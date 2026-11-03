#!/usr/bin/env node
/**
 * Build `lib/client.js` from `src/client.template.js`.
 *
 * The wallpapers are inlined as data URIs so the browser half needs no host
 * route and no extra request. The generated file is committed: installing the
 * bundle must not require a build step.
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = path.join(ROOT, "src/client.template.js");
const OUTPUT = path.join(ROOT, "lib/client.js");
const MARKER = "/* __WALLPAPERS__ */ null";
const MAX_WALLPAPER_BYTES = 512 * 1024;

async function main() {
  const manifest = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8"));
  const template = await readFile(TEMPLATE, "utf8");
  if (!template.includes(MARKER)) {
    throw new Error(`build-client: marker missing from ${path.relative(ROOT, TEMPLATE)}`);
  }

  const dataUri = async (file) => {
    const filePath = path.join(ROOT, "wallpapers", file);
    const bytes = await readFile(filePath);
    if (bytes.length > MAX_WALLPAPER_BYTES) {
      throw new Error(`build-client: ${file} is ${bytes.length} bytes (> ${MAX_WALLPAPER_BYTES}); shrink the artwork first`);
    }
    return `data:image/webp;base64,${bytes.toString("base64")}`;
  };

  // Two families: the deepseek.com-style hero (`official`) is the default art,
  // the aurora pair stays as the alternative built-in.
  const wallpapers = {
    aurora: {
      light: await dataUri("aurora-light.webp"),
      dark: await dataUri("aurora-dark.webp"),
    },
    official: {
      light: await dataUri("official-light.webp"),
      dark: await dataUri("official-dark.webp"),
    },
  };
  const output = template.replace(MARKER, JSON.stringify(wallpapers));

  // The loader keys the boot graph by package name and rejects a bundle that
  // registers under any other id.
  if (!output.includes(`id: "${manifest.name}"`)) {
    throw new Error(`build-client: client id must equal the package name "${manifest.name}"`);
  }
  if (/__WALLPAPERS__/.test(output)) {
    throw new Error("build-client: placeholder left behind in the output");
  }

  await writeFile(OUTPUT, output, "utf8");
  const bytes = Buffer.byteLength(output);
  console.log(`build-client: wrote ${path.relative(ROOT, OUTPUT)} (${bytes.toLocaleString()} bytes)`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
