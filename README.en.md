# dsh-wallpaper

Replace the flat DeepSeek Harness background with a real wallpaper. A **Wallpaper** settings page (order 5, sibling of *General*) ships two built-in wallpapers — **Official** (a static bake of the [deepseek.com](https://www.deepseek.com/) homepage hero: a near-flat pale-blue wash, soft warped-fBm wisps, fine CSS grid; the default) and **Aurora** — plus user uploads, panel opacity and background blur, three bundled OFL reading fonts (LXGW WenKai / Noto Serif SC / Noto Sans SC) and a 90–110% text scale.

![CI](https://github.com/cd-feng/dsh-wallpaper/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

[中文文档](./README.md)

## Features

- **Works out of the box** — the browser bundle (`lib/client.js`) is committed; the built-in art is inlined as data URIs.
- **Official look** — palette sampled from the real site (top ≈ `#e5ecf6`, bottom ≈ `#f2f4f8`, whole-image median ≈ `#e1e9f6`), cloudy wisps baked with domain-warped fBm, and the fine grid drawn with `repeating-linear-gradient` (crisp at integer DPR; 1.25/1.5 DPR antialiases, and a blur > 0 softens it with the artwork).
- **Uses the official theme mechanism** — `ctx.theme.overrideTokens()` turns `--dsw-alias-bg-base` translucent and a fixed `body::before` layer paints the image. Disabling or uninstalling the plugin rolls everything back.
- **Light/dark aware** — both built-in wallpapers have light and dark variants that follow the app theme. Uploaded images are used for both.
- **Respects the system setting** — the wallpaper pauses while *reduce transparency* is on.
- **Translucent chrome (0.7)** — the composer, user bubbles, markdown code blocks and the *Edited N files* deliverable cards follow *panel opacity* instead of staying solid; the composer also frosts its backdrop so message text cannot bleed through.
- **Overlay opacity on its own (0.8)** — those overlays track the panel slider (panel +6 %) by default; drag *Overlay opacity* in *Display* to pin a separate value, or use *Follow panel* to restore the link.
- **Your own images** — PNG / JPEG / WebP / GIF / AVIF, up to 20 MB, multi-select, two-step delete.
- **Survives restarts** — Desktop runs the Web server on a random port (`--port 0`), so the browser origin changes on every launch. Images and the selection are stored by the plugin Host under `<DSH_HOME>/dsh-wallpaper-desktop/`, not in localStorage/IndexedDB.
- **Bundled fonts (0.6)** — LXGW WenKai, Noto Serif SC and Noto Sans SC, one weight each, subset to GB2312 (~3.7 MB total, SIL OFL with license texts). The *Fonts* section switches instantly; code blocks and the terminal keep their monospace stack, rare glyphs fall back to the system font. Fonts are served by the Host at `/dsh-wallpaper/fonts/*` (immutable cache + sha256 ETag), never inlined into the JS bundle.
- **Text scale (0.6)** — the 90–110% slider scales the interface typography tokens (`--dsw-font-*`) and the conversation/code/terminal font-size variables; it only writes CSS variables and never republishes the theme.

## Install

From GitHub, let the Harness agent call `plugin_manager`:

```
action: install_bundle
target: github:cd-feng/dsh-wallpaper
```

Then **fully quit and restart DeepSeek Harness**: the browser half hot-reloads, but the Host half (image-library routes) is loaded at process start.

Local development:

```sh
dsh plugin add link:/absolute/path/to/dsh-wallpaper
node scripts/build-client.mjs   # rebuild the browser half (HMR picks it up)
node --test tests/*.test.mjs    # behaviour tests
```

Uninstall with `plugin_manager` `remove_bundle` (`target: dsh-wallpaper`); the image data stays in `<DSH_HOME>/dsh-wallpaper-desktop/` until you delete it.

## Usage

`Settings → Wallpaper` (order 5):

- **Background** — Official (default, the deepseek.com clouds + grid) / Aurora
- **My images** — upload, click a card to apply, two-step delete
- **Display** — panel opacity (20–100 %, also applied to the composer, bubbles, code blocks and deliverable cards), overlay opacity (20–100 %, follows the panel (+6 %) unless overridden), background blur (0–24 px)
- **Reset to defaults**

## Data

| Data | Location |
|---|---|
| Selection + slider values | `<DSH_HOME>/dsh-wallpaper[-desktop]/config.json` |
| Uploaded images | `<DSH_HOME>/dsh-wallpaper[-desktop]/images/<id>.<ext>` |
| Image index (sha256, size, name, time) | `<DSH_HOME>/dsh-wallpaper[-desktop]/library.json` |
| Built-in art | inlined into `lib/client.js` |

`<DSH_HOME>` defaults to `~/.dsh`; the desktop and web profiles keep separate directories.

## HTTP API

Every route is fenced to a same-origin loopback request (`Host`, loopback peer, `sec-fetch-site`, `Origin`), because plugin routes bypass the Web page's own authentication.

| Method | Path | Purpose |
|---|---|---|
| GET | `/dsh-wallpaper/state` | `{ config, images, fonts }` |
| PATCH | `/dsh-wallpaper/config` | partial `{ mode, customId, panelOpacity, blur, fontId, fontScale }` |
| POST | `/dsh-wallpaper/library` | raw image bytes, `content-type` + `x-filename` (URI-encoded), magic-byte sniffed; the upload becomes the selection |
| DELETE | `/dsh-wallpaper/library/<id>` | delete an image, fall back to the built-in wallpaper if it was selected |
| GET | `/dsh-wallpaper/assets/<id>` | image bytes, immutable cache, sha256 ETag |
| GET/HEAD | `/dsh-wallpaper/fonts/<file>` | bundled font / preview subset / OFL text; the name must be listed in the manifest; immutable cache + sha256 ETag/304 |

## Development

```sh
npm run check        # rebuild bundle + verify font payload + syntax check + 46 behaviour tests
npm test             # tests only
npm run build        # rebuild lib/client.js (inlines wallpaper data URIs + font manifest)
npm run fonts        # regenerate the bundled fonts (fonttools + brotli + network; sources pinned)
npm run fonts:check  # verify fonts/ against manifest sha256 / sizes / woff2 magic
npm run wallpapers   # regenerate the built-in art (Pillow + numpy, fixed seed)
```

CI runs the syntax check and tests on Node 22/24 and verifies that a rebuild leaves `lib/client.js` unchanged.

## Performance

The wallpaper is a permanent full-viewport layer, so its cost is bounded on purpose:

- **Style rebuilds** — the `body::before` rule carries the inlined WebPs and is rewritten only when the artwork changes. Sliders only move custom properties (`--dwp-panel-alpha`, `--dwp-filter`, `--dwp-transform`, `--dwp-sidebar-*`).
- **No theme churn while dragging** — `theme.overrideTokens` bumps the theme revision and re-renders every theme consumer, so the token layer is registered once and reads its alpha from `rgba(..., var(--dwp-panel-alpha))`. Dragging a slider emits no `theme/change`.
- **Frosted composer only** — just the composer card uses `backdrop-filter` (28 px, small area); bubbles and deliverable cards are plain-alpha `color-mix()`, so they allocate no filter surface.
- **Coalesced repaints** — every state change goes through `requestAnimationFrame`, so a 100+ Hz trackpad drag still paints at most once per frame.
- **No extra layers by default** — at blur 0 `filter`/`transform` are `none`, so the browser allocates no filter surface and no extra composited layer; a non-zero blur scales by `3×blur / viewport` so the feathered edge stays off-screen.
- **Thumbnails** — the 168 px cards use 336×210 bakes (≈700 B each for the built-ins) instead of decoding a 13.7 MB original.
- **Disk / network** — `PATCH` is debounced by 220 ms (0 writes while dragging, 1 on release); assets are read asynchronously with a 32 MB LRU, and a 304 is decided from the metadata ETag before any file read, so serving never blocks the Host event loop; an unchanged PATCH is not written.
- **Memory** — each 2400×1500 built-in image decodes to ≈13.7 MB and only the active light/dark one is decoded; uploads above 40 megapixels are rejected (they would decode to hundreds of MB).
- **Fonts on demand** — `@font-face` only declares faces; the settings cards use 3–6 KB preview subsets and the full file (1.0–1.5 MB) is fetched only once a font is selected. Files are `immutable` with a sha256 ETag, so a second load is a 304.
- **Scale writes variables only** — 51 typography tokens plus 3 body font-size variables per change: no stylesheet rebuild, no `theme/change`.
- **Trade-off** — a large blur is the one expensive setting. Custom-image thumbnails reuse the original file, so a very large upload costs one decode when Settings opens.

## Notes and limits

- The sidebar rule `[class*="_sidebarCol"]` depends on upstream css-modules names; if upstream renames it, the sidebar simply falls back to the official colour.
- The deliverable-card rules depend on upstream `vdszpW_*` / `IBlBFq_*` css-modules names; an upstream rename falls back to the solid card and breaks nothing. Same risk class as `_sidebarCol`.
- The built-in art is regenerated with `npm run wallpapers` (needs `python3 -m pip install pillow numpy`); the committed WebPs are already generated, so a normal install never runs Python.
- Images are stored verbatim (no recompression); a 20 MB PNG costs 20 MB on disk.
- Uploads are whole-file POSTs with no progress bar (loopback is fast); failures surface inline in the page.
- One active wallpaper at a time; the gallery can hold many, but one image serves both light and dark.
- Animated uploads (GIF / animated WebP / AVIF) repaint the full-viewport layer every frame — prefer still images.
- Custom-image thumbnails reuse the original file; there is no server-side downscale.
- The sidebar override also sets the documented `--dsw-specific-sidebar-fill` token, so surfaces that read it (the Windows title bar) stay translucent.
- Two Host processes sharing one data directory do not merge writes (normally there is exactly one Desktop process); edits made by hand are picked up after a Host restart.
- The font subsets cover GB2312 (6763 hanzi) plus Latin/punctuation/full-width forms; rare glyphs fall back to the system font, so mixed lines can differ slightly. Only weight 400 ships — `500/600` is synthesized by the browser.
- If the native *Appearance → Text font* field is set, its inline `<body>` value wins over the plugin's choice; clear it to let the plugin apply.
- The text scale targets Harness typography tokens and the conversation/code/terminal sizes; icons and spacing do not scale (this is a font scale, not a UI zoom).
- The 46 tests cover behaviour, not aesthetics.

## Data integrity

- Writes persist first and update memory afterwards: a failed `PATCH`, upload or delete rolls the metadata back, so a failed request never leaves a changed state and a restart never loses an image.
- Atomic writes use `fsync` + a temp file + `rename`, and a failed write removes its temp file; a missing file and an unreadable one are handled differently.
- A corrupt `library.json` / `config.json` is renamed to `.corrupt-<timestamp>` instead of being silently reset. Settings shows the warning returned by the Host, and a library that failed to load blocks overwriting the user's selection.
- Data directories are `0700` and files are `0600`; asset routes only serve regular files and return 404 for symlinks.
- The Host also parses image headers and rejects uploads above 40 megapixels, so a direct POST cannot bypass the browser-side check.
- `GET /state` is read-only: default files are created when the plugin mounts, not by a read request.

## License

[MIT](./LICENSE)

The bundled typefaces are distributed under the SIL Open Font License 1.1; the full texts live in `fonts/licenses/`:

| Font | Source | License |
|---|---|---|
| LXGW WenKai | [lxgw/LxgwWenKai](https://github.com/lxgw/LxgwWenKai) v1.530 | SIL OFL 1.1 |
| Noto Serif SC | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notoserifsc) | SIL OFL 1.1 |
| Noto Sans SC | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notosanssc) | SIL OFL 1.1 |

The woff2 files are GB2312 subsets of the originals, keeping the OFL notice and original copyright; no reserved font name is used.
