# Changelog

## 0.4.1

- 官方壁纸按官网实拍重新调色：把截图做 10px 高斯模糊、遮掉界面元素后逐行采样，官方亮色版是一条近乎平坦的 `#e5eaf5` 云洗（顶部 `#dfe7f4`，底部 `#f0f3f7` 近白）。新预设的均值/中位与官网逐行误差在 ±6 以内（此前顶部偏蓝 40+、底部偏蓝 20）。
- 云絮改成中段成团、顶部留白、底部淡出的分布，更接近官网"云在中间、下缘发白"的观感。
- 网格透明度再降一档（亮色 `0.055 → 0.018`，深色 `0.07 → 0.028`），贴近官网那层"几乎看不见"的格线。

## 0.4.0

- New **Official** built-in wallpaper: a static bake of the deepseek.com homepage hero — the `linear-gradient(180deg, #9cc1e7, transparent)` sky band over the `#f9f8f8` page colour, domain-warped fBm clouds (the site's masked flow-field canvas), a centre halo, and the fine grid drawn in CSS so it stays crisp at any DPI. Light and dark variants.
- **Official is now the default** wallpaper (`mode: "official"`), and both halves fall back to it when a selected custom image disappears.
- The aurora pair remains as the second built-in option; the settings page cards show the real thumbnails.
- `npm run wallpapers` generates four presets from fixed seeds; the bundle grows to ~113 KB.

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
