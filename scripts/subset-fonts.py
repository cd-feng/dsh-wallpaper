#!/usr/bin/env python3
"""Subset the bundled OFL fonts into the small woff2 files the plugin serves.

Run through `node scripts/build-fonts.mjs` (that script downloads the pinned
sources and writes the manifest); this script only touches fonts.

The subset is deliberately *not* the whole CJK plane: GB2312 (6763 hanzi) plus
Latin, punctuation and full-width forms keeps each file around 1.5-2.5 MB while
covereage stays comfortable for UI text. A glyph outside the subset falls back
to the system font — the fallback stack is part of the manifest.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer

# Latin, punctuation, symbols and CJK forms a UI can realistically show.
EXTRA_RANGES = (
    (0x0020, 0x007F),  # ASCII
    (0x00A0, 0x0180),  # Latin-1 + Extended-A
    (0x2000, 0x2070),  # general punctuation
    (0x3000, 0x3040),  # CJK punctuation
    (0xFF00, 0xFFF0),  # full-width forms
)
EXTRA_CHARS = "囧氵灬乄乆々〇ぁぃぅぇぉ"
NO_HINTING = os.environ.get("DWP_FONT_NO_HINTING") == "1"


def ui_charset() -> set[str]:
    chars: set[str] = set()
    for start, end in EXTRA_RANGES:
        chars.update(chr(cp) for cp in range(start, end))
    # GB2312 level 1 (3755 most-used hanzi by pinyin order); rare characters
    # fall back to the system font, which keeps each file inside the size budget.
    level1_only = os.environ.get("DWP_FONT_LEVEL1") == "1"
    for cp in range(0x4E00, 0xA000):
        char = chr(cp)
        try:
            encoded = char.encode("gb2312")
        except UnicodeEncodeError:
            continue
        if level1_only and not (0xB0 <= encoded[0] <= 0xD7):
            continue
        chars.add(char)
    chars.update(EXTRA_CHARS)
    return chars


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def build_font(source: Path, target: Path, text: str, variable: str | None) -> dict:
    font = TTFont(source)
    if variable is not None:
        font = instancer.instantiateVariableFont(font, {"wght": 400})
    options = subset.Options()
    # `flavor` only takes effect through `subset.save_font`: `TTFont.save` would
    # write a plain TTF with a .woff2 extension.
    options.flavor = "woff2"
    options.layout_features = ["kern"]
    options.name_IDs = ["*"]
    options.name_legacy = True
    options.notdef_outline = True
    options.recalc_bounds = True
    options.drop_tables += ["BASE", "DSIG", "MATH", "SVG"]
    options.hinting = not NO_HINTING
    subsetter = subset.Subsetter(options=options)
    subsetter.populate(text=text)
    subsetter.subset(font)
    target.parent.mkdir(parents=True, exist_ok=True)
    subset.save_font(font, target, options)
    font.close()
    return {
        "file": target.name,
        "bytes": target.stat().st_size,
        "sha256": sha256(target),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True, help="JSON jobs file from build-fonts.mjs")
    parser.add_argument("--source-dir", required=True)
    parser.add_argument("--out-dir", required=True)
    parser.add_argument("--out", required=True, help="JSON result file read by build-fonts.mjs")
    args = parser.parse_args()

    config = json.loads(Path(args.config).read_text())
    source_dir = Path(args.source_dir)
    out_dir = Path(args.out_dir)
    charset = ui_charset()
    full_text = "".join(sorted(charset))
    print(f"charset: {len(charset)} chars", file=sys.stderr)

    results = []
    for job in config["fonts"]:
        source = source_dir / job["source"]
        full = build_font(source, out_dir / job["file"], full_text, job.get("variable"))
        preview = build_font(source, out_dir / job["previewFile"], job["previewText"], job.get("variable"))
        results.append({**job, **full, "preview": preview})
        print(f"{job['id']}: {full['bytes'] / 1024:.0f} KB (+ preview {preview['bytes'] / 1024:.1f} KB)", file=sys.stderr)

    Path(args.out).write_text(json.dumps({"fonts": results}, indent=2) + "\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
