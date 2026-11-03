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
 *   GET    /dsh-wallpaper/state           -> { config, images, warning }
 *   PATCH  /dsh-wallpaper/config          -> partial config -> { config, images }
 *   POST   /dsh-wallpaper/library         -> raw image body -> { config, images }
 *   DELETE /dsh-wallpaper/library/<id>    -> { config, images }
 *   GET    /dsh-wallpaper/assets/<id>     -> image bytes (immutable cache, ETag/304)
 *
 * Data lives in `<DSH_HOME>/dsh-wallpaper[-desktop]/`:
 *   config.json   { mode, customId, panelOpacity, blur }
 *   library.json  { images: [{ id, name, mime, size, sha256, addedAt, file }] }
 *   images/       <id>.<png|jpg|webp|gif|avif>
 *
 * Writes are ordered so a failure cannot leave memory and disk disagreeing: new
 * metadata is persisted first, memory is committed only after the write returned,
 * and a failed commit rolls the metadata back. Corrupt files are quarantined
 * instead of silently replaced, and `/state` reports the problem.
 *
 * Every route is fenced to a trusted same-origin loopback request (loopback Host
 * header, loopback peer, no cross-site fetch metadata, and an `Origin` whose
 * scheme + host + port match the request), because plugin routes bypass the Web
 * app's own page authentication.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const name = "dsh-wallpaper";

const API_BASE = "/dsh-wallpaper";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const BODY_LIMIT = MAX_UPLOAD_BYTES + 1024 * 1024;
/** 40 MP keeps the decoded RGBA around 160 MB; the byte cap alone allows far more. */
const MAX_PIXELS = 40 * 1000 * 1000;
const CONFIG_FILE = "config.json";
const LIBRARY_FILE = "library.json";
const IMAGES_DIR = "images";
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const ASSET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const IMAGE_FILE = /^([0-9a-f-]{36})\.(png|jpg|webp|gif|avif)$/;
const SHA256 = /^[0-9a-f]{64}$/;
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

/**
 * Desktop keeps its data in a separate directory. The launcher runs it with
 * `cwd = <DSH_HOME>/profiles/desktop`, which is the fallback here; the
 * `startedBundles` hint from `profileContext` wins when present, because a
 * changed cwd would otherwise silently switch the plugin to the web directory.
 */
export function hostProfileFor(root, cwd = process.cwd(), startedBundles = []) {
  if (Array.isArray(startedBundles) && startedBundles.some((bundle) => /desktop/i.test(String(bundle)))) {
    return "desktop";
  }
  const normalize = (path) => (process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path));
  return normalize(cwd) === normalize(join(expandHome(root), "profiles", "desktop")) ? "desktop" : "web";
}

export function dataDirFor(root, profile) {
  const base = resolve(expandHome(root));
  return join(base, profile === "desktop" ? "dsh-wallpaper-desktop" : "dsh-wallpaper");
}

// --------------------------------------------------------------- small utils

function clampInt(value, min, max, fallback) {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.round(number)));
}

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  try {
    chmodSync(dir, DIR_MODE);
  } catch {
    /* a pre-existing dir may be owned elsewhere; the mkdir mode still applies */
  }
}

/** fsync + rename, with the temp file removed when anything below fails. */
function writeJsonAtomic(file, value) {
  ensureDir(dirname(file));
  const temporary = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  const body = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const fd = openSync(temporary, "w", FILE_MODE);
    try {
      writeFileSync(fd, body, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    chmodSync(temporary, FILE_MODE);
    renameSync(temporary, file);
  } catch (error) {
    try {
      rmSync(temporary, { force: true });
    } catch {
      /* the throw below is the useful signal */
    }
    throw error;
  }
}

/**
 * Read a JSON object. A missing file is a normal state; an unreadable or corrupt
 * one is not — it is moved aside so the user can still recover it by hand.
 */
function readJsonFile(file, fallback) {
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    if (error && error.code === "ENOENT") return { value: fallback, missing: true, broken: false };
    return { value: fallback, missing: false, broken: true, error };
  }
  try {
    const parsed = JSON.parse(raw);
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { value: parsed, missing: false, broken: false };
    }
    return { value: fallback, missing: false, broken: true };
  } catch {
    return { value: fallback, missing: false, broken: true };
  }
}

function quarantine(file) {
  const target = `${file}.corrupt-${Date.now()}`;
  try {
    renameSync(file, target);
    return target;
  } catch {
    return null;
  }
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

/**
 * Intrinsic size from the file header (no decode). The browser checks this too,
 * but a direct same-origin POST could bypass it — a compressible 400 MP PNG
 * would make the renderer allocate roughly 1.6 GB.
 */
function parseImageSize(buffer) {
  const u16be = (offset) => buffer.readUInt16BE(offset);
  const u32be = (offset) => buffer.readUInt32BE(offset);
  const u24be = (offset) => (buffer[offset] << 16) | (buffer[offset + 1] << 8) | buffer[offset + 2];

  if (buffer.length >= 24 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    // Signature + an `IHDR` chunk; anything else is not a PNG header we can trust.
    return buffer.subarray(12, 16).toString("latin1") === "IHDR" ? { width: u32be(16), height: u32be(20) } : null;
  }
  if (buffer.length >= 10 && buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
    return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
  }
  if (buffer.length >= 30 && buffer.subarray(0, 4).toString("latin1") === "RIFF") {
    const chunk = buffer.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") return { width: u24be(24) + 1, height: u24be(27) + 1 };
    if (chunk === "VP8L") {
      const bits = buffer.readUInt32LE(21);
      return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
    }
    if (chunk === "VP8 ") return { width: u16be(26) & 0x3fff, height: u16be(28) & 0x3fff };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = buffer[offset + 1];
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
  for (let index = 0; index + 16 <= buffer.length; index += 1) {
    if (buffer[index] === 0x69 && buffer[index + 1] === 0x73 && buffer[index + 2] === 0x70 && buffer[index + 3] === 0x65) {
      return { width: u32be(index + 8), height: u32be(index + 12) };
    }
  }
  return null;
}

/** Strip control/bidi/zero-width characters and cap by code points, not UTF-16 units. */
function sanitizeName(raw) {
  const text = String(raw)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
    .replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .trim();
  if (text === "") return "wallpaper";
  return Array.from(text).slice(0, 200).join("");
}

function hashOf(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function matchesIfNoneMatch(headerValue, etag) {
  if (typeof headerValue !== "string" || headerValue === "") return false;
  return headerValue.split(",").some((candidate) => {
    const value = candidate.trim();
    return value === "*" || value === etag || value === `W/${etag}`;
  });
}

// -------------------------------------------------------------------- store

function normalizeConfig(raw, images, { lenient = false } = {}) {
  const source = raw !== null && typeof raw === "object" ? raw : {};
  let mode = source.mode;
  if (mode !== "official" && mode !== "builtin" && mode !== "custom") mode = DEFAULTS.mode;
  const known = new Set(images.map((image) => image.id));
  const customId =
    typeof source.customId === "string" && (lenient || known.has(source.customId)) ? source.customId : null;
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
  let images = [];
  let persistedConfig = null;
  let ready = false;
  let libraryDegraded = false;
  let warning = "";

  // A file is served at most once per page load (immutable + UUID URL), so a
  // tiny LRU keeps repeat reads off the event loop. Bounded so a 20 MB upload
  // cannot pin memory.
  const assetCache = new Map();
  let assetCacheBytes = 0;
  const ASSET_CACHE_BYTES = 32 * 1024 * 1024;

  const dropAsset = (id) => {
    const cached = assetCache.get(id);
    if (cached === undefined) return;
    assetCache.delete(id);
    assetCacheBytes -= cached.buffer.length;
  };

  const cacheAsset = (id, value) => {
    if (value.buffer.length > ASSET_CACHE_BYTES) return value;
    dropAsset(id); // a concurrent miss must not count the same bytes twice
    while (assetCacheBytes + value.buffer.length > ASSET_CACHE_BYTES && assetCache.size > 0) {
      dropAsset(assetCache.keys().next().value);
    }
    assetCache.set(id, value);
    assetCacheBytes += value.buffer.length;
    return value;
  };

  const normalizeEntry = (entry) => {
    if (entry === null || typeof entry !== "object") return null;
    if (typeof entry.id !== "string" || !ASSET_ID.test(entry.id)) return null;
    if (typeof entry.file !== "string" || !IMAGE_FILE.test(entry.file)) return null;
    if (entry.file.slice(0, 36) !== entry.id) return null;
    if (typeof entry.mime !== "string" || extensionFor(entry.mime) === null) return null;
    if (!entry.file.endsWith(`.${extensionFor(entry.mime)}`)) return null;
    if (!existsSync(join(imagesDir, entry.file))) return null;
    return {
      id: entry.id,
      name: sanitizeName(typeof entry.name === "string" && entry.name !== "" ? entry.name : entry.id),
      mime: entry.mime,
      size: clampInt(entry.size, 1, MAX_UPLOAD_BYTES, 1),
      sha256: typeof entry.sha256 === "string" && SHA256.test(entry.sha256) ? entry.sha256 : "",
      addedAt: clampInt(entry.addedAt, 0, Number.MAX_SAFE_INTEGER, 0),
      file: entry.file,
    };
  };

  /**
   * Load once, at mount time. Missing files are created here; `/state` never
   * writes. A broken file is quarantined, never silently replaced: the user gets
   * a warning and can still recover the original.
   */
  const bootstrap = () => {
    if (ready) return;
    ready = true;
    const warnings = [];
    try {
      ensureDir(dataDir);
      ensureDir(imagesDir);
    } catch (error) {
      warnings.push(`cannot create the data directory: ${error instanceof Error ? error.message : error}`);
    }

    const libraryRead = readJsonFile(libraryFile, { images: [] });
    if (libraryRead.broken) {
      libraryDegraded = true;
      const saved = quarantine(libraryFile);
      warnings.push(
        saved === null
          ? "library.json is unreadable; the image list is empty until it is repaired"
          : `library.json was unreadable and moved to ${saved}; the image list is empty`,
      );
    }
    const rawList = Array.isArray(libraryRead.value.images) ? libraryRead.value.images : [];
    if (libraryDegraded) {
      images = [];
    } else {
      images = rawList.map(normalizeEntry).filter((entry) => entry !== null);
      images.sort((a, b) => b.addedAt - a.addedAt);
      if (images.length !== rawList.length || libraryRead.missing) {
        try {
          writeJsonAtomic(libraryFile, { images });
        } catch (error) {
          warnings.push(`cannot write library.json: ${error instanceof Error ? error.message : error}`);
        }
      }
    }

    const configRead = readJsonFile(configFile, null);
    if (configRead.broken) {
      const saved = quarantine(configFile);
      warnings.push(
        saved === null
          ? "config.json is unreadable; using defaults"
          : `config.json was unreadable and moved to ${saved}; using defaults`,
      );
    }
    // When the library failed to load, keep the selection instead of "repairing"
    // it away: the images may come back once the file is fixed.
    config = normalizeConfig(configRead.value, images, { lenient: libraryDegraded });
    persistedConfig = config;
    if (configRead.missing) {
      try {
        writeJsonAtomic(configFile, config);
      } catch (error) {
        warnings.push(`cannot write config.json: ${error instanceof Error ? error.message : error}`);
      }
    }
    warning = warnings.join("; ");
  };

  const ensure = () => {
    if (!ready) bootstrap();
  };

  const publicImages = () =>
    images.map(({ id, name, mime, size, sha256, addedAt }) => ({ id, name, mime, size, sha256, addedAt }));

  const snapshot = () => {
    ensure();
    const value = { config: { ...config }, images: publicImages() };
    if (warning !== "") value.warning = warning;
    return value;
  };

  const writeLibrary = (list) => writeJsonAtomic(libraryFile, { images: list });

  /** Write first, commit memory after: a failed write must not look persisted. */
  const persistConfig = (next) => {
    if (persistedConfig !== null && JSON.stringify(next) === JSON.stringify(persistedConfig)) {
      config = next;
      return next;
    }
    writeJsonAtomic(configFile, next);
    config = next;
    persistedConfig = next;
    return next;
  };

  const addImage = async ({ buffer, mime, name }) => {
    ensure();
    const extension = extensionFor(mime);
    if (extension === null) throw new HttpError(415, "UNSUPPORTED_IMAGE", "unsupported image format");
    const size = parseImageSize(buffer);
    if (size !== null && size.width * size.height > MAX_PIXELS) {
      throw new HttpError(413, "IMAGE_TOO_LARGE", "image larger than 40 megapixels");
    }
    const id = randomUUID();
    const file = `${id}.${extension}`;
    const target = join(imagesDir, file);
    const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
    ensureDir(imagesDir);
    const entry = {
      id,
      name: sanitizeName(name),
      mime,
      size: buffer.length,
      sha256: hashOf(buffer),
      addedAt: Date.now(),
      file,
    };
    const nextImages = [entry, ...images];
    const nextConfig = normalizeConfig({ ...config, mode: "custom", customId: id }, nextImages);
    try {
      writeFileSync(temporary, buffer, { mode: FILE_MODE });
      chmodSync(temporary, FILE_MODE);
      // Metadata first, bytes at the end: a crash leaves a prunable row and an
      // orphan temp file, never a row pointing at bytes that do not exist.
      writeLibrary(nextImages);
      writeJsonAtomic(configFile, nextConfig);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* the original error is the useful one */
      }
      try {
        writeLibrary(images);
        writeJsonAtomic(configFile, config);
      } catch {
        /* the next mount prunes whatever is left */
      }
      throw error;
    }
    try {
      renameSync(temporary, target);
    } catch (error) {
      try {
        rmSync(temporary, { force: true });
      } catch {
        /* ignored */
      }
      try {
        writeLibrary(images);
        writeJsonAtomic(configFile, config);
      } catch {
        /* ignored */
      }
      throw error;
    }
    images = nextImages;
    config = nextConfig;
    persistedConfig = nextConfig;
    return { ...entry };
  };

  const removeImage = (id) => {
    ensure();
    const index = images.findIndex((image) => image.id === id);
    if (index < 0) throw new HttpError(404, "ASSET_NOT_FOUND", "image not found");
    const entry = images[index];
    const nextImages = images.filter((image) => image.id !== id);
    const nextConfig = normalizeConfig(config, nextImages);
    writeLibrary(nextImages);
    try {
      writeJsonAtomic(configFile, nextConfig);
    } catch (error) {
      try {
        writeLibrary(images);
      } catch {
        /* keep the original error */
      }
      throw error;
    }
    images = nextImages;
    config = nextConfig;
    persistedConfig = nextConfig;
    try {
      rmSync(join(imagesDir, entry.file), { force: true });
    } catch {
      /* the row is gone; an orphan file is pruned by the next mount */
    }
    dropAsset(id);
    return { id };
  };

  const patchConfig = (patch) => {
    ensure();
    if (libraryDegraded) {
      throw new HttpError(503, "STORE_DEGRADED", "library.json is unreadable; refusing to overwrite the selection");
    }
    const source = patch !== null && typeof patch === "object" ? patch : {};
    const next = normalizeConfig({ ...config, ...source }, images);
    return persistConfig(next);
  };

  const assetMeta = (id) => {
    ensure();
    const entry = images.find((image) => image.id === id);
    if (entry === undefined) throw new HttpError(404, "ASSET_NOT_FOUND", "image not found");
    return entry;
  };

  /** ETag and Last-Modified come from metadata, so a 304 needs no file read. */
  const assetHeaders = (entry) => ({
    etag: `"${entry.sha256}"`,
    lastModified: new Date(entry.addedAt).toUTCString(),
  });

  const readAsset = async (id) => {
    const entry = assetMeta(id);
    const cached = assetCache.get(id);
    if (cached !== undefined && cached.meta.sha256 === entry.sha256) {
      assetCache.delete(id); // LRU touch
      assetCache.set(id, cached);
      return cached;
    }
    const filePath = join(imagesDir, entry.file);
    let stat;
    try {
      stat = lstatSync(filePath);
    } catch {
      throw new HttpError(404, "ASSET_NOT_FOUND", "image file missing");
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new HttpError(404, "ASSET_NOT_FOUND", "image file missing");
    }
    let buffer;
    try {
      buffer = await readFile(filePath);
    } catch {
      throw new HttpError(404, "ASSET_NOT_FOUND", "image file missing");
    }
    if (entry.sha256 === "") {
      entry.sha256 = hashOf(buffer);
      try {
        writeLibrary(images);
      } catch {
        /* the in-memory hash still serves this request */
      }
    }
    // A DELETE can race the read; do not cache bytes that no longer have a row.
    if (!images.some((image) => image.id === id)) return { meta: entry, buffer };
    return cacheAsset(id, { meta: entry, buffer });
  };

  // Load at mount time: the Web server is up before the first request, and a
  // read-only `/state` must not be the thing that creates or repairs files.
  bootstrap();

  return { snapshot, addImage, removeImage, patchConfig, readAsset, assetMeta, assetHeaders, dataDir };
}

// ----------------------------------------------------------------- request IO

function header(headers, key) {
  const value = headers?.[key.toLowerCase()];
  if (Array.isArray(value)) return value[0];
  return typeof value === "string" ? value : undefined;
}

function sendJson(response, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    ...extraHeaders,
  });
  response.end(body);
}

function isLoopbackHostname(hostname) {
  if (hostname === "localhost" || hostname === "[::1]" || hostname === "::1") return true;
  const parts = hostname.split(".");
  return parts.length === 4 && parts[0] === "127" && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function isLoopbackAddress(address) {
  if (typeof address !== "string") return false;
  if (address === "::1") return true;
  const normalized = address.startsWith("::ffff:") ? address.slice(7) : address;
  return isIP(normalized) === 4 && normalized.split(".")[0] === "127";
}

/**
 * Plugin routes bypass the Web app's page authentication, so each one must prove
 * the request came from the same-origin loopback page: Host header, loopback
 * peer, browser fetch site, and (when present) an Origin equal to the request's
 * scheme + host + port.
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
    const target = new URL(origin);
    if (target.protocol !== (request.socket?.encrypted === true ? "https:" : "http:")) return false;
    return target.host === parsed.host;
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
    return sanitizeName(decodeURIComponent(raw));
  } catch {
    throw new HttpError(400, "FILENAME_INVALID", "x-filename is not encodeURIComponent output");
  }
}

function method(request, response, expected) {
  const actual = String(request.method ?? "").toUpperCase();
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (allowed.includes(actual)) return true;
  sendJson(
    response,
    405,
    { error: `method not allowed: ${actual}`, code: "METHOD_NOT_ALLOWED" },
    { allow: allowed.join(", ") },
  );
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
          await store.addImage({ buffer, mime, name: decodeName(request) });
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
          if (!method(request, response, ["GET", "HEAD"])) return;
          const pathname = String(request.url ?? "").split("?")[0];
          const match = /\/dsh-wallpaper\/assets\/([^/]+)$/.exec(pathname);
          const id = match?.[1] ?? "";
          if (!ASSET_ID.test(id)) throw new HttpError(400, "INVALID_ASSET_ID", "invalid image id");
          const entry = store.assetMeta(id);
          const { etag, lastModified } = store.assetHeaders(entry);
          const cachedHeaders = {
            etag,
            "last-modified": lastModified,
            "cache-control": "private, max-age=31536000, immutable",
          };
          if (matchesIfNoneMatch(header(request.headers, "if-none-match"), etag)) {
            response.writeHead(304, cachedHeaders);
            response.end();
            return;
          }
          const asset = await store.readAsset(id);
          response.writeHead(200, {
            "content-type": asset.meta.mime,
            "content-length": asset.buffer.length,
            "x-content-type-options": "nosniff",
            "cross-origin-resource-policy": "same-origin",
            ...cachedHeaders,
          });
          response.end(request.method === "HEAD" ? undefined : asset.buffer);
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
    const startedBundles = ctx.get?.("profileContext")?.startedBundles ?? [];
    const profile = hostProfileFor(root, process.cwd(), startedBundles);
    const store = createStore(dataDirFor(root, profile));
    host.effect(() => mountRoutes(host, store), "dsh-wallpaper: routes");
  });
}
