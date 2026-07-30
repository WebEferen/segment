# Segment brand assets

The Segment mark is one routing idea drawn three times: structural paths can share
the same state space, while one red path identifies the targeted update. The old
five-line emblem and the separate lattice mark were consolidated so every asset now
uses the same geometry.

## The mark

- Three bold routes keep the symbol legible at small sizes.
- The middle route is the only live red element.
- Detached end cells preserve the idea of addressable segments without a full grid.
- The mark has no container, shadow, glow, or background.
- `logo.svg`, `logo.png`, and `segment-state-logo.png` are transparent.

The light-surface palette is ink `#5B5751` and live red `#E90826`. The dark-surface
palette is ink `#F4EEE8` and live red `#FF415A`.

## Files

| File                     | Size     | Notes                                                    |
| ------------------------ | -------- | -------------------------------------------------------- |
| `logo.svg`               | 64x64    | Transparent light-surface mark.                          |
| `logo-dark.svg`          | 64x64    | Transparent dark-surface mark, with identical geometry.  |
| `lockup.svg`             | 512x72   | Mark plus wordmark; adapts to the reader's color scheme. |
| `logo.png`               | 512x512  | Transparent raster of `logo.svg`.                        |
| `segment-state-logo.png` | 512x512  | README-compatible copy of `logo.png`.                    |
| `og.svg`                 | 1200x630 | Editable social card source using the same mark.         |
| `og.png`                 | 1200x630 | Raster Open Graph image.                                 |

`og.svg` uses the dark-surface colors so the mark remains unchanged geometrically
while retaining sufficient contrast on the card background.

## Rasterizing

The committed PNGs are browser-rendered from the SVG sources. Render `logo.svg` on
a transparent 512x512 canvas, copy that result to `segment-state-logo.png`, and
render `og.svg` at its intrinsic 1200x630 size. Keep one renderer for both outputs
so the mark remains pixel-identical across the set.

## Usage

- Use `logo.svg` or `logo.png` on light surfaces.
- Use `logo-dark.svg` on dark surfaces.
- Use `lockup.svg` when the mark and name must travel together.
- Use `og.png` as the social preview without resizing or recompressing it.
- Keep clear space equal to roughly one route thickness on every side.
