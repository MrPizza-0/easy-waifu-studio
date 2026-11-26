// Controls bound to workflow widgets, the "all nodes" editor and tag autocomplete.
import { h, icon, clear, numField, field, toggle, seg, pick, autosize, short, sheet, haptic, api, $ } from "./util.js";
import { S, changed } from "./comfy.js";

const pretty = (n) => n.replace(/_/g, " ");

// One control for one widget of one node. onChange(value) runs after the value is stored.
export function widgetControl(node, w, opts = {}) {
  const g = S.graph;
  const val = g.get(node, w.name);
  const label = opts.label || pretty(w.control ? "after each run" : w.name);
  const commit = (v) => { g.set(node, w.name, v, true); changed(opts.changeOpts || {}); opts.onChange?.(v); };
  const o = w.opts || {};
  if (w.control) return field(label, seg(w.options.map((x) => [x, x]), val, commit));
  if (w.type === "BOOLEAN") {
    return h("div.row", h("div.grow", h("div", { style: { fontSize: "14px" } }, label)),
      h("span.hint", val ? o.label_on || "" : o.label_off || ""), toggle(!!val, commit));
  }
  if (w.type === "INT" || w.type === "FLOAT") {
    const step = o.step ?? (w.type === "INT" ? 1 : 0.01);
    const min = o.min ?? -Infinity, max = o.max ?? Infinity;
    const rng = opts.slider ?? (Number.isFinite(min) && Number.isFinite(max) && max - min <= 200 && max - min > 0 ? [min, max] : null);
    return numField({ label, value: val ?? o.default ?? 0, min, max, step, onChange: commit, slider: rng, hint: opts.hint });
  }
  if (w.type === "COMBO") {
    const b = h("button.picker", h("span.grow", h("span.k", label), h("span.v", opts.fmt ? opts.fmt(val) : String(val ?? "—"))), icon("down"));
    b.onclick = async () => {
      const v = await pick({ title: label, value: val, options: w.options.map((x) => ({ value: x, label: opts.fmt ? opts.fmt(x) : String(x), desc: opts.fmt && opts.fmt(x) !== String(x) ? String(x) : "" })) });
      if (v !== undefined && v !== val) { commit(v); b.querySelector(".v").textContent = opts.fmt ? opts.fmt(v) : String(v); }
    };
    return b;
  }
  if (w.type === "STRING") {
    if (o.multiline || opts.multiline) {
      const ta = tagArea(val || "", (v) => { g.set(node, w.name, v, true); changed({ quiet: true }); opts.onChange?.(v); }, { mono: opts.mono });
      return field(label, ta);
    }
    const inp = h("input.inp", { value: val ?? "" });
    inp.onchange = () => commit(inp.value);
    return field(label, inp);
  }
  return h("div.hint", `${label}: ${JSON.stringify(val)}`);
}

// Editor for a list of widget names on a node; rest goes behind "more".
export function nodeFields(container, node, names, opts = {}) {
  const g = S.graph;
  const ws = g.widgets(node);
  const shown = new Set();
  for (const spec of names) {
    const [name, extra] = Array.isArray(spec) ? spec : [spec, {}];
    const w = ws.find((x) => x.name === name);
    if (!w) continue;
    shown.add(name);
    container.appendChild(widgetControl(node, w, extra));
    const ctl = ws.find((x) => x.control && x.of === name);
    if (ctl) { shown.add(ctl.name); container.appendChild(widgetControl(node, ctl)); }
  }
  const rest = ws.filter((w) => !shown.has(w.name));
  if (rest.length && opts.more !== false) {
    const box = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
    const btn = h("button.btn.sm.ghost", { onclick: () => { btn.remove(); for (const w of rest) box.appendChild(widgetControl(node, w)); } }, icon("sliders"), `${rest.length} more settings`);
    container.append(btn, box);
  }
}

// Every node with widgets, grouped, with bypass toggles. Full control over the whole graph.
export function allNodesSheet() {
  const g = S.graph;
  sheet({
    title: "All nodes", full: true,
    body: (bd) => {
      const q = h("input.inp", { type: "search", placeholder: "Filter nodes…" });
      const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
      bd.append(h("div.search", icon("search"), q), list);
      const draw = () => {
        const s = q.value.toLowerCase();
        clear(list);
        for (const n of g.nodes) {
          if (["SetNode", "GetNode", "Note", "Reroute"].includes(n.type)) continue;
          const ws = g.widgets(n);
          const title = g.title(n);
          if (s && !(title + " " + n.type).toLowerCase().includes(s)) continue;
          const bdy = h("div.bd.hidden");
          const modeTag = h("span.mode" + (n.mode === 4 ? ".byp" : ""), n.mode === 4 ? "bypassed" : n.mode === 2 ? "muted" : "#" + n.id);
          const box = h("div.node-ed",
            h("button", { onclick: () => { bdy.classList.toggle("hidden"); if (!bdy.dataset.filled) fill(); } }, h("span.grow.ell", title), modeTag, icon("down")),
            bdy);
          const fill = () => {
            bdy.dataset.filled = 1;
            bdy.appendChild(h("div.row", h("span.grow.hint", n.type), h("span.hint", "bypass"), toggle(n.mode === 4, (v) => { n.mode = v ? 4 : 0; modeTag.textContent = v ? "bypassed" : "#" + n.id; modeTag.classList.toggle("byp", v); changed(); })));
            if (n.type === "Power Lora Loader (rgthree)") bdy.appendChild(h("div.hint", "Edit LoRAs in the LoRAs section of Create."));
            for (const w of ws) bdy.appendChild(widgetControl(n, w));
            if (!ws.length) bdy.appendChild(h("div.hint", "No settings."));
          };
          list.appendChild(box);
        }
      };
      q.oninput = draw;
      draw();
    },
  });
}

// ------------------------------------------------------------ tag autocomplete
let TAGS = null, tagsLoading = null;
async function tags() {
  if (TAGS) return TAGS;
  tagsLoading ||= api("/waifu/m/api/tags").then((txt) => {
    TAGS = txt.split("\n").map((l) => { const i = l.lastIndexOf(","); return i > 0 ? [l.slice(0, i), +l.slice(i + 1) || 0] : [l, 0]; }).filter((t) => t[0]);
    return TAGS;
  }).catch(() => (TAGS = []));
  return tagsLoading;
}

const ac = () => $("#ac");
let acTarget = null;

function tokenAt(ta) {
  const v = ta.value, c = ta.selectionStart;
  let a = c; while (a > 0 && !",\n".includes(v[a - 1])) a--;
  let b = c; while (b < v.length && !",\n".includes(v[b])) b++;
  const raw = v.slice(a, c);
  const lead = raw.length - raw.trimStart().length;
  return { a: a + lead, b, word: raw.trimStart(), full: v.slice(a + lead, b).trim() };
}

function replaceRange(ta, a, b, text) {
  ta.setRangeText(text, a, b, "end");
  ta.dispatchEvent(new Event("input", { bubbles: true }));
}

function adjustWeight(ta, d) {
  const t = tokenAt(ta);
  if (!t.full) return;
  const m = t.full.match(/^\((.+):([\d.]+)\)$/);
  let out;
  if (m) { const w = +(+m[2] + d).toFixed(2); out = Math.abs(w - 1) < 1e-6 ? m[1] : `(${m[1]}:${w})`; }
  else out = `(${t.full}:${(1 + d).toFixed(1)})`;
  const end = t.a + t.full.length;
  replaceRange(ta, t.a, end, out);
}

async function suggest(ta) {
  const box = ac();
  const t = tokenAt(ta);
  const word = t.word.toLowerCase().replace(/ /g, "_");
  const row = box.querySelector(".acrow");
  clear(row);
  if (word.length >= 2 && !word.startsWith("<")) {
    const all = await tags();
    const pre = [], mid = [];
    for (const [tag, n] of all) {
      if (tag.startsWith(word)) { pre.push([tag, n]); if (pre.length >= 14) break; }
      else if (mid.length < 8 && tag.includes(word)) mid.push([tag, n]);
    }
    const trig = Object.values(S.presets?.triggers || {}).filter((x) => x.toLowerCase().includes(t.word.toLowerCase())).slice(0, 4);
    for (const x of trig) row.appendChild(sugg(ta, t, x, "lora"));
    for (const [tag, n] of [...pre, ...mid].slice(0, 18)) row.appendChild(sugg(ta, t, tag, n > 999 ? Math.round(n / 1000) + "k" : n));
  }
  row.classList.toggle("hidden", !row.children.length);
  place();
}

function sugg(ta, t, tag, n) {
  const b = h("button", tag, h("small", String(n)));
  b.addEventListener("pointerdown", (e) => e.preventDefault());
  b.onclick = () => {
    haptic(5);
    const v = ta.value;
    const after = v.slice(t.b);
    const needComma = !after.trimStart().startsWith(",");
    replaceRange(ta, t.a, t.b, tag + (needComma ? ", " : ""));
    suggest(ta);
  };
  return b;
}

function place() {
  const box = ac();
  if (!acTarget) return;
  const vv = window.visualViewport;
  const bottom = vv ? window.innerHeight - (vv.offsetTop + vv.height) : 0;
  box.style.bottom = Math.max(8, bottom + 6) + "px";
}

export function initAutocomplete() {
  const box = h("div", { id: "ac" }, h("div.acrow"), h("div.tools"));
  const tools = box.querySelector(".tools");
  const tool = (label, fn) => {
    const b = h("button", label);
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.onclick = () => { if (acTarget) { haptic(5); fn(acTarget); } };
    tools.appendChild(b);
  };
  tool("( )", (ta) => { const t = tokenAt(ta); if (t.full) replaceRange(ta, t.a, t.a + t.full.length, `(${t.full})`); });
  tool("−.1", (ta) => adjustWeight(ta, -0.1));
  tool("+.1", (ta) => adjustWeight(ta, 0.1));
  tool(",", (ta) => replaceRange(ta, ta.selectionStart, ta.selectionEnd, ", "));
  tool("_", (ta) => { const t = tokenAt(ta); if (t.full) replaceRange(ta, t.a, t.a + t.full.length, t.full.includes("_") ? t.full.replace(/_/g, " ") : t.full.replace(/ /g, "_")); });
  tool("⌫ tag", (ta) => { const t = tokenAt(ta); let b = t.b; if (ta.value[b] === ",") b++; while (ta.value[b] === " ") b++; replaceRange(ta, t.a, b, ""); });
  tool("done", (ta) => ta.blur());
  document.body.appendChild(box);
  window.visualViewport?.addEventListener("resize", place);
  window.visualViewport?.addEventListener("scroll", place);
}

export function tagArea(value, onInput, opts = {}) {
  const ta = h("textarea.ta" + (opts.big ? ".big" : "") + (opts.mono ? ".mono" : ""), { rows: 1, placeholder: opts.placeholder || "", spellcheck: false, autocapitalize: "off", autocomplete: "off" });
  ta.value = value;
  autosize(ta);
  let t;
  ta.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => onInput(ta.value), 250); if (acTarget === ta) suggest(ta); });
  ta.addEventListener("focus", () => { acTarget = ta; ac().classList.add("open"); tags(); suggest(ta); setTimeout(() => ta.scrollIntoView({ block: "nearest", behavior: "smooth" }), 350); });
  ta.addEventListener("click", () => suggest(ta));
  ta.addEventListener("blur", () => { clearTimeout(t); onInput(ta.value); setTimeout(() => { if (document.activeElement !== ta && acTarget === ta) { acTarget = null; ac().classList.remove("open"); } }, 120); });
  return ta;
}

export { short };
