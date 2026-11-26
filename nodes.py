"""Waifu Studio - one workflow for everything.

Everything after the encoder travels in one WAIFU pipe (model, clip, vae, conditioning,
sampler settings, seed). Optional stages sit behind lazy gates: a stage whose switch is
off is never executed.
"""
import json
import math
import os
import re

import torch

import comfy.model_management
import comfy.samplers
import comfy.sd
import comfy.utils
import folder_paths
import nodes as comfy_nodes
from comfy_execution.graph_utils import ExecutionBlocker
from comfy_extras.nodes_upscale_model import ImageUpscaleWithModel, UpscaleModelLoader

from . import lora_db

HERE = os.path.dirname(os.path.abspath(__file__))
PRESETS = os.path.join(HERE, "presets")

SAMPLERS = comfy.samplers.KSampler.SAMPLERS
SCHEDULERS = comfy.samplers.KSampler.SCHEDULERS


# ------------------------------------------------------------------ presets
USER_PRESETS = os.path.join(folder_paths.get_user_directory(), "waifu_studio")
USER_FILES = ("characters.json", "styles.json", "downloads.json")  # the user's own additions/edits live here, safe from pack updates


def _read(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except FileNotFoundError:
        return {}
    except Exception as ex:
        print(f"[waifu_studio] could not read {path}: {ex}")
        return {}


def _load(name):
    """Shipped preset file, with the user's edits from ComfyUI/user/waifu_studio/ merged on top."""
    data = {k: v for k, v in _read(os.path.join(PRESETS, name)).items() if not k.startswith("_")}
    if name in USER_FILES:
        for k, v in _read(os.path.join(USER_PRESETS, name)).items():
            if k.startswith("_"):
                continue
            if isinstance(v, dict) and v.get("deleted"):
                data.pop(k, None)
            else:
                data[k] = v
    return data


def _model_presets():
    # all presets are listed, also ones whose model isn't downloaded yet (the phone offers the download)
    return _load("models.json") or {"(no presets)": {}}


# ------------------------------------------------------------------ text helpers
def clean_prompt(*parts):
    """Join prompt parts, tidy commas/spaces and drop exact duplicate tags."""
    text = ", ".join(p.strip().strip(",") for p in parts if p and p.strip().strip(","))
    pieces, seen = [], set()
    depth = 0
    for raw in text.split(","):
        piece = raw.strip()
        depth_before = depth
        depth += raw.count("(") - raw.count(")") + raw.count("[") - raw.count("]")
        if not piece:
            continue
        key = piece.lower().replace("_", " ")
        # only dedupe plain tags outside of weight brackets
        if depth_before == 0 and depth == 0 and "(" not in piece and "[" not in piece:
            if key in seen:
                continue
            seen.add(key)
        pieces.append(piece)
    out = ", ".join(pieces)
    out = re.sub(r"\s*\n\s*", " ", out)
    out = re.sub(r" {2,}", " ", out)
    return out.strip()


LORA_TAG = re.compile(r"<lora:([^:>]+)(?::([-0-9.]+))?(?::[-0-9.]+)?>", re.I)


def _find_lora(name):
    name = name.strip().replace("\\", "/").lower()
    all_l = folder_paths.get_filename_list("loras")
    for cand in all_l:
        c = cand.replace("\\", "/").lower()
        stem = os.path.splitext(c)[0]
        if name in (c, stem, os.path.basename(stem), os.path.basename(c)):
            return cand
    return None


# ------------------------------------------------------------------ model helpers
_lora_cache = {}


def apply_lora(model, clip, name, strength):
    path = folder_paths.get_full_path("loras", name)
    if path is None:
        raise FileNotFoundError(f"LoRA not found: {name}")
    if path not in _lora_cache:
        if len(_lora_cache) > 24:
            _lora_cache.pop(next(iter(_lora_cache)))
        _lora_cache[path] = comfy.utils.load_torch_file(path, safe_load=True)
    return comfy.sd.load_lora_for_models(model, clip, _lora_cache[path], strength, strength)


def encode(clip, text):
    tokens = clip.tokenize(text)
    return clip.encode_from_tokens_scheduled(tokens)


# ================================================================== NODES
# Each switch is its own node on purpose: a stage only depends on its own switch,
# so flipping one switch never invalidates the cache of the others.
class WaifuSwitch:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"on": ("BOOLEAN", {"default": False, "label_on": "✅ ON", "label_off": "⬜ off"})}}

    RETURN_TYPES = ("BOOLEAN",)
    RETURN_NAMES = ("on",)
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, on):
        return (on,)


class WaifuMode:
    MODES = ["Generate", "Upscale From (Load Image box)", "Inpaint (Load Image box + mask)"]

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"mode": (cls.MODES, {"default": "Generate"})}}

    RETURN_TYPES = ("BOOLEAN", "BOOLEAN")
    RETURN_NAMES = ("use_loaded_image", "inpaint")
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, mode):
        return (mode != "Generate", mode.startswith("Inpaint"))


class WaifuGate:
    """Passes 'on' when enabled, else 'off'. The unused side is never executed."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {"enabled": ("BOOLEAN", {"forceInput": True})},
            "optional": {
                "off": ("IMAGE", {"lazy": True}),
                "on": ("IMAGE", {"lazy": True}),
            },
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def check_lazy_status(self, enabled, **kw):
        key = "on" if enabled else "off"
        if key in kw and kw[key] is None:
            return [key]
        return []

    def run(self, enabled, off=None, on=None):
        img = on if enabled else off
        if img is None:
            raise RuntimeError(f"Waifu Gate: the '{'on' if enabled else 'off'}' input is not connected.")
        return (img,)


class WaifuCanvas:
    SIZES = {
        "Portrait 896x1152": (896, 1152),
        "Landscape 1152x896": (1152, 896),
        "Square 1024x1024": (1024, 1024),
        "Tall 832x1216": (832, 1216),
        "Wide 1216x832": (1216, 832),
        "Phone 768x1344": (768, 1344),
        "Phone 720x1280 (Anima)": (720, 1280),
        "Cinema 1344x768": (1344, 768),
        "Custom (use width/height)": None,
    }

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "size": (list(cls.SIZES.keys()), {"default": "Portrait 896x1152"}),
                "batch": ("INT", {"default": 1, "min": 1, "max": 16}),
                "width": ("INT", {"default": 896, "min": 256, "max": 4096, "step": 8}),
                "height": ("INT", {"default": 1152, "min": 256, "max": 4096, "step": 8}),
            }
        }

    RETURN_TYPES = ("LATENT", "INT", "INT")
    RETURN_NAMES = ("latent", "width", "height")
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, size, batch, width, height):
        wh = self.SIZES.get(size) or (width, height)
        w, h = (wh[0] // 8) * 8, (wh[1] // 8) * 8
        latent = torch.zeros([batch, 4, h // 8, w // 8], device=comfy.model_management.intermediate_device())
        return ({"samples": latent}, w, h)


class WaifuLoader:
    """One loader for both model kinds. 'Checkpoint' = normal SDXL/Illustrious file (+ clip skip).
    'Anima' = separate diffusion model + Qwen text encoder + VAE, with the AuraFlow shift patch.
    The model preset fills these fields; the fields of the other kind are simply ignored."""

    KINDS = ["Checkpoint (SDXL / Illustrious)", "Anima (diffusion model + Qwen + VAE)"]

    @classmethod
    def INPUT_TYPES(cls):
        def lst(folder, prefer):
            files = folder_paths.get_filename_list(folder) or ["(none found)"]
            return (files, {"default": prefer if prefer in files else files[0]})
        return {
            "required": {
                "kind": (cls.KINDS, {"default": cls.KINDS[0]}),
                "checkpoint": lst("checkpoints", "waiNSFWIllustrious_v140.safetensors"),
                "clip_skip": ("INT", {"default": -2, "min": -24, "max": -1, "tooltip": "Checkpoint only"}),
                "unet": lst("diffusion_models", "Nova3DCGAMV10.safetensors"),
                "text_encoder": lst("text_encoders", "qwen_3_06b_base.safetensors"),
                "vae": lst("vae", "qwen_image_vae.safetensors"),
                "shift": ("FLOAT", {"default": 3.0, "min": 0.0, "max": 100.0, "step": 0.05, "tooltip": "Anima only"}),
            }
        }

    RETURN_TYPES = ("MODEL", "CLIP", "VAE")
    RETURN_NAMES = ("model", "clip", "vae")
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, kind, checkpoint, clip_skip, unet, text_encoder, vae, shift):
        if kind.startswith("Anima"):
            from comfy_extras.nodes_model_advanced import ModelSamplingAuraFlow
            model = comfy_nodes.UNETLoader().load_unet(unet, "default")[0]
            clip = comfy_nodes.CLIPLoader().load_clip(text_encoder, "stable_diffusion")[0]
            vae_ = comfy_nodes.VAELoader().load_vae(vae)[0]
            model = ModelSamplingAuraFlow().patch_aura(model, shift)[0]
            return (model, clip, vae_)
        model, clip, vae_ = comfy_nodes.CheckpointLoaderSimple().load_checkpoint(checkpoint)[:3]
        clip = clip.clone()
        clip.clip_layer(clip_skip)
        return (model, clip, vae_)


class WaifuPresets:
    """Picking a preset fills the editable boxes, the Power Lora Loader and the sampler settings
    (done in the browser by web/waifu_studio.js). Generation only reads those fields."""

    @classmethod
    def INPUT_TYPES(cls):
        chars = _load("characters.json")
        outfits = sorted({o for c in chars.values() if isinstance(c, dict) for o in (c.get("outfits") or {})})
        return {
            "required": {
                "model_preset": (list(_model_presets().keys()),),
                "character": (list(chars.keys()) or ["None (empty box)"],),
                "art_style": (list(_load("styles.json").keys()) or ["None"],),
                # the browser only shows the picked character's outfits; the full list is for validation
                "outfit": (["(default)"] + outfits, {"default": "(default)"}),
            }
        }

    RETURN_TYPES = ()
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, model_preset, character, art_style, outfit="(default)"):
        return ()


class WaifuText:
    """The editable prompt boxes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "base": ("STRING", {"multiline": True, "default": "", "tooltip": "Quality words + art style words (filled by the model/style preset)"}),
                "character": ("STRING", {"multiline": True, "default": "", "tooltip": "Who she is + outfit (filled by the character preset)"}),
                "lora_triggers": ("STRING", {"multiline": True, "default": "", "tooltip": "Trigger words of LoRAs you switch on in the Power Lora Loader"}),
                "scene": ("STRING", {"multiline": True, "default": "", "tooltip": "Pose, place, mood. Never overwritten by presets."}),
                "negative": ("STRING", {"multiline": True, "default": ""}),
            }
        }

    RETURN_TYPES = ("STRING", "STRING", "STRING")
    RETURN_NAMES = ("base_positive", "scene", "negative")
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, base, character, lora_triggers, scene, negative):
        return (clean_prompt(base, character, lora_triggers), scene, clean_prompt(negative))


class WaifuSettings:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "steps": ("INT", {"default": 30, "min": 1, "max": 150}),
                "cfg": ("FLOAT", {"default": 7.0, "min": 0.0, "max": 30.0, "step": 0.5}),
                "sampler_name": (SAMPLERS, {"default": "euler_ancestral"}),
                "scheduler": (SCHEDULERS, {"default": "normal"}),
            }
        }

    RETURN_TYPES = ("WAIFU_SETTINGS",)
    RETURN_NAMES = ("settings",)
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, steps, cfg, sampler_name, scheduler):
        return ({"steps": steps, "cfg": cfg, "sampler": sampler_name, "scheduler": scheduler},)


class WaifuEncode:
    """Builds the final prompt, loads <lora:name:0.8> tags from the scene and
    packs everything into the WAIFU pipe."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "model": ("MODEL",),
                "clip": ("CLIP",),
                "vae": ("VAE",),
                "settings": ("WAIFU_SETTINGS",),
                "seed": ("INT", {"forceInput": True}),
                "base_positive": ("STRING", {"forceInput": True}),
                "scene": ("STRING", {"forceInput": True}),
                "negative": ("STRING", {"forceInput": True}),
            },
        }

    RETURN_TYPES = ("WAIFU", "STRING")
    RETURN_NAMES = ("waifu", "final_prompt")
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, model, clip, vae, settings, seed, base_positive, scene, negative):
        notes = []

        def lora_sub(m):
            nonlocal model, clip
            name = _find_lora(m.group(1))
            if name is None:
                notes.append(f"!! prompt LoRA not found: {m.group(1)}")
                return ""
            strength = float(m.group(2) or 1.0)
            model, clip = apply_lora(model, clip, name, strength)
            notes.append(f"prompt LoRA {strength:g} {name}")
            return lora_db.pick_triggers(name, "first") + ","

        scene_txt = LORA_TAG.sub(lora_sub, scene)
        positive = clean_prompt(LORA_TAG.sub("", base_positive), scene_txt)
        negative = clean_prompt(negative)

        waifu = dict(settings, model=model, clip=clip, vae=vae, seed=seed,
                     positive=encode(clip, positive), negative=encode(clip, negative))
        shown = positive + "\n\n--- negative ---\n" + negative
        if notes:
            shown += "\n\n" + "\n".join(notes)
        return (waifu, shown)


class WaifuSampler:
    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"waifu": ("WAIFU",), "latent": ("LATENT",)}}

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, waifu, latent):
        w = waifu
        out = comfy_nodes.common_ksampler(w["model"], w["seed"], w["steps"], w["cfg"], w["sampler"], w["scheduler"],
                                          w["positive"], w["negative"], latent, denoise=1.0)[0]
        img = w["vae"].decode(out["samples"])
        return (img.reshape(-1, img.shape[-3], img.shape[-2], img.shape[-1]),)


class WaifuCompareGuard:
    """Feeds a before/after comparer only when the stage actually changed the image,
    so switched-off stages don't save comparison images."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"before": ("IMAGE",), "after": ("IMAGE",)}}

    RETURN_TYPES = ("IMAGE", "IMAGE")
    RETURN_NAMES = ("before", "after")
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, before, after):
        if before is after:
            return (ExecutionBlocker(None), ExecutionBlocker(None))
        return (before, after)


def _upscale_model(name):
    return UpscaleModelLoader.execute(name).result[0]


def _run_upscale_model(model, image):
    return ImageUpscaleWithModel.execute(model, image).result[0]


_up_cache = {}


class WaifuHiRes:
    """Upscale + second sampler pass. 'tiled' mode works tile by tile, for very big images."""

    @classmethod
    def INPUT_TYPES(cls):
        ups = ["lanczos (no model)"] + folder_paths.get_filename_list("upscale_models")
        default = "2x-AnimeSharpV4_RCAN.safetensors" if "2x-AnimeSharpV4_RCAN.safetensors" in ups else ups[-1]
        return {
            "required": {
                "waifu": ("WAIFU",),
                "image": ("IMAGE",),
                "upscale_model": (ups, {"default": default}),
                "scale_by": ("FLOAT", {"default": 2.0, "min": 1.0, "max": 4.0, "step": 0.25}),
                "denoise": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0, "step": 0.01, "tooltip": "0 = 0.3 (the model preset fills this in)"}),
                "steps": ("INT", {"default": 20, "min": 1, "max": 100}),
                "cfg": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 30.0, "step": 0.5, "tooltip": "0 = same CFG as the main sampler"}),
                "mode": (["full image", "tiled"], {"default": "full image"}),
                "tile_size": ("INT", {"default": 1024, "min": 512, "max": 2048, "step": 64}),
                "seed_offset": ("INT", {"default": 1, "min": 0, "max": 1000}),
            }
        }

    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, waifu, image, upscale_model, scale_by, denoise, steps, cfg, mode, tile_size, seed_offset):
        w = waifu
        b, h, wd, c = image.shape
        tw, th = int(round(wd * scale_by / 8)) * 8, int(round(h * scale_by / 8)) * 8

        img = image
        if upscale_model != "lanczos (no model)":
            if upscale_model not in _up_cache:
                _up_cache.clear()
                _up_cache[upscale_model] = _upscale_model(upscale_model)
            img = _run_upscale_model(_up_cache[upscale_model], img)
        if img.shape[2] != tw or img.shape[1] != th:
            img = comfy.utils.common_upscale(img.movedim(-1, 1), tw, th, "lanczos", "disabled").movedim(1, -1)
        img = img[..., :3].clamp(0, 1)

        dn = denoise or 0.3
        cf = cfg or w["cfg"]
        seed = w["seed"] + seed_offset
        if mode == "tiled":
            return (self._tiled(w, img, dn, steps, cf, seed, tile_size),)
        vae = w["vae"]
        big = tw * th > 2_400_000
        lat = vae.encode_tiled(img, tile_x=1024, tile_y=1024, overlap=64) if big else vae.encode(img)
        out = comfy_nodes.common_ksampler(w["model"], seed, steps, cf, w["sampler"], w["scheduler"],
                                          w["positive"], w["negative"], {"samples": lat}, denoise=dn)[0]["samples"]
        res = vae.decode_tiled(out, tile_x=128, tile_y=128, overlap=16) if big else vae.decode(out)
        return (res.reshape(-1, res.shape[-3], res.shape[-2], res.shape[-1]),)

    @staticmethod
    def _positions(length, tile, overlap):
        if length <= tile:
            return [0], length
        n = math.ceil((length - overlap) / (tile - overlap))
        step = (length - tile) / (n - 1)
        return sorted({int(round(i * step / 8)) * 8 for i in range(n - 1)} | {length - tile}), tile

    def _tiled(self, w, img, denoise, steps, cfg, seed, tile):
        b, h, wd, _ = img.shape
        overlap = 128
        ys, th = self._positions(h, tile, overlap)
        xs, tw = self._positions(wd, tile, overlap)
        out = torch.zeros_like(img)
        weight = torch.zeros((1, h, wd, 1), dtype=img.dtype)
        ramp_y = torch.clamp((torch.minimum(torch.arange(th), torch.arange(th).flip(0)) + 1) / overlap, 1e-3, 1.0)
        ramp_x = torch.clamp((torch.minimum(torch.arange(tw), torch.arange(tw).flip(0)) + 1) / overlap, 1e-3, 1.0)
        mask = (ramp_y[:, None] * ramp_x[None, :])[None, :, :, None].to(img.dtype)
        pbar = comfy.utils.ProgressBar(len(ys) * len(xs))
        vae = w["vae"]
        for y in ys:
            for x in xs:
                crop = img[:, y:y + th, x:x + tw, :]
                lat = vae.encode(crop)
                s = comfy_nodes.common_ksampler(w["model"], seed, steps, cfg, w["sampler"], w["scheduler"],
                                                w["positive"], w["negative"], {"samples": lat}, denoise=denoise)[0]["samples"]
                dec = vae.decode(s)
                dec = dec.reshape(-1, dec.shape[-3], dec.shape[-2], dec.shape[-1]).to(out.device, out.dtype)
                out[:, y:y + th, x:x + tw, :] += dec[:, :th, :tw, :] * mask
                weight[:, y:y + th, x:x + tw, :] += mask
                pbar.update(1)
        return (out / weight).clamp(0, 1)


class WaifuUnpack:
    """Splits the WAIFU pipe for the Impact detailer nodes."""

    @classmethod
    def INPUT_TYPES(cls):
        return {"required": {"waifu": ("WAIFU",)}}

    RETURN_TYPES = ("MODEL", "CLIP", "VAE", "CONDITIONING", "CONDITIONING", "BASIC_PIPE", "INT")
    RETURN_NAMES = ("model", "clip", "vae", "positive", "negative", "basic_pipe", "seed")
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, waifu):
        w = waifu
        pipe = (w["model"], w["clip"], w["vae"], w["positive"], w["negative"])
        return (*pipe, pipe, w["seed"])


class WaifuInpaintPrompt:
    """Inpaint-only prompt. The boxes start as a copy of the main prompt (web/waifu_studio.js keeps
    them in sync until you edit them). An empty box inherits the main prompt as it was encoded."""

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "waifu": ("WAIFU",),
                "positive": ("STRING", {"multiline": True, "default": "", "tooltip": "Inpaint prompt. Empty = same as the main prompt."}),
                "negative": ("STRING", {"multiline": True, "default": "", "tooltip": "Inpaint negative. Empty = same as the main negative."}),
            }
        }

    RETURN_TYPES = ("WAIFU",)
    RETURN_NAMES = ("waifu",)
    FUNCTION = "run"
    CATEGORY = "waifu_studio"

    def run(self, waifu, positive, negative):
        w = dict(waifu)
        pos, neg = clean_prompt(LORA_TAG.sub("", positive)), clean_prompt(LORA_TAG.sub("", negative))
        if pos:
            w["positive"] = encode(w["clip"], pos)
        if neg:
            w["negative"] = encode(w["clip"], neg)
        return (w,)


NODE_CLASS_MAPPINGS = {
    "WaifuInpaintPrompt": WaifuInpaintPrompt,
    "WaifuPresets": WaifuPresets,
    "WaifuLoader": WaifuLoader,
    "WaifuText": WaifuText,
    "WaifuSettings": WaifuSettings,
    "WaifuEncode": WaifuEncode,
    "WaifuSwitch": WaifuSwitch,
    "WaifuMode": WaifuMode,
    "WaifuGate": WaifuGate,
    "WaifuCanvas": WaifuCanvas,
    "WaifuSampler": WaifuSampler,
    "WaifuHiRes": WaifuHiRes,
    "WaifuUnpack": WaifuUnpack,
    "WaifuCompareGuard": WaifuCompareGuard,
}
NODE_DISPLAY_NAME_MAPPINGS = {
    "WaifuInpaintPrompt": "🖌️ Waifu Inpaint Prompt",
    "WaifuPresets": "🎯 Waifu Presets",
    "WaifuLoader": "📦 Waifu Model Loader",
    "WaifuText": "✍️ Waifu Prompt Boxes",
    "WaifuSettings": "⚙️ Waifu Sampler Settings",
    "WaifuEncode": "🧬 Waifu Encode",
    "WaifuSwitch": "🔘 Waifu Switch",
    "WaifuMode": "🎛️ Waifu Mode",
    "WaifuGate": "🚦 Waifu Gate",
    "WaifuCanvas": "🖼️ Waifu Canvas",
    "WaifuSampler": "🎨 Waifu Sampler",
    "WaifuHiRes": "🔍 Waifu HiRes / Upscale",
    "WaifuUnpack": "📦 Waifu Unpack",
    "WaifuCompareGuard": "🔀 Waifu Compare Guard",
}
