// Fullscreen viewer: swipe between images, pinch / double-tap zoom, swipe down to close,
// before/after compare, metadata, remix, favorites, trash.
import { h, icon, clear, api, toast, haptic, sheet, pushLayer, copyText, ago, fmtBytes, confirmSheet } from "./util.js";
import { S, setWorkflow, changed, saveSettings, markTrashed } from "./comfy.js";

let V = null;

function ensure() {
  if (V) return V;
  const el = h("div", { id: "viewer" });
  document.body.appendChild(el);
  V = { el };
  return V;
}

// items: [{url, mid?, f?, m?, ref, title, compare?, temp?, video?, fav?}]
export function openViewer(items, index = 0, opts = {}) {
  const v = ensure();
  Object.assign(v, { items, index, opts, chrome: true, zoom: { s: 1, x: 0, y: 0 } });
  v.el.className = "open";
  const pop = pushLayer(() => closeNow());
  v.close = pop;
  render();
}

function closeNow() {
  if (!V) return;
  V.el.className = "";
  clear(V.el);
  V.cleanup?.();
}

const cur = () => V.items[V.index];

function render() {
  const v = V;
  clear(v.el);
  v.track = h("div.track");
  v.slides = [-1, 0, 1].map((d) => slide(v.items[v.index + d], d));
  v.track.append(...v.slides);
  v.track.style.transform = "translateX(-100vw)";
  v.top = h("div.vtop",
    h("button.ibtn", { onclick: () => v.close() }, icon("left")),
    v.titleEl = h("div.t"),
    v.hdBtn = h("button.ibtn", { onclick: () => loadHD(true) }, h("span", { style: { fontSize: "11px", fontWeight: 800 } }, "HD")),
    h("button.ibtn", { onclick: moreMenu }, icon("more")));
  v.bot = h("div.vbot");
  v.el.append(v.track, v.top, v.bot);
  v.el.classList.toggle("chrome-off", !v.chrome);
  updateChrome();
  bindGestures();
}

function slide(item, d) {
  const s = h("div.slide");
  if (!item) return s;
  if (item.compare) return compareSlide(s, item);
  if (item.video) {
    s.appendChild(h("video", { src: item.url, controls: d === 0, playsInline: true, loop: true, preload: d === 0 ? "auto" : "metadata" }));
    return s;
  }
  const img = h("img", { decoding: "async", draggable: false });
  img.src = item.mid && !S.settings.hd ? item.mid : item.url;
  if (item.mid && !S.settings.hd) img.dataset.hd = item.url;
  s.appendChild(img);
  return s;
}

function compareSlide(s, item) {
  const box = h("div.cmp");
  const a = h("div.b", h("img", { src: item.compare.a, draggable: false }));
  const b = h("div.b", h("img", { src: item.compare.b, draggable: false }));
  const line = h("div.line");
  box.append(a, b, line, h("span.tag", { style: { left: "10px" } }, "before"), h("span.tag", { style: { right: "10px" } }, "after"));
  s.appendChild(box);
  let pos = 0.5;
  const set = (p) => { pos = Math.max(0, Math.min(1, p)); b.style.clipPath = `inset(0 0 0 ${pos * 100}%)`; line.style.left = pos * 100 + "%"; };
  set(0.5);
  box.dataset.compare = "1";
  box._set = (x) => set(x / box.clientWidth);
  return s;
}

function loadHD(manual) {
  const img = V.slides[1]?.querySelector("img[data-hd]");
  if (!img) { if (manual) toast("Already full resolution"); return; }
  const full = new Image();
  full.onload = () => { img.src = full.src; delete img.dataset.hd; if (V) V.hdBtn.style.color = "var(--acc)"; };
  full.src = img.dataset.hd;
  if (manual) toast("Loading full resolution…");
}

function updateChrome() {
  const v = V, it = cur();
  if (!it) return;
  clear(v.titleEl, h("div.ell", it.title || it.f || ""), h("small", [`${v.index + 1} / ${v.items.length}${v.opts.hasMore?.() ? "+" : ""}`, it.m ? " · " + ago(it.m) : ""].join("")));
  v.hdBtn.style.display = it.mid && !it.video && !it.compare ? "" : "none";
  v.hdBtn.style.color = v.slides[1]?.querySelector("img[data-hd]") ? "" : "var(--acc)";
  const B = (ic, label, fn, on) => h("button" + (on ? ".on" : ""), { onclick: fn }, icon(ic), label);
  const isOut = !!it.f;
  clear(v.bot,
    isOut && B("star", "Favorite", toggleFav, it.fav),
    B("info", "Info", info),
    (isOut || it.ref) && !it.video && B("recycle", "Remix", () => remix(false)),
    (it.ref) && !it.video && B("zap", "Upscale", () => useSource("Upscale")),
    (it.ref) && !it.video && B("brush", "Inpaint", () => useSource("Inpaint")),
    B("download", "Save", download),
    isOut && B("trash", "Trash", trash));
}

// ------------------------------------------------------------ navigation
async function go(dir) {
  const v = V;
  let n = v.index + dir;
  if (n >= v.items.length && v.opts.loadMore) {
    v.items = await v.opts.loadMore();
  }
  if (n < 0 || n >= v.items.length) { snap(); return; }
  haptic(4);
  v.track.style.transition = "transform .22s ease-out";
  v.track.style.transform = `translateX(${-100 - dir * 100}vw)`;
  setTimeout(() => {
    v.index = n;
    v.zoom = { s: 1, x: 0, y: 0 };
    v.track.style.transition = "none";
    const nxt = slide(v.items[n + dir], dir);
    if (dir > 0) { v.slides[0].remove(); v.slides = [v.slides[1], v.slides[2], nxt]; v.track.appendChild(nxt); }
    else { v.slides[2].remove(); v.slides = [nxt, v.slides[0], v.slides[1]]; v.track.prepend(nxt); }
    v.slides.forEach((s, i) => s.querySelectorAll("video").forEach((vid) => { vid.controls = i === 1; if (i !== 1) vid.pause(); }));
    v.track.style.transform = "translateX(-100vw)";
    updateChrome();
    if (S.settings.hd) loadHD(false);
  }, 220);
}
function snap() {
  V.track.style.transition = "transform .2s ease-out";
  V.track.style.transform = "translateX(-100vw)";
  V.el.style.background = "";
  V.track.style.opacity = "";
}

function applyZoom() {
  const img = V.slides[1]?.querySelector("img");
  if (!img) return;
  const z = V.zoom;
  img.style.transformOrigin = "50% 50%";
  img.style.transform = `translate(${z.x}px, ${z.y}px) scale(${z.s})`;
  if (z.s > 1.4) loadHD(false);
}
function clampZoom() {
  const img = V.slides[1]?.querySelector("img");
  if (!img) return;
  const z = V.zoom;
  z.s = Math.max(1, Math.min(z.s, 8));
  const mx = Math.max(0, (img.clientWidth * z.s - innerWidth) / 2), my = Math.max(0, (img.clientHeight * z.s - innerHeight) / 2);
  z.x = Math.max(-mx, Math.min(mx, z.x)); z.y = Math.max(-my, Math.min(my, z.y));
  if (z.s === 1) { z.x = 0; z.y = 0; }
}

function bindGestures() {
  const v = V, el = v.el;
  const pts = new Map();
  let start = null, mode = null, pinch0 = null, lastTap = 0, tapTimer = null, moved = false;
  const center = () => ({ x: innerWidth / 2, y: innerHeight / 2 });
  const down = (e) => {
    if (e.target.closest(".vtop, .vbot") || e.target.closest("video")) return;
    el.setPointerCapture?.(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    if (pts.size === 1) {
      start = { x: e.clientX, y: e.clientY, zx: v.zoom.x, zy: v.zoom.y, t: Date.now() };
      mode = null;
      const cmp = v.slides[1]?.querySelector("[data-compare]");
      if (cmp && v.zoom.s === 1) { const line = cmp.querySelector(".line").getBoundingClientRect(); if (Math.abs(e.clientX - line.left) < 60) mode = "compare"; }
    } else if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      pinch0 = { d: Math.hypot(a.x - b.x, a.y - b.y), s: v.zoom.s, x: v.zoom.x, y: v.zoom.y, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      mode = "pinch";
    }
  };
  const move = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === "pinch" && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const s2 = Math.max(0.8, Math.min(8, pinch0.s * d / pinch0.d));
      const c = center();
      const px = pinch0.cx - c.x, py = pinch0.cy - c.y;
      const mx = (a.x + b.x) / 2 - pinch0.cx, my = (a.y + b.y) / 2 - pinch0.cy;
      v.zoom.s = s2;
      v.zoom.x = px - (px - pinch0.x) * (s2 / pinch0.s) + mx;
      v.zoom.y = py - (py - pinch0.y) * (s2 / pinch0.s) + my;
      applyZoom(); moved = true;
      return;
    }
    if (!start || pts.size !== 1) return;
    const dx = e.clientX - start.x, dy = e.clientY - start.y;
    if (!moved && Math.hypot(dx, dy) < 8) return;
    moved = true;
    if (mode === "compare") { v.slides[1].querySelector("[data-compare]")._set(e.clientX); return; }
    if (!mode) mode = v.zoom.s > 1.01 ? "pan" : Math.abs(dx) > Math.abs(dy) ? "swipe" : dy > 0 ? "close" : "none";
    if (mode === "pan") { v.zoom.x = start.zx + dx; v.zoom.y = start.zy + dy; clampZoom(); applyZoom(); }
    else if (mode === "swipe") { v.track.style.transition = "none"; v.track.style.transform = `translateX(calc(-100vw + ${dx}px))`; }
    else if (mode === "close") {
      const p = Math.min(1, dy / 300);
      v.track.style.transition = "none";
      v.track.style.transform = `translate(-100vw, ${dy}px) scale(${1 - p * 0.25})`;
      v.el.style.background = `rgba(0,0,0,${1 - p})`;
      v.el.classList.add("chrome-off");
    }
  };
  const up = (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    if (mode === "pinch") {
      if (pts.size === 0) { clampZoom(); const img = v.slides[1]?.querySelector("img"); if (img) img.style.transition = "transform .18s"; applyZoom(); setTimeout(() => img && (img.style.transition = ""), 200); mode = null; }
      else { const [p] = [...pts.values()]; start = { x: p.x, y: p.y, zx: v.zoom.x, zy: v.zoom.y, t: Date.now() }; mode = v.zoom.s > 1.01 ? "pan" : "none"; }
      return;
    }
    if (pts.size) return;
    const dx = e.clientX - (start?.x ?? 0), dy = e.clientY - (start?.y ?? 0);
    const fast = Date.now() - (start?.t ?? 0) < 260;
    if (mode === "swipe") { if (Math.abs(dx) > innerWidth * 0.22 || (fast && Math.abs(dx) > 40)) go(dx < 0 ? 1 : -1); else snap(); }
    else if (mode === "close") { if (dy > 120 || (fast && dy > 60)) { v.el.style.background = ""; v.close(); } else { snap(); v.el.classList.toggle("chrome-off", !v.chrome); } }
    else if (!moved) {
      const now = Date.now();
      if (now - lastTap < 280) {
        clearTimeout(tapTimer); lastTap = 0;
        const img = v.slides[1]?.querySelector("img");
        if (!img) return;
        const c = center();
        if (v.zoom.s > 1.05) v.zoom = { s: 1, x: 0, y: 0 };
        else { const s = 2.6, px = e.clientX - c.x, py = e.clientY - c.y; v.zoom = { s, x: -px * (s - 1), y: -py * (s - 1) }; clampZoom(); }
        img.style.transition = "transform .2s"; applyZoom(); setTimeout(() => (img.style.transition = ""), 220);
      } else {
        lastTap = now;
        tapTimer = setTimeout(() => { v.chrome = !v.chrome; v.el.classList.toggle("chrome-off", !v.chrome); }, 280);
      }
    }
    mode = null; start = null;
  };
  el.addEventListener("pointerdown", down);
  el.addEventListener("pointermove", move);
  el.addEventListener("pointerup", up);
  el.addEventListener("pointercancel", up);
  const key = (e) => { if (e.key === "ArrowRight") go(1); else if (e.key === "ArrowLeft") go(-1); };
  addEventListener("keydown", key);
  v.cleanup = () => { removeEventListener("keydown", key); el.removeEventListener("pointerdown", down); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); el.removeEventListener("pointercancel", up); };
}

// ------------------------------------------------------------ actions
async function meta(full = false) {
  const it = cur();
  const q = it.f ? `f=${encodeURIComponent(it.f)}` : `a=1&f=${encodeURIComponent(it.ref)}`;
  return api(`/waifu/m/api/meta?${q}${full ? "&full=1" : ""}`);
}

async function toggleFav() {
  const it = cur();
  it.fav = !it.fav;
  haptic(12);
  updateChrome();
  await api("/waifu/m/api/favs", { json: it.fav ? { add: [it.f] } : { remove: [it.f] } });
  V.opts.onChange?.("fav", it);
}

function info() {
  const it = cur();
  sheet({
    title: "Image info", full: true,
    body: async (bd) => {
      bd.appendChild(h("span.spin"));
      let m;
      try { m = await meta(); } catch (e) { clear(bd, h("div.mute", "No info: " + e.message)); return; }
      clear(bd);
      const kv = h("div.kv");
      const row = (k, val) => kv.append(h("div.k", k), h("div.v", String(val)));
      row("file", it.f || it.ref);
      if (m.w) row("size", `${m.w} × ${m.h} · ${fmtBytes(m.size)}`);
      row("saved", new Date(m.mtime * 1000).toLocaleString());
      for (const r of m.rows || []) row(r.k, r.v);
      bd.appendChild(kv);
      const txt = (label, t) => t && bd.append(h("div.lbl", label), h("div.ptext", t, h("button.ibtn.sm.cp", { onclick: () => copyText(t) }, icon("copy"))));
      txt("Positive", m.positive);
      txt("Negative", m.negative);
      if (m.has_workflow) {
        bd.appendChild(h("div.row", { style: { marginTop: "4px" } },
          h("button.btn.pri.grow", { onclick: () => remix(false) }, icon("recycle"), "Remix (all settings)"),
          m.waifu && h("button.btn.grow", { onclick: () => remix(true) }, icon("seed"), "Seed only")));
      }
    },
  });
}

async function remix(seedOnly) {
  let m;
  try { m = await meta(true); } catch (e) { return toast("Could not read the image: " + e.message, { err: true }); }
  const seedNode = m.prompt && Object.values(m.prompt).find((n) => n.class_type === "Seed (rgthree)");
  const seed = seedNode ? Number(seedNode.inputs.seed) : null;
  if (seedOnly) {
    const r = S.graph.roles();
    if (!r.seed || seed == null) return toast("No seed found", { err: true });
    r.seed.widgets_values[0] = seed;
    changed({ all: true });
    toast(`Seed locked to ${seed}`);
    return;
  }
  if (!m.workflow) return toast("This image has no workflow in it", { err: true });
  if (!m.waifu && !(await confirmSheet("Not a Waifu Studio image", "This image was made with a different workflow. The Create tab will only show 'All nodes' for it. Load it anyway?", "Load"))) return;
  const wf = m.workflow;
  const sn = wf.nodes?.find((n) => n.type === "Seed (rgthree)");
  if (sn && seed != null && seed >= 0) sn.widgets_values[0] = seed;
  await setWorkflow(wf, "image: " + (it().title || "remix"));
  V?.close();
  document.dispatchEvent(new CustomEvent("waifu-tab", { detail: "create" }));
  toast(seed != null ? `Settings loaded, seed locked to ${seed}` : "Settings loaded");
}
const it = () => cur() || {};

async function useSource(mode) {
  const item = cur();
  const { useAsSource, inpaintFrom } = await import("./create.js");
  V.close();
  if (mode === "Inpaint") inpaintFrom(item.ref); else useAsSource(item.ref, "Upscale");
}

function download() {
  const item = cur();
  const a = h("a", { href: item.url, download: item.title || "image.png" });
  document.body.appendChild(a); a.click(); a.remove();
  toast("Downloading original");
}

async function trash() {
  const item = cur();
  const res = await api("/waifu/m/api/trash", { json: { files: [item.f] } });
  if (!res.moved.length) return toast("Could not move it", { err: true });
  haptic(15);
  markTrashed(res.moved.map((m) => m[0]));
  V.opts.onChange?.("trash", item);
  const idx = V.items.indexOf(item);
  if (idx >= 0) V.items.splice(idx, 1); // (the gallery's own handler may already have removed it)
  toast("Moved to trash", { action: { label: "Undo", fn: async () => { await api("/waifu/m/api/restore", { json: { moved: res.moved } }); markTrashed(res.moved.map((m) => m[0]), false); toast("Restored – refresh the gallery to see it"); } } });
  if (!V.items.length) return V.close();
  V.index = Math.min(V.index, V.items.length - 1);
  V.zoom = { s: 1, x: 0, y: 0 };
  render();
}

function moreMenu() {
  const item = cur();
  sheet({
    title: item.title || "Image",
    body: (bd, close) => {
      const opt = (ic, t, fn) => bd.appendChild(h("button.opt", { onclick: () => { close(); fn(); } }, h("span.ck", icon(ic)), h("span.grow", h("div.t", t))));
      opt("copy", "Copy file path", () => copyText(item.f || item.ref));
      opt("eye", "Open original in a new tab", () => window.open(item.url, "_blank"));
      opt("maximize", (S.settings.hd ? "Stop loading" : "Always load") + " full resolution", () => { S.settings.hd = !S.settings.hd; saveSettings(); if (S.settings.hd) loadHD(false); });
      if (navigator.share && window.isSecureContext) opt("share", "Share…", async () => {
        try { const b = await (await fetch(item.url)).blob(); await navigator.share({ files: [new File([b], item.title || "image.png", { type: b.type })] }); } catch {}
      });
    },
  });
}
