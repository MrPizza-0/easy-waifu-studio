// Model presets: Civitai checkpoint import, preset editor (create / edit / reset / delete).
import { h, icon, clear, api, toast, sheet, pick, confirmSheet, short, stepper } from "./util.js";
import { S, changed, refreshAfterDownload } from "./comfy.js";
import { civitaiFlow } from "./charedit.js";
import { pic } from "./chars.js";

const clone = (o) => JSON.parse(JSON.stringify(o));
const famLabel = { anima: "Anima", illustrious: "Illustrious" };

function bigButton(ic, title, onclick) {
  return h("button.bigopt", { onclick }, h("span.bi", icon(ic)), h("span.grow", h("div.t", title)), icon("right"));
}
const lab = (t, el) => h("div", h("div.lbl", t), el);
const two = (a, b) => h("div.row", { style: { gap: "8px", alignItems: "flex-end" } }, h("div.grow", { style: { minWidth: 0 } }, a), h("div.grow", { style: { minWidth: 0 } }, b));
function textInput(value, onInput, placeholder = "") {
  const i = h("input.inp", { value: value || "", placeholder });
  i.oninput = () => onInput(i.value);
  return i;
}
function textArea(value, onInput) {
  const t = h("textarea.ta", { rows: 3 });
  t.value = value || "";
  t.oninput = () => onInput(t.value);
  return t;
}

// widget option lists of the loaded workflow
function options(role, name) {
  const G = S.graph, n = G.roles()[role];
  return (n && G.widget(n, name)?.options) || [];
}
function listPicker(label, value, opts, onPick, fmt = (v) => v) {
  const b = h("button.picker", h("span.grow", h("span.k", label), h("span.v", value ? fmt(value) : "—")), icon("down"));
  b.onclick = async () => {
    const v = await pick({ title: label, value, options: opts.map((o) => ({ value: o, label: fmt(o) })), searchable: opts.length > 12 });
    if (v !== undefined) onPick(v);
  };
  return b;
}

// the shipped-style values of a model kind, used to start a new preset
function templateFor(fam) {
  const m = Object.values(S.presets.models).find((x) => !!x.unet === (fam === "anima")) || {};
  const t = clone(m);
  delete t.missing;
  t.quality_loras = [];
  return t;
}

async function afterModelChange(select) {
  await refreshAfterDownload();
  const G = S.graph, p = G.roles().presets;
  if (!p) return;
  const names = G.widget(p, "model_preset")?.options || [];
  const cur = G.get(p, "model_preset");
  const target = select || (names.includes(cur) ? null : names[0]);
  if (target) {
    G.set(p, "model_preset", target, true);
    G.applyPreset("model", S.presets);
    changed({ all: true });
  }
}

// ------------------------------------------------------------ entry point
export function addModelSheet() {
  sheet({
    title: "Add a model",
    body: (bd, close) => {
      bd.append(
        bigButton("search", "Find a model on Civitai", () => { close(); setTimeout(() => civitaiFlow(null, "model"), 250); }),
        bigButton("edit", "Create preset", () => { close(); setTimeout(() => editModel(null), 250); }));
    },
  });
}

// ------------------------------------------------------------ Civitai draft -> check before adding
export async function openModelDraft(id) {
  toast("Reading the Civitai page…");
  let d;
  try { d = await api("/waifu/m/api/civitai/model-draft?id=" + id); }
  catch (e) { return toast(e.message, { err: true, ms: 8000 }); }
  if (!d.versions.length) return toast("This model is not Illustrious, SDXL or Anima, so it can't be used here.", { err: true, ms: 8000 });
  let vi = 0;
  const s = sheet({
    title: "Check before adding", full: true,
    body: (bd) => {
      const draw = () => {
        const v = d.versions[vi], m = v.data, anima = v.family === "anima";
        const samplers = options("settings", "sampler_name"), schedulers = options("settings", "scheduler");
        clear(bd,
          (v.image || d.image) ? h("img.nsfw", { src: pic(v.image || d.image), style: { width: "100%", maxHeight: "200px", objectFit: "cover", borderRadius: "12px" } }) : null,
          d.versions.length > 1 ? h("div.chips.scrollx", d.versions.map((x, i) => h("button.chip" + (i === vi ? ".on" : ""), { onclick: () => { vi = i; draw(); } }, x.version))) : null,
          h("div", h("span.badge2.ok", famLabel[v.family]), h("span.badge2", `${v.file} · ${v.sizeMB} MB`)),
          lab("Name", textInput(v.name, (x) => (v.name = x))),
          two(lab("Steps", stepper({ value: m.steps, min: 1, max: 80, step: 1, onChange: (x) => (m.steps = x) })),
            lab("CFG", stepper({ value: m.cfg, min: 1, max: 15, step: 0.5, onChange: (x) => (m.cfg = x) }))),
          two(listPicker("Sampler", m.sampler, samplers, (x) => { m.sampler = x; draw(); }),
            listPicker("Scheduler", m.scheduler, schedulers, (x) => { m.scheduler = x; draw(); })),
          anima ? lab("Shift", stepper({ value: m.shift ?? 3, min: 0, max: 20, step: 0.5, onChange: (x) => (m.shift = x) }))
            : lab("Clip skip", stepper({ value: m.clip_skip ?? -2, min: -4, max: -1, step: 1, onChange: (x) => (m.clip_skip = x) })),
          lab("Quality words", textArea(m.positive, (x) => (m.positive = x))),
          lab("Negative prompt", textArea(m.negative, (x) => (m.negative = x))),
          d.skipped.length ? h("div.hint", "Skipped: " + d.skipped.join(", ")) : null,
          h("a.hint", { href: d.page, target: "_blank", rel: "noopener", style: { color: "var(--acc)" } }, "Civitai page ↗"),
          h("button.btn.pri.block", { style: { height: "52px", fontSize: "16px" }, onclick: () => save(true) }, icon("download"), `Add and download (${v.sizeMB} MB)`),
          h("button.btn.block.ghost", { onclick: () => save(false) }, "Add without downloading (I already have the file)"));
        bd.classList.toggle("blurimg", S.settings.blur);
      };
      draw();
    },
  });
  async function save(download) {
    const v = d.versions[vi], name = v.name.trim();
    if (!name) return toast("Name is missing.", { err: true });
    if (S.presets.models[name] && !(await confirmSheet(`"${name}" already exists`, "Replace it?", "Replace", true))) return;
    let r;
    try { r = await api("/waifu/m/api/model/save", { json: { name, data: v.data, downloads: v.download, download } }); }
    catch (e) { return toast(e.message, { err: true, ms: 8000 }); }
    s.close();
    await afterModelChange(name);
    if (download && r.download?.running) { toast("Model added. Downloading it…", { ms: 5000 }); waitForDownload(name); }
    else toast("Model added.");
  }
}

async function waitForDownload(name) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 3000));
    let st;
    try { st = await api("/waifu/m/api/models/download"); } catch { continue; }
    if (st.running) continue;
    const p = S.graph.roles().presets;
    await afterModelChange(p && S.graph.get(p, "model_preset") === name ? name : null);
    toast(st.failed.length ? `Download problem: ${st.failed.map((f) => f.error).join("; ")}` : "The model is ready.", { err: !!st.failed.length, ms: 6000 });
    return;
  }
}

// ------------------------------------------------------------ editor
export async function editModel(name) {
  const isNew = !name;
  let info = { shipped: [] };
  if (!isNew) { try { info = await api("/waifu/m/api/model/info"); } catch {} }
  const shipped = info.shipped.includes(name), edited = (info.edited || []).includes(name);
  const cur = S.presets.models[name];
  const m = isNew ? templateFor(S.graph.family()) : clone(cur || {});
  delete m.missing;
  if (isNew) { delete m.checkpoint; delete m.unet; }
  let fam = m.unet || (isNew && S.graph.family() === "anima") ? "anima" : "illustrious";
  let newName = name || "";
  const s = sheet({
    title: isNew ? "New model preset" : "Edit model", full: true,
    body: (bd) => {
      const draw = () => {
        const anima = fam === "anima";
        const samplers = options("settings", "sampler_name"), schedulers = options("settings", "scheduler");
        const setFam = (f) => {
          if (f === fam) return;
          const t = templateFor(f);
          if (isNew) {  // nothing to keep yet: start from that kind's defaults
            for (const k of Object.keys(m)) delete m[k];
            Object.assign(m, t);
            delete m.checkpoint; delete m.unet;
            fam = f; return draw();
          }
          if (f === "anima") { for (const k of ["text_encoder", "vae", "shift", "hires_scale", "canvas"]) m[k] ??= t[k]; delete m.checkpoint; delete m.clip_skip; }
          else { m.clip_skip ??= t.clip_skip ?? -2; delete m.unet; delete m.text_encoder; delete m.vae; delete m.shift; delete m.hires_scale; delete m.canvas; }
          fam = f; draw();
        };
        clear(bd,
          lab("Name", textInput(newName, (x) => (newName = x))),
          h("div.chips", h("button.chip" + (anima ? "" : ".on"), { onclick: () => setFam("illustrious") }, "Illustrious / SDXL"),
            h("button.chip" + (anima ? ".on" : ""), { onclick: () => setFam("anima") }, "Anima")),
          anima ? listPicker("Model file", m.unet, options("loader", "unet"), (x) => { m.unet = x; draw(); }, short)
            : listPicker("Model file", m.checkpoint, options("loader", "checkpoint"), (x) => { m.checkpoint = x; draw(); }, short),
          anima && two(listPicker("Text encoder", m.text_encoder, options("loader", "text_encoder"), (x) => { m.text_encoder = x; draw(); }, short),
            listPicker("VAE", m.vae, options("loader", "vae"), (x) => { m.vae = x; draw(); }, short)),
          two(lab("Steps", stepper({ value: m.steps ?? 30, min: 1, max: 80, step: 1, onChange: (x) => (m.steps = x) })),
            lab("CFG", stepper({ value: m.cfg ?? 6, min: 1, max: 15, step: 0.5, onChange: (x) => (m.cfg = x) }))),
          two(listPicker("Sampler", m.sampler, samplers, (x) => { m.sampler = x; draw(); }),
            listPicker("Scheduler", m.scheduler, schedulers, (x) => { m.scheduler = x; draw(); })),
          two(anima ? lab("Shift", stepper({ value: m.shift ?? 3, min: 0, max: 20, step: 0.5, onChange: (x) => (m.shift = x) }))
            : lab("Clip skip", stepper({ value: m.clip_skip ?? -2, min: -4, max: -1, step: 1, onChange: (x) => (m.clip_skip = x) })),
            lab("2x denoise", stepper({ value: m.hires_denoise ?? 0.3, min: 0, max: 1, step: 0.05, onChange: (x) => (m.hires_denoise = x) }))),
          lab("Quality words", textArea(m.positive, (x) => (m.positive = x))),
          lab("Negative prompt", textArea(m.negative, (x) => (m.negative = x))),
          h("button.btn.pri.block", { style: { height: "52px", fontSize: "16px" }, onclick: save }, icon("check"), "Save"),
          !isNew && h("div.row",
            shipped && edited && h("button.btn.grow", { onclick: reset }, icon("undo"), "Reset to original"),
            h("button.btn.grow.ghost.danger", { onclick: del }, icon("trash"), "Delete model")));
      };
      draw();
    },
  });
  async function save() {
    const n = newName.trim();
    if (!n) return toast("Name is missing.", { err: true });
    if (n !== name && S.presets.models[n] && !(await confirmSheet(`"${n}" already exists`, "Replace it?", "Replace", true))) return;
    try { await api("/waifu/m/api/model/save", { json: { name: n, data: m, old_name: name } }); }
    catch (e) { return toast(e.message, { err: true, ms: 8000 }); }
    s.close();
    await afterModelChange(n);
    toast("Model saved");
  }
  async function reset() {
    if (!(await confirmSheet(`Reset "${name}"?`, "Your changes to this model are removed.", "Reset", true))) return;
    await api("/waifu/m/api/model/reset", { json: { name } });
    s.close();
    await afterModelChange(name);
    toast("Model reset");
  }
  async function del() {
    if (!(await confirmSheet(`Delete "${name}"?`, "Removed from the model list. The model file stays on your PC.", "Delete", true))) return;
    try { await api("/waifu/m/api/model/delete", { json: { name } }); }
    catch (e) { return toast(e.message, { err: true, ms: 8000 }); }
    s.close();
    await afterModelChange(null);
    toast("Model deleted");
  }
}
