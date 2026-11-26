// Small DOM toolkit: elements, icons, sheets with Android-back support, toasts, controls.

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];

export function h(tag, attrs, ...kids) {
  const [t, ...cls] = tag.split(".");
  const el = document.createElement(t || "div");
  if (cls.length) el.className = cls.join(" ");
  if (attrs && (typeof attrs !== "object" || attrs instanceof Node || Array.isArray(attrs))) { kids.unshift(attrs); attrs = null; }
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className += (el.className ? " " : "") + v;
    else if (k === "style" && typeof v === "object") Object.assign(el.style, v);
    else if (k === "html") el.innerHTML = v;
    else if (k in el && k !== "list" && typeof v !== "string") el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  add(el, kids);
  return el;
}
function add(el, kids) {
  for (const k of kids.flat(Infinity)) {
    if (k == null || k === false) continue;
    el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
  }
}
export const clear = (el, ...kids) => { el.replaceChildren(); add(el, kids); return el; };

const P = {
  plus: "M12 5v14M5 12h14", minus: "M5 12h14", x: "M18 6 6 18M6 6l12 12", check: "M20 6 9 17l-5-5",
  down: "m6 9 6 6 6-6", left: "m15 18-6-6 6-6", right: "m9 18 6-6-6-6", up: "m18 15-6-6-6 6",
  wand: "M15 4V2M15 16v-2M8 9h2M20 9h2M17.8 11.8 19 13M15 9h0M17.8 6.2 19 5M3 21l9-9M12.2 6.2 11 5",
  zap: "M13 2 3 14h9l-1 8 10-12h-9l1-8z", image: "M3 5h18v14H3zM8.5 10a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM21 15l-5-5L5 19",
  grid: "M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z", list: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01",
  layers: "m12 2 10 5-10 5L2 7l10-5zM2 17l10 5 10-5M2 12l10 5 10-5", sliders: "M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3", star: "m12 2 3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1z",
  trash: "M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6", download: "M12 3v12M7 10l5 5 5-5M5 21h14", info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01",
  refresh: "M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5", dice: "M4 4h16v16H4zM8.5 8.5h.01M15.5 15.5h.01M15.5 8.5h.01M8.5 15.5h.01M12 12h.01",
  recycle: "M7 19H4.8a1.8 1.8 0 0 1-1.6-2.7L7.2 9.5M11 19h8.2a1.8 1.8 0 0 0 1.6-2.7l-1.2-2M14 16l-3 3 3 3M8.3 13.6 7.2 9.5 3.1 10.6M9.3 5.6l1.1-1.9a1.8 1.8 0 0 1 3.1 0l3.8 6.6M13.4 9.3l3.9 1.1 1.1-4.1",
  upload: "M12 21V9M7 14l5-5 5 5M5 3h14", brush: "M9.1 15.1 4 20M12 4l8 8-6 6-8-8 6-6zM14.5 6.5l3 3", eraser: "M7 21h10M5.5 13.5l7-7a2 2 0 0 1 2.8 0l3.2 3.2a2 2 0 0 1 0 2.8l-7 7H8.3L5.5 16.7a2 2 0 0 1 0-3.2z",
  undo: "M3 7v6h6M3 13a9 9 0 1 0 3-7.7L3 8", folder: "M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z",
  more: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 6a1 1 0 1 0 0-2 1 1 0 0 0 0 2zM12 20a1 1 0 1 0 0-2 1 1 0 0 0 0 2z",
  copy: "M8 8h12v12H8zM4 16V4h12", eye: "M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  compare: "M12 3v18M5 8l-3 4 3 4M19 8l3 4-3 4", lock: "M5 11h14v10H5zM8 11V7a4 4 0 0 1 8 0v4", stop: "M6 6h12v12H6z",
  play: "M6 4l14 8-14 8z", save: "M5 3h11l5 5v13H5zM8 3v5h7M8 21v-7h8v7", file: "M14 3H6v18h12V7zM14 3v4h4",
  maximize: "M8 3H3v5M16 3h5v5M8 21H3v-5M16 21h5v-5", heart: "M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8z",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z", share: "M4 12v8h16v-8M16 6l-4-4-4 4M12 2v13",
  scan: "M3 7V3h4M17 3h4v4M21 17v4h-4M7 21H3v-4M7 12h10", user: "M20 21a8 8 0 0 0-16 0M12 13a5 5 0 1 0 0-10 5 5 0 0 0 0 10z",
  palette: "M12 22a10 10 0 1 1 10-10c0 2.8-2.2 3-4 3h-2a2 2 0 0 0-1 3.7A2 2 0 0 1 12 22zM7.5 11.5h.01M10.5 7.5h.01M15.5 8.5h.01",
  cpu: "M6 6h12v12H6zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4", seed: "M12 22V12M12 12C12 7 8 4 3 4c0 5 4 8 9 8zM12 12c0-4 3-7 8-7 0 4-3 7-8 7z",
  ratio: "M4 6h16v12H4z", text: "M4 7V4h16v3M9 20h6M12 4v16",
};
export function icon(name, cls = "") {
  const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  s.setAttribute("viewBox", "0 0 24 24");
  s.setAttribute("class", "i " + cls);
  const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
  p.setAttribute("d", P[name] || P.info);
  s.appendChild(p);
  return s;
}

export const haptic = (ms = 8) => { try { navigator.vibrate?.(ms); } catch {} };
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const short = (f) => String(f || "").split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|pt|pth|bin|gguf)$/i, "");
export const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
export function ago(ts) {
  const s = Date.now() / 1000 - ts;
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86400) return Math.floor(s / 3600) + " h ago";
  return new Date(ts * 1000).toLocaleDateString(undefined, { day: "numeric", month: "short", year: s > 300 * 86400 ? "numeric" : undefined });
}
export const fmtBytes = (b) => b > 1e6 ? (b / 1e6).toFixed(1) + " MB" : Math.round(b / 1e3) + " KB";

export async function api(url, opts = {}) {
  const o = { ...opts };
  if (o.json !== undefined) { o.method ||= "POST"; o.body = JSON.stringify(o.json); o.headers = { "Content-Type": "application/json", ...(o.headers || {}) }; delete o.json; }
  const r = await fetch(url, o);
  const ct = r.headers.get("content-type") || "";
  const body = ct.includes("json") ? await r.json() : await r.text();
  if (!r.ok) {
    const msg = typeof body === "string" ? body : body?.error?.message || body?.error || JSON.stringify(body);
    const err = new Error(msg); err.body = body; err.status = r.status; throw err;
  }
  return body;
}

// ------------------------------------------------------------ Android back button: a stack of open layers
const layers = [];
export function pushLayer(close) {
  const entry = { close };
  layers.push(entry);
  history.pushState({ waifu: layers.length }, "");
  return () => { if (layers.includes(entry)) history.back(); };
}
window.addEventListener("popstate", () => {
  const top = layers.pop();
  if (top) top.close();
});
export const layerCount = () => layers.length;

// ------------------------------------------------------------ toasts
export function toast(msg, opts = {}) {
  const t = h("div.toast" + (opts.err ? ".err" : ""), h("span.grow", msg), opts.action && h("button", { onclick: () => { opts.action.fn(); t.remove(); } }, opts.action.label));
  $("#toasts").appendChild(t);
  setTimeout(() => t.remove(), opts.ms || (opts.action ? 5500 : opts.err ? 6000 : 2400));
  return t;
}

export async function copyText(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) { await navigator.clipboard.writeText(text); }
    else {
      const ta = h("textarea", { style: { position: "fixed", opacity: 0 } });
      ta.value = text; document.body.appendChild(ta); ta.select(); document.execCommand("copy"); ta.remove();
    }
    toast("Copied"); haptic();
  } catch { toast("Copy failed", { err: true }); }
}

// ------------------------------------------------------------ bottom sheets
export function sheet({ title, body, full = false, actions = [], onClose, headExtra }) {
  const root = $("#sheets");
  const scrim = h("div.scrim");
  const bd = h("div.sbd");
  const el = h("div.sheet" + (full ? ".full" : ""),
    h("div.grab"),
    h("div.shd", h("h3", title || ""), headExtra || null, h("button.ibtn.sm", { onclick: () => close() }, icon("x"))),
    bd,
    actions.length ? h("div.sft", actions.map((a) => h("button.btn" + (a.pri ? ".pri" : "") + (a.cls ? "." + a.cls : ""), { style: { flex: a.flex ?? 1 }, onclick: () => a.onClick(close) }, a.icon && icon(a.icon), a.label))) : null);
  if (typeof body === "function") body(bd, () => close()); else if (body) add(bd, [body]);
  root.append(scrim, el);
  // Open right away: force one layout so the slide-up transition starts from below the screen.
  // Waiting for requestAnimationFrame left the sheet parked off-screen when the browser skipped that frame.
  void el.offsetHeight;
  scrim.classList.add("open"); el.classList.add("open");
  let closed = false;
  // safety net: if the slide-up animation never ran, put the sheet in place without it
  setTimeout(() => {
    if (closed || el.style.transform) return;
    if (el.getBoundingClientRect().top >= window.innerHeight - 4) {
      el.style.transition = scrim.style.transition = "none";
      void el.offsetHeight;
      el.style.transition = scrim.style.transition = "";
    }
  }, 400);
  const finish = () => {
    if (closed) return; closed = true;
    scrim.classList.remove("open"); el.classList.remove("open");
    el.style.transform = "";
    setTimeout(() => { scrim.remove(); el.remove(); }, 260);
    onClose?.();
  };
  const pop = pushLayer(finish);
  const close = () => pop();
  scrim.onclick = close;
  // drag down to dismiss from the grab bar / header
  let y0 = null, dy = 0;
  const start = (e) => { y0 = e.touches[0].clientY; dy = 0; el.style.transition = "none"; };
  const move = (e) => { if (y0 == null) return; dy = Math.max(0, e.touches[0].clientY - y0); el.style.transform = `translateY(${dy}px)`; };
  const end = () => { if (y0 == null) return; el.style.transition = ""; y0 = null; if (dy > 90) close(); else el.style.transform = ""; };
  for (const g of [el.querySelector(".grab"), el.querySelector(".shd")]) {
    g.addEventListener("touchstart", start, { passive: true }); g.addEventListener("touchmove", move, { passive: true }); g.addEventListener("touchend", end);
  }
  return { el, body: bd, close };
}

// Searchable option list. Resolves with the picked value, or undefined.
export function pick({ title, options, value, searchable, render, multi = false }) {
  return new Promise((resolve) => {
    let done = false, picked = multi ? new Set(value || []) : value;
    const opts = options.map((o) => (typeof o === "object" ? o : { value: o, label: String(o) }));
    const s = sheet({
      title, full: opts.length > 12,
      actions: multi ? [{ label: "Done", pri: true, onClick: (c) => { done = true; resolve([...picked]); c(); } }] : [],
      onClose: () => { if (!done) resolve(undefined); },
      body: (bd) => {
        const list = h("div");
        const q = h("input.inp", { type: "search", placeholder: "Search…", enterkeyhint: "search" });
        const draw = () => {
          const words = q.value.toLowerCase().split(/\s+/).filter(Boolean);
          const items = opts.filter((o) => { const hay = (o.label + " " + (o.desc || "") + " " + o.value).toLowerCase(); return words.every((w) => hay.includes(w)); });
          clear(list, items.slice(0, 400).map((o) => {
            const on = multi ? picked.has(o.value) : o.value === value;
            return h("button.opt" + (on ? ".on" : ""), {
              onclick: () => {
                haptic();
                if (multi) { picked.has(o.value) ? picked.delete(o.value) : picked.add(o.value); draw(); return; }
                done = true; resolve(o.value); s.close();
              },
            }, h("span.ck", on ? icon("check") : null), render ? render(o) : h("span.grow", h("div.t", o.label), o.desc && h("div.d", o.desc)));
          }), items.length > 400 ? h("div.hint", `+${items.length - 400} more – type to narrow down`) : null);
        };
        if (searchable ?? opts.length > 10) { bd.appendChild(h("div.search", icon("search"), q)); q.oninput = draw; }
        bd.appendChild(list);
        draw();
        const cur = list.querySelector(".opt.on");
        if (cur) setTimeout(() => cur.scrollIntoView({ block: "center" }), 60);
      },
    });
  });
}

export function confirmSheet(title, text, okLabel = "OK", danger = false) {
  return new Promise((resolve) => {
    let ok = false;
    sheet({
      title, body: h("div.mute", text),
      actions: [{ label: "Cancel", onClick: (c) => c() }, { label: okLabel, pri: !danger, cls: danger ? "danger" : "", onClick: (c) => { ok = true; c(); } }],
      onClose: () => resolve(ok),
    });
  });
}

export function promptSheet(title, value = "", placeholder = "") {
  return new Promise((resolve) => {
    let out;
    const inp = h("input.inp", { value, placeholder });
    sheet({ title, body: inp, actions: [{ label: "Cancel", onClick: (c) => c() }, { label: "OK", pri: true, onClick: (c) => { out = inp.value; c(); } }], onClose: () => resolve(out) });
    setTimeout(() => inp.focus(), 250);
  });
}

// ------------------------------------------------------------ controls
export function autosize(ta) {
  const fit = () => { ta.style.height = "auto"; ta.style.height = ta.scrollHeight + 2 + "px"; };
  ta.addEventListener("input", fit);
  requestAnimationFrame(fit);
  new ResizeObserver(() => fit()).observe(ta);
  return ta;
}

export function toggle(on, onChange) {
  const el = h("button.sw" + (on ? ".on" : ""), { role: "switch" });
  el.onclick = (e) => { e.stopPropagation(); on = !on; el.classList.toggle("on", on); haptic(); onChange(on); };
  return el;
}

export function seg(options, value, onChange) {
  const el = h("div.seg");
  const draw = () => clear(el, options.map((o) => {
    const [v, label, ic] = Array.isArray(o) ? o : [o, o];
    return h("button" + (v === value ? ".on" : ""), { onclick: () => { if (v === value) return; value = v; haptic(); draw(); onChange(v); } }, ic && icon(ic), label);
  }));
  draw();
  return el;
}

const decimals = (step) => { const s = String(step); return s.includes(".") ? s.split(".")[1].length : 0; };

export function stepper({ value, min = -Infinity, max = Infinity, step = 1, onChange, dec }) {
  dec ??= decimals(step);
  const inp = h("input", { type: "text", inputMode: dec ? "decimal" : "numeric", value: (+value).toFixed(dec) });
  const setv = (v, fire = true) => {
    v = Math.min(max, Math.max(min, Math.round(v / step) * step));
    if (!Number.isFinite(v)) return;
    v = +v.toFixed(dec);
    inp.value = v.toFixed(dec);
    if (fire) onChange(v);
  };
  inp.onchange = () => { const v = parseFloat(inp.value.replace(",", ".")); if (Number.isFinite(v)) setv(v); else inp.value = (+value).toFixed(dec); };
  inp.onfocus = () => setTimeout(() => inp.select(), 0);
  let rep;
  const hold = (d) => (e) => {
    e.preventDefault(); haptic(5);
    setv((parseFloat(inp.value) || 0) + d * step);
    let n = 0;
    rep = setInterval(() => { n++; setv((parseFloat(inp.value) || 0) + d * step * (n > 12 ? 5 : 1)); }, 110);
    setTimeout(() => {}, 0);
  };
  const stop = () => clearInterval(rep);
  const mk = (d, ic) => {
    const b = h("button", icon(ic));
    let t;
    b.addEventListener("pointerdown", (e) => { t = setTimeout(() => hold(d)(e), 350); });
    b.addEventListener("pointerup", () => { if (t) { clearTimeout(t); if (!rep) { haptic(5); setv((parseFloat(inp.value) || 0) + d * step); } } stop(); rep = null; t = null; });
    b.addEventListener("pointerleave", () => { clearTimeout(t); stop(); rep = null; });
    b.addEventListener("contextmenu", (e) => e.preventDefault());
    return b;
  };
  const el = h("div.stepper", mk(-1, "minus"), inp, mk(1, "plus"));
  el.set = (v) => setv(v, false);
  return el;
}

// label + stepper (+ optional slider)
export function numField({ label, value, min, max, step, onChange, slider, hint }) {
  const st = stepper({ value, min, max, step, onChange: (v) => { if (sl) sl.value = v; onChange(v); } });
  let sl = null;
  if (slider) {
    sl = h("input.slider", { type: "range", min: slider[0] ?? min, max: slider[1] ?? max, step, value });
    sl.oninput = () => { st.set(+sl.value); onChange(+sl.value); };
  }
  return h("div.nf", h("div.nfrow", h("div.nfl", label, hint && h("small", hint)), st), sl);
}

export function field(label, control, right) {
  return h("div", h("div.lbl", label, right || null), control);
}

export function section({ id, title, sub, icon: ic, collapsed = false, extra, body }) {
  const key = "sec:" + id;
  let c = localStorage.getItem(key);
  c = c == null ? collapsed : c === "1";
  const bd = h("div.bd");
  const subEl = h("span.sub", sub || "");
  const el = h("section.sec" + (c ? ".collapsed" : ""), { id: "sec-" + id },
    h("div.hd", { onclick: (e) => { if (e.target.closest("button, .sw")) return; el.classList.toggle("collapsed"); try { localStorage.setItem(key, el.classList.contains("collapsed") ? "1" : "0"); } catch {} } },
      h("h2", ic && icon(ic), title, subEl), extra || null, icon("down", "chev")),
    bd);
  if (body) body(bd);
  el.bd = bd; el.sub = subEl;
  return el;
}

export function longPress(el, fn, ms = 450) {
  let t, x, y, fired = false;
  el.addEventListener("pointerdown", (e) => { fired = false; x = e.clientX; y = e.clientY; t = setTimeout(() => { fired = true; haptic(15); fn(e); }, ms); });
  el.addEventListener("pointermove", (e) => { if (Math.hypot(e.clientX - x, e.clientY - y) > 10) clearTimeout(t); });
  for (const ev of ["pointerup", "pointercancel", "pointerleave"]) el.addEventListener(ev, () => clearTimeout(t));
  el.addEventListener("contextmenu", (e) => e.preventDefault());
  el.addEventListener("click", (e) => { if (fired) { e.stopImmediatePropagation(); e.preventDefault(); fired = false; } }, true);
}

export const store = {
  get(k, d) { try { const v = localStorage.getItem("wm:" + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("wm:" + k, JSON.stringify(v)); } catch (e) { console.warn("storage", e); } },
};
