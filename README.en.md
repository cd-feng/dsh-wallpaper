# dsh-wallpaper

Replace the flat DeepSeek Harness background with a real wallpaper. A **Wallpaper** settings page (order 5, sibling of *General*) ships two built-in wallpapers — **Official** (a static bake of the [deepseek.com](https://www.deepseek.com/) homepage hero: blue sky band, warped fBm clouds, fine CSS grid; the default) and **Aurora** — plus user uploads, panel opacity and background blur.

![CI](https://github.com/cd-feng/dsh-wallpaper/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

[中文文档](./README.md)

## Features

- **Works out of the box** — the browser bundle (`lib/client.js`) is committed; the built-in art is inlined as data URIs.
- **Official look** — palette from the real site (`#9cc1e7` band over `#f9f8f8`), cloudy wisps baked with domain-warped fBm, and the fine grid drawn with `repeating-linear-gradient` so it stays 1px at any DPI.
- **Uses the official theme mechanism** — `ctx.theme.overrideTokens()` turns `--dsw-alias-bg-base` translucent and a fixed `body::before` layer paints the image. Disabling or uninstalling the plugin rolls everything back.
- **Light/dark aware** — both built-in wallpapers have light and dark variants that follow the app theme. Uploaded images are used for both.
- **Respects the system setting** — the wallpaper pauses while *reduce transparency* is on.
- **Your own images** — PNG / JPEG / WebP / GIF / AVIF, up to 20 MB, multi-select, two-step delete.
- **Survives restarts** — Desktop runs the Web server on a random port (`--port 0`), so the browser origin changes on every launch. Images and the selection are stored by the plugin Host under `<DSH_HOME>/dsh-wallpaper-desktop/`, not in localStorage/IndexedDB.

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
- **Display** — panel opacity (20–100 %), background blur (0–24 px)
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
| GET | `/dsh-wallpaper/state` | `{ config, images }` |
| PATCH | `/dsh-wallpaper/config` | partial `{ mode, customId, panelOpacity, blur }` |
| POST | `/dsh-wallpaper/library` | raw image bytes, `content-type` + `x-filename` (URI-encoded), magic-byte sniffed; the upload becomes the selection |
| DELETE | `/dsh-wallpaper/library/<id>` | delete an image, fall back to the built-in wallpaper if it was selected |
| GET | `/dsh-wallpaper/assets/<id>` | image bytes, immutable cache, sha256 ETag |

## Development

```sh
npm run check        # rebuild bundle + syntax check + 24 behaviour tests
npm test             # tests only
npm run build        # rebuild lib/client.js (inlines wallpaper data URIs)
npm run wallpapers   # regenerate the built-in art (Pillow + numpy, fixed seed)
```

CI runs the syntax check and tests on Node 20/22 and verifies that a rebuild leaves `lib/client.js` unchanged.

## Performance

The wallpaper is a permanent full-viewport layer, so its cost is bounded on purpose:

- **Style rebuilds** — the `body::before` rule carries two inlined WebPs (~38 KB of base64) and is rewritten only when the artwork changes. Sliders only move the `--dwp-blur` / `--dwp-scale` / `--dwp-sidebar-*` custom properties.
- **Coalesced repaints** — every state change goes through `requestAnimationFrame`, so a 100+ Hz trackpad drag still paints at most once per frame.
- **Token layer** — `theme.overrideTokens` restyles the whole app, so it is re-registered only when the rounded opacity actually changes.
- **Disk** — `PATCH` is debounced by 220 ms (≈4 writes/s while dragging); uploaded images are served with `immutable` caching and a sha256 ETag, so reloads do not re-read the file.
- **Memory** — each 2400×1500 built-in image decodes to ≈13.7 MB; only the active light/dark artwork is decoded. Blur > 0 adds a full-viewport compositor texture; the default 0 does not.
- **Trade-off** — a large blur is the one expensive setting. Defaults are the cheapest path.

## Notes and limits

- The sidebar rule `[class*="_sidebarCol"]` depends on upstream css-modules names; if upstream renames it, the sidebar simply falls back to the official colour.
- The built-in art is regenerated with `npm run wallpapers` (needs `python3 -m pip install pillow numpy`); the committed WebPs are already generated, so a normal install never runs Python.
- Images are stored verbatim (no recompression); a 20 MB PNG costs 20 MB on disk.
- Uploads are whole-file POSTs with no progress bar (loopback is fast); failures surface inline in the page.
- One active wallpaper at a time; the gallery can hold many, but one image serves both light and dark.
- The 26 tests cover behaviour, not aesthetics.

## License

[MIT](./LICENSE)
