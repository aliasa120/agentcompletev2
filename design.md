# THE ECHO — Master Brand Design Guide

## Brand Identity

**Brand Name:** THE ECHO  
**Website watermark:** `theecho.news.tv`  

---

## Official Color Palette

| Role | Color Name | Hex | Usage |
|---|---|---|---|
| Primary / Top Header | Deep Teal | `#0E4D4A` | Top bar background, THE ECHO brand header bar |
| Accent / Highlight | Mustard Gold | `#CBA052` | Category tags (#NEWS, #GLOBAL), key word highlights in headline |
| Text Box Background | Deep Charcoal | `#1A1A1A` | Background behind text overlays for readability |
| Primary Text | Pure White | `#FFFFFF` | Main headline text |
| Secondary Text | Light Grey | `#E0E0E0` | Sub-headlines, teasers, supporting text |
| Dark Card/Band | Soft Black | `#0D1F1E` | Dark bands, card backgrounds |

---

## Typography

| Element | Font | Style |
|---|---|---|
| Brand Name / Category Tags | Montserrat or Roboto | Bold, Sans-Serif — modern and clean |
| Main Headlines | Playfair Display or PT Serif | Bold, Serif — high authority, established newspaper feel |

---

## Layout Rules (Required in Every Design)

1. **Top Header Bar:** Solid Deep Teal `#0E4D4A` bar at the top containing "THE ECHO" wordmark/logo — white text on teal background. Always top-left.
2. **Category Tag:** Small Mustard Gold `#CBA052` tag above the headline — e.g. `# NEWS`, `# GLOBAL`, `# EXCLUSIVE`, `# BREAKING`. Montserrat Bold.
3. **Text Box:** Deep Charcoal `#1A1A1A` background behind headline text blocks for maximum readability.
4. **Watermark:** `theecho.news.tv` bottom-right corner, small Mustard Gold `#CBA052` text.

---

## ⚠️ CRITICAL DESIGN NOTE FOR AI

You CANNOT hallucinate or invent the brand design. Two reference images of THE ECHO's actual published posts are attached alongside this document. 

**You MUST:**
- Study these reference images carefully FIRST before selecting any candidate image or writing any prompt.
- Base ALL design decisions on what you observe in those reference images — the real color application, text placement, overlay style, and layout.
- The reference images are your ground truth. The guidelines here describe them in text, but the images show exactly how everything actually looks in practice.
- When writing an editing_prompt, explicitly instruct the editing model to "reproduce the layout shown in the attached THE ECHO brand reference images" so the editing model also has visual guidance.

---

## News-Type → Style Selection Guide

| News Type | THE ECHO Style | Key Visual Feel |
|---|---|---|
| Breaking / Hard News | **Style 1 — Gritty Ground-Level** | Real photo dominant, deep teal gradient overlay on bottom 30%, white serif headline on image, mustard gold category tag |
| Quote / Interview / Controversy | **Style 2 — Portrait Gradient** | Close-up face photo, dark `#0D1F1E` gradient fills bottom 40%, bold sans-serif headline in white, key words in mustard gold |
| Feature / Natural / Science | **Style 3 — Clean Container** | Wide cinematic shot, clean white/teal rounded text block at bottom, teal `#0E4D4A` left accent bar, high readability |
| Tabloid / Opinion / Geo-political Drama | **Style 4 — Composite Dramatic** | Multiple image layers, bold all-caps white headline, mustard gold word highlights, distressed textures, high contrast |
| Tech / Environment / Niche Brand | **Style 5 — Cinematic Branded** | Dramatic aerial or sunset photo, solid black text block at bottom 28%, teal single vertical accent bar on left edge |
| Disaster / Grief / Humanitarian | **Style 6 — Immersive Dark Band** | Teal/dark band at top (25%) + bottom (25%), photo fills middle 50%, white serif centered headline — sombre and respectful |

---

## THE ECHO Styles — Full Specifications

### Style 1 — Gritty Ground-Level
Ground-level photo fills frame. Deep Teal `#0E4D4A` gradient overlay covering bottom 30%, fading upward into transparency. Bold white serif headline (Playfair Display / PT Serif) in the overlay. Mustard Gold `#CBA052` category badge above headline. THE ECHO wordmark in Deep Teal bar at top-left. Watermark `theecho.news.tv` bottom-right in small mustard text.

### Style 2 — Portrait Gradient
Close-up portrait photo. Dark `#0D1F1E` gradient fills bottom 40%. Bold sans-serif (Montserrat/Roboto) headline in white; key words highlighted in Mustard Gold `#CBA052`. Category tag above headline. THE ECHO badge top-left on teal bar. Watermark bottom-right.

### Style 3 — Clean Container
Wide or cinematic photo. Clean rounded charcoal/white text block at bottom — a card, not a full gradient overlay. Dark `#1A1A1A` or teal `#0E4D4A` headline inside the card. Teal `#0E4D4A` left accent bar on the card. Very readable. THE ECHO badge integrated into the card. Watermark inside card bottom-right area.

### Style 4 — Composite Dramatic
Multiple overlaid images or textures. Photo-montage feel. Bold all-caps white headline; key words in Mustard Gold `#CBA052`. Distressed or flag textures in background. High-contrast tabloid energy. THE ECHO badge top-left on teal bar. Watermark bottom-right.

### Style 5 — Cinematic Branded
One dramatic high-angle or sunset photo. Solid Deep Charcoal `#1A1A1A` text block at bottom 28% (clean rectangle — not gradient). Teal `#0E4D4A` single vertical accent bar on left edge of block. White Montserrat Bold headline inside block. Mustard Gold `#CBA052` category tag above headline inside block. THE ECHO badge in block top-left area. Watermark bottom-right.

### Style 6 — Immersive Dark Band
Solid Deep Teal `#0E4D4A` or Dark `#0D1F1E` band at top (25%) + bottom band (25%). Photo fills middle 50%. Bold white serif headline centered in bottom band. No visual clutter — sombre and respectful. `URGENT` or `BREAKING` category tag in Mustard Gold in top band. THE ECHO badge in top-band left. Watermark in bottom-band right.

---

## Text Layers (Required in Every Editing Prompt)

1. **CATEGORY TAG / KICKER** — 2-4 words, small caps or bold sans-serif, Mustard Gold `#CBA052`. E.g. `# BREAKING NEWS`, `# COURT RULING`, `# EXCLUSIVE`, `# DEVELOPING`, `# GLOBAL`, `# URGENT`
2. **HEADLINE** — Bold, large, serif feel (Playfair Display or PT Serif). Max 10 words. Hook line adapted from the X (Twitter) post text.
3. **SPICE LINE / TEASER** — Smaller italic text below headline. One compelling sentence, max 15 words. Intriguing — not a repeat of the headline. Light Grey `#E0E0E0` color.

---

## Editing Prompt Rules

- Always reference THE ECHO style number and name at the start of the prompt.
- Explicitly tell the editing model: "Refer to the attached THE ECHO brand reference images to replicate the exact layout, overlay style, and text placement."
- Reference exact image zones for text placement (e.g. "top-left 40% sky area", "avoid face in center-right").
- Specify exact overlay position and size.
- Include all three text layers with exact wording.
- Specify exact color hex codes in the prompt: `#0E4D4A`, `#CBA052`, `#1A1A1A`, `#FFFFFF`, `#E0E0E0`.
- Always end the prompt with: `"Preserve original photo quality, sharpness and colors exactly — only add overlay and text. Do not upscale, blur, or re-compress."`
