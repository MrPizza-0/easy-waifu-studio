"""'Download missing models': finds the files the presets and the workflow need, and downloads
the missing ones from the sources in presets/downloads.json. Only runs when the user asks."""
import hashlib
import json
import os
import threading
import time
import urllib.error
import urllib.request
import zipfile

import folder_paths
from aiohttp import web
from server import PromptServer

from . import build_workflow
from .nodes import _load

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = os.path.join(folder_paths.get_user_directory(), "waifu_studio.json")
norm = lambda p: str(p).replace("\\", "/")


def load_config():
    try:
        with open(CONFIG, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, json.JSONDecodeError):
        return {}


def civitai_key():
    return os.environ.get("CIVITAI_API_KEY") or load_config().get("civitai_key") or ""


def target(key):
    """'loras/sub/x.safetensors' -> absolute path in the first folder ComfyUI uses for that kind."""
    kind, _, rest = norm(key).partition("/")
    base = os.path.join(folder_paths.models_dir, "ultralytics") if kind == "ultralytics" else folder_paths.get_folder_paths(kind)[0]
    base = os.path.abspath(base)
    full = os.path.abspath(os.path.join(base, rest))
    if os.path.commonpath((base, full)) != base:
        raise ValueError(f"bad path: {key}")
    return full


def present(key):
    kind, _, rest = norm(key).partition("/")
    if kind == "ultralytics":
        return os.path.exists(target(key))
    return folder_paths.get_full_path(kind, rest) is not None or folder_paths.get_full_path(kind, rest.replace("/", os.sep)) is not None


def needed():
    """{key: [what uses it]} for every file the presets and the workflow need."""
    need = {}
    add = lambda key, who: need.setdefault(norm(key), []).append(who)
    for name, m in _load("models.json").items():
        who = f"model: {name}"
        if m.get("unet"):
            add("diffusion_models/" + m["unet"], who)
            if m.get("text_encoder"):
                add("text_encoders/" + m["text_encoder"], who)
            if m.get("vae"):
                add("vae/" + m["vae"], who)
        elif m.get("checkpoint"):
            add("checkpoints/" + m["checkpoint"], who)
        for n, _ in m.get("quality_loras") or []:
            add("loras/" + n, who)
    for name, s in _load("styles.json").items():
        for n, _ in s.get("loras") or []:
            add("loras/" + n, f"style: {name}")
    for name, c in _load("characters.json").items():
        if not isinstance(c, dict):
            continue
        for n, _ in c.get("loras") or []:
            add("loras/" + n, f"character: {name}")
        for oname, o in (c.get("outfits") or {}).items():
            for fam, b in o.items():
                for n, _ in b.get("loras") or []:
                    add("loras/" + n, f"character: {name} / {oname} / {fam}")
    for key, src in _load("downloads.json").items():
        if src.get("required"):
            add(key, "workflow (upscaler / detailers)")
    return need


state = {"running": False, "queue": [], "current": None, "bytes": 0, "total": 0, "done": [], "failed": []}
_lock = threading.Lock()


def _fetch(key, src):
    out = target(key)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    part = out + ".part"
    if src.get("civitai"):
        url = f"https://civitai.com/api/download/models/{src['civitai']}"
        headers = {"Authorization": f"Bearer {civitai_key()}"} if civitai_key() else {}
    else:
        url, headers = src["url"], {}
    headers["User-Agent"] = "comfyui-waifu-studio"
    h = hashlib.sha256()
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=120) as r, open(part, "wb") as f:
        state["total"] = int(r.headers.get("Content-Length") or 0)
        state["bytes"] = 0
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)
            h.update(b)
            state["bytes"] += len(b)
    if src.get("zip"):
        with zipfile.ZipFile(part) as z:
            name = os.path.basename(out)
            members = [m for m in z.namelist() if not m.endswith("/")]
            member = next((m for m in members if os.path.basename(m) == name), None) or next(m for m in members if m.endswith(os.path.splitext(name)[1]))
            with z.open(member) as src_f, open(out, "wb") as dst:
                dst.write(src_f.read())
        os.remove(part)
        return
    if src.get("sha256") and h.hexdigest() != src["sha256"].lower():
        os.remove(part)
        raise RuntimeError("download does not match the expected file (sha256)")
    os.replace(part, out)


def _worker():
    sources = _load("downloads.json")
    while True:
        with _lock:
            if not state["queue"]:
                state.update(running=False, current=None)
                return
            key = state["queue"].pop(0)
            state["current"] = key
        src = sources.get(key)
        if not src:
            state["failed"].append({"key": key, "error": "no download source in presets/downloads.json"})
            continue
        for attempt in range(5):
            try:
                _fetch(key, src)
                state["done"].append(key)
                break
            except urllib.error.HTTPError as e:
                if e.code == 401:
                    state["failed"].append({"key": key, "error": "Civitai needs your API key for this file (Models & downloads > Civitai API key)"})
                    break
                if e.code == 429 and attempt < 4:  # Civitai rate limit
                    time.sleep(30 * (attempt + 1))
                    continue
                state["failed"].append({"key": key, "error": f"HTTP {e.code}"})
                break
            except Exception as e:
                state["failed"].append({"key": key, "error": str(e)})
                break


def start_downloads(keys):
    with _lock:
        for k in keys:
            k = norm(k)
            if k not in state["queue"] and k != state["current"] and not present(k):
                state["queue"].append(k)
        if not state["running"] and state["queue"]:
            state.update(running=True, done=[], failed=[])
            threading.Thread(target=_worker, daemon=True, name="waifu_download").start()


def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/waifu/m/api/models")
    async def models(request):
        sources = _load("downloads.json")
        items = []
        for key, used in sorted(needed().items()):
            src = sources.get(key) or {}
            items.append({"key": key, "present": present(key), "used_by": used, "name": src.get("name", ""),
                          "page": src.get("page", ""), "sizeMB": src.get("sizeMB"), "downloadable": bool(src)})
        return web.json_response({"items": items, "key_set": bool(civitai_key()), "download": state})

    @routes.post("/waifu/m/api/models/download")
    async def download(request):
        start_downloads((await request.json()).get("keys", []))
        return web.json_response(state)

    @routes.get("/waifu/m/api/models/download")
    async def download_state(request):
        return web.json_response(state)

    @routes.get("/waifu/m/api/default-workflow")
    async def default_workflow(request):
        return web.json_response(build_workflow.build())

    @routes.post("/waifu/m/api/config")
    async def config(request):
        body = await request.json()
        cfg = load_config()
        if "civitai_key" in body:
            cfg["civitai_key"] = str(body["civitai_key"]).strip()
        if body.get("old_preset_loras") in ("remove", "off"):
            cfg["old_preset_loras"] = body["old_preset_loras"]
        os.makedirs(os.path.dirname(CONFIG), exist_ok=True)
        with open(CONFIG, "w", encoding="utf-8") as f:
            json.dump(cfg, f, indent=1)
        return web.json_response({"key_set": bool(civitai_key())})
