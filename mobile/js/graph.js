// Waifu Studio Mobile - the workflow model.
// Holds the same UI-format workflow the desktop uses, edits widget values by name,
// mirrors the desktop extension (presets, LoRA triggers, inpaint prompt sync) and
// converts the graph to an API prompt the way the ComfyUI frontend does.

export const PLL = "Power Lora Loader (rgthree)";
export const SEED = "Seed (rgthree)";
const VIRTUAL = new Set(["SetNode", "GetNode", "Reroute", "Note", "MarkdownNote", "PrimitiveNode", "Label (rgthree)", "Fast Groups Bypasser (rgthree)", "Fast Groups Muter (rgthree)"]);
const CONTROL = ["fixed", "increment", "decrement", "randomize"];
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
export const SEED_MAX = 1125899906842624;

export const randomSeed = () => Math.floor(Math.random() * SEED_MAX) + 1;
const clone = (o) => JSON.parse(JSON.stringify(o));
export const join = (...parts) => parts.map((p) => (p || "").trim()).filter(Boolean).join(" ");
export const tidy = (t) => (t || "").replace(/\s*\n\s*/g, " ").replace(/(\s*,\s*)+/g, ", ").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();

function parseSpec(name, spec) {
  if (!Array.isArray(spec)) return null;
  const [t, opts = {}] = spec;
  if (opts.forceInput) return null;
  if (Array.isArray(t)) return { name, type: "COMBO", options: t, opts };
  if (t === "COMBO") return { name, type: "COMBO", options: opts.options || [], opts };
  if (!WIDGET_TYPES.has(t)) return null;
  return { name, type: t, opts };
}

export class Graph {
  constructor(workflow, info) {
    this.wf = clone(workflow);
    this.info = info || {};
    this.index();
  }

  index() {
    this.nodes = this.wf.nodes || [];
    this.byId = new Map(this.nodes.map((n) => [n.id, n]));
    this.links = new Map();
    for (const l of this.wf.links || []) {
      if (Array.isArray(l)) this.links.set(l[0], { id: l[0], from: l[1], fromSlot: l[2], to: l[3], toSlot: l[4], type: l[5] });
      else this.links.set(l.id, { id: l.id, from: l.origin_id, fromSlot: l.origin_slot, to: l.target_id, toSlot: l.target_slot, type: l.type });
    }
    this.sets = new Map(this.nodes.filter((n) => n.type === "SetNode").map((n) => [n.widgets_values?.[0], n]));
    this._w = new Map();
    this._roles = null;
  }

  types() { return [...new Set(this.nodes.map((n) => n.type))]; }
  find(type) { return this.nodes.find((n) => n.type === type); }
  findAll(type) { return this.nodes.filter((n) => n.type === type); }
  title(n) { return n?.title || this.info[n?.type]?.display_name || n?.type || ""; }

  // ---------------------------------------------------------------- widgets
  widgets(node) {
    if (!node) return [];
    if (this._w.has(node.id)) return this._w.get(node.id);
    const info = this.info[node.type];
    const vals = Array.isArray(node.widgets_values) ? node.widgets_values : [];
    const out = [];
    if (info && node.type !== PLL) {
      let idx = 0;
      for (const group of ["required", "optional"]) {
        const specs = info.input?.[group] || {};
        const order = info.input_order?.[group] || Object.keys(specs);
        for (const name of order) {
          const s = parseSpec(name, specs[name]);
          if (!s) continue;
          out.push({ ...s, idx: idx++ });
          const isSeed = s.type === "INT" && (s.opts.control_after_generate || name === "seed" || name === "noise_seed");
          if (isSeed && typeof vals[idx] === "string" && CONTROL.includes(vals[idx])) {
            out.push({ name: name + "::control", control: true, of: name, type: "COMBO", options: CONTROL, opts: {}, idx: idx++ });
          }
        }
      }
    }
    this._w.set(node.id, out);
    return out;
  }

  widget(node, name) { return this.widgets(node).find((w) => w.name === name); }

  get(node, name) {
    const w = this.widget(node, name);
    return w ? node.widgets_values?.[w.idx] : undefined;
  }

  // force: allow values outside the combo list (e.g. LoadImage "x.png [output]")
  set(node, name, value, force = false) {
    const w = this.widget(node, name);
    if (!w || value === undefined || value === null) return false;
    if (!force && w.type === "COMBO" && w.options.length && !w.options.includes(value)) {
      console.warn(`[waifu] ${name}: '${value}' is not available`);
      return false;
    }
    if (!Array.isArray(node.widgets_values)) node.widgets_values = [];
    node.widgets_values[w.idx] = value;
    return true;
  }

  // ---------------------------------------------------------------- links
  inputLink(node, name) {
    const inp = (node?.inputs || []).find((i) => i.name === name);
    return inp && inp.link != null ? this.links.get(inp.link) : null;
  }

  // Follow a link back through Get/Set/Reroute (and bypassed nodes when bypass=true).
  resolve(link, bypass = true, depth = 0) {
    if (!link || depth > 40) return null;
    const n = this.byId.get(link.from);
    if (!n) return null;
    if (n.type === "GetNode") {
      const set = this.sets.get(n.widgets_values?.[0]);
      return set ? this.resolve(this.links.get(set.inputs?.[0]?.link), bypass, depth + 1) : null;
    }
    if (n.type === "Reroute" || n.type === "SetNode") return this.resolve(this.links.get(n.inputs?.[0]?.link), bypass, depth + 1);
    if (bypass && n.mode === 4) {
      const outType = n.outputs?.[link.fromSlot]?.type;
      const ins = (n.inputs || []).filter((i) => i.link != null);
      const same = n.inputs?.[link.fromSlot];
      const pick = (same && same.link != null && (same.type === outType || outType === "*") ? same : null)
        || ins.find((i) => i.type === outType) || null;
      return pick ? this.resolve(this.links.get(pick.link), bypass, depth + 1) : null;
    }
    if (bypass && n.mode === 2) return null;
    return { node: n, slot: link.fromSlot };
  }

  source(node, name) { return this.resolve(this.inputLink(node, name), false); }

  // ---------------------------------------------------------------- roles
  roles() {
    if (this._roles) return this._roles;
    const r = {
      seed: this.find(SEED), presets: this.find("WaifuPresets"), mode: this.find("WaifuMode"),
      text: this.find("WaifuText"), settings: this.find("WaifuSettings"),
      loader: this.find("WaifuLoader"), ckpt: this.find("CheckpointLoaderSimple"), pll: this.find(PLL),
      canvas: this.find("WaifuCanvas"), encode: this.find("WaifuEncode"),
      load: this.find("LoadImage"), scale: this.find("ImageScaleToTotalPixels"), save: this.find("SaveImage"),
      showText: this.find("ShowText|pysssss"), inpaintPrompt: this.find("WaifuInpaintPrompt"),
      switches: {}, stages: {},
    };
    // switch key from the SetNode it feeds ("sw_face" -> face)
    for (const sw of this.findAll("WaifuSwitch")) {
      let key = null;
      for (const lid of sw.outputs?.[0]?.links || []) {
        const l = this.links.get(lid);
        const to = l && this.byId.get(l.to);
        if (to?.type === "SetNode") key = String(to.widgets_values?.[0] || "").replace(/^sw_/, "");
        if (key) break;
      }
      if (!key) {
        const t = (sw.title || "").toLowerCase();
        key = t.includes("upscale 2x") ? "hires" : t.includes("face") ? "face"
          : t.includes("hand") ? "hands" : t.includes("mouth") ? "mouth" : t.includes("ultra") ? "ultra" : t;
      }
      r.switches[key] = sw;
    }
    // stages: every WaifuGate whose 'enabled' comes from a switch or the inpaint flag
    for (const gate of this.findAll("WaifuGate")) {
      const en = this.source(gate, "enabled");
      const on = this.resolve(this.inputLink(gate, "on"), true);
      if (!en) continue;
      let key = null;
      if (en.node.type === "WaifuSwitch") key = Object.entries(r.switches).find(([, n]) => n === en.node)?.[0];
      else if (en.node.type === "WaifuMode") key = en.slot === 1 ? "inpaint" : "source";
      if (!key || key === "source") continue;
      const st = { key, gate, node: on?.node || null, switch: r.switches[key] || null };
      if (st.node?.type === "FaceDetailer") st.detector = this.source(st.node, "bbox_detector")?.node || null;
      r.stages[key] = st;
    }
    this._roles = r;
    return r;
  }

  // ---------------------------------------------------------------- Power Lora Loader rows
  loraRows() {
    const pll = this.roles().pll;
    return (pll?.widgets_values || []).filter((v) => v && typeof v === "object" && "lora" in v);
  }

  addLora(name, strength = 1, on = true) {
    const pll = this.roles().pll;
    if (!pll) return null;
    const vals = pll.widgets_values || (pll.widgets_values = [{}, { type: "PowerLoraLoaderHeaderWidget" }, {}, ""]);
    let at = -1;
    vals.forEach((v, i) => { if (v && typeof v === "object" && ("lora" in v || v.type === "PowerLoraLoaderHeaderWidget")) at = i; });
    const row = { on, lora: name, strength, strengthTwo: null };
    vals.splice(at + 1, 0, row);
    return row;
  }

  removeLora(row) {
    const vals = this.roles().pll?.widgets_values;
    const i = vals ? vals.indexOf(row) : -1;
    if (i >= 0) vals.splice(i, 1);
  }

  moveLora(row, dir) {
    const vals = this.roles().pll?.widgets_values;
    const rows = this.loraRows();
    const i = rows.indexOf(row), j = i + dir;
    if (i < 0 || j < 0 || j >= rows.length) return;
    const a = vals.indexOf(rows[i]), b = vals.indexOf(rows[j]);
    [vals[a], vals[b]] = [vals[b], vals[a]];
  }

  // ---------------------------------------------------------------- presets (mirror of web/waifu_studio.js)
  // Switches on the new preset's LoRAs. LoRAs of the previous preset - and of any other preset of the same kind,
  // also ones left over in a loaded workflow - are removed from the list or switched off (setting).
  setPresetLoras(kind, loras, data) {
    const r = this.roles();
    if (!r.pll || !r.presets) return;
    const props = (r.presets.properties ||= {});
    const managed = (props.waifu_managed ||= {});
    const norm = (n) => String(n).replace(/\\/g, "/").toLowerCase();
    const previous = new Set([...(managed[kind] || []), ...presetLoras(kind, data)].map(norm));
    const wanted = new Map((loras || []).map(([name, strength]) => [name, strength]));
    const wantedN = new Set([...wanted.keys()].map(norm));
    const remove = (data?.settings?.old_preset_loras || "remove") === "remove";
    for (const row of [...this.loraRows()]) {
      if (!previous.has(norm(row.lora)) || wantedN.has(norm(row.lora))) continue;
      if (remove) this.removeLora(row); else row.on = false;
    }
    for (const [name, strength] of wanted) {
      const row = this.loraRows().find((x) => x.lora === name) || this.addLora(name, strength);
      Object.assign(row, { lora: name, on: true, strength });
    }
    managed[kind] = [...wanted.keys()];
  }

  family() {
    const L = this.roles().loader;
    return String(L ? this.get(L, "kind") : "").startsWith("Anima") ? "anima" : "illustrious";
  }

  outfit() {
    const p = this.roles().presets;
    return (p && this.get(p, "outfit")) || "(default)";
  }

  // character + outfit for the loaded model kind -> {name, tags, loras, ok}
  resolveCharacter(data, name = null, outfit = null, fam = null) {
    const p = this.roles().presets;
    const ch = data.characters[name ?? (p && this.get(p, "character"))];
    return resolveCharacter(ch, outfit ?? this.outfit(), fam ?? this.family());
  }

  // LoRAs switched on that no preset asked for (turned on by hand, or left over in the loaded workflow)
  extraLoras() {
    const managed = new Set(Object.values(this.roles().presets?.properties?.waifu_managed || {}).flat());
    return this.loraRows().filter((x) => x.on && !managed.has(x.lora));
  }

  applyPreset(kind, data) {
    const r = this.roles();
    const p = r.presets;
    if (!p) return null;
    const famBefore = this.family();
    const model = data.models[this.get(p, "model_preset")] || {};
    const style = data.styles[this.get(p, "art_style")] || {};
    const text = r.text;
    if (kind === "model" || kind === "style") {
      this.set(text, "base", join(model.positive, style.positive));
      this.set(text, "negative", join(model.negative, style.negative));
    }
    if (kind === "model") {
      if (r.ckpt) this.set(r.ckpt, "ckpt_name", model.checkpoint);
      const L = r.loader;
      if (L) {
        const kinds = this.widget(L, "kind")?.options || [];
        const anima = !!model.unet;
        this.set(L, "kind", kinds[anima ? 1 : 0]);
        if (anima) {
          this.set(L, "unet", model.unet); this.set(L, "text_encoder", model.text_encoder);
          this.set(L, "vae", model.vae); this.set(L, "shift", model.shift);
        } else {
          this.set(L, "checkpoint", model.checkpoint); this.set(L, "clip_skip", model.clip_skip);
        }
      }
      if (model.canvas) this.set(r.canvas, "size", model.canvas);
      const s = r.settings;
      this.set(s, "steps", model.steps); this.set(s, "cfg", model.cfg);
      this.set(s, "sampler_name", model.sampler); this.set(s, "scheduler", model.scheduler);
      for (const h of this.findAll("WaifuHiRes")) {
        if (this.get(h, "mode") !== "full image") continue;
        this.set(h, "denoise", model.hires_denoise);
        this.set(h, "scale_by", model.hires_scale ?? 2.0);
      }
      this.setPresetLoras("model", model.quality_loras, data);
    }
    if (kind === "style") this.setPresetLoras("style", style.loras, data);
    if (kind === "character" || (kind === "model" && this.family() !== famBefore)) {
      const res = this.resolveCharacter(data);
      if (res) {
        this.set(text, "character", res.tags);
        this.setPresetLoras("character", res.loras, data);
      }
      return res;
    }
    return null;
  }

  // A LoRA switched by hand adds/removes its first trigger in lora_triggers (desktop behaviour).
  loraToggled(lora, on, triggers) {
    const r = this.roles();
    if (!r.text) return;
    const t = triggers[lora];
    if (!t) return;
    const managed = Object.values(r.presets?.properties?.waifu_managed || {}).flat();
    let value = this.get(r.text, "lora_triggers") || "";
    if (!on && value.includes(t)) value = value.replace(t, "");
    if (on && !managed.includes(lora) && !value.includes(t)) value = join(value.replace(/,?\s*$/, ","), t);
    value = value.replace(/(\s*,\s*)+/g, ", ").replace(/^\s*,\s*|\s*,\s*$/g, "").trim();
    this.set(r.text, "lora_triggers", value);
  }

  // ---------------------------------------------------------------- inpaint prompt sync (desktop behaviour)
  mainPrompt() {
    const t = this.roles().text;
    if (!t) return null;
    const v = (n) => this.get(t, n) || "";
    return {
      positive: tidy([v("base"), v("character"), v("lora_triggers"), v("scene")].map(tidy).filter(Boolean).join(", ")),
      negative: tidy(v("negative")),
    };
  }

  syncInpaint(force = false) {
    const node = this.roles().inpaintPrompt;
    const main = this.mainPrompt();
    if (!node || !main) return;
    const copied = ((node.properties ||= {}).waifu_copied ||= {});
    for (const key of ["positive", "negative"]) {
      const cur = this.get(node, key) || "";
      const firstTime = copied[key] === undefined && !cur;
      const unedited = copied[key] !== undefined && cur === copied[key];
      if (!force && !firstTime && !unedited) continue;
      this.set(node, key, main[key]);
      copied[key] = main[key];
    }
  }

  // ---------------------------------------------------------------- API prompt
  // Returns {prompt, seed}. Applies control_after_generate afterwards like the desktop does.
  toPrompt() {
    const prompt = {};
    let seedUsed = null;
    for (const node of this.nodes) {
      if (node.mode === 2 || node.mode === 4 || VIRTUAL.has(node.type)) continue;
      const info = this.info[node.type];
      if (!info) continue;
      const inputs = {};
      if (node.type === PLL) {
        let i = 0;
        for (const row of this.loraRows()) {
          const v = { ...row };
          if (v.strengthTwo == null) delete v.strengthTwo;
          inputs[`lora_${++i}`] = v;
        }
      } else {
        for (const w of this.widgets(node)) {
          if (w.control) continue;
          const v = node.widgets_values?.[w.idx];
          inputs[w.name] = v !== undefined ? v : w.opts?.default ?? (w.type === "COMBO" ? w.options[0] : undefined);
        }
      }
      if (node.type === SEED) {
        let s = Number(inputs.seed);
        if (s === -1 || s === -2 || s === -3 || !Number.isFinite(s)) s = randomSeed();
        inputs.seed = s;
        seedUsed = s;
      }
      for (const [k, v] of Object.entries(inputs)) {
        if (typeof v === "string" && v.includes("%")) inputs[k] = this.expand(v);
      }
      for (const inp of node.inputs || []) {
        if (inp.link == null) continue;
        const src = this.resolve(this.links.get(inp.link), true);
        if (src && !VIRTUAL.has(src.node.type) && this.info[src.node.type]) inputs[inp.name] = [String(src.node.id), src.slot];
        else if (!inp.widget) delete inputs[inp.name];
      }
      prompt[String(node.id)] = { inputs, class_type: node.type, _meta: { title: this.title(node) } };
    }
    return { prompt, seed: seedUsed };
  }

  // %date:yyyy-MM-dd% and %Node title.widget% in text widgets, like the frontend
  expand(text) {
    const now = new Date();
    const pad = (n, l = 2) => String(n).padStart(l, "0");
    return text.replace(/%([^%]+)%/g, (m, body) => {
      if (body.startsWith("date:")) {
        return body.slice(5).replace(/yyyy|yy|MM|M|dd|d|hh|h|mm|m|ss|s/g, (t) => ({
          yyyy: now.getFullYear(), yy: pad(now.getFullYear() % 100), MM: pad(now.getMonth() + 1), M: now.getMonth() + 1,
          dd: pad(now.getDate()), d: now.getDate(), hh: pad(now.getHours()), h: now.getHours(),
          mm: pad(now.getMinutes()), m: now.getMinutes(), ss: pad(now.getSeconds()), s: now.getSeconds(),
        })[t]);
      }
      const dot = body.lastIndexOf(".");
      if (dot > 0) {
        const name = body.slice(0, dot), wname = body.slice(dot + 1);
        const n = this.nodes.find((x) => x.title === name || x.type === name || x.properties?.["Node name for S&R"] === name);
        const v = n && this.get(n, wname);
        if (v !== undefined) return String(v);
      }
      return m;
    });
  }

  // control_after_generate widgets (e.g. the inpaint seed set to randomize)
  afterQueue() {
    for (const node of this.nodes) {
      for (const w of this.widgets(node)) {
        if (!w.control) continue;
        const mode = node.widgets_values[w.idx];
        const tw = this.widget(node, w.of);
        const v = Number(node.widgets_values[tw.idx]) || 0;
        const max = Math.min(tw.opts?.max ?? SEED_MAX, SEED_MAX);
        if (mode === "randomize") node.widgets_values[tw.idx] = Math.floor(Math.random() * max);
        else if (mode === "increment") node.widgets_values[tw.idx] = v + 1;
        else if (mode === "decrement") node.widgets_values[tw.idx] = Math.max(0, v - 1);
      }
    }
  }

  serialize() { return clone(this.wf); }
}

// every LoRA file used by any preset of one kind ("model" / "style" / "character")
export function presetLoras(kind, data) {
  if (!data) return [];
  const out = [];
  const add = (list) => (list || []).forEach(([n]) => out.push(n));
  if (kind === "model") Object.values(data.models || {}).forEach((m) => add(m.quality_loras));
  if (kind === "style") Object.values(data.styles || {}).forEach((st) => add(st.loras));
  if (kind === "character") {
    for (const c of Object.values(data.characters || {})) {
      if (!c || typeof c !== "object") continue;
      add(c.loras);
      for (const o of Object.values(c.outfits || {})) for (const b of Object.values(o)) add(b.loras);
    }
  }
  return out;
}

export function resolveCharacter(ch, outfit, fam) {
  if (!ch || ch.custom) return null;
  if (!ch.outfits) return { name: "", tags: [ch.tags, ch.outfit].filter(Boolean).join("\n"), loras: ch.loras || [], ok: true };
  const names = Object.keys(ch.outfits);
  const name = ch.outfits[outfit] ? outfit : ch.outfits[ch.default_outfit] ? ch.default_outfit : names[0];
  const o = ch.outfits[name] || {};
  const b = o[fam] || o.any;
  if (b) return { name, tags: b.tags || "", loras: b.loras || [], ok: true, missing: b.missing };
  return { name, tags: ch.tags || "", loras: [], ok: false, other: Object.keys(o) };
}

// Which model kinds an outfit has a setup for.
export const outfitFamilies = (o) => ["anima", "illustrious", "any"].filter((f) => o?.[f]);

// Text summary of what a run does, used in the queue list.
export function describe(g) {
  const r = g.roles();
  const parts = [];
  if (r.presets) parts.push(g.get(r.presets, "character"), g.outfit() !== "(default)" ? g.outfit() : null);
  const mode = r.mode ? g.get(r.mode, "mode") : "Generate";
  if (mode && !mode.startsWith("Generate")) parts.push(mode.split(" ")[0]);
  const on = Object.entries(r.switches).filter(([, n]) => g.get(n, "on")).map(([k]) => k);
  parts.push(on.length ? on.join("+") : "preview");
  return parts.filter(Boolean).join(" · ");
}
