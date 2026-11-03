/**
 * dsh-wallpaper — browser half.
 *
 * 把 Harness 的纯色底换成壁纸：内置极光图（随明暗切换）或用户上传的本机图片。
 *
 * 设计要点：
 * - 背景层是 `body::before` 的 fixed 伪元素，永远垫在所有内容下面；同时用
 *   `ctx.theme.overrideTokens` 把 `--dsw-alias-bg-base` 换成半透明，
 *   否则官方面板那层实色会把壁纸整个挡住。
 * - 图片和选择都存在 Host 侧（`/dsh-wallpaper/*` 路由 + DSH 数据目录），因为
 *   桌面版是 `--port 0`：每次重启浏览器 origin 都变，localStorage / IndexedDB
 *   靠不住。浏览器这边只保留一份内存快照。
 * - 一切副作用（样式表、token 层、body 标记、媒体监听、定时器）都注册在
 *   `ctx.effect` 的清理函数里，禁用插件即完全回滚。
 *
 * 注意：浏览器半侧拿不到 `ctx.locale.subscribe` 这类服务方法的 this，必须包一层
 * 再交给 `React.useSyncExternalStore`（直接传会抛 "Cannot read properties of
 * undefined"，整页渲染失败）。
 */

window.__ModuleLoader__.load({
  id: "dsh-wallpaper",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;

    const BODY_ATTR = "data-dsh-wallpaper";
    const THEME_SOURCE = "dsh-wallpaper";
    const CSS_TAG_ID = "dsh-wallpaper/global.css";
    const CSS_TAG_ID_BY_FEATURE = "dsh-wallpaper/page.css";
    const SECTION_ID = "wallpaper";
    const NS = "settings.wallpaper";
    const API = "/dsh-wallpaper";

    const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
    // 40 MP keeps the decoded RGBA around 160 MB instead of "whatever fits in 20 MB".
    const MAX_PIXELS = 40 * 1000 * 1000;
    const ALLOWED_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif", "image/avif"];
    const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

    const OPACITY_MIN = 20;
    const OPACITY_MAX = 100;
    const BLUR_MIN = 0;
    const BLUR_MAX = 24;
    const PERSIST_DELAY = 220;
    const DEFAULTS = Object.freeze({ mode: "official", customId: null, panelOpacity: 52, blur: 0 });

    // Injected by scripts/build-client.mjs:
    //   { aurora: { light, dark, thumb }, official: { light, dark, thumb } }
    // `thumb` is a 336x210 bake, so a 168 px card never decodes a 2400x1500 image.
    const WALLPAPERS = /* __WALLPAPERS__ */ null;
    const THUMB_OFFICIAL = `url("${WALLPAPERS.official.thumb}")`;
    const THUMB_AURORA = `url("${WALLPAPERS.aurora.thumb}")`;

    // ---------------------------------------------------------------- locale

    const ZH = {
      nav: "壁纸",
      title: "壁纸",
      intro: "内置「官方」与「极光」两套壁纸，也可以上传自己的图片。上传的图片保存在本机 DSH 数据目录，不会上传到服务器。",
      sectionBackground: "背景",
      sectionMine: "我的图片",
      sectionDisplay: "显示",
      optionOfficial: "官方",
      optionOfficialDesc: "deepseek.com 首页的云海底纹",
      optionBuiltin: "极光",
      optionBuiltinDesc: "随明暗自动切换",
      selected: "使用中",
      upload: "上传图片",
      uploading: "正在读取…",
      reset: "恢复默认",
      delete: "删除",
      confirmDelete: "确认删除",
      empty: "还没有上传图片，点「上传图片」添加。",
      loading: "正在读取本机图片…",
      retry: "重试",
      hostUnavailable: "壁纸服务还没启动。请重启 DeepSeek Harness 让插件 Host 半加载后再试。",
      uploadRejected: "这些文件没有导入：",
      reasonType: "不是支持的图片格式",
      reasonSize: "超过 20 MB",
      reasonPixels: "像素太大（超过 4000 万像素）",
      opacity: "面板不透明度",
      blur: "背景模糊",
      sliderValue: "{value}%",
      blurValue: "{value}px",
      hintReduced: "系统开启了「降低透明度」，壁纸已暂停。",
      hintMissing: "选中的图片已不存在，当前显示内置壁纸。",
      hintLocal: "图片保存在插件数据目录（<DSH_HOME>/dsh-wallpaper[-desktop]/images/），清掉即可删除。",
      saveFailed: "设置没有写进磁盘：{error}",
      dataWarning: "本地数据文件有问题：{warning}",
      saveRetry: "重新保存",
      bytes: "B",
      kilobytes: "KB",
      megabytes: "MB",
    };

    const EN = {
      nav: "Wallpaper",
      title: "Wallpaper",
      intro: "Two built-in wallpapers — the official deepseek.com clouds and an aurora — or your own images. Uploads live in the local DSH data directory and never leave this machine.",
      sectionBackground: "Background",
      sectionMine: "My images",
      sectionDisplay: "Display",
      optionOfficial: "Official",
      optionOfficialDesc: "The deepseek.com homepage clouds",
      optionBuiltin: "Aurora",
      optionBuiltinDesc: "Switches with light / dark",
      selected: "In use",
      upload: "Upload image",
      uploading: "Reading…",
      reset: "Reset to defaults",
      delete: "Delete",
      confirmDelete: "Confirm delete",
      empty: "No images yet — use “Upload image” to add one.",
      loading: "Reading local images…",
      retry: "Retry",
      hostUnavailable: "The wallpaper service is not running yet. Restart DeepSeek Harness so the plugin's Host half loads, then try again.",
      uploadRejected: "These files were skipped:",
      reasonType: "unsupported image format",
      reasonSize: "larger than 20 MB",
      reasonPixels: "larger than 40 megapixels",
      opacity: "Panel opacity",
      blur: "Background blur",
      sliderValue: "{value}%",
      blurValue: "{value}px",
      hintReduced: "The system “reduce transparency” setting is on, so the wallpaper is paused.",
      hintMissing: "The selected image is gone; showing the built-in wallpaper.",
      hintLocal: "Images live in the plugin data directory (<DSH_HOME>/dsh-wallpaper[-desktop]/images/); remove it to delete them.",
      saveFailed: "Settings were not written to disk: {error}",
      dataWarning: "Local data file problem: {warning}",
      saveRetry: "Save again",
      bytes: "B",
      kilobytes: "KB",
      megabytes: "MB",
    };

    // ----------------------------------------------------------------- utils

    function clamp(value, min, max, fallback) {
      if (value === null || value === undefined || value === "") return fallback;
      const number = Number(value);
      if (!Number.isFinite(number)) return fallback;
      return Math.min(max, Math.max(min, Math.round(number)));
    }

    function roundTo(value, digits) {
      const factor = 10 ** digits;
      return Math.round(value * factor) / factor;
    }

    function formatBytes(size, t) {
      const bytes = Number(size);
      if (!Number.isFinite(bytes) || bytes <= 0) return "";
      if (bytes < 1024) return `${Math.round(bytes)} ${t("bytes")}`;
      if (bytes < 1024 * 1024) return `${roundTo(bytes / 1024, 1)} ${t("kilobytes")}`;
      return `${roundTo(bytes / (1024 * 1024), 1)} ${t("megabytes")}`;
    }

    function messageOf(error) {
      if (error instanceof Error && error.message !== "") return error.message;
      return String(error);
    }

    // ------------------------------------------------------------- Host state

    function requestJson(path, init) {
      return window.fetch(path, { credentials: "same-origin", cache: "no-store", ...init }).then(async (response) => {
        const text = await response.text();
        let payload = null;
        if (text !== "") {
          try {
            payload = JSON.parse(text);
          } catch {
            payload = null;
          }
        }
        if (!response.ok) {
          const message = payload !== null && typeof payload.error === "string" ? payload.error : `HTTP ${response.status}`;
          const error = new Error(message);
          error.status = response.status;
          throw error;
        }
        return payload;
      });
    }

    function normalizeState(raw) {
      const source = raw !== null && typeof raw === "object" ? raw : {};
      let mode = source.mode;
      if (mode !== "official" && mode !== "builtin" && mode !== "custom") mode = DEFAULTS.mode;
      const customId = typeof source.customId === "string" && ASSET_ID.test(source.customId) ? source.customId : null;
      if (mode === "custom" && customId === null) mode = DEFAULTS.mode;
      return {
        mode,
        customId,
        panelOpacity: clamp(source.panelOpacity, OPACITY_MIN, OPACITY_MAX, DEFAULTS.panelOpacity),
        blur: clamp(source.blur, BLUR_MIN, BLUR_MAX, DEFAULTS.blur),
      };
    }

    function sameState(a, b) {
      return a.mode === b.mode && a.customId === b.customId && a.panelOpacity === b.panelOpacity && a.blur === b.blur;
    }

    function createStore() {
      let state = Object.freeze(normalizeState(DEFAULTS));
      const listeners = new Set();
      let timer = 0;
      let inFlight = false;
      let queued = null;
      let disposed = false;
      let persistError = "";
      /** Host-reported data-file problem (`/state.warning`); empty when healthy. */
      let hostWarning = "";
      /** Bumped by every local change, so a slow PATCH cannot revert a fresh edit. */
      let revision = 0;

      const emit = () => {
        if (disposed) return;
        for (const listener of [...listeners]) listener();
      };

      const persist = () => {
        if (disposed || queued === null) return;
        if (inFlight) return;
        const body = queued;
        const sentRevision = revision;
        queued = null;
        inFlight = true;
        requestJson(`${API}/config`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        })
          .then((payload) => {
            if (disposed) return;
            if (persistError !== "") {
              persistError = "";
              emit();
            }
            if (revision !== sentRevision) return;
            if (payload !== null && typeof payload === "object" && payload.config !== undefined) {
              applyHost(payload.config);
            }
          })
          .catch((failure) => {
            // 本地值先留着，但要让用户知道没写盘；flush() 会再试一次。
            if (disposed) return;
            persistError = messageOf(failure);
            emit();
          })
          .finally(() => {
            inFlight = false;
            if (queued !== null) persist();
          });
      };

      const schedule = () => {
        if (disposed) return;
        queued = { ...state };
        if (timer !== 0) window.clearTimeout(timer);
        timer = window.setTimeout(() => {
          timer = 0;
          persist();
        }, PERSIST_DELAY);
      };

      /** Host 是权威：拉回/回写成功后同步本地快照，但不回写 Host，避免环路。 */
      const applyHost = (config) => {
        if (disposed) return;
        const next = normalizeState(config);
        if (sameState(next, state)) return;
        state = Object.freeze(next);
        emit();
      };

      return {
        get: () => state,
        applyHost,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set(patch) {
          const next = normalizeState({ ...state, ...patch });
          if (sameState(next, state)) return;
          revision += 1;
          state = Object.freeze(next);
          emit();
          schedule();
        },
        /** 保存失败的详情；空串表示已经落盘。 */
        persistError: () => persistError,
        /** Host 报告的数据文件问题；空串表示健康。 */
        warning: () => hostWarning,
        setWarning(message) {
          const next = typeof message === "string" ? message : "";
          if (next === hostWarning) return;
          hostWarning = next;
          emit();
        },
        /** 立即重试一次挂起的写入（页面「重新保存」）。 */
        flush() {
          if (disposed) return;
          if (queued === null && !inFlight) queued = { ...state };
          if (timer !== 0) {
            window.clearTimeout(timer);
            timer = 0;
          }
          persist();
        },
        dispose() {
          disposed = true;
          if (timer !== 0) window.clearTimeout(timer);
          timer = 0;
          queued = null;
        },
      };
    }

    function createLibrary(store) {
      let snapshot = { status: "loading", images: [], urls: new Map(), error: "" };
      const listeners = new Set();
      const patch = (next) => {
        const merged = { ...snapshot, ...next };
        if (next.images !== undefined) {
          merged.urls = new Map(merged.images.map((image) => [image.id, `${API}/assets/${image.id}`]));
        }
        snapshot = merged;
        for (const listener of [...listeners]) listener();
      };
      const normalizeImage = (raw) => ({
        id: typeof raw.id === "string" ? raw.id : "",
        name: typeof raw.name === "string" && raw.name !== "" ? raw.name : "image",
        mime: typeof raw.mime === "string" ? raw.mime : "",
        size: Number.isFinite(Number(raw.size)) ? Number(raw.size) : 0,
        addedAt: Number.isFinite(Number(raw.addedAt)) ? Number(raw.addedAt) : 0,
      });
      const applySnapshot = (payload) => {
        if (payload === null || typeof payload !== "object") return;
        if (Array.isArray(payload.images)) {
          patch({ status: "ready", images: payload.images.map(normalizeImage).filter((image) => ASSET_ID.test(image.id)), error: "" });
        }
        store.setWarning(payload.warning);
        if (payload.config !== undefined) store.applyHost(payload.config);
      };

      return {
        get: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        urlFor(id) {
          if (typeof id !== "string" || !ASSET_ID.test(id)) return null;
          return snapshot.urls.get(id) ?? null;
        },
        async load() {
          try {
            applySnapshot(await requestJson(`${API}/state`));
          } catch (error) {
            patch({ status: "error", error: messageOf(error) });
          }
        },
        async upload(file) {
          try {
            const payload = await requestJson(`${API}/library`, {
              method: "POST",
              headers: {
                "content-type": typeof file.type === "string" && file.type !== "" ? file.type : "application/octet-stream",
                "x-filename": encodeURIComponent(typeof file.name === "string" ? file.name : "wallpaper"),
              },
              body: file,
            });
            applySnapshot(payload);
          } catch (error) {
            // A failed upload is a per-file error, not an unreachable Host: keep
            // the library visible and let the page show the message.
            patch({ error: messageOf(error) });
            throw error;
          }
        },
        async remove(id) {
          try {
            applySnapshot(await requestJson(`${API}/library/${id}`, { method: "DELETE" }));
          } catch (error) {
            patch({ error: messageOf(error) });
            throw error;
          }
        },
      };
    }

    // ------------------------------------------------------------ wallpaper

    /**
     * A Gaussian blur of radius r bleeds ~3r px past the element box. Size the
     * upscale from the viewport so the feathered border stays off-screen instead
     * of a fixed 1.03 that only covers blur <= 4 at a 1440 px window.
     */
    function bleedScale(blur) {
      const width = typeof window.innerWidth === "number" ? window.innerWidth : 0;
      const height = typeof window.innerHeight === "number" ? window.innerHeight : 0;
      const viewport = Math.min(width > 0 ? width : 1280, height > 0 ? height : 800);
      return roundTo(1 + (3 * blur) / Math.max(viewport, 320), 4);
    }

    function opacityAlpha(state) {
      return roundTo(state.panelOpacity / 100, 3);
    }

    /**
     * The translucent panel colour, registered once. The alpha is a CSS variable
     * (`--dwp-panel-alpha`) instead of a baked number: the theme service bumps
     * its revision and emits `theme/change` on every override, which re-renders
     * every theme consumer — far too expensive to do on every slider frame. The
     * browser re-resolves `var()` inline, and `rgba()` clamps the dark +0.06.
     */
    function buildTokens() {
      // Two plain `var()` numbers, no `calc()`: the alpha slot takes a <number>
      // and a substituted number is the least surprising thing to hand a browser.
      return {
        "--dsw-alias-bg-base": {
          light: "rgba(255, 255, 255, var(--dwp-panel-alpha, 0.52))",
          dark: "rgba(21, 21, 23, var(--dwp-panel-alpha-dark, 0.58))",
        },
        // The documented sidebar token, so surfaces that read it (Windows
        // titlebar included) stay in sync with the translucent column.
        "--dsw-specific-sidebar-fill": {
          light: "rgba(249, 250, 251, var(--dwp-sidebar-light, 0.68))",
          dark: "rgba(27, 27, 28, var(--dwp-sidebar-dark, 0.74))",
        },
      };
    }

    function builtinPair(mode) {
      // 「官方」复刻 deepseek.com 首页的云海底纹；极光是另一套内置壁纸。
      return mode === "official" ? WALLPAPERS.official : WALLPAPERS.aurora;
    }

    function wallpaperUrls(state, customUrl) {
      if (state.mode === "custom" && customUrl !== null) {
        // Fallback under the upload: if the file is gone or undecodable the
        // browser drops to the next image instead of showing a transparent hole.
        const fallback = builtinPair("official");
        return { light: [customUrl, fallback.light], dark: [customUrl, fallback.dark] };
      }
      // 自定义图还没读到、或选择失效时，先用内置图占位。
      const pair = builtinPair(state.mode);
      return { light: [pair.light], dark: [pair.dark] };
    }

    const GRID_CELL = 56;
    // The site's grid is barely there; two thirds of a step above it and the
    // Harness panels start reading as graph paper.
    const GRID_LINE_LIGHT = "rgba(30, 41, 59, 0.018)";
    const GRID_LINE_DARK = "rgba(255, 255, 255, 0.028)";

    /**
     * The官网背景的细网格：烘焙进位图会在缩放时起摩尔纹，所以用 CSS 重复渐变叠在
     * 图片之上（第一层在最上面）。1px 在 1.25/1.5 DPR 会抗锯齿，而且 blur > 0 时
     * 网格和图片在同一层，也会被一起糊掉——想要绝对锐利就得拆成独立图层。
     */
    function gridLayers(line) {
      return [
        `repeating-linear-gradient(0deg, ${line} 0 1px, transparent 1px ${GRID_CELL}px)`,
        `repeating-linear-gradient(90deg, ${line} 0 1px, transparent 1px ${GRID_CELL}px)`,
      ];
    }

    function layerRule(images, layers) {
      const extras = layers ?? [];
      const urls = Array.isArray(images) ? images : [images];
      const layersCss = [...extras, ...urls.map((image) => `url("${image}")`)];
      return [
        `content:"";position:fixed;inset:0;z-index:-1;pointer-events:none`,
        `background-image:${layersCss.join(",")}`,
        `background-size:${[...extras.map(() => "auto"), ...urls.map(() => "cover")].join(",")}`,
        `background-position:${[...extras.map(() => "0 0"), ...urls.map(() => "center")].join(",")}`,
        `background-repeat:${[...extras.map(() => "repeat"), ...urls.map(() => "no-repeat")].join(",")}`,
        // Driven by custom properties: the blur slider then costs one property
        // write per frame instead of a 40 KB CSS re-parse.
        `filter:var(--dwp-filter, none);transform:var(--dwp-transform, none)`,
      ].join(";");
    }

    /**
     * Structural CSS: only the chosen artwork, the grid and the panel rules.
     * Everything that the sliders move lives in custom properties so a drag
     * never rebuilds (and re-parses) this string, which carries two inlined
     * 2400x1500 data URIs.
     */
    function buildCss(state, customUrl) {
      const urls = wallpaperUrls(state, customUrl);
      const grid = state.mode === "official";
      const sidebarGradientLight =
        "linear-gradient(90deg, rgba(255, 255, 255, 0) 0%, rgba(255, 255, 255, 0.4) 100%)";
      const sidebarGradientDark = "linear-gradient(90deg, rgba(0, 0, 0, 0) 0%, rgba(0, 0, 0, 0.25) 100%)";
      const rules = [
        // body 自己的不透明底色必须让位；html/body 的官方样式在 macOS 上本来就是透明。
        `body[${BODY_ATTR}]{background-color:transparent}`,
        `body[${BODY_ATTR}]::before{${layerRule(urls.light, grid ? gridLayers(GRID_LINE_LIGHT) : [])}}`,
        // 侧栏有自己的填充令牌和渐变，单独给一层半透明。
        `body[${BODY_ATTR}] [class*="_sidebarCol"]{background:${sidebarGradientLight},rgba(249, 250, 251, var(--dwp-sidebar-light, 0.68))}`,
      ];
      if (urls.dark.join("|") !== urls.light.join("|")) {
        rules.push(
          `body[${BODY_ATTR}][data-ds-dark-theme]::before{${layerRule(urls.dark, grid ? gridLayers(GRID_LINE_DARK) : [])}}`,
        );
      }
      rules.push(
        `body[${BODY_ATTR}][data-ds-dark-theme] [class*="_sidebarCol"]{background:${sidebarGradientDark},var(--dsw-specific-sidebar-fill)}`,
      );
      return rules.join("\n");
    }

    // ---------------------------------------------------------- settings page

    const PAGE_CSS = [
      ".dwp-root{max-width:760px;display:flex;flex-direction:column;gap:18px;font-size:13px;color:var(--dsw-alias-label-primary)}",
      ".dwp-head{display:flex;flex-direction:column;gap:5px}",
      ".dwp-title{margin:0;font-size:15px;font-weight:600;letter-spacing:.01em}",
      ".dwp-hint{margin:0;font-size:11px;line-height:1.65;color:var(--dsw-alias-label-secondary)}",
      ".dwp-section{display:flex;flex-direction:column;gap:9px}",
      ".dwp-sectionTitle{font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}",
      ".dwp-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(168px,1fr));gap:10px}",
      ".dwp-card{position:relative;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-1);transition:border-color .12s ease,box-shadow .12s ease}",
      ".dwp-card:hover{border-color:var(--dsw-alias-border-l2)}",
      ".dwp-card[data-selected]{border-color:var(--dsw-alias-brand-primary);box-shadow:0 0 0 1px var(--dsw-alias-brand-primary)}",
      ".dwp-cardSelect{appearance:none;display:flex;flex-direction:column;width:100%;padding:0;border:0;border-radius:9px;background:transparent;color:inherit;font:inherit;text-align:start;cursor:pointer}",
      ".dwp-cardSelect:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}",
      ".dwp-delete:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}",
      ".dwp-thumb{display:block;aspect-ratio:16/10;border-radius:9px 9px 0 0;overflow:hidden;background-size:cover;background-position:center;background-repeat:no-repeat}",
      ".dwp-cardLabel{display:flex;align-items:center;justify-content:space-between;gap:8px;padding:7px 9px;min-height:20px;font-size:11px;color:var(--dsw-alias-label-secondary)}",
      ".dwp-cardName{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}",
      ".dwp-badge{flex:0 0 auto;font-size:10px;color:var(--dsw-alias-brand-primary);border:1px solid var(--dsw-alias-brand-primary);border-radius:999px;padding:0 6px}",
      ".dwp-delete{position:absolute;top:6px;right:6px;appearance:none;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;padding:2px 8px;font-size:10px;line-height:1.5;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);cursor:pointer}",
      ".dwp-delete:hover{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}",
      ".dwp-actions{display:flex;align-items:center;gap:9px;flex-wrap:wrap}",
      ".dwp-btn{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;border-radius:8px;padding:5px 11px;cursor:pointer;transition:border-color .12s ease,opacity .12s ease}",
      ".dwp-btn:hover:not(:disabled){border-color:var(--dsw-alias-brand-primary)}",
      ".dwp-btn:disabled{opacity:.45;cursor:not-allowed}",
      ".dwp-btn:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:3px}",
      ".dwp-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:20px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px}",
      ".dwp-error{color:var(--dsw-alias-state-error-primary);font-size:12px;line-height:1.65;white-space:pre-wrap;word-break:break-word}",
      ".dwp-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:2px 0}",
      ".dwp-rowLabel{display:flex;flex-direction:column;gap:2px;min-width:0}",
      ".dwp-rowTitle{font-size:13px}",
      ".dwp-range{flex:0 1 200px;min-width:120px;accent-color:var(--dsw-alias-brand-primary)}",
      ".dwp-rowValue{flex:0 0 46px;text-align:end;font-size:11px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}",
      ".dwp-foot{display:flex;align-items:center;gap:9px;flex-wrap:wrap}",
    ].join("\n");

    function createPage(ctx, store, library) {
      // 服务方法必须包一层再交给 useSyncExternalStore：直接传会丢掉 this。
      const readLocale = () => ctx.locale.getSnapshot();
      const subscribeLocale = (onChange) => ctx.locale.subscribe(onChange);
      const readState = () => store.get();
      const readLibrary = () => library.get();

      return function WallpaperPage() {
        const state = React.useSyncExternalStore(store.subscribe, readState, readState);
        const snapshot = React.useSyncExternalStore(library.subscribe, readLibrary, readLibrary);
        React.useSyncExternalStore(subscribeLocale, readLocale, readLocale);
        const t = ctx.locale.bind(NS);

        const [pendingDelete, setPendingDelete] = React.useState(null);
        const [removingId, setRemovingId] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const [error, setError] = React.useState("");
        const [saveError, setSaveError] = React.useState(store.persistError());
        const [storeWarning, setStoreWarning] = React.useState(store.warning());
        const reducedHint = React.useSyncExternalStore(
          subscribeReducedTransparency,
          readReducedTransparency,
          readReducedTransparency,
        );
        const inputRef = React.useRef(null);

        const images = snapshot.images;
        const selectedMissing =
          state.mode === "custom" && snapshot.status === "ready" && library.urlFor(state.customId) === null;

        React.useEffect(() => {
          if (pendingDelete === null) return undefined;
          const timer = window.setTimeout(() => setPendingDelete(null), 3000);
          return () => window.clearTimeout(timer);
        }, [pendingDelete]);

        React.useEffect(
          () =>
            store.subscribe(() => {
              setSaveError(store.persistError());
              setStoreWarning(store.warning());
            }),
          [],
        );

        const pickFiles = () => {
          if (inputRef.current !== null) inputRef.current.click();
        };

        const onFiles = async (event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = "";
          if (files.length === 0) return;
          setBusy(true);
          setError("");
          const rejected = [];
          let firstId = null;
          for (const file of files) {
            const reason = await validateFile(file, t);
            if (reason !== null) {
              rejected.push(`${file.name}: ${reason}`);
              continue;
            }
            try {
              await library.upload(file);
              const uploaded = library.get().images[0];
              if (uploaded !== undefined && firstId === null) firstId = uploaded.id;
            } catch (failure) {
              rejected.push(`${file.name}: ${messageOf(failure)}`);
            }
          }
          setBusy(false);
          if (rejected.length > 0) setError(`${t("uploadRejected")}\n${rejected.join("\n")}`);
          if (firstId !== null && store.get().customId !== firstId) {
            store.set({ mode: "custom", customId: firstId });
          }
        };

        const removeImage = async (id) => {
          if (removingId !== null) return;
          setPendingDelete(null);
          setRemovingId(id);
          setError("");
          try {
            await library.remove(id);
          } catch (failure) {
            // 404 means another tab/click already removed it: refresh instead of scolding.
            if (/not found|404/i.test(messageOf(failure))) await library.load();
            else setError(messageOf(failure));
          } finally {
            setRemovingId(null);
          }
        };

        const selectedOfficial = state.mode === "official";
        const selectedBuiltin = state.mode === "builtin";

        const card = (options) =>
          h(
            "div",
            { className: "dwp-card", "data-selected": options.selected ? "" : undefined },
            h(
              "button",
              {
                key: "select",
                type: "button",
                className: "dwp-cardSelect",
                "aria-pressed": options.selected,
                title: options.title,
                onClick: options.onSelect,
              },
              h("span", {
                key: "thumb",
                className: options.thumbClass === undefined ? "dwp-thumb" : `dwp-thumb ${options.thumbClass}`,
                style: options.thumbStyle,
              }),
              h(
                "span",
                { key: "label", className: "dwp-cardLabel" },
                h("span", { className: "dwp-cardName", title: options.title }, options.name),
                options.selected ? h("span", { className: "dwp-badge" }, t("selected")) : null,
              ),
            ),
            options.onDelete === undefined
              ? null
              : h(
                  "button",
                  {
                    key: "delete",
                    type: "button",
                    className: "dwp-delete",
                    disabled: removingId !== null,
                    "aria-label": `${t("delete")} ${options.name}`,
                    onClick: () => {
                      if (pendingDelete === options.id) void removeImage(options.id);
                      else setPendingDelete(options.id);
                    },
                  },
                  pendingDelete === options.id ? t("confirmDelete") : t("delete"),
                ),
          );

        const builtinCard = card({
          id: "builtin",
          name: t("optionBuiltin"),
          title: t("optionBuiltinDesc"),
          selected: selectedBuiltin,
          thumbStyle: { backgroundImage: THUMB_AURORA },
          onSelect: () => store.set({ mode: "builtin" }),
        });

        const officialCard = card({
          id: "official",
          name: t("optionOfficial"),
          title: t("optionOfficialDesc"),
          selected: selectedOfficial,
          thumbStyle: { backgroundImage: THUMB_OFFICIAL },
          onSelect: () => store.set({ mode: "official" }),
        });

        const customCards = images.map((image) => {
          const url = library.urlFor(image.id);
          const selected = state.mode === "custom" && state.customId === image.id;
          return card({
            id: image.id,
            name: image.name,
            title: `${image.name}${image.size > 0 ? ` · ${formatBytes(image.size, t)}` : ""}`,
            selected,
            thumbStyle: url === null ? undefined : { backgroundImage: `url("${url}")` },
            onSelect: () => store.set({ mode: "custom", customId: image.id }),
            onDelete: true,
          });
        });

        const unavailable = snapshot.status === "error" && snapshot.error !== "";
        const libraryBody = unavailable
          ? h(
              "div",
              { className: "dwp-error", role: "alert" },
              `${t("hostUnavailable")}\n${snapshot.error}`,
              h(
                "button",
                { type: "button", className: "dwp-btn", onClick: () => void library.load() },
                t("retry"),
              ),
            )
          : snapshot.status === "loading"
            ? h("div", { className: "dwp-empty" }, t("loading"))
            : customCards.length === 0
              ? h("div", { className: "dwp-empty" }, t("empty"))
              : h("div", { className: "dwp-grid" }, customCards);

        const slider = (id, label, min, max, value, format) =>
          h(
            "label",
            { key: id, className: "dwp-row" },
            h("span", { className: "dwp-rowLabel" }, h("span", { className: "dwp-rowTitle" }, label)),
            h("input", {
              type: "range",
              className: "dwp-range",
              min,
              max,
              step: 1,
              value,
              "aria-label": label,
              onChange: (event) => store.set({ [id]: clamp(event.currentTarget.value, min, max, DEFAULTS[id]) }),
            }),
            h("span", { className: "dwp-rowValue" }, format(value)),
          );

        return h(
          "div",
          { className: "dwp-root" },
          h(
            "div",
            { className: "dwp-head" },
            h("h2", { className: "dwp-title" }, t("title")),
            h("p", { className: "dwp-hint" }, t("intro")),
            saveError === ""
              ? null
              : h(
                  "div",
                  { className: "dwp-error", role: "alert" },
                  `${t("saveFailed").replace("{error}", saveError)} `,
                  h(
                    "button",
                    { type: "button", className: "dwp-btn", onClick: () => store.flush() },
                    t("saveRetry"),
                  ),
                ),
          ),
          storeWarning === ""
            ? null
            : h("div", { className: "dwp-error", role: "status" }, t("dataWarning").replace("{warning}", storeWarning)),
          h(
            "div",
            { className: "dwp-section" },
            h("div", { className: "dwp-sectionTitle" }, t("sectionBackground")),
            h("div", { className: "dwp-grid" }, officialCard, builtinCard),
          ),
          h(
            "div",
            { className: "dwp-section" },
            h("div", { className: "dwp-sectionTitle" }, t("sectionMine")),
            h(
              "div",
              { className: "dwp-actions" },
              h(
                "button",
                {
                  type: "button",
                  className: "dwp-btn",
                  onClick: pickFiles,
                  disabled: busy || unavailable,
                },
                busy ? t("uploading") : t("upload"),
              ),
              h("input", {
                ref: inputRef,
                type: "file",
                accept: ALLOWED_TYPES.join(","),
                multiple: true,
                hidden: true,
                onChange: (event) => void onFiles(event),
              }),
            ),
            libraryBody,
            unavailable || snapshot.status !== "ready" ? null : h("p", { className: "dwp-hint" }, t("hintLocal")),
          ),
          error === "" ? null : h("div", { className: "dwp-error", role: "alert" }, error),
          selectedMissing
            ? h("p", { className: "dwp-hint" }, t("hintMissing"))
            : reducedHint
              ? h("p", { className: "dwp-hint" }, t("hintReduced"))
              : null,
          h(
            "div",
            { className: "dwp-section" },
            h("div", { className: "dwp-sectionTitle" }, t("sectionDisplay")),
            slider("panelOpacity", t("opacity"), OPACITY_MIN, OPACITY_MAX, state.panelOpacity, (value) =>
              t("sliderValue", { value }),
            ),
            slider("blur", t("blur"), BLUR_MIN, BLUR_MAX, state.blur, (value) => t("blurValue", { value })),
          ),
          h(
            "div",
            { className: "dwp-foot" },
            h("button", { type: "button", className: "dwp-btn", onClick: () => store.set({ ...DEFAULTS }) }, t("reset")),
          ),
        );
      };
    }

    /**
     * Read intrinsic width/height from the first 64 KB of the file. A 20 MB
     * budget alone still allows a 100 MP image, and a 100 MP image decodes to
     * ~400 MB of RGBA once the wallpaper uses it.
     */
    function imageDimensions(bytes) {
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      const u16be = (offset) => view.getUint16(offset, false);
      const u32be = (offset) => view.getUint32(offset, false);
      const u24be = (offset) => (view.getUint8(offset) << 16) | (view.getUint8(offset + 1) << 8) | view.getUint8(offset + 2);

      // PNG: IHDR is the first chunk.
      if (bytes.length >= 24 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return { width: u32be(16), height: u32be(20) };
      }
      // GIF: logical screen descriptor.
      if (bytes.length >= 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
        return { width: view.getUint16(6, true), height: view.getUint16(8, true) };
      }
      // WebP: VP8X carries the canvas, VP8L a packed 14-bit size, VP8 a frame header.
      if (bytes.length >= 30 && bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46) {
        const chunk = String.fromCharCode(bytes[12], bytes[13], bytes[14], bytes[15]);
        if (chunk === "VP8X") return { width: u24be(24) + 1, height: u24be(27) + 1 };
        if (chunk === "VP8L") {
          const bits = view.getUint32(21, true);
          return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
        }
        if (chunk === "VP8 ") {
          return { width: view.getUint16(26, true) & 0x3fff, height: view.getUint16(28, true) & 0x3fff };
        }
      }
      // JPEG: walk the markers until a start-of-frame segment.
      if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
        let offset = 2;
        while (offset + 9 < bytes.length) {
          if (bytes[offset] !== 0xff) {
            offset += 1;
            continue;
          }
          const marker = bytes[offset + 1];
          if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
            offset += 2;
            continue;
          }
          const length = u16be(offset + 2);
          if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { width: u16be(offset + 7), height: u16be(offset + 5) };
          }
          if (length < 2) return null;
          offset += 2 + length;
        }
        return null;
      }
      // AVIF/HEIF: the first `ispe` box carries the display size.
      for (let index = 0; index + 16 <= bytes.length; index += 1) {
        if (bytes[index] === 0x69 && bytes[index + 1] === 0x73 && bytes[index + 2] === 0x70 && bytes[index + 3] === 0x65) {
          return { width: u32be(index + 8), height: u32be(index + 12) };
        }
      }
      return null;
    }

    async function validateFile(file, t) {
      if (!ALLOWED_TYPES.includes(file.type)) return t("reasonType");
      if (typeof file.size === "number" && file.size > MAX_UPLOAD_BYTES) return t("reasonSize");
      if (typeof file.slice !== "function") return null;
      let size = null;
      try {
        size = imageDimensions(new Uint8Array(await file.slice(0, 64 * 1024).arrayBuffer()));
      } catch {
        return null;
      }
      if (size !== null && size.width * size.height > MAX_PIXELS) return t("reasonPixels");
      return null;
    }

    // -------------------------------------------------------------- effects

    const REDUCE_QUERY = "(prefers-reduced-transparency: reduce)";

    function readReducedTransparency() {
      return typeof window.matchMedia === "function" && window.matchMedia(REDUCE_QUERY).matches;
    }

    function subscribeReducedTransparency(onChange) {
      if (typeof window.matchMedia !== "function") return () => {};
      const media = window.matchMedia(REDUCE_QUERY);
      if (typeof media.addEventListener === "function") {
        media.addEventListener("change", onChange);
        return () => media.removeEventListener("change", onChange);
      }
      if (typeof media.addListener === "function") {
        media.addListener(onChange);
        return () => media.removeListener(onChange);
      }
      return () => {};
    }

    function reducedTransparency() {
      try {
        return (
          typeof window.matchMedia === "function" &&
          window.matchMedia("(prefers-reduced-transparency: reduce)").matches
        );
      } catch (error) {
        return false;
      }
    }

    /**
     * Owns everything the wallpaper needs on screen and keeps its cost bounded:
     * the style element is rewritten only when the artwork changes, the sliders
     * only move custom properties, all of it is rAF-batched, and the theme token
     * layer is re-registered only when the rounded opacity actually changes.
     */
    function createPainter(ctx, store, library) {
      const doc = window.document;
      if (doc === null || doc === undefined || doc.head === null || doc.body === null) return () => {};

      const styleTag = doc.createElement("style");
      styleTag.dataset.pluginCss = CSS_TAG_ID;
      doc.head.appendChild(styleTag);
      const root = doc.documentElement ?? null;

      let disposeTokens = null;
      let structureKey = null;
      let frame = 0;
      let disposed = false;

      const raf =
        typeof window.requestAnimationFrame === "function"
          ? (callback) => window.requestAnimationFrame(callback)
          : (callback) => window.setTimeout(callback, 16);
      const cancel =
        typeof window.cancelAnimationFrame === "function"
          ? (id) => window.cancelAnimationFrame(id)
          : (id) => window.clearTimeout(id);

      const appliedProperties = new Set();
      const setProperty = (name, value) => {
        if (root === null || root.style === undefined || typeof root.style.setProperty !== "function") return;
        appliedProperties.add(name);
        root.style.setProperty(name, value);
      };

      const detachTokens = () => {
        if (disposeTokens === null) return;
        const release = disposeTokens;
        disposeTokens = null;
        release();
      };

      const paintNow = () => {
        if (disposed) return;
        const state = store.get();

        if (reducedTransparency()) {
          detachTokens();
          doc.body.removeAttribute(BODY_ATTR);
          if (structureKey !== null) {
            structureKey = null;
            styleTag.textContent = "";
          }
          return;
        }

        const customUrl = state.mode === "custom" ? library.urlFor(state.customId) : null;
        const nextStructure = `${state.mode}|${customUrl ?? ""}`;
        if (nextStructure !== structureKey) {
          structureKey = nextStructure;
          styleTag.textContent = buildCss(state, customUrl);
        }

        doc.body.setAttribute(BODY_ATTR, state.mode);

        // Slider values ride on custom properties: one property write per frame
        // instead of re-parsing a stylesheet that carries two inlined images.
        const alpha = opacityAlpha(state);
        setProperty("--dwp-panel-alpha", String(alpha));
        setProperty("--dwp-panel-alpha-dark", String(Math.min(1, roundTo(alpha + 0.06, 3))));
        setProperty("--dwp-sidebar-light", String(Math.min(1, roundTo(alpha + 0.16, 3))));
        setProperty("--dwp-sidebar-dark", String(Math.min(1, roundTo(alpha + 0.22, 3))));
        if (state.blur > 0) {
          setProperty("--dwp-filter", `blur(${state.blur}px)`);
          setProperty("--dwp-transform", `scale(${bleedScale(state.blur)})`);
        } else {
          setProperty("--dwp-filter", "none");
          setProperty("--dwp-transform", "none");
        }

        // One token layer for the whole session: it reads `--dwp-panel-alpha`,
        // so dragging the slider only writes that variable.
        if (disposeTokens === null) disposeTokens = ctx.theme.overrideTokens(THEME_SOURCE, buildTokens());
      };

      const schedule = () => {
        if (disposed || frame !== 0) return;
        frame = raf(() => {
          frame = 0;
          paintNow();
        });
      };

      const unsubscribeStore = store.subscribe(schedule);
      const unsubscribeLibrary = library.subscribe(schedule);
      const media = window.matchMedia("(prefers-reduced-transparency: reduce)");
      const onMedia = () => schedule();
      if (typeof media.addEventListener === "function") media.addEventListener("change", onMedia);
      else if (typeof media.addListener === "function") media.addListener(onMedia);

      const onResize = () => schedule();
      if (typeof window.addEventListener === "function") window.addEventListener("resize", onResize);

      // Paint the host-selected artwork first: painting the defaults synchronously
      // flashes the official image before a custom choice lands.
      const paintWhenKnown = () => {
        if (library.get().status !== "loading") paintNow();
      };
      paintWhenKnown();
      const bootFallback = window.setTimeout(paintWhenKnown, 1000);

      return () => {
        disposed = true;
        if (frame !== 0) {
          cancel(frame);
          frame = 0;
        }
        unsubscribeStore();
        unsubscribeLibrary();
        window.clearTimeout(bootFallback);
        if (typeof window.removeEventListener === "function") window.removeEventListener("resize", onResize);
        if (typeof media.removeEventListener === "function") media.removeEventListener("change", onMedia);
        else if (typeof media.removeListener === "function") media.removeListener(onMedia);
        detachTokens();
        styleTag.remove();
        doc.body.removeAttribute(BODY_ATTR);
        if (root !== null && root.style !== undefined && typeof root.style.removeProperty === "function") {
          for (const name of appliedProperties) root.style.removeProperty(name);
        }
        appliedProperties.clear();
      };
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh: ZH, en: EN }));

      const store = createStore();
      const library = createLibrary(store);

      ctx.effect(() => {
        library.load();
        return () => store.dispose();
      });

      // 壁纸落地：body 标记 + 样式表 + token 层。全部走 rAF 合并，滑杆拖动时
      // 一帧最多重绘一次，而且帧内只改自定义属性，不重建带 data URI 的样式表。
      ctx.effect(() => createPainter(ctx, store, library));

      // Settings-page stylesheet, injected once instead of on every render.
      ctx.effect(() => {
        const doc = window.document;
        if (doc === null || doc === undefined || doc.head === null) return () => {};
        const tag = doc.createElement("style");
        tag.dataset.pluginCss = CSS_TAG_ID_BY_FEATURE;
        tag.textContent = PAGE_CSS;
        doc.head.appendChild(tag);
        return () => tag.remove();
      });

      ctx.slots.inject("settings.section", () =>
        ctx.slots.register(
          {
            name: "settings.section",
            id: SECTION_ID,
            order: 5,
            label: () => navLabel(ctx),
          },
          createPage(ctx, store, library),
        ),
      );
    }

    function navLabel(ctx) {
      try {
        const text = ctx.locale.bind(NS)("nav");
        return typeof text === "string" && text !== "nav" && text !== "" ? text : ZH.nav;
      } catch (error) {
        return ZH.nav;
      }
    }

    return { inject: ["locale", "slots", "theme"], apply };
  },
});
