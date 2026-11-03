/**
 * dsh-wallpaper — host half.
 *
 * The wallpaper itself is painted in the browser (theme tokens + page layer live
 * there), but the durable state lives here: the Desktop app can launch the Web
 * server on `--port 0`, so every restart gets a fresh origin and browser storage
 * (localStorage / IndexedDB) is *not* a place to keep an uploaded wallpaper. This
 * half therefore owns the image library and the preference file, and exposes them
 * as plain same-origin routes under `/dsh-wallpaper/*`:
 *
 *   GET    /dsh-wallpaper/state           -> { config, images }
 *   PATCH  /dsh-wallpaper/config          -> partial config -> { config, images }
 *   POST   /dsh-wallpaper/library         -> raw image body -> { config, images }
 *   DELETE /dsh-wallpaper/library/<id>    -> { config, images }
 *   GET    /dsh-wallpaper/assets/<id>     -> image bytes (immutable cache)
 *
 * Data lives in `<DSH_HOME>/dsh-wallpaper[-desktop]/`:
 *   config.json   { mode, customId, panelOpacity, blur }
 *   library.json  { images: [{ id, name, mime, size, sha256, addedAt, file }] }
 *   images/       <id>.<png|jpg|webp|gif|avif>
 *
 * Every route is fenced to a trusted same-origin loopback request (Host header,
 * loopback peer, `sec-fetch-site`, `Origin`), because plugin routes bypass the
 * Web app's own page authentication.
 */
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const name = "dsh-wallpaper";

const API_BASE = "/dsh-wallpaper";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const BODY_LIMIT = MAX_UPLOAD_BYTES + 1024 * 1024;
const CONFIG_FILE = "config.json";
const LIBRARY_FILE = "library.json";
const IMAGES_DIR = "images";
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_FILE = /^([0-9a-f-]{36})\.(png|jpg|webp|gif|avif)$/;
const EXTENSIONS = new Map([
  ["image/png", "png"],
  ["image/jpeg", "jpg"],
  ["image/webp", "webp"],
  ["image/gif", "gif"],
  ["image/avif", "avif"],
]);
const DEFAULTS = Object.freeze({ mode: "official", customId: null, panelOpacity: 52, blur: 0 });
const OPACITY_MIN = 20;
const OPACITY_MAX = 100;
const BLUR_MIN = 0;
const BLUR_MAX = 24;

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// ---------------------------------------------------------------- data paths

function expandHome(value) {
  if (value === "~") return homedir();
  if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
  return value;
}

/** Same discovery as the other bundled plugins: DSH_HOME wins, then ~/.dsh. */
export function dshHome(env = process.env) {
  const configured = typeof env.DSH_HOME === "string" ? env.DSH_HOME.trim() : "";
  return resolve(expandHome(configured === "" ? join(homedir(), ".dsh") : configured));
}

/** Desktop runs with cwd = <DSH_HOME>/profiles/desktop; keep its data separate. */
export function hostProfileFor(root, cwd = process.cwd()) {
  const normalize = (path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  return normalize(cwd) === normalize(join(expandHome(root), "profiles", "desktop")) ? "desktop" : "web";
}

export function dataDirFor(root, profile) {
  const base = resolve(expandHome(root));
  return join(base, profile === "desktop" ? "dsh-wallpaper-desktop" : "dsh-wallpaper");
}

// --------------------------------------------------------------- small utils

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function readJson(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    return parsed !== null && typeof parsed === "object" ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(temporary, file);
}

function extensionFor(mime) {
  return EXTENSIONS.get(mime) ?? null;
}

function sniffImageMime(buffer) {
  if (buffer.length >= 8) {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    if (buffer.subarray(0, 8).equals(png)) return "image/png";
  }
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 6 && buffer.subarray(0, 4).toString("latin1") === "GIF8") return "image/gif";
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("latin1") === "RIFF" &&
    buffer.subarray(8, 12).toString("latin1") === "WEBP"
  ) {
    return "image/webp";
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString("latin1") === "ftyp") {
    const brand = buffer.subarray(8, 12).toString("latin1");
    if (brand === "avif" || brand === "avis") return "image/avif";
  }
  return null;
}

// -------------------------------------------------------------------- store

function normalizeConfig(raw, images) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  let mode = source.mode;
  if (mode !== "official" && mode !== "builtin" && mode !== "custom") mode = DEFAULTS.mode;
  const known = new Set(images.map((image) => image.id));
  let customId = typeof source.customId === "string" && known.has(source.customId) ? source.customId : null;
  if (mode === "custom" && customId === null) mode = DEFAULTS.mode;
  return {
    mode,
    customId,
    panelOpacity: clampInt(source.panelOpacity, OPACITY_MIN, OPACITY_MAX, DEFAULTS.panelOpacity),
    blur: clampInt(source.blur, BLUR_MIN, BLUR_MAX, DEFAULTS.blur),
  };
}

export function createStore(dataDir) {
  const imagesDir = join(dataDir, IMAGES_DIR);
  const configFile = join(dataDir, CONFIG_FILE);
  const libraryFile = join(dataDir, LIBRARY_FILE);
  let config = null;
  let images = null;

  const loadImages = () => {
    const raw = readJson(libraryFile, { images: [] });
    const list = Array.isArray(raw.images) ? raw.images : [];
    const kept = [];
    for (const entry of list) {
      if (entry === null || typeof entry !== "object") continue;
      if (typeof entry.id !== "string" || !ASSET_ID.test(entry.id)) continue;
      if (typeof entry.file !== "string" || !IMAGE_FILE.test(entry.file)) continue;
      if (entry.file.slice(0, 36) !== entry.id) continue;
      if (typeof entry.mime !== "string" || extensionFor(entry.mime) === null) continue;
      if (!existsSync(join(imagesDir, entry.file))) continue;
      kept.push({
        id: entry.id,
        name: typeof entry.name === "string" && entry.name !== "" ? entry.name : entry.id,
        mime: entry.mime,
        size: clampInt(entry.size, 1, MAX_UPLOAD_BYTES, 1),
        sha256: typeof entry.sha256 === "string" ? entry.sha256 : "",
        addedAt: clampInt(entry.addedAt, 0, Number.MAX_SAFE_INTEGER, 0),
        file: entry.file,
      });
    }
    kept.sort((a, b) => b.addedAt - a.addedAt);
    return kept;
  };

  const ensure = () => {
    if (config !== null && images !== null) return;
    images = loadImages();
    const raw = readJson(configFile, null);
    const normalized = normalizeConfig(raw, images);
    config = normalized;
    if (raw === null || JSON.stringify(raw) !== JSON.stringify(normalized)) writeJsonAtomic(configFile, normalized);
    if (!existsSync(libraryFile)) writeJsonAtomic(libraryFile, { images });
  };

  const publicImages = () => images.map(({ id, name, mime, size, sha256, addedAt }) => ({ id, name, mime, size, sha256, addedAt }));
  const snapshot = () => {
    ensure();
    return { config: { ...config }, images: publicImages() };
  };

  const persistConfig = (next) => {
    config = next;
    writeJsonAtomic(configFile, next);
  };

  const persistLibrary = () => {
    writeJsonAtomic(libraryFile, { images });
  };

  const addImage = ({ buffer, mime, name }) => {
    ensure();
    const id = randomUUID();
    const extension = extensionFor(mime);
    const file = `${id}.${extension}`;
    mkdirSync(imagesDir, { recursive: true });
    const target = join(imagesDir, file);
    const temporary = `${target}.${process.pid}.tmp`;
    writeFileSync(temporary, buffer);
    renameSync(temporary, target);
    const entry = {
      id,
      name,
      mime,
      size: buffer.length,
      sha256: createHash("sha256").update(buffer).digest("hex"),
      addedAt: Date.now(),
      file,
    };
    images.unshift(entry);
    persistLibrary();
    const next = normalizeConfig({ ...config, mode: "custom", customId: id }, images);
    persistConfig(next);
    return { ...entry };
  };

  const removeImage = (id) => {
    ensure();
    const index = images.findIndex((image) => image.id === id);
    if (index < 0) throw new HttpError(404, "ASSET_NOT_FOUND", "image not found");
    const [entry] = images.splice(index, 1);
    try {
      rmSync(join(imagesDir, entry.file), { force: true });
    } catch {
      /* the metadata is gone either way */
    }
    persistLibrary();
    persistConfig(normalizeConfig(config, images));
    return { id };
  };

  const patchConfig = (patch) => {
    ensure();
    const source = patch !== null && typeof patch === "object" ? patch : {};
    const next = normalizeConfig({ ...config, ...source }, images);
    persistConfig(next);
    return next;
  };

  const readAsset = (id) => {
    ensure();
    const entry = images.find((image) => image.id === id);
    if (entry === undefined) throw new HttpError(404, "ASSET_NOT_FOUND", "image not found");
    try {
      return { meta: entry, buffer: readFileSync(join(imagesDir, entry.file)) };
    } catch {
      throw new HttpError(404, "ASSET_NOT_FOUND", "image file missing");
    }
  };

  return { snapshot, addImage, removeImage, patchConfig, readAsset };
}

// ----------------------------------------------------------------- request IO

function header(headers, key) {
  const value = headers?.[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function sendJson(response, status, value) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(body);
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isLoopbackAddress(address) {
  return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1" || address === "::ffff:7f00:1";
}

/**
 * Plugin routes bypass the Web app's page authentication, so each one must prove
 * the request came from the same-origin loopback page: Host header, loopback
 * peer, browser fetch site, and (when present) an Origin equal to Host.
 */
export function isTrustedRequest(request) {
  const host = header(request.headers, "host");
  if (typeof host !== "string" || host === "") return false;
  let parsed;
  try {
    parsed = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(parsed.hostname)) return false;
  const peer = request.socket?.remoteAddress;
  if (typeof peer === "string" && !isLoopbackAddress(peer)) return false;
  if (header(request.headers, "sec-fetch-site") === "cross-site") return false;
  const origin = header(request.headers, "origin");
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === parsed.host;
  } catch {
    return false;
  }
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new HttpError(413, "BODY_TOO_LARGE", `body larger than ${limit} bytes`);
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

async function readJsonBody(request) {
  const raw = await readBody(request, 64 * 1024);
  if (raw.length === 0) return {};
  try {
    const value = JSON.parse(raw.toString("utf8"));
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new HttpError(400, "INVALID_CONFIG", "body must be a JSON object");
    }
    return value;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "INVALID_CONFIG", "body is not valid JSON");
  }
}

function decodeName(request) {
  const raw = header(request.headers, "x-filename");
  if (raw === undefined || raw === "") return "wallpaper";
  try {
    const decoded = decodeURIComponent(raw);
    return decoded === "" ? "wallpaper" : decoded.slice(0, 200);
  } catch {
    throw new HttpError(400, "FILENAME_INVALID", "x-filename is not encodeURIComponent output");
  }
}

function method(request, response, expected) {
  if (request.method === expected) return true;
  response.writeHead(405, { allow: expected, "cache-control": "no-store" });
  response.end();
  return false;
}

function statusOf(error) {
  return error instanceof HttpError ? error.status : 500;
}

function codeOf(error) {
  return error instanceof HttpError ? error.code : "INTERNAL";
}

function errorBody(error) {
  return { error: error instanceof Error ? error.message : String(error), code: codeOf(error) };
}

function fenced(handler) {
  return async (request, response) => {
    if (!isTrustedRequest(request)) {
      sendJson(response, 403, { error: "trusted DSH Web request required", code: "UNTRUSTED" });
      return;
    }
    try {
      await handler(request, response);
    } catch (error) {
      if (response.headersSent) {
        response.destroy();
        return;
      }
      sendJson(response, statusOf(error), errorBody(error));
    }
  };
}

// -------------------------------------------------------------------- routes

export function mountRoutes(host, store) {
  const disposers = [];
  try {
    disposers.push(
      host.webServer.register({
        kind: "exact",
        path: `${API_BASE}/state`,
        handler: fenced(async (request, response) => {
          if (!method(request, response, "GET")) return;
          sendJson(response, 200, store.snapshot());
        }),
      }),
    );
    disposers.push(
      host.webServer.register({
        kind: "exact",
        path: `${API_BASE}/config`,
        handler: fenced(async (request, response) => {
          if (!method(request, response, "PATCH")) return;
          const patch = await readJsonBody(request);
          store.patchConfig(patch);
          sendJson(response, 200, store.snapshot());
        }),
      }),
    );
    disposers.push(
      host.webServer.register({
        kind: "exact",
        path: `${API_BASE}/library`,
        handler: fenced(async (request, response) => {
          if (request.method === "GET") {
            sendJson(response, 200, store.snapshot());
            return;
          }
          if (!method(request, response, "POST")) return;
          const declared = Number(header(request.headers, "content-length") ?? "0");
          if (Number.isFinite(declared) && declared > MAX_UPLOAD_BYTES) {
            throw new HttpError(413, "UPLOAD_TOO_LARGE", "image larger than 20 MB");
          }
          const buffer = await readBody(request, BODY_LIMIT);
          if (buffer.length === 0) throw new HttpError(400, "EMPTY_UPLOAD", "empty upload");
          if (buffer.length > MAX_UPLOAD_BYTES) throw new HttpError(413, "UPLOAD_TOO_LARGE", "image larger than 20 MB");
          const sniffed = sniffImageMime(buffer);
          const declaredMime = header(request.headers, "content-type");
          const mime = sniffed ?? (typeof declaredMime === "string" ? declaredMime.split(";")[0].trim().toLowerCase() : "");
          if (extensionFor(mime) === null) throw new HttpError(415, "UNSUPPORTED_IMAGE", "unsupported image format");
          store.addImage({ buffer, mime, name: decodeName(request) });
          sendJson(response, 201, store.snapshot());
        }),
      }),
    );
    disposers.push(
      host.webServer.register({
        kind: "prefix",
        path: `${API_BASE}/library`,
        handler: fenced(async (request, response) => {
          if (!method(request, response, "DELETE")) return;
          const pathname = String(request.url ?? "").split("?")[0];
          const match = /\/dsh-wallpaper\/library\/([^/]+)$/.exec(pathname);
          const id = match?.[1] ?? "";
          if (!ASSET_ID.test(id)) throw new HttpError(400, "INVALID_ASSET_ID", "invalid image id");
          store.removeImage(id);
          sendJson(response, 200, store.snapshot());
        }),
      }),
    );
    disposers.push(
      host.webServer.register({
        kind: "prefix",
        path: `${API_BASE}/assets`,
        handler: fenced(async (request, response) => {
          if (!method(request, response, "GET")) return;
          const pathname = String(request.url ?? "").split("?")[0];
          const match = /\/dsh-wallpaper\/assets\/([^/]+)$/.exec(pathname);
          const id = match?.[1] ?? "";
          if (!ASSET_ID.test(id)) throw new HttpError(400, "INVALID_ASSET_ID", "invalid image id");
          const asset = store.readAsset(id);
          response.writeHead(200, {
            "content-type": asset.meta.mime,
            "content-length": asset.buffer.length,
            "cache-control": "private, max-age=31536000, immutable",
            etag: `"${asset.meta.sha256}"`,
            "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin",
          });
          response.end(asset.buffer);
        }),
      }),
    );
  } catch (error) {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* keep the original failure */
      }
    }
    throw error;
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        /* route already gone */
      }
    }
  };
}

// --------------------------------------------------------------------- apply

export function apply(ctx) {
  ctx.inject(["webServer"], (host) => {
    const root = dshHome();
    const profile = hostProfileFor(root);
    const store = createStore(dataDirFor(root, profile));
    host.effect(() => mountRoutes(host, store), "dsh-wallpaper: routes");
  });
}
