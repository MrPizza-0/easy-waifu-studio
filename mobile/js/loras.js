// LoRA library: browse, search, see triggers, add to the workflow.
import { h, icon, clear, api, toast, sheet, copyText, short, haptic, debounce, store } from "./util.js";
import { S, loras, changed, on } from "./comfy.js";

const norm = (f) => String(f || "").replace(/\\/g, "/").toLowerCase();
let byFile = null;
export function loraInfo(file) {
  if (!S.loras) return null;
  if (!byFile || byFile._src !== S.loras) { byFile = new Map(S.loras.map((r) => [norm(r.file), r])); byFile._src = S.loras; }
  return byFile.get(norm(file)) || null;
}

const FILTERS = [["all", "All"], ["wf", "In workflow"], ["on", "On"], ["sdxl", "SDXL / Illustrious"], ["anima", "Anima"], ["preset", "In a preset"]];

function matches(r, q, filter) {
  if (filter === "sdxl" && r.compat !== "ok") return false;
  if (filter === "anima" && !/anima/i.test(r.base + " " + r.file + " " + r.title)) return false;
  if (filter === "preset" && !r.preset) return false;
  const rows = S.graph?.loraRows() || [];
  const row = rows.find((x) => norm(x.lora) === norm(r.file));
  if (filter === "wf" && !row) return false;
  if (filter === "on" && !row?.on) return false;
  if (!q) return true;
  const hay = (r.file + " " + r.title + " " + r.words.join(" ") + " " + r.hints.join(" ")).toLowerCase();
  return q.split(/\s+/).every((w) => hay.includes(w));
}

function trigList(r) {
  const box = h("div");
  const chip = (w, cls = "") => h("span.trig" + cls, { title: w, onclick: (e) => { e.stopPropagation(); copyText(w); } }, w);
  const draw = (all) => {
    clear(box, (all ? r.words : r.words.slice(0, 3)).map((w) => chip(w)),
      !all && r.words.length > 3 && h("span.trig.hint", { onclick: (e) => { e.stopPropagation(); draw(true); } }, `+${r.words.length - 3} more`),
      chip(`<lora:${short(r.file)}:1>`, ".hint"));
  };
  draw(false);
  return box;
}

function card(r, { onPick } = {}) {
  const rows = S.graph?.loraRows() || [];
  const row = rows.find((x) => norm(x.lora) === norm(r.file));
  const badges = [
    r.preset && h("span.badge2.p", "in a preset"),
    r.base && h("span.badge2." + r.compat, r.base + (r.compat === "bad" ? " – not for SDXL" : "")),
    row && h("span.badge2.p", row.on ? `on @ ${row.strength}` : "in workflow, off"),
  ];
  const act = onPick
    ? h("button.btn.sm.pri", { onclick: (e) => { e.stopPropagation(); onPick(r.file); } }, icon("plus"), "Add")
    : h("button.btn.sm" + (row?.on ? "" : ".pri"), { onclick: (e) => { e.stopPropagation(); toggleInWf(r, e.currentTarget); } }, row?.on ? "Turn off" : row ? "Turn on" : "Add");
  const el = h("div.lcard",
    h("img.nsfw", { src: r.image || null, loading: "lazy", onload: (e) => { e.target.style.visibility = ""; }, onerror: (e) => { e.target.style.visibility = "hidden"; } }),
    h("div.grow", { style: { minWidth: 0 } },
      h("div.row", h("div.grow", h("div.t", r.title), h("div.f", r.file)), act),
      h("div", badges),
      trigList(r),
      !r.words.length && r.hints.length ? h("div", r.hints.slice(0, 8).map((w) => h("span.trig.hint", { onclick: (e) => { e.stopPropagation(); copyText(w); } }, w))) : null,
      r.url && h("div.hint", { style: { marginTop: "4px" } }, h("a", { href: r.url, target: "_blank", rel: "noopener", style: { color: "var(--acc)" } }, "Civitai page ↗"))));
  if (onPick) el.onclick = () => onPick(r.file);
  return el;
}

function toggleInWf(r, btn) {
  const G = S.graph;
  if (!G.roles().pll) return toast("This workflow has no Power Lora Loader", { err: true });
  let row = G.loraRows().find((x) => norm(x.lora) === norm(r.file));
  if (!row) row = G.addLora(r.file, 1, true);
  else row.on = !row.on;
  G.loraToggled(row.lora, row.on, S.presets.triggers);
  changed();
  haptic();
  import("./create.js").then((m) => m.refreshLoras());
  toast(`${r.title}: ${row.on ? "on" : "off"}${row.on && S.presets.triggers[row.lora] ? " · trigger added" : ""}`);
  const p = btn.closest(".lcard");
  p.replaceWith(card(r));
}

function listInto(container, { q, filter, onPick }) {
  clear(container);
  const all = (S.loras || []).filter((r) => matches(r, q, filter));
  let shown = 0;
  const more = () => {
    const chunk = all.slice(shown, shown + 40);
    shown += chunk.length;
    for (const r of chunk) container.appendChild(card(r, { onPick }));
  };
  more();
  container._more = () => { if (shown < all.length) more(); };
  return all.length;
}

export function lorasView(el) {
  let q = "", filter = store.get("l:filter", "all");
  const count = h("small");
  const top = h("div.topbar", h("h1", "LoRAs", count),
    h("button.ibtn", { onclick: scan, title: "Scan new LoRAs" }, icon("scan")),
    h("button.ibtn", { onclick: () => { S.settings.blur = !S.settings.blur; el.classList.toggle("blurimg", S.settings.blur); } }, icon("eye")));
  const inp = h("input.inp", { type: "search", placeholder: "Search name, character, trigger…", enterkeyhint: "search" });
  const chips = h("div.chips.scrollx");
  const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "0 12px 100px" } });
  const scroll = h("div.scroll", list);
  el.append(top, h("div.gtools", h("div.search", icon("search"), inp), chips), scroll);
  el.classList.toggle("blurimg", S.settings.blur);
  const draw = () => {
    clear(chips, FILTERS.map(([k, l]) => h("button.chip" + (filter === k ? ".on" : ""), { onclick: () => { filter = k; store.set("l:filter", k); draw(); } }, l)));
    const n = listInto(list, { q, filter });
    count.textContent = `${n} of ${S.loras?.length ?? 0}`;
    scroll.scrollTop = 0;
  };
  inp.oninput = debounce(() => { q = inp.value.toLowerCase().trim(); draw(); }, 200);
  scroll.addEventListener("scroll", () => { if (scroll.scrollTop + scroll.clientHeight > scroll.scrollHeight - 800) list._more?.(); }, { passive: true });
  el._shown = async () => {
    if (!S.loras) { list.replaceChildren(h("div.empty-state", h("span.spin"))); await loras(); }
    draw();
  };
  on("graph", (o) => { if (o?.all && el.offsetParent) draw(); });

  async function scan() {
    await api("/waifu/rescan", { method: "POST" });
    toast("Scanning new LoRAs on Civitai…");
    const t = setInterval(async () => {
      const s = await api("/waifu/rescan");
      if (!s.running) { clearInterval(t); S.loras = null; await loras(); draw(); toast("LoRA scan finished"); }
    }, 2000);
  }
}

export function loraPicker() {
  return new Promise(async (resolve) => {
    let done = false, q = "", filter = "all";
    const s = sheet({
      title: "Add LoRA", full: true,
      onClose: () => { if (!done) resolve(undefined); },
      body: async (bd) => {
        bd.classList.toggle("blurimg", S.settings.blur);
        const inp = h("input.inp", { type: "search", placeholder: "Search…" });
        const chips = h("div.chips.scrollx");
        const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
        bd.append(h("div.search", icon("search"), inp), chips, list);
        const pickIt = (f) => { done = true; resolve(f); s.close(); };
        const draw = () => {
          clear(chips, FILTERS.filter(([k]) => k !== "on").map(([k, l]) => h("button.chip" + (filter === k ? ".on" : ""), { onclick: () => { filter = k; draw(); } }, l)));
          listInto(list, { q, filter, onPick: pickIt });
        };
        inp.oninput = debounce(() => { q = inp.value.toLowerCase().trim(); draw(); }, 200);
        bd.addEventListener("scroll", () => { if (bd.scrollTop + bd.clientHeight > bd.scrollHeight - 800) list._more?.(); }, { passive: true });
        list.appendChild(h("span.spin"));
        await loras();
        draw();
      },
    });
  });
}
