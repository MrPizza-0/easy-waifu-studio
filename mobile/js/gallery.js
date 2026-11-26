// Gallery: browse F:\ComfyOutput (or whatever the output folder is) fast, on a phone.
import { h, icon, clear, api, toast, haptic, sheet, longPress, store, debounce, confirmSheet, pick } from "./util.js";
import { S, on, thumbUrl, saveSettings, markTrashed } from "./comfy.js";
import { openViewer } from "./viewer.js";

const PAGE = 150;
const dayKey = (ts) => { const d = new Date(ts * 1000); return d.getFullYear() + "-" + d.getMonth() + "-" + d.getDate(); };
function dayLabel(ts) {
  const d = new Date(ts * 1000), now = new Date();
  const diff = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 864e5);
  if (diff === 0) return "Today";
  if (diff === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { weekday: diff < 7 ? "long" : undefined, day: "numeric", month: "long", year: d.getFullYear() !== now.getFullYear() ? "numeric" : undefined });
}
export const isVideo = (f) => /\.(mp4|webm|mov)$/i.test(f);
export const origUrl = (f) => { const i = f.lastIndexOf("/"); return `/view?filename=${encodeURIComponent(f.slice(i + 1))}&subfolder=${encodeURIComponent(i > 0 ? f.slice(0, i) : "")}&type=output`; };
export const itemOf = ([f, m, size, fav]) => ({ f, m, size, fav, url: origUrl(f), mid: isVideo(f) ? null : thumbUrl(f, m, 1800), thumb: thumbUrl(f, m, 420), ref: f + " [output]", title: f.split("/").pop(), video: isVideo(f) });

export class Gallery {
  constructor(el, opts = {}) {
    this.el = el;
    this.opts = opts;
    this.dir = opts.dir ?? store.get("g:dir", "Waifu");
    this.view = opts.pick ? "folder" : store.get("g:view", "folder");
    this.q = "";
    this.sort = "new";
    this.items = [];
    this.total = 0;
    this.sel = new Set();
    this.build();
    this.load(true);
    if (!opts.pick) {
      on("jobDone", (job) => { if (job.images.some((i) => i.type === "output")) this.softRefresh(); });
    }
  }

  get cols() { return this.opts.pick ? 3 : S.settings.cols; }

  build() {
    const pickMode = !!this.opts.pick;
    this.title = h("h1", "Gallery", this.subtitle = h("small"));
    const top = pickMode ? null : h("div.topbar", this.title,
      this.searchBtn = h("button.ibtn", { onclick: () => this.toggleSearch() }, icon("search")),
      h("button.ibtn", { onclick: () => this.menu() }, icon("more")));
    this.searchInp = h("input.inp", { type: "search", placeholder: "Search prompts: rapi bikini -nsfw", enterkeyhint: "search" });
    this.searchBox = h("div.search" + (pickMode ? "" : ".hidden"), icon("search"), this.searchInp);
    this.searchInp.oninput = debounce(() => { this.q = this.searchInp.value.trim(); this.load(true); }, 350);
    this.viewSeg = h("div.seg");
    this.crumbs = h("div.crumbs");
    this.tools = h("div.gtools", this.searchBox, this.viewSeg, this.crumbs);
    this.ptr = h("div.ptr", "Release to refresh");
    this.folders = h("div.folders");
    this.grid = h("div");
    this.foot = h("div.gfoot");
    this.scroll = h("div.scroll", this.ptr, this.folders, this.grid, this.foot);
    this.selbar = h("div.selbar.hidden");
    this.el.append(...[top, this.tools, this.scroll, this.selbar].filter(Boolean));
    this.drawSeg();
    this.scroll.addEventListener("scroll", () => { if (this.scroll.scrollTop + this.scroll.clientHeight > this.scroll.scrollHeight - 1200) this.more(); }, { passive: true });
    this.gestures();
  }

  drawSeg() {
    const opts = [["folder", "Folders", "folder"], ["all", "Everything", "grid"], ["fav", "Favorites", "star"]];
    clear(this.viewSeg, opts.map(([v, l, ic]) => h("button" + (this.view === v ? ".on" : ""), { onclick: () => { this.view = v; if (!this.opts.pick) store.set("g:view", v); this.drawSeg(); this.load(true); } }, icon(ic), l)));
  }

  toggleSearch() {
    const show = this.searchBox.classList.toggle("hidden") === false;
    this.searchBtn.classList.toggle("on", show);
    if (show) setTimeout(() => this.searchInp.focus(), 50);
    else if (this.q) { this.q = ""; this.searchInp.value = ""; this.load(true); }
  }

  setDir(d) {
    this.dir = d;
    if (!this.opts.pick) store.set("g:dir", d);
    this.load(true);
  }

  drawCrumbs() {
    const parts = this.dir ? this.dir.split("/") : [];
    const btns = [h("button", { onclick: () => this.setDir("") }, "Output")];
    parts.forEach((p, i) => btns.push(h("span.dim", "›"), h("button", { onclick: () => this.setDir(parts.slice(0, i + 1).join("/")) }, p)));
    clear(this.crumbs, btns);
    this.crumbs.classList.toggle("hidden", this.view === "fav" && !this.dir);
    requestAnimationFrame(() => (this.crumbs.scrollLeft = 1e6));
  }

  async load(reset) {
    if (reset) {
      this.items = []; this.total = 0; this.done = false; this.lastDay = null; this.groupEl = null;
      clear(this.grid); clear(this.folders); this.scroll.scrollTop = 0;
      this.token = (this.token || 0) + 1;
    }
    this.drawCrumbs();
    await this.more();
  }

  async more() {
    if (this.loading || this.done) return;
    this.loading = true;
    const token = this.token;
    this.foot.replaceChildren(h("span.spin"));
    const p = new URLSearchParams({ dir: this.dir, offset: this.items.length, limit: PAGE, view: this.view, sort: this.sort });
    if (this.q) p.set("q", this.q);
    let res;
    try { res = await api("/waifu/m/api/files?" + p); }
    catch (e) {
      this.loading = false;
      if (e.status === 404 && this.dir) { this.dir = ""; return this.load(true); }
      this.foot.textContent = "Could not load: " + e.message; return;
    }
    if (token !== this.token) { this.loading = false; return; }
    if (this.items.length === 0) this.drawFolders(res.folders || []);
    const items = res.files.map(itemOf);
    this.items.push(...items);
    this.total = res.total;
    this.appendTiles(items);
    this.done = this.items.length >= res.total || !items.length;
    this.loading = false;
    const idx = res.index;
    this.foot.textContent = this.items.length ? (this.done ? `${this.total} ${this.total === 1 ? "file" : "files"}` : "") : (this.q ? "No matches." : "No images here.");
    if (idx?.running) this.foot.textContent += ` · search index: ${idx.done}/${idx.total} new files read`;
    this.subtitle.textContent = this.q ? `“${this.q}” · ${this.total} found` : this.view === "fav" ? `${this.total} favorites` : `${this.dir || "Output"} · ${this.total}`;
    if (!this.done && this.scroll.scrollHeight <= this.scroll.clientHeight + 400) this.more();
  }

  drawFolders(folders) {
    clear(this.folders);
    if (this.view !== "folder" || this.q) return;
    if (this.dir) folders = folders.slice();
    for (const f of folders) {
      const cv = h("div.cv", f.cover ? null : icon("folder"));
      if (f.cover && !isVideo(f.cover)) cv.style.backgroundImage = `url("${thumbUrl(f.cover, f.cover_m, 300)}")`;
      this.folders.appendChild(h("button.folder", { onclick: () => this.setDir(f.path) }, cv, h("div.n.ell", f.name), h("div.c", `${f.count}${f.dirs ? ` · ${f.dirs} folders` : ""}`)));
    }
  }

  appendTiles(items) {
    const size = this.cols <= 2 ? 640 : 420; // 420 is pre-generated by the server
    for (const it of items) {
      const k = dayKey(it.m);
      if (k !== this.lastDay) {
        this.lastDay = k;
        this.groupEl = h("div.ggrid", { style: { gridTemplateColumns: `repeat(${this.cols}, 1fr)` } });
        this.grid.append(h("div.ghead", dayLabel(it.m)), this.groupEl);
      }
      const idx = this.items.indexOf(it);
      const media = it.video
        ? h("video", { src: it.url + "#t=0.1", muted: true, preload: "metadata", playsInline: true, onloadeddata: (e) => e.target.classList.add("ld") })
        : h("img", { loading: "lazy", decoding: "async", src: thumbUrl(it.f, it.m, size), onload: (e) => e.target.classList.add("ld"), alt: "" });
      const tile = h("div.tile", media, it.video && h("span.vid", "▶ video"), it.fav && h("span.fav", icon("star")), h("div.selm" + (this.sel.has(it.f) ? ".s" : "")));
      tile.dataset.i = idx;
      tile.onclick = () => this.tap(it, tile);
      if (!this.opts.pick) longPress(tile, () => this.startSelect(it, tile));
      this.groupEl.appendChild(tile);
    }
  }

  tap(it, tile) {
    if (this.opts.pick) { haptic(); return this.opts.pick(it); }
    if (this.selecting) return this.toggleSel(it, tile);
    openViewer(this.items, this.items.indexOf(it), {
      loadMore: async () => { await this.more(); return this.items; },
      hasMore: () => !this.done,
      onChange: (kind, item) => this.itemChanged(kind, item),
    });
  }

  itemChanged(kind, item) {
    if (kind === "trash") {
      const i = this.items.indexOf(item);
      if (i >= 0) this.items.splice(i, 1);
      this.grid.querySelector(`.tile[data-i="${i}"]`)?.remove();
      this.reindex();
    } else if (kind === "fav") {
      const tile = this.findTile(item);
      if (tile) { tile.querySelector(".fav")?.remove(); if (item.fav) tile.appendChild(h("span.fav", icon("star"))); }
    }
  }
  findTile(item) { return this.grid.querySelector(`.tile[data-i="${this.items.indexOf(item)}"]`); }
  reindex() { [...this.grid.querySelectorAll(".tile")].forEach((t, i) => (t.dataset.i = i)); }

  // ------------------------------------------------------------ selection
  startSelect(it, tile) {
    this.selecting = true;
    this.el.classList.add("selecting");
    this.sel.clear();
    this.toggleSel(it, tile);
  }
  toggleSel(it, tile) {
    haptic(5);
    if (this.sel.has(it.f)) this.sel.delete(it.f); else this.sel.add(it.f);
    tile.querySelector(".selm").classList.toggle("s", this.sel.has(it.f));
    this.drawSelbar();
  }
  endSelect() {
    this.selecting = false;
    this.el.classList.remove("selecting");
    this.sel.clear();
    this.grid.querySelectorAll(".selm.s").forEach((x) => x.classList.remove("s"));
    this.selbar.classList.add("hidden");
  }
  drawSelbar() {
    if (!this.selecting) return;
    const n = this.sel.size;
    clear(this.selbar,
      h("button.ibtn", { onclick: () => this.endSelect() }, icon("x")),
      h("span.grow", `${n} selected`),
      h("button.ibtn", { onclick: () => { this.items.forEach((it) => this.sel.add(it.f)); this.grid.querySelectorAll(".selm").forEach((x) => x.classList.add("s")); this.drawSelbar(); } }, icon("check")),
      h("button.ibtn", { disabled: !n, onclick: () => this.favSel() }, icon("star")),
      h("button.ibtn", { disabled: !n, onclick: () => this.downloadSel() }, icon("download")),
      h("button.ibtn", { disabled: !n, style: { color: "var(--bad)" }, onclick: () => this.trashSel() }, icon("trash")));
    this.selbar.classList.remove("hidden");
  }
  async favSel() {
    const files = [...this.sel];
    const allFav = files.every((f) => this.items.find((i) => i.f === f)?.fav);
    await api("/waifu/m/api/favs", { json: allFav ? { remove: files } : { add: files } });
    for (const it of this.items) if (this.sel.has(it.f)) { it.fav = !allFav; this.itemChanged("fav", it); }
    toast(allFav ? `Removed ${files.length} from favorites` : `Added ${files.length} to favorites`);
    this.endSelect();
  }
  downloadSel() {
    const files = [...this.sel];
    files.forEach((f, i) => setTimeout(() => { const a = h("a", { href: origUrl(f), download: f.split("/").pop() }); document.body.appendChild(a); a.click(); a.remove(); }, i * 400));
    toast(`Downloading ${files.length}`);
    this.endSelect();
  }
  async trashSel() {
    const files = [...this.sel];
    if (!(await confirmSheet(`Move ${files.length} to trash?`, `They are moved to the _trash folder inside your output folder. Nothing is deleted.`, "Move to trash", true))) return;
    const res = await api("/waifu/m/api/trash", { json: { files } });
    this.endSelect();
    markTrashed(res.moved.map((m) => m[0]));
    for (const [f] of res.moved) { const it = this.items.find((i) => i.f === f); if (it) this.itemChanged("trash", it); }
    toast(`Moved ${res.moved.length} to trash`, { action: { label: "Undo", fn: async () => { await api("/waifu/m/api/restore", { json: { moved: res.moved } }); markTrashed(res.moved.map((m) => m[0]), false); this.load(true); } } });
  }

  // ------------------------------------------------------------ menu / refresh / gestures
  menu() {
    sheet({
      title: "Gallery",
      body: (bd, close) => {
        const opt = (ic, t, d, fn) => bd.appendChild(h("button.opt", { onclick: () => { close(); fn(); } }, h("span.ck", icon(ic)), h("span.grow", h("div.t", t), d && h("div.d", d))));
        bd.appendChild(h("div.lbl", "Columns (or pinch the grid)"));
        const seg = h("div.seg");
        for (const c of [2, 3, 4, 5]) seg.appendChild(h("button" + (S.settings.cols === c ? ".on" : ""), { onclick: () => { close(); this.setCols(c); } }, String(c)));
        bd.appendChild(seg);
        opt("refresh", "Refresh", "", () => this.load(true));
        opt("down", this.sort === "new" ? "Show oldest first" : "Show newest first", "", () => { this.sort = this.sort === "new" ? "old" : "new"; this.load(true); });
        opt("folder", "Go to Waifu Studio folder", "Waifu/", () => { this.view = "folder"; this.drawSeg(); this.setDir("Waifu"); });
        opt("check", "Select…", "", () => { this.selecting = true; this.el.classList.add("selecting"); this.drawSelbar(); });
        opt("scan", "Update search index", "", async () => { const s = await api("/waifu/m/api/index", { method: "POST" }); toast(s.running ? `Indexing… ${s.done}/${s.total}` : "Index update started"); });
      },
    });
  }

  setCols(c) {
    c = Math.max(2, Math.min(6, c));
    if (c === S.settings.cols) return;
    S.settings.cols = c; saveSettings();
    const keepIdx = this.firstVisible();
    for (const gr of this.grid.querySelectorAll(".ggrid")) gr.style.gridTemplateColumns = `repeat(${c}, 1fr)`;
    if (keepIdx != null) this.grid.querySelector(`.tile[data-i="${keepIdx}"]`)?.scrollIntoView({ block: "start" });
  }
  firstVisible() {
    const top = this.scroll.getBoundingClientRect().top;
    for (const t of this.grid.querySelectorAll(".tile")) { if (t.getBoundingClientRect().bottom > top + 40) return t.dataset.i; }
    return null;
  }

  async softRefresh() {
    if (this.q || this.view === "fav" || this.scroll.scrollTop > 200 || this.selecting) { this.stale = true; return; }
    this.load(true);
  }

  gestures() {
    // pinch the grid to change columns; pull down at the top to refresh
    let d0 = null, startCols, y0 = null, pulled = 0;
    const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    this.scroll.addEventListener("touchstart", (e) => {
      if (e.touches.length === 2 && !this.opts.pick) { d0 = dist(e.touches); startCols = S.settings.cols; }
      else if (e.touches.length === 1 && this.scroll.scrollTop <= 0) { y0 = e.touches[0].clientY; pulled = 0; }
    }, { passive: true });
    this.scroll.addEventListener("touchmove", (e) => {
      if (d0 && e.touches.length === 2) {
        const r = dist(e.touches) / d0;
        const target = r > 1.35 ? startCols - 1 : r < 0.72 ? startCols + 1 : startCols;
        if (target !== S.settings.cols) { haptic(10); this.setCols(target); }
      } else if (y0 != null && e.touches.length === 1) {
        pulled = e.touches[0].clientY - y0;
        if (this.scroll.scrollTop > 0 || pulled < 0) { y0 = null; this.ptr.style.height = "0"; return; }
        this.ptr.style.height = Math.min(56, pulled / 2.2) + "px";
        this.ptr.textContent = pulled > 120 ? "Release to refresh" : "Pull to refresh";
      }
    }, { passive: true });
    this.scroll.addEventListener("touchend", () => {
      d0 = null;
      if (y0 != null) { if (pulled > 120) { haptic(); this.load(true); } this.ptr.style.height = "0"; y0 = null; }
    });
  }

  shown() { if (this.stale) { this.stale = false; this.softRefresh(); } }
}

export function pickFromGallery() {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title: "Pick an image", full: true,
      onClose: () => { if (!done) resolve(undefined); },
      body: (bd) => {
        bd.style.padding = "0";
        bd.style.display = "flex";
        const box = h("div", { style: { flex: 1, display: "flex", flexDirection: "column", minHeight: 0, position: "relative" } });
        bd.appendChild(box);
        new Gallery(box, { pick: (it) => { done = true; resolve(it.ref); s.close(); } });
      },
    });
  });
}
