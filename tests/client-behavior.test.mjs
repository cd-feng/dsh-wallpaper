/**
 * Headless behaviour tests for the built browser half.
 *
 * The live page cannot be driven from here (no browser control, screen capture is
 * denied), so this loads the real `lib/client.js` against a small DOM / React /
 * fetch stand-in and asserts the observable contract:
 *
 *  - the body marker, the stylesheet and the theme-token layer the wallpaper needs;
 *  - the settings-section registration (order 5, localized label);
 *  - the page render (localized copy, upload input, sliders, cards);
 *  - upload → Host POST → wallpaper swap, delete, official mode, debounced PATCH;
 *  - the reduce-transparency pause and the Host-unavailable fallback;
 *  - and that service methods are never passed to React detached (the regression
 *    that once made the settings row crash on the real page).
 *
 * Dependency-free: `node --test tests/*.test.mjs`.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BUNDLE = path.join(ROOT, "lib/client.js");

const IMAGE_ID = "00000000-0000-4000-8000-000000000001";
const IMAGE_ID_2 = "00000000-0000-4000-8000-000000000002";

let bundleCode = "";
async function readBundle() {
  if (bundleCode === "") bundleCode = await readFile(BUNDLE, "utf8");
  return bundleCode;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ harness

function createDocument() {
  const styleTags = [];
  const head = {
    children: styleTags,
    appendChild(node) {
      styleTags.push(node);
      return node;
    },
  };
  const attributes = new Map();
  const bodyStyle = new Map();
  const body = {
    setAttribute: (name, value) => attributes.set(name, value),
    removeAttribute: (name) => attributes.delete(name),
    hasAttribute: (name) => attributes.has(name),
    style: {
      setProperty: (name, value) => bodyStyle.set(name, value),
      getPropertyValue: (name) => bodyStyle.get(name) ?? "",
      removeProperty: (name) => bodyStyle.delete(name),
    },
  };
  const rootStyle = new Map();
  const documentElement = {
    style: {
      setProperty: (name, value) => rootStyle.set(name, value),
      getPropertyValue: (name) => rootStyle.get(name) ?? "",
      removeProperty: (name) => rootStyle.delete(name),
    },
  };
  return {
    document: {
      head,
      body,
      documentElement,
      createElement(tagName) {
        const node = {
          tagName,
          dataset: {},
          textContent: "",
          remove() {
            const index = styleTags.indexOf(node);
            if (index >= 0) styleTags.splice(index, 1);
          },
        };
        return node;
      },
    },
    styleTags,
    attributes,
    bodyStyle,
    rootStyle,
  };
}

function createMedia({ reducedTransparency = false } = {}) {
  const handlers = new Set();
  const media = {
    matches: reducedTransparency,
    addEventListener: (type, handler) => handlers.add(handler),
    removeEventListener: (type, handler) => handlers.delete(handler),
    fire(next) {
      media.matches = next;
      for (const handler of [...handlers]) handler();
    },
    handlerCount: () => handlers.size,
  };
  return media;
}

function createLocale() {
  const dictionaries = new Map();
  const listeners = new Set();
  // Methods use `this` on purpose: a caller that detaches them (the old bug)
  // explodes here instead of silently rendering an empty page.
  return {
    active: "zh",
    snapshot: Object.freeze({ active: "zh", locales: [], revision: 0 }),
    register(namespace, dicts) {
      dictionaries.set(namespace, dicts);
      return () => dictionaries.delete(namespace);
    },
    getSnapshot() {
      return this.snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    registeredCount: () => dictionaries.size,
    bind(namespace) {
      const self = this;
      return (key, params) => self.translate(namespace, key, params);
    },
    translate(namespace, key, params) {
      const dicts = dictionaries.get(namespace) ?? {};
      const dict = dicts[this.active] ?? dicts.zh ?? {};
      const template = dict[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    },
  };
}

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

/** Stand-in for the Host half's `/dsh-wallpaper/*` routes. */
function createHost({ config = {}, images = [], fail = false, uploadStatus = 0, patchDelay = 0 } = {}) {
  const state = {
    config: { mode: "official", customId: null, panelOpacity: 52, blur: 0, fontId: "system", fontScale: 100, ...config },
    images: [...images],
  };
  const calls = [];
  let counter = 0;
  const knownIds = () => new Set(state.images.map((image) => image.id));

  const normalize = (raw) => {
    const source = raw !== null && typeof raw === "object" ? raw : {};
    let mode = source.mode;
    if (mode !== "official" && mode !== "builtin" && mode !== "custom") mode = "builtin";
    const customId =
      typeof source.customId === "string" && knownIds().has(source.customId) ? source.customId : null;
    if (mode === "custom" && customId === null) mode = "official";
    return {
      mode,
      customId,
      panelOpacity: clamp(source.panelOpacity, 20, 100, 52),
      blur: clamp(source.blur, 0, 24, 0),
      fontId: typeof source.fontId === "string" && /^[a-z0-9-]{1,32}$/.test(source.fontId) ? source.fontId : "system",
      fontScale: clamp(source.fontScale, 90, 110, 100),
    };
  };

  const reply = (status, payload) => ({
    ok: status < 400,
    status,
    text: async () => JSON.stringify(payload),
  });

  const fetch = async (url, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = String(url).split("?")[0];
    calls.push({ path, method, init });
    if (fail) return reply(404, { error: "not found" });

    if (path === "/dsh-wallpaper/state" && method === "GET") {
      return reply(200, { config: state.config, images: state.images });
    }
    if (path === "/dsh-wallpaper/config" && method === "PATCH") {
      if (patchDelay > 0) await delay(patchDelay);
      state.config = normalize({ ...state.config, ...JSON.parse(String(init.body)) });
      return reply(200, { config: state.config, images: state.images });
    }
    if (path === "/dsh-wallpaper/library" && method === "POST") {
      if (uploadStatus >= 400) {
        return reply(uploadStatus, { error: "unsupported image format", code: "UNSUPPORTED_IMAGE" });
      }
      counter += 1;
      const id = counter === 1 ? IMAGE_ID : IMAGE_ID_2;
      const entry = {
        id,
        name: decodeURIComponent(init.headers["x-filename"] ?? "wallpaper"),
        mime: init.headers["content-type"] ?? "image/png",
        size: typeof init.body?.size === "number" ? init.body.size : 0,
        addedAt: Date.now(),
        sha256: `hash-${counter}`,
      };
      state.images = [entry, ...state.images];
      state.config = normalize({ ...state.config, mode: "custom", customId: id });
      return reply(201, { config: state.config, images: state.images });
    }
    const removed = /^\/dsh-wallpaper\/library\/(.+)$/.exec(path);
    if (removed !== null && method === "DELETE") {
      state.images = state.images.filter((image) => image.id !== removed[1]);
      state.config = normalize(state.config);
      return reply(200, { config: state.config, images: state.images });
    }
    return reply(404, { error: "not found" });
  };

  return { state, calls, fetch, normalize };
}

function createReact() {
  const slots = [];
  const effects = [];
  let cursor = 0;
  const React = {
    createElement(type, props, ...children) {
      return { type, props: props ?? {}, children: children.flat() };
    },
    useSyncExternalStore(_subscribe, getSnapshot) {
      return getSnapshot();
    },
    useState(initial) {
      const index = cursor++;
      if (slots[index] === undefined) {
        slots[index] = { value: typeof initial === "function" ? initial() : initial };
      }
      const slot = slots[index];
      return [
        slot.value,
        (next) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
          return slot.value;
        },
      ];
    },
    useRef(initial) {
      const index = cursor++;
      if (slots[index] === undefined) slots[index] = { value: { current: initial } };
      return slots[index].value;
    },
    useEffect(run, deps) {
      const index = cursor++;
      const previous = effects[index];
      const unchanged =
        previous !== undefined &&
        Array.isArray(deps) &&
        Array.isArray(previous.deps) &&
        deps.length === previous.deps.length &&
        deps.every((value, i) => value === previous.deps[i]);
      if (unchanged) return;
      if (previous !== undefined && typeof previous.cleanup === "function") previous.cleanup();
      effects[index] = { deps, cleanup: run() };
    },
    beginRender() {
      cursor = 0;
    },
  };
  return React;
}

function createContext({ locale }) {
  const disposers = [];
  const overrides = [];
  const released = [];
  const registrations = [];
  const injections = [];
  const context = {
    effect(run) {
      const disposer = run();
      if (typeof disposer === "function") disposers.push(disposer);
      return disposer;
    },
    locale,
    theme: {
      overrideTokens(source, tokens) {
        overrides.push({ source, tokens });
        return () => released.push(source);
      },
    },
    slots: {
      inject(key, callback) {
        injections.push(key);
        return callback();
      },
      register(options, component) {
        registrations.push({ options, component });
        return () => {};
      },
    },
  };
  return { ctx: context, disposers, overrides, released, registrations, injections };
}

async function boot({ reducedTransparency = false, ...hostOptions } = {}) {
  const code = await readBundle();
  const dom = createDocument();
  const media = createMedia({ reducedTransparency });
  const host = createHost(hostOptions);
  const window = {
    document: dom.document,
    fetch: host.fetch,
    matchMedia: (query) => {
      assert.equal(query, "(prefers-reduced-transparency: reduce)");
      return media;
    },
    setTimeout: (fn, ms) => {
      const timer = setTimeout(fn, ms);
      timer.unref?.();
      return timer;
    },
    clearTimeout: (timer) => clearTimeout(timer),
  };

  const previous = { window: globalThis.window, document: globalThis.document };
  globalThis.window = window;
  globalThis.document = dom.document;

  let captured = null;
  window.__ModuleLoader__ = {
    load(entry) {
      captured = entry;
    },
  };
  new Function("window", "document", code)(window, dom.document);
  assert.ok(captured, "bundle registered a module");

  const React = createReact();
  const plugin = captured.factory((request) => {
    assert.equal(request, "react");
    return React;
  });
  const locale = createLocale();
  const context = createContext({ locale });
  plugin.apply(context.ctx);
  await delay(20);

  return {
    entry: captured,
    plugin,
    documentElement: dom.document,
    React,
    dom,
    media,
    host,
    locale,
    ...context,
    render() {
      React.beginRender();
      return context.registrations[0].component();
    },
    /** Wait one animation frame: paints are rAF-batched. */
    settle: () => delay(24),
    dispose() {
      for (const disposer of [...context.disposers].reverse()) disposer();
      globalThis.window = previous.window;
      globalThis.document = previous.document;
    },
  };
}

// ------------------------------------------------------------- tree helpers

function collectText(node, out = []) {
  if (node === null || node === undefined) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) collectText(child, out);
    return out;
  }
  if (typeof node === "object" && node.children !== undefined) collectText(node.children, out);
  return out;
}

function walk(node, visit) {
  if (node === null || node === undefined) return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node !== "object") return;
  visit(node);
  if (node.children !== undefined) walk(node.children, visit);
}

function findAll(node, predicate) {
  const found = [];
  walk(node, (element) => {
    if (predicate(element)) found.push(element);
  });
  return found;
}

function allText(node) {
  return collectText(node).join("\n");
}

function cardNames(tree) {
  return findAll(tree, (element) => element.type === "span" && element.props.className === "dwp-cardName").map((element) =>
    collectText(element).join(""),
  );
}

function sheetOf(app) {
  const sheet = app.dom.styleTags.find((tag) => tag.dataset.pluginCss === "dsh-wallpaper/global.css");
  assert.ok(sheet, "wallpaper stylesheet exists");
  return sheet;
}

// ---------------------------------------------------------------- the tests

test("registers under the package name", async () => {
  const app = await boot();
  assert.equal(app.entry.id, "dsh-wallpaper");
  app.dispose();
});

test("defaults to the official-style wallpaper and cleans up on dispose", async () => {
  const app = await boot();
  assert.equal(app.dom.attributes.get("data-dsh-wallpaper"), "official");
  const sheet = sheetOf(app);
  assert.match(sheet.textContent, /body\[data-dsh-wallpaper\]\{background-color:transparent/);
  assert.match(sheet.textContent, /body\[data-dsh-wallpaper\]::before\{content:""/);
  assert.match(sheet.textContent, /data:image\/webp;base64,/);
  // The official look carries the deepseek.com fine grid as extra CSS layers.
  assert.match(sheet.textContent, /repeating-linear-gradient\(0deg/);
  assert.match(sheet.textContent, /background-size:auto,auto,cover/);
  assert.match(sheet.textContent, /body\[data-dsh-wallpaper\]\[data-ds-dark-theme\]::before\{content:""/);
  assert.match(sheet.textContent, /_sidebarCol/);

  assert.equal(app.overrides.length, 1, "the token layer is registered exactly once");
  const tokens = app.overrides.at(-1).tokens;
  assert.deepEqual(Object.keys(tokens).sort(), [
    "--dsw-alias-bg-base",
    "--dsw-alias-markdown-code-block",
    "--dsw-alias-markdown-code-block-banner",
    "--dsw-specific-bubble",
    "--dsw-specific-input-major",
    "--dsw-specific-sidebar-fill",
  ]);
  // The alpha is a CSS variable: dragging the slider must not re-publish the theme.
  assert.match(tokens["--dsw-alias-bg-base"].light, /var\(--dwp-panel-alpha/);
  assert.match(tokens["--dsw-alias-bg-base"].dark, /var\(--dwp-panel-alpha/);
  assert.match(tokens["--dsw-specific-sidebar-fill"].light, /var\(--dwp-sidebar-light/);
  // Composer and bubbles are layer surfaces: they follow the surface alpha so the
  // wallpaper stays visible behind them instead of being covered by solid fills.
  assert.match(tokens["--dsw-specific-input-major"].light, /rgba\(255, 255, 255, var\(--dwp-surface-alpha/);
  assert.match(tokens["--dsw-specific-input-major"].dark, /rgba\(44, 44, 46, var\(--dwp-surface-alpha/);
  assert.match(tokens["--dsw-specific-bubble"].light, /rgba\(237, 243, 254, var\(--dwp-surface-alpha/);
  assert.match(tokens["--dsw-specific-bubble"].dark, /rgba\(44, 44, 46, var\(--dwp-surface-alpha/);
  // Markdown code blocks follow the same surface alpha (body + banner).
  assert.match(tokens["--dsw-alias-markdown-code-block"].dark, /rgba\(27, 27, 28, var\(--dwp-surface-alpha/);
  assert.match(tokens["--dsw-alias-markdown-code-block"].light, /rgba\(249, 250, 251, var\(--dwp-surface-alpha/);
  assert.match(tokens["--dsw-alias-markdown-code-block-banner"].dark, /rgba\(44, 44, 46, var\(--dwp-surface-alpha/);
  assert.equal(app.dom.rootStyle.get("--dwp-panel-alpha"), "0.52");
  assert.equal(app.dom.rootStyle.get("--dwp-surface-alpha"), "0.58");
  assert.equal(app.dom.rootStyle.get("--dwp-surface-mix"), "58%");

  app.dispose();
  assert.equal(app.dom.attributes.has("data-dsh-wallpaper"), false);
  assert.equal(app.dom.styleTags.length, 0);
  assert.equal(app.released.length, app.overrides.length);
  assert.ok(app.released.every((source) => source === "dsh-wallpaper"));
  assert.equal(app.dom.rootStyle.has("--dwp-panel-alpha"), false, "custom properties are removed on dispose");
  assert.equal(app.dom.rootStyle.has("--dwp-surface-alpha"), false, "surface alpha is removed too");
});

test("the composer, bubbles and deliverable cards inherit the panel opacity", async () => {
  const app = await boot();
  const sheet = sheetOf(app).textContent;
  // The composer floats over the transcript and frosts its backdrop so message
  // text cannot bleed through the translucent card.
  assert.match(sheet, /\[class\*="composerStack"\] \[class\*="_card"\]/);
  assert.match(sheet, /\[class\*="composerSeat"\] \[class\*="_card"\]/);
  assert.match(sheet, /backdrop-filter:blur\(28px\) saturate\(1\.35\)/);
  // Deliverable / file-change cards mix their own fills with the surface alpha.
  assert.match(
    sheet,
    /\[class\*="vdszpW_card"\]\{background:color-mix\(in srgb,var\(--dsw-alias-bg-layer-1\) var\(--dwp-surface-mix, 58%\),transparent\)/,
  );
  assert.match(sheet, /\[class\*="vdszpW_card"\] \[class\*="vdszpW_header"\]\{background:color-mix/);
  assert.match(sheet, /\[class\*="vdszpW_header"\]:hover:not\(:disabled\)/);
  assert.match(sheet, /\[class\*="IBlBFq_file"\]\{background:color-mix/);
  assert.match(sheet, /\[class\*="IBlBFq_file"\]:hover\{background:color-mix/);

  // The surface alpha is derived from the same slider and no theme re-publish.
  const range = () =>
    findAll(app.render(), (element) => element.type === "input" && element.props.type === "range")[1];
  range().props.onChange({ currentTarget: { value: "80" } });
  await app.settle();
  assert.equal(app.dom.rootStyle.get("--dwp-panel-alpha"), "0.8");
  assert.equal(app.dom.rootStyle.get("--dwp-surface-alpha"), "0.86");
  assert.equal(app.dom.rootStyle.get("--dwp-surface-mix"), "86%");
  assert.equal(app.overrides.length, 1, "the token layer is still registered only once");
  app.dispose();
  assert.equal(app.dom.rootStyle.has("--dwp-surface-alpha"), false);
  assert.equal(app.dom.rootStyle.has("--dwp-surface-mix"), false);
});

test("a Host-selected custom image becomes the wallpaper", async () => {
  const app = await boot({
    config: { mode: "custom", customId: IMAGE_ID, panelOpacity: 64 },
    images: [{ id: IMAGE_ID, name: "my-photo.jpg", mime: "image/jpeg", size: 1200, addedAt: 1 }],
  });
  assert.equal(app.dom.attributes.get("data-dsh-wallpaper"), "custom");
  const sheet = sheetOf(app);
  assert.match(sheet.textContent, new RegExp(`url\\("/dsh-wallpaper/assets/${IMAGE_ID}"\\)`));
  // The upload is the first layer; the official bake sits underneath as a fallback.
  assert.match(sheet.textContent, new RegExp(`url\\("/dsh-wallpaper/assets/${IMAGE_ID}"\\),url\\("data:image/webp;base64,`));
  assert.equal(app.overrides.length, 1);
  assert.equal(app.dom.rootStyle.get("--dwp-panel-alpha"), "0.64");

  const tree = app.render();
  assert.ok(cardNames(tree).includes("my-photo.jpg"));
  assert.ok(allText(tree).includes("使用中"));
  app.dispose();
});

test("an unreachable Host half keeps the default look and explains the restart", async () => {
  const app = await boot({ fail: true });
  assert.equal(app.dom.attributes.get("data-dsh-wallpaper"), "official");
  const tree = app.render();
  assert.ok(allText(tree).includes("壁纸服务还没启动"), "page explains the missing Host half");
  const upload = findAll(tree, (element) => element.type === "button" && element.props.className === "dwp-btn")[0];
  assert.equal(upload.props.disabled, true);
  app.dispose();
});

test("registers a settings section at order 5 with a localized label", async () => {
  const app = await boot();
  assert.deepEqual(app.injections, ["settings.section"]);
  assert.equal(app.registrations.length, 1);
  assert.equal(app.registrations[0].options.name, "settings.section");
  assert.equal(app.registrations[0].options.id, "wallpaper");
  assert.equal(app.registrations[0].options.order, 5);
  assert.equal(app.registrations[0].options.label(), "壁纸");
  app.dispose();
});

test("the page renders localized copy, the upload input and both sliders", async () => {
  const app = await boot();
  const tree = app.render();
  const text = allText(tree);
  for (const expected of ["壁纸", "背景", "官方", "极光", "我的图片", "上传图片", "显示", "面板不透明度", "背景模糊", "恢复默认"]) {
    assert.ok(text.includes(expected), `page copy includes ${expected}`);
  }
  const fileInputs = findAll(tree, (element) => element.type === "input" && element.props.type === "file");
  assert.equal(fileInputs.length, 1);
  assert.match(fileInputs[0].props.accept, /image\/png/);
  assert.match(fileInputs[0].props.accept, /image\/jpeg/);
  const ranges = findAll(tree, (element) => element.type === "input" && element.props.type === "range");
  assert.deepEqual(ranges.map((range) => range.props.min), [90, 20, 0]);
  assert.deepEqual(ranges.map((range) => range.props.max), [110, 100, 24]);
  assert.deepEqual(cardNames(tree), ["官方", "极光"]);
  app.dispose();
});

test("uploading posts to the Host, selects the image and shows the card", async () => {
  const app = await boot();
  let tree = app.render();
  const fileInput = findAll(tree, (element) => element.type === "input" && element.props.type === "file")[0];
  const file = { name: "sunset.png", type: "image/png", size: 4096 };

  fileInput.props.onChange({ currentTarget: { files: [file], value: "" } });
  await delay(50);

  const post = app.host.calls.find((call) => call.path === "/dsh-wallpaper/library" && call.method === "POST");
  assert.ok(post, "upload reached the Host");
  assert.equal(post.init.headers["content-type"], "image/png");
  assert.equal(decodeURIComponent(post.init.headers["x-filename"]), "sunset.png");
  assert.equal(app.host.state.config.mode, "custom");
  assert.equal(app.host.state.config.customId, IMAGE_ID);
  assert.equal(app.dom.attributes.get("data-dsh-wallpaper"), "custom");
  assert.match(sheetOf(app).textContent, new RegExp(`url\\("/dsh-wallpaper/assets/${IMAGE_ID}"\\)`));

  tree = app.render();
  assert.ok(cardNames(tree).includes("sunset.png"));
  assert.equal(findAll(tree, (element) => element.type === "div" && element.props.className === "dwp-card").length, 3);
  app.dispose();
});

test("rejects unsupported files locally without calling the Host", async () => {
  const app = await boot();
  const tree = app.render();
  const fileInput = findAll(tree, (element) => element.type === "input" && element.props.type === "file")[0];
  fileInput.props.onChange({
    currentTarget: { files: [{ name: "notes.txt", type: "text/plain", size: 10 }], value: "" },
  });
  await delay(30);
  assert.equal(app.host.calls.filter((call) => call.method === "POST").length, 0);
  assert.ok(allText(app.render()).includes("不是支持的图片格式"));
  app.dispose();
});

test("deleting the selected image falls back to the built-in wallpaper", async () => {
  const app = await boot({
    config: { mode: "custom", customId: IMAGE_ID },
    images: [{ id: IMAGE_ID, name: "gone.png", mime: "image/png", size: 10, addedAt: 1 }],
  });
  let tree = app.render();
  let deleteButton = findAll(tree, (element) => element.type === "button" && element.props.className === "dwp-delete")[0];
  deleteButton.props.onClick();
  tree = app.render();
  deleteButton = findAll(tree, (element) => element.type === "button" && element.props.className === "dwp-delete")[0];
  assert.equal(collectText(deleteButton).join(""), "确认删除");
  deleteButton.props.onClick();
  await delay(50);

  assert.ok(app.host.calls.find((call) => call.method === "DELETE"), "delete reached the Host");
  assert.equal(app.host.state.images.length, 0);
  // Deleting the selected image falls back to the default wallpaper (official).
  assert.equal(app.dom.attributes.get("data-dsh-wallpaper"), "official");
  assert.deepEqual(cardNames(app.render()), ["官方", "极光"]);
  app.dispose();
});

test("switching between the two built-in wallpapers repaints and persists", async () => {
  const app = await boot();
  const officialSheet = sheetOf(app).textContent;
  assert.match(officialSheet, /repeating-linear-gradient\(0deg/);

  // The only card not currently selected is the aurora one.
  const [builtin] = findAll(
    app.render(),
    (element) => element.type === "button" && element.props.className === "dwp-cardSelect" && element.props["aria-pressed"] === false,
  );
  builtin.props.onClick();
  await app.settle();

  assert.equal(app.dom.attributes.get("data-dsh-wallpaper"), "builtin");
  const auroraSheet = sheetOf(app).textContent;
  assert.doesNotMatch(auroraSheet, /repeating-linear-gradient/);
  assert.notEqual(auroraSheet, officialSheet, "aurora paints different art than the official pair");
  assert.match(auroraSheet, /data:image\/webp;base64,/);

  await delay(300);
  const patch = app.host.calls.find((call) => call.path === "/dsh-wallpaper/config" && call.method === "PATCH");
  assert.ok(patch, "preference was written back");
  assert.equal(JSON.parse(String(patch.init.body)).mode, "builtin");
  assert.equal(app.host.state.config.mode, "builtin");
  app.dispose();
});


test("a slider repaints at once and writes one debounced PATCH", async () => {
  const app = await boot();
  const ranges = findAll(app.render(), (element) => element.type === "input" && element.props.type === "range");
  const before = app.overrides.length;
  const sheetBefore = sheetOf(app).textContent;
  ranges[1].props.onChange({ currentTarget: { value: "80" } });
  ranges[1].props.onChange({ currentTarget: { value: "85" } });
  await app.settle();

  // Both events collapse into one frame; the theme layer is not re-published at
  // all, the alpha arrives as a custom property.
  assert.equal(app.overrides.length, before, "dragging does not re-register the token layer");
  assert.equal(app.dom.rootStyle.get("--dwp-panel-alpha"), "0.85");
  // The stylesheet (which carries the inlined artwork) is not rewritten, and
  // the new values arrive as custom properties instead.
  assert.equal(sheetOf(app).textContent, sheetBefore, "slider drag does not re-parse the artwork CSS");
  assert.equal(app.dom.rootStyle.get("--dwp-sidebar-light"), "1");

  await delay(300);
  const patches = app.host.calls.filter((call) => call.path === "/dsh-wallpaper/config" && call.method === "PATCH");
  assert.equal(patches.length, 1, "two quick changes collapse into one write");
  assert.equal(JSON.parse(String(patches[0].init.body)).panelOpacity, 85);
  assert.equal(app.host.state.config.panelOpacity, 85);
  app.dispose();
});

test("reduce-transparency pauses the wallpaper and resumes when disabled", async () => {
  const app = await boot({ reducedTransparency: true });
  assert.equal(app.dom.attributes.has("data-dsh-wallpaper"), false);
  assert.equal(app.overrides.length, 0);

  app.media.fire(false);
  await app.settle();
  assert.equal(app.dom.attributes.get("data-dsh-wallpaper"), "official");
  assert.equal(app.overrides.length, 1);
  app.dispose();
  assert.equal(app.media.handlerCount(), 0);
});

test("the locale service is never called detached", async () => {
  const app = await boot();
  // createLocale() methods read `this`; a detached call would have thrown while
  // registering the label thunk or rendering the page.
  assert.doesNotThrow(() => app.render());
  assert.ok(allText(app.render()).includes("壁纸"));
  app.dispose();
});

test("a rejected upload keeps the library usable instead of reporting an unreachable Host", async () => {
  const app = await boot({ uploadStatus: 415 });
  let tree = app.render();
  const fileInput = findAll(tree, (element) => element.type === "input" && element.props.type === "file")[0];
  fileInput.props.onChange({
    currentTarget: { files: [{ name: "broken.png", type: "image/png", size: 2048 }], value: "" },
  });
  await delay(50);

  tree = app.render();
  const text = allText(tree);
  assert.ok(text.includes("这些文件没有导入"), "the per-file error is shown");
  assert.ok(!text.includes("壁纸服务还没启动"), "a 415 is not a missing Host half");
  assert.ok(cardNames(tree).includes("极光"), "the built-in cards still render");
  app.dispose();
});

test("the unreachable-Host message offers a retry that reloads the state", async () => {
  const app = await boot({ fail: true });
  let tree = app.render();
  const retry = findAll(tree, (element) => element.type === "button" && element.props.className === "dwp-btn").find(
    (element) => collectText(element).join("") === "重试",
  );
  assert.ok(retry, "retry button is rendered");
  const before = app.host.calls.filter((call) => call.path === "/dsh-wallpaper/state").length;
  retry.props.onClick();
  await delay(30);
  assert.equal(app.host.calls.filter((call) => call.path === "/dsh-wallpaper/state").length, before + 1);
  app.dispose();
});

test("a slow PATCH cannot revert a newer slider change", async () => {
  const app = await boot({ patchDelay: 140 });
  const range = () => findAll(app.render(), (element) => element.type === "input" && element.props.type === "range")[1];

  range().props.onChange({ currentTarget: { value: "80" } });
  await delay(240); // the first PATCH is now in flight
  range().props.onChange({ currentTarget: { value: "85" } });
  await delay(120); // the stale 80 response lands inside this window
  assert.equal(range().props.value, 85, "the stale response did not overwrite the newer value");

  await delay(320);
  assert.equal(app.host.state.config.panelOpacity, 85);
  app.dispose();
});

test("a bundled font is applied through the theme font variable and persisted", async () => {
  const app = await boot();
  try {
    const fontButton = findAll(
      app.render(),
      (element) => element.type === "button" && element.props.className === "dwp-fontCard" && element.props.title.includes("LXGW"),
    )[0];
    assert.ok(fontButton, "the WenKai card renders");
    assert.equal(app.dom.rootStyle.get("--dsh-font-family-text") ?? "", "");

    fontButton.props.onClick();
    await delay(280); // the write is debounced by PERSIST_DELAY
    assert.equal(
      app.dom.rootStyle.get("--dsh-font-family-text"),
      '"DWP WenKai", "Kaiti SC", "STKaiti", "PingFang SC", sans-serif',
    );

    const patch = app.host.calls.filter((call) => call.method === "PATCH");
    assert.equal(patch.length > 0, true);
    assert.equal(JSON.parse(String(patch.at(-1).init.body)).fontId, "wenkai");
    assert.equal(app.host.state.config.fontId, "wenkai");

    // The stylesheet declares every face up front but fetches nothing until used.
    const fontSheet = app.dom.styleTags.find((tag) => tag.dataset.pluginCss === "dsh-wallpaper/font.css");
    assert.ok(fontSheet, "font stylesheet exists");
    assert.match(fontSheet.textContent, /font-family:"DWP WenKai";/);
    assert.match(fontSheet.textContent, /"DWP Noto Serif SC Preview"/);
    assert.match(fontSheet.textContent, /\/dsh-wallpaper\/fonts\/serif\.woff2/);

    // Back to the system stack: the variable is removed, not set to a value.
    const systemButton = findAll(
      app.render(),
      (element) => element.type === "button" && element.props.className === "dwp-fontCard" && element.props.title.includes("苹方"),
    )[0];
    systemButton.props.onClick();
    await app.settle();
    assert.equal(app.dom.rootStyle.get("--dsh-font-family-text") ?? "", "");
  } finally {
    app.dispose();
  }
});

test("an unknown font id from the Host falls back to the system stack", async () => {
  const app = await boot({ config: { fontId: "removed-font" } });
  try {
    await app.settle();
    assert.equal(app.dom.rootStyle.get("--dsh-font-family-text") ?? "", "");
    assert.equal(app.dom.styleTags.some((tag) => tag.dataset.pluginCss === "dsh-wallpaper/font.css"), true);
  } finally {
    app.dispose();
  }
});

test("text scale rewrites the typography tokens and the body content sizes", async () => {
  const app = await boot();
  try {
    const scale = () =>
      findAll(app.render(), (element) => element.type === "input" && element.props.type === "range")[0];
    assert.equal(scale().props.value, 100);
    assert.equal(app.dom.bodyStyle.get("--dsw-font-base-16-font-size") ?? "", "");

    scale().props.onChange({ currentTarget: { value: "110" } });
    await app.settle();
    assert.equal(app.dom.bodyStyle.get("--dsw-font-base-16-font-size"), "17.6px");
    assert.equal(app.dom.bodyStyle.get("--dsw-font-base-16"), "17.6px/26.4px var(--dsw-font-family)");
    assert.equal(app.dom.bodyStyle.get("--dsh-content-font-size"), "15.4px");
    assert.equal(app.dom.bodyStyle.get("--dsh-code-font-size"), "12.1px");

    scale().props.onChange({ currentTarget: { value: "100" } });
    await app.settle();
    assert.equal(app.dom.bodyStyle.get("--dsw-font-base-16-font-size") ?? "", "");
    assert.equal(app.dom.bodyStyle.get("--dsh-content-font-size") ?? "", "");
  } finally {
    app.dispose();
  }
});

test("disposing the plugin removes the font layer and the scaled variables", async () => {
  const app = await boot();
  const fontButton = findAll(
    app.render(),
    (element) => element.type === "button" && element.props.className === "dwp-fontCard" && element.props.title.includes("LXGW"),
  )[0];
  fontButton.props.onClick();
  await app.settle();
  assert.notEqual(app.dom.rootStyle.get("--dsh-font-family-text") ?? "", "");
  app.dispose();
  assert.equal(app.dom.rootStyle.get("--dsh-font-family-text") ?? "", "");
  assert.equal(app.dom.styleTags.some((tag) => tag.dataset.pluginCss === "dsh-wallpaper/font.css"), false);
});

test("disposing the plugin cancels the pending write", async () => {
  const app = await boot();
  const range = findAll(app.render(), (element) => element.type === "input" && element.props.type === "range")[0];
  range.props.onChange({ currentTarget: { value: "70" } });
  app.dispose();
  await delay(320);
  const patches = app.host.calls.filter((call) => call.path === "/dsh-wallpaper/config" && call.method === "PATCH");
  assert.equal(patches.length, 0, "no write happens after dispose");
  assert.equal(app.host.state.config.panelOpacity, 52);
});

test("the locale dictionary is registered and released with the plugin", async () => {
  const app = await boot();
  assert.equal(app.locale.registeredCount(), 1);
  app.dispose();
  assert.equal(app.locale.registeredCount(), 0);
});

test("rejects an image with absurd pixel dimensions", async () => {
  const app = await boot();
  const fileInput = findAll(app.render(), (element) => element.type === "input" && element.props.type === "file")[0];
  // A valid PNG signature + IHDR carrying 20000x20000 (400 MP).
  const header = new Uint8Array(24);
  header.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  header.set([0, 0, 0, 13], 8);
  header.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(header.buffer).setUint32(16, 20000);
  new DataView(header.buffer).setUint32(20, 20000);
  const file = {
    name: "huge.png",
    type: "image/png",
    size: 4096,
    slice: () => ({ arrayBuffer: async () => header.buffer }),
  };
  fileInput.props.onChange({ currentTarget: { files: [file], value: "" } });
  await delay(60);
  const posts = app.host.calls.filter((call) => call.path === "/dsh-wallpaper/library" && call.method === "POST");
  assert.equal(posts.length, 0, "the huge image never reaches the Host");
  assert.match(allText(app.render()), /4000 万像素/);
  app.dispose();
});
