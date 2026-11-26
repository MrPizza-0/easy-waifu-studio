"""Waifu Studio - anime workflow nodes, a phone UI for ComfyUI, and a LoRA trigger guide.

Phone UI:  http://<your pc>:8188/waifu/m/
LoRA guide: http://<your pc>:8188/waifu/loras
"""
from .nodes import NODE_CLASS_MAPPINGS, NODE_DISPLAY_NAME_MAPPINGS

WEB_DIRECTORY = "./web"

# the nodes must work even if a page fails to load
for _name in ("guide", "mobile", "downloads", "characters", "connect"):
    try:
        __import__(f"{__name__}.{_name}", fromlist=["register_routes"]).register_routes()
    except Exception as ex:
        print(f"[waifu_studio] {_name} not available: {ex}")

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
