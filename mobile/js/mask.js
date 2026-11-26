// Inpaint mask painter. One finger paints, two fingers zoom/pan.
// Saves the mask through /waifu/m/api/mask, which writes the source + alpha mask into input/waifu_mobile/.
import { h, icon, clear, api, toast, haptic, pushLayer, seg } from "./util.js";

let M = null;

export function maskPainter(ref) {
  return new Promise((resolve) => {
    if (!M) { M = h("div", { id: "mask" }); document.body.appendChild(M); }
    let result;
    const close = pushLayer(() => { M.classList.remove("open"); clear(M); resolve(result); });
    M.classList.add("open");
    build(ref, (name) => { result = name; close(); }, () => close());
  });
}

function build(ref, done, cancel) {
  const box = h("div.stagebox");
  const imgC = h("canvas"), maskC = h("canvas", { style: { opacity: 0.55 } });
  const cursor = h("div.cursor");
  const layer = h("div", { style: { position: "absolute", left: 0, top: 0, transformOrigin: "0 0" } }, imgC, maskC);
  box.append(layer, cursor);
  let brush = 48, tool = "brush";
  const status = h("span.hint", "Loading…");
  const sizeVal = h("b", String(brush));
  const size = h("input.slider", { type: "range", min: 6, max: 220, value: brush });
  size.oninput = () => { brush = +size.value; sizeVal.textContent = brush; };
  const undoBtn = h("button.btn.sm", { onclick: () => undo() }, icon("undo"));
  const saveBtn = h("button.btn.pri", { onclick: () => save() }, icon("check"), "Use mask");
  M.append(
    h("div.mtop", h("button.ibtn", { onclick: cancel }, icon("x")), h("div.grow", h("div", { style: { fontWeight: 650 } }, "Paint what to change"), status), saveBtn),
    box,
    h("div.mbot",
      h("div.row", seg([["brush", "Brush", "brush"], ["eraser", "Eraser", "eraser"]], tool, (v) => (tool = v)), undoBtn,
        h("button.btn.sm", { onclick: () => invert() }, "Invert"), h("button.btn.sm.danger", { onclick: () => { snap(); mctx.clearRect(0, 0, maskC.width, maskC.height); } }, icon("trash"))),
      h("div", h("div.lbl", "Brush size", sizeVal), size),
      h("div.hint", "1 finger paints · 2 fingers zoom/move")));

  const ictx = imgC.getContext("2d"), mctx = maskC.getContext("2d", { willReadFrequently: true });
  let view = { s: 1, x: 0, y: 0 }, W = 0, H = 0;
  const hist = [];
  const snap = () => { hist.push(mctx.getImageData(0, 0, W, H)); if (hist.length > 15) hist.shift(); };
  const undo = () => { const d = hist.pop(); if (d) mctx.putImageData(d, 0, 0); haptic(); };
  const invert = () => {
    snap();
    const d = mctx.getImageData(0, 0, W, H);
    for (let i = 0; i < d.data.length; i += 4) { const a = 255 - d.data[i + 3]; d.data[i] = 255; d.data[i + 1] = 60; d.data[i + 2] = 140; d.data[i + 3] = a > 127 ? 255 : 0; }
    mctx.putImageData(d, 0, 0);
  };
  const apply = () => { layer.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`; };

  const img = new Image();
  img.onload = async () => {
    W = img.naturalWidth; H = img.naturalHeight;
    for (const c of [imgC, maskC]) { c.width = W; c.height = H; }
    ictx.drawImage(img, 0, 0);
    const bw = box.clientWidth, bh = box.clientHeight;
    view.s = Math.min(bw / W, bh / H);
    view.x = (bw - W * view.s) / 2; view.y = (bh - H * view.s) / 2;
    apply();
    status.textContent = ref.replace(/ \[\w+\]$/, "");
    try {
      const r = await fetch(`/waifu/m/api/maskof?f=${encodeURIComponent(ref)}`);
      if (r.status === 200) {
        const mimg = await createImageBitmap(await r.blob());
        const tmp = new OffscreenCanvas(W, H), t = tmp.getContext("2d");
        t.drawImage(mimg, 0, 0, W, H);
        const d = t.getImageData(0, 0, W, H);
        for (let i = 0; i < d.data.length; i += 4) { const v = d.data[i]; d.data[i] = 255; d.data[i + 1] = 60; d.data[i + 2] = 140; d.data[i + 3] = v; }
        mctx.putImageData(d, 0, 0);
        status.textContent += " · existing mask loaded";
      }
    } catch {}
  };
  img.onerror = () => { status.textContent = "Could not load the image"; };
  img.src = `/waifu/m/api/thumb?a=1&s=2048&f=${encodeURIComponent(ref)}&v=${Date.now()}`;

  // ------------------------------------------------------------ painting + zoom
  const pts = new Map();
  let stroke = null, pinch = null, last = null;
  const toCanvas = (cx, cy) => { const r = box.getBoundingClientRect(); return [(cx - r.left - view.x) / view.s, (cy - r.top - view.y) / view.s]; };
  const showCursor = (cx, cy) => {
    const r = box.getBoundingClientRect();
    cursor.style.display = "block";
    cursor.style.width = cursor.style.height = brush + "px";
    cursor.style.left = cx - r.left - brush / 2 + "px"; cursor.style.top = cy - r.top - brush / 2 + "px";
  };
  const dot = (x, y) => {
    mctx.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
    mctx.fillStyle = "rgb(255,60,140)"; mctx.strokeStyle = "rgb(255,60,140)";
    mctx.lineCap = "round"; mctx.lineJoin = "round";
    mctx.lineWidth = brush / view.s;
    mctx.beginPath();
    if (last) { mctx.moveTo(last[0], last[1]); mctx.lineTo(x, y); mctx.stroke(); }
    else { mctx.arc(x, y, brush / view.s / 2, 0, Math.PI * 2); mctx.fill(); }
    last = [x, y];
  };
  box.addEventListener("pointerdown", (e) => {
    box.setPointerCapture(e.pointerId);
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      snap();
      stroke = { t: Date.now() };
      last = null;
      dot(...toCanvas(e.clientX, e.clientY));
      showCursor(e.clientX, e.clientY);
    } else if (pts.size === 2) {
      if (stroke) { if (Date.now() - stroke.t < 250) undo(); stroke = null; }
      const [a, b] = [...pts.values()];
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2, ...view };
      cursor.style.display = "none";
    }
  });
  box.addEventListener("pointermove", (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size >= 2) {
      const [a, b] = [...pts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const s = Math.max(0.2, Math.min(12, pinch.s * d / pinch.d));
      const r = box.getBoundingClientRect();
      const cx = (a.x + b.x) / 2 - r.left, cy = (a.y + b.y) / 2 - r.top;
      const px = pinch.cx - r.left, py = pinch.cy - r.top;
      view = { s, x: cx - (px - pinch.x) * (s / pinch.s), y: cy - (py - pinch.y) * (s / pinch.s) };
      apply();
    } else if (stroke) {
      dot(...toCanvas(e.clientX, e.clientY));
      showCursor(e.clientX, e.clientY);
    }
  });
  const up = (e) => {
    pts.delete(e.pointerId);
    if (pts.size < 2) pinch = null;
    if (!pts.size) { stroke = null; last = null; cursor.style.display = "none"; }
  };
  box.addEventListener("pointerup", up);
  box.addEventListener("pointercancel", up);

  async function save() {
    saveBtn.disabled = true;
    status.textContent = "Saving mask…";
    try {
      const blob = await new Promise((r) => maskC.toBlob(r, "image/png"));
      const fd = new FormData();
      fd.append("source", ref);
      fd.append("mask", blob, "mask.png");
      const res = await api("/waifu/m/api/mask", { method: "POST", body: fd });
      haptic(20);
      toast("Mask saved. Mode is now Inpaint.");
      done(res.name);
    } catch (e) {
      saveBtn.disabled = false;
      status.textContent = "Save failed: " + e.message;
    }
  }
}
