"""LoRA trigger-word guide, served by ComfyUI at /waifu/loras."""
import json
import os

import folder_paths
from aiohttp import web
from server import PromptServer

from . import lora_db
from .downloads import load_config
from .nodes import _load, _model_presets

SDXL_FAMILY = ("illustrious", "pony", "noobai", "sdxl")


def _rows():
    db = lora_db.load_db()
    mine = lora_db.load_mine()
    used = set()
    for f in ("characters.json", "styles.json", "models.json"):
        try:
            with open(os.path.join(lora_db.HERE, "presets", f), encoding="utf-8") as fh:
                for k, v in json.load(fh).items():
                    if isinstance(v, dict):
                        for n, _ in v.get("loras", []) + v.get("quality_loras", []):
                            used.add(n)
        except Exception:
            pass
    rows = []
    for name in folder_paths.get_filename_list("loras"):
        if not name.endswith(".safetensors"):
            continue
        key = name.replace("\\", "/")
        e = db.get(key, {})
        civ = e.get("civitai") if isinstance(e.get("civitai"), dict) else {}
        ti = lora_db.trigger_info(name)
        base = (civ or {}).get("baseModel") or e.get("base_model_meta") or ""
        bl = base.lower()
        compat = "ok" if any(s in bl for s in SDXL_FAMILY) else ("bad" if bl and ("1.5" in bl or "sd1" in bl or "wan" in bl or "flux" in bl or "hunyuan" in bl or "ltx" in bl) else "unknown")
        rows.append({
            "file": name,
            "title": (civ or {}).get("model") or os.path.splitext(os.path.basename(name))[0],
            "version": (civ or {}).get("version") or "",
            "base": base,
            "compat": compat,
            "type": (civ or {}).get("type") or "",
            "words": ti["words"],
            "source": ti["source"],
            "hints": ti["hints"][:12],
            "url": f"https://civitai.com/models/{civ['modelId']}?modelVersionId={civ.get('versionId')}" if civ and civ.get("modelId") else "",
            "image": (civ or {}).get("image") or "",
            "preset": name in used,
            "mine": key in mine,
        })
    rows.sort(key=lambda r: (not r["preset"], r["title"].lower()))
    return rows


PAGE = r"""<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>LoRA Trigger Guide</title>
<style>
:root{--bg:#14121a;--card:#1d1a26;--line:#2e2a3b;--text:#ece8f5;--mute:#9a93ad;--acc:#ff7ab6;--ok:#58d39a;--bad:#ff6b6b;--warn:#f5c35b}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.45 system-ui,Segoe UI,sans-serif}
header{position:sticky;top:0;background:#14121aee;backdrop-filter:blur(6px);padding:14px 16px;border-bottom:1px solid var(--line);z-index:2}
h1{margin:0 0 8px;font-size:18px}h1 span{color:var(--acc)}
.bar{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
input[type=search]{flex:1;min-width:220px;padding:9px 12px;border-radius:10px;border:1px solid var(--line);background:var(--card);color:var(--text);font-size:15px}
label{color:var(--mute);font-size:13px;display:flex;gap:4px;align-items:center}
button{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:8px;padding:7px 10px;cursor:pointer}
main{padding:14px 16px;display:grid;grid-template-columns:repeat(auto-fill,minmax(340px,1fr));gap:12px}
.c{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:12px;display:flex;gap:12px}
.c img{width:84px;height:110px;object-fit:cover;border-radius:8px;flex:none;background:#000}
.blur .c img{filter:blur(10px)}.blur .c img:hover{filter:none}
.t{font-weight:600}.f{color:var(--mute);font-size:12px;word-break:break-all}
.b{display:inline-block;font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--line);margin:4px 4px 0 0;color:var(--mute)}
.b.ok{color:var(--ok);border-color:#2d5c47}.b.bad{color:var(--bad);border-color:#6b2e2e}.b.p{color:var(--acc);border-color:#6b2e4c}
.w{margin-top:8px;display:flex;flex-direction:column;gap:5px}
.chip{background:#2a2438;border:1px solid #3c3450;border-radius:8px;padding:5px 8px;cursor:pointer;font-family:ui-monospace,Consolas,monospace;font-size:12px}
.chip:hover{border-color:var(--acc)}.chip.copied{border-color:var(--ok)}
.chip.lt{display:inline-block;background:none;border-style:dashed;color:var(--mute);margin:3px 3px 0 0}
.h{color:var(--mute);font-size:12px;margin-top:6px}a{color:var(--acc)}
.none{color:var(--warn);font-size:12px;margin-top:8px}
#count{color:var(--mute);font-size:13px}
</style></head><body class="blur">
<header><h1>💖 LoRA <span>Trigger Guide</span></h1>
<div class="bar"><input id="q" type="search" placeholder="Search name, character, trigger…" autofocus>
<label><input type="checkbox" id="onlyok"> SDXL/Illustrious only</label>
<label><input type="checkbox" id="blur" checked> blur previews</label>
<button id="scan" title="Look up LoRAs added since the last scan">Scan new LoRAs</button><span id="count"></span></div>
<div class="h">Click a trigger to copy it. Dashed chips are training tags (hints, not official). Put your own triggers in <code>waifu_studio/presets/my_triggers.json</code>. Or type <code>&lt;lora:name:0.8&gt;</code> in the Waifu Prompt box to load a LoRA with its trigger added automatically.</div></header>
<main id="g"></main>
<script>
const R=__ROWS__;
const g=document.getElementById('g'),q=document.getElementById('q'),ok=document.getElementById('onlyok');
function esc(s){return String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}
function copy(el,t){navigator.clipboard.writeText(t);el.classList.add('copied');setTimeout(()=>el.classList.remove('copied'),700)}
function render(){const s=q.value.toLowerCase().trim();let n=0;g.innerHTML='';
for(const r of R){const hay=(r.file+' '+r.title+' '+r.words.join(' ')+' '+r.hints.join(' ')).toLowerCase();
if(s&&!s.split(/\s+/).every(w=>hay.includes(w)))continue;if(ok.checked&&r.compat!=='ok')continue;n++;
const d=document.createElement('div');d.className='c';
const stem=r.file.replace(/\.safetensors$/,'').split('/').pop();
d.innerHTML=(r.image?`<img loading="lazy" src="${esc(r.image)}">`:'')+`<div style="min-width:0;flex:1"><div class="t">${esc(r.title)}</div>
<div class="f">${esc(r.file)}</div>
${r.preset?'<span class="b p">in a preset</span>':''}${r.base?`<span class="b ${r.compat}">${esc(r.base)}${r.compat==='bad'?' – won\'t work on SDXL':''}</span>`:''}${r.type?`<span class="b">${esc(r.type)}</span>`:''}${r.mine?'<span class="b p">my trigger</span>':''}
<div class="w">${r.words.map(w=>`<div class="chip" data-t="${esc(w)}">${esc(w)}</div>`).join('')}
<div class="chip" data-t="&lt;lora:${esc(stem)}:1&gt;" style="opacity:.7">&lt;lora:${esc(stem)}:1&gt;</div></div>
${!r.words.length?'<div class="none">No official trigger words'+(r.hints.length?' – training tags below:':' – probably a style/slider LoRA that needs none.')+'</div>':''}
${r.hints.length?'<div>'+r.hints.map(w=>`<span class="chip lt" data-t="${esc(w)}">${esc(w)}</span>`).join('')+'</div>':''}
${r.url?`<div class="h"><a href="${esc(r.url)}" target="_blank" rel="noopener">Civitai page ↗</a></div>`:''}</div>`;
g.appendChild(d)}document.getElementById('count').textContent=n+' / '+R.length+' LoRAs'}
g.addEventListener('click',e=>{const c=e.target.closest('[data-t]');if(c)copy(c,c.dataset.t)});
q.oninput=render;ok.onchange=render;document.getElementById('blur').onchange=e=>document.body.classList.toggle('blur',e.target.checked);
document.getElementById('scan').onclick=async e=>{e.target.disabled=true;e.target.textContent='Scanning…';
await fetch('/waifu/rescan',{method:'POST'});const t=setInterval(async()=>{const s=await (await fetch('/waifu/rescan')).json();
e.target.textContent=s.running?`Scanning ${s.done}/${s.total}…`:'Done – reload page';if(!s.running)clearInterval(t)},1500)};
render();
</script></body></html>"""


def register_routes():
    routes = PromptServer.instance.routes

    @routes.get("/waifu/loras")
    async def lora_page(request):
        html = PAGE.replace("__ROWS__", json.dumps(_rows(), ensure_ascii=False).replace("</", "<\\/"))
        return web.Response(text=html, content_type="text/html")

    @routes.get("/waifu/presets")
    async def presets(request):
        triggers = {}
        for name in folder_paths.get_filename_list("loras"):
            words = lora_db.trigger_info(name)["words"]
            if words:
                triggers[name] = words[0]
        idx = {n.replace("\\", "/").lower(): n for n in folder_paths.get_filename_list("loras")}
        missing = set()

        def fix(block, key):
            """Preset LoRA paths may use / and any case; map them to ComfyUI's exact names.
            LoRAs that are not on disk are dropped and listed under 'missing'."""
            if not isinstance(block, dict) or not block.get(key):
                return
            ok, gone = [], []
            for name, strength in block[key]:
                real = idx.get(str(name).replace("\\", "/").lower())
                if real:
                    ok.append([real, strength])
                else:
                    gone.append(name)
                    missing.add(name)
            block[key] = ok
            if gone:
                block["missing"] = gone

        models, chars, styles = _model_presets(), _load("characters.json"), _load("styles.json")
        for m in models.values():
            fix(m, "quality_loras")
        for st in styles.values():
            fix(st, "loras")
        for ch in chars.values():
            fix(ch, "loras")
            for o in (ch.get("outfits") or {}).values() if isinstance(ch, dict) else []:
                for fam in ("anima", "illustrious", "any"):
                    fix(o.get(fam), "loras")
        return web.json_response({
            "models": models,
            "characters": chars,
            "styles": styles,
            "triggers": triggers,
            "missing": sorted(missing),
            "settings": {"old_preset_loras": load_config().get("old_preset_loras", "remove")},
        })

    @routes.get("/waifu/rescan")
    async def rescan_status(request):
        return web.json_response(lora_db.scan_state)

    @routes.post("/waifu/rescan")
    async def rescan(request):
        lora_db.scan_in_background(only_new=True)
        return web.json_response({"started": True})
