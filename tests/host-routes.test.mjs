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
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { apply, dataDirFor, dshHome, hostProfileFor, isTrustedRequest } from "../lib/index.js";

const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from("dsh-wallpaper-test-payload"),
]);

// ------------------------------------------------------------------ harness

function setup({ home = null } = {}) {
  const root = home ?? mkdtempSync(join(tmpdir(), "dsh-wallpaper-"));
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
      rmSync(root, { recursive: true, force: true });
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
    ],
  );
  app.dispose();
});

test("starts with defaults and creates the data files", async () => {
  const app = setup();
  const response = await state(app);
  assert.equal(response.status, 200);
  assert.deepEqual(response.json(), {
    config: { mode: "official", customId: null, panelOpacity: 52, blur: 0 },
    images: [],
  });
  assert.ok(existsSync(join(app.dataDir, "config.json")));
  assert.ok(existsSync(join(app.dataDir, "library.json")));
  app.dispose();
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
  const fake = await upload(app, {
    body: Buffer.concat([Buffer.from("GIF89a"), Buffer.from("payload")]),
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
