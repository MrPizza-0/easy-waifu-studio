// App state + ComfyUI connection: websocket progress/previews, queueing, queue + history.
import { api, store, toast, debounce, haptic } from "./util.js";
import { Graph, describe } from "./graph.js";

export const bus = new EventTarget();
export const emit = (name, detail) => bus.dispatchEvent(new CustomEvent(name, { detail }));
export const on = (name, fn) => bus.addEventListener(name, (e) => fn(e.detail));

export const S = {
  clientId: store.get("clientId") || (() => { const id = "wm-" + Math.random().toString(36).slice(2, 10); store.set("clientId", id); return id; })(),
  graph: null, info: {}, presets: null, loras: null, source: store.get("wfSource", "Waifu Studio.json"),
  jobs: new Map(),          // prompt_id -> job (this phone's jobs)
  order: [],                // prompt ids, newest last
  run: null,                // {id, node, value, max, preview, started, rate}
  queue: { running: [], pending: [] }, remaining: 0,
  lastSeed: store.get("lastSeed", null),
  connected: false,
  settings: Object.assign({ preview: "auto", blur: false, cols: 3, hd: false }, store.get("settings", {})),
  trashed: new Set(),       // output files moved to trash (paths relative to the output folder)
};
// gone=true after a trash, false after an undo. The Result card hides trashed images.
export function markTrashed(files, gone = true) {
  for (const f of files) gone ? S.trashed.add(f) : S.trashed.delete(f);
  emit("trashed");
}
export const saveSettings = () => store.set("settings", S.settings);

// ------------------------------------------------------------ workflow loading / persistence
const undoStack = [];
let lastSnap = 0;
export function changed(opts = {}) {
  if (!opts.noUndo) {
    const now = Date.now();
    if (now - lastSnap > 1200 && S._before) { undoStack.push(S._before); if (undoStack.length > 40) undoStack.shift(); }
    lastSnap = now;
  }
  S._before = JSON.stringify(S.graph.wf);
  persist();
  emit("graph", opts);
}
const persist = debounce(() => store.set("wf", S.graph.wf), 300);
export const canUndo = () => undoStack.length > 0;
export function undo() {
  const prev = undoStack.pop();
  if (!prev) return;
  S.graph = new Graph(JSON.parse(prev), S.info);
  S._before = prev;
  persist();
  emit("graph", { all: true });
  toast("Undone");
}

export async function ensureInfo(types) {
  const missing = types.filter((t) => !S.info[t]);
  if (missing.length) Object.assign(S.info, await api("/waifu/m/api/info?types=" + encodeURIComponent(missing.join("|"))));
}

export async function setWorkflow(wf, source) {
  await ensureInfo([...new Set((wf.nodes || []).map((n) => n.type))]);
  if (S.graph) { undoStack.push(JSON.stringify(S.graph.wf)); }
  S.graph = new Graph(wf, S.info);
  S._before = JSON.stringify(S.graph.wf);
  S.source = source;
  store.set("wfSource", source);
  store.set("wf", S.graph.wf);
  emit("graph", { all: true });
}

export async function loadWorkflowFile(name) {
  const wf = await api("/api/userdata/" + encodeURIComponent("workflows/" + name));
  await setWorkflow(wf, name);
}

export async function saveWorkflowFile(name) {
  await api("/api/userdata/" + encodeURIComponent("workflows/" + name) + "?overwrite=true&full_info=true", { method: "POST", body: JSON.stringify(S.graph.serialize()), headers: { "Content-Type": "application/json" } });
}

export async function listWorkflows() {
  const files = await api("/api/userdata?dir=workflows&recurse=true");
  return (files || []).filter((f) => f.endsWith(".json")).sort();
}

// newest history entry that ran Waifu Studio (this includes runs queued from the PC)
export async function lastPcRun() {
  const hist = await api("/history?max_items=60");
  const items = Object.entries(hist).sort((a, b) => (b[1].prompt?.[0] ?? 0) - (a[1].prompt?.[0] ?? 0));
  for (const [id, h] of items) {
    const wf = h.prompt?.[3]?.extra_pnginfo?.workflow;
    if (wf && wf.nodes?.some((n) => n.type === "WaifuText")) return { id, wf, prompt: h.prompt[2] };
  }
  return null;
}

export async function boot() {
  const [presets, models] = await Promise.all([api("/waifu/presets"), api("/waifu/m/api/models").catch(() => null)]);
  S.presets = presets;
  S.models = models;
  const saved = store.get("wf");
  if (saved?.nodes) await setWorkflow(saved, S.source);
  else {
    try { await loadWorkflowFile("Waifu Studio.json"); }
    catch { await setWorkflow(await api("/waifu/m/api/default-workflow"), "Waifu Studio (default)"); }
  }
  connect();
  refreshQueue();
}

// after new model files arrive: reload presets, LoRA list and the node option lists
export async function refreshAfterDownload() {
  S.presets = await api("/waifu/presets");
  S.loras = null;
  if (S.models) { try { S.models = await api("/waifu/m/api/models"); } catch {} }  // the missing-files list
  const types = Object.keys(S.info);
  S.info = {};
  await ensureInfo(types);
  S.graph.info = S.info;
  S.graph._w = new Map();
  emit("graph", { all: true });
}

export async function loras() {
  if (!S.loras) S.loras = await api("/waifu/m/api/loras");
  return S.loras;
}

// ------------------------------------------------------------ queueing
export async function queue(count = 1, opts = {}) {
  const g = S.graph;
  g.syncInpaint();
  const ids = [];
  for (let i = 0; i < count; i++) {
    const { prompt, seed } = g.toPrompt();
    const wf = g.serialize();
    // the saved image gets the seed that was actually used, so dragging it into ComfyUI reproduces it
    const seedNode = wf.nodes.find((n) => n.type === "Seed (rgthree)");
    if (seedNode && seed != null) seedNode.widgets_values[0] = seed;
    const body = { prompt, client_id: S.clientId, extra_data: { extra_pnginfo: { workflow: wf } } };
    if (S.settings.preview && S.settings.preview !== "default") body.extra_data.preview_method = S.settings.preview;
    if (opts.front) body.front = true;
    let res;
    try {
      res = await api("/prompt", { json: body });
    } catch (e) {
      emit("queueError", e.body || { error: { message: e.message } });
      throw e;
    }
    const job = { id: res.prompt_id, number: res.number, desc: describe(g), seed, created: Date.now(), status: "pending", outputs: {}, images: [], titles: nodeTitles(g) };
    S.jobs.set(job.id, job);
    S.order.push(job.id);
    if (seed != null) { S.lastSeed = seed; store.set("lastSeed", seed); }
    g.afterQueue();
    ids.push(job.id);
  }
  changed({ noUndo: true, quiet: true });
  haptic(20);
  emit("jobs");
  refreshQueue();
  return ids;
}

function nodeTitles(g) {
  const t = {};
  for (const n of g.nodes) t[n.id] = g.title(n);
  return t;
}

export async function interrupt() { await api("/interrupt", { method: "POST" }); toast("Stopping current run"); }
export async function cancel(id) { await api("/queue", { json: { delete: [id] } }); refreshQueue(); }
export async function clearPending() { await api("/queue", { json: { clear: true } }); refreshQueue(); }

export const refreshQueue = debounce(async () => {
  try {
    const q = await api("/queue");
    S.queue = { running: q.queue_running || [], pending: (q.queue_pending || []).sort((a, b) => a[0] - b[0]) };
    for (const [, id] of S.queue.running) { const j = S.jobs.get(id); if (j && j.status === "pending") j.status = "running"; }
    emit("queue");
  } catch {}
}, 150);

// ------------------------------------------------------------ websocket
let ws, retry = 0;
function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(`${proto}://${location.host}/ws?clientId=${S.clientId}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { S.connected = true; retry = 0; emit("conn"); refreshQueue(); };
  ws.onclose = () => { S.connected = false; emit("conn"); setTimeout(connect, Math.min(8000, 800 * 2 ** retry++)); };
  ws.onmessage = (e) => {
    if (typeof e.data !== "string") return onBinary(e.data);
    let m; try { m = JSON.parse(e.data); } catch { return; }
    onMessage(m.type, m.data || {});
  };
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") { if (!ws || ws.readyState > 1) connect(); refreshQueue(); }
});

function onBinary(buf) {
  const view = new DataView(buf);
  const type = view.getUint32(0);
  let blob;
  if (type === 1) {
    const fmt = view.getUint32(4);
    blob = new Blob([buf.slice(8)], { type: fmt === 2 ? "image/png" : "image/jpeg" });
  } else if (type === 4) {
    const len = view.getUint32(4);
    let meta = {};
    try { meta = JSON.parse(new TextDecoder().decode(buf.slice(8, 8 + len))); } catch {}
    blob = new Blob([buf.slice(8 + len)], { type: meta.image_type || "image/jpeg" });
  } else return;
  if (!S.run) return;
  if (S.run.preview) URL.revokeObjectURL(S.run.preview);
  S.run.preview = URL.createObjectURL(blob);
  emit("preview");
}

function onMessage(type, d) {
  const job = d.prompt_id ? S.jobs.get(d.prompt_id) : null;
  switch (type) {
    case "status":
      S.remaining = d.status?.exec_info?.queue_remaining ?? 0;
      emit("status");
      refreshQueue();
      break;
    case "execution_start":
      S.run = { id: d.prompt_id, node: null, value: 0, max: 0, preview: null, started: Date.now(), rate: 0, mine: !!job };
      if (job) { job.status = "running"; job.started = Date.now(); }
      emit("run"); refreshQueue();
      break;
    case "executing":
      if (!S.run || S.run.id !== d.prompt_id) S.run = { id: d.prompt_id, started: Date.now(), mine: !!job, value: 0, max: 0 };
      if (d.node == null) { finish(d.prompt_id, "done"); break; }
      S.run.node = d.node; S.run.value = 0; S.run.max = 0; S.run.t0 = Date.now();
      emit("run");
      break;
    case "progress":
      if (!S.run) break;
      if (S.run.node !== d.node) { S.run.node = d.node; S.run.t0 = Date.now(); }
      if (d.value > 1 && S.run.t0) S.run.rate = (d.value - 1) / ((Date.now() - S.run.t0) / 1000);
      if (d.value === 1) S.run.t0 = Date.now();
      S.run.value = d.value; S.run.max = d.max;
      emit("run");
      break;
    case "executed":
      if (job) {
        job.outputs[d.node] = d.output;
        for (const im of d.output?.images || []) if (im.type === "output") S.trashed.delete(relOf(im));  // a new file can reuse a trashed name
        for (const im of d.output?.images || []) job.images.push({ ...im, node: d.node, title: job.titles[d.node], v: job.id });  // v: ComfyUI reuses file names after a delete, so thumbnail URLs carry the job id
        if (d.output?.text) job.text = job.text || {};
        if (d.output?.text) job.text[d.node] = d.output.text.join("\n");
        emit("jobOutput", job);
      }
      break;
    case "execution_cached":
      break;
    case "execution_success":
      finish(d.prompt_id, "done");
      break;
    case "execution_interrupted":
      finish(d.prompt_id, "stopped");
      break;
    case "execution_error":
      if (job) { job.error = d; }
      toast(`${d.node_type || "Error"}: ${(d.exception_message || "").split("\n")[0].slice(0, 160)}`, { err: true, ms: 9000 });
      finish(d.prompt_id, "error");
      break;
  }
}

function finish(id, status) {
  const job = S.jobs.get(id);
  if (job && job.status !== "done" && job.status !== "error" && job.status !== "stopped") {
    job.status = status;
    job.ended = Date.now();
    if (status === "done") { haptic([30, 60, 30]); emit("jobDone", job); }
  }
  if (S.run && S.run.id === id) { if (S.run.preview && job) job.lastPreview = S.run.preview; S.run = null; }
  emit("run"); emit("jobs"); refreshQueue();
}

// ------------------------------------------------------------ outputs helpers
export const viewUrl = (im) => `/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || "")}&type=${im.type || "output"}`;
export const relOf = (im) => (im.subfolder ? im.subfolder.replace(/\\/g, "/") + "/" : "") + im.filename;
export const thumbUrl = (f, m, s = 480) => `/waifu/m/api/thumb?f=${encodeURIComponent(f)}&s=${s}&v=${m || 0}`;
export const midUrl = (f, m) => thumbUrl(f, m, 1800);
// resized preview of any ComfyUI image ref (output or temp)
export const imThumb = (im, s = 1800) => `/waifu/m/api/thumb?a=1&s=${s}&f=${encodeURIComponent(relOf(im) + ` [${im.type || "output"}]`)}${im.v ? "&v=" + encodeURIComponent(im.v) : ""}`;

// the job's images sorted for display: final first, then base preview, then comparisons
export function jobImages(job) {
  const allFinals = job.images.filter((i) => i.type === "output");
  const finals = allFinals.filter((i) => !S.trashed.has(relOf(i)));
  // every saved image of this job was trashed: hide the whole job, its previews and compare images too
  if (allFinals.length && !finals.length) return [];
  const temps = job.images.filter((i) => i.type !== "output");
  return [...finals, ...temps];
}
export function jobCompare(job) {
  // the "preview vs final" comparer (whole chain) if it produced a pair
  for (const [node, out] of Object.entries(job.outputs)) {
    if (out?.a_images?.length && out?.b_images?.length && /whole chain|preview vs final/i.test(job.titles[node] || "")) return { a: out.a_images[0], b: out.b_images[0], title: job.titles[node] };
  }
  for (const [node, out] of Object.entries(job.outputs)) {
    if (out?.a_images?.length && out?.b_images?.length) return { a: out.a_images[0], b: out.b_images[0], title: job.titles[node] };
  }
  return null;
}
export function jobCompares(job) {
  return Object.entries(job.outputs).filter(([, o]) => o?.a_images?.length && o?.b_images?.length)
    .map(([n, o]) => ({ a: o.a_images[0], b: o.b_images[0], title: job.titles[n] }));
}
