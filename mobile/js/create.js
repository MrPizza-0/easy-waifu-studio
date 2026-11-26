// Create tab: the whole Waifu Studio control panel, phone-sized.
import { h, icon, clear, section, seg, toggle, numField, field, pick, sheet, toast, haptic, short, api, copyText,
  longPress, confirmSheet, promptSheet, store } from "./util.js";
import { S, on, changed, queue, undo, canUndo, loadWorkflowFile, saveWorkflowFile, listWorkflows, lastPcRun,
  setWorkflow, loras, jobImages, jobCompare, viewUrl, relOf, saveSettings, imThumb } from "./comfy.js";
import { randomSeed, SEED_MAX, outfitFamilies } from "./graph.js";
import { pickCharacter, pickOutfit, charOutfits, famBadges, charImage } from "./chars.js";
import { addCharacterSheet, editCharacter, civitaiFlow, exportPack, importPack, autoPicture, addStyleSheet, editStyle } from "./charedit.js";
import { widgetControl, nodeFields, allNodesSheet, tagArea } from "./widgets.js";
import { openViewer } from "./viewer.js";
import { pickFromGallery } from "./gallery.js";
import { loraPicker, loraInfo } from "./loras.js";
import { maskPainter } from "./mask.js";
import { modelsSheet, missingFor } from "./models.js";

const STAGE_ORDER = ["hires", "face", "hands", "mouth", "ultra"];
const STAGE_NAMES = { hires: ["🔍", "Upscale 2x"], face: ["🙂", "Face"], hands: ["✋", "Hands"], mouth: ["👄", "Mouth"], ultra: ["💎", "Ultra 4x"] };
const MODE_LABEL = (m) => m.startsWith("Upscale") ? "Upscale" : m.startsWith("Inpaint") ? "Inpaint" : m.split(" ")[0];

let root, scroller, jump, secs = {}, resultBox, selImage = 0;
const g = () => S.graph;
const R = () => S.graph.roles();

export function createView(el) {
  root = el;
  const undoBtn = h("button.ibtn", { onclick: () => undo(), title: "Undo" }, icon("undo"));
  const sub = h("small");
  const top = h("div.topbar", h("h1", "Waifu Studio", sub), undoBtn, h("button.ibtn", { onclick: workflowMenu }, icon("more")));
  jump = h("div.jump");
  scroller = h("div.scroll");
  el.append(top, jump, scroller);
  const updTop = () => { undoBtn.style.opacity = canUndo() ? 1 : 0.35; sub.textContent = (S.connected ? "" : "⚠ offline · ") + "workflow: " + S.source.replace(/\.json$/, ""); };
  on("graph", (o) => { updTop(); if (o?.all) build(); else updateSubs(); });
  on("conn", updTop);
  on("run", () => drawResult());
  on("preview", () => drawResult());
  on("jobOutput", () => drawResult());
  on("trashed", () => { selImage = 0; drawResult(); });
  on("jobDone", (job) => { selImage = 0; drawResult(); if (job?.images?.length) scroller.scrollTo({ top: 0, behavior: "smooth" }); autoPicture(job); });
  build();
  updTop();
}

function build() {
  if (!S.graph) return;
  const keep = scroller.scrollTop;
  clear(scroller);
  secs = {};
  resultBox = h("div.result", { id: "sec-result" });
  scroller.appendChild(resultBox);
  drawResult();
  const r = R();
  const add = (key, s) => { if (s) { secs[key] = s; scroller.appendChild(s); } };
  add("run", runSection());
  if (r.presets) add("presets", presetSection());
  if (r.text) add("prompt", promptSection());
  if (r.pll) add("loras", loraSection());
  if (r.canvas) add("size", sizeSection());
  if (r.settings) add("sampler", samplerSection());
  if (r.loader || r.ckpt) add("model", modelSection());
  add("adv", advancedSection());
  scroller.appendChild(h("div", { style: { height: "90px" } }));
  buildJump();
  updateSubs();
  scroller.scrollTop = keep;
}

function buildJump() {
  const names = { result: "Result", run: "Run", presets: "Presets", prompt: "Prompt", loras: "LoRAs", size: "Size", sampler: "Sampler", model: "Model", adv: "Advanced" };
  const keys = ["result", ...Object.keys(secs)];
  const btns = {};
  clear(jump, keys.map((k) => (btns[k] = h("button", {
    onclick: () => {
      const el = k === "result" ? resultBox : secs[k];
      if (el.classList.contains("collapsed")) el.querySelector(".hd").click();
      scroller.scrollTo({ top: el.offsetTop - 6, behavior: "smooth" });
    },
  }, names[k]))));
  const io = new IntersectionObserver((ents) => {
    for (const e of ents) {
      const k = e.target.id.replace("sec-", "");
      if (e.isIntersecting) { Object.values(btns).forEach((b) => b.classList.remove("on")); btns[k]?.classList.add("on"); btns[k]?.scrollIntoView({ inline: "center", block: "nearest" }); break; }
    }
  }, { root: scroller, rootMargin: "0px 0px -75% 0px" });
  [resultBox, ...Object.values(secs)].forEach((s) => io.observe(s));
}

function updateSubs() {
  const r = R(), G = g();
  const set = (k, t) => { if (secs[k]) secs[k].sub.textContent = t; };
  if (r.presets) { const rc = G.resolveCharacter(S.presets); set("presets", [G.get(r.presets, "character"), rc?.name, short(G.get(r.presets, "model_preset"))].filter(Boolean).join(" · ")); }
  if (r.text) set("prompt", (G.get(r.text, "scene") || "").slice(0, 40));
  if (r.pll) set("loras", `${G.loraRows().filter((x) => x.on).length} on / ${G.loraRows().length}`);
  if (r.canvas) {
    const sz = G.get(r.canvas, "size") || "";
    set("size", (sz.startsWith("Custom") ? `${G.get(r.canvas, "width")}×${G.get(r.canvas, "height")}` : sz.replace(/^\S+ /, "")) + ` · batch ${G.get(r.canvas, "batch")}`);
  }
  if (r.settings) set("sampler", `${G.get(r.settings, "steps")} · cfg ${G.get(r.settings, "cfg")} · ${G.get(r.settings, "sampler_name")}`);
  if (r.loader) set("model", short(String(G.get(r.loader, "kind")).startsWith("Anima") ? G.get(r.loader, "unet") : G.get(r.loader, "checkpoint")));
  if (secs.run) {
    const mode = r.mode ? MODE_LABEL(G.get(r.mode, "mode")) : "";
    const st = STAGE_ORDER.filter((k) => r.switches[k] && G.get(r.switches[k], "on")).map((k) => STAGE_NAMES[k][1]);
    secs.run.sub.textContent = [mode, st.join(" + ") || "preview"].filter(Boolean).join(" · ");
  }
}

// ------------------------------------------------------------ result card
function lastJob() {
  if (S.run?.mine) return S.jobs.get(S.run.id);
  for (let i = S.order.length - 1; i >= 0; i--) {
    const j = S.jobs.get(S.order[i]);
    if (j?.images?.length && jobImages(j).length) return j;
  }
  return null;
}

function drawResult() {
  if (!resultBox) return;
  const job = lastJob();
  const running = S.run?.mine && S.run.id === job?.id;
  const imgs = job ? jobImages(job) : [];
  clear(resultBox);
  if (running && S.run.preview && !(imgs.length && S.run.node == null)) {
    const pct = S.run.max ? `${S.run.value}/${S.run.max}` : "";
    resultBox.append(h("div.stage-img", h("img", { src: S.run.preview }),
      h("div.ov", h("span", job.titles[S.run.node] || "working…"), pct && h("span", pct))));
  } else if (imgs.length) {
    if (selImage >= imgs.length) selImage = 0;
    const im = imgs[selImage];
    const img = h("img", { src: imThumb(im, 1800), onclick: () => openViewer(imgs.map(toItem), selImage) });
    resultBox.append(h("div.stage-img", img, h("div.ov",
      h("span", im.type === "output" ? "final" : (im.title || "preview").replace(/^[^\w]+/, "").slice(0, 30)),
      job.seed != null && h("span", "seed " + job.seed),
      running && h("span", "still running…"))));
    if (imgs.length > 1) {
      resultBox.append(h("div.strip", imgs.map((x, i) => h("img" + (i === selImage ? ".sel" : ""), { src: imThumb(x, 200), onclick: () => { selImage = i; drawResult(); } }))));
    }
  } else if (running) {
    resultBox.append(h("div.empty", h("span.spin"), h("div", { style: { marginTop: "8px" } }, job.titles[S.run.node] || "Starting…")));
  } else {
    resultBox.append(h("div.empty", "Your results show up here. Tap the ⚡ button to generate. Hold it to queue several."));
    return;
  }
  const final = imgs.find((x) => x.type === "output") || imgs[selImage];
  const acts = h("div.acts");
  const A = (ic, label, fn, cls = "") => acts.appendChild(h("button.btn.sm" + cls, { onclick: fn }, icon(ic), label));
  if (job?.seed != null) A("recycle", "Use seed", () => { setSeed(job.seed); toast(`Seed locked to ${job.seed}. Switch stages on and generate again.`); });
  if (final) {
    A("maximize", "Open", () => openViewer(imgs.map(toItem), Math.max(0, imgs.indexOf(final))));
    if (final.type === "output") {
      A("zap", "Upscale this", () => useAsSource(relOf(final) + " [output]", "Upscale"));
      A("brush", "Inpaint this", () => inpaintFrom(relOf(final) + " [output]"));
    }
  }
  const cmp = job && imgs.length && jobCompare(job);
  if (cmp) A("compare", "Compare", () => openViewer([{ ...toItem(cmp.b), compare: { a: viewUrl(cmp.a), b: viewUrl(cmp.b), title: cmp.title } }], 0));
  if (job?.text) {
    const ft = Object.entries(job.text).find(([n]) => /final prompt/i.test(job.titles[n] || ""))?.[1] || Object.values(job.text)[0];
    A("text", "Prompt used", () => sheet({ title: "Final prompt actually used", body: h("div.ptext", ft, h("button.ibtn.sm.cp", { onclick: () => copyText(ft) }, icon("copy"))) }));
  }
  resultBox.appendChild(acts);
}

export const toItem = (im) => ({ url: viewUrl(im), mid: imThumb(im, 1800), f: im.type === "output" ? relOf(im) : null, ref: relOf(im) + ` [${im.type || "output"}]`, title: im.title, temp: im.type !== "output", filename: im.filename });

// ------------------------------------------------------------ run: mode, source, stages, seed
function setSeed(v) {
  const r = R();
  if (!r.seed) return;
  r.seed.widgets_values[0] = v;
  changed();
  if (secs.run) secs.run.replaceWith(secs.run = runSection());
  updateSubs();
}

export function useAsSource(ref, mode = "Upscale") {
  const r = R(), G = g();
  if (!r.load || !r.mode) return toast("This workflow has no Load Image / Mode node", { err: true });
  G.set(r.load, "image", ref, true);
  const opt = G.widget(r.mode, "mode").options.find((o) => o.startsWith(mode));
  G.set(r.mode, "mode", opt);
  if (mode === "Inpaint" && r.scale && r.scale.mode !== 4) { r.scale.mode = 4; toast("Downscale node bypassed: the mask is not scaled with the image."); }
  changed();
  build();
  document.dispatchEvent(new CustomEvent("waifu-tab", { detail: "create" }));
  setTimeout(() => scroller.scrollTo({ top: secs.run.offsetTop - 6, behavior: "smooth" }), 50);
  if (mode === "Upscale") toast("Source set, mode is now Upscale From. Switch stages on and generate.");
}

export async function inpaintFrom(ref) {
  const name = await maskPainter(ref);
  if (name) useAsSource(name, "Inpaint");
}

function runSection() {
  return section({
    id: "run", title: "Run", icon: "zap",
    body: (bd) => {
      const r = R(), G = g();
      if (r.mode) {
        const w = G.widget(r.mode, "mode");
        bd.appendChild(seg(w.options.map((o) => [o, MODE_LABEL(o)]), G.get(r.mode, "mode"), (v) => { G.set(r.mode, "mode", v); changed(); secs.run.replaceWith(secs.run = runSection()); updateSubs(); }));
        const mode = G.get(r.mode, "mode") || "";
        if (!mode.startsWith("Generate") && r.load) bd.appendChild(sourceCard(mode.startsWith("Inpaint")));
      }
      const tiles = h("div.stages");
      for (const key of STAGE_ORDER) {
        const sw = r.switches[key];
        if (!sw) continue;
        const [em, nm] = STAGE_NAMES[key];
        const onNow = !!G.get(sw, "on");
        const t = h("button.stage" + (onNow ? ".on" : ""), h("span.em", em), h("span.nm", nm),
          h("span.cog", { onclick: (e) => { e.stopPropagation(); stageSheet(key); } }, icon("sliders")));
        t.onclick = () => { const v = !G.get(sw, "on"); G.set(sw, "on", v); t.classList.toggle("on", v); haptic(); changed(); updateSubs(); };
        tiles.appendChild(t);
      }
      if (tiles.children.length) bd.append(h("div.lbl", "Stages"), tiles);
      if (r.seed) bd.appendChild(seedRow());
    },
  });
}

function seedRow() {
  const r = R();
  const cur = Number(r.seed.widgets_values[0]);
  const random = cur === -1 || cur === -2 || cur === -3;
  const inp = h("input.inp", { inputMode: "numeric", value: random ? "" : String(cur), placeholder: "random every run", style: { fontVariantNumeric: "tabular-nums" } });
  inp.onchange = () => { const v = parseInt(inp.value, 10); setSeed(Number.isFinite(v) ? Math.min(SEED_MAX, Math.max(0, v)) : -1); };
  const dice = h("button.btn" + (random ? ".pri" : ""), { onclick: () => setSeed(random ? (S.lastSeed ?? randomSeed()) : -1) }, icon("dice"), random ? "Random" : "Fixed");
  const last = h("button.btn", { disabled: S.lastSeed == null, onclick: () => setSeed(S.lastSeed) }, icon("recycle"), "Last");
  const nw = h("button.btn", { onclick: () => setSeed(randomSeed()) }, icon("refresh"));
  return h("div", h("div.lbl", "Seed", S.lastSeed != null && h("span", { onclick: () => copyText(String(S.lastSeed)) }, "last used: " + S.lastSeed)),
    h("div.row", h("div.grow", inp), dice, nw, last));
}

function sourceCard(inpaint) {
  const r = R(), G = g();
  const val = G.get(r.load, "image") || "";
  const thumb = h("img", { src: `/waifu/m/api/thumb?a=1&s=360&f=${encodeURIComponent(val)}&v=${encodeURIComponent(val)}`, style: { width: "84px", height: "112px", objectFit: "cover", borderRadius: "10px", background: "var(--s3)", flex: "none" }, onerror: (e) => { e.target.style.visibility = "hidden"; } });
  thumb.onclick = () => openViewer([{ url: `/view?filename=${encodeURIComponent(val.replace(/ \[\w+\]$/, "").split("/").pop())}&subfolder=${encodeURIComponent(val.replace(/ \[\w+\]$/, "").split("/").slice(0, -1).join("/"))}&type=${(val.match(/\[(\w+)\]$/) || [0, "input"])[1]}`, ref: val, title: val }], 0);
  const upload = h("input", { type: "file", accept: "image/*", style: { display: "none" } });
  upload.onchange = async () => {
    const f = upload.files[0];
    if (!f) return;
    const fd = new FormData();
    fd.append("image", f, f.name || "phone.png");
    fd.append("subfolder", "waifu_mobile");
    fd.append("type", "input");
    toast("Uploading…");
    try {
      const res = await api("/upload/image", { method: "POST", body: fd });
      const ref = (res.subfolder ? res.subfolder + "/" : "") + res.name;
      if (inpaint) inpaintFrom(ref); else useAsSource(ref, "Upscale");
    } catch (e) { toast("Upload failed: " + e.message, { err: true }); }
  };
  const btns = h("div", { style: { display: "flex", flexDirection: "column", gap: "6px", flex: 1, minWidth: 0 } },
    h("div.hint.ell", val || "no image"),
    h("div.row.wrap",
      h("button.btn.sm", { onclick: async () => { const ref = await pickFromGallery(); if (ref) inpaint ? inpaintFrom(ref) : useAsSource(ref, "Upscale"); } }, icon("image"), "Gallery"),
      h("button.btn.sm", { onclick: () => upload.click() }, icon("upload"), "Phone"),
      inpaint && h("button.btn.sm.pri", { onclick: () => inpaintFrom(val) }, icon("brush"), "Paint mask")),
    inpaint && h("button.btn.sm.ghost", { style: { alignSelf: "flex-start" }, onclick: () => stageSheet("inpaint") }, icon("sliders"), "Inpaint prompt & settings"));
  const box = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } }, h("div.row", { style: { alignItems: "flex-start" } }, thumb, btns), upload);
  if (r.scale) {
    const on = r.scale.mode !== 4;
    box.appendChild(h("div.row", h("div.grow", h("div", { style: { fontSize: "14px" } }, "Downscale source first"), h("div.hint", inpaint ? "Keep off for inpaint (the mask is not scaled)." : "")),
      toggle(on, (v) => { r.scale.mode = v ? 0 : 4; changed(); secs.run.replaceWith(secs.run = runSection()); })));
    if (on) {
      const mp = G.widget(r.scale, "megapixels");
      if (mp) box.appendChild(widgetControl(r.scale, mp, { label: "megapixels", slider: [0.25, 4] }));
    }
  }
  return box;
}

// ------------------------------------------------------------ stage settings
export function stageSheet(key) {
  const r = R(), G = g();
  const st = r.stages[key];
  if (!st?.node) return toast("No settings found for this stage", { err: true });
  const n = st.node;
  const name = key === "inpaint" ? "🖌️ Inpaint" : STAGE_NAMES[key].join(" ");
  sheet({
    title: name, full: true,
    headExtra: st.switch ? toggle(!!G.get(st.switch, "on"), (v) => { G.set(st.switch, "on", v); changed(); if (secs.run) secs.run.replaceWith(secs.run = runSection()); updateSubs(); }) : null,
    body: (bd) => {
      if (n.type === "WaifuHiRes") {
        nodeFields(bd, n, [["upscale_model", { fmt: short }], ["scale_by", { slider: [1, 4] }], ["denoise", { slider: [0, 1] }], ["steps", { slider: [1, 60] }], ["cfg", { slider: [0, 15], hint: "0 = same as main" }], "mode", "tile_size", "seed_offset"]);
      } else if (n.type === "FaceDetailer") {
        if (st.detector) {
          const w = G.widget(st.detector, "model_name");
          if (w) bd.appendChild(widgetControl(st.detector, w, { label: "detector model", fmt: short }));
        }
        nodeFields(bd, n, [["denoise", { slider: [0, 1] }], ["guide_size", { slider: [256, 2048] }], ["max_size", { slider: [256, 2048] }], ["steps", { slider: [1, 60] }], ["cfg", { slider: [0, 15] }], "sampler_name", "scheduler", ["bbox_threshold", { slider: [0, 1] }], ["bbox_dilation", { slider: [-64, 128] }], ["bbox_crop_factor", { slider: [1, 10] }], ["feather", { slider: [0, 100] }], "seed"]);
      } else if (n.type === "MaskDetailerPipe") {
        const ip = r.inpaintPrompt;
        if (ip) {
          G.syncInpaint();
          const box = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
          const fill = () => {
            clear(box);
            box.append(h("div.hint", "Empty = main prompt."));
            for (const k of ["positive", "negative"]) box.appendChild(widgetControl(ip, G.widget(ip, k), { label: "inpaint " + k, multiline: true }));
            box.appendChild(h("button.btn.sm", { style: { alignSelf: "flex-start" }, onclick: () => { G.syncInpaint(true); changed(); fill(); toast("Copied main prompt"); } }, icon("refresh"), "Copy main prompt again"));
          };
          fill();
          bd.appendChild(box);
        }
        nodeFields(bd, n, [["denoise", { slider: [0, 1], hint: "0.6 default · 0.4 small fix" }], ["steps", { slider: [1, 60] }], ["cfg", { slider: [0, 15] }], "sampler_name", "scheduler", ["guide_size", { slider: [256, 2048] }], ["max_size", { slider: [256, 2048] }], ["feather", { slider: [0, 100] }], ["crop_factor", { slider: [1, 10] }], ["noise_mask_feather", { slider: [0, 100] }], "seed"]);
      } else {
        nodeFields(bd, n, G.widgets(n).filter((w) => !w.control).map((w) => w.name));
      }
    },
  });
}

// ------------------------------------------------------------ presets
function presetSection() {
  return section({
    id: "presets", title: "Presets", icon: "wand",
    extra: h("button.btn.sm.ghost.hdt", { onclick: (e) => { e.stopPropagation(); refill(); } }, icon("refresh"), "Refill"),
    body: (bd) => {
      const r = R(), G = g(), P = S.presets;
      const report = (res, what) => {
        if (!res) return toast(`${what} applied`);
        if (!res.ok) toast(`No ${G.family() === "anima" ? "Anima" : "Illustrious"} LoRA for this outfit, using tags only. It has: ${res.other.join(", ")}`, { err: true, ms: 7000 });
        else if (res.missing?.length) toast("LoRA file missing: " + res.missing.join(", "), { err: true });
        else toast(`${what} applied`);
      };
      const mk = (wname, kind, label, list, desc) => {
        const b = h("button.picker", h("span.grow", h("span.k", label), h("span.v", G.get(r.presets, wname) || "—")), icon("down"));
        b.onclick = async () => {
          const opts = (G.widget(r.presets, wname)?.options || []).map((name) => ({ value: name, label: name, desc: desc(list[name] || {}) }));
          const v = await pick({ title: label, value: G.get(r.presets, wname), options: opts, searchable: true });
          if (v === undefined) return;
          G.set(r.presets, wname, v);
          const res = G.applyPreset(kind, P);
          changed();
          build();
          report(res, `${label}: ${v}`);
        };
        return b;
      };
      // character card + outfit chips
      const fam = G.family();
      const cname = G.get(r.presets, "character");
      const ch = P.characters[cname] || {};
      const outfits = charOutfits(ch);
      const res = G.resolveCharacter(P);
      const pickChar = async () => {
        const v = await pickCharacter(cname, fam);
        if (v === undefined) return;
        G.set(r.presets, "character", v);
        G.set(r.presets, "outfit", "(default)");
        const out = G.applyPreset("character", P);
        changed(); build(); report(out, v);
      };
      const setOutfit = (o) => {
        G.set(r.presets, "outfit", o, true);
        const out = G.applyPreset("character", P);
        changed(); build(); report(out, o);
      };
      bd.appendChild(h("button.charcard", { onclick: pickChar, class: S.settings.blur ? "blurimg" : "" },
        charImage(ch) ? h("img.nsfw", { src: charImage(ch), onerror: (e) => e.target.remove() }) : h("div.noimg", icon("user")),
        h("div.grow", { style: { minWidth: 0 } },
          h("div.k", "Character" + (ch.franchise ? " · " + ch.franchise : "")),
          h("div.v.ell", cname || "—"),
          res?.name && h("div.o.ell", "outfit: " + res.name),
          h("div", famBadges(ch, fam))),
        icon("right")));
      bd.appendChild(h("div.row", { style: { gap: "6px" } },
        !ch.custom && cname && h("button.btn.sm.grow", { onclick: () => editCharacter(cname) }, icon("edit"), "Edit her"),
        !ch.custom && cname && h("button.btn.sm.grow", { onclick: () => civitaiFlow(cname) }, icon("plus"), "Add LoRA / outfits"),
        h("button.btn.sm.grow", { onclick: () => addCharacterSheet() }, icon("user"), "New character")));
      if (res && !res.ok) bd.appendChild(h("div.warnline", icon("info"), `No ${fam === "anima" ? "Anima" : "Illustrious"} LoRA for this outfit, so it uses tags only. Switch the model, or pick an outfit marked ${fam === "anima" ? "Anima" : "Illustrious"}.`));
      if (outfits.length > 1) {
        const cur = res?.name;
        const row = h("div.chips.scrollx");
        for (const o of outfits) {
          const fams = outfitFamilies(ch.outfits[o]);
          const usable = fams.includes(fam) || fams.includes("any");
          row.appendChild(h("button.chip" + (o === cur ? ".on" : ""), { style: { opacity: usable ? 1 : 0.45 }, onclick: () => o !== cur && setOutfit(o) }, o));
        }
        if (outfits.length > 6) row.appendChild(h("button.chip", { onclick: async () => { const o = await pickOutfit(ch, cur, fam); if (o && o !== cur) setOutfit(o); } }, icon("list"), `all ${outfits.length}`));
        bd.appendChild(row);
        setTimeout(() => row.querySelector(".chip.on")?.scrollIntoView({ inline: "center", block: "nearest" }), 50);
      }
      const wrong = mismatchedLoras();
      if (wrong.length) bd.appendChild(h("div.warnline", icon("info"), h("span.grow", `${wrong.length} LoRA${wrong.length > 1 ? "s" : ""} on for the wrong model type (they do nothing on ${fam === "anima" ? "Anima" : "Illustrious/SDXL"}): ${wrong.map((x) => short(x.lora)).join(", ")}`),
        h("button.btn.sm", { onclick: () => { for (const x of wrong) { x.on = false; G.loraToggled(x.lora, false, S.presets.triggers); } changed(); build(); toast(`Turned off ${wrong.length}`); } }, "Turn off")));
      const miss = missingFor({ model: G.get(r.presets, "model_preset"), style: G.get(r.presets, "art_style"), character: cname, outfit: res?.name || "", fam });
      if (miss.length) {
        const size = miss.reduce((a, i) => a + (i.sizeMB || 0), 0);
        bd.appendChild(h("div.warnline", icon("download"), h("span.grow", `${miss.length} file${miss.length > 1 ? "s" : ""} missing for this setup${size ? ` (${size} MB)` : ""}: ${miss.map((i) => i.name || i.key.split("/").pop()).join(", ")}`),
          h("button.btn.sm", { onclick: () => modelsSheet(miss.map((i) => i.key)) }, "Download")));
      }
      const extras = G.extraLoras();
      if (extras.length) bd.appendChild(h("div.warnline", icon("info"), h("span.grow", `${extras.length} LoRA${extras.length > 1 ? "s" : ""} on that no preset picked: ${extras.map((x) => short(x.lora)).join(", ")}`),
        h("button.btn.sm", { onclick: () => turnOffExtras() }, "Turn off")));
      bd.append(
        mk("art_style", "style", "Art style", P.styles, (s) => [(s.loras || []).map((l) => short(l[0])).join(", "), s.positive].filter(Boolean).join(" · ").slice(0, 120)),
        h("div.row", { style: { gap: "6px" } },
          G.get(r.presets, "art_style") && G.get(r.presets, "art_style") !== "None" && h("button.btn.sm.grow", { onclick: () => editStyle(G.get(r.presets, "art_style")) }, icon("edit"), "Edit style"),
          h("button.btn.sm.grow", { onclick: () => addStyleSheet() }, icon("plus"), "Add style")),
        mk("model_preset", "model", "Model", P.models, (m) => `${short(m.unet || m.checkpoint)} · ${m.steps} steps · cfg ${m.cfg} · ${m.sampler}`));
    },
  });
}

async function refill() {
  if (!(await confirmSheet("Refill everything from presets?", "This overwrites base, negative, character, sampler settings, model and the preset LoRAs. Your scene text is kept.", "Refill"))) return;
  S.presets = await api("/waifu/presets");
  for (const k of ["model", "style", "character"]) g().applyPreset(k, S.presets);
  changed();
  build();
  toast("Refilled from presets");
}

// ------------------------------------------------------------ prompt
function promptSection() {
  return section({
    id: "prompt", title: "Prompt", icon: "text",
    body: (bd) => {
      const r = R(), G = g();
      const boxes = [
        ["scene", "Scene", "pose, place, mood · presets never touch it · <lora:name:0.8> loads a LoRA", true],
        ["character", "Character", "filled by the character preset"],
        ["lora_triggers", "LoRA triggers", "added when you switch a LoRA on by hand"],
        ["base", "Base", "quality + style words (model & style preset)"],
        ["negative", "Negative", ""],
      ];
      for (const [name, label, hint, big] of boxes) {
        const w = G.widget(r.text, name);
        if (!w) continue;
        const k = "pbox:" + name;
        let open = store.get(k, name === "scene" || name === "character");
        const ta = tagArea(G.get(r.text, name) || "", (v) => { if (G.get(r.text, name) !== v) { G.set(r.text, name, v); changed({ quiet: true }); updateSubs(); prev.textContent = v; } }, { big, placeholder: hint });
        const prev = h("div.hint.ell", G.get(r.text, name) || "empty");
        const body = h("div", ta);
        const head = h("div.lbl", { style: { cursor: "pointer", marginBottom: "4px" } }, h("b", label), h("span.row", { style: { gap: "4px" } },
          h("button.ibtn.sm", { onclick: (e) => { e.stopPropagation(); copyText(ta.value); } }, icon("copy")),
          h("button.ibtn.sm", { onclick: (e) => { e.stopPropagation(); ta.value = ""; ta.dispatchEvent(new Event("input")); ta.focus(); } }, icon("x"))));
        const set = () => { body.classList.toggle("hidden", !open); prev.classList.toggle("hidden", open); };
        head.onclick = () => { open = !open; store.set(k, open); set(); if (open) setTimeout(() => ta.dispatchEvent(new Event("input")), 0); };
        prev.onclick = head.onclick;
        set();
        bd.appendChild(h("div", head, prev, body));
      }
    },
  });
}

// ------------------------------------------------------------ loras
function loraSection() {
  const s = section({
    id: "loras", title: "LoRAs", icon: "layers",
    extra: h("button.btn.sm.ghost.hdt", { onclick: (e) => { e.stopPropagation(); addLora(); } }, icon("plus"), "Add"),
    body: (bd) => drawLoras(bd),
  });
  return s;
}

async function addLora() {
  const file = await loraPicker();
  if (!file) return;
  const G = g();
  const ex = G.loraRows().find((x) => x.lora === file);
  if (ex) { ex.on = true; } else G.addLora(file, 1, true);
  G.loraToggled(file, true, S.presets.triggers);
  changed();
  refreshLoras();
  toast(`${short(file)} added`);
}

export function refreshLoras() {
  if (!secs.loras) return;
  drawLoras(secs.loras.bd);
  updateSubs();
}

// LoRAs switched on whose Civitai base model doesn't match the loaded model kind
function mismatchedLoras() {
  if (!S.loras) { loras().then(() => mismatchedLoras().length && build()).catch(() => {}); return []; }
  const fam = g().family();
  return g().loraRows().filter((x) => {
    if (!x.on) return false;
    const base = String(loraInfo(x.lora)?.base || "").toLowerCase();
    if (!base) return false;
    const anima = base.includes("anima");
    return fam === "anima" ? !anima : anima;
  });
}

export function turnOffExtras() {
  const G = g();
  const extras = G.extraLoras();
  for (const row of extras) { row.on = false; G.loraToggled(row.lora, false, S.presets.triggers); }
  changed();
  build();
  toast(`Turned off ${extras.length} LoRA${extras.length > 1 ? "s" : ""}`);
}

function drawLoras(bd) {
  const G = g();
  const rows = G.loraRows();
  const extra = new Set(G.extraLoras());
  clear(bd);
  if (extra.size) bd.appendChild(h("div.warnline", icon("info"), h("span.grow", `${extra.size} on that no preset picked`), h("button.btn.sm", { onclick: turnOffExtras }, "Turn off")));
  const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "7px" }, class: S.settings.blur ? "blurimg" : "" });
  bd.appendChild(list);
  loras().then(() => { for (const img of list.querySelectorAll("img[data-f]")) { const i = loraInfo(img.dataset.f); if (i?.image) img.src = i.image; } }).catch(() => {});
  for (const row of rows) {
    const info = S.loras ? loraInfo(row.lora) : null;
    const trig = S.presets.triggers[row.lora];
    const val = h("span.v", (+row.strength).toFixed(2));
    const range = h("input", { type: "range", min: -2, max: 5, step: 0.05, value: row.strength });
    range.oninput = () => { row.strength = +range.value; val.textContent = (+range.value).toFixed(2); };
    range.onchange = () => changed();
    const el = h("div.lora" + (row.on ? "" : ".off"),
      h("img.nsfw", { "data-f": row.lora, src: info?.image || null, loading: "lazy", onload: (e) => { e.target.style.visibility = ""; }, onerror: (e) => { e.target.style.visibility = "hidden"; } }),
      h("div.grow",
        h("div.nm.ell", info?.title || short(row.lora)),
        h("div.tr.ell", extra.has(row) ? "⚠ not from a preset" : trig ? "trigger: " + trig : short(row.lora)),
        h("div.str",
          h("button.ibtn.sm", { onclick: () => { row.strength = +(row.strength - 0.05).toFixed(2); range.value = row.strength; val.textContent = row.strength.toFixed(2); changed(); } }, icon("minus")),
          range,
          h("button.ibtn.sm", { onclick: () => { row.strength = +(+row.strength + 0.05).toFixed(2); range.value = row.strength; val.textContent = row.strength.toFixed(2); changed(); } }, icon("plus")),
          val)),
      h("div", { style: { display: "flex", flexDirection: "column", alignItems: "center", gap: "4px" } },
        toggle(!!row.on, (v) => { row.on = v; el.classList.toggle("off", !v); G.loraToggled(row.lora, v, S.presets.triggers); changed(); updateSubs(); }),
        h("button.ibtn.sm", { onclick: () => loraMenu(row) }, icon("more"))));
    longPress(el, () => loraMenu(row));
    list.appendChild(el);
  }
  if (!rows.length) list.appendChild(h("div.hint", "No LoRAs. Tap Add."));
  bd.appendChild(h("button.btn.block.ghost", { onclick: addLora }, icon("plus"), "Add LoRA"));
}

function loraMenu(row) {
  const G = g();
  const trig = S.presets.triggers[row.lora];
  const info = S.loras ? loraInfo(row.lora) : null;
  sheet({
    title: info?.title || short(row.lora),
    body: (bd, close) => {
      const opt = (ic, label, fn, desc) => bd.appendChild(h("button.opt", { onclick: () => { fn(); close(); } }, h("span.ck", icon(ic)), h("span.grow", h("div.t", label), desc && h("div.d", desc))));
      bd.appendChild(h("div.hint", row.lora));
      if (info?.words?.length) bd.appendChild(h("div", info.words.map((w) => h("span.trig", { onclick: () => copyText(w) }, w))));
      opt("up", "Move up", () => { G.moveLora(row, -1); changed(); refreshLoras(); });
      opt("down", "Move down", () => { G.moveLora(row, 1); changed(); refreshLoras(); });
      if (trig) opt("text", "Add trigger to scene", () => { const r = R(); G.set(r.text, "scene", ((G.get(r.text, "scene") || "").replace(/,?\s*$/, ", ") + trig).replace(/^, /, "")); changed(); build(); }, trig);
      opt("refresh", "Reset strength to 1", () => { row.strength = 1; changed(); refreshLoras(); });
      opt("trash", "Remove from list", () => { if (row.on) G.loraToggled(row.lora, false, S.presets.triggers); G.removeLora(row); changed(); refreshLoras(); });
    },
  });
}

// ------------------------------------------------------------ size
function sizeSection() {
  return section({
    id: "size", title: "Size", icon: "ratio", collapsed: true,
    body: (bd) => {
      const r = R(), G = g(), c = r.canvas;
      const w = G.widget(c, "size");
      const cur = G.get(c, "size");
      const chips = h("div.chips");
      for (const o of w.options) {
        chips.appendChild(h("button.chip" + (o === cur ? ".on" : ""), { onclick: () => { G.set(c, "size", o); changed(); secs.size.replaceWith(secs.size = sizeSection()); updateSubs(); } }, o.replace(" (use width/height)", "")));
      }
      bd.appendChild(chips);
      if (String(cur).startsWith("Custom")) {
        bd.appendChild(h("div.grid2", widgetControl(c, G.widget(c, "width"), { onChange: updateSubs }), widgetControl(c, G.widget(c, "height"), { onChange: updateSubs })));
      }
      bd.appendChild(widgetControl(c, G.widget(c, "batch"), { label: "batch (images per run)", slider: [1, 8], onChange: updateSubs }));
    },
  });
}

// ------------------------------------------------------------ sampler
function samplerSection() {
  return section({
    id: "sampler", title: "Sampler", icon: "sliders", collapsed: true,
    body: (bd) => {
      const s = R().settings;
      nodeFields(bd, s, [["steps", { slider: [1, 80], onChange: updateSubs }], ["cfg", { slider: [0, 15], onChange: updateSubs }]]);
      bd.appendChild(h("div.grid2", widgetControl(s, g().widget(s, "sampler_name"), { label: "sampler", onChange: updateSubs }), widgetControl(s, g().widget(s, "scheduler"), { onChange: updateSubs })));
    },
  });
}

// ------------------------------------------------------------ model
function modelSection() {
  return section({
    id: "model", title: "Model", icon: "cpu", collapsed: true,
    body: (bd) => {
      const r = R(), G = g();
      if (!r.loader) { nodeFields(bd, r.ckpt, [["ckpt_name", { fmt: short }]]); return; }
      const L = r.loader;
      const kw = G.widget(L, "kind");
      const anima = String(G.get(L, "kind")).startsWith("Anima");
      bd.appendChild(seg(kw.options.map((o) => [o, o.startsWith("Anima") ? "Anima" : "Checkpoint"]), G.get(L, "kind"), (v) => { G.set(L, "kind", v); const res = G.applyPreset("character", S.presets); changed(); build(); if (res?.loras?.length) toast("Character LoRAs switched to the " + (G.family() === "anima" ? "Anima" : "Illustrious") + " version"); }));
      if (anima) nodeFields(bd, L, [["unet", { label: "diffusion model", fmt: short, onChange: updateSubs }], ["text_encoder", { fmt: short }], ["vae", { fmt: short }], ["shift", { slider: [0, 10] }]], { more: false });
      else nodeFields(bd, L, [["checkpoint", { fmt: short, onChange: updateSubs }], "clip_skip"], { more: false });
      bd.appendChild(h("div.hint", "SDXL LoRAs do nothing on Anima models."));
    },
  });
}

// ------------------------------------------------------------ advanced
function advancedSection() {
  return section({
    id: "adv", title: "Output & advanced", icon: "more", collapsed: true,
    body: (bd) => {
      const r = R(), G = g();
      if (r.save) bd.appendChild(widgetControl(r.save, G.widget(r.save, "filename_prefix"), { label: "save to (filename prefix)" }));
      bd.appendChild(field("Live preview while sampling", seg([["default", "Server"], ["none", "Off"], ["latent2rgb", "Fast"], ["taesd", "TAESD"]], S.settings.preview, (v) => { S.settings.preview = v; saveSettings(); })));
      bd.appendChild(field("When you switch a character, style or model, its old LoRAs are",
        seg([["remove", "Removed from the list"], ["off", "Just switched off"]], S.presets.settings?.old_preset_loras || "remove", async (v) => {
          await api("/waifu/m/api/config", { json: { old_preset_loras: v } });
          S.presets = await api("/waifu/presets");
          toast(v === "remove" ? "Old preset LoRAs will be removed from the list" : "Old preset LoRAs will stay in the list, switched off");
        })));
      bd.appendChild(h("button.btn.block", { onclick: () => modelsSheet() }, icon("download"), "Models & downloads"));
      bd.appendChild(h("div.row",
        h("button.btn.grow", { onclick: async () => {
          const info = await api("/waifu/m/api/char/info");
          if (!info.edited.length) return toast("You haven't added or changed any characters yet.");
          exportPack(info.edited);
        } }, icon("share"), "Share my characters"),
        h("button.btn.grow", { onclick: importPack }, icon("upload"), "Import a pack")));
      bd.appendChild(h("button.btn.block", { onclick: allNodesSheet }, icon("grid"), "All nodes (every setting)"));
      bd.appendChild(h("div.row", h("button.btn.grow", { onclick: workflowMenu }, icon("file"), "Workflow…"), h("button.btn.grow", { onclick: async () => { S.presets = await api("/waifu/presets"); S.loras = null; await loras(); toast("Presets and LoRA list reloaded"); build(); } }, icon("refresh"), "Reload presets")));
    },
  });
}

// ------------------------------------------------------------ workflow menu
export function workflowMenu() {
  sheet({
    title: "Workflow",
    body: (bd, close) => {
      const opt = (ic, label, desc, fn) => bd.appendChild(h("button.opt", { onclick: async () => { close(); try { await fn(); } catch (e) { toast(e.message, { err: true }); } } }, h("span.ck", icon(ic)), h("span.grow", h("div.t", label), desc && h("div.d", desc))));
      bd.appendChild(h("div.hint", `Loaded: ${S.source}`));
      opt("refresh", "Load the PC's last run", null, async () => {
        const run = await lastPcRun();
        if (!run) return toast("No Waifu Studio run in the ComfyUI history", { err: true });
        await setWorkflow(run.wf, "PC last run");
        toast("Loaded the PC's last run");
      });
      opt("file", "Load saved Waifu Studio.json", null, async () => { await loadWorkflowFile("Waifu Studio.json"); toast("Loaded Waifu Studio.json"); });
      opt("folder", "Open another workflow file…", null, async () => {
        const files = await listWorkflows();
        const f = await pick({ title: "Workflow file", options: files.map((x) => ({ value: x, label: x.replace(/\.json$/, "") })), searchable: true });
        if (f) { await loadWorkflowFile(f); toast("Loaded " + f); }
      });
      opt("save", "Save as “Waifu Studio (phone).json”", null, async () => { await saveWorkflowFile("Waifu Studio (phone).json"); toast("Saved Waifu Studio (phone).json"); });
      opt("edit", "Save as…", null, async () => {
        const n = await promptSheet("Save workflow as", "Waifu Studio (phone 2)");
        if (n) { const name = n.endsWith(".json") ? n : n + ".json"; await saveWorkflowFile(name); toast("Saved " + name); }
      });
      opt("trash", "Overwrite Waifu Studio.json", "Replaces the desktop's main file", async () => {
        if (await confirmSheet("Overwrite Waifu Studio.json?", "If the desktop tab has unsaved changes, saving there later will overwrite this again, and reloading there will lose those unsaved changes. A copy of the current file is saved first as “Waifu Studio.before-phone-save.json”.", "Overwrite", true)) {
          try { const old = await api("/api/userdata/" + encodeURIComponent("workflows/Waifu Studio.json")); await api("/api/userdata/" + encodeURIComponent("workflows/Waifu Studio.before-phone-save.json") + "?overwrite=true", { method: "POST", body: JSON.stringify(old), headers: { "Content-Type": "application/json" } }); } catch {}
          await saveWorkflowFile("Waifu Studio.json");
          toast("Saved over Waifu Studio.json");
        }
      });
      opt("eye", (S.settings.blur ? "Unblur" : "Blur") + " LoRA previews", null, () => { S.settings.blur = !S.settings.blur; saveSettings(); build(); });
    },
  });
}

// long-press on the generate button
export function genMenu() {
  sheet({
    title: "Generate",
    body: (bd, close) => {
      const r = R();
      const seedFixed = r.seed && Number(r.seed.widgets_values[0]) >= 0;
      bd.appendChild(h("div.hint", seedFixed ? "Seed: fixed" : "Seed: random"));
      const grid = h("div.grid2");
      for (const n of [1, 2, 4, 8]) grid.appendChild(h("button.btn", { onclick: async () => { close(); await queue(n); toast(`Queued ${n}`); } }, `×${n}`));
      bd.appendChild(grid);
      if (seedFixed) bd.appendChild(h("button.btn.block", { onclick: async () => {
        close();
        const old = r.seed.widgets_values[0];
        r.seed.widgets_values[0] = -1;
        await queue(4);
        r.seed.widgets_values[0] = old;
        changed({ noUndo: true });
        toast("Queued 4 with new random seeds");
      } }, icon("dice"), "×4 with new random seeds"));
      bd.appendChild(h("button.btn.block", { onclick: async () => { close(); await queue(1, { front: true }); toast("Queued at the front"); } }, icon("up"), "Queue 1 at the front"));
    },
  });
}
