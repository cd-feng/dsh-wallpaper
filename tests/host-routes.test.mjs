/**
 * Tests for the Host half: the `/dsh-wallpaper/*` routes, the fence, the upload
 * validation and the on-disk durability (a Desktop restart gets a new browser
 * origin, so the files must survive here).
 *
 * Routes are driven directly: `apply()` is mounted on a fake Cordis context whose
 * `webServer.register` records the route table, then requests are replayed against
 * the recorded handlers with Node's IncomingMessage/ServerResponse shape.
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { after } from "node:test";

import { apply, dataDirFor, dshHome, hostProfileFor, isTrustedRequest } from "../lib/index.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("dsh-wallpaper-test-payload"),
]);

// ------------------------------------------------------------------ harness

const ownedRoots = new Set();
after(() => {
  for (const root of ownedRoots) rmSync(root, { recursive: true, force: true });
  ownedRoots.clear();
});

function setup({ home = null } = {}) {
  const root = home ?? mkdtempSync(join(tmpdir(), "dsh-wallpaper-"));
  if (home === null) ownedRoots.add(root);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = root;
  const routes = [];
  const effects = [];
  const host = {
    webServer: {
      register(route) {
        routes.push(route);
        return () => {
          const index = routes.indexOf(route);
          if (index >= 0) routes.splice(index, 1);
        };
      },
    },
    effect(run) {
      const disposer = run();
      effects.push(disposer);
      return disposer;
    },
  };
  const ctx = {
    inject(services, callback) {
      assert.deepEqual(services, ["webServer"]);
      callback(host);
    },
  };
  apply(ctx);
  const dataDir = dataDirFor(root, hostProfileFor(root));
  return {
    root,
    dataDir,
    routes,
    effects,
    dispose() {
      for (const disposer of effects.reverse()) {
        if (typeof disposer === "function") disposer();
      }
      if (previous === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previous;
      ownedRoots.delete(root);
      if (home === null) rmSync(root, { recursive: true, force: true });
    },
  };
}

function routeFor(routes, pathname) {
  const exact = routes.find((route) => route.kind === "exact" && route.path === pathname);
  if (exact !== undefined) return exact;
  let best;
  for (const route of routes) {
    if (route.kind !== "prefix") continue;
    if (pathname !== route.path && !pathname.startsWith(`${route.path}/`)) continue;
    if (best === undefined || route.path.length > best.path.length) best = route;
  }
  return best;
}

async function call(routes, method, url, options = {}) {
  const pathname = new URL(url, "http://127.0.0.1:1").pathname;
  const route = routeFor(routes, pathname);
  assert.ok(route, `no route for ${method} ${pathname}`);
  const chunks = options.body === undefined ? [] : [Buffer.isBuffer(options.body) ? options.body : Buffer.from(options.body)];
  const request = {
    method,
    url,
    headers: { host: "127.0.0.1:4321", ...(options.headers ?? {}) },
    socket: { remoteAddress: options.peer ?? "127.0.0.1" },
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
  const response = {
    headersSent: false,
    status: 0,
    headers: {},
    chunks: [],
    writeHead(status, headers = {}) {
      this.status = status;
      this.headers = headers;
      this.headersSent = true;
    },
    end(chunk) {
      if (chunk !== undefined) this.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    },
    destroy() {
      this.destroyed = true;
    },
    body() {
      return Buffer.concat(this.chunks);
    },
    json() {
      return JSON.parse(this.body().toString("utf8"));
    },
  };
  await route.handler(request, response);
  return response;
}

const state = (app) => call(app.routes, "GET", "/dsh-wallpaper/state");

/** A PNG header with a real IHDR chunk (no pixel data; the Host only reads headers). */
function pngWithSize(width, height) {
  const header = Buffer.alloc(33);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "latin1");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  header[24] = 8; // bit depth
  header[25] = 6; // RGBA
  return header;
}

function corruptFiles(root) {
  return readdirSync(root).filter((file) => file.includes(".corrupt-"));
}

async function upload(app, { body = PNG, mime = "image/png", name = "wallpaper.png" } = {}) {
  return call(app.routes, "POST", "/dsh-wallpaper/library", {
    headers: { "content-type": mime, "x-filename": encodeURIComponent(name) },
    body,
  });
}

// -------------------------------------------------------------------- tests

test("registers the documented routes", () => {
  const app = setup();
  assert.deepEqual(
    app.routes.map((route) => `${route.kind} ${route.path}`),
    [
      "exact /dsh-wallpaper/state",
      "exact /dsh-wallpaper/config",
      "exact /dsh-wallpaper/library",
      "prefix /dsh-wallpaper/library",
      "prefix /dsh-wallpaper/assets",
      "prefix /dsh-wallpaper/fonts",
    ],
  );
  app.dispose();
});

test("starts with defaults and creates the data files", async () => {
  const app = setup();
  const response = await state(app);
  assert.equal(response.status, 200);
  const payload = response.json();
  assert.deepEqual(payload.config, {
    mode: "official",
    customId: null,
    panelOpacity: 52,
    surfaceOpacity: null,
    blur: 0,
    fontId: "system",
    fontScale: 100,
  });
  assert.deepEqual(payload.images, []);
  assert.equal(payload.fonts.length, 3);
  assert.deepEqual(
    payload.fonts.map((font) => font.id),
    ["wenkai", "serif", "sans"],
  );
  assert.equal(payload.fonts[0].labels.zh, "霞鹜文楷");
  assert.match(payload.fonts[0].fallback, /Kaiti SC/);
  assert.ok(existsSync(join(app.dataDir, "config.json")));
  assert.ok(existsSync(join(app.dataDir, "library.json")));
  app.dispose();
});

test("serves the bundled fonts with an immutable cache and ETag/304", async () => {
  const app = setup();
  const woff2 = await call(app.routes, "GET", "/dsh-wallpaper/fonts/wenkai.woff2");
  assert.equal(woff2.status, 200);
  assert.equal(woff2.headers["content-type"], "font/woff2");
  assert.equal(woff2.headers["cache-control"], "private, max-age=31536000, immutable");
  assert.match(woff2.headers.etag, /^"[0-9a-f]{64}"$/);
  assert.equal(woff2.body().subarray(0, 4).toString("latin1"), "wOF2");
  assert.equal(Number(woff2.headers["content-length"]), woff2.body().length);

  const head = await call(app.routes, "HEAD", "/dsh-wallpaper/fonts/wenkai.woff2");
  assert.equal(head.status, 200);
  assert.equal(head.body().length, 0);
  assert.equal(Number(head.headers["content-length"]), woff2.body().length);

  const cached = await call(app.routes, "GET", "/dsh-wallpaper/fonts/wenkai.woff2", {
    headers: { "if-none-match": woff2.headers.etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body().length, 0);

  const preview = await call(app.routes, "GET", "/dsh-wallpaper/fonts/serif-preview.woff2");
  assert.equal(preview.status, 200);
  assert.equal(preview.body().subarray(0, 4).toString("latin1"), "wOF2");
  assert.ok(preview.body().length < 20 * 1024, "preview subsets stay tiny");

  // The OFL texts ship with the package and are served for transparency.
  const license = await call(app.routes, "GET", "/dsh-wallpaper/fonts/LICENSE-wenkai.txt");
  assert.equal(license.status, 200);
  assert.match(license.headers["content-type"], /^text\/plain/);
  assert.match(license.body().toString("utf8"), /SIL OPEN FONT LICENSE/);
  app.dispose();
});

test("font requests only reach files the manifest allows", async () => {
  const app = setup();
  for (const url of [
    "/dsh-wallpaper/fonts/manifest.json",
    "/dsh-wallpaper/fonts/%2e%2e%2fpackage.json",
    "/dsh-wallpaper/fonts/unknown.woff2",
  ]) {
    const response = await call(app.routes, "GET", url);
    assert.equal(response.status, 404, `${url} must not be served`);
  }
  // A literal `../` is normalized by the URL parser into a path no route owns.
  assert.equal(routeFor(app.routes, "/dsh-wallpaper/package.json"), undefined);
  app.dispose();
});

test("persists the font choice and scale, and clamps bad values", async () => {
  const root = mkdtempSync(join(tmpdir(), "dsh-wallpaper-font-"));
  ownedRoots.add(root);
  const app = setup({ home: root });
  const patched = await call(app.routes, "PATCH", "/dsh-wallpaper/config", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fontId: "serif", fontScale: 110 }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().config.fontId, "serif");
  assert.equal(patched.json().config.fontScale, 110);

  const bad = await call(app.routes, "PATCH", "/dsh-wallpaper/config", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ fontId: "../../etc/passwd", fontScale: 500 }),
  });
  assert.equal(bad.status, 200);
  assert.equal(bad.json().config.fontId, "system");
  assert.equal(bad.json().config.fontScale, 110);

  const saved = JSON.parse(readFileSync(join(app.dataDir, "config.json"), "utf8"));
  assert.equal(saved.fontId, "system");
  assert.equal(saved.fontScale, 110);

  // A restart re-reads the same file.
  app.dispose();
  const restarted = setup({ home: root });
  const snapshot = await state(restarted);
  assert.equal(snapshot.json().config.fontScale, 110);
  assert.equal(snapshot.json().config.fontId, "system");
  restarted.dispose();
  ownedRoots.delete(root);
  rmSync(root, { recursive: true, force: true });
});

test("uploads an image, selects it, serves it and keeps it on disk", async () => {
  const app = setup();
  const uploaded = await upload(app, { name: "极光 截图.png" });
  assert.equal(uploaded.status, 201, uploaded.body().toString("utf8"));
  const payload = uploaded.json();
  assert.equal(payload.config.mode, "custom");
  assert.equal(payload.images.length, 1);
  const image = payload.images[0];
  assert.match(image.id, /^[0-9a-f-]{36}$/);
  assert.equal(image.name, "极光 截图.png");
  assert.equal(image.mime, "image/png");
  assert.equal(image.size, PNG.length);
  assert.equal(payload.config.customId, image.id);

  const file = join(app.dataDir, "images", `${image.id}.png`);
  assert.ok(existsSync(file), "bytes were written under images/");
  assert.deepEqual(readFileSync(file), PNG);

  const asset = await call(app.routes, "GET", `/dsh-wallpaper/assets/${image.id}`);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers["content-type"], "image/png");
  assert.equal(asset.headers["x-content-type-options"], "nosniff");
  assert.match(asset.headers.etag, /^"[0-9a-f]{64}"$/);
  assert.deepEqual(asset.body(), PNG);

  // The page sends If-None-Match on reload; a matching tag answers 304 with no body.
  const cached = await call(app.routes, "GET", `/dsh-wallpaper/assets/${image.id}`, {
    headers: { "if-none-match": asset.headers.etag },
  });
  assert.equal(cached.status, 304);
  assert.equal(cached.body().length, 0);

  const snapshot = await state(app);
  assert.equal(snapshot.json().config.mode, "custom");
  app.dispose();
});

test("patches the preference, clamps it and survives a restart", async () => {
  const app = setup();
  const patched = await call(app.routes, "PATCH", "/dsh-wallpaper/config", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ panelOpacity: 1000, blur: -3 }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.json().config.panelOpacity, 100);
  assert.equal(patched.json().config.blur, 0);

  // A Desktop restart is a brand-new browser origin; the Host store must still
  // answer with the same preference from disk.
  const restarted = setup({ home: app.root });
  const snapshot = await state(restarted);
  assert.equal(snapshot.json().config.panelOpacity, 100);
  restarted.dispose();
  app.dispose();
});

test("overlay opacity persists as follow-panel or a clamped percentage", async () => {
  const app = setup();
  const patch = (body) =>
    call(app.routes, "PATCH", "/dsh-wallpaper/config", { body: Buffer.from(JSON.stringify(body)) });

  const follow = await patch({ surfaceOpacity: null });
  assert.equal(follow.status, 200);
  assert.equal(follow.json().config.surfaceOpacity, null);

  const explicit = await patch({ surfaceOpacity: 72 });
  assert.equal(explicit.json().config.surfaceOpacity, 72);
  assert.equal(JSON.parse(readFileSync(join(app.dataDir, "config.json"), "utf8")).surfaceOpacity, 72);

  // Out of range clamps; unparsable values fall back to following the panel.
  assert.equal((await patch({ surfaceOpacity: 1000 })).json().config.surfaceOpacity, 100);
  assert.equal((await patch({ surfaceOpacity: 5 })).json().config.surfaceOpacity, 20);
  assert.equal((await patch({ surfaceOpacity: "abc" })).json().config.surfaceOpacity, null);
  assert.equal((await patch({ surfaceOpacity: 72 })).json().config.surfaceOpacity, 72);

  // A config file written before 0.8 keeps working and follows the panel.
  writeFileSync(join(app.dataDir, "config.json"), `${JSON.stringify({ mode: "official", customId: null, panelOpacity: 52, blur: 0 })}\n`);
  const restarted = setup({ home: app.root });
  const snapshot = await state(restarted);
  assert.equal(snapshot.json().config.surfaceOpacity, null);
  assert.equal(snapshot.json().config.panelOpacity, 52);
  restarted.dispose();
  app.dispose();
});

test("deleting the selected image clears the selection and the bytes", async () => {
  const app = setup();
  const image = (await upload(app)).json().images[0];
  const removed = await call(app.routes, "DELETE", `/dsh-wallpaper/library/${image.id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual(removed.json().images, []);
  assert.equal(removed.json().config.mode, "official");
  assert.equal(removed.json().config.customId, null);
  assert.equal(existsSync(join(app.dataDir, "images", `${image.id}.png`)), false);
  app.dispose();
});

test("fences every route to a same-origin loopback request", async () => {
  const app = setup();
  const bad = [
    { headers: { host: "evil.example.com" } },
    { headers: { "sec-fetch-site": "cross-site" } },
    { headers: { origin: "http://evil.example.com" } },
    { peer: "10.0.0.7" },
  ];
  for (const options of bad) {
    const response = await call(app.routes, "GET", "/dsh-wallpaper/state", options);
    assert.equal(response.status, 403, JSON.stringify(options));
  }
  const trusted = await call(app.routes, "GET", "/dsh-wallpaper/state", {
    headers: { origin: "http://127.0.0.1:4321" },
  });
  assert.equal(trusted.status, 200);
  app.dispose();
});

test("isTrustedRequest accepts the page's own requests only", () => {
  const request = (headers, peer = "127.0.0.1") => ({
    headers,
    socket: { remoteAddress: peer },
  });
  assert.equal(isTrustedRequest(request({ host: "127.0.0.1:9" })), true);
  assert.equal(isTrustedRequest(request({ host: "localhost:9" })), true);
  assert.equal(isTrustedRequest(request({ host: "[::1]:9" }), "::1"), true);
  assert.equal(isTrustedRequest(request({ host: "127.0.0.1:9", origin: "http://127.0.0.1:9" })), true);
  assert.equal(isTrustedRequest(request({ host: "127.0.0.1:9", origin: "http://127.0.0.1:8" })), false);
  assert.equal(isTrustedRequest(request({ host: "evil.example.com" })), false);
  assert.equal(isTrustedRequest(request({ host: "127.0.0.1:9", "sec-fetch-site": "cross-site" })), false);
  assert.equal(isTrustedRequest(request({})), false);
  // Any 127/8 peer is loopback, not just 127.0.0.1 (the server may bind 127.0.0.2).
  assert.equal(isTrustedRequest(request({ host: "127.0.0.2:9" }, "127.0.0.2")), true);
  assert.equal(isTrustedRequest(request({ host: "127.0.0.2:9" }, "127.9.9.9")), true);
  assert.equal(isTrustedRequest(request({ host: "127.0.0.2:9" }, "10.0.0.1")), false);
  // Origin scheme and port must match the page, not just the hostname.
  assert.equal(isTrustedRequest(request({ host: "127.0.0.1:9", origin: "https://127.0.0.1:9" })), false);
  assert.equal(isTrustedRequest(request({ host: "127.0.0.1:9", origin: "http://127.0.0.1:9", "sec-fetch-site": "same-origin" })), true);
});

test("rejects unsupported, empty and oversized uploads", async () => {
  const app = setup();
  const text = await upload(app, { body: Buffer.from("hello"), mime: "text/plain", name: "notes.txt" });
  assert.equal(text.status, 415);

  const empty = await upload(app, { body: Buffer.alloc(0) });
  assert.equal(empty.status, 400);

  const declaredTooLarge = await call(app.routes, "POST", "/dsh-wallpaper/library", {
    headers: { "content-type": "image/png", "content-length": String(21 * 1024 * 1024) },
    body: PNG,
  });
  assert.equal(declaredTooLarge.status, 413);

  // A GIF header with a PNG declaration is sniffed by magic bytes, not trusted.
  // The header carries a real 1x1 logical screen descriptor.
  const gifHeader = Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0x01, 0x00, 0x01, 0x00, 0x80, 0x00, 0x00]);
  const fake = await upload(app, {
    body: Buffer.concat([gifHeader, Buffer.from("payload")]),
    mime: "image/png",
    name: "actually.gif",
  });
  assert.equal(fake.status, 201);
  assert.equal(fake.json().images[0].mime, "image/gif");
  app.dispose();
});

test("rejects malformed ids and unknown assets", async () => {
  const app = setup();
  const traversal = await call(app.routes, "DELETE", "/dsh-wallpaper/library/..%2F..%2Fetc");
  assert.equal(traversal.status, 400);
  const unknown = await call(app.routes, "GET", "/dsh-wallpaper/assets/00000000-0000-4000-8000-00000000dead");
  assert.equal(unknown.status, 404);
  const badAsset = await call(app.routes, "GET", "/dsh-wallpaper/assets/nope.png");
  assert.equal(badAsset.status, 400);
  app.dispose();
});

test("drops library entries whose file is gone when the store reloads", async () => {
  const app = setup();
  const image = (await upload(app)).json().images[0];
  rmSync(join(app.dataDir, "images", `${image.id}.png`), { force: true });

  // Entries are read (and pruned) on store load, i.e. the next Host start.
  const restarted = setup({ home: app.root });
  const snapshot = await state(restarted);
  assert.deepEqual(snapshot.json().images, []);
  assert.equal(snapshot.json().config.mode, "official");
  restarted.dispose();
  app.dispose();
});

test("resolves DSH_HOME and the per-profile data directory", () => {
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = "/tmp/dsh-home-test";
  assert.equal(dshHome(), "/tmp/dsh-home-test");
  assert.equal(dataDirFor("/tmp/dsh-home-test", "desktop"), "/tmp/dsh-home-test/dsh-wallpaper-desktop");
  assert.equal(dataDirFor("/tmp/dsh-home-test", "web"), "/tmp/dsh-home-test/dsh-wallpaper");
  assert.equal(hostProfileFor("/tmp/dsh-home-test", "/tmp/dsh-home-test/profiles/desktop"), "desktop");
  assert.equal(hostProfileFor("/tmp/dsh-home-test", "/tmp/dsh-home-test/profiles/web"), "web");
  if (previous === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = previous;
});

// ------------------------------------------------------- failure-path coverage

test("a failed upload leaves no image row and no file behind", async () => {
  const app = setup();
  // A directory where library.json belongs makes the metadata write fail.
  rmSync(join(app.dataDir, "library.json"), { force: true });
  mkdirSync(join(app.dataDir, "library.json"));

  const response = await upload(app);
  assert.equal(response.status, 500);
  const snapshot = await state(app);
  assert.deepEqual(snapshot.json().images, []);
  assert.equal(snapshot.json().config.mode, "official");
  assert.deepEqual(readdirSync(join(app.dataDir, "images")), []);

  // Once the obstruction is gone the same upload works again: no stale memory.
  rmSync(join(app.dataDir, "library.json"), { recursive: true, force: true });
  const retried = await upload(app);
  assert.equal(retried.status, 201);
  assert.equal(retried.json().images.length, 1);
  app.dispose();
});

test("corrupt store files are quarantined instead of silently reset", async () => {
  const app = setup();
  const image = (await upload(app)).json().images[0];

  writeFileSync(
    join(app.dataDir, "config.json"),
    `${JSON.stringify({ mode: "custom", customId: image.id, panelOpacity: 40, blur: 5 })}\n`,
  );
  writeFileSync(join(app.dataDir, "library.json"), "{ this is not json");

  const restarted = setup({ home: app.root });
  const snapshot = await state(restarted);
  assert.equal(snapshot.status, 200);
  // The library failed to load, so the selection is kept, not "repaired" away.
  assert.equal(snapshot.json().config.mode, "custom");
  assert.equal(snapshot.json().config.customId, image.id);
  assert.equal(snapshot.json().config.panelOpacity, 40);
  assert.deepEqual(snapshot.json().images, []);
  assert.match(snapshot.json().warning, /library\.json was unreadable/);
  assert.equal(corruptFiles(app.dataDir).filter((file) => file.startsWith("library.json")).length, 1);

  // Writing a preference would overwrite the file the user may still repair.
  const patch = await call(restarted.routes, "PATCH", "/dsh-wallpaper/config", { body: Buffer.from("{}") });
  assert.equal(patch.status, 503);
  restarted.dispose();
  app.dispose();
});

test("GET /state does not write to disk", async () => {
  const app = setup();
  const configBefore = statSync(join(app.dataDir, "config.json")).mtimeMs;
  const libraryBefore = statSync(join(app.dataDir, "library.json")).mtimeMs;
  await state(app);
  await state(app);
  assert.equal(statSync(join(app.dataDir, "config.json")).mtimeMs, configBefore);
  assert.equal(statSync(join(app.dataDir, "library.json")).mtimeMs, libraryBefore);
  app.dispose();
});

test("rejects absurd pixel dimensions server-side, not just in the browser", async () => {
  const app = setup();
  const huge = await upload(app, { body: pngWithSize(20000, 20000) });
  assert.equal(huge.status, 413);
  assert.equal(huge.json().code, "IMAGE_TOO_LARGE");
  assert.deepEqual((await state(app)).json().images, []);

  const ok = await upload(app, { body: pngWithSize(4000, 3000) });
  assert.equal(ok.status, 201);
  app.dispose();
});

test("serves HEAD, ETag lists and Last-Modified without reading the file", async () => {
  const app = setup();
  const image = (await upload(app)).json().images[0];
  const full = await call(app.routes, "GET", `/dsh-wallpaper/assets/${image.id}`);
  assert.equal(full.status, 200);
  assert.ok(full.body().length > 0);
  const etag = full.headers.etag;
  assert.match(etag, /^"[0-9a-f]{64}"$/);
  assert.ok(!Number.isNaN(Date.parse(full.headers["last-modified"])));

  for (const candidate of [etag, `W/${etag}`, `"nope", ${etag}`, "*"]) {
    const cached = await call(app.routes, "GET", `/dsh-wallpaper/assets/${image.id}`, {
      headers: { "if-none-match": candidate },
    });
    assert.equal(cached.status, 304, candidate);
    assert.equal(cached.body().length, 0);
  }

  const head = await call(app.routes, "HEAD", `/dsh-wallpaper/assets/${image.id}`);
  assert.equal(head.status, 200);
  assert.equal(head.body().length, 0);
  assert.ok(Number(head.headers["content-length"]) > 0);

  const notModified = await call(app.routes, "GET", `/dsh-wallpaper/assets/${image.id}`, {
    headers: { "if-none-match": '"deadbeef"' },
  });
  assert.equal(notModified.status, 200);
  app.dispose();
});

test("stores files with owner-only permissions and refuses symlinked assets", async () => {
  const app = setup();
  const image = (await upload(app)).json().images[0];
  assert.equal(statSync(app.dataDir).mode & 0o777, 0o700);
  assert.equal(statSync(join(app.dataDir, "images")).mode & 0o777, 0o700);
  assert.equal(statSync(join(app.dataDir, "config.json")).mode & 0o777, 0o600);
  assert.equal(statSync(join(app.dataDir, "images", `${image.id}.png`)).mode & 0o777, 0o600);

  const imagePath = join(app.dataDir, "images", `${image.id}.png`);
  rmSync(imagePath, { force: true });
  symlinkSync(join(app.dataDir, "config.json"), imagePath);
  const response = await call(app.routes, "GET", `/dsh-wallpaper/assets/${image.id}`);
  assert.equal(response.status, 404);
  app.dispose();
});

test("prefers the profile hint over cwd and only cleans up its own temp root", () => {
  assert.equal(
    hostProfileFor("/tmp/dsh-home-test", "/tmp/whatever", ["@deepseek-ai/dsh-desktop"]),
    "desktop",
  );
  assert.equal(hostProfileFor("/tmp/dsh-home-test", "/tmp/dsh-home-test/profiles/desktop", []), "desktop");
  assert.equal(hostProfileFor("/tmp/dsh-home-test", "/tmp/elsewhere", []), "web");

  const callerRoot = mkdtempSync(join(tmpdir(), "dsh-wallpaper-caller-"));
  const app = setup({ home: callerRoot });
  app.dispose();
  assert.ok(existsSync(callerRoot));
  rmSync(callerRoot, { recursive: true, force: true });
});

test("a failed PATCH cannot report success on a same-value retry", async () => {
  const app = setup();
  const configPath = join(app.dataDir, "config.json");
  rmSync(configPath, { force: true });
  mkdirSync(configPath);

  const failed = await call(app.routes, "PATCH", "/dsh-wallpaper/config", {
    body: Buffer.from('{"panelOpacity":70}'),
  });
  assert.equal(failed.status, 500);
  // Memory kept the old value, so the next read is honest about what is on disk.
  assert.equal((await state(app)).json().config.panelOpacity, 52);

  rmSync(configPath, { recursive: true, force: true });
  writeFileSync(configPath, `${JSON.stringify({ mode: "official", customId: null, panelOpacity: 52, blur: 0 })}\n`);
  const retried = await call(app.routes, "PATCH", "/dsh-wallpaper/config", {
    body: Buffer.from('{"panelOpacity":70}'),
  });
  assert.equal(retried.status, 200);
  assert.equal(JSON.parse(readFileSync(configPath, "utf8")).panelOpacity, 70);
  // Mode survives the retry: it was never reset to the default by the failure.
  assert.equal(retried.json().config.mode, "official");
  app.dispose();
});
