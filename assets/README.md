# Segment brand assets

Visual identity for `segment-state`. The mark was originally designed beside
Octane; its ink, red, stroke weight, and letterforms preserve that visual lineage
after Segment became a standalone package.

The generated `segment-state-logo.png` is the README emblem: its interlocking
paths show many structural addresses while the red route isolates one targeted
update. The compact vector assets below remain available for favicons, one-colour
printing, and adaptive light/dark surfaces.

## The mark

A rounded square holds a lattice of small squares. One block of that lattice is
lit, and the four addresses inside the lit block are punched clean through it.

That is the whole library in one picture:

- **The rounded square is one segment.** Bulk data lives in it as a single
  opaque value with a single version stamp.
- **The lattice is the address space.** 21 addresses exist, laid out on a 5x5
  grid at pitch 7 with the four corners dropped so the constellation echoes the
  container's roundness. They are all the same size, because an address that
  nothing observes costs the same as any other: nothing.
- **The lit block is what something is watching.** It is 15 of 36 units across,
  so most of the field is dark, and it sits off centre (its centre is 16.5
  against the field's 20) because a window is a position, not the middle. Move
  it and the mark still reads, which is the point: materialization is
  reversible.
- **The four holes are the materialized nodes.** They are punched with
  `fill-rule="evenodd"`, so they show whatever is behind the mark. An observed
  address is the only place you can see through the opacity of the bulk value,
  and it is 1.67x the size of a dormant one. Three sizes, three states: dormant,
  observed, and the lit region that holds them.

The mark carries no gradient, no transparency and no second accent. Size and one
red do all the work, so it survives a 16px favicon, a one colour print and a
1 bit stencil unchanged.

## Wordmark

Unicase geometric forms on Octane's own metrics: 45 cap height, 10.4 stem, 17.3
centreline radius for a full height shoulder, butt caps for flat terminals and
miter joins for square corners. E, N and T are Octane's glyphs unchanged, so a
third of the word is literally the parent's. S, G and M are drawn to the same
rules, and the counters of the S measure 6.9 at their widest: the same aperture
as the gaps between the bars of Octane's E. Total advance is 416 units.

Like Octane's own wordmark, the forms are unicase, so "Segment" sets as SEGMENT
at a single height.

## Palette

| Token      | Light surface | Dark surface | Role                                                      |
| ---------- | ------------- | ------------ | --------------------------------------------------------- |
| Ink        | `#5B5751`     | `#F4EEE8`    | Field boundary, dormant addresses, wordmark               |
| Live       | `#E90826`     | `#FF415A`    | The lit block, the only colour that is not `currentColor` |
| Ground     | any           | `#1A1614`    | Card ground for `og.svg`                                  |
| Field tint | n/a           | `#332B27`    | `og.svg` background texture only                          |
| Muted ink  | n/a           | `#C9BFB5`    | `og.svg` tagline only                                     |

Both ink values and both live values are Octane's, unchanged. Measured contrast:

| Pair                   | Ratio  | Bar                                     |
| ---------------------- | ------ | --------------------------------------- |
| `#5B5751` on white     | 7.2:1  | passes AA text and graphics             |
| `#5B5751` on `#F4EEE8` | 6.2:1  | passes AA text                          |
| `#E90826` on white     | 4.6:1  | passes AA text                          |
| `#E90826` on `#F4EEE8` | 4.0:1  | passes AA large and graphics            |
| `#F4EEE8` on `#1A1614` | 15.6:1 | passes AAA                              |
| `#FF415A` on `#1A1614` | 5.3:1  | passes AA text                          |
| `#C9BFB5` on `#1A1614` | 9.9:1  | passes AAA (the only text in any asset) |

## Light and dark

Two mechanisms, on purpose:

1. **Every shape draws with `currentColor`,** and the one exception carries
   `class="sg-live"`. So a single declaration retargets a whole asset:
   `style="color: #F4EEE8"` beats the presentation attribute on the root, and a
   `.sg-live { fill: X }` rule handles the red. This is the path a docs site
   should take.
2. **The palette is pinned in the file** for the standalone `<img>` case, where
   `currentColor` would otherwise resolve to the user agent default.

`logo.svg` is pinned light and `logo-dark.svg` is pinned dark, because a mark
you place yourself should not change under you. `lockup.svg` is the exception:
it is the asset that gets dropped into a README, where the surface follows the
reader, so it pins light and adds a `prefers-color-scheme: dark` override.
`og.svg` is pinned dark, because an OG image is rasterized once and served to
every surface.

The holes in the lit block are transparent, so the mark needs no background
colour of its own and inherits any solid surface. Put it on a solid colour, not
on a photograph.

## Files

| File                     | Size     | Notes                                                       |
| ------------------------ | -------- | ----------------------------------------------------------- |
| `logo.svg`               | 40x40    | Mark alone, pinned light. 2 units of padding on every side. |
| `logo-dark.svg`          | 40x40    | Same geometry, pinned dark.                                 |
| `lockup.svg`             | 512x72   | Mark plus wordmark, adapts to colour scheme.                |
| `og.svg`                 | 1200x630 | Social card. Text is set in a system sans stack.            |
| `logo.png`               | 512x512  | Rasterized `logo.svg`, transparent.                         |
| `og.png`                 | 1200x630 | Rasterized `og.svg`. Use this one for `og:image`.           |
| `segment-state-logo.png` | 479x479  | Generated README emblem on a dark ground.                   |

In the lockup the mark is scaled to 72 units of ink (1.6x the cap height, the
visual mass Octane's flame has against the same cap) and the ink gap to the S is 24. The mark is translated by -4 to cancel its own padding, so the lockup's box
is tight to the ink.

Both `logo.svg` and `logo-dark.svg` declare an element with `id="sg-addr"`, so
inline one or the other, never both in the same document.

### Rasterizing

No rasterizer is a dependency of this repo. The PNGs were produced with the
Chrome that is already on the machine:

```sh
CH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

# og.png, straight from the SVG, whose intrinsic size is already 1200x630
"$CH" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1200,630 --screenshot=og.png og.svg

# logo.png needs a wrapper, because logo.svg is intrinsically 40x40
printf '%s' '<body style="margin:0"><img src="logo.svg" style="display:block;width:512px;height:512px">' > wrap.html
"$CH" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --default-background-color=00000000 --window-size=512,512 \
  --screenshot=logo.png wrap.html && rm wrap.html
```

## Minimum sizes

Verified by rendering, not guessed:

- **Mark: 16px.** At 16px the lattice fuses into tone and the holes in the lit
  block close up. What survives is the silhouette plus one red block, which is
  still the mark. Do not go below 16px.
- **Lockup: 160px wide.** Below that the S, E and G start to run together.
  Under 160px use the mark and set the name in text.
- **`og.png`: use as is.** The tagline is 46px, which is still 11.5px at the
  300px width a feed thumbnail renders at.

## Clear space

One address pitch on every side, measured at whatever scale the asset is drawn.
That is 18% of the mark's width, and 19% of the lockup's height. Nothing else,
including a container edge, enters that band.

## Do not

- Do not recolour the lit block to anything but the two live reds. It is the
  only thing in the identity carrying meaning through colour.
- Do not add a gradient, a shadow, a glow or a transparency to any part of the
  mark. The whole design exists so that none of those are needed.
- Do not fill the punched holes. They are the materialized addresses, and a
  filled block is a solid chip that says nothing.
- Do not centre the lit block, resize it, or change how many addresses it
  covers. Its off centre position and its 4 of 21 share are the argument.
- Do not redraw the lattice as a full 5x5 grid. The corners are dropped so the
  field follows the container's radius.
- Do not stretch, shear, rotate or outline the mark, and do not rebuild the
  wordmark in a licensed font. Scale it uniformly.
- Do not set the mark on a photograph or a busy pattern. The holes are
  transparent and will pick up whatever is behind them.
- Do not put the mark inside another shape, badge or circle. It already has a
  container, and that container is part of the meaning.
- Do not pair the wordmark with a different mark, or the mark with the word
  "Octane". Segment sits next to Octane, it does not replace it.
