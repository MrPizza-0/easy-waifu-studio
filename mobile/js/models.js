// "Models & downloads": what the presets need, what is missing, and downloading it.
import { h, icon, clear, api, toast, sheet, haptic } from "./util.js";
import { S, refreshAfterDownload } from "./comfy.js";

export async function loadModels() {
  try { S.models = await api("/waifu/m/api/models"); } catch { S.models = null; }
  return S.models;
}

const mb = (items) => items.reduce((a, i) => a + (i.sizeMB || 0), 0);

// missing files for the current model / style / character outfit (+ the workflow's upscaler and detectors)
export function missingFor({ model, style, character, outfit, fam }) {
  if (!S.models) return [];
  const want = [`model: ${model}`, `style: ${style}`, `character: ${character} / ${outfit} / ${fam}`, `character: ${character} / ${outfit} / any`, `character: ${character}`, "workflow"];
  return S.models.items.filter((i) => !i.present && i.used_by.some((u) => want.some((w) => u === w || (w === "workflow" && u.startsWith(w)))));
}

export function modelsSheet(preselect = []) {
  const sel = new Set(preselect);
  let timer = null;
  sheet({
    title: "Models & downloads", full: true,
    onClose: () => clearInterval(timer),
    body: (bd) => {
      const keyBox = h("div");
      const prog = h("div");
      const list = h("div", { style: { display: "flex", flexDirection: "column", gap: "6px" } });
      const actions = h("div.row");
      bd.append(keyBox, prog, actions, list);

      const drawKey = () => {
        const inp = h("input.inp", { type: "password", placeholder: S.models?.key_set ? "saved (type to replace)" : "paste your Civitai API key", autocomplete: "off" });
        clear(keyBox,
          h("div.lbl", "Civitai API key", h("span", S.models?.key_set ? "✓ saved" : "not set")),
          h("div.row", h("div.grow", inp), h("button.btn", { onclick: async () => {
            const r = await api("/waifu/m/api/config", { json: { civitai_key: inp.value } });
            S.models.key_set = r.key_set; drawKey(); toast(r.key_set ? "Key saved" : "Key removed");
          } }, "Save")),
          h("div.hint", "civitai.com → Account settings → API keys"));
      };

      const draw = () => {
        const items = S.models?.items || [];
        const missing = items.filter((i) => !i.present);
        const st = S.models?.download || {};
        clear(prog);
        if (st.running || st.done?.length || st.failed?.length) {
          const pct = st.total ? Math.round((st.bytes / st.total) * 100) : 0;
          prog.append(h("div.live", { style: { margin: "0" } }, h("div.info",
            st.running && h("div", { style: { fontWeight: 650 } }, `Downloading ${st.current?.split("/").pop() || "…"}`),
            st.running && h("div.pbar", h("i", { style: { width: pct + "%" } })),
            st.running && h("div.hint", `${(st.bytes / 1048576).toFixed(0)} / ${(st.total / 1048576).toFixed(0)} MB · ${st.queue.length} more waiting`),
            st.done?.length ? h("div.hint", `✓ ${st.done.length} downloaded`) : null,
            ...(st.failed || []).map((f) => h("div.hint", { style: { color: "var(--bad)" } }, `✗ ${f.key.split("/").pop()}: ${f.error}`)))));
        }
        const chosen = missing.filter((i) => sel.has(i.key) && i.downloadable);
        clear(actions,
          h("button.btn.sm", { onclick: () => { missing.forEach((i) => i.downloadable && sel.add(i.key)); draw(); } }, "Select all"),
          h("button.btn.sm", { onclick: () => { sel.clear(); draw(); } }, "None"),
          h("span.grow"),
          h("button.btn.pri", { disabled: !chosen.length, onclick: async () => {
            haptic();
            S.models.download = await api("/waifu/m/api/models/download", { json: { keys: chosen.map((i) => i.key) } });
            sel.clear(); draw(); poll();
          } }, icon("download"), `Download ${chosen.length} (${mb(chosen) ? mb(chosen) + " MB" : "?"})`));
        clear(list,
          h("div.lbl", `Missing (${missing.length})`, h("span", `${items.length - missing.length} present`)),
          missing.length ? null : h("div.hint", "Everything the presets use is on this PC."),
          ...missing.map((i) => h("label.opt", { style: { alignItems: "flex-start" } },
            h("input", { type: "checkbox", checked: sel.has(i.key), disabled: !i.downloadable, style: { marginTop: "4px", accentColor: "var(--acc)" },
              onchange: (e) => { e.target.checked ? sel.add(i.key) : sel.delete(i.key); draw(); } }),
            h("span.grow", { style: { minWidth: 0 } },
              h("div.t", i.name || i.key.split("/").pop()),
              h("div.d", `${i.key}${i.sizeMB ? " · " + i.sizeMB + " MB" : ""}`),
              h("div.d", i.used_by.slice(0, 3).join(" · ") + (i.used_by.length > 3 ? ` · +${i.used_by.length - 3}` : "")),
              !i.downloadable && h("div.d", { style: { color: "var(--warn)" } }, "no download source — add it yourself")))));
      };

      const poll = () => {
        clearInterval(timer);
        timer = setInterval(async () => {
          S.models.download = await api("/waifu/m/api/models/download");
          draw();
          if (!S.models.download.running) {
            clearInterval(timer);
            await loadModels();
            await refreshAfterDownload();
            drawKey(); draw();
            toast(`Downloads finished: ${S.models.download.done.length} ok, ${S.models.download.failed.length} failed`);
          }
        }, 1000);
      };

      (S.models ? Promise.resolve() : loadModels()).then(() => { drawKey(); draw(); if (S.models?.download?.running) poll(); });
    },
  });
}
