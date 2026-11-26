# Waifu Studio for ComfyUI

A phone app for ComfyUI and an anime workflow to go with it. You pick a character, an outfit, an art style and a
model, then generate. You have upscaling, face, hand and mouth detailers, inpainting, multiple model presets, character presets, easy lora integration and more!
And all of it can be controlled on your mobile device from anywhere in the world!

<!-- screenshots / screen recording go here -->

## Phone app

Open `http://<your-pc>:8188/waifu/m/` in your phone's browser. You don't install anything on the phone.

- **Create**: character, outfit, art style and model pickers, a prompt editor with tag autocomplete, and one-tap
  switches for each stage (Upscale 2x, Face, Hands, Mouth, Ultra 4x). You see a live preview while it samples.
- Found a preview you like? Tap *Use seed*, turn on the stages you want and generate again. Only the new stages run.
- **Upscale this** and **Inpaint this** work on any image. You paint the inpaint mask with your finger and pinch to zoom.
- **Gallery** shows your whole output folder: folders, favorites, search by prompt text, pinch to change the
  number of columns, full-screen viewer with zoom, before/after slider, image info, and Remix (loads the
  settings that made an image). Deleting moves files to a trash folder, with undo.
- **Queue** shows live progress and waiting jobs, including ones started on the PC. You can cancel jobs here.
- **LoRA browser** with Civitai preview pictures and trigger words.
- **All nodes** lets you edit every setting of every node in the workflow.
- **Models & downloads** lists the model files the presets need and downloads the missing ones.
- The Android back button works, and you can install the page as an app (see Phone access).

## Install

Tested with ComfyUI 0.32 on Windows (portable build), with an RTX 3090.

1. In `ComfyUI/custom_nodes/`, run `git clone https://github.com/MrPizza-0/comfyui-waifu-studio`, or use
   ComfyUI Manager's "Install via Git URL" with the same link.
2. Install these node packs with ComfyUI Manager: rgthree-comfy, ComfyUI-KJNodes, ComfyUI-Impact-Pack,
   ComfyUI-Impact-Subpack and ComfyUI-Custom-Scripts. Custom-Scripts is optional. It shows the final prompt on
   the PC; tag autocomplete works without it.
3. Restart ComfyUI. On the PC, load `workflow/Waifu Studio.json`, or go straight to the phone app.
4. In the phone app, open Output & advanced > Models & downloads. Paste your Civitai API key (civitai.com >
   Account settings > API keys) and download the files you need. The key is saved on your PC in
   `ComfyUI/user/waifu_studio.json` and is only sent to Civitai.

The default model is WAI-NSFW-Illustrious v14 (SDXL). An Anima model preset (Nova 3DCG) is included too.

## Phone access

ComfyUI has no password. Anyone who can reach its port can use it, see your images and queue jobs, so don't
port-forward it to the internet.

Use [Tailscale](https://tailscale.com) (free) on the PC and the phone. Then either:

- start ComfyUI with `--listen` and open `http://<pc-tailscale-ip>:8188/waifu/m/`, or
- run `tailscale serve --bg 8188` on the PC (no `--listen` needed) and open
  `https://<pc-name>.<tailnet>.ts.net/waifu/m/`. Over HTTPS, Chrome offers "Install app" and the page runs full-screen.

## Characters and outfits

51 characters come with the pack. They need no LoRA because the models already know them: Genshin Impact,
Honkai: Star Rail, NIKKE, Overwatch, League of Legends, Final Fantasy, Street Fighter, One Piece, Fate and others.
Each has a picture. The pictures are links to Safebooru and Civitai, downloaded and cached on your PC the first
time you open the list.

To add a character from a Civitai LoRA, in the phone app:

1. Open the character list and tap + Add character > Find her on Civitai.
2. Type her name or paste the link to the LoRA's Civitai page.
3. Waifu Studio reads the page and fills in her name, one outfit per LoRA version, the trigger words, the model
   type (Anima or Illustrious) and a picture. If you already have her, the new outfits are added to her.
4. Look over the list. Untick outfits you don't want, tap Fix to change words, then tap Add and download.

The importer gets things wrong sometimes, so everything can be changed afterwards. Edit her opens an editor for
the name, picture and outfits. For each outfit you can set the LoRA, its strength and the words, and the trigger
words from the LoRA page show up as buttons you tap to add. If you change one of the 51 built-in characters, you
can reset her to the original. You can share characters as small pack files. A pack has the Civitai links,
not the LoRA files.

Your characters are saved in `ComfyUI/user/waifu_studio/`, so updating Waifu Studio doesn't touch them.
When you switch between an Anima and an Illustrious model, each character switches to her LoRA for that model.

The LoRAs belong to the people who made them. Waifu Studio downloads them from the creators' own Civitai pages.

## Art styles

No style LoRAs are included. Add the ones you like under Art style > + Add style: search Civitai or paste a
link. You get one style per model type, with the creator's trigger words and suggested strength filled in.
Edit style changes the words, the strength or the LoRA file.

When you switch to another character, style or model, the previous one's LoRAs are removed from the LoRA list.
If you'd rather have them only switched off, change that in Output & advanced.

## Credits

Character pictures are linked from Safebooru and Civitai and are not part of this repository. LoRAs belong to
their Civitai creators. The tag autocomplete list comes from ComfyUI-Custom-Scripts by pythongosssss.

License: MIT.
