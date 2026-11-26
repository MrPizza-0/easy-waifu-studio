"""Character editing and the Civitai importer for the phone UI.

User changes go to ComfyUI/user/waifu_studio/characters.json (and downloads.json for the LoRA sources);
the shipped presets/characters.json is never modified, so 'Reset' can always bring a shipped character back."""
import json
import os
import re
import urllib.parse
import urllib.request

from aiohttp import web
from server import PromptServer

from .downloads import civitai_key, state as download_state, start_downloads
from .mobile import load_tags
from .nodes import PRESETS, USER_PRESETS, _load, _read

CIVITAI = "https://civitai.com/api/v1"


def _user(name):
    return _read(os.path.join(USER_PRESETS, name))


def _write_user(name, data):
    os.makedirs(USER_PRESETS, exist_ok=True)
    path = os.path.join(USER_PRESETS, name)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=1, ensure_ascii=False)
    os.replace(tmp, path)


def shipped(file="characters.json"):
    return {k for k in _read(os.path.join(PRESETS, file)) if not k.startswith("_")}


def save_character(name, data, old_name=None, file="characters.json"):
    user = _user(file)
    if old_name and old_name != name:
        if old_name in shipped(file):
            user[old_name] = {"deleted": True}
        else:
            user.pop(old_name, None)
    user[name] = data
    _write_user(file, user)


def delete_character(name, file="characters.json"):
    user = _user(file)
    if name in shipped(file):
        user[name] = {"deleted": True}
    else:
        user.pop(name, None)
    _write_user(file, user)


def reset_character(name, file="characters.json"):
    user = _user(file)
    user.pop(name, None)
    _write_user(file, user)


def add_downloads(entries):
    user = _user("downloads.json")
    user.update(entries)
    _write_user("downloads.json", user)


# ------------------------------------------------------------------ Civitai
def _get(path):
    headers = {"User-Agent": "comfyui-waifu-studio"}
    if civitai_key():
        headers["Authorization"] = f"Bearer {civitai_key()}"
    with urllib.request.urlopen(urllib.request.Request(CIVITAI + path, headers=headers), timeout=60) as r:
        return json.load(r)


def family(base):
    b = (base or "").lower()
    if "anima" in b:
        return "anima"
    if "illustrious" in b or "noob" in b or b.startswith("sdxl"):
        return "illustrious"
    return None  # Pony, SD 1.5, Flux, video models... don't work with these workflows


def _image(version_or_model):
    imgs = [i for v in version_or_model.get("modelVersions", [version_or_model]) for i in v.get("images", []) if i.get("type", "image") == "image"]
    imgs.sort(key=lambda i: i.get("nsfwLevel", 99))
    return re.sub(r"/original=true/|/width=\d+/", "/width=450/", imgs[0]["url"]) if imgs else ""


NOISE = r"\b(sdxl|lora|anima|illustrious|ilxl|il|ixl|xl|pony|noobai|noob|nai|v\d+(\.\d+)*|character|outfits?|\d+\s*outfits?|commission)\b"


def clean_name(raw):
    """'Luna Snow (Marvel Rivals) (+2 outfits) [Anima/Illustrious]' -> ('Luna Snow (Marvel Rivals)', 'Marvel Rivals')"""
    s = re.sub(r"\[[^\]]*\]", " ", raw)
    s = re.sub(r"\(\s*\+?\d+\s*outfits?\s*\)", " ", s, flags=re.I)
    parts = [p.strip() for p in re.split(r"\s+[|—–-]\s+|\s*\|\s*", s) if p.strip()]
    name = parts[0] if parts else raw
    # drop words written in other scripts entirely (also 'ドールズフロントライン2'), and brackets left empty
    latin = lambda t: re.sub(r"\(\W*\)", " ", re.sub(r"\S*[^\x00-ɏ]\S*", " ", t))
    tidy = lambda t: re.sub(r"\s{2,}", " ", latin(re.sub(NOISE, " ", t, flags=re.I))).strip(" ,-/|&+")
    name = tidy(name)
    franchise = ""
    m = re.search(r"\(([^)]+)\)\s*$", name)
    if m:
        franchise = m.group(1).strip()
    elif len(parts) > 1:
        franchise = tidy(parts[1])
        if re.search(r"[A-Za-z0-9]", franchise):
            name = f"{name} ({franchise})"
    if not re.search(r"[A-Za-z0-9]", franchise):
        franchise = ""
    return name or raw.strip(), franchise


def clean_outfit(raw):
    if re.fullmatch(r"[\w.\-]+", raw) and ("_" in raw or "-" in raw):  # a file name like 'rapi-nikke-richy-v3_ixl'
        return ""
    s = re.sub(NOISE + r"|\b(1l|a|remap(ped)?|base|default)\b", " ", raw, flags=re.I)
    s = re.sub(r"[\s\-_()]+", " ", s).strip()
    return s


def _lead(group):
    return group.split(",")[0].strip()


_known = None


def _triggerish(tok):
    """A trigger word is a single word that is not a normal Danbooru tag."""
    global _known
    if _known is None:
        _known = {line.rsplit(",", 1)[0].lower() for line in load_tags().split("\n") if line}
    t = tok.strip().lower()
    return bool(t) and " " not in t and len(t) <= 40 and t not in _known


def split_groups(groups):
    """Trigger-word groups -> [(outfit name or '', tags)]. Splits only when the groups clearly are
    alternative outfits (each starts with its own trigger word); otherwise one outfit with everything."""
    groups = [g.strip().strip(",") for g in groups if g and g.strip().strip(",")]
    if len(groups) <= 1:
        return [("", groups[0] if groups else "")]
    ident = ""
    rest = groups
    if "," not in groups[0] and len(groups) >= 3:  # 'ovekiriko', then one group per outfit
        ident, rest = groups[0], groups[1:]
    if all("," not in g for g in rest) and all(_triggerish(g) for g in rest) and len(rest) >= 2:
        return [(g, f"{ident}, {g}" if ident else g) for g in rest]  # one word per outfit: 'soppobasegf2', 'soppocometgf2'
    leads = [_lead(g) for g in rest]
    if len(set(leads)) == len(leads) and all(_triggerish(t) for t in leads) and all(g.count(",") >= 1 for g in rest):
        prefix = os.path.commonprefix(leads)
        out = []
        for g, t in zip(rest, leads):
            nm = t[len(prefix):] if len(t) - len(prefix) >= 2 else t
            out.append((nm, f"{ident}, {g}" if ident else g))
        return out
    seconds = [g.split(",")[1].strip() if g.count(",") else "" for g in rest]
    if len(set(leads)) == 1 and all(seconds) and len(set(seconds)) == len(seconds) and all(_triggerish(t) for t in seconds):
        return [(t, g) for t, g in zip(seconds, rest)]  # 'klukaigf2, baseout' / 'klukaigf2, speedout'
    return [("", ", ".join(groups))]


def _desc_lines(model):
    t = re.sub(r"<br\s*/?>|</p>|</li>|</h\d>|<p>", "\n", model.get("description") or "")
    t = re.sub(r"<[^>]+>", "", t).replace("&amp;", "&").replace("&nbsp;", " ")
    return [line.strip() for line in t.split("\n") if line.strip()]


def _from_description(lines, tags):
    """Creators often write the full outfit prompt (and its name on the line above) only in the description.
    For a short trigger group like 'klukaigf2, speedout' -> ('Speed Star', 'klukaigf2, speedout, white bodysuit, ...')."""
    squash = lambda t: re.sub(r"\s+", "", t.lower())
    last = tags.split(",")[-1].strip()
    for key, prefix in ((tags, ""), (last, tags[: len(tags) - len(last)].strip(" ,"))):
        k = squash(key)
        for i, line in enumerate(lines):
            sq = squash(line)
            # a tag list that starts with the trigger words ('klukaigf2, speedout, white bodysuit, ...'), not prose
            if sq.startswith(k) and sq[len(k):len(k) + 1] == "," and len(line) > len(key) + 5:
                prev = lines[i - 1] if i and lines[i - 1].endswith(":") else ""
                name = prev.rstrip(":").split(",")[-1].strip()
                return name, f"{prefix}, {line}" if prefix else line
    return "", tags


def _outfits_in_description(lines):
    """When the trigger words just say 'check description': tag-list lines that share their first word."""
    rows = [(i, line) for i, line in enumerate(lines) if line.count(",") >= 5]
    by_first = {}
    for i, line in rows:
        by_first.setdefault(_lead(line).lower(), []).append((i, line))
    best = max(by_first.values(), key=len, default=[])
    if len(best) < 2:
        return []
    out = []
    for i, line in best:
        prev = lines[i - 1] if i and lines[i - 1].endswith(":") else ""
        name = prev.rstrip(":").split(",")[-1].strip()
        if name.lower() in ("character", "looks", "look", "appearance"):
            continue
        out.append((name or (line.split(",")[1].strip() if line.count(",") else ""), line))
    return out


def draft_from_model(model):
    lines = _desc_lines(model)
    name, franchise = clean_name(model["name"])
    folder = re.sub(r'[<>:"/\\|?*]', "", franchise or "Imported").strip() or "Imported"
    outfits, downloads, skipped, seen = {}, {}, [], set()
    for v in model.get("modelVersions", []):  # Civitai lists the newest version first
        fam = family(v.get("baseModel"))
        if not fam or "remap" in v["name"].lower():
            skipped.append(f"{v['name']} ({v.get('baseModel')})")
            continue
        same = (fam, re.sub(r"v\d+(\.\d+)*", "", v["name"].lower()).strip(" -_"))
        if same in seen:  # v1/v2/v3 of the same file: keep the newest
            skipped.append(f"{v['name']} (older version)")
            continue
        seen.add(same)
        f = next((x for x in v.get("files", []) if x.get("type") == "Model" and x["name"].endswith(".safetensors")), None)
        if not f:
            skipped.append(f"{v['name']} (no .safetensors file)")
            continue
        path = f"waifu_chars/{folder}/{f['name']}"
        downloads["loras/" + path] = {"civitai": v["id"], "page": f"https://civitai.com/models/{model['id']}?modelVersionId={v['id']}",
                                      "name": model["name"], "sizeMB": round(f.get("sizeKB", 0) / 1024),
                                      "sha256": (f.get("hashes") or {}).get("SHA256", "").lower()}
        base_name = clean_outfit(v["name"]) or "Default"
        splits = split_groups(v.get("trainedWords") or [])
        if len(splits) == 1 and (not splits[0][1] or "description" in splits[0][1].lower()):
            splits = _outfits_in_description(lines) or [("", "")]
        for sub, tags in splits:
            if tags.count(",") <= 2:
                found_name, tags = _from_description(lines, tags)
                sub = found_name or sub
            oname = base_name if len(splits) == 1 or not sub else (sub if base_name == "Default" else f"{base_name} · {sub}")
            oname = oname or "Default"
            o = outfits.setdefault(oname, {})
            if fam in o:  # same outfit name twice for one model kind: keep both
                oname = f"{oname} ({v['name']})"
                o = outfits.setdefault(oname, {})
            o[fam] = {"loras": [[path, 1.0]], "tags": tags, "groups": v.get("trainedWords") or []}
    return {"name": name, "franchise": franchise, "image": _image(model), "tags": "",
            "default_outfit": next(iter(outfits), ""), "outfits": outfits,
            "_downloads": downloads, "_skipped": skipped, "_page": f"https://civitai.com/models/{model['id']}"}


def _weight(lines, default=0.8):
    """'Recommended weight ~ 0.7' / 'strength: 0.6' in the description -> 0.7"""
    for line in lines:
        m = re.search(r"(?:weight|strength)[^0-9]{0,20}([01](?:\.\d+)?)", line, re.I)
        if m and 0.1 <= float(m.group(1)) <= 1.5:
            return float(m.group(1))
    return default


def style_draft(model):
    """Every usable version of a style LoRA becomes one style preset."""
    lines = _desc_lines(model)
    name, _ = clean_name(model["name"])
    weight = _weight(lines)
    styles, downloads, skipped, seen = [], {}, [], set()
    versions = [v for v in model.get("modelVersions", []) if family(v.get("baseModel")) and "remap" not in v["name"].lower()]
    for v in model.get("modelVersions", []):
        fam = family(v.get("baseModel"))
        if v not in versions:
            skipped.append(f"{v['name']} ({v.get('baseModel')})")
            continue
        same = (fam, re.sub(r"v\d+(\.\d+)*", "", v["name"].lower()).strip(" -_"))
        if same in seen:
            skipped.append(f"{v['name']} (older version)")
            continue
        seen.add(same)
        f = next((x for x in v.get("files", []) if x.get("type") == "Model" and x["name"].endswith(".safetensors")), None)
        if not f:
            continue
        path = f"waifu_styles/{f['name']}"
        downloads["loras/" + path] = {"civitai": v["id"], "page": f"https://civitai.com/models/{model['id']}?modelVersionId={v['id']}",
                                      "name": model["name"], "sizeMB": round(f.get("sizeKB", 0) / 1024),
                                      "sha256": (f.get("hashes") or {}).get("SHA256", "").lower()}
        sub = clean_outfit(v["name"])
        label = f"{name}{' · ' + sub if sub and len(versions) > 1 else ''} ({'Anima' if fam == 'anima' else 'Illustrious'})"
        words = [w.strip().strip(",") for w in (v.get("trainedWords") or []) if w.strip()]
        styles.append({"name": label, "family": fam, "positive": (words[0] + ",") if words else "", "negative": "",
                       "loras": [[path, weight]], "groups": words, "sizeMB": downloads["loras/" + path]["sizeMB"]})
    return {"name": name, "image": _image(model), "styles": styles, "_downloads": downloads, "_skipped": skipped,
            "_page": f"https://civitai.com/models/{model['id']}"}


def parse_ref(q):
    m = re.search(r"/models/(\d+)(?:[^?]*\?.*modelVersionId=(\d+))?", q)
    if m:
        return int(m.group(1))
    if q.strip().isdigit():
        return int(q.strip())
    return None


# ------------------------------------------------------------------ routes
def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/waifu/m/api/civitai/search")
    async def search(request):
        q = request.query.get("q", "").strip()
        mid = parse_ref(q)
        if mid:
            return web.json_response({"model_id": mid})
        # no "sort": with a sort, Civitai ignores the query text and returns its most popular LoRAs
        params = {"query": q, "types": "LORA", "nsfw": "true", "limit": 30}
        try:
            d = _get("/models?" + urllib.parse.urlencode(params))
        except Exception as ex:
            return web.json_response({"error": f"Civitai search failed: {ex}"}, status=502)
        out = []
        for m in d.get("items", []):
            fams = sorted({family(v.get("baseModel")) for v in m.get("modelVersions", [])} - {None})
            out.append({"id": m["id"], "name": m["name"], "image": _image(m), "downloads": (m.get("stats") or {}).get("downloadCount"),
                        "families": fams, "versions": len(m.get("modelVersions", []))})
        out.sort(key=lambda x: (not x["families"], -(x["downloads"] or 0)))
        return web.json_response({"results": out})

    @routes.get("/waifu/m/api/civitai/draft")
    async def draft(request):
        try:
            model = _get(f"/models/{int(request.query['id'])}")
        except Exception as ex:
            return web.json_response({"error": f"Could not read that Civitai page: {ex}"}, status=502)
        if model.get("type") != "LORA":
            return web.json_response({"error": f"That is a {model.get('type')}, not a LoRA."}, status=400)
        return web.json_response(draft_from_model(model))

    @routes.get("/waifu/m/api/civitai/style-draft")
    async def style_draft_route(request):
        try:
            model = _get(f"/models/{int(request.query['id'])}")
        except Exception as ex:
            return web.json_response({"error": f"Could not read that Civitai page: {ex}"}, status=502)
        if model.get("type") != "LORA":
            return web.json_response({"error": f"That is a {model.get('type')}, not a LoRA."}, status=400)
        return web.json_response(style_draft(model))

    @routes.post("/waifu/m/api/style/save")
    async def style_save(request):
        """{styles: {name: data}, old_name?, downloads?, download?}"""
        b = await request.json()
        styles = b.get("styles") or {}
        if not styles or not all(n.strip() for n in styles):
            return web.json_response({"error": "The style needs a name."}, status=400)
        for n, data in styles.items():
            save_character(n.strip(), {k: v for k, v in data.items() if not k.startswith("_") and k not in ("family", "sizeMB")},
                           b.get("old_name") if len(styles) == 1 else None, file="styles.json")
        downloads = b.get("downloads") or {}
        if downloads:
            add_downloads(downloads)
        if b.get("download") and downloads:
            start_downloads(list(downloads))
        return web.json_response({"ok": True, "download": download_state})

    @routes.post("/waifu/m/api/style/delete")
    async def style_delete(request):
        delete_character((await request.json())["name"], file="styles.json")
        return web.json_response({"ok": True})

    @routes.post("/waifu/m/api/char/save")
    async def save(request):
        b = await request.json()
        name = (b.get("name") or "").strip()
        if not name:
            return web.json_response({"error": "The character needs a name."}, status=400)
        data = b["data"]
        downloads = data.pop("_downloads", None) or {}
        for k in [k for k in data if k.startswith("_")]:
            data.pop(k)
        save_character(name, data, b.get("old_name"))
        if downloads:
            add_downloads(downloads)
        if b.get("download") and downloads:
            start_downloads(list(downloads))
        return web.json_response({"ok": True, "name": name, "download": download_state})

    @routes.post("/waifu/m/api/char/delete")
    async def delete(request):
        delete_character((await request.json())["name"])
        return web.json_response({"ok": True})

    @routes.post("/waifu/m/api/char/reset")
    async def reset(request):
        reset_character((await request.json())["name"])
        return web.json_response({"ok": True})

    @routes.get("/waifu/m/api/char/info")
    async def info(request):
        user = _user("characters.json")
        return web.json_response({"shipped": sorted(shipped()), "edited": sorted(k for k, v in user.items() if not k.startswith("_"))})

    @routes.post("/waifu/m/api/char/export")
    async def export(request):
        names = (await request.json()).get("names") or []
        chars, sources = _load("characters.json"), _load("downloads.json")
        pack = {"waifu_studio_pack": 1, "characters": {}, "downloads": {}}
        for n in names:
            c = chars.get(n)
            if not c:
                continue
            pack["characters"][n] = c
            for o in (c.get("outfits") or {}).values():
                for b in o.values():
                    for lora, _ in b.get("loras") or []:
                        k = "loras/" + lora.replace("\\", "/")
                        if k in sources:
                            pack["downloads"][k] = sources[k]
        return web.json_response(pack)

    @routes.post("/waifu/m/api/char/import")
    async def import_pack(request):
        pack = await request.json()
        if not isinstance(pack, dict) or "characters" not in pack:
            return web.json_response({"error": "That file is not a Waifu Studio character pack."}, status=400)
        for n, c in pack["characters"].items():
            save_character(n, c)
        add_downloads(pack.get("downloads") or {})
        return web.json_response({"ok": True, "count": len(pack["characters"])})
