# Companion-app brand finish — app-15 (iOS app icon) + app-16 (brand audit)

**Date:** 2026-06-13
**Issues:** app-15 (#632), app-16 (#706)
**Branch:** `feat/app-companion-brand-finish`
**Umbrella plan:** [188 — Android companion app](../../features/188-android-companion-app.md)

## Why

Two leftover companion-app brand-pass items, both small and cohesive enough to
ship as one PR:

- **app-15 (#632)** — finish the launcher-icon coverage. The Castwright adaptive
  icon (API 26+) and the **Android legacy PNG fallback are already branded**
  (the issue text is stale on the latter — the `mipmap-*/ic_launcher.png` set
  already renders the Castwright waveform-and-book mark). The only thing still
  on the Flutter default is the **iOS `AppIcon.appiconset`**, which is the stock
  blue Flutter logo.
- **app-16 (#706)** — a timeboxed brand audit of the Flutter companion's
  surfaces (pairing, library, player) against the v2 brand checklist, so the
  second screen tells the same story as the first.

## Audit findings (app-16)

The companion is a pure utility listening client. Against the three hard
checklist criteria it is **clean**:

| Criterion | Finding |
|---|---|
| No retired tagline ("…effortlessly. Even in your own voice.") | Absent everywhere in `lib/`. |
| No `.ai` inside wordmark lockups | `.ai` appears only in a URL (`castwright.ai/pair` deep link) and reverse-DNS identifiers (`ai.castwright.art`, `ai.castwright.audio`). Neither is a brand lockup. |
| Engine credits where voices are shown | The player surfaces chapter/title only; voices and TTS engines are never displayed. Criterion is N/A. |

The one real gap: the companion carries **no brand line at all**, while the web
app puts the tagline on its empty-library and on-ramp surfaces. The v2 short
form `TAGLINE_SHORT = "Any book, fully cast."` should appear on the companion's
first-run brand moments so the experience is consistent.

## Scope

One branch, one PR: `Closes #632` and `Closes #706`. Touch only `apps/android/**`
and the shared `scripts/render-brand-pngs.mjs` (+ its test). **Out of scope:** the
iOS *build pipeline* itself (app-12) — this generates icon assets only and does
not activate an iOS target.

## Part A — iOS AppIcon set (app-15 / #632)

### Source and rasterizer

Reuse the existing Playwright-chromium `scripts/render-brand-pngs.mjs` (the
"no SVG rasterizer on the build box" blocker noted in the issue no longer
applies — this script already renders the Android legacy PNGs). No new brand
master is committed (the `brand/` directory is git-ignored, local-only); the iOS
variant is produced by transforming the existing `brand/castwright-icon.svg`
in-script, exactly as `sized()` already rewrites the root `<svg>`.

> **Worktree note:** because `brand/` is git-ignored, the SVG master is not
> present in a fresh worktree checkout. Copy `brand/castwright-icon.svg` (and any
> other `brand/*.svg` the script reads) from the primary checkout into the
> worktree's `brand/` before running the render script.

### iOS variant transform

`brand/castwright-icon.svg` is a **rounded, opaque** 512×512 tile:
`<rect width="512" height="512" rx="118" fill="#0f0e0d"/>` plus the waveform
artwork. Apple's requirements differ from Android's:

- **No alpha channel** — an icon with transparency is rejected at submission.
- **Square, no rounded corners** — iOS applies its own superellipse mask;
  baking corners in causes double-rounding / inset.

So the iOS job:

1. Rewrites `rx="118"` → `rx="0"` on the full-bleed tile (square corners).
2. Renders with `omitBackground: false` (opaque — the dark tile fills the whole
   square; no transparent pixels anywhere).

The waveform artwork keeps its existing coordinates (it already has safe padding
inside the 512 box), so the only visible change vs. the Android render is the
corners filling dark.

### Sizes

Add an `IOS_JOBS` array (or extend `JOBS`) emitting every filename already
referenced by
`apps/android/ios/Runner/Assets.xcassets/AppIcon.appiconset/Contents.json`, each
at its exact pixel dimensions:

| Filename | px |
|---|---|
| `Icon-App-20x20@1x.png` | 20 |
| `Icon-App-20x20@2x.png` | 40 |
| `Icon-App-20x20@3x.png` | 60 |
| `Icon-App-29x29@1x.png` | 29 |
| `Icon-App-29x29@2x.png` | 58 |
| `Icon-App-29x29@3x.png` | 87 |
| `Icon-App-40x40@1x.png` | 40 |
| `Icon-App-40x40@2x.png` | 80 |
| `Icon-App-40x40@3x.png` | 120 |
| `Icon-App-60x60@2x.png` | 120 |
| `Icon-App-60x60@3x.png` | 180 |
| `Icon-App-76x76@1x.png` | 76 |
| `Icon-App-76x76@2x.png` | 152 |
| `Icon-App-83.5x83.5@2x.png` | 167 |
| `Icon-App-1024x1024@1x.png` | 1024 |

`Contents.json` is **unchanged** — filenames already match; only the PNG bytes
are replaced.

### Test (Part A)

Extend the render-script spec (`node --test`):

- The iOS jobs are present with the correct filenames and pixel sizes.
- Each iOS job is flagged square + opaque (the `rx`→0 transform applied,
  `omitBackground: false`).
- The existing hand-designed-favicon no-clobber invariant still holds (the
  script never emits `public/favicon-16.png`, `favicon-32.png`, `favicon.svg`).

## Part B — short-form tagline (app-16 / #706)

### Brand constants

New `apps/android/lib/src/brand.dart` (mirrors the web app's `src/lib/brand.ts`):

```dart
/// Castwright brand copy — single source for the companion app.
const String kTagline =
    'Any book, performed by a full cast — kept true, kept yours, book after book.';
const String kTaglineShort = 'Any book, fully cast.';
```

### Surfaces

Show `kTaglineShort` on the two first-run brand moments:

- **Pairing screen** (`lib/src/ui/pairing_screen.dart`) — as a subtitle under
  the "Pair a device" header, the genuine first-run moment.
- **Empty home state** (`lib/src/ui/home_screen.dart`) — alongside the existing
  "Nothing in progress yet — start a book from Library." copy.

Keep it small and quiet (secondary text style) — this is a utility client, not a
marketing page.

### Test (Part B)

Dart tests under `apps/android/test/`:

- A widget test pumping `PairingScreen` and the empty `HomeScreen` asserts
  `kTaglineShort` is rendered on each.
- A constant test asserts the brand strings contain none of the banned words
  (`effortlessly`, `seamless`, `even in your own voice`) — the companion mirror
  of the web app's "no retired tagline survives" guard.

## Verification

- **Node:** `node --test` for the render-script spec; then
  `node scripts/render-brand-pngs.mjs` to regenerate (writes the new iOS PNGs;
  confirms the Android legacy PNGs are byte-unchanged).
- **Flutter:** `flutter test` in `apps/android` (run manually — Flutter is not
  in the Node `verify` battery; invoke `flutter.bat` under PowerShell).
- **Visual sanity:** open one regenerated iOS PNG to confirm a square, opaque,
  Castwright-branded icon (not the blue Flutter logo).

## Closeout

- Drop the app-15 and app-16 rows from `docs/BACKLOG.md`.
- `Closes #632` / `Closes #706` in the PR body.
- Add a ship-note line to plan 188 referencing this finish.
