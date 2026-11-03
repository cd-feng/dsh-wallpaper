#!/usr/bin/env python3
"""Generate the built-in wallpapers for dsh-wallpaper.

Two families, deterministic (fixed seed) and low-contrast on purpose, because
the app draws translucent panels over them:

- `aurora-*`  — the original decorative pair.
- `official-*` — a static bake of the DeepSeek homepage hero: the site paints a
  `linear-gradient(180deg, #9cc1e7, transparent)` band plus a masked flow-field
  canvas, which together read as soft blue wisps. We keep the palette and the
  band, replace the live canvas with domain-warped fBm noise, and leave the fine
  grid to CSS (crisp at any DPI instead of moiré in a bitmap).

Output: wallpapers/<name>.webp at 2400x1500 (16:10, cropped by
`background-size: cover`).

Run: python3 scripts/make-wallpapers.py
"""

from __future__ import annotations

import math
from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter

WIDTH = 2400
HEIGHT = 1500
# The smooth colour field is computed at 1/4 resolution and upscaled; the grain
# is added at full resolution so it stays crisp instead of turning into mush.
FIELD_WIDTH = 600
FIELD_HEIGHT = 375
OUT_DIR = Path(__file__).resolve().parent.parent / "wallpapers"


def gaussian_blob(width: int, height: int, cx: float, cy: float, rx: float, ry: float) -> np.ndarray:
    """Elliptical falloff in [0, 1] over a width x height grid (full-res units)."""
    ys = np.arange(height, dtype=np.float32)[:, None]
    xs = np.arange(width, dtype=np.float32)[None, :]
    dx = (xs - cx) / max(rx, 1.0)
    dy = (ys - cy) / max(ry, 1.0)
    return np.exp(-(dx * dx + dy * dy) * 2.0)


def vertical_gradient(width: int, height: int, top: np.ndarray, bottom: np.ndarray) -> np.ndarray:
    t = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None, None]
    return top[None, None, :] * (1.0 - t) + bottom[None, None, :] * t


def ribbon(width: int, height: int, *, base_y: float, amplitude: float, frequency: float,
           thickness: float, phase: float) -> np.ndarray:
    """One soft sinusoidal light band running left to right."""
    xs = np.arange(width, dtype=np.float32)[None, :]
    ys = np.arange(height, dtype=np.float32)[:, None]
    center = base_y + amplitude * np.sin(frequency * (xs / width) * math.tau + phase)
    return np.exp(-(((ys - center) / thickness) ** 2))


def smooth_field(
    *, seed: int, top: tuple[float, float, float], bottom: tuple[float, float, float],
    blobs: list[tuple[float, float, float, float, tuple[float, float, float], float]],
    ribbons: list[tuple[float, float, float, float, float, tuple[float, float, float], float]],
    blend: str = "add",
) -> np.ndarray:
    """Compose the smooth colour field at FIELD_WIDTH x FIELD_HEIGHT."""
    width, height = FIELD_WIDTH, FIELD_HEIGHT
    # Work in full-res coordinates so the presets read in real pixel terms.
    scale = width / WIDTH
    field = vertical_gradient(
        width, height,
        np.array(top, dtype=np.float32),
        np.array(bottom, dtype=np.float32),
    )
    def apply(mask: np.ndarray, color: tuple[float, float, float], strength: float) -> None:
        nonlocal field
        amount = (mask * strength)[:, :, None]
        rgb = np.array(color, dtype=np.float32)
        if blend == "mix":
            # Lerp toward the colour: pastel and clip-free, right for light art.
            field = field * (1.0 - amount) + rgb * amount
        else:
            # Additive glow: right for the dark aurora.
            field = field + amount * rgb

    for bx, by, brx, bry, color, strength in blobs:
        apply(
            gaussian_blob(
                width, height,
                bx * scale, by * (height / HEIGHT),
                max(brx * scale, 1.0), max(bry * (height / HEIGHT), 1.0),
            ),
            color, strength,
        )
    for base_y, amplitude, frequency, thickness, phase, color, strength in ribbons:
        apply(
            ribbon(
                width, height,
                base_y=base_y * (height / HEIGHT), amplitude=amplitude * (height / HEIGHT),
                frequency=frequency, thickness=max(thickness * (height / HEIGHT), 1.0), phase=phase,
            ),
            color, strength,
        )
    return field


def value_noise(width: int, height: int, cells_x: int, cells_y: int, rng: np.random.Generator) -> np.ndarray:
    """Smooth value noise: a random coarse grid, smoothly interpolated to pixels."""
    grid = rng.random((cells_y + 1, cells_x + 1)).astype(np.float32)
    xs = np.linspace(0.0, cells_x, width, dtype=np.float32)
    ys = np.linspace(0.0, cells_y, height, dtype=np.float32)
    x0 = np.floor(xs).astype(np.int32)
    y0 = np.floor(ys).astype(np.int32)
    x1 = np.minimum(x0 + 1, cells_x)
    y1 = np.minimum(y0 + 1, cells_y)
    tx = xs - x0
    ty = ys - y0
    tx = tx * tx * (3.0 - 2.0 * tx)
    ty = ty * ty * (3.0 - 2.0 * ty)
    g00 = grid[np.ix_(y0, x0)]
    g10 = grid[np.ix_(y0, x1)]
    g01 = grid[np.ix_(y1, x0)]
    g11 = grid[np.ix_(y1, x1)]
    tx = tx[None, :]
    ty = ty[:, None]
    top = g00 * (1.0 - tx) + g10 * tx
    bottom = g01 * (1.0 - tx) + g11 * tx
    return top * (1.0 - ty) + bottom * ty


def fbm(width: int, height: int, *, seed: int, octaves: int, cells: float, persistence: float = 0.5) -> np.ndarray:
    """Fractal sum of value noise, normalised to [0, 1]."""
    rng = np.random.default_rng(seed)
    total = np.zeros((height, width), dtype=np.float32)
    amplitude = 1.0
    total_amplitude = 0.0
    frequency = cells
    for _ in range(octaves):
        total += amplitude * value_noise(
            width, height,
            max(2, int(round(frequency * width / max(height, 1)))),
            max(2, int(round(frequency))),
            rng,
        )
        total_amplitude += amplitude
        amplitude *= persistence
        frequency *= 2.0
    return total / total_amplitude


def warp_field(base: np.ndarray, *, seed: int, strength: float, cells: float) -> np.ndarray:
    """Domain-warp a [0,1] field so the noise reads as wisps instead of blobs."""
    height, width = base.shape
    dx = (fbm(width, height, seed=seed + 1, octaves=2, cells=cells) - 0.5) * 2.0
    dy = (fbm(width, height, seed=seed + 2, octaves=2, cells=cells) - 0.5) * 2.0
    ys = np.arange(height, dtype=np.float32)[:, None]
    xs = np.arange(width, dtype=np.float32)[None, :]
    sample_x = np.clip(xs + dx * strength, 0, width - 1).astype(np.int32)
    sample_y = np.clip(ys + dy * strength, 0, height - 1).astype(np.int32)
    warped = base[sample_y, sample_x]
    # Light second pass of contrast so the wisps keep soft shoulders.
    return warped * 0.75 + base * 0.25


def official_field(
    *,
    seed: int,
    top: tuple[float, float, float],
    bottom: tuple[float, float, float],
    hero_color: tuple[float, float, float],
    hero_strength: float,
    hero_fade: float,
    wing_color: tuple[float, float, float],
    wing_strength: float,
    glow_color: tuple[float, float, float],
    glow_strength: float,
    cloud_color: tuple[float, float, float],
    cloud_strength: float,
    vignette_color: tuple[float, float, float],
    vignette_strength: float,
    cells: float,
    warp: float,
) -> np.ndarray:
    """Bake the DeepSeek homepage hero look (blue band + wisps + centre glow)."""
    width, height = FIELD_WIDTH, FIELD_HEIGHT
    rng = np.random.default_rng(seed)
    field = vertical_gradient(
        width, height,
        np.array(top, dtype=np.float32),
        np.array(bottom, dtype=np.float32),
    )

    def mix(mask: np.ndarray, color: tuple[float, float, float], strength: float) -> None:
        nonlocal field
        amount = np.clip(mask * strength, 0.0, 1.0)[:, :, None]
        rgb = np.array(color, dtype=np.float32)
        field = field * (1.0 - amount) + rgb * amount

    # The site's hero band: blue at the very top, gone by mid-page. Modulated by
    # a coarse noise so its lower edge reads as weather, not as a gradient stop.
    ys = np.linspace(0.0, 1.0, height, dtype=np.float32)[:, None]
    band = np.clip(1.0 - ys / hero_fade, 0.0, 1.0) ** 1.15
    band_edge = fbm(width, height, seed=seed + 3, octaves=3, cells=2.4) * 0.5 + 0.5
    band = band * (0.55 + 0.75 * band_edge)
    mix(band, hero_color, hero_strength)

    # Blue wings left/right of the centre, where the flow field pools.
    wings = np.zeros((height, width), dtype=np.float32)
    xs = np.linspace(0.0, 1.0, width, dtype=np.float32)[None, :]
    wings += gaussian_blob(width, height, 0.02 * width, 0.45 * height, 0.30 * width, 0.42 * height)
    wings += gaussian_blob(width, height, 0.98 * width, 0.34 * height, 0.28 * width, 0.38 * height)
    wings += gaussian_blob(width, height, 0.74 * width, 0.86 * height, 0.34 * width, 0.30 * height)
    mix(wings, wing_color, wing_strength)

    # Wisps: two warped fBm passes, one broad and soft, one finer for texture.
    for pass_cells, pass_strength, pass_seed in (
        (cells * 0.42, cloud_strength * 0.85, seed + 5),
        (cells, cloud_strength, seed + 7),
    ):
        noise = fbm(width, height, seed=pass_seed, octaves=4, cells=pass_cells)
        noise = warp_field(noise, seed=pass_seed + 11, strength=warp, cells=max(pass_cells * 0.6, 2.0))
        wisp = np.clip((noise - 0.42) * 2.6, 0.0, 1.0)
        wisp *= 0.45 + 0.75 * np.clip(1.25 - ys, 0.0, 1.0)
        mix(wisp, cloud_color, pass_strength)

    # Centre halo: the page keeps its content area bright.
    halo = np.zeros((height, width), dtype=np.float32)
    halo += gaussian_blob(width, height, 0.50 * width, 0.56 * height, 0.56 * width, 0.50 * height)
    mix(halo, glow_color, glow_strength)

    # Corner tint instead of a darkening vignette: keeps the pastel reading.
    radius = np.sqrt(
        (np.linspace(-1, 1, width, dtype=np.float32)[None, :] ** 2)
        + (np.linspace(-1, 1, height, dtype=np.float32)[:, None] ** 2)
    ) / math.sqrt(2.0)
    corners = np.clip((radius - 0.45) / 0.55, 0.0, 1.0) ** 1.8
    mix(corners, vignette_color, vignette_strength)
    return field


def add_grain(field: np.ndarray, *, seed: int, amount: float) -> np.ndarray:
    rng = np.random.default_rng(seed)
    noise = rng.normal(0.0, 1.0, (HEIGHT, WIDTH)).astype(np.float32)
    # Blur the grain slightly so it reads as texture, not television static.
    noise_img = Image.fromarray(((noise * 0.5 + 0.5) * 255.0).clip(0, 255).astype(np.uint8), mode="L")
    noise_img = noise_img.filter(ImageFilter.GaussianBlur(0.6))
    noise = (np.asarray(noise_img, dtype=np.float32) / 255.0) * 2.0 - 1.0
    return field + noise[:, :, None] * amount


def vignette(field: np.ndarray, *, strength: float, feather: float) -> np.ndarray:
    ys = np.linspace(-1.0, 1.0, HEIGHT, dtype=np.float32)[:, None]
    xs = np.linspace(-1.0, 1.0, WIDTH, dtype=np.float32)[None, :]
    radius = np.sqrt(xs * xs + ys * ys) / math.sqrt(2.0)
    mask = 1.0 - strength * np.clip((radius - (1.0 - feather)) / feather, 0.0, 1.0) ** 2
    return field * mask[:, :, None]


def render(name: str, **preset) -> Path:
    seed = preset.pop("seed")
    field = preset.pop("field")
    if preset.pop("official", False):
        field = official_field(**field)
    else:
        field = smooth_field(**field)
    # Pillow has no floating-point RGB mode, so upscale each channel as "F".
    field = np.stack(
        [
            np.asarray(
                Image.fromarray(field[:, :, channel].astype(np.float32), mode="F").resize(
                    (WIDTH, HEIGHT), Image.Resampling.BICUBIC,
                ),
                dtype=np.float32,
            )
            for channel in range(3)
        ],
        axis=-1,
    )
    field = add_grain(field, seed=seed, **preset.pop("grain"))
    field = vignette(field, **preset.pop("vignette"))
    image = Image.fromarray((field.clip(0.0, 1.0) * 255.0).round().astype(np.uint8), mode="RGB")
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    path = OUT_DIR / f"{name}.webp"
    image.save(path, format="WEBP", quality=82, method=6)
    return path


DARK_PRESET = {
    "seed": 20261103,
    "field": {
        "seed": 0,
        "blend": "add",
        "top": (0.050, 0.055, 0.080),
        "bottom": (0.028, 0.030, 0.046),
        "blobs": [
            # x, y, radius-x, radius-y (full-res px), colour, strength
            (300, 1900, 1500, 900, (0.16, 0.45, 0.42), 0.60),
            (1250, 150, 1400, 850, (0.10, 0.12, 0.32), 0.75),
            (2200, 1150, 1200, 850, (0.38, 0.22, 0.44), 0.45),
            (1750, 2600, 1400, 1000, (0.10, 0.16, 0.28), 0.50),
            (700, -350, 1100, 700, (0.05, 0.08, 0.20), 0.60),
        ],
        "ribbons": [
            (1030, 200, 0.55, 140, 0.4, (0.34, 0.90, 0.82), 0.38),
            (1180, 250, 0.80, 95, 2.1, (0.58, 0.46, 0.98), 0.28),
            (960, 160, 1.10, 75, 4.3, (0.92, 0.66, 0.38), 0.16),
        ],
    },
    "grain": {"amount": 0.010},
    "vignette": {"strength": 0.32, "feather": 0.55},
}

LIGHT_PRESET = {
    "seed": 20261104,
    "field": {
        "seed": 0,
        "blend": "mix",
        "top": (0.985, 0.975, 0.958),
        "bottom": (0.930, 0.940, 0.965),
        "blobs": [
            (330, 1780, 1500, 950, (0.99, 0.78, 0.62), 0.55),
            (1500, 120, 1500, 900, (0.78, 0.86, 0.98), 0.62),
            (2240, 1320, 1250, 820, (0.76, 0.68, 0.95), 0.50),
            (1120, 2500, 1550, 950, (0.62, 0.78, 0.96), 0.55),
            (720, -380, 1050, 680, (0.98, 0.87, 0.72), 0.50),
            (1850, 640, 800, 560, (0.80, 0.93, 0.86), 0.40),
        ],
        "ribbons": [
            (1080, 170, 0.65, 165, 0.9, (1.00, 0.92, 0.80), 0.45),
            (1260, 200, 0.95, 110, 2.7, (0.82, 0.88, 1.00), 0.38),
        ],
    },
    "grain": {"amount": 0.008},
    "vignette": {"strength": 0.18, "feather": 0.62},
}


OFFICIAL_DARK_PRESET = {
    "seed": 20261105,
    "official": True,
    "field": {
        "seed": 20261105,
        # DeepSeek's own palette: #0a0a0a page under a #4d6bfe-tinted band.
        "top": (0.043, 0.047, 0.055),
        "bottom": (0.060, 0.066, 0.080),
        "hero_color": (0.26, 0.36, 0.56),
        "hero_strength": 0.62,
        "hero_fade": 0.55,
        "wing_color": (0.17, 0.23, 0.38),
        "wing_strength": 0.48,
        "glow_color": (0.105, 0.115, 0.135),
        "glow_strength": 0.80,
        "cloud_color": (0.30, 0.38, 0.56),
        "cloud_strength": 0.30,
        "vignette_color": (0.035, 0.037, 0.042),
        "vignette_strength": 0.55,
        "cells": 4.0,
        "warp": 34.0,
    },
    "grain": {"amount": 0.006},
    "vignette": {"strength": 0.0, "feather": 0.5},
}

OFFICIAL_LIGHT_PRESET = {
    "seed": 20261106,
    "official": True,
    "field": {
        "seed": 20261106,
        # Top band from the site (#9cc1e7), page base #f9f8f8, white centre.
        "top": (0.965, 0.974, 0.986),
        "bottom": (0.945, 0.956, 0.975),
        "hero_color": (0.600, 0.730, 0.890),
        "hero_strength": 0.58,
        "hero_fade": 0.55,
        "wing_color": (0.650, 0.760, 0.905),
        "wing_strength": 0.42,
        "glow_color": (1.0, 1.0, 1.0),
        "glow_strength": 0.42,
        "cloud_color": (0.600, 0.720, 0.900),
        "cloud_strength": 0.30,
        "vignette_color": (0.720, 0.790, 0.900),
        "vignette_strength": 0.24,
        "cells": 3.0,
        "warp": 50.0,
    },
    "grain": {"amount": 0.005},
    "vignette": {"strength": 0.0, "feather": 0.5},
}


def main() -> None:
    for name, preset in (
        ("aurora-dark", DARK_PRESET),
        ("aurora-light", LIGHT_PRESET),
        ("official-dark", OFFICIAL_DARK_PRESET),
        ("official-light", OFFICIAL_LIGHT_PRESET),
    ):
        path = render(name, **dict(preset))
        print(f"{path.name}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
