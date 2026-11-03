# dsh-wallpaper

给 [DeepSeek Harness](https://github.com/deepseek-ai) 换一张真正的背景图：官方界面的深/浅纯色底换成壁纸。设置里多一个和「通用」同级、序号 5 的「壁纸」页——内置「官方」（复刻 [deepseek.com](https://www.deepseek.com/) 首页的云海底纹 + 细网格，默认）与「极光」两套，也能上传自己的图片，并可调面板通透度与背景模糊。

![CI](https://github.com/cd-feng/dsh-wallpaper/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-%E2%89%A50.2.1--rc.1-4B6BFB)

## 特性

- **装完即用**：`lib/client.js` 已生成并随包提交；内置壁纸以 data URI 内联，不额外起资源路由。
- **官方同款**：默认壁纸照着 deepseek.com 首页烤的——`#9cc1e7 → 透明` 的蓝色天幕、域扭曲 fBm 云絮、中心亮斑，网格用 CSS 重复渐变叠（不烘进位图，缩放不起摩尔纹）。
- **官方机制上屏**：`ctx.theme.overrideTokens()` 把 `--dsw-alias-bg-base` 换成半透明 rgba，`body::before` 固定层画图；插件禁用/卸载时全部自动回滚，不留脏样式。
- **跟随明暗**：每套内置壁纸都有亮色、深色两张，随 Harness「外观配色」自动切换；上传的图片同时用于两种配色。
- **跟随系统**：系统开启「降低透明度」时自动暂停壁纸，关掉后自动恢复。
- **上传自己的图**：PNG / JPEG / WebP / GIF / AVIF，≤20 MB，多选，两段式删除。
- **重启不丢**：Desktop 版是 `--port 0`，每次启动浏览器 origin 都变，所以图片与选择存在 **Host 侧**（`<DSH_HOME>/dsh-wallpaper-desktop/`），不用 localStorage / IndexedDB。

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
- **显示**：面板不透明度（20–100%）、背景模糊（0–24px）
- **恢复默认**

滑杆改动 debounce 220ms 后回写 Host，本地即时生效。

## 数据存储

| 数据 | 位置 | 说明 |
|---|---|---|
| 选择 + 滑杆值 | `<DSH_HOME>/dsh-wallpaper[-desktop]/config.json` | Host 是唯一权威，浏览器只在内存里留快照 |
| 上传的图片 | `<DSH_HOME>/dsh-wallpaper[-desktop]/images/<id>.<ext>` | 原样保存，不压缩、不转码、不上传服务器 |
| 图片索引 | `<DSH_HOME>/dsh-wallpaper[-desktop]/library.json` | sha256（做 ETag）、尺寸、原始文件名、时间 |
| 内置壁纸 | 打进 `lib/client.js` 的 data URI | 四张 webp（官方/极光 × 亮/暗），共约 58 KB |

`<DSH_HOME>` 默认 `~/.dsh`，可用环境变量覆盖；desktop / web profile 分开存。

## HTTP 接口

所有路由都 fence 到「同源 loopback」请求（`Host` 头、loopback 对端、`sec-fetch-site`、`Origin`），因为 plugin 路由不经过 Web 页面自身的登录鉴权。

| 方法 | 路径 | 作用 |
|---|---|---|
| GET | `/dsh-wallpaper/state` | `{ config, images }`，客户端启动时拉一次 |
| PATCH | `/dsh-wallpaper/config` | 局部更新 `{ mode, customId, panelOpacity, blur }`，返回 state |
| POST | `/dsh-wallpaper/library` | body 为图片原始字节；`content-type` 声明类型、`x-filename` 为 `encodeURIComponent(文件名)`；按 magic bytes 校验；成功后自动选中 |
| DELETE | `/dsh-wallpaper/library/<id>` | 删图；删到当前壁纸时选择回退到内置 |
| GET | `/dsh-wallpaper/assets/<id>` | 图片字节，`immutable` 缓存 + sha256 ETag |

## 开发

```sh
npm run check        # 重新生成 bundle + 语法检查 + 24 条行为测试
npm test             # 只跑测试
npm run build        # 只重新生成 lib/client.js（内联壁纸 data URI）
npm run wallpapers   # 重画内置壁纸（需 python3 + `pip install pillow numpy`；固定种子可复现）
                     # 官方款：官网同款配色 + 域扭曲 fBm 云絮；极光款：原装饰版
```

CI 在 Node 20 / 22 上跑语法检查与测试，并校验重建后的 `lib/client.js` 与提交内容一致（防止忘记 `npm run build`）。

## 目录结构

```
dsh-wallpaper/
├── package.json                 # dsh.bundle.patch + dsh.client（platform: web, immediately: true）
├── cordis.patch.yml             # 把 wallpaper 行插入 web 插件名册
├── lib/index.js                 # Host 半：数据目录、文件存储、/dsh-wallpaper/* 路由、请求 fence
├── lib/client.js                # 浏览器半（构建产物，提交进仓库）
├── src/client.template.js       # 浏览器半源码（WALLPAPERS 占位符构建时替换）
├── scripts/build-client.mjs     # 内联壁纸 data URI + 一致性校验
├── scripts/make-wallpapers.py   # 生成内置壁纸（Pillow + numpy）
├── tests/client-behavior.test.mjs   # 浏览器半行为测试（假 DOM / React / fetch）
├── tests/host-routes.test.mjs       # Host 路由、fence、上传校验、重启持久性
├── locale/{zh,en}.json          # 插件市场标题/描述 + 设置页文案
├── wallpapers/                  # official-*.webp / aurora-*.webp（2400×1500，12–21 KB）
└── icon.svg                     # 插件图标
```

## 实现要点

| 需要解决的问题 | 做法 |
|---|---|
| 官方「纯色背景」是谁画的 | 会话列 `_centerCol` / 底部行 `.bottomRow` 用 `--dsw-alias-bg-base`；侧栏 `_sidebarCol` 用自己的填充令牌，macOS 下还带 40% 透明渐变 |
| 壁纸放在哪 | `body::before`：`position:fixed; inset:0; z-index:-1; pointer-events:none`，在全部内容之下、画布之上 |
| 官网页面的云海与网格 | 云海烤成 webp（deepseek.com 的 `#9cc1e7` 天幕 + 流场粒子 → 静态 fBm）；网格是 CSS 的两条 `repeating-linear-gradient`，叠在图片上方的背景层，任意 DPI 都是 1px |
| 让壁纸透出来 | `theme.overrideTokens('dsh-wallpaper', { '--dsw-alias-bg-base': { light, dark } })`；侧栏另用 `[class*="_sidebarCol"]` 规则覆盖 |
| 上传图片怎么上屏 | 存 Host 文件，客户端把 `/dsh-wallpaper/assets/<id>` 直接写进 `body::before` 的 `background-image`（同源、可缓存、无 object URL 生命周期） |
| 重启不丢 | Host 写盘（`config.json` / `library.json` / `images/`）；浏览器侧完全不依赖 origin 级存储 |
| 卸载即还原 | 样式表、token 层、body 标记、媒体查询监听、debounce 定时器全部注册在 `ctx.effect` 的清理里；Host 路由用 `webServer.register` 的 disposer 释放 |
| 设置页 | `ctx.slots.inject('settings.section', () => ctx.slots.register({ name, id: 'wallpaper', order: 5, label }, Page))`；页面 CSS 在 `ctx.effect` 里注入一次，不进每次渲染 |
| 服务方法绑定 | `ctx.locale.subscribe` / `getSnapshot` 必须包一层再交给 `useSyncExternalStore`，直接传会丢 `this`、整页渲染崩 |
| 拖动滑杆不卡 | 带图片 data URI 的结构样式只在换壁纸时重写；透明度/模糊/缩放走 `--dwp-*` 自定义属性；所有重绘经 `requestAnimationFrame` 合并，一帧最多一次；token 层只在取整后的透明度变化时才重新注册 |
| Host 连不上可自愈 | 页面在宿主半未加载时给出「重试」按钮；单张图上传失败只报该文件，不会把整个图库判成不可用 |

## 性能

壁纸是常驻的全屏图层，所以这块专门收了口：

- **样式重建**：`body::before` 的规则里带着两张内联 webp（约 38 KB base64），只在切换壁纸（官方 / 极光 / 某张自定义图）时重写一次；拖动滑杆只改 `--dwp-blur` / `--dwp-scale` / `--dwp-sidebar-*` 四个自定义属性。
- **重绘合并**：所有状态变化走 `requestAnimationFrame` 合并，一帧最多重绘一次；快速拖动 100+ 次/秒的触控板也不会把主线程刷满。
- **token 层**：`theme.overrideTokens` 会让整个应用重算样式，因此只在取整后的不透明度变化时重新注册（`0.01` 级别的抖动不会触发）。
- **磁盘**：`PATCH` 有 220 ms 防抖，拖动滑杆最多约 4 次/秒落盘；上传图片走 `immutable` 缓存 + sha256 ETag，页面重载不会重复读盘。
- **内存**：每张 2400×1500 的内置图画出来约 13.7 MB 解码位图，只有当前明暗用的那一张（加另一种配色）会被解码；模糊 > 0 会让合成器多一层全屏纹理，默认 0 时不额外建层。
- **已知取舍**：模糊值调得越大，全屏图层重绘越贵；想要最省就用默认的 0。

## 已知边界

- 侧栏选择器 `[class*="_sidebarCol"]` 依赖上游布局的 css-modules 局部名；上游大改版时需复核，失效只会退回官方底色，不破坏布局。
- 图片原样保存不压缩，接近 20 MB 的图会占磁盘；显示层用 `background-size:cover` 缩放。
- 上传是整文件 POST，没有进度条（本地回环很快）；失败在页面行内报错。
- 同一时刻只有一张「当前壁纸」：自定义图库可以有多张，但明暗共用一个图。
- 「官方」是照着 deepseek.com 当前首页配色烘的静态图，官网改版不会自动跟；要跟就重跑 `npm run wallpapers` 改预设。
- 行为测试覆盖 26 条契约，**不覆盖观感**——颜色、通透度是否好看要人眼看。

## License

[MIT](./LICENSE)
