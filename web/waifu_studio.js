// Waifu Studio: presets fill the editable fields once; LoRAs switched on by hand add their trigger words.
import { app } from "../../scripts/app.js";

let DATA = null;
async function presets(force = false) {
  if (!DATA || force) DATA = await (await fetch("/waifu/presets")).json();
  return DATA;
}

const nodesOf = (type) => (app.graph?._nodes || []).filter((n) => n.comfyClass === type || n.type === type);
const first = (type) => nodesOf(type)[0];
const widget = (node, name) => node?.widgets?.find((w) => w.name === name);

function setWidget(node, name, value) {
  const w = widget(node, name);
  if (!w || value === undefined || value === null) return;
  const options = w.options?.values;
  if (Array.isArray(options) && !options.includes(value)) {
    console.warn(`[waifu] ${name}: '${value}' is not available`);
    return;
  }
  w.value = value;
  w.callback?.(value);
}

const join = (...parts) => parts.map((p) => (p || "").trim()).filter(Boolean).join(" ");
const loraRows = (pll) => (pll?.widgets || []).filter((w) => w.name?.startsWith("lora_"));

// Anima or Illustrious/SDXL, from the loader's "kind" field.
function family() {
  return String(widget(first("WaifuLoader"), "kind")?.value || "").startsWith("Anima") ? "anima" : "illustrious";
}

// A character's outfit for the loaded model kind -> {name, tags, loras, ok}. Old presets (tags/outfit/loras) still work.
function resolveCharacter(ch, outfit, fam) {
  if (!ch || ch.custom) return null;
  if (!ch.outfits) return { name: "", tags: [ch.tags, ch.outfit].filter(Boolean).join("\n"), loras: ch.loras || [], ok: true };
  const names = Object.keys(ch.outfits);
  const name = ch.outfits[outfit] ? outfit : ch.outfits[ch.default_outfit] ? ch.default_outfit : names[0];
  const o = ch.outfits[name] || {};
  const b = o[fam] || o.any;
  if (b) return { name, tags: b.tags || "", loras: b.loras || [], ok: true, missing: b.missing };
  return { name, tags: ch.tags || "", loras: [], ok: false, other: Object.keys(o) };
}

// The outfit combo only lists the picked character's outfits.
function updateOutfitList(node, ch) {
  const w = widget(node, "outfit");
  if (!w) return;
  const values = ["(default)", ...Object.keys(ch?.outfits || {})];
  w.options.values = values;
  if (!values.includes(w.value)) w.value = "(default)";
}

function toast(severity, summary, detail) {
  app.extensionManager?.toast?.add({ severity, summary, detail, life: 6000 });
}

// Switch the preset's LoRAs on (adding rows if needed) and the previous preset's ones off.
// every LoRA file used by any preset of one kind ("model" / "style" / "character")
function presetLoras(kind, d) {
  const out = [];
  const add = (list) => (list || []).forEach(([n]) => out.push(n));
  if (kind === "model") Object.values(d.models || {}).forEach((m) => add(m.quality_loras));
  if (kind === "style") Object.values(d.styles || {}).forEach((st) => add(st.loras));
  if (kind === "character") {
    for (const c of Object.values(d.characters || {})) {
      if (!c || typeof c !== "object") continue;
      add(c.loras);
      for (const o of Object.values(c.outfits || {})) for (const b of Object.values(o)) add(b.loras);
    }
  }
  return out;
}

// Switches on the new preset's LoRAs. LoRAs of any other preset of the same kind (also ones left over in a
// loaded workflow) are removed from the Power Lora Loader or switched off, as set in the phone UI.
function setPresetLoras(presetNode, kind, loras) {
  const pll = first("Power Lora Loader (rgthree)");
  if (!pll) return;
  const managed = (presetNode.properties.waifu_managed ||= {});
  const norm = (n) => String(n).replace(/\\/g, "/").toLowerCase();
  const previous = new Set([...(managed[kind] || []), ...presetLoras(kind, DATA || {})].map(norm));
  const wanted = new Map((loras || []).map(([name, strength]) => [name, strength]));
  const wantedN = new Set([...wanted.keys()].map(norm));
  const remove = (DATA?.settings?.old_preset_loras || "remove") === "remove";
  for (const row of [...loraRows(pll)]) {
    if (!previous.has(norm(row.value?.lora)) || wantedN.has(norm(row.value?.lora))) continue;
    if (remove) pll.widgets.splice(pll.widgets.indexOf(row), 1);
    else row.value.on = false;
  }
  for (const [name, strength] of wanted) {
    const row = loraRows(pll).find((r) => r.value?.lora === name) || pll.addNewLoraWidget(name);
    row.value = { ...row.value, lora: name, on: true, strength };
  }
  managed[kind] = [...wanted.keys()];
  pll.size[1] = pll.computeSize()[1];
  pll.setDirtyCanvas(true, true);
}

async function applyPreset(presetNode, kind) {
  const d = await presets();
  const model = d.models[widget(presetNode, "model_preset")?.value] || {};
  const style = d.styles[widget(presetNode, "art_style")?.value] || {};
  const text = first("WaifuText");

  if (kind === "model" || kind === "style") {
    setWidget(text, "base", join(model.positive, style.positive));
    setWidget(text, "negative", join(model.negative, style.negative));
  }
  const famBefore = family();
  if (kind === "model") {
    setWidget(first("CheckpointLoaderSimple"), "ckpt_name", model.checkpoint);
    setWidget(first("CLIPSetLastLayer"), "stop_at_clip_layer", model.clip_skip);
    const loader = first("WaifuLoader");
    if (loader) {
      const anima = !!model.unet;
      setWidget(loader, "kind", widget(loader, "kind")?.options?.values?.[anima ? 1 : 0]);
      if (anima) {
        setWidget(loader, "unet", model.unet);
        setWidget(loader, "text_encoder", model.text_encoder);
        setWidget(loader, "vae", model.vae);
        setWidget(loader, "shift", model.shift);
      } else {
        setWidget(loader, "checkpoint", model.checkpoint);
        setWidget(loader, "clip_skip", model.clip_skip);
      }
    }
    if (model.canvas) setWidget(first("WaifuCanvas"), "size", model.canvas);
    const settings = first("WaifuSettings");
    setWidget(settings, "steps", model.steps);
    setWidget(settings, "cfg", model.cfg);
    setWidget(settings, "sampler_name", model.sampler);
    setWidget(settings, "scheduler", model.scheduler);
    for (const hires of nodesOf("WaifuHiRes")) {
      if (widget(hires, "mode")?.value !== "full image") continue;
      setWidget(hires, "denoise", model.hires_denoise);
      setWidget(hires, "scale_by", model.hires_scale ?? 2.0);
    }
    setPresetLoras(presetNode, "model", model.quality_loras);
  }
  if (kind === "style") setPresetLoras(presetNode, "style", style.loras);
  if (kind === "character" || (kind === "model" && family() !== famBefore)) {
    const ch = d.characters[widget(presetNode, "character")?.value];
    updateOutfitList(presetNode, ch);
    const r = resolveCharacter(ch, widget(presetNode, "outfit")?.value, family());
    if (r) {
      setWidget(text, "character", r.tags);
      setPresetLoras(presetNode, "character", r.loras);
      if (!r.ok) toast("warn", `No ${family() === "anima" ? "Anima" : "Illustrious"} LoRA for this outfit`, `Using tags only. This outfit has: ${r.other.join(", ")}`);
      if (r.missing?.length) toast("warn", "LoRA file missing", r.missing.join(", "));
    }
  }
  app.graph.setDirtyCanvas(true, true);
}

// LoRAs switched on by hand get their trigger added to the lora_triggers box; switched off, removed again.
const seen = new WeakMap();
async function watchLoras() {
  const pll = first("Power Lora Loader (rgthree)");
  const text = first("WaifuText");
  if (!pll || !text) return;
  const on = new Set(loraRows(pll).filter((r) => r.value?.on && r.value?.lora).map((r) => r.value.lora));
  const before = seen.get(pll);
  seen.set(pll, on);
  if (!before) return; // first look after load: remember, don't touch the prompt

  const added = [...on].filter((l) => !before.has(l));
  const removed = [...before].filter((l) => !on.has(l));
  if (!added.length && !removed.length) return;

  const d = await presets();
  const managed = Object.values(first("WaifuPresets")?.properties?.waifu_managed || {}).flat();
  const box = widget(text, "lora_triggers");
  let value = box.value || "";
  for (const lora of removed) {
    const t = d.triggers[lora];
    if (t && value.includes(t)) value = value.replace(t, "");
  }
  for (const lora of added) {
    const t = d.triggers[lora];
    if (t && !managed.includes(lora) && !value.includes(t)) value = join(value.replace(/,?\s*$/, ","), t);
  }
  value = value.replace(/(\s*,\s*)+/g, ", ").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();
  if (value !== box.value) {
    box.value = value;
    box.callback?.(value);
  }
}

// Inpaint prompt boxes: start as a copy of the main prompt and follow it until you edit them.
// Edited boxes are left alone; an emptied box inherits the main prompt at run time.
const tidy = (t) => (t || "").replace(/\s*\n\s*/g, " ").replace(/(\s*,\s*)+/g, ", ").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();
function mainPrompt() {
  const text = first("WaifuText");
  if (!text) return null;
  const v = (n) => widget(text, n)?.value || "";
  return {
    positive: tidy([v("base"), v("character"), v("lora_triggers"), v("scene")].map(tidy).filter(Boolean).join(", ")),
    negative: tidy(v("negative")),
  };
}
function syncInpaint(node, force = false) {
  const main = mainPrompt();
  if (!main) return;
  const copied = (node.properties.waifu_copied ||= {});
  for (const key of ["positive", "negative"]) {
    const box = widget(node, key);
    if (!box) continue;
    const firstTime = copied[key] === undefined && !box.value;
    const unedited = copied[key] !== undefined && box.value === copied[key];
    if (!force && !firstTime && !unedited) continue;
    if (box.value !== main[key]) {
      box.value = main[key];
      box.callback?.(main[key]);
      node.setDirtyCanvas(true, true);
    }
    copied[key] = main[key];
  }
}

app.registerExtension({
  name: "waifu_studio.presets",
  async setup() {
    presets();
    setInterval(() => watchLoras().catch((e) => console.warn("[waifu]", e)), 700);
    setInterval(() => {
      try { for (const n of nodesOf("WaifuInpaintPrompt")) syncInpaint(n); } catch (e) { console.warn("[waifu]", e); }
    }, 700);
  },
  async refreshComboInNodes() {
    await presets(true);
  },
  nodeCreated(node) {
    if (node.comfyClass === "WaifuLoader") {  // switching Anima <-> Illustrious by hand swaps the character's LoRAs too
      const w = widget(node, "kind");
      const cb = w.callback;
      w.callback = function (...a) {
        const r = cb?.apply(this, a);
        const p = first("WaifuPresets");
        if (p) applyPreset(p, "character");
        return r;
      };
      return;
    }
    if (node.comfyClass === "WaifuInpaintPrompt") {
      const b = node.addWidget("button", "↻ Copy main prompt again", null, () => syncInpaint(node, true));
      b.serialize = false;
      return;
    }
    if (node.comfyClass !== "WaifuPresets") return;
    setTimeout(async () => { const d = await presets(); updateOutfitList(node, d.characters[widget(node, "character")?.value]); }, 300);
    for (const [name, kind] of [["model_preset", "model"], ["character", "character"], ["art_style", "style"], ["outfit", "character"]]) {
      const w = widget(node, name);
      if (!w) continue;  // workflows saved before the outfit field existed
      if (name === "character") {  // a new character starts at its default outfit
        const cb = w.callback;
        w.callback = function (...a) { const ow = widget(node, "outfit"); if (ow) ow.value = "(default)"; return cb?.apply(this, a); };
      }
      const original = w.callback;
      w.callback = function (value, ...rest) {
        const r = original?.apply(this, [value, ...rest]);
        applyPreset(node, kind);
        return r;
      };
    }
    const button = node.addWidget("button", "↻ Refill everything from presets", null, async () => {
      await presets(true);
      for (const kind of ["model", "style", "character"]) await applyPreset(node, kind);
    });
    button.serialize = false;
  },
});
