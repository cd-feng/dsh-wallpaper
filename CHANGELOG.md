# Changelog

## 0.7.0

输入框、用户气泡、Markdown 代码块与「已编辑 N 个文件」交付卡片也会透出壁纸——此前这几处还是实色填充，壁纸被大块盖住。

- **输入框（composer）**：`--dsw-specific-input-major` 改为跟随「面板不透明度」的半透明色（面板 alpha +0.06），并加 28px 背景模糊：卡片浮在滚动正文之上，纯透明会让消息文字透出来，毛玻璃把下层糊掉、又保留壁纸的颜色。普通 / 紧凑 / 嵌入等 composer 变体共用同一 token，一并生效。
- **用户气泡**：`--dsw-specific-bubble` 同样跟随面板不透明度；亮色 `#edf3fe`、暗色 `#2c2c2e` 的色相保留，只把 alpha 换成变量。
- **Markdown 代码块**：正文卡片与顶部 `bash` 条分别用 `--dsw-alias-markdown-code-block` / `-banner`，一并换成半透明（暗色 `#1b1b1c` / `#2c2c2e`、亮色 `#f9fafb`），语法高亮色不动。
- **交付卡片**（`dsh-client-ui-deliverables` 的「已编辑 N 个文件」与单文件卡片）：body 的 `--dsw-alias-bg-layer-1`、header 的 `--changes-fill` / `--deliverable-fill` 用 `color-mix()` 混入透明度，hover / focus 状态同步；边框、圆角、diff 颜色不动。
- **实现**：新增 `--dwp-surface-alpha` / `--dwp-surface-mix`（面板 alpha +0.06，`requestAnimationFrame` 合并写入），拖滑杆照旧零主题重发布；`prefers-reduced-transparency` 时随 token 层一起回滚，禁用插件不留脏样式。
- **耦合提示**：交付卡片选择器依赖上游 css-modules 的 `vdszpW_*` / `IBlBFq_*` 局部名（与既有 `_sidebarCol` 同类风险），上游大改版时需复核，失效只会退回实色卡片。
- **测试**：新增 surface token、混合变量、样式规则、滑杆联动与销毁回滚断言，共 46 条。

## 0.6.0

新增「字体」能力：三款 OFL 正文字体 + 字号缩放，都走官方 typography 变量，不重发布主题。

- **三款打包字体**：霞鹜文楷（LXGW WenKai v1.530）/ 思源宋体 / 思源黑体（Google Fonts 固定 commit）。各一个字重，按 GB2312 + 拉丁 + 标点 + 全角子集化为 woff2，共约 3.7 MB；OFL 许可证全文随包分发（`fonts/licenses/`）。生僻字回退系统字体。
- **设置页新增「字体」分区**：系统字体 + 三款字体卡片（卡片内用每款 3–6 KB 的预览子集渲染示例，不预载完整字体），点卡片即时切换；新增 90–110% 字号缩放滑杆；`config.json` 增 `fontId` / `fontScale`，走既有 PATCH/持久化路径。
- **接入点**：Harness 的排版 token 全部经 `--dsw-font-family → var(--dsh-font-family-text, …)`，插件在 `<html>` 上设 `--dsh-font-family-text` 并注入 `@font-face`；代码块/终端保持 `--ds-font-family-code` 等宽字体，品牌字体不动。
- **字号缩放**：从 Harness 基础样式提取 51 个可缩放排版 token（`--dsw-font-*`）与正文/代码/终端字号变量，按比例重写；只写 CSS 变量，不触发 `theme/change`，主题 presenter 在 `theme/change` 后会重写 body 字号，插件在下一帧覆盖。
- **Host**：`/state` 增加 `fonts` 清单；新增只读 `GET|HEAD /dsh-wallpaper/fonts/<file>`，文件名必须命中 manifest（遍历/未知文件 404），`font/woff2`、`immutable` 缓存、sha256 ETag/304/HEAD；`config` 校验 `fontId`（形状）与 `fontScale`（90–110 夹取）。
- **构建链**：`npm run fonts` 下载固定源 → fonttools 子集 → 写 `fonts/manifest.json`（含 sha256/字节）；产物提交，安装/CI 不需要 Python 或网络。`npm run fonts:check`、CI 语法/载荷/打包断言同步更新；`build-client.mjs` 内联字体清单与排版 token 表，bundle 上限 400 KB。
- **测试**：新增客户端字体变量/缩放/dispose、未知 fontId 回退，Host 字体路由（ETag/304/HEAD/许可文件/遍历拒绝）与字体配置校验/重启持久化，共 45 条。
- 文档：中英文 README 增字体章节、HTTP 路由、开发命令与字体许可表；已知边界补充生僻字回退、原生字体设置优先级与「字号缩放不是界面缩放」。

## 0.5.2

Host 半审计（数据完整性 / 权限 / 缓存）的修复，重点是不再「返回成功但没落盘」、也不静默丢数据。

- **写盘顺序**：`PATCH` 先写成功再更新内存，同值跳过改为与「已落盘值」比较；失败后不会出现重试返回 200、磁盘仍是旧值的情况。
- **读接口无写副作用**：默认文件改在插件挂载时创建，`GET /state` 不再写盘（测试断言文件 mtime 不变）。
- **上传/删除事务化**：临时文件 → 先持久化 metadata/config → 最后 `rename` 提交；任一步失败回滚元数据并清理临时文件，不再「500 但图已加进去」或重试产生重复。
- **损坏文件隔离**：`library.json` / `config.json` 解析失败时改名 `.corrupt-<时间戳>` 保留；`/state` 返回 `warning`，设置页显示提示；图库读不出来时保留用户选择并拒绝 `PATCH`（503），不把 custom 静默重置成 official。
- **权限收紧**：数据目录 `0700`、文件 `0600`（含已存在路径 `chmod`）；资产路由只服务普通文件，符号链接走 404。
- **服务端像素上限**：Host 解析 PNG/JPEG/GIF/WebP/AVIF 头，> 4000 万像素直接 413——此前只有浏览器端检查，直接 POST 可上传 400 MP。
- **fence 修正**：对端接受 `127/8`（绑 `127.0.0.2` 不再全站 403）；`Origin` 同时比较 scheme + host + port。
- **缓存/304**：304 由元数据 ETag 判定（支持 `If-None-Match` 列表 / weak / `*`），不再先读文件；新增 `Last-Modified` 与 `HEAD`；并发 miss 不重复计内存；DELETE 竞态不再缓存孤儿。
- **校验**：sha256 格式、扩展名与 mime 绑定、上传文件名剥 bidi/零宽并按 code point 截断；`clampInt(null/true)` 不再落到极值。
- **测试**：新增故障路径、损坏隔离、只读 GET、服务端 40 MP、ETag/304/HEAD、0700/0600、软链、profile 判定与临时目录清理，共 38 条；测试脚本改成显式文件列表（Windows cmd 不展开 glob）。
- 文档：补「数据完整性」章节，更新测试数与 CI 版本（Node 22/24）。

## 0.5.1

- **拖动滑杆不再让整个应用重算主题**：`theme.overrideTokens` 会 bump revision、让每个主题消费者重渲染，之前拖动不透明度每帧都要重注册；现在 token 层只在启用时注册一次，透明度写成 `rgba(..., var(--dwp-panel-alpha))`，拖动零 `theme/change`。
- **默认零额外图层**：模糊为 0 时 `filter/transform` 都是 `none`（此前保留 `blur(0px)` 渲染面和 `scale(1)` 合成层）；模糊 > 0 时按 `3×blur/视口` 动态放大，修掉边缘露底。
- **缩略图**：设置卡片改用 336×210 烘焙缩略图（内置图各约 700 B），不再为 168 px 卡片解码 13.7 MB 原图。`npm run wallpapers` 现在同时产出 `*.thumb.webp`。
- **Host 资产读取不再阻塞事件循环**：`readFileSync` → 异步 `readFile`；加 32 MB LRU；支持 `If-None-Match` → 304；同值 PATCH 跳过写盘。
- **上传限制像素**：> 4000 万像素（或 20 MB）直接拒绝，避免解码吃掉几百 MB；GIF/动图仍可用但建议静态图。
- **自定义图有兜底**：CSS 里 custom 图下面叠官方烘焙图，文件丢失/解码失败不再露出透明底。
- **设置丢失可见**：PATCH 失败会在页面上报错并提供「重新保存」；慢响应不会覆盖更新的本地修改。
- **禁用后彻底静默**：`dispose` 取消排队/在途写入、移除 `<html>` 上的 `--dwp-*`、释放 locale 字典（`ctx.effect` 包裹）。
- **侧栏令牌**：另外覆盖官方 `--dsw-specific-sidebar-fill`（Windows 标题栏也读它），不再只靠私有 class。
- **交互修复**：删除请求期间禁用按钮、404 视为已删除；卡片焦点环不再被 `overflow:hidden` 裁掉；删除按钮带图片名 `aria-label`；降低透明度提示会随系统设置实时刷新；`clamp(null)` 不再落到最小值。
- 文档：更新官网配色/尺寸/测试数，补性能与已知边界（动图、自定义缩略图、1.25/1.5 DPR 网格）。

## 0.5.0

- 性能：带内联 webp 的结构样式只在切换壁纸时重写；滑杆值改走 `--dwp-*` 自定义属性；所有重绘经 `requestAnimationFrame` 合并；设置页 CSS 只注入一次。
- 修复：单张图上传被拒（如 415）不再把整个图库判成「壁纸服务不可用」。
- 新增：宿主半未加载时页面提供「重试」。
- 收紧：删除未文档化的 `GET /dsh-wallpaper/library`；`x-filename` 过滤控制字符；临时文件加随机后缀。
- `npm run wallpapers` 缺 Pillow/numpy 时给出安装提示；CI 增加模板/生成器语法检查与 `npm pack --dry-run`。

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
