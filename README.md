# dsh-wallpaper

给 [DeepSeek Harness](https://github.com/deepseek-ai) 换一张真正的背景图：官方界面的深/浅纯色底换成壁纸。设置里多一个和「通用」同级、序号 5 的「壁纸」页——内置「官方」（复刻 [deepseek.com](https://www.deepseek.com/) 首页的云海底纹 + 细网格，默认）与「极光」两套，也能上传自己的图片；另带三款打包的 OFL 正文字体（霞鹜文楷 / 思源宋体 / 思源黑体）与 90–110% 字号缩放，可调面板通透度与背景模糊。

![CI](https://github.com/cd-feng/dsh-wallpaper/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.1--rc.1-4B6BFB)

## 特性

- **装完即用**：`lib/client.js` 已生成并随包提交；内置壁纸以 data URI 内联，不额外起资源路由。
- **官方同款**：默认壁纸照着 deepseek.com 首页烤的——上浅蓝（约 `#e5ecf6`）、下近白（约 `#f2f4f8`）的近平面色场，只在中间带淡淡的域扭曲 fBm 云絮和中心亮斑；网格用 CSS 重复渐变叠（不烘进位图，缩放不起摩尔纹）。
- **官方机制上屏**：`ctx.theme.overrideTokens()` 把 `--dsw-alias-bg-base` 换成半透明 rgba，`body::before` 固定层画图；插件禁用/卸载时全部自动回滚，不留脏样式。
- **跟随明暗**：每套内置壁纸都有亮色、深色两张，随 Harness「外观配色」自动切换；上传的图片同时用于两种配色。
- **跟随系统**：系统开启「降低透明度」时自动暂停壁纸，关掉后自动恢复。
- **面板透出壁纸（0.7）**：输入框、用户气泡、Markdown 代码块与「已编辑 N 个文件」等交付卡片也跟随「面板不透明度」半透明；输入框另加背景模糊，浮在滚动正文上方也不会被文字穿透。
- **浮层不透明度可单独调（0.8）**：上面这几类浮层默认跟面板联动（面板 +6%），在「显示」里拖动「浮层不透明度」即可单独定值，点「跟随面板」回到联动。
- **上传自己的图**：PNG / JPEG / WebP / GIF / AVIF，≤20 MB，多选，两段式删除。
- **重启不丢**：Desktop 版是 `--port 0`，每次启动浏览器 origin 都变，所以图片与选择存在 **Host 侧**（`<DSH_HOME>/dsh-wallpaper-desktop/`），不用 localStorage / IndexedDB。
- **可换字体（0.6）**：随包带霞鹜文楷 / 思源宋体 / 思源黑体（各一个字重，GB2312 子集，共约 3.7 MB，OFL 许可，许可证随包分发）；在「壁纸 → 字体」里点卡片即时切换，代码块/终端保持等宽字体；生僻字回退系统字体。字体走 Host 的 `/dsh-wallpaper/fonts/*` 只读路由（immutable 缓存 + sha256 ETag），不塞进 JS bundle。
- **字号缩放（0.6）**：90–110% 滑杆同时缩放界面排版 token（`--dsw-font-*`）与正文/代码/终端字号变量；只改 CSS 变量，不触发主题重发布。

## 安装

### 从 GitHub 安装（推荐）

在 Harness 里让 Agent 执行 `plugin_manager`：

```
action: install_bundle
target: github:cd-feng/dsh-wallpaper
```

装完**完全退出并重启 DeepSeek Harness**：浏览器半侧可以 HMR 热更，但 Host 半侧（图片库路由）要重启进程才会挂上。

### 本地开发安装

```sh
dsh plugin add link:/绝对路径/dsh-wallpaper
```

改动后的工作流：

```sh
node scripts/build-client.mjs     # 改浏览器半 → 生成 lib/client.js，HMR 生效
node --test tests/*.test.mjs      # 行为测试
```

改了 Host 半（`lib/index.js`）需要重启 Harness 才会加载新的 JavaScript 模块。

### 卸载

```
action: remove_bundle
target: dsh-wallpaper
```

图片数据留在 `<DSH_HOME>/dsh-wallpaper-desktop/`，想彻底清掉手动删该目录即可。

## 快速上手

`设置 → 壁纸`（order 5，与「通用」同级）

- **背景**：官方（默认，deepseek.com 首页云海 + 细网格）/ 极光（随明暗切换）
- **我的图片**：上传、点卡片设为壁纸、两段式删除
- **字体**：系统字体 / 霞鹜文楷 / 思源宋体 / 思源黑体 四张预览卡 + 字号缩放（90–110%）
- **显示**：面板不透明度（20–100%，同时作用于输入框、气泡、代码块与交付卡片）、浮层不透明度（20–100%，默认跟随面板 +6%，可单独覆盖）、背景模糊（0–24px）
- **恢复默认**

滑杆改动 debounce 220ms 后回写 Host，本地即时生效。

## 数据存储

| 数据 | 位置 | 说明 |
|---|---|---|
| 选择 + 滑杆值 + 字体 | `<DSH_HOME>/dsh-wallpaper[-desktop]/config.json` | Host 是唯一权威，浏览器只在内存里留快照；含 `fontId` / `fontScale` |
| 上传的图片 | `<DSH_HOME>/dsh-wallpaper[-desktop]/images/<id>.<ext>` | 原样保存，不压缩、不转码、不上传服务器 |
| 图片索引 | `<DSH_HOME>/dsh-wallpaper[-desktop]/library.json` | sha256（做 ETag）、尺寸、原始文件名、时间 |
| 内置壁纸 | 打进 `lib/client.js` 的 data URI | 四张 webp（官方/极光 × 亮/暗），共约 58 KB |
| 打包字体 | 插件包 `fonts/`（woff2 + manifest + OFL 许可证） | Host 只读路由提供，不进 bundle；子集由 `npm run fonts` 生成并提交 |

`<DSH_HOME>` 默认 `~/.dsh`，可用环境变量覆盖；desktop / web profile 分开存。

## HTTP 接口

所有路由都 fence 到「同源 loopback」请求（`Host` 头、loopback 对端、`sec-fetch-site`、`Origin`），因为 plugin 路由不经过 Web 页面自身的登录鉴权。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-wallpaper/state` | `{ config, images, fonts }`，客户端启动时拉一次（`fonts` 来自 manifest） |
| PATCH | `/dsh-wallpaper/config` | 局部更新 `{ mode, customId, panelOpacity, blur, fontId, fontScale }`，返回 state |
| POST | `/dsh-wallpaper/library` | body 为图片原始字节；`content-type` 声明类型、`x-filename` 为 `encodeURIComponent(文件名)`；按 magic bytes 校验；成功后自动选中 |
| DELETE | `/dsh-wallpaper/library/<id>` | 删图；删到当前壁纸时选择回退到内置 |
| GET | `/dsh-wallpaper/assets/<id>` | 图片字节，`immutable` 缓存 + sha256 ETag |
| GET/HEAD | `/dsh-wallpaper/fonts/<file>` | 打包字体 / 预览子集 / OFL 文本；文件名必须出现在 manifest 里，`immutable` 缓存 + sha256 ETag/304 |

## 开发

```sh
npm run check        # 重新生成 bundle + 校验字体载荷 + 语法检查 + 46 条行为测试
npm test             # 只跑测试
npm run build        # 只重新生成 lib/client.js（内联壁纸 data URI + 字体 manifest）
npm run fonts        # 重新生成打包字体（仅换字体源时需要；需 fonttools + brotli + 网络）
                     # 源与版本固定在 scripts/fonts.config.mjs；产物 woff2/manifest 提交进仓库
npm run fonts:check  # 校验 fonts/ 与 manifest 的 sha256 / 字节数 / woff2 魔数
npm run wallpapers   # 重画内置壁纸（需 python3 + `pip install pillow numpy`；固定种子可复现）
                     # 官方款：官网同款配色 + 域扭曲 fBm 云絮；极光款：原装饰版
```

CI 在 Node 22 / 24 上跑语法检查与测试，校验重建后的 `lib/client.js` 与提交内容一致（防止忘记 `npm run build`），并校验 `fonts/` 与 manifest 的 sha256 一致。

## 目录结构

```
dsh-wallpaper/
├── package.json                 # dsh.bundle.patch + dsh.client（platform: web, immediately: true）
├── cordis.patch.yml             # 把 wallpaper 行插入 web 插件名册
├── lib/index.js                 # Host 半：数据目录、文件存储、/dsh-wallpaper/* 路由、请求 fence
├── lib/client.js                # 浏览器半（构建产物，提交进仓库）
├── src/client.template.js       # 浏览器半源码（WALLPAPERS / FONTS / FONT_TOKENS 占位符构建时替换）
├── src/typography.tokens.json   # 从 Harness 基础样式提取的可缩放排版 token 表
├── scripts/build-client.mjs     # 内联壁纸 data URI + 字体清单 + 一致性校验
├── scripts/build-fonts.mjs      # 下载固定版本字体源 → 子集化 → 写 fonts/manifest.json
├── scripts/subset-fonts.py      # fonttools 子集（GB2312 + 拉丁 + 标点 → woff2）
├── scripts/check-fonts.mjs      # 校验已提交字体载荷与 manifest 一致
├── scripts/make-wallpapers.py   # 生成内置壁纸（Pillow + numpy）
├── fonts/                       # 3 款 woff2 + 预览子集 + manifest.json + licenses/*.txt
├── tests/client-behavior.test.mjs   # 浏览器半行为测试（假 DOM / React / fetch）
├── tests/host-routes.test.mjs       # Host 路由、fence、上传校验、重启持久性
├── locale/{zh,en}.json          # 插件市场标题/描述 + 设置页文案
├── wallpapers/                  # official-*.webp / aurora-*.webp（2400×1500，11–20 KiB）+ *.thumb.webp（336×210）
└── icon.svg                     # 插件图标
```

## 实现要点

| 需要解决的问题 | 做法 |
|---|---|
| 官方「纯色背景」是谁画的 | 会话列 `_centerCol` / 底部行 `.bottomRow` 用 `--dsw-alias-bg-base`；侧栏 `_sidebarCol` 用自己的填充令牌，macOS 下还带 40% 透明渐变 |
| 壁纸放在哪 | `body::before`：`position:fixed; inset:0; z-index:-1; pointer-events:none`，在全部内容之下、画布之上 |
| 官网页面的云海与网格 | 云海烤成 webp（deepseek.com 首页的浅蓝渐层 + 流场粒子 → 静态 fBm，整图实测中位色约 `#e1e9f6`）；网格是 CSS 的两条 `repeating-linear-gradient`，叠在图片上方（1.25/1.5 DPR 会抗锯齿，模糊 > 0 时也会被一起糊掉） |
| 让壁纸透出来 | `theme.overrideTokens('dsh-wallpaper', { '--dsw-alias-bg-base': { light, dark } })`；侧栏另用 `[class*="_sidebarCol"]` 规则覆盖 |
| 上传图片怎么上屏 | 存 Host 文件，客户端把 `/dsh-wallpaper/assets/<id>` 直接写进 `body::before` 的 `background-image`（同源、可缓存、无 object URL 生命周期） |
| 重启不丢 | Host 写盘（`config.json` / `library.json` / `images/`）；浏览器侧完全不依赖 origin 级存储 |
| 卸载即还原 | 样式表、token 层、body 标记、媒体查询监听、debounce 定时器全部注册在 `ctx.effect` 的清理里；Host 路由用 `webServer.register` 的 disposer 释放 |
| 设置页 | `ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id: 'wallpaper', order: 5, label }, Page))`；页面 CSS 在 `ctx.effect` 里注入一次，不进每次渲染 |
| 服务方法绑定 | `ctx.locale.subscribe` / `getSnapshot` 必须包一层再交给 `useSyncExternalStore`，直接传会丢 `this`、整页渲染崩 |
| 侧栏通透 | 除了 `[class*="_sidebarCol"]`，还覆盖官方令牌 `--dsw-specific-sidebar-fill`（Windows 标题栏也读它）；透明通道由 `--dwp-sidebar-*` 驱动 |
| 输入框 / 气泡 / 代码块 / 交付卡片怎么透 | token 层把 `--dsw-specific-input-major` / `--dsw-specific-bubble` / `--dsw-alias-markdown-code-block(-banner)` 改成 `rgba(..., var(--dwp-surface-alpha))`；交付卡片用 `color-mix()` 把自身 fill 混入 `--dwp-surface-mix`；`--dwp-surface-alpha` = 面板 alpha +0.06，除非 `surfaceOpacity` 显式覆盖；输入框再加 `backdrop-filter:blur(28px)`，避免滚动正文透出来 |
| 拖动滑杆不卡 | 带图片 data URI 的结构样式只在换壁纸时重写；透明度/模糊/缩放走 `--dwp-*` 自定义属性；所有重绘经 `requestAnimationFrame` 合并，一帧最多一次；token 层只在取整后的透明度变化时才重新注册 |
| 字体怎么上屏 | Harness 的排版 token 全部经过 `--dsw-font-family → var(--dsh-font-family-text, …)`；插件在 `<html>` 上设 `--dsh-font-family-text` 并注入 `@font-face`，不重发布主题、不动品牌字体。代码字体（`--dsh-font-family-code`）保持系统等宽 |
| 字号缩放不重排主题 | 从 Harness 基础样式提取 51 个可缩放排版 token（`--dsw-font-*`），按比例重写 px；这些 token 与正文/代码/终端字号都写在 `<body>` 内联变量上（Harness 把它们声明在 body，主题 presenter 也写 body，故监听 `theme/change` 在下一帧覆盖）。只改自定义属性，不 bump theme revision |
| 字体文件不发胖 bundle | 字体由 Host 路由按需返回；`@font-face` 先全部声明、浏览器只下载真正用到的字体；设置页预览用 3–6 KB 的字符子集，选中才拉完整字体 |
| Host 连不上可自愈 | 页面在宿主半未加载时给出「重试」按钮；单张图上传失败只报该文件，不会把整个图库判成不可用 |

## 性能

壁纸是常驻的全屏图层，所以这块专门收了口：

- **样式重建**：`body::before` 的规则里带着内联 webp，只在切换壁纸（官方 / 极光 / 某张自定义图）时重写一次；拖动滑杆只改 `--dwp-panel-alpha` / `--dwp-filter` / `--dwp-transform` / `--dwp-sidebar-*` 这些自定义属性。
- **主题层不参与拖动**：`theme.overrideTokens` 会 bump revision 并让每个主题消费者重渲染，所以 token 只在启用时注册一次，透明度用 `rgba(..., var(--dwp-panel-alpha))` 从 CSS 变量读——拖滑杆不触发任何 `theme/change`。
- **输入框毛玻璃**：只有输入框卡片用了 `backdrop-filter`（28px，面积小）；气泡与交付卡片走纯 alpha 的 `color-mix`，不建 filter 图层。
- **重绘合并**：所有状态变化走 `requestAnimationFrame` 合并，一帧最多重绘一次；快速拖动 100+ 次/秒的触控板也不会把主线程刷满。
- **默认不建额外图层**：模糊为 0 时 `filter/transform` 都是 `none`，浏览器不分配 filter 渲染面、也不多一层合成层；模糊 > 0 才按 `3×blur/视口` 动态放大，避免边缘露底。
- **缩略图**：设置页 168 px 卡片用 336×210 的缩略图（内置图各约 700 B），不会为一张卡片解码 13.7 MB 大图。
- **磁盘/网络**：`PATCH` 220 ms 防抖（拖动期间 0 次写、松手 1 次）；资产读取是异步 `readFile` + 32 MB LRU，304 直接用元数据里的 ETag 判定、不读文件，不再阻塞 Host 事件循环；同值 PATCH 不落盘。
- **内存**：每张 2400×1500 内置图解码约 13.7 MB，只有当前明暗的那张被解码；上传超过 4000 万像素直接拒绝（否则解码可能吃掉几百 MB）。
- **字体按需加载**：`@font-face` 只声明不下载；设置页预览卡用 3–6 KB 的预览子集，点选后才拉对应字体文件（1.0–1.5 MB，本地回环）；字体文件 `immutable` + sha256 ETag，二次加载 304。
- **字号缩放只写变量**：51 个 token + 3 个 body 字号变量，一次缩放 54 次属性写入，不重建样式表、不触发 `theme/change`。
- **已知取舍**：模糊值调得越大，全屏图层重绘越贵；想要最省就用默认的 0。自定义图的缩略图仍是原图缩放，图特别大时打开设置会有一次解码尖峰。

## 已知边界

- 侧栏选择器 `[class*="_sidebarCol"]` 依赖上游布局的 css-modules 局部名；上游大改版时需复核，失效只会退回官方底色，不破坏布局。
- 交付卡片（「已编辑 N 个文件」）的透明规则依赖上游 `vdszpW_*` / `IBlBFq_*` 局部名；上游升级改名会退回实色卡片，不影响功能。与侧栏 `_sidebarCol` 同类风险。
- 图片原样保存不压缩，接近 20 MB 的图会占磁盘；显示层用 `background-size:cover` 缩放。
- 上传是整文件 POST，没有进度条（本地回环很快）；失败在页面行内报错。
- 同一时刻只有一张「当前壁纸」：自定义图库可以有多张，但明暗共用一个图。
- 「官方」是照着 deepseek.com 当前首页配色烘的静态图，官网改版不会自动跟；要跟就重跑 `npm run wallpapers` 改预设。
- 上传动图（GIF/AVIF/动画 WebP）会让全屏背景逐帧解码，建议用静态图。
- 自定义图的缩略图直接复用原图，没有服务端缩放。
- 两个 Host 进程同时指向同一数据目录时不会合并写入（正常只有一个 Desktop 进程）；手改文件后需重启 Host 半才会重新读盘。
- 字体子集只覆盖 GB2312（6763 汉字）+ 拉丁/标点/全角；生僻字回退系统字体，混排时字形会有差异。只打包 400 字重，`font-weight:500/600` 由浏览器合成加粗，观感略逊于真粗体。
- 若曾在 Harness 原生「外观 → 字体」里设置了正文字体，那边的 `<body>` 内联值优先级更高，会盖住插件的选择；把原生设置清空即可。
- 字号缩放作用于 Harness 的排版 token 与正文/代码/终端字号；图标、间距不缩放（是「字号缩放」而不是界面缩放）。
- 行为测试覆盖 46 条契约，**不覆盖观感**——颜色、通透度、字体是否好看要人眼看。

## 数据完整性

- 写盘顺序是「先持久化、后改内存」：`PATCH` / 上传 / 删除任一步失败都会回滚元数据，不会出现「返回 500 但状态变了」或重启后丢图。
- 原子写带 `fsync` + 临时文件 + `rename`，异常时清理临时文件；读取失败与文件不存在分开处理。
- `library.json` / `config.json` 损坏时改名 `.corrupt-<时间戳>` 保留，不会被静默重置；设置页顶部会显示 Host 返回的警告，图库读不出来时拒绝覆盖用户的选择。
- 数据目录 `0700`、文件 `0600`；资产路由只服务普通文件，符号链接直接 404。
- 服务端也解析图片头并拒绝 > 4000 万像素的上传（不只是浏览器端检查），直接 POST 也绕不过去。
- `GET /state` 只读：默认文件在插件挂载时创建，读接口没有写副作用。

## License

插件本体 [MIT](./LICENSE)。打包字体各自遵循 SIL Open Font License 1.1，许可证全文在 `fonts/licenses/`：

| 字体 | 来源 | 许可证 |
|---|---|---|
| 霞鹜文楷 LXGW WenKai | [lxgw/LxgwWenKai](https://github.com/lxgw/LxgwWenKai) v1.530 | SIL OFL 1.1 |
| 思源宋体 Noto Serif SC | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notoserifsc) | SIL OFL 1.1 |
| 思源黑体 Noto Sans SC | [google/fonts](https://github.com/google/fonts/tree/main/ofl/notosanssc) | SIL OFL 1.1 |

woff2 为原字体按 GB2312 等字符集子集化后的衍生文件，保留 OFL 许可与原始版权声明，未使用保留字体名。
