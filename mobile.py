"""Waifu Studio Mobile - phone UI served by ComfyUI at /waifu/m

Everything here is read-mostly helpers for the phone app in ./mobile:
gallery listing, thumbnails, PNG metadata, prompt search index, favorites,
trash (move, never delete), inpaint mask compositing, tag autocomplete, node info.
Generation itself goes through ComfyUI's own /prompt, /queue and /ws.
"""
import asyncio
import hashlib
import io
import json
import os
import shutil
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

import folder_paths
import nodes as comfy_nodes
from aiohttp import web
from PIL import Image, ImageOps
from PIL.PngImagePlugin import PngInfo
from server import PromptServer

HERE = os.path.dirname(os.path.abspath(__file__))
STATIC = os.path.join(HERE, "mobile")
CACHE = os.path.join(HERE, ".cache")
THUMBS = os.path.join(CACHE, "thumbs")
DATA = os.path.join(HERE, "data")
FAVS = os.path.join(DATA, "mobile_favorites.json")
INDEX_DB = os.path.join(CACHE, "search_index.sqlite")
TRASH = "_trash"
IMG_EXT = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
VID_EXT = {".mp4", ".webm", ".mov"}
ALL_EXT = IMG_EXT | VID_EXT

os.makedirs(THUMBS, exist_ok=True)
POOL = ThreadPoolExecutor(max_workers=4, thread_name_prefix="waifu_m")


def out_dir():
    return os.path.abspath(folder_paths.get_output_directory())


def safe_path(rel, base=None):
    """Resolve a relative path inside the output dir (or base). Returns None if it escapes."""
    base = base or out_dir()
    rel = (rel or "").replace("\\", "/").strip("/")
    full = os.path.abspath(os.path.join(base, rel))
    if os.path.commonpath((base, full)) != base:
        return None
    return full


def annotated_path(name):
    """'sub/x.png [output]' / 'x.png [input]' / 'x.png' (input) -> absolute path or None."""
    name = (name or "").strip()
    base = folder_paths.get_input_directory()
    for tag, d in (("[output]", folder_paths.get_output_directory()), ("[input]", folder_paths.get_input_directory()),
                   ("[temp]", folder_paths.get_temp_directory())):
        if name.endswith(tag):
            name, base = name[: -len(tag)].strip(), d
            break
    return safe_path(name, os.path.abspath(base))


def rel(full):
    return os.path.relpath(full, out_dir()).replace("\\", "/")


# ------------------------------------------------------------------ directory cache
_dir_cache = {}
_dir_lock = threading.Lock()


def list_dir(full):
    """(files [(rel, mtime, size)], subdirs [name]) for one folder, cached by folder mtime."""
    try:
        mt = os.stat(full).st_mtime_ns
    except OSError:
        return [], []
    with _dir_lock:
        hit = _dir_cache.get(full)
        if hit and hit[0] == mt:
            return hit[1], hit[2]
    files, dirs = [], []
    base = out_dir()
    try:
        with os.scandir(full) as it:
            for e in it:
                try:
                    if e.is_dir():
                        if e.name != TRASH and not e.name.startswith("."):
                            dirs.append(e.name)
                    elif os.path.splitext(e.name)[1].lower() in ALL_EXT:
                        st = e.stat()
                        files.append((os.path.relpath(e.path, base).replace("\\", "/"), int(st.st_mtime), st.st_size))
                except OSError:
                    pass
    except OSError:
        pass
    files.sort(key=lambda f: -f[1])
    dirs.sort()
    with _dir_lock:
        _dir_cache[full] = (mt, files, dirs)
    return files, dirs


def walk(full):
    files, dirs = list_dir(full)
    out = list(files)
    for d in dirs:
        out.extend(walk(os.path.join(full, d)))
    return out


def folder_entry(full):
    files, dirs = list_dir(full)
    cover = files[0] if files else None
    if cover is None:
        for d in dirs[::-1]:
            f2, _ = list_dir(os.path.join(full, d))
            if f2:
                cover = f2[0]
                break
    return {"name": os.path.basename(full), "path": rel(full), "count": len(files), "dirs": len(dirs),
            "mtime": cover[1] if cover else int(os.stat(full).st_mtime), "cover": cover[0] if cover else None,
            "cover_m": cover[1] if cover else 0}


# ------------------------------------------------------------------ favorites
_fav_lock = threading.Lock()


def load_favs():
    try:
        with open(FAVS, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_favs(favs):
    tmp = FAVS + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(favs, f, indent=0)
    os.replace(tmp, FAVS)


# ------------------------------------------------------------------ thumbnails
def _thumb_key(full, size, mode):
    st = os.stat(full)
    h = hashlib.sha1(f"{full}|{st.st_mtime_ns}|{st.st_size}|{size}|{mode}".encode()).hexdigest()
    return os.path.join(THUMBS, h[:2], h + ".webp")


def make_thumb(full, size, mode="fit"):
    path = _thumb_key(full, size, mode)
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with Image.open(full) as im:
        if im.format == "JPEG":
            im.draft("RGB", (size, size))
        im = ImageOps.exif_transpose(im)
        if getattr(im, "n_frames", 1) > 1:
            im.seek(0)
        # alpha is dropped on purpose: inpaint sources keep their colours under the (transparent) mask
        im = im.convert("RGB")
        im.thumbnail((size, size * 2 if mode == "fit" else size), Image.LANCZOS)
        tmp = path + f".{threading.get_ident()}.tmp"
        im.save(tmp, "WEBP", quality=82 if size <= 640 else 88, method=4)
        os.replace(tmp, path)
    return path


REMOTE_HOSTS = {"safebooru.org", "image.civitai.com", "files.yande.re", "konachan.net"}


def remote_thumb(url, size):
    h = hashlib.sha1(f"{url}|{size}".encode()).hexdigest()
    path = os.path.join(CACHE, "remote", h[:2], h + ".webp")
    if os.path.exists(path):
        return path
    os.makedirs(os.path.dirname(path), exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "comfyui-waifu-studio", "Referer": url})
    with urllib.request.urlopen(req, timeout=30) as r:
        data = r.read(30 << 20)
    with Image.open(io.BytesIO(data)) as im:
        im = im.convert("RGB")
        im.thumbnail((size, size * 2), Image.LANCZOS)
        tmp = path + f".{threading.get_ident()}.tmp"
        im.save(tmp, "WEBP", quality=85)
        os.replace(tmp, path)
    return path


# ------------------------------------------------------------------ metadata
def _read_info(full):
    with Image.open(full) as im:
        info = dict(im.info)
        return im.size, info


def _s(v):
    return v if isinstance(v, str) else ""


def summarize(prompt):
    """Readable settings from an API-format prompt (Waifu Studio aware, generic fallback)."""
    if not isinstance(prompt, dict):
        return {"waifu": False, "rows": [], "positive": "", "negative": ""}
    by = {}
    for nid, n in prompt.items():
        if isinstance(n, dict):
            by.setdefault(n.get("class_type"), []).append((nid, n))
    rows = []
    pos = neg = ""

    def first(t):
        return by.get(t, [(None, None)])[0][1]

    def title(n):
        return ((n or {}).get("_meta") or {}).get("title") or ""

    waifu = "WaifuText" in by
    if waifu:
        t = first("WaifuText")["inputs"]
        pos = ", ".join(x.strip().strip(",") for x in (_s(t.get("base")), _s(t.get("character")),
                                                     _s(t.get("lora_triggers")), _s(t.get("scene"))) if x.strip())
        neg = _s(t.get("negative"))
        rows.append(("scene", _s(t.get("scene"))))
        p = first("WaifuPresets")
        if p:
            i = p["inputs"]
            rows += [("model preset", i.get("model_preset")), ("character", i.get("character")), ("style", i.get("art_style"))]
        m = first("WaifuMode")
        if m:
            rows.append(("mode", m["inputs"].get("mode")))
        on = [title(n) for _, n in by.get("WaifuSwitch", []) if n["inputs"].get("on") is True]
        rows.append(("stages", ", ".join(on) or "preview only"))
    sd = first("Seed (rgthree)")
    if sd:
        rows.append(("seed", sd["inputs"].get("seed")))
    s = first("WaifuSettings")
    if s:
        i = s["inputs"]
        rows.append(("sampler", f"{i.get('steps')} steps · cfg {i.get('cfg')} · {i.get('sampler_name')} / {i.get('scheduler')}"))
    ld = first("WaifuLoader")
    if ld:
        i = ld["inputs"]
        rows.append(("model", i.get("unet") if str(i.get("kind", "")).startswith("Anima") else i.get("checkpoint")))
    c = first("WaifuCanvas")
    if c:
        i = c["inputs"]
        rows.append(("canvas", f"{i.get('size')} · batch {i.get('batch')}"))
    for _, n in by.get("Power Lora Loader (rgthree)", []):
        for k, v in n["inputs"].items():
            if k.startswith("lora_") and isinstance(v, dict) and v.get("on"):
                rows.append(("lora", f"{os.path.splitext(os.path.basename(str(v.get('lora'))))[0]} @ {v.get('strength')}"))
    if not waifu:  # generic workflows
        for t in ("CheckpointLoaderSimple", "UNETLoader", "CheckpointLoader|pysssss"):
            for _, n in by.get(t, []):
                rows.append(("model", n["inputs"].get("ckpt_name") or n["inputs"].get("unet_name")))
        for _, n in by.get("LoraLoader", []):
            rows.append(("lora", f"{n['inputs'].get('lora_name')} @ {n['inputs'].get('strength_model')}"))
        for t in ("KSampler", "KSamplerAdvanced", "KSampler (Efficient)"):
            for _, n in by.get(t, []):
                i = n["inputs"]
                rows.append(("sampler", f"seed {i.get('seed', i.get('noise_seed'))} · {i.get('steps')} steps · cfg {i.get('cfg')} · {i.get('sampler_name')}"))
        texts = []
        for t in ("CLIPTextEncode", "CLIPTextEncodeSDXL", "ShowText|pysssss"):
            for _, n in by.get(t, []):
                v = n["inputs"].get("text") or n["inputs"].get("text_g")
                if isinstance(v, str) and v.strip():
                    texts.append((title(n), v))
        if texts:
            pos = texts[0][1]
            negs = [v for ti, v in texts if "neg" in ti.lower()]
            neg = negs[0] if negs else (texts[1][1] if len(texts) > 1 else "")
    return {"waifu": waifu, "rows": [{"k": k, "v": v} for k, v in rows if v not in (None, "")],
            "positive": pos, "negative": neg}


def index_text(info):
    """Lower-case text used for search: every string input of the prompt."""
    out = []
    try:
        prompt = json.loads(info.get("prompt") or "null")
    except Exception:
        prompt = None
    if isinstance(prompt, dict):
        for n in prompt.values():
            if not isinstance(n, dict):
                continue
            for k, v in (n.get("inputs") or {}).items():
                if isinstance(v, str) and len(v) < 4000:
                    out.append(v)
                elif isinstance(v, dict) and v.get("on") and v.get("lora"):
                    out.append(str(v["lora"]))
    else:
        for k in ("parameters", "Description", "Comment"):
            if isinstance(info.get(k), str):
                out.append(info[k])
    return " ".join(out).lower().replace("_", " ")


# ------------------------------------------------------------------ search index (background)
class Indexer:
    def __init__(self):
        self.lock = threading.Lock()
        self.db = sqlite3.connect(INDEX_DB, check_same_thread=False)
        self.db.execute("CREATE TABLE IF NOT EXISTS img (path TEXT PRIMARY KEY, mtime INTEGER, text TEXT)")
        self.db.commit()
        self.state = {"running": False, "done": 0, "total": 0}
        self.wake = threading.Event()
        threading.Thread(target=self.loop, daemon=True, name="waifu_m_index").start()

    def loop(self):
        while True:
            try:
                self.run_once()
            except Exception as ex:
                print(f"[waifu_studio mobile] index error: {ex}")
            self.wake.wait(600)
            self.wake.clear()

    def run_once(self):
        base = out_dir()
        files = walk(base)
        # Waifu Studio images first, newest first
        files.sort(key=lambda f: (not f[0].startswith("Waifu/"), -f[1]))
        with self.lock:
            known = dict(self.db.execute("SELECT path, mtime FROM img").fetchall())
        todo = [f for f in files if known.get(f[0]) != f[1] and f[0].lower().endswith(".png")]
        self.state = {"running": True, "done": 0, "total": len(todo)}
        batch = []
        for i, (r, m, _) in enumerate(todo):
            try:
                _, info = _read_info(os.path.join(base, r))
                batch.append((r, m, index_text(info)))
            except Exception:
                batch.append((r, m, ""))
            if len(batch) >= 200:
                self.flush(batch)
                batch = []
            self.state["done"] = i + 1
        self.flush(batch)
        # warm the grid thumbnails of the newest images so browsing is instant
        self.state["thumbs"] = 0
        for r, m, _ in sorted(files, key=lambda f: -f[1])[:3000]:
            if os.path.splitext(r)[1].lower() not in IMG_EXT:
                continue
            try:
                full = os.path.join(base, r)
                if not os.path.exists(_thumb_key(full, 420, "fit")):
                    make_thumb(full, 420, "fit")
                    self.state["thumbs"] += 1
            except Exception:
                pass
        alive = {f[0] for f in files}
        with self.lock:
            gone = [p for p in known if p not in alive]
            self.db.executemany("DELETE FROM img WHERE path=?", [(p,) for p in gone])
            self.db.commit()
        self.state["running"] = False

    def flush(self, batch):
        if not batch:
            return
        with self.lock:
            self.db.executemany("INSERT OR REPLACE INTO img VALUES (?,?,?)", batch)
            self.db.commit()

    def add(self, r, m, text):
        self.flush([(r, m, text)])

    def search(self, q, prefix="", limit=120, offset=0):
        words = [w for w in q.lower().replace("_", " ").split() if w]
        sql, args = "SELECT path, mtime FROM img WHERE 1=1", []
        for w in words:
            neg = w.startswith("-") and len(w) > 1
            sql += " AND text NOT LIKE ?" if neg else " AND (text LIKE ? OR lower(path) LIKE ?)"
            if neg:
                args.append(f"%{w[1:]}%")
            else:
                args += [f"%{w}%", f"%{w}%"]
        if prefix:
            sql += " AND path LIKE ?"
            args.append(prefix.rstrip("/") + "/%")
        with self.lock:
            total = self.db.execute(sql.replace("path, mtime", "count(*)", 1), args).fetchone()[0]
            rows = self.db.execute(sql + " ORDER BY mtime DESC LIMIT ? OFFSET ?", args + [limit, offset]).fetchall()
        return total, rows


_indexer = None


def indexer():
    global _indexer
    if _indexer is None:
        _indexer = Indexer()
    return _indexer


# ------------------------------------------------------------------ node info (same shape as /object_info)
def node_info(cls_name):
    from comfy_api.internal import _ComfyNodeInternal
    obj = comfy_nodes.NODE_CLASS_MAPPINGS[cls_name]
    if issubclass(obj, _ComfyNodeInternal):
        return obj.GET_NODE_INFO_V1()
    it = obj.INPUT_TYPES()
    return {
        "input": it,
        "input_order": {k: list(v.keys()) for k, v in it.items()},
        "output": obj.RETURN_TYPES,
        "output_name": getattr(obj, "RETURN_NAMES", obj.RETURN_TYPES),
        "name": cls_name,
        "display_name": comfy_nodes.NODE_DISPLAY_NAME_MAPPINGS.get(cls_name, cls_name),
        "output_node": bool(getattr(obj, "OUTPUT_NODE", False)),
    }


# ------------------------------------------------------------------ tags (danbooru autocomplete list from pysssss)
_tags = None


def load_tags():
    global _tags
    if _tags is None:
        # pysssss' full list if it is installed (either folder name), else the 20,000 most common tags shipped here
        candidates = [os.path.join(HERE, "..", d, "user", "autocomplete.txt") for d in ("ComfyUI-Custom-Scripts", "comfyui-custom-scripts")]
        candidates.append(os.path.join(HERE, "data", "common_tags.txt"))
        lines = []
        for path in candidates:
            if not os.path.isfile(path):
                continue
            with open(path, encoding="utf-8") as f:
                for i, line in enumerate(f):
                    if i >= 60000:
                        break
                    line = line.strip()
                    if line:
                        lines.append(line)
            break
        _tags = "\n".join(lines)
    return _tags


# ------------------------------------------------------------------ routes
def register_routes():
    routes = PromptServer.instance.routes
    loop_run = lambda fn, *a: asyncio.get_running_loop().run_in_executor(POOL, fn, *a)

    def nocache(resp):
        resp.headers["Cache-Control"] = "no-cache"
        return resp

    @routes.get("/waifu/m")
    async def m_index(request):
        raise web.HTTPFound("/waifu/m/")

    @routes.get("/waifu/m/")
    async def m_index2(request):
        return nocache(web.FileResponse(os.path.join(STATIC, "index.html")))

    @routes.get("/waifu/m/s/{path:.+}")
    async def m_static(request):
        full = safe_path(request.match_info["path"], STATIC)
        if not full or not os.path.isfile(full):
            raise web.HTTPNotFound()
        resp = web.FileResponse(full)
        if full.endswith(".webmanifest"):
            resp.content_type = "application/manifest+json"
        return nocache(resp)

    @routes.get("/waifu/m/sw.js")
    async def m_sw(request):
        resp = web.FileResponse(os.path.join(STATIC, "sw.js"))
        resp.headers["Service-Worker-Allowed"] = "/waifu/m/"
        return nocache(resp)

    @routes.get("/waifu/m/api/info")
    async def m_info(request):
        out = {}
        for t in request.query.get("types", "").split("|"):
            if t in comfy_nodes.NODE_CLASS_MAPPINGS:
                try:
                    out[t] = node_info(t)
                except Exception as ex:
                    print(f"[waifu_studio mobile] node info {t}: {ex}")
        return web.json_response(out)

    @routes.get("/waifu/m/api/loras")
    async def m_loras(request):
        from . import guide
        rows = await loop_run(guide._rows)
        return web.json_response(rows)

    @routes.get("/waifu/m/api/tags")
    async def m_tags(request):
        txt = await loop_run(load_tags)
        resp = web.Response(text=txt, content_type="text/plain")
        resp.headers["Cache-Control"] = "max-age=604800"
        resp.enable_compression()
        return resp

    @routes.get("/waifu/m/api/files")
    async def m_files(request):
        q = request.query
        d = q.get("dir", "")
        offset, limit = int(q.get("offset", 0)), min(int(q.get("limit", 120)), 500)
        view = q.get("view", "folder")
        full = safe_path(d)
        if full is None or not os.path.isdir(full):
            return web.json_response({"error": f"folder not found: {d}"}, status=404)
        favs = load_favs()
        search = q.get("q", "").strip()
        folders = []
        if search:
            ix = indexer()
            if not ix.state["running"]:
                ix.wake.set()  # picks up images made since the last pass
            total, rows = await loop_run(ix.search, search, d, limit, offset)
            files = [(r, m, 0) for r, m in rows]
            return web.json_response({"dir": d, "folders": [], "files": [[f, m, s, f in favs] for f, m, s in files],
                                      "total": total, "offset": offset, "index": ix.state})
        if view == "fav":
            items = []
            for f in favs:
                p = safe_path(f)
                if p and os.path.isfile(p) and (not d or f.startswith(d.rstrip("/") + "/")):
                    items.append((f, int(os.path.getmtime(p)), 0))
            items.sort(key=lambda x: -x[1])
        elif view == "all":
            items = await loop_run(walk, full)
            items.sort(key=lambda x: -x[1])
        else:
            items, dirs = await loop_run(list_dir, full)
            if not items and dirs:  # e.g. Waifu/: no images of its own, show everything in its date folders
                items = sorted(await loop_run(walk, full), key=lambda x: -x[1])
            if offset == 0:
                folders = await loop_run(lambda: [folder_entry(os.path.join(full, x)) for x in dirs])
                folders.sort(key=lambda x: -x["mtime"])
        if q.get("sort") == "old":
            items = items[::-1]
        page = items[offset: offset + limit]
        return web.json_response({"dir": d, "folders": folders, "files": [[f, m, s, f in favs] for f, m, s in page],
                                  "total": len(items), "offset": offset})

    @routes.get("/waifu/m/api/thumb")
    async def m_thumb(request):
        q = request.query
        full = annotated_path(q.get("f", "")) if q.get("a") else safe_path(q.get("f", ""))
        if not full or not os.path.isfile(full):
            raise web.HTTPNotFound()
        size = max(64, min(int(q.get("s", 400)), 2400))
        try:
            path = await loop_run(make_thumb, full, size, "fit")
        except Exception as ex:
            return web.Response(status=500, text=str(ex))
        resp = web.FileResponse(path)
        resp.content_type = "image/webp"
        # Only a versioned URL may be cached forever. ComfyUI reuses a file name after that file is
        # deleted, so an unversioned URL must be re-checked (cheap 304 when nothing changed).
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable" if q.get("v") else "no-cache"
        return resp

    @routes.get("/waifu/m/api/remote")
    async def m_remote(request):
        """Character portraits from Safebooru / Civitai: downloaded once by this PC, shrunk and cached."""
        url = request.query.get("u", "")
        if urllib.parse.urlparse(url).hostname not in REMOTE_HOSTS:
            raise web.HTTPForbidden()
        size = max(64, min(int(request.query.get("s", 450)), 1200))
        try:
            path = await loop_run(remote_thumb, url, size)
        except Exception as ex:
            return web.Response(status=502, text=str(ex))
        resp = web.FileResponse(path)
        resp.content_type = "image/webp"
        resp.headers["Cache-Control"] = "public, max-age=31536000, immutable"
        return resp

    @routes.get("/waifu/m/api/meta")
    async def m_meta(request):
        q = request.query
        full = annotated_path(q.get("f", "")) if q.get("a") else safe_path(q.get("f", ""))
        if not full or not os.path.isfile(full):
            return web.json_response({"error": "not found"}, status=404)
        ext = os.path.splitext(full)[1].lower()
        st = os.stat(full)
        out = {"f": q.get("f"), "size": st.st_size, "mtime": int(st.st_mtime), "video": ext in VID_EXT}
        if ext in VID_EXT:
            return web.json_response(out)
        try:
            (w, h), info = await loop_run(_read_info, full)
        except Exception as ex:
            return web.json_response(dict(out, error=str(ex)))
        prompt = workflow = None
        try:
            prompt = json.loads(info.get("prompt") or "null")
        except Exception:
            pass
        try:
            workflow = json.loads(info.get("workflow") or "null")
        except Exception:
            pass
        out.update(w=w, h=h, has_workflow=isinstance(workflow, dict), has_alpha="transparency" in info,
                   **summarize(prompt))
        if not prompt and isinstance(info.get("parameters"), str):  # A1111-style
            out["positive"] = info["parameters"]
        if q.get("full"):
            out["workflow"] = workflow
            out["prompt"] = prompt
        return web.json_response(out)

    @routes.get("/waifu/m/api/favs")
    async def m_favs_get(request):
        return web.json_response(load_favs())

    @routes.post("/waifu/m/api/favs")
    async def m_favs_set(request):
        body = await request.json()
        with _fav_lock:
            favs = load_favs()
            for f in body.get("add", []):
                favs[f] = int(time.time())
            for f in body.get("remove", []):
                favs.pop(f, None)
            save_favs(favs)
        return web.json_response({"ok": True, "count": len(favs)})

    @routes.post("/waifu/m/api/trash")
    async def m_trash(request):
        """Moves files into <output>/_trash/<same path>. Nothing is deleted."""
        body = await request.json()
        moved = []
        base = out_dir()
        for f in body.get("files", []):
            src = safe_path(f)
            if not src or not os.path.isfile(src) or f.startswith(TRASH + "/"):
                continue
            dst = os.path.join(base, TRASH, f)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            if os.path.exists(dst):
                root, ext = os.path.splitext(dst)
                dst = f"{root}_{int(time.time())}{ext}"
            shutil.move(src, dst)
            moved.append([f, rel(dst)])
        if moved:
            with _fav_lock:
                favs = load_favs()
                if any(m[0] in favs for m in moved):
                    for m in moved:
                        favs.pop(m[0], None)
                    save_favs(favs)
        return web.json_response({"moved": moved})

    @routes.post("/waifu/m/api/restore")
    async def m_restore(request):
        body = await request.json()
        restored = []
        for orig, trashed in body.get("moved", []):
            src, dst = safe_path(trashed), safe_path(orig)
            if src and dst and os.path.isfile(src) and not os.path.exists(dst):
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                shutil.move(src, dst)
                restored.append(orig)
        return web.json_response({"restored": restored})

    @routes.post("/waifu/m/api/mask")
    async def m_mask(request):
        """Composite a painted mask (white = repaint) into the source image's alpha channel and save it
        to input/waifu_mobile/. LoadImage turns transparent pixels into its MASK output."""
        post = await request.post()
        src = annotated_path(post.get("source", ""))
        mask = post.get("mask")
        if not src or not os.path.isfile(src) or mask is None:
            return web.json_response({"error": "source image or mask missing"}, status=400)
        data = mask.file.read()

        def work():
            with Image.open(src) as im:
                meta = PngInfo()
                for k, v in (im.info or {}).items():
                    if isinstance(v, str) and k in ("prompt", "workflow"):
                        meta.add_text(k, v)
                rgba = ImageOps.exif_transpose(im).convert("RGBA")
            m = Image.open(io.BytesIO(data))
            m = (m.getchannel("A") if "A" in m.getbands() and m.mode in ("RGBA", "LA") else m.convert("L"))
            m = m.resize(rgba.size, Image.BILINEAR)
            rgba.putalpha(ImageOps.invert(m))
            folder = os.path.join(folder_paths.get_input_directory(), "waifu_mobile")
            os.makedirs(folder, exist_ok=True)
            name = f"inpaint_{time.strftime('%Y%m%d_%H%M%S')}.png"
            rgba.save(os.path.join(folder, name), compress_level=4, pnginfo=meta)
            return "waifu_mobile/" + name

        name = await loop_run(work)
        return web.json_response({"name": name})

    @routes.get("/waifu/m/api/maskof")
    async def m_maskof(request):
        """The existing mask of an image (white = repaint), or 204 if it has none."""
        src = annotated_path(request.query.get("f", ""))
        if not src or not os.path.isfile(src):
            raise web.HTTPNotFound()

        def work():
            with Image.open(src) as im:
                if "A" not in im.getbands() and "transparency" not in im.info:
                    return None
                a = im.convert("RGBA").getchannel("A")
                if a.getextrema()[0] == 255:
                    return None
                buf = io.BytesIO()
                ImageOps.invert(a).save(buf, "PNG", compress_level=1)
                return buf.getvalue()

        png = await loop_run(work)
        if png is None:
            return web.Response(status=204)
        return web.Response(body=png, content_type="image/png")

    @routes.post("/waifu/m/api/index")
    async def m_reindex(request):
        indexer().wake.set()
        return web.json_response(indexer().state)

    @routes.get("/waifu/m/api/index")
    async def m_index_state(request):
        return web.json_response(indexer().state)

    # start indexing in the background once the server is up
    threading.Timer(20, indexer).start()
