// App shell: tabs, generate button, now-running strip, back-button handling.
import { h, icon, clear, toast, sheet, pushLayer, longPress, haptic, copyText } from "./util.js";
import { S, on, boot, queue } from "./comfy.js";
import { createView, genMenu } from "./create.js";
import { Gallery } from "./gallery.js";
import { queueView } from "./queue.js";
import { lorasView } from "./loras.js";
import { initAutocomplete } from "./widgets.js";

const app = document.getElementById("app");
const views = {}, tabs = {};
let current = "create", tabLayer = null, gallery = null;
const scrollMem = {};

function mkView(name, init) {
  const el = h("div.view.off");
  app.appendChild(el);
  views[name] = { el, init, ready: false };
}

function show(name, fromBack = false) {
  if (name === current && views[name].ready) return;
  const prev = views[current];
  if (prev) { const sc = prev.el.querySelector(".scroll"); if (sc) scrollMem[current] = sc.scrollTop; prev.el.classList.add("off"); }
  const v = views[name];
  if (!v.ready) { v.init(v.el); v.ready = true; }
  v.el.classList.remove("off");
  const sc = v.el.querySelector(".scroll");
  if (sc && scrollMem[name] != null) sc.scrollTop = scrollMem[name];
  Object.entries(tabs).forEach(([k, t]) => t.classList.toggle("on", k === name));
  current = name;
  v.el._shown?.();
  if (name === "gallery") gallery?.shown();
  // back button: from any other tab, back returns to Create
  if (name !== "create" && !tabLayer && !fromBack) tabLayer = pushLayer(() => { tabLayer = null; show("create", true); });
  if (name === "create" && tabLayer && !fromBack) { const t = tabLayer; tabLayer = null; t(); }
  drawNow();
}

function nav() {
  const tab = (name, ic, label) => (tabs[name] = h("button.tab", { onclick: () => { haptic(4); if (current === name) scrollTop(name); else show(name); } }, icon(ic), label));
  const ring = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  ring.setAttribute("class", "ring"); ring.setAttribute("viewBox", "0 0 74 74");
  ring.innerHTML = `<circle cx="37" cy="37" r="34" stroke-dasharray="213.6" stroke-dashoffset="213.6"></circle>`;
  const count = h("span.count.hidden");
  const gen = h("button", { id: "gen", "aria-label": "Generate" }, ring, icon("zap"), count);
  gen.onclick = async () => {
    try { await queue(1); toast(S.remaining > 0 || S.run ? "Queued" : "Generating…"); } catch {}
  };
  longPress(gen, () => genMenu());
  const qtab = tab("queue", "list", "Queue");
  const badge = h("span.badge.hidden");
  qtab.appendChild(badge);
  const bar = h("nav.tabs", tab("create", "wand", "Create"), tab("gallery", "image", "Gallery"), gen, qtab, tab("loras", "layers", "LoRAs"));
  document.body.appendChild(bar);
  const circ = ring.querySelector("circle");
  const upd = () => {
    const r = S.run;
    const p = r?.max ? r.value / r.max : r ? 0.03 : 0;
    circ.setAttribute("stroke-dashoffset", String(213.6 * (1 - p)));
    circ.style.opacity = r ? 0.95 : 0;
    const n = S.remaining;
    count.textContent = n; count.classList.toggle("hidden", !n);
    badge.textContent = S.queue.pending.length; badge.classList.toggle("hidden", !S.queue.pending.length);
  };
  on("run", upd); on("status", upd); on("queue", upd); on("jobs", upd);
}

function scrollTop(name) {
  const sc = views[name].el.querySelector(".scroll");
  sc?.scrollTo({ top: 0, behavior: "smooth" });
}

// now-running strip, shown on tabs other than Create/Queue
let nowEl;
function drawNow() {
  if (!nowEl) { nowEl = h("div", { id: "nowbar", class: "hidden", onclick: () => show("queue") }); document.body.appendChild(nowEl); }
  const r = S.run;
  const showIt = r && current !== "create" && current !== "queue";
  nowEl.classList.toggle("hidden", !showIt);
  if (!showIt) return;
  const job = S.jobs.get(r.id);
  clear(nowEl,
    r.preview ? h("img", { src: r.preview }) : h("div.ph"),
    h("div.grow", h("div.t.ell", job ? job.desc : "PC job running"), h("div.s.ell", [job?.titles[r.node], r.max ? `${r.value}/${r.max}` : ""].filter(Boolean).join(" · ") || "working…")),
    h("button.ibtn.sm", { onclick: (e) => { e.stopPropagation(); import("./comfy.js").then((m) => m.interrupt()); } }, icon("stop")),
    h("div.bar", { style: { width: (r.max ? (r.value / r.max) * 100 : 3) + "%" } }));
}

function queueErrorSheet(body) {
  const err = body?.error || {};
  const nodes = body?.node_errors || {};
  const titles = {};
  for (const n of S.graph?.nodes || []) titles[n.id] = S.graph.title(n);
  const lines = [];
  for (const [id, ne] of Object.entries(nodes)) for (const e of ne.errors || []) lines.push(`${titles[id] || ne.class_type} (#${id}): ${e.message}${e.details ? " – " + e.details : ""}`);
  const text = [err.message, err.details, ...lines].filter(Boolean).join("\n\n");
  sheet({ title: "ComfyUI refused the job", body: h("div", h("div.ptext", text || JSON.stringify(body), h("button.ibtn.sm.cp", { onclick: () => copyText(text) }, icon("copy"))),
    h("div.hint", { style: { marginTop: "8px" } }, "Usually a missing model/LoRA file or a moved image.")) });
}

async function start() {
  initAutocomplete();
  mkView("create", createView);
  mkView("gallery", (el) => { gallery = new Gallery(el); });
  mkView("queue", queueView);
  mkView("loras", lorasView);
  nav();
  on("run", drawNow); on("preview", drawNow);
  on("queueError", queueErrorSheet);
  document.addEventListener("waifu-tab", (e) => show(e.detail));
  try {
    await boot();
  } catch (e) {
    console.error(e);
    clear(app, h("div.empty-state", h("h2", "Could not start"), h("div", e.message), h("button.btn", { style: { marginTop: "16px" }, onclick: () => location.reload() }, "Retry"),
      h("button.btn.ghost", { style: { marginTop: "16px" }, onclick: () => { localStorage.removeItem("wm:wf"); location.reload(); } }, "Reset phone copy")));
    return;
  }
  show("create");
  document.getElementById("splash")?.remove();
  if ("serviceWorker" in navigator && window.isSecureContext) navigator.serviceWorker.register("/waifu/m/sw.js", { scope: "/waifu/m/" }).catch(() => {});
}

start();
