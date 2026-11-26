// Queue tab: live run, pending jobs (phone + PC), this session's results, recent history.
import { h, icon, clear, api, toast, sheet, confirmSheet, copyText } from "./util.js";
import { S, on, interrupt, cancel, clearPending, jobImages, jobCompares, viewUrl, relOf, imThumb } from "./comfy.js";
import { openViewer } from "./viewer.js";
import { toItem } from "./create.js";

export function queueView(el) {
  const sub = h("small");
  const top = h("div.topbar", h("h1", "Queue", sub),
    h("button.ibtn", { title: "Stop current", onclick: () => interrupt() }, icon("stop")),
    h("button.ibtn", { title: "Clear pending", onclick: async () => { if (await confirmSheet("Clear all pending jobs?", "This also removes jobs queued from the PC. The running job keeps running.", "Clear", true)) clearPending(); } }, icon("trash")));
  const live = h("div");
  const pending = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "0 12px" } });
  const mine = h("div", { style: { display: "flex", flexDirection: "column", gap: "8px", padding: "0 12px" } });
  const hist = h("div.hgrid");
  const scroll = h("div.scroll", live,
    h("div.ghead", "Waiting", h("span", "")), pending,
    h("div.ghead", "From this phone"), mine,
    h("div.ghead", "Recent runs (phone + PC)", h("button.btn.sm.ghost", { onclick: () => loadHist() }, icon("refresh"))), hist,
    h("div", { style: { height: "100px" } }));
  el.append(top, scroll);

  const drawLive = () => {
    clear(live);
    const run = S.run;
    const running = S.queue.running[0];
    if (!run && !running) { live.appendChild(h("div.live", h("div.info", h("div.mute", S.connected ? "Nothing running." : "Not connected to ComfyUI. Retrying…")))); return; }
    const job = run ? S.jobs.get(run.id) : running ? S.jobs.get(running[1]) : null;
    const pct = run?.max ? Math.round((run.value / run.max) * 100) : 0;
    const node = run?.node && job ? job.titles[run.node] : null;
    const eta = run?.rate && run.max ? Math.max(0, (run.max - run.value) / run.rate) : null;
    live.appendChild(h("div.live",
      h("div.pic", run?.preview ? h("img", { src: run.preview }) : h("div.mute", job ? (node ? "working…" : "starting…") : "Running a job queued from the PC")),
      h("div.info",
        h("div.row", h("div.grow", h("div", { style: { fontWeight: 650 } }, job ? job.desc : "PC job"), h("div.hint", [node, run?.max ? `${run.value}/${run.max}` : "", run?.rate ? `${run.rate.toFixed(2)} it/s` : "", eta != null ? `~${Math.ceil(eta)}s left in this step` : ""].filter(Boolean).join(" · "))),
          h("button.btn.sm.danger", { onclick: () => interrupt() }, icon("stop"), "Stop")),
        h("div.pbar", h("i", { style: { width: pct + "%" } })))));
  };

  const drawPending = () => {
    const P = S.queue.pending;
    sub.textContent = `${S.queue.running.length ? "1 running · " : ""}${P.length} waiting`;
    clear(pending);
    if (!P.length) { pending.appendChild(h("div.hint", "Nothing waiting.")); return; }
    P.forEach(([num, id, prompt, extra], i) => {
      const job = S.jobs.get(id);
      const ours = extra?.client_id === S.clientId;
      const pr = Object.values(prompt || {}).find((n) => n.class_type === "WaifuPresets");
      const desc = job?.desc || (pr ? pr.inputs.character : "job") ;
      pending.appendChild(h("div.job",
        h("div.ph", String(i + 1)),
        h("div.grow", h("div.t", desc), h("div.s", ours ? "from this phone" : "from the PC / another device")),
        h("button.btn.sm", { onclick: async () => { await cancel(id); toast("Removed from queue"); } }, icon("x"), "Cancel")));
    });
  };

  const drawMine = () => {
    clear(mine);
    const ids = [...S.order].reverse();
    if (!ids.length) { mine.appendChild(h("div.hint", "Nothing yet this visit.")); return; }
    for (const id of ids.slice(0, 40)) {
      const j = S.jobs.get(id);
      const imgs = jobImages(j);
      const final = imgs.find((x) => x.type === "output") || imgs[imgs.length - 1];
      const dur = j.ended && j.started ? Math.round((j.ended - j.started) / 1000) + "s" : "";
      const status = { pending: "waiting", running: "running…", done: "done", error: "error", stopped: "stopped" }[j.status] || j.status;
      const row = h("div.job",
        final ? h("img", { src: imThumb(final, 240), loading: "lazy" }) : h("div.ph", j.status === "running" ? h("span.spin") : icon("image")),
        h("div.grow", h("div.t", j.desc), h("div.s", [status, dur, j.seed != null ? "seed " + j.seed : "", imgs.length ? imgs.length + " images" : ""].filter(Boolean).join(" · ")),
          j.error && h("div.s", { style: { color: "var(--bad)" } }, `${j.error.node_type}: ${(j.error.exception_message || "").split("\n")[0]}`)),
        icon("right"));
      row.onclick = () => {
        if (j.error) return sheet({ title: "Error", body: h("div.ptext.mono", `${j.error.node_type} (#${j.error.node_id})\n\n${j.error.exception_message}\n\n${(j.error.traceback || []).join("")}`, h("button.ibtn.sm.cp", { onclick: () => copyText(j.error.exception_message) }, icon("copy"))) });
        if (!imgs.length) return;
        const items = imgs.map(toItem);
        for (const c of jobCompares(j)) items.push({ url: viewUrl(c.b), ref: relOf(c.b) + " [temp]", title: "⟷ " + (c.title || "compare"), compare: { a: viewUrl(c.a), b: viewUrl(c.b) } });
        openViewer(items, 0);
      };
      mine.appendChild(row);
    }
  };

  let histItems = [];
  async function loadHist() {
    try {
      const hh = await api("/history?max_items=30");
      const entries = Object.values(hh).sort((a, b) => (b.prompt?.[0] ?? 0) - (a.prompt?.[0] ?? 0));
      histItems = [];
      for (const e of entries) for (const out of Object.values(e.outputs || {})) for (const im of out.images || []) if (im.type === "output") histItems.push(im);
      clear(hist, histItems.slice(0, 60).map((im, i) => h("div.tile", { onclick: () => openViewer(histItems.map(toItem), i) },
        h("img", { loading: "lazy", src: `/waifu/m/api/thumb?f=${encodeURIComponent(relOf(im))}&s=360`, onload: (ev) => ev.target.classList.add("ld") }))));
      if (!histItems.length) hist.appendChild(h("div.hint", "No saved images in the ComfyUI history yet."));
    } catch {}
  }

  on("run", drawLive); on("preview", drawLive); on("conn", drawLive);
  on("queue", () => { drawLive(); drawPending(); });
  on("jobs", drawMine); on("jobOutput", drawMine);
  on("jobDone", () => { drawMine(); loadHist(); });
  el._shown = () => { drawLive(); drawPending(); drawMine(); loadHist(); };
}
