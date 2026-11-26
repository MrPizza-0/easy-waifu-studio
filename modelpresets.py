"""Model presets for the phone UI: the Civitai checkpoint importer, and saving, deleting and resetting presets.

User changes go to ComfyUI/user/waifu_studio/models.json (and downloads.json for the model file sources);
the shipped presets/models.json is never modified, so 'Reset' can always bring a shipped preset back."""
import re
import urllib.parse

from aiohttp import web
from server import PromptServer

from .characters import _desc_lines, _get, _image, _user, add_downloads, delete_character, reset_character, save_character, shipped
from .downloads import start_downloads, state as download_state
from .nodes import PRESETS, _read

FILE = "models.json"
KEEP = ("checkpoint", "clip_skip", "unet", "text_encoder", "vae", "shift", "positive", "negative", "sampler", "scheduler",
        "steps", "cfg", "hires_denoise", "hires_scale", "canvas", "quality_loras")


def vpred(*texts):
    return any(re.search(r"v[\s_-]?pred", t or "", re.I) for t in texts)


def model_family(base, *names):
    """Which loader kind a Civitai checkpoint needs, or None if Waifu Studio can't run it."""
    b = (base or "").lower()
    if vpred(*names):
        return None  # v-prediction models need a sampling patch the loader doesn't have
    if "anima" in b:
        return "anima"
    if "illustrious" in b or "noob" in b or b.startswith("sdxl"):
        return "illustrious"
    return None  # Pony, SD 1.5, Flux, video models...


def template(fam):
    """The shipped preset of that kind: its values fill whatever the Civitai page doesn't say."""
    for name, m in _read(f"{PRESETS}/{FILE}").items():
        if not name.startswith("_") and isinstance(m, dict) and bool(m.get("unet")) == (fam == "anima"):
            return dict(m)
    return {}


SAMPLERS = [  # A1111 / Civitai names -> ComfyUI names, longest first
    ("dpm++ 2m sde gpu", "dpmpp_2m_sde_gpu"), ("dpm++ 3m sde", "dpmpp_3m_sde"), ("dpm++ 2m sde", "dpmpp_2m_sde"),
    ("dpm++ 2s a", "dpmpp_2s_ancestral"), ("dpm++ 2m", "dpmpp_2m"), ("dpm++ sde", "dpmpp_sde"), ("dpm2 a", "dpm_2_ancestral"),
    ("dpm2", "dpm_2"), ("euler a", "euler_ancestral"), ("euler_a", "euler_ancestral"), ("euler ancestral", "euler_ancestral"),
    ("euler", "euler"), ("heun", "heun"), ("ddim", "ddim"), ("unipc", "uni_pc"), ("lcm", "lcm"), ("lms", "lms"),
]
SCHEDULERS = [("sgm uniform", "sgm_uniform"), ("sgm_uniform", "sgm_uniform"), ("karras", "karras"), ("exponential", "exponential"),
              ("beta", "beta"), ("simple", "simple"), ("normal", "normal"), ("ddim uniform", "ddim_uniform")]
LABELS = r"(?:sampler|sampling method|schedule(?:r| type)?|steps|sampling steps|cfg(?: scale)?|guidance|clip ?skip|hires|high ?res|denois\w*|upscal\w*|vae|resolution|size|positive(?: prompt)?|prompts?|negative(?: prompts?)?|quality tags?)"


def _num(text, kind=float):
    """'20~30' -> 25, '4~6' -> 5.0, '3 (2.5-6)' -> 3.0: the first number, or the middle of the first range."""
    m = re.match(r"\D{0,12}?(\d+(?:\.\d+)?)(?:\s*(?:~|-|–|to)\s*(\d+(?:\.\d+)?))?", text)
    if not m:
        return None
    a = float(m.group(1)); b = float(m.group(2)) if m.group(2) else a
    return int(round((a + b) / 2)) if kind is int else round((a + b) / 2 * 2) / 2


def _first(text, table):
    """The alias that appears first in the text ('Euler a OR DPM++ 2M' -> euler_ancestral)."""
    low = text.lower()
    hits = [(low.find(a), -len(a), c) for a, c in table if a in low]
    return min(hits)[2] if hits else None


def settings_from_text(lines):
    """Read 'Recommended settings' that creators write in the description:
    'Sampler: Euler a Normal', 'Steps: 20~30', 'CFG Scale: 4~6', 'Clip Skip: 2', 'Prompt: ...', 'Negative Prompts: ...'."""
    text = "\n".join(lines)
    out = {}

    def value(label):
        m = re.search(r"(?:^|[\s,;(])(?<!negative )" + label + r"[ \t]*[:：=][ \t]*(.+?)(?=\s*(?:[,;]\s*)?\b" + LABELS + r"\s*[:：=]|\n|$)", text, re.I)
        return m.group(1).strip(" ,;") if m else None

    v = value(r"(?:sampler|sampling method)")
    if v:
        low = v.lower()
        out["sampler"] = _first(low, SAMPLERS)
        sch = _first(low, SCHEDULERS)
        if sch:
            out["scheduler"] = sch
    v = value(r"schedule(?:r| type)?")
    if v:
        out["scheduler"] = _first(v, SCHEDULERS) or out.get("scheduler")
    v = value(r"(?:sampling )?steps")
    if v and _num(v, int):
        out["steps"] = max(8, min(60, _num(v, int)))
    v = value(r"(?:cfg(?: scale)?|guidance)")
    if v and _num(v):
        out["cfg"] = max(1.0, min(15.0, _num(v)))
    v = value(r"clip ?skip")
    if v and _num(v, int):
        out["clip_skip"] = -max(1, min(4, _num(v, int)))

    def tidy(v):
        """Drop 'BREAK' (A1111 only) and placeholders like {prompt}, then fix the commas."""
        v = re.sub(r"\bBREAK\b|\{[^}]*\}|\[[^\]]*prompt[^\]]*\]|<[^>]*prompt[^>]*>", "", v)
        v = re.sub(r"\s*,\s*(,\s*)*", ", ", v).strip(" ,")
        return v + "," if v else None

    v = value(r"negative(?: prompts?)?")
    if v and len(v) > 8:
        out["negative"] = tidy(v)
    v = value(r"(?:positive(?: prompt)?|prompts?|quality tags?)")
    if v and len(v) > 8:
        out["positive"] = tidy(v)
    return {k: v for k, v in out.items() if v is not None}


def _file(version):
    """The model file of a version: a .safetensors 'Model' file, fp16/pruned when there are several."""
    files = [f for f in version.get("files", []) if f.get("type") == "Model" and f["name"].lower().endswith(".safetensors")]
    score = lambda f: (((f.get("metadata") or {}).get("fp") == "fp16") + ((f.get("metadata") or {}).get("size") == "pruned"), -f.get("sizeKB", 0))
    return max(files, key=score) if files else None


def model_draft(model):
    lines = _desc_lines(model)
    name = re.sub(r"\s{2,}", " ", re.sub(r"\[[^\]]*\]|\((?:checkpoint|illustrious|sdxl|anima)[^)]*\)", " ", model["name"], flags=re.I)).strip(" -|")
    versions, skipped = [], []
    for v in model.get("modelVersions", []):
        f = _file(v)
        fam = model_family(v.get("baseModel"), model["name"], v["name"], f["name"] if f else "")
        if not fam:
            skipped.append(f"{v['name']} ({'v-pred' if vpred(model['name'], v['name']) else v.get('baseModel')})")
            continue
        if not f:
            skipped.append(f"{v['name']} (no .safetensors file)")
            continue
        t = template(fam)
        vlines = _desc_lines({"description": v.get("description")})
        found = {**settings_from_text(lines), **settings_from_text(vlines)}
        data = {k: t[k] for k in KEEP if k in t}
        data["quality_loras"] = []
        if fam == "anima":
            data["unet"] = f["name"]
            data.pop("clip_skip", None)
            found.pop("clip_skip", None)
        else:
            data["checkpoint"] = f["name"]
        data.update(found)
        key = ("diffusion_models/" if fam == "anima" else "checkpoints/") + f["name"]
        versions.append({
            "id": v["id"], "version": v["name"], "family": fam, "file": f["name"], "sizeMB": round(f.get("sizeKB", 0) / 1024),
            "name": f"{name} {v['name']}".strip(), "image": _image(v), "data": data, "found": sorted(found),
            "download": {key: {"civitai": v["id"], "page": f"https://civitai.com/models/{model['id']}?modelVersionId={v['id']}",
                               "name": f"{model['name']} {v['name']}", "sizeMB": round(f.get("sizeKB", 0) / 1024),
                               "sha256": ((f.get("hashes") or {}).get("SHA256") or "").lower()}},
        })
    return {"name": name, "image": _image(model), "versions": versions, "skipped": skipped,
            "page": f"https://civitai.com/models/{model['id']}"}


def clean(data):
    return {k: v for k, v in data.items() if k in KEEP}


# ------------------------------------------------------------------ routes
def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/waifu/m/api/civitai/model-search")
    async def search(request):
        from .characters import parse_ref
        q = request.query.get("q", "").strip()
        mid = parse_ref(q)
        if mid:
            return web.json_response({"model_id": mid})
        params = {"query": q, "types": "Checkpoint", "nsfw": "true", "limit": 30}  # no "sort": it makes Civitai ignore the query
        try:
            d = _get("/models?" + urllib.parse.urlencode(params))
        except Exception as ex:
            return web.json_response({"error": f"Civitai search failed: {ex}"}, status=502)
        out = []
        for m in d.get("items", []):
            vs = m.get("modelVersions", [])
            fams = sorted({model_family(v.get("baseModel"), m["name"], v["name"]) for v in vs} - {None})
            out.append({"id": m["id"], "name": m["name"], "image": _image(m), "downloads": (m.get("stats") or {}).get("downloadCount"),
                        "families": fams, "versions": len(vs)})
        out.sort(key=lambda x: (not x["families"], -(x["downloads"] or 0)))
        return web.json_response({"results": out})

    @routes.get("/waifu/m/api/civitai/model-draft")
    async def draft(request):
        try:
            model = _get(f"/models/{int(request.query['id'])}")
        except Exception as ex:
            return web.json_response({"error": f"Could not read that Civitai page: {ex}"}, status=502)
        if model.get("type") != "Checkpoint":
            return web.json_response({"error": f"That is a {model.get('type')}, not a checkpoint model."}, status=400)
        return web.json_response(model_draft(model))

    @routes.get("/waifu/m/api/model/info")
    async def info(request):
        user = _user(FILE)
        return web.json_response({"shipped": sorted(shipped(FILE)), "edited": sorted(k for k in user if not k.startswith("_"))})

    @routes.post("/waifu/m/api/model/save")
    async def save(request):
        """{name, data, old_name?, downloads?, download?}"""
        b = await request.json()
        name = (b.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "Name is missing."}, status=400)
        data = clean(b.get("data") or {})
        if not (data.get("checkpoint") or data.get("unet")):
            return web.json_response({"error": "Pick a model file."}, status=400)
        if data.get("unet"):
            data.pop("checkpoint", None)
            data.pop("clip_skip", None)
            t = template("anima")
            for k in ("text_encoder", "vae", "shift"):
                if not data.get(k) and k in t:
                    data[k] = t[k]
        else:
            for k in ("unet", "text_encoder", "vae", "shift"):
                data.pop(k, None)
        save_character(name, data, b.get("old_name"), file=FILE)
        downloads = b.get("downloads") or {}
        if downloads:
            add_downloads(downloads)
        if b.get("download") and downloads:
            start_downloads(list(downloads))
        return web.json_response({"ok": True, "name": name, "download": download_state})

    @routes.post("/waifu/m/api/model/delete")
    async def delete(request):
        from .nodes import _model_presets
        name = (await request.json())["name"]
        if len([k for k in _model_presets() if k != name]) < 1:
            return web.json_response({"error": "This is the last model preset, so it can't be deleted."}, status=400)
        delete_character(name, file=FILE)
        return web.json_response({"ok": True})

    @routes.post("/waifu/m/api/model/reset")
    async def reset(request):
        reset_character((await request.json())["name"], file=FILE)
        return web.json_response({"ok": True})
