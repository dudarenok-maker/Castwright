# Castwright — brand assets

> **Castwright** · `castwright.ai`
> *Any book, performed by a full cast — effortlessly. Even in your own voice.*

The mark is a **ragged free waveform** — six bars in three colours (peach / magenta / white)
standing for *three distinct voices = a full cast* — sitting above an **open-book page swoosh**.
The uneven bottom edge of the wave "reaches" toward the page, tying voice to book.

## Colour tokens (match `src/styles.css`)

| Token | Hex | Role |
|---|---|---|
| ink | `#0f0e0d` | tile / 1-colour positive |
| peach | `#f79a83` | voice 1 (action accent) |
| magenta | `#a43c6c` | voice 2 (brand) |
| canvas | `#fffdfb` | voice 3 / reversed knockout |

## Files (SVG masters — resolution-independent)

| File | Use |
|---|---|
| `castwright-icon.svg` | **Primary** app icon — colour on ink tile. App stores, favicons, anywhere. |
| `castwright-favicon.svg` | SVG favicon (same artwork; ship this `<link rel="icon" type="image/svg+xml">`). |
| `castwright-icon-onlight.svg` | Full colour, **no tile** (3rd voice + book in ink) — for placing on light surfaces. |
| `castwright-mono-ink.svg` | 1-colour positive (ink, transparent) — stamps, light single-colour print. |
| `castwright-mono-white.svg` | 1-colour reversed/knockout (white, transparent) — dark backgrounds, photos. |
| `castwright-wordmark.svg` | Horizontal lockup (icon + "Castwright.ai"), positive / light bg. |
| `castwright-wordmark-reversed.svg` | Horizontal lockup, reversed / dark bg. |

### Theme-responsive logo (swaps with app light/dark mode)

| File | Use |
|---|---|
| `castwright-logo-light.svg` | In-app logo on the **natural/light** surface (3rd voice + book = ink). Transparent. |
| `castwright-logo-dark.svg` | In-app logo on the **dark** surface (3rd voice + book = canvas/white). Transparent. |
| `castwright-logo-auto.svg` | Single self-adapting file — flips via `prefers-color-scheme` for OS-theme contexts. |

The app swaps `-light` / `-dark` when the user toggles theme (peach + magenta stay constant;
only the third voice + book flip). Preview: open `castwright-theme-pair.html`.

## Brand system & marketing

| File | Use |
|---|---|
| `brand-guidelines.md` | Verbal voice & tone (+ sample copy), typography, colour system. |
| `castwright-og.svg` | Social / OG share image (1200×630, signature gradient + lockup + tagline). |
| `castwright-hero.html` | Landing hero mock — gradient, headline rule, 3 pillars, CTAs. |

## Exporting PNGs / favicons

No design tool needed — open **`export-png.html`** in any browser, choose a variant and size
(1024 app icon, 512, 192 PWA, 180 apple-touch, 64/48/32/16), and the PNG downloads. For a
multi-size `favicon.ico`, export 16/32/48 and combine at any free .ico packer — or just ship the
SVG favicon.

## Usage rules

- **Reversibility:** full-colour (its own ink tile) is primary. On a light surface with no tile use
  `-onlight`; on dark use `-mono-white`. Never place the magenta voice on a magenta surface.
- **Clear space:** keep padding ≥ the width of one bar around the mark.
- **Minimum size:** the full mark holds to ~16px; below that, prefer a simplified single-voice glyph.
- **Wordmark type:** previews use Georgia. **Outline the text to paths** before production so it
  renders without the font installed.

## Concept history

Exploration sheets live in `../brand-concepts/` (open in a browser). The locked direction is
Castwave → B2 waveform → "deep reach" ragged free waveform above a page-swoosh book.
