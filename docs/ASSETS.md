# Assets

Every external asset in the app (art, sound, music, fonts, data) is logged here with its source and licence. Procedural or self-made comes first (BUILD_BRIEF §13, CLAUDE.md).

| | |
|---|---|
| **Status** | Phase 0: no external assets yet. |
| **Policy owner** | The owner approves any new licence type. |

## Licence policy

| Kind | Allowed | Status |
|---|---|---|
| Art, textures, sprites, icons | **Procedural** (Skia paths, gradients, SkSL shaders, particles) or drawn by us. External only if **CC0** (for example Kenney). | Brief §13 (locked) |
| Sound effects | **Synthesised** by our own scripts (OPEN_QUESTIONS F2). External only if CC0. | Default, F2 open |
| Music | Only if **CC0**, logged here (F2). | Default, F2 open |
| Fonts | **SIL OFL 1.1** fonts allowed: Noto Sans Tamil and Noto Sans (Latin). CanvasKit has no system fonts and Tamil needs shaping, so we bundle fonts. | **Pending OPEN_QUESTIONS F1** (a deviation from CC0-only). Until approved, no OFL font ships. |
| Quiz content | Our own wording; every fact has a checked source URL (OPEN_QUESTIONS D32). Sources are references, not copied text. | D31/D32 open |
| Kolam patterns | Procedural, plus our own designs in the traditional folk style (D26). | D26 open |
| App icon | Generated vector icon, once the name is decided (F5, A7). | F5 open |

**Not allowed:** CC-BY, CC-BY-SA, CC-NC, "free for personal use", "royalty-free" stock, assets ripped from other games or apps, and AI-generated assets whose terms restrict commercial or redistribution use. If a licence isn't on the allowed list, ask first.

**OFL obligations** (once F1 is approved): keep the font's copyright notice and licence text with the app (an in-app "Licences" screen plus the licence file in the repo), don't sell the font on its own, and don't use the reserved font name for a modified version.

## How to add an asset

1. Prefer making it procedurally. Only add a file if procedural is clearly worse.
2. Check the licence on the **original** source page (not a re-upload). Save the page URL and the date you checked.
3. Put the file under the game's `assets/` folder (or `packages/ui` for shared ones). Keep sizes small: audio as Opus or AAC, images as compressed WebP or SVG. Game assets load lazily, never in the Home bundle.
4. Add a row to the log below **in the same commit**.
5. CC0 needs no attribution, but we credit authors anyway in the in-app Licences screen.

## Log

| Asset (path) | Used by | Source URL | Author | Licence | Checked on | Notes |
|---|---|---|---|---|---|---|
| `spikes/render-stress/assets/fonts/NotoSansTamil-VF.ttf` (spike only) | Spike (a) Tamil Paragraph test | https://github.com/google/fonts/blob/main/ofl/notosanstamil/NotoSansTamil%5Bwdth,wght%5D.ttf | Google / Noto project | SIL OFL 1.1 (`OFL.txt` alongside) | 2026-10-06 | v2.004, sha256 `aa3a9b32…cf88`; OFL use pending OPEN_QUESTIONS F1 |
