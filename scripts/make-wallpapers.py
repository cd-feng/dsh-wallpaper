#!/usr/bin/env python3
"""Generate the two built-in wallpapers (light + dark) for dsh-wallpaper.

The artwork is deterministic (fixed seed per palette), soft and low-contrast on
purpose: the app draws translucent panels over it, so busy detail would fight
the conversation text. Output: wallpapers/<name>.webp at 2400x1500 (16:10,
cropped by `background-size: cover`).

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
    field = smooth_field(**preset.pop("field"))
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


def main() -> None:
    for name in ("aurora-dark", "aurora-light"):
        preset = dict(DARK_PRESET if name.endswith("dark") else LIGHT_PRESET)
        path = render(name, **preset)
        print(f"{path.name}: {path.stat().st_size:,} bytes")


if __name__ == "__main__":
    main()
