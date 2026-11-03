# Changelog

## 0.3.0

- Uploaded images and the selection now live on the **Host** side (`<DSH_HOME>/dsh-wallpaper[-desktop]/`) instead of IndexedDB/localStorage. Desktop launches the Web server on a random port, so the browser origin changes on every restart and former browser storage silently disappeared.
- New Host routes: `GET /dsh-wallpaper/state`, `PATCH /dsh-wallpaper/config`, `POST /dsh-wallpaper/library`, `DELETE /dsh-wallpaper/library/<id>`, `GET /dsh-wallpaper/assets/<id>`; each fenced to a same-origin loopback request.
- Upload validation on both halves (types, 20 MB cap, magic-byte sniffing), sha256 ETag for assets, atomic JSON writes.
- Graceful fallback when the Host half is not loaded yet: built-in wallpaper plus a "restart Harness" hint instead of a broken settings page.
- 24 dependency-free tests (13 browser-half behaviour, 11 Host routes / fence / durability), CI workflow, CHANGELOG, LICENSE.

## 0.2.0

- Settings entry moved to a top-level `settings.section` page (`order: 5`), sibling of *General*.
- Custom image upload with gallery, two-step delete, panel-opacity and blur sliders.
- Fixed a crash that hid the settings entry: `ctx.locale.subscribe` / `getSnapshot` were passed to `useSyncExternalStore` detached, losing `this`.

## 0.1.0

- First version: replace the solid light/dark background with built-in CC0 aurora art via `theme.overrideTokens` + a fixed `body::before` layer.
