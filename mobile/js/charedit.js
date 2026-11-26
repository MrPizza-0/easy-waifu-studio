// Adding and editing characters: Civitai import, character editor, outfit editor, packs.
// Written for people who never touched JSON: big buttons, plain words, everything fixable.
import { h, icon, clear, api, toast, sheet, haptic, pick, confirmSheet, promptSheet, short, stepper } from "./util.js";
import { S, changed, queue, refreshAfterDownload, jobImages, relOf } from "./comfy.js";
import { tagArea } from "./widgets.js";
import { loraPicker, loraInfo } from "./loras.js";
import { pic } from "./chars.js";
import { openModelDraft } from "./modeledit.js";

const FAMS = [["anima", "Anima models"], ["illustrious", "Illustrious / SDXL"], ["any", "Any model (no LoRA)"]];
const famLabel = { anima: "Anima", illustrious: "Illustrious", any: "Any model" };
const clone = (o) => JSON.parse(JSON.stringify(o));

function bigButton(ic, title, desc, onclick) {
  return h("button.bigopt", { onclick }, h("span.bi", icon(ic)), h("span.grow", h("div.t", title), desc && h("div.d", desc)), icon("right"));
}

// after any change: reload presets and node lists, optionally switch the workflow to that character
export async function afterCharChange(select, outfit) {
  await refreshAfterDownload();
  const G = S.graph, p = G.roles().presets;
  if (select && p) {
    G.set(p, "character", select, true);
    G.set(p, "outfit", outfit || "(default)", true);
    G.applyPreset("character", S.presets);
    changed({ all: true });
  }
}

// ------------------------------------------------------------ entry point
export function addCharacterSheet(mergeInto = null) {
  sheet({
    title: mergeInto ? `Add a LoRA to ${mergeInto}` : "Add a character",
    body: (bd, close) => {
      bd.append(
        bigButton("search", "Find character on Civitai", null, () => { close(); setTimeout(() => civitaiFlow(mergeInto), 250); }),
        !mergeInto && bigButton("edit", "Make one without a LoRA", null, () => { close(); setTimeout(() => editCharacter(null), 250); }),
        !mergeInto && bigButton("upload", "Import a character pack (.json)", null, () => { close(); importPack(); }));
    },
  });
}

// ------------------------------------------------------------ Civitai search -> draft
export function civitaiFlow(mergeInto = null, mode = "character") {
  const open = (id) => (mode === "style" ? openStyleDraft(id) : mode === "model" ? openModelDraft(id) : openDraft(id, mergeInto));
  sheet({
    title: mode === "style" ? "Find a style LoRA on Civitai" : mode === "model" ? "Find a model on Civitai" : "Find a LoRA on Civitai", full: true,
    body: (bd, close) => {
      const inp = h("input.inp", { type: "search", placeholder: mode === "model" ? "Name or a Civitai link" : "Name (e.g. Luna Snow) or a Civitai link", enterkeyhint: "search", style: { fontSize: "16px" } });
      const go = h("button.btn.pri", { onclick: () => run() }, icon("search"), "Search");
      const out = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px" } });
      bd.append(h("div.row", h("div.grow", inp), go), out);
      inp.addEventListener("keydown", (e) => { if (e.key === "Enter") run(); });
      setTimeout(() => inp.focus(), 300);
      if (mergeInto) { inp.value = mergeInto.replace(/\s*\(.*\)\s*$/, ""); run(); }
      async function run() {
        const q = inp.value.trim();
        if (!q) return;
        clear(out, h("div.empty-state", h("span.spin")));
        let r;
        try { r = await api(`/waifu/m/api/civitai/${mode === "model" ? "model-search" : "search"}?q=` + encodeURIComponent(q)); }
        catch (e) { clear(out, h("div.warnline", icon("info"), e.message)); return; }
        if (r.model_id) { close(); return open(r.model_id); }
        if (!r.results.length) { clear(out, h("div.empty-state", "Nothing found. Try a shorter name, or paste the link.")); return; }
        clear(out, r.results.map((m) => h("button.lcard", { style: { textAlign: "left", opacity: m.families.length ? 1 : 0.45 }, onclick: () => {
          if (!m.families.length) return toast(mode === "model" ? "This model is not Illustrious, SDXL or Anima, so it can't be used here." : "This LoRA is not for Anima or Illustrious models, so it can't be used here.", { err: true });
          close(); open(m.id);
        } },
          m.image ? h("img.nsfw", { src: pic(m.image), loading: "lazy" }) : h("div.noimg"),
          h("div.grow", { style: { minWidth: 0 } },
            h("div.t", m.name),
            h("div", m.families.length ? m.families.map((f) => h("span.badge2.ok", famLabel[f])) : h("span.badge2.bad", "not usable here")),
            h("div.f", `${m.versions} version${m.versions > 1 ? "s" : ""} · ${(m.downloads || 0).toLocaleString()} downloads`)))));
        out.classList.toggle("blurimg", S.settings.blur);
      }
    },
  });
}

async function openDraft(id, mergeInto) {
  toast("Reading the Civitai page…");
  let d;
  try { d = await api("/waifu/m/api/civitai/draft?id=" + id); }
  catch (e) { return toast(e.message, { err: true, ms: 8000 }); }
  if (!Object.keys(d.outfits).length) return toast("That LoRA has no Anima or Illustrious version, so it can't be used here.", { err: true, ms: 8000 });
  reviewDraft(d, mergeInto);
}

// best existing character for a new import ('Luna Snow (Marvel Rivals)' matches 'Luna Snow')
function bestMatch(name) {
  const first = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, " ").trim().split(/\s+/).slice(0, 2).join(" ");
  const f = first(name);
  return Object.keys(S.presets.characters).find((k) => !k.startsWith("_") && first(k) === f) || null;
}

// ------------------------------------------------------------ review what the importer guessed
function reviewDraft(d, mergeInto) {
  const keep = new Set(Object.keys(d.outfits));
  let target = mergeInto || bestMatch(d.name);
  const s = sheet({
    title: "Check before adding", full: true,
    body: (bd) => {
      const draw = () => {
        const size = Object.values(d._downloads).reduce((a, x) => a + (x.sizeMB || 0), 0);
        clear(bd,
          h("div.row", { style: { alignItems: "flex-start" } },
            d.image ? h("img.nsfw", { src: pic(d.image), style: { width: "84px", height: "112px", objectFit: "cover", borderRadius: "10px", flex: "none" } }) : null,
            h("div.grow", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              h("div.lbl", "Name"), textInput(d.name, (v) => (d.name = v)),
              h("div.lbl", "Game / series"), textInput(d.franchise, (v) => (d.franchise = v)))),
          h("div.lbl", "Where should it go?"),
          h("button.picker", { onclick: async () => {
            const opts = [{ value: "", label: "➕ A new character", desc: d.name }, ...Object.keys(S.presets.characters).filter((k) => !k.startsWith("_") && !S.presets.characters[k].custom).map((k) => ({ value: k, label: k }))];
            const v = await pick({ title: "Add to", options: opts, value: target || "", searchable: true });
            if (v !== undefined) { target = v || null; draw(); }
          } }, h("span.grow", h("span.k", target ? "Add these outfits to" : "Make"), h("span.v", target || "a new character")), icon("down")),
          h("div.lbl", `Outfits found: ${Object.keys(d.outfits).length}`),
          ...Object.entries(d.outfits).map(([name, o]) => outfitRow(name, o)),
          d._skipped.length ? h("div.hint", "Skipped: " + d._skipped.join(", ")) : null,
          h("a.hint", { href: d._page, target: "_blank", rel: "noopener", style: { color: "var(--acc)" } }, "Civitai page ↗"),
          h("div", { style: { height: "8px" } }),
          h("button.btn.pri.block", { style: { height: "52px", fontSize: "16px" }, onclick: () => save(true) }, icon("download"), `Add and download${size ? ` (${size} MB)` : ""}`),
          h("button.btn.block.ghost", { onclick: () => save(false) }, "Add without downloading (I already have the file)"));
        bd.classList.toggle("blurimg", S.settings.blur);
      };
      const outfitRow = (name, o) => {
        const on = keep.has(name);
        const cb = h("input", { type: "checkbox", checked: on, style: { width: "22px", height: "22px", accentColor: "var(--acc)", flex: "none" }, onchange: (e) => { e.target.checked ? keep.add(name) : keep.delete(name); draw(); } });
        const first = Object.values(o)[0];
        return h("div.lora" + (on ? "" : ".off"), cb,
          h("div.grow", { style: { minWidth: 0 } },
            h("div.nm.ell", name),
            h("div", Object.keys(o).map((f) => h("span.badge2.ok", famLabel[f]))),
            h("div.tr", { style: { whiteSpace: "normal", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" } }, first.tags || "(no trigger words)")),
          h("button.btn.sm", { onclick: () => outfitEditor({ name, outfit: o }, (res) => {
            if (res.deleted) { delete d.outfits[name]; keep.delete(name); }
            else {
              if (res.name !== name) { delete d.outfits[name]; keep.delete(name); keep.add(res.name); }
              d.outfits[res.name] = res.outfit;
            }
            draw();
          }) }, icon("edit"), "Fix"));
      };
      draw();
    },
  });

  async function save(download) {
    const chosen = Object.fromEntries(Object.entries(d.outfits).filter(([n]) => keep.has(n)));
    if (!Object.keys(chosen).length) return toast("Tick at least one outfit.", { err: true });
    // the creator listed no trigger words: use the character's basic look so the outfit still works
    const look = (target && S.presets.characters[target]?.tags) || d.tags || "1girl";
    for (const o of Object.values(chosen)) for (const b of Object.values(o)) if (!b.tags?.trim()) b.tags = look;
    let name = d.name.trim(), data;
    if (target) {
      name = target;
      data = clone(S.presets.characters[target]);
      if (!data.outfits) data = legacyToOutfits(data);
      for (const [on, o] of Object.entries(chosen)) data.outfits[on] = Object.assign(data.outfits[on] || {}, o);
      if (!data.image && d.image) data.image = d.image;
      if (!data.franchise && d.franchise) data.franchise = d.franchise;
    } else {
      if (!name) return toast("Name is missing.", { err: true });
      if (S.presets.characters[name] && !(await confirmSheet("Name already used", `There already is a character called "${name}". Replace it?`, "Replace", true))) return;
      data = { franchise: d.franchise, tags: d.tags, image: d.image, default_outfit: Object.keys(chosen)[0], outfits: chosen };
    }
    data._downloads = d._downloads;
    const r = await api("/waifu/m/api/char/save", { json: { name, data, download } });
    s.close();
    haptic(20);
    await afterCharChange(name, Object.keys(chosen)[0]);
    if (download && r.download?.running) {
      toast(`${name} added. Downloading the LoRA… you'll get a message when it's ready.`, { ms: 6000 });
      waitForDownloads(name);
    } else toast(`${name} added.`, { ms: 4000 });
  }
}

// when the LoRA downloads finish: reload the presets and re-apply the character, so its LoRA is really used
async function waitForDownloads(name) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let st;
    try { st = await api("/waifu/m/api/models/download"); } catch { continue; }
    if (st.running) continue;
    const G = S.graph, p = G.roles().presets;
    const outfit = p ? G.get(p, "outfit") : null;
    await afterCharChange(p && G.get(p, "character") === name ? name : null, outfit);
    if (st.failed.length) toast(`Download problem: ${st.failed.map((f) => f.error).join("; ")}`, { err: true, ms: 9000 });
    else toast(`${name}'s LoRA is ready. Generate!`, { ms: 5000 });
    return;
  }
}

// old-style preset (tags/outfit/loras) -> one outfit called "Default"
function legacyToOutfits(c) {
  return { franchise: c.franchise || "", tags: c.tags || "", image: c.image || "", default_outfit: "Default",
    outfits: { Default: { any: { loras: c.loras || [], tags: [c.tags, c.outfit].filter(Boolean).join(", ") } } } };
}

function textInput(value, onInput, placeholder = "") {
  const i = h("input.inp", { value: value || "", placeholder });
  i.oninput = () => onInput(i.value);
  return i;
}

// ------------------------------------------------------------ character editor
export async function editCharacter(name) {
  const isNew = !name;
  let c = isNew ? { franchise: "", tags: "1girl, ", image: "", default_outfit: "Default", outfits: { Default: { any: { loras: [], tags: "1girl, " } } } }
    : clone(S.presets.characters[name]);
  if (!c) return toast("Character not found", { err: true });
  if (c.custom) return toast("This entry can't be edited.");
  if (!c.outfits) c = legacyToOutfits(c);
  let info = { shipped: [], edited: [] };
  try { info = await api("/waifu/m/api/char/info"); } catch {}
  let newName = name || "", dirty = isNew;
  const touch = () => { dirty = true; };
  const s = sheet({
    title: isNew ? "New character" : "Edit character", full: true,
    onClose: () => {
      if (!dirty) return;
      setTimeout(async () => {
        if (await confirmSheet("Save your changes?", `You changed ${newName || "this character"} but didn't save.`, "Save")) doSave(false);
      }, 300);
    },
    body: (bd) => {
      const draw = () => {
        const lastImg = lastResultImage();
        clear(bd,
          h("div.row", { style: { alignItems: "flex-start" } },
            c.image ? h("img.nsfw", { src: pic(c.image), style: { width: "90px", height: "120px", objectFit: "cover", borderRadius: "12px", flex: "none" } }) : h("div.noimg", { style: { width: "90px", height: "120px", borderRadius: "12px", flex: "none", background: "var(--s3)", display: "grid", placeItems: "center" } }, icon("user")),
            h("div.grow", { style: { display: "flex", flexDirection: "column", gap: "6px" } },
              h("div.lbl", "Name"), textInput(newName, (v) => { newName = v; touch(); }, "e.g. Luna Snow (Marvel Rivals)"),
              h("div.lbl", "Game / series"), textInput(c.franchise, (v) => { c.franchise = v; touch(); }, "e.g. Marvel Rivals"))),
          h("div.row.wrap",
            lastImg && h("button.btn.sm", { onclick: () => { c.image = lastImg; touch(); draw(); } }, icon("image"), "Use last result as picture"),
            h("button.btn.sm.ghost", { onclick: async () => { const u = await promptSheet("Paste a picture link", "", "https://…"); if (u) { c.image = u.trim(); touch(); draw(); } } }, "Picture link…"),
            c.image && h("button.btn.sm.ghost", { onclick: () => { c.image = ""; touch(); draw(); } }, "No picture")),
          h("div.lbl", "Appearance"),
          tagArea(c.tags || "", (v) => { c.tags = v; touch(); }, { placeholder: "1girl, her name tag, hair color, eye color…" }),
          h("div.lbl", { style: { marginTop: "6px" } }, `Outfits (${Object.keys(c.outfits).length})`),
          ...Object.entries(c.outfits).map(([on, o]) => h("div.lora",
            h("button.ibtn.sm", { title: "Picked first", style: { color: c.default_outfit === on ? "var(--warn)" : "var(--dim)" }, onclick: () => { c.default_outfit = on; touch(); draw(); } }, icon("star")),
            h("div.grow", { style: { minWidth: 0 }, onclick: () => openOutfit(on) },
              h("div.nm.ell", on),
              h("div", Object.keys(o).map((f) => h("span.badge2.ok", famLabel[f] + (o[f].loras?.length ? " + LoRA" : ""))))),
            h("button.btn.sm", { onclick: () => openOutfit(on) }, icon("edit"), "Edit"))),
          h("div.row.wrap",
            h("button.btn", { onclick: () => {
              let n = "New outfit", i = 2;
              while (c.outfits[n]) n = `New outfit ${i++}`;
              c.outfits[n] = { any: { loras: [], tags: c.tags || "" } };
              touch(); openOutfit(n);
            } }, icon("plus"), "New outfit"),
            !isNew && h("button.btn", { onclick: async () => { if (dirty) await doSave(false); s.close(); setTimeout(() => civitaiFlow(newName || name), 250); } }, icon("search"), "Add a LoRA from Civitai")),
          h("div", { style: { height: "6px" } }),
          h("button.btn.pri.block", { style: { height: "52px", fontSize: "16px" }, onclick: () => doSave(true) }, icon("check"), "Save"),
          h("button.btn.block", { onclick: async () => { await doSave(true, true); } }, icon("zap"), "Save and make a test picture"),
          !isNew && h("div.row.wrap", { style: { marginTop: "10px" } },
            h("button.btn.sm.ghost", { onclick: () => exportPack([name]) }, icon("share"), "Share (pack file)"),
            info.shipped.includes(name) && info.edited.includes(name) && h("button.btn.sm.ghost", { onclick: async () => {
              if (!(await confirmSheet("Reset to the original?", `Your changes to ${name} are thrown away and the shipped version comes back.`, "Reset", true))) return;
              await api("/waifu/m/api/char/reset", { json: { name } }); s.close(); await afterCharChange(); toast(`${name} reset`);
            } }, icon("undo"), "Reset to original"),
            h("button.btn.sm.ghost.danger", { onclick: async () => {
              if (!(await confirmSheet(`Delete ${name}?`, "Removed from the character list. LoRA files stay on your PC.", "Delete", true))) return;
              await api("/waifu/m/api/char/delete", { json: { name } }); s.close(); await afterCharChange(); toast(`${name} deleted`);
            } }, icon("trash"), "Delete")));
        bd.classList.toggle("blurimg", S.settings.blur);
      };
      const openOutfit = (on) => outfitEditor({ name: on, outfit: c.outfits[on], baseTags: c.tags }, (res) => {
        touch();
        if (res.deleted) {
          delete c.outfits[on];
          if (c.default_outfit === on) c.default_outfit = Object.keys(c.outfits)[0] || "";
        } else {
          if (res.name !== on) { delete c.outfits[on]; if (c.default_outfit === on) c.default_outfit = res.name; }
          c.outfits[res.name] = res.outfit;
        }
        draw();
      });
      draw();
    },
  });

  async function doSave(close, test = false) {
    const n = newName.trim();
    if (!n) return toast("Name is missing.", { err: true });
    if (!Object.keys(c.outfits).length) return toast("Add at least one outfit.", { err: true });
    if (n !== name && S.presets.characters[n] && !(await confirmSheet("Name already used", `There already is a character called "${n}". Replace it?`, "Replace", true))) return;
    if (!c.outfits[c.default_outfit]) c.default_outfit = Object.keys(c.outfits)[0];
    await api("/waifu/m/api/char/save", { json: { name: n, old_name: name, data: c } });
    dirty = false;
    if (close) s.close();
    await afterCharChange(n, c.default_outfit);
    toast(`${n} saved`);
    if (test) { try { await queue(1); toast("Making a test picture… it shows at the top of Create."); } catch {} }
  }
}

// a character without a picture gets the first image you make of it
export async function autoPicture(job) {
  const G = S.graph, p = G.roles().presets;
  if (!p) return;
  const name = G.get(p, "character");
  const c = S.presets.characters[name];
  if (!c || c.custom || c.image || name === "None (empty box)") return;
  const im = jobImages(job).find((x) => x.type === "output");
  if (!im) return;
  const data = clone(c.outfits ? c : legacyToOutfits(c));
  data.image = `/waifu/m/api/thumb?a=1&s=450&f=${encodeURIComponent(relOf(im) + " [output]")}`;
  try {
    await api("/waifu/m/api/char/save", { json: { name, data } });
    S.presets.characters[name] = data;
  } catch {}
}

function lastResultImage() {
  for (let i = S.order.length - 1; i >= 0; i--) {
    const j = S.jobs.get(S.order[i]);
    const im = j && jobImages(j).find((x) => x.type === "output");
    if (im) return `/waifu/m/api/thumb?a=1&s=450&f=${encodeURIComponent(relOf(im) + " [output]")}`;
  }
  return null;
}

// ------------------------------------------------------------ outfit editor
// ctx: {name, outfit, baseTags}; done({name, outfit} | {deleted: true})
export function outfitEditor(ctx, done) {
  const o = clone(ctx.outfit || {});
  let name = ctx.name;
  let tab = FAMS.find(([f]) => o[f])?.[0] || "any";
  let finished = false;
  const s = sheet({
    title: "Edit outfit", full: true,
    onClose: () => { if (!finished) done({ name: name.trim() || ctx.name, outfit: o }); },
    body: (bd) => {
      const draw = () => {
        const b = o[tab];
        clear(bd,
          h("div.lbl", "Outfit name"), textInput(name, (v) => (name = v), "e.g. Swimsuit"),
          h("div.lbl", "Which models is this for?"),
          h("div.seg", FAMS.map(([f, label]) => h("button" + (f === tab ? ".on" : ""), { onclick: () => { tab = f; draw(); } }, label.split(" ")[0], o[f] ? " ✓" : ""))),
          b ? blockEditor(b) : h("div.empty-state", { style: { padding: "20px" } },
            h("div", `Nothing set for ${famLabel[tab]} yet.`),
            h("button.btn.pri", { style: { marginTop: "10px" }, onclick: () => { o[tab] = { loras: [], tags: anyTags() }; draw(); } }, icon("plus"), `Set up for ${famLabel[tab]}`)),
          h("div", { style: { height: "10px" } }),
          h("button.btn.pri.block", { style: { height: "50px" }, onclick: () => s.close() }, icon("check"), "Done"),
          h("button.btn.block.ghost.danger", { onclick: async () => {
            if (!(await confirmSheet("Delete this outfit?", `"${name}" is removed from this character.`, "Delete", true))) return;
            finished = true; s.close(); done({ deleted: true });
          } }, icon("trash"), "Delete outfit"));
      };
      const anyTags = () => o.any?.tags || ctx.baseTags || "";
      const blockEditor = (b) => {
        const lora = b.loras?.[0];
        const groups = (b.groups && b.groups.length ? b.groups : (lora && S.loras ? loraInfo(lora[0])?.words : null)) || [];
        const box = h("div", { style: { display: "flex", flexDirection: "column", gap: "10px" } });
        const ta = tagArea(b.tags || "", (v) => { b.tags = v; drawChips(); }, { big: true, placeholder: "trigger words, hair, eyes, clothes…" });
        const chips = h("div.chips");
        const drawChips = () => clear(chips, groups.map((g) => {
          const on = (b.tags || "").replace(/\s+/g, " ").includes(g.trim().replace(/\s+/g, " "));
          return h("button.chip" + (on ? ".on" : ""), { style: { whiteSpace: "normal", textAlign: "left", maxWidth: "100%" }, onclick: () => {
            const t = g.trim();
            b.tags = on ? b.tags.replace(t, "").replace(/(\s*,\s*)+/g, ", ").replace(/^\s*,\s*|\s*,\s*$/g, "")
              : [b.tags, t].map((x) => (x || "").trim().replace(/,$/, "")).filter(Boolean).join(", ");
            ta.value = b.tags; ta.dispatchEvent(new Event("input")); haptic(5); drawChips();
          } }, (on ? "✓ " : "+ ") + (t => t.length > 90 ? t.slice(0, 90) + "…" : t)(g.trim()));
        }));
        drawChips();
        box.append(
          tab !== "any" && h("div.lbl", "LoRA file"),
          tab !== "any" && h("div.row",
            h("button.picker.grow", { onclick: async () => {
              const f = await loraPicker();
              if (f) { b.loras = [[f, lora?.[1] ?? 1]]; b.groups = []; draw(); }
            } }, h("span.grow", h("span.k", "LoRA"), h("span.v", lora ? short(lora[0]) : "none — tap to pick")), icon("down")),
            lora && h("button.btn", { onclick: () => { b.loras = []; draw(); } }, "Remove")),
          tab !== "any" && lora && h("div", h("div.lbl", "Strength"), stepper({ value: lora[1] ?? 1, min: 0, max: 2, step: 0.05, onChange: (v) => { b.loras[0][1] = v; } })),
          h("div.lbl", "Words for this outfit"),
          ta,
          groups.length ? h("div.lbl", "Trigger words") : null,
          groups.length ? chips : null,
          h("button.btn.sm.ghost.danger", { style: { alignSelf: "flex-start" }, onclick: () => { delete o[tab]; draw(); } }, icon("x"), `Remove the ${famLabel[tab]} setup`));
        return box;
      };
      draw();
    },
  });
}

// ------------------------------------------------------------ packs
export async function exportPack(names) {
  const pack = await api("/waifu/m/api/char/export", { json: { names } });
  const blob = new Blob([JSON.stringify(pack, null, 1)], { type: "application/json" });
  const a = h("a", { href: URL.createObjectURL(blob), download: `waifu-pack-${names.length === 1 ? names[0].replace(/[^\w]+/g, "-") : names.length + "-characters"}.json` });
  document.body.appendChild(a); a.click(); a.remove();
  toast("Pack file saved. Send it to anyone with Waifu Studio. It holds links only, no LoRA files.", { ms: 6000 });
}

export function importPack() {
  const inp = h("input", { type: "file", accept: ".json,application/json", style: { display: "none" } });
  inp.onchange = async () => {
    const f = inp.files[0];
    if (!f) return;
    let pack;
    try { pack = JSON.parse(await f.text()); } catch { return toast("That file is not a character pack.", { err: true }); }
    const names = Object.keys(pack.characters || {});
    if (!names.length) return toast("That file has no characters in it.", { err: true });
    const clash = names.filter((n) => S.presets.characters[n]);
    if (!(await confirmSheet(`Add ${names.length} character${names.length > 1 ? "s" : ""}?`,
      names.slice(0, 12).join(", ") + (names.length > 12 ? "…" : "") + (clash.length ? `\n\nThese will be replaced: ${clash.join(", ")}` : ""), "Add"))) return;
    try {
      await api("/waifu/m/api/char/import", { json: pack });
      await afterCharChange();
      toast(`${names.length} added. Missing LoRAs can be downloaded under Output & advanced → Models & downloads.`, { ms: 7000 });
    } catch (e) { toast(e.message, { err: true }); }
    inp.remove();
  };
  document.body.appendChild(inp);
  inp.click();
}

// ------------------------------------------------------------ styles
export function addStyleSheet() {
  sheet({
    title: "Add a style",
    body: (bd, close) => {
      bd.append(
        bigButton("search", "Find a style on Civitai", null, () => { close(); setTimeout(() => civitaiFlow(null, "style"), 250); }),
        bigButton("edit", "Create preset", null, () => { close(); setTimeout(() => editStyle(null), 250); }));
    },
  });
}

async function afterStyleChange(select) {
  await refreshAfterDownload();
  const G = S.graph, p = G.roles().presets;
  if (select && p) {
    G.set(p, "art_style", select, true);
    G.applyPreset("style", S.presets);
    changed({ all: true });
  }
}

async function openStyleDraft(id) {
  toast("Reading the Civitai page…");
  let d;
  try { d = await api("/waifu/m/api/civitai/style-draft?id=" + id); }
  catch (e) { return toast(e.message, { err: true, ms: 8000 }); }
  if (!d.styles.length) return toast("That LoRA has no Anima or Illustrious version, so it can't be used here.", { err: true, ms: 8000 });
  const keep = new Set(d.styles.map((x, i) => i));
  const s = sheet({
    title: "Check before adding", full: true,
    body: (bd) => {
      const draw = () => {
        const size = d.styles.filter((x, i) => keep.has(i)).reduce((a, x) => a + (x.sizeMB || 0), 0);
        clear(bd,
          d.image ? h("img.nsfw", { src: pic(d.image), style: { width: "100%", maxHeight: "200px", objectFit: "cover", borderRadius: "12px" } }) : null,
          ...d.styles.map((st, i) => h("div.lora" + (keep.has(i) ? "" : ".off"), { style: { flexDirection: "column", alignItems: "stretch", gap: "6px" } },
            h("div.row",
              h("input", { type: "checkbox", checked: keep.has(i), style: { width: "22px", height: "22px", accentColor: "var(--acc)" }, onchange: (e) => { e.target.checked ? keep.add(i) : keep.delete(i); draw(); } }),
              h("span.badge2.ok", st.family === "anima" ? "Anima" : "Illustrious"),
              h("span.grow")),
            h("div.lbl", "Name"), textInput(st.name, (v) => (st.name = v)),
            h("div.lbl", "Style words"), textInput(st.positive, (v) => (st.positive = v), "trigger words, if any"),
            st.groups.length > 1 ? h("div.chips", st.groups.map((gw) => h("button.chip", { onclick: () => { st.positive = [st.positive, gw].map((x) => (x || "").trim().replace(/,$/, "")).filter(Boolean).join(", ") + ","; draw(); } }, "+ " + gw.slice(0, 60)))) : null,
            h("div.lbl", "Strength"),
            stepper({ value: st.loras[0][1], min: 0, max: 2, step: 0.05, onChange: (v) => { st.loras[0][1] = v; } }))),
          d._skipped.length ? h("div.hint", "Skipped: " + d._skipped.join(", ")) : null,
          h("a.hint", { href: d._page, target: "_blank", rel: "noopener", style: { color: "var(--acc)" } }, "Civitai page ↗"),
          h("button.btn.pri.block", { style: { height: "52px", fontSize: "16px" }, onclick: () => save(true) }, icon("download"), `Add and download${size ? ` (${size} MB)` : ""}`),
          h("button.btn.block.ghost", { onclick: () => save(false) }, "Add without downloading (I already have the file)"));
        bd.classList.toggle("blurimg", S.settings.blur);
      };
      draw();
    },
  });
  async function save(download) {
    const chosen = d.styles.filter((x, i) => keep.has(i));
    if (!chosen.length) return toast("Tick at least one style.", { err: true });
    if (chosen.some((x) => !x.name.trim())) return toast("Every style needs a name.", { err: true });
    const styles = Object.fromEntries(chosen.map((x) => [x.name.trim(), { positive: x.positive, negative: x.negative, loras: x.loras, groups: x.groups }]));
    const r = await api("/waifu/m/api/style/save", { json: { styles, downloads: d._downloads, download } });
    s.close();
    const fam = S.graph.family();  // pick the version that fits the loaded model
    const best = chosen.find((x) => x.family === fam) || chosen[0];
    await afterStyleChange(best.name.trim());
    if (download && r.download?.running) { toast("Style added. Downloading the LoRA…", { ms: 5000 }); waitForStyleDownloads(best.name.trim()); }
    else toast("Style added.");
  }
}

async function waitForStyleDownloads(name) {
  for (;;) {
    await new Promise((r) => setTimeout(r, 2000));
    let st;
    try { st = await api("/waifu/m/api/models/download"); } catch { continue; }
    if (st.running) continue;
    const p = S.graph.roles().presets;
    await afterStyleChange(p && S.graph.get(p, "art_style") === name ? name : null);
    toast(st.failed.length ? `Download problem: ${st.failed.map((f) => f.error).join("; ")}` : "The style's LoRA is ready.", { err: !!st.failed.length, ms: 6000 });
    return;
  }
}

export function editStyle(name) {
  const isNew = !name;
  const st = isNew ? { positive: "", negative: "", loras: [] } : clone(S.presets.styles[name] || {});
  let newName = name || "";
  const s = sheet({
    title: isNew ? "New style" : "Edit style", full: true,
    body: (bd) => {
      const draw = () => {
        const lora = st.loras?.[0];
        const groups = (st.groups && st.groups.length ? st.groups : (lora && S.loras ? loraInfo(lora[0])?.words : null)) || [];
        clear(bd,
          h("div.lbl", "Style name"), textInput(newName, (v) => (newName = v), "e.g. Soft watercolor"),
          h("div.lbl", "LoRA file"),
          h("div.row",
            h("button.picker.grow", { onclick: async () => { const f = await loraPicker(); if (f) { st.loras = [[f, lora?.[1] ?? 0.8]]; st.groups = []; draw(); } } },
              h("span.grow", h("span.k", "LoRA"), h("span.v", lora ? short(lora[0]) : "none — tap to pick")), icon("down")),
            lora && h("button.btn", { onclick: () => { st.loras = []; draw(); } }, "Remove")),
          lora && h("div", h("div.lbl", "Strength"), stepper({ value: lora[1] ?? 0.8, min: 0, max: 2, step: 0.05, onChange: (v) => { st.loras[0][1] = v; } })),
          h("div.lbl", "Style words"),
          tagArea(st.positive || "", (v) => { st.positive = v; }, { placeholder: "trigger words, art style words…" }),
          groups.length ? h("div.lbl", "Trigger words") : null,
          groups.length ? h("div.chips", groups.map((gw) => h("button.chip", { onclick: () => { st.positive = [st.positive, gw.trim()].map((x) => (x || "").trim().replace(/,$/, "")).filter(Boolean).join(", ") + ","; draw(); } }, "+ " + gw.trim().slice(0, 70)))) : null,
          h("div.lbl", "Negative prompt"),
          tagArea(st.negative || "", (v) => { st.negative = v; }, { placeholder: "optional" }),
          h("button.btn.pri.block", { style: { height: "52px", fontSize: "16px" }, onclick: save }, icon("check"), "Save"),
          !isNew && h("button.btn.block.ghost.danger", { onclick: async () => {
            if (!(await confirmSheet(`Delete the style "${name}"?`, "It disappears from the list. Its LoRA file stays on your PC.", "Delete", true))) return;
            await api("/waifu/m/api/style/delete", { json: { name } }); s.close(); await afterStyleChange(null); toast("Style deleted");
          } }, icon("trash"), "Delete style"));
      };
      draw();
    },
  });
  async function save() {
    const n = newName.trim();
    if (!n) return toast("Give the style a name.", { err: true });
    await api("/waifu/m/api/style/save", { json: { styles: { [n]: st }, old_name: name } });
    s.close();
    await afterStyleChange(n);
    toast("Style saved");
  }
}
