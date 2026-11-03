#!/usr/bin/env node
/**
 * Regenerate the bundled web fonts (only needed when the sources are bumped).
 *
 * Downloads the pinned OFL sources into `.cache/fonts-src/` (gitignored), runs
 * `scripts/subset-fonts.py` with the fonttools venv, and writes `fonts/manifest.json`.
 * The generated `.woff2` files and the manifest are committed, so installs never
 * need Python or the network.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { FONTS, LICENSES, SOURCES } from "./fonts.config.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache");
const SOURCE_DIR = path.join(CACHE, "fonts-src");
const OUT_DIR = path.join(ROOT, "fonts");
const LICENSE_DIR = path.join(OUT_DIR, "licenses");
const JOBS = path.join(CACHE, "fonts-jobs.json");
const RESULT = path.join(CACHE, "fonts-result.json");
const VENV_PYTHON = path.join(CACHE, "fonts-venv", "bin", "python3");

async function download(url, target) {
  if (existsSync(target) && readFileSync(target).length > 1 << 20) return target;
  mkdirSync(path.dirname(target), { recursive: true });
  process.stdout.write(`  download ${path.basename(target)} … `);
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  writeFileSync(target, Buffer.from(await response.arrayBuffer()));
  console.log(`${(readFileSync(target).length / 1024 / 1024).toFixed(1)} MB`);
  return target;
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

const python = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";
const probe = spawnSync(python, ["-c", "import fontTools, brotli"], { stdio: "pipe" });
if (probe.status !== 0) {
  console.error(
    `fonttools/brotli missing for ${python}.\n` +
      `  python3 -m venv .cache/fonts-venv && .cache/fonts-venv/bin/pip install fonttools brotli`,
  );
  process.exit(1);
}

console.log("sources:");
mkdirSync(SOURCE_DIR, { recursive: true });
mkdirSync(LICENSE_DIR, { recursive: true });
for (const source of SOURCES) {
  const file = await download(source.url, path.join(SOURCE_DIR, source.name));
  if (source.bytes && readFileSync(file).length !== source.bytes) {
    throw new Error(`${source.name}: expected ${source.bytes} bytes, got ${readFileSync(file).length}`);
  }
  console.log(`  ${source.name} sha256=${sha256(file).slice(0, 16)}…`);
}

console.log("licenses:");
for (const license of Object.values(LICENSES)) {
  await download(license.url, path.join(LICENSE_DIR, license.file));
}

writeFileSync(
  JOBS,
  JSON.stringify({
    fonts: FONTS.map((font) => ({
      id: font.id,
      source: font.source,
      variable: font.variable,
      file: font.file,
      previewFile: font.previewFile,
      previewText: font.previewText,
    })),
  }),
);

console.log("subsetting:");
const result = spawnSync(
  python,
  [
    path.join(ROOT, "scripts", "subset-fonts.py"),
    "--config",
    JOBS,
    "--source-dir",
    SOURCE_DIR,
    "--out-dir",
    OUT_DIR,
    "--out",
    RESULT,
  ],
  { stdio: "inherit", encoding: "utf8" },
);
if (result.status !== 0) process.exit(result.status ?? 1);

const built = JSON.parse(readFileSync(RESULT, "utf8"));

const manifest = {
  version: 1,
  fonts: FONTS.map((font) => {
    const job = built.fonts.find((entry) => entry.id === font.id);
    const license = LICENSES[font.license];
    return {
      id: font.id,
      family: font.family,
      labels: font.labels,
      sample: font.sample,
      fallback: font.fallback,
      file: job.file,
      bytes: job.bytes,
      sha256: job.sha256,
      previewFile: job.preview.file,
      previewBytes: job.preview.bytes,
      previewSha256: job.preview.sha256,
      license: { name: license.name, file: license.file },
    };
  }),
};
manifest.files = manifest.fonts.flatMap((font) => [font.file, font.previewFile]);
manifest.licenses = [...new Set(Object.values(LICENSES).map((license) => license.file))];
const sorted = (value) =>
  Array.isArray(value) ? value.map(sorted) : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])])) : value;
writeFileSync(path.join(OUT_DIR, "manifest.json"), `${JSON.stringify(sorted(manifest), null, 2)}\n`);

const total = manifest.fonts.reduce((sum, font) => sum + font.bytes + font.previewBytes, 0);
console.log(`\nfonts/manifest.json written — ${manifest.fonts.length} fonts, ${(total / 1024 / 1024).toFixed(2)} MB total`);
