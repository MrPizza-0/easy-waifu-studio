// Character browser + outfit picker.
import { h, icon, clear, sheet, haptic, debounce, store, longPress } from "./util.js";
import { S, loras } from "./comfy.js";
import { addCharacterSheet, editCharacter } from "./charedit.js";
import { loraInfo } from "./loras.js";
import { outfitFamilies } from "./graph.js";

const FAM = { anima: "Anima", illustrious: "Illustrious", any: "tags" };

export const charOutfits = (ch) => (ch?.outfits ? Object.keys(ch.outfits) : []);

// preview picture: the preset's own image, else the Civitai image of its first LoRA
export const charImage = (ch) => pic(ch?.image || (ch?.loras?.[0] && loraInfo(ch.loras[0][0])?.image) || "");

// web pictures (Safebooru / Civitai) go through the PC, which caches a small copy
export const pic = (url) => (/^https?:\/\//.test(url || "") ? `/waifu/m/api/remote?s=450&u=${encodeURIComponent(url)}` : url || "");

export function famBadges(ch, fam) {
  if (!ch?.outfits) return [h("span.badge2", (ch?.loras || []).length ? "LoRA" : "tags")];
  const fams = new Set(Object.values(ch.outfits).flatMap(outfitFamilies));
  return ["anima", "illustrious"].filter((f) => fams.has(f)).map((f) => h("span.badge2" + (f === fam ? ".ok" : ""), FAM[f]));
}

// Full-screen browser. Resolves with a character name or undefined.
export function pickCharacter(current, fam) {
  return new Promise((resolve) => {
    let done = false;
    const chars = Object.entries(S.presets.characters).filter(([k]) => !k.startsWith("_"));
    const s = sheet({
      title: "Character", full: true,
      onClose: () => { if (!done) resolve(undefined); },
      body: (bd) => {
        bd.classList.toggle("blurimg", S.settings.blur);
        let group = store.get("ch:group", "All"), q = "";
        const rank = (f) => (f === "All" ? 0 : f === "My characters" ? 1 : 2);
        const franchises = ["All", ...new Set(chars.map(([, c]) => c.franchise || "My characters"))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
        const inp = h("input.inp", { type: "search", placeholder: `Search ${chars.length} characters, outfits…` });
        const chips = h("div.chips.scrollx");
        const list = h("div");
        bd.append(h("div.search", icon("search"), inp), chips, list);
        const pickIt = (name) => { haptic(); done = true; resolve(name); s.close(); };
        const leave = (fn) => { s.close(); setTimeout(fn, 280); };
        bd.insertBefore(h("div.row", { style: { gap: "8px" } },
          h("button.btn.pri.grow", { style: { height: "48px", fontSize: "15px" }, onclick: () => leave(() => addCharacterSheet()) }, icon("plus"), "Add character"),
          h("span.hint", { style: { maxWidth: "40%" } }, "Hold a character to edit")), bd.firstChild);
        const draw = () => {
          clear(chips, franchises.map((f) => h("button.chip" + (f === group ? ".on" : ""), { onclick: () => { group = f; store.set("ch:group", f); draw(); } }, f)));
          const words = q.toLowerCase().split(/\s+/).filter(Boolean);
          const items = chars.filter(([name, c]) => {
            const fr = c.franchise || "My characters";
            if (group !== "All" && fr !== group) return false;
            const hay = (name + " " + fr + " " + charOutfits(c).join(" ")).toLowerCase();
            return words.every((w) => hay.includes(w));
          });
          const groups = new Map();
          for (const it of items) { const fr = it[1].franchise || "My characters"; if (!groups.has(fr)) groups.set(fr, []); groups.get(fr).push(it); }
          clear(list);
          for (const [fr, its] of [...groups.entries()].sort((a, b) => (a[0] === "My characters" ? -1 : b[0] === "My characters" ? 1 : a[0].localeCompare(b[0])))) {
            list.appendChild(h("div.lbl", { style: { margin: "10px 0 6px" } }, h("b", fr), h("span", `${its.length}`)));
            const grid = h("div", { style: { display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "7px" } });
            for (const [name, c] of its) {
              const n = charOutfits(c).length;
              const card = h("button", { class: "ccard" + (name === current ? " on" : ""), onclick: () => pickIt(name) },
                charImage(c) ? h("img.nsfw", { src: charImage(c), loading: "lazy", onerror: (e) => e.target.remove() }) : h("div.noimg", (name.match(/[A-Za-z0-9]/) || ["?"])[0]),
                h("div.cn", name.replace(/ \(.*\)$/, "")),
                h("div.co", n ? `${n} outfit${n > 1 ? "s" : ""}` : c.custom ? "leaves box alone" : "tags"),
                h("div.cb", famBadges(c, fam)));
              if (!c.custom) longPress(card, () => leave(() => editCharacter(name)));
              grid.appendChild(card);
            }
            list.appendChild(grid);
          }
          if (!items.length) list.appendChild(h("div.empty-state", "No match."));
        };
        inp.oninput = debounce(() => { q = inp.value; draw(); }, 150);
        draw();
        if (!S.loras) loras().then(draw).catch(() => {});
      },
    });
  });
}

// Outfit list sheet (for characters with many outfits). Resolves with an outfit name or undefined.
export function pickOutfit(ch, current, fam) {
  return new Promise((resolve) => {
    let done = false;
    const s = sheet({
      title: "Outfit", full: charOutfits(ch).length > 10,
      onClose: () => { if (!done) resolve(undefined); },
      body: (bd) => {
        const inp = h("input.inp", { type: "search", placeholder: "Search outfits…" });
        const list = h("div");
        if (charOutfits(ch).length > 10) bd.appendChild(h("div.search", icon("search"), inp));
        bd.appendChild(list);
        const draw = () => {
          const w = inp.value.toLowerCase();
          clear(list, charOutfits(ch).filter((n) => n.toLowerCase().includes(w)).map((n) => {
            const fams = outfitFamilies(ch.outfits[n]);
            const usable = fams.includes(fam) || fams.includes("any");
            return h("button.opt" + (n === current ? ".on" : ""), { style: { opacity: usable ? 1 : 0.5 }, onclick: () => { done = true; resolve(n); s.close(); } },
              h("span.ck", n === current ? icon("check") : null),
              h("span.grow", h("div.t", n), h("div.d", fams.map((f) => FAM[f]).join(" · ") + (usable ? "" : ` — no ${FAM[fam]} LoRA, uses tags only`))));
          }));
        };
        inp.oninput = draw;
        draw();
      },
    });
  });
}
