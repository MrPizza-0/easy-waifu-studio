"""LoRA trigger-word database.

Sources, in priority order:
  1. presets/my_triggers.json   - your own overrides (always wins)
  2. Civitai trained words       - looked up by file hash
  3. Training tags inside the file (ss_tag_frequency) - shown as hints only
"""
import collections
import hashlib
import json
import os
import struct
import threading
import time
import urllib.error
import urllib.request

import folder_paths

HERE = os.path.dirname(os.path.abspath(__file__))
DB_PATH = os.path.join(HERE, "data", "lora_info.json")
MY_TRIGGERS = os.path.join(HERE, "presets", "my_triggers.json")

_lock = threading.Lock()
_cache = {"stamp": None, "db": {}, "mine_stamp": None, "mine": {}}
scan_state = {"running": False, "done": 0, "total": 0, "current": ""}


def _mtime(p):
    try:
        return os.path.getmtime(p)
    except OSError:
        return None


def load_db():
    st = _mtime(DB_PATH)
    if st != _cache["stamp"]:
        try:
            with open(DB_PATH, encoding="utf-8") as f:
                _cache["db"] = json.load(f)
        except Exception:
            _cache["db"] = {}
        _cache["stamp"] = st
    return _cache["db"]


def load_mine():
    st = _mtime(MY_TRIGGERS)
    if st != _cache["mine_stamp"]:
        try:
            with open(MY_TRIGGERS, encoding="utf-8") as f:
                _cache["mine"] = {k: v for k, v in json.load(f).items() if not k.startswith("_")}
        except Exception:
            _cache["mine"] = {}
        _cache["mine_stamp"] = st
    return _cache["mine"]


def _split_words(words):
    out = []
    for w in words or []:
        w = (w or "").strip().strip(",").strip()
        if w and w not in out:
            out.append(w)
    return out


def trigger_info(lora_name):
    """Returns dict(source, words[list of trigger groups], hints[list of training tags])."""
    key = lora_name.replace("\\", "/")
    mine = load_mine()
    entry = load_db().get(key, {})
    hints = entry.get("top_tags") or []
    if key in mine:
        v = mine[key]
        return {"source": "my_triggers.json", "words": _split_words(v if isinstance(v, list) else [v]), "hints": hints}
    civ = entry.get("civitai") or {}
    words = _split_words(civ.get("trainedWords") if isinstance(civ, dict) else None)
    if words:
        return {"source": "civitai", "words": words, "hints": hints}
    return {"source": "none", "words": [], "hints": hints}


def pick_triggers(lora_name, mode):
    """mode: off | first | all"""
    if mode == "off":
        return ""
    info = trigger_info(lora_name)
    words = info["words"]
    if not words:
        return ""
    return words[0] if mode == "first" else ", ".join(words)


# ---------------------------------------------------------------- scanning
def _header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        return (json.loads(f.read(n)).get("__metadata__") or {})


def _sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for b in iter(lambda: f.read(8 << 20), b""):
            h.update(b)
    return h.hexdigest()


def scan(only_new=True, use_civitai=True):
    """Fill data/lora_info.json for every LoRA. Safe to run while ComfyUI is up."""
    if scan_state["running"]:
        return
    scan_state["running"] = True
    try:
        db = dict(load_db())
        names = [n for n in folder_paths.get_filename_list("loras") if n.endswith(".safetensors")]
        todo = [n for n in names if not (only_new and n.replace("\\", "/") in db and "civitai" in db[n.replace("\\", "/")])]
        scan_state.update(done=0, total=len(todo))
        for i, name in enumerate(todo):
            key = name.replace("\\", "/")
            scan_state.update(done=i, current=key)
            path = folder_paths.get_full_path("loras", name)
            e = db.get(key, {})
            try:
                if not e.get("sha256"):
                    meta = path[: -len(".safetensors")] + ".metadata.json"
                    s = None
                    if os.path.exists(meta):
                        try:
                            with open(meta, encoding="utf-8") as f:
                                s = json.load(f).get("sha256")
                        except Exception:
                            pass
                    e["sha256"] = s or _sha256(path)
                md = _header(path)
                tf = md.get("ss_tag_frequency")
                if tf:
                    c = collections.Counter()
                    for ds in json.loads(tf).values():
                        for t, n in ds.items():
                            c[t.strip()] += n
                    e["top_tags"] = [t for t, _ in c.most_common(25)]
                e["base_model_meta"] = md.get("ss_base_model_version") or md.get("modelspec.architecture")
            except Exception as ex:
                e["header_error"] = str(ex)
            if use_civitai and "civitai" not in e:
                try:
                    req = urllib.request.Request(
                        "https://civitai.com/api/v1/model-versions/by-hash/" + e["sha256"],
                        headers={"User-Agent": "waifu-studio/1.0"},
                    )
                    j = json.loads(urllib.request.urlopen(req, timeout=30).read())
                    imgs = [x.get("url") for x in (j.get("images") or []) if x.get("type", "image") == "image"][:1]
                    e["civitai"] = dict(
                        trainedWords=j.get("trainedWords") or [],
                        model=(j.get("model") or {}).get("name"),
                        version=j.get("name"),
                        baseModel=j.get("baseModel"),
                        modelId=j.get("modelId"),
                        versionId=j.get("id"),
                        type=(j.get("model") or {}).get("type"),
                        image=imgs[0] if imgs else None,
                        desc=(j.get("description") or "")[:600],
                    )
                except urllib.error.HTTPError as ex:
                    e["civitai"] = None if ex.code == 404 else {"error": ex.code}
                except Exception as ex:
                    e["civitai"] = {"error": str(ex)}
                time.sleep(0.4)
            db[key] = e
            if i % 10 == 0 or i == len(todo) - 1:
                _save(db)
        _save(db)
        scan_state.update(done=len(todo), current="")
    finally:
        scan_state["running"] = False


def _save(db):
    with _lock:
        os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
        tmp = DB_PATH + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(db, f, indent=1, ensure_ascii=False)
        os.replace(tmp, DB_PATH)


def scan_in_background(only_new=True):
    t = threading.Thread(target=scan, kwargs={"only_new": only_new}, daemon=True)
    t.start()
    return t
