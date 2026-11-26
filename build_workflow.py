"""Builds 'Waifu Studio.json' into the ComfyUI workflows folder.

Run:  python_embeded\\python.exe ComfyUI\\custom_nodes\\waifu_studio\\build_workflow.py
(Overwrites the workflow file - rename yours first if you edited it.)
"""
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
COMFY = os.path.abspath(os.path.join(HERE, "..", ".."))
WF_DIR = os.path.join(COMFY, "user", "default", "workflows")
OUT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(WF_DIR, "Waifu Studio.json")


class WF:
    def __init__(self):
        self.nodes, self.links, self.groups = [], [], []
        self.nid, self.lid = 0, 0

    def node(self, type_, pos, size, widgets=None, inputs=(), outputs=(), title=None, props=None,
             color=None, bgcolor=None, collapsed=False):
        self.nid += 1
        n = {
            "id": self.nid, "type": type_, "pos": list(pos), "size": list(size),
            "flags": {"collapsed": True} if collapsed else {}, "order": self.nid, "mode": 0,
            "inputs": [dict(name=a, type=b, link=None, **({"widget": {"name": a}} if w else {}))
                       for a, b, *w in inputs],
            "outputs": [{"name": a, "type": b, "links": [], "slot_index": i} for i, (a, b) in enumerate(outputs)],
            "properties": dict({"Node name for S&R": type_}, **(props or {})),
        }
        if widgets is not None:
            n["widgets_values"] = widgets
        if title:
            n["title"] = title
        if color:
            n["color"] = color
        if bgcolor:
            n["bgcolor"] = bgcolor
        self.nodes.append(n)
        return n

    def link(self, a, a_out, b, b_in):
        ai = a_out if isinstance(a_out, int) else [o["name"] for o in a["outputs"]].index(a_out)
        bi = [i["name"] for i in b["inputs"]].index(b_in)
        self.lid += 1
        t = a["outputs"][ai]["type"]
        self.links.append([self.lid, a["id"], ai, b["id"], bi, t])
        a["outputs"][ai]["links"].append(self.lid)
        b["inputs"][bi]["link"] = self.lid

    def group(self, title, x, y, w, h, color):
        self.groups.append({"id": len(self.groups) + 1, "title": title, "bounding": [x, y, w, h],
                            "color": color, "font_size": 26, "flags": {}})

    # KJNodes Set/Get - wireless links
    def set_(self, name, type_, src, src_out, pos):
        s = self.node("SetNode", pos, [210, 58], [name], inputs=[(type_, type_)], outputs=[("*", "*")],
                      title=f"Set_{name}", props={"previousName": name}, color="#223", bgcolor="#335", collapsed=True)
        self.link(src, src_out, s, type_)
        return s

    def get(self, name, type_, pos):
        return self.node("GetNode", pos, [210, 58], [name], outputs=[(type_, type_)], title=f"Get_{name}",
                         color="#223", bgcolor="#335", collapsed=True)


def face_widgets(guide, max_size, denoise, crop=3.0, threshold=0.5, dilation=10):
    return [guide, True, max_size, 0, "fixed", 20, 7.0, "euler_ancestral", "simple", denoise, 5, True, True,
            threshold, dilation, crop, "center-1", 0, 0.93, 0, 0.7, "False", 10, "", 1, False, 20, False, False]


FD_IN = [("image", "IMAGE"), ("model", "MODEL"), ("clip", "CLIP"), ("vae", "VAE"), ("positive", "CONDITIONING"),
         ("negative", "CONDITIONING"), ("bbox_detector", "BBOX_DETECTOR"), ("sam_model_opt", "SAM_MODEL"),
         ("segm_detector_opt", "SEGM_DETECTOR"), ("detailer_hook", "DETAILER_HOOK"),
         ("scheduler_func_opt", "SCHEDULER_FUNC")]
UNPACK_OUT = [("model", "MODEL"), ("clip", "CLIP"), ("vae", "VAE"), ("positive", "CONDITIONING"),
              ("negative", "CONDITIONING"), ("basic_pipe", "BASIC_PIPE"), ("seed", "INT")]

PINK, BLUE, GREEN, PURPLE, ORANGE, GREY, CYAN = "#a1309b", "#3f789e", "#3f8f5f", "#6c4fa0", "#b06634", "#444", "#2f8f8f"

README = """💖 WAIFU STUDIO - quick start

1. 🎯 PRESETS: pick model, character, art style. They fill the boxes,
   the Power Lora Loader and the sampler settings ONCE - then it's all yours
   to edit (delete 'blue eyes' for a from-behind shot, swap the outfit...).
   '✏️ Custom' character leaves the box and LoRAs alone.
2. Power Lora Loader: switch LoRAs on/off freely. Switching one on by hand
   adds its trigger words to the 'lora_triggers' box automatically.
3. ✍️ scene box: pose, place, mood. Presets never touch it.
   <lora:name:0.8> in the text also loads that LoRA.
4. 🎛️ MODE + switches: pick what runs. All off = fast preview. Queue!

LIKE A PREVIEW? Click '♻️ Use Last Queued Seed' on the Seed node, turn on
Upscale / detailers, queue again: only the new steps run.

UPSCALE FROM / INPAINT: put the image in 📂 Load Image (inpaint: right-click
it > Open in MaskEditor, paint the area), then set MODE.

Phone UI: http://<this pc>:8188/waifu/m/   LoRA guide: /waifu/loras
Preset files: custom_nodes/easy-waifu-studio/presets/*.json (edit, press R)."""


def preset_state():
    """Box/LoRA contents matching the default presets, so the workflow opens filled in."""
    def load(name):
        with open(os.path.join(HERE, "presets", name), encoding="utf-8") as f:
            return json.load(f)
    model = load("models.json")[DEFAULT_MODEL]
    ch = load("characters.json")[DEFAULT_CHARACTER]
    style = load("styles.json")[DEFAULT_STYLE]
    fam = "anima" if model.get("unet") else "illustrious"
    if "outfits" in ch:
        o = ch["outfits"][ch["default_outfit"]]
        o = o.get(fam) or o.get("any") or {"tags": ch.get("tags", ""), "loras": []}
        char_tags, char_loras = o["tags"], o["loras"]
    else:
        char_tags, char_loras = "\n".join(x for x in (ch.get("tags"), ch.get("outfit")) if x), ch.get("loras", [])
    join = lambda *p: " ".join(x.strip() for x in p if x and x.strip())
    managed = {"model": [n for n, _ in model["quality_loras"]], "style": [n for n, _ in style["loras"]],
               "character": [n for n, _ in char_loras]}
    rows = [{"on": True, "lora": n, "strength": st, "strengthTwo": None}
            for n, st in model["quality_loras"] + style["loras"] + char_loras]
    return model, {
        "base": join(model["positive"], style["positive"]),
        "character": char_tags,
        "negative": join(model["negative"], style["negative"]),
        "rows": rows, "managed": managed,
    }


DEFAULT_MODEL, DEFAULT_CHARACTER, DEFAULT_STYLE = "WAI NSFW Illustrious v14", "Rapi (NIKKE)", "None"


def build():
    w = WF()
    model, st = preset_state()

    # ---------------------------------------------------------- CONTROL PANEL
    w.group("💖 CONTROL PANEL", -20, -60, 1460, 1920, PINK)
    w.node("Note", [0, 30], [440, 400], [README], title="📖 READ ME", color="#432", bgcolor="#653")
    seed = w.node("Seed (rgthree)", [0, 470], [440, 130], [-1, "", "", ""], outputs=[("SEED", "INT")])
    w.node("WaifuPresets", [0, 640], [440, 190], [DEFAULT_MODEL, DEFAULT_CHARACTER, DEFAULT_STYLE, "(default)"],
           title="🎯 PRESETS (fill the fields once)", props={"waifu_managed": st["managed"]},
           color="#4a1f45", bgcolor="#6b2c63")

    mode = w.node("WaifuMode", [460, 30], [400, 80], ["Generate"],
                  outputs=[("use_loaded_image", "BOOLEAN"), ("inpaint", "BOOLEAN")], title="🎛️ MODE",
                  color="#4a1f45", bgcolor="#6b2c63")
    w.set_("use_loaded", "BOOLEAN", mode, "use_loaded_image", [0, 1720])
    w.set_("inpaint", "BOOLEAN", mode, "inpaint", [0, 1760])
    switches = {}
    for i, (key, label) in enumerate([("hires", "🔍 Upscale 2x"), ("face", "🙂 Face Detailer"), ("hands", "✋ Hand Detailer"),
                                      ("mouth", "👄 Mouth Detailer"), ("ultra", "💎 Ultra Upscale (4x total)")]):
        sw = w.node("WaifuSwitch", [460, 150 + i * 100], [400, 58], [False], outputs=[("on", "BOOLEAN")],
                    title=label, color="#4a1f45", bgcolor="#6b2c63")
        switches[key] = sw
        w.set_("sw_" + key, "BOOLEAN", sw, "on", [180 + (i // 3) * 160, 1720 + (i % 3) * 40])
    canvas = w.node("WaifuCanvas", [460, 700], [400, 170], ["Portrait 896x1152", 1, 896, 1152],
                    outputs=[("latent", "LATENT"), ("width", "INT"), ("height", "INT")])

    anima = bool(model.get("unet"))
    ckpt = w.node("WaifuLoader", [880, 30], [540, 230],
                  ["Anima (diffusion model + Qwen + VAE)" if anima else "Checkpoint (SDXL / Illustrious)",
                   model.get("checkpoint", "waiNSFWIllustrious_v140.safetensors"), model.get("clip_skip", -2),
                   model.get("unet", "Nova3DCGAMV10.safetensors"), model.get("text_encoder", "qwen_3_06b_base.safetensors"),
                   model.get("vae", "qwen_image_vae.safetensors"), model.get("shift", 3.0)],
                  outputs=[("model", "MODEL"), ("clip", "CLIP"), ("vae", "VAE")],
                  title="📦 Model (filled by the model preset)")
    pll = w.node("Power Lora Loader (rgthree)", [880, 290], [540, 580],
                 [{}, {"type": "PowerLoraLoaderHeaderWidget"}, *st["rows"], {}, ""],
                 inputs=[("model", "MODEL"), ("clip", "CLIP")], outputs=[("MODEL", "MODEL"), ("CLIP", "CLIP")],
                 props={"Show Strengths": "Single Strength"})
    w.link(ckpt, "model", pll, "model")
    w.link(ckpt, "clip", pll, "clip")

    text = w.node("WaifuText", [0, 920], [860, 760],
                  [st["base"], st["character"], "", "cowboy_shot, looking_at_viewer, smile,", st["negative"]],
                  outputs=[("base_positive", "STRING"), ("scene", "STRING"), ("negative", "STRING")],
                  title="✍️ PROMPT (all editable)")
    settings = w.node("WaifuSettings", [880, 920], [540, 160],
                      [model["steps"], model["cfg"], model["sampler"], model["scheduler"]],
                      outputs=[("settings", "WAIFU_SETTINGS")], title="⚙️ Sampler settings")
    enc = w.node("WaifuEncode", [880, 1120], [540, 150],
                 inputs=[("model", "MODEL"), ("clip", "CLIP"), ("vae", "VAE"), ("settings", "WAIFU_SETTINGS"),
                         ("seed", "INT"), ("base_positive", "STRING"), ("scene", "STRING"), ("negative", "STRING")],
                 outputs=[("waifu", "WAIFU"), ("final_prompt", "STRING")])
    final_txt = w.node("ShowText|pysssss", [880, 1410], [540, 270], [""], inputs=[("text", "STRING")],
                       outputs=[("STRING", "STRING")], title="📝 Final prompt actually used")
    w.link(pll, "MODEL", enc, "model")
    w.link(pll, "CLIP", enc, "clip")
    w.link(ckpt, "vae", enc, "vae")
    w.link(settings, "settings", enc, "settings")
    w.link(seed, 0, enc, "seed")
    for k in ("base_positive", "scene", "negative"):
        w.link(text, k, enc, k)
    w.link(enc, "final_prompt", final_txt, "text")
    w.set_("waifu", "WAIFU", enc, "waifu", [0, 1800])

    # ---------------------------------------------------------- SOURCE
    X = 1500
    w.group("🎨 GENERATE / 📂 LOAD IMAGE", X, -60, 1000, 1500, BLUE)
    g_w = w.get("waifu", "WAIFU", [X + 20, 20])
    sampler = w.node("WaifuSampler", [X + 20, 70], [300, 80],
                     inputs=[("waifu", "WAIFU"), ("latent", "LATENT")], outputs=[("image", "IMAGE")])
    w.link(g_w, 0, sampler, "waifu")
    w.link(canvas, "latent", sampler, "latent")
    load = w.node("LoadImage", [X + 20, 240], [300, 420], ["example.png", "image"],
                  outputs=[("IMAGE", "IMAGE"), ("MASK", "MASK")], title="📂 Load Image (Upscale From / Inpaint)")
    g_f = w.get("use_loaded", "BOOLEAN", [X + 20, 880])
    src = w.node("WaifuGate", [X + 20, 900], [300, 100], None,
                 inputs=[("enabled", "BOOLEAN"), ("off", "IMAGE"), ("on", "IMAGE")], outputs=[("image", "IMAGE")],
                 title="🚦 Source: generated or loaded")
    w.link(g_f, 0, src, "enabled")
    w.link(sampler, "image", src, "off")
    # optional: bypass (Ctrl+B) when not needed - bypassed it passes the image straight through
    scale = w.node("ImageScaleToTotalPixels", [X + 20, 700], [300, 106], ["lanczos", 1.0, 8],
                   inputs=[("image", "IMAGE")], outputs=[("IMAGE", "IMAGE")],
                   title="📐 Scale to Total Pixels (Upscale From only - bypass with Ctrl+B)",
                   color="#4a1f45", bgcolor="#6b2c63")
    w.link(load, "IMAGE", scale, "image")
    w.link(scale, "IMAGE", src, "on")
    prev = w.node("PreviewImage", [X + 340, 30], [640, 860], inputs=[("images", "IMAGE")],
                  title="👀 PREVIEW (base image)")
    w.link(src, "image", prev, "images")
    w.node("Note", [X + 20, 1040], [960, 180],
           ["Generate mode: the sampler makes the image from your prompt.\n"
            "Upscale From / Inpaint mode: the 📂 Load Image box is used instead and the sampler is skipped.\n"
            "Inpaint: right-click the Load Image node > 'Open in MaskEditor', paint what to change, save, and describe "
            "the change in the Prompt box."], title="ℹ️ source", color="#432", bgcolor="#653")

    # ---------------------------------------------------------- STAGES
    def stage(title, color, x, y, gate_name, build_fn, prev_img, w_=980, h_=1440, note_text=None):
        w.group(title, x, y, w_, h_, color)
        gw = w.get("waifu", "WAIFU", [x + 20, y + 70])
        gf = w.get("inpaint" if gate_name == "inpaint" else "sw_" + gate_name, "BOOLEAN", [x + 20, y + 110])
        out = build_fn(gw, prev_img, x + 20, y + 330)
        gate = w.node("WaifuGate", [x + 20, y + h_ - 140], [330, 100], None,
                      inputs=[("enabled", "BOOLEAN"), ("off", "IMAGE"), ("on", "IMAGE")],
                      outputs=[("image", "IMAGE")], title=f"🚦 {gate_name}")
        w.link(gf, 0, gate, "enabled")
        w.link(prev_img[0], prev_img[1], gate, "off")
        w.link(out[0], out[1], gate, "on")
        guard = w.node("WaifuCompareGuard", [x + 20, y + h_ - 180], [330, 80],
                       inputs=[("before", "IMAGE"), ("after", "IMAGE")],
                       outputs=[("before", "IMAGE"), ("after", "IMAGE")], collapsed=True)
        w.link(prev_img[0], prev_img[1], guard, "before")
        w.link(gate, "image", guard, "after")
        cmp_ = w.node("Image Comparer (rgthree)", [x + 370, y + 60], [w_ - 390, h_ - 80], [],
                      inputs=[("image_a", "IMAGE"), ("image_b", "IMAGE")], outputs=[],
                      props={"comparer_mode": "Slide"}, title=f"🔀 before / after - {gate_name}")
        w.link(guard, "before", cmp_, "image_a")
        w.link(guard, "after", cmp_, "image_b")
        if note_text:
            w.node("Note", [x + 20, y + 150], [330, 140], [note_text], title="ℹ️", color="#432", bgcolor="#653")
        return (gate, "image")

    def inpaint_fn(gw, img, x, y):
        ip = w.node("WaifuInpaintPrompt", [x + 350, y - 270], [590, 460], ["", ""],
                    inputs=[("waifu", "WAIFU"), ("positive", "STRING", 1), ("negative", "STRING", 1)],
                    outputs=[("waifu", "WAIFU")], title="🖌️ INPAINT PROMPT (copy of main prompt - edit freely)",
                    color="#4a1f45", bgcolor="#6b2c63")
        w.link(gw, 0, ip, "waifu")
        up = w.node("WaifuUnpack", [x, y], [330, 170], inputs=[("waifu", "WAIFU")], outputs=UNPACK_OUT)
        w.link(ip, "waifu", up, "waifu")
        md = w.node("MaskDetailerPipe", [x, y + 210], [330, 640],
                    [1024, True, 1024, True, 0, "randomize", 28, 6.0, "euler_ancestral", "normal", 0.6, 8, 3.0, 10,
                     0.2, 1, 1, False, 20, False, True],
                    inputs=[("image", "IMAGE"), ("mask", "MASK"), ("basic_pipe", "BASIC_PIPE"),
                            ("refiner_basic_pipe_opt", "BASIC_PIPE"), ("detailer_hook", "DETAILER_HOOK"),
                            ("scheduler_func_opt", "SCHEDULER_FUNC")],
                    outputs=[("image", "IMAGE"), ("cropped_refined", "IMAGE"), ("cropped_enhanced_alpha", "IMAGE"),
                             ("basic_pipe", "BASIC_PIPE"), ("refiner_basic_pipe_opt", "BASIC_PIPE")],
                    title="🖌️ Inpaint (masked area, crop & stitch)")
        w.link(img[0], img[1], md, "image")
        w.link(load, "MASK", md, "mask")
        w.link(up, "basic_pipe", md, "basic_pipe")
        return (md, "image")

    def hires_fn(gw, img, x, y, ultra=False):
        vals = (["2x-AnimeSharpV4_RCAN.safetensors", 2.0, 0.25, 20, 0.0, "tiled", 1024, 2] if ultra else
                ["2x-AnimeSharpV4_RCAN.safetensors", 2.0, model["hires_denoise"], 20, 0.0, "full image", 1024, 1])
        hr = w.node("WaifuHiRes", [x, y], [330, 300], vals, inputs=[("waifu", "WAIFU"), ("image", "IMAGE")],
                    outputs=[("image", "IMAGE")], title="🔍 Ultra 2x (tiled)" if ultra else "🔍 Upscale 2x + 2nd pass")
        w.link(gw, 0, hr, "waifu")
        w.link(img[0], img[1], hr, "image")
        return (hr, "image")

    def detailer_fn(model_name, widgets, label):
        def fn(gw, img, x, y):
            det = w.node("UltralyticsDetectorProvider", [x, y], [330, 80], [model_name],
                         outputs=[("BBOX_DETECTOR", "BBOX_DETECTOR"), ("SEGM_DETECTOR", "SEGM_DETECTOR")])
            up = w.node("WaifuUnpack", [x, y + 120], [330, 170], inputs=[("waifu", "WAIFU")], outputs=UNPACK_OUT)
            w.link(gw, 0, up, "waifu")
            fd = w.node("FaceDetailer", [x, y + 330], [330, 300], widgets, inputs=FD_IN,
                        outputs=[("image", "IMAGE"), ("cropped_refined", "IMAGE"), ("cropped_enhanced_alpha", "IMAGE"),
                                 ("mask", "MASK"), ("detailer_pipe", "DETAILER_PIPE"), ("cnet_images", "IMAGE")],
                        title=label, collapsed=True)
            w.link(img[0], img[1], fd, "image")
            for k in ("model", "clip", "vae", "positive", "negative"):
                w.link(up, k, fd, k)
            w.link(det, "BBOX_DETECTOR", fd, "bbox_detector")
            w.link(det, "SEGM_DETECTOR", fd, "segm_detector_opt")
            return (fd, "image")
        return fn

    SX, SY, SW, SH, GAP = 2560, -60, 980, 1440, 40
    img = (src, "image")
    img = stage("🖌️ INPAINT (mode: Inpaint)", GREY, SX, SY, "inpaint", inpaint_fn, img,
                note_text="Repaints only the masked part.\nThe 🖌️ INPAINT PROMPT box starts as a copy of your main prompt: edit it "
                          "(e.g. 'yellow necktie') - it stops following the main prompt once you edit it. ↻ re-copies. "
                          "Empty = main prompt.\nDenoise 0.6 default, 0.4 = small fix. Seed changes every run.")
    inpaint_cmp = next(n for n in w.nodes if n.get("title") == "🔀 before / after - inpaint")
    inpaint_cmp["pos"], inpaint_cmp["size"] = [SX + 370, SY + 540], [SW - 390, SH - 620]
    img = stage("🔍 UPSCALE 2x (switch: 🔍 Upscale 2x)", GREEN, SX + SW + GAP, SY, "hires", hires_fn, img,
                note_text="2x upscale with a second sampler pass.\nDenoise is filled by the model preset (0.3).\n"
                          "Upscaler: AnimeSharpV4 (anime-tuned).")
    img = stage("🙂 FACE DETAILER", ORANGE, SX + 2 * (SW + GAP), SY, "face",
                detailer_fn("segm/99coins_anime_girl_face_m_seg.pt", face_widgets(1024, 1024, 0.4), "FaceDetailer (face)"),
                img)
    img = stage("✋ HAND DETAILER", ORANGE, SX, SY + SH + GAP, "hands",
                detailer_fn("segm/PitHandDetailer-v2-Test-v9c.pt", face_widgets(768, 1024, 0.4, threshold=0.4), "FaceDetailer (hands)"),
                img)
    img = stage("👄 MOUTH DETAILER", ORANGE, SX + SW + GAP, SY + SH + GAP, "mouth",
                detailer_fn("segm/adetailer2dMouth_v10.pt", face_widgets(512, 768, 0.35, crop=4.0), "FaceDetailer (mouth)"),
                img)
    img = stage("💎 ULTRA 4x TOTAL (switch: 💎 Ultra)", CYAN, SX + 2 * (SW + GAP), SY + SH + GAP, "ultra",
                lambda gw, im, x, y: hires_fn(gw, im, x, y, ultra=True), img,
                note_text="Another 2x on top, done in 1024px tiles so it fits in VRAM.\n"
                          "With Upscale 2x on: 896x1152 -> 3584x4608.")

    # ---------------------------------------------------------- SAVE
    FX, FY = SX, SY + 2 * (SH + GAP)
    w.group("💾 FINAL", FX, FY, 3 * SW + 2 * GAP, 1160, PINK)
    save = w.node("SaveImage", [FX + 20, FY + 60], [1000, 1020], ["Waifu/%date:yyyy-MM-dd%/waifu"],
                  inputs=[("images", "IMAGE")], outputs=[], title="💾 SAVED IMAGE (final)")
    w.link(img[0], img[1], save, "images")
    allcmp = w.node("Image Comparer (rgthree)", [FX + 1040, FY + 60], [1960, 1020], [],
                    inputs=[("image_a", "IMAGE"), ("image_b", "IMAGE")], outputs=[], props={"comparer_mode": "Slide"},
                    title="🔀 preview vs final (whole chain)")
    guard = w.node("WaifuCompareGuard", [FX + 1040, FY + 1130], [200, 80], inputs=[("before", "IMAGE"), ("after", "IMAGE")],
                   outputs=[("before", "IMAGE"), ("after", "IMAGE")], collapsed=True)
    w.link(src, "image", guard, "before")
    w.link(img[0], img[1], guard, "after")
    w.link(guard, "before", allcmp, "image_a")
    w.link(guard, "after", allcmp, "image_b")

    return {
        "id": "7a1f7d3e-6f2b-4d55-9c3e-5a1f00d1e001",
        "revision": 0,
        "last_node_id": w.nid,
        "last_link_id": w.lid,
        "nodes": w.nodes,
        "links": w.links,
        "groups": w.groups,
        "config": {},
        "extra": {"ds": {"scale": 0.45, "offset": [60, 120]}},
        "version": 0.4,
    }


if __name__ == "__main__":
    wf = build()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(wf, f, indent=1, ensure_ascii=False)
    print(f"wrote {OUT}: {len(wf['nodes'])} nodes, {len(wf['links'])} links")
