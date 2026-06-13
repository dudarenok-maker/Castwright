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
> other `brand/*.svg` the script reads — `renderJobs` only needs the icon, but
> `renderAll` also reads `castwright-og.svg`) from the primary checkout into the
> worktree's `brand/` before running the render script. Also junction the root
> `node_modules` into the worktree so `@playwright/test` resolves (the chromium
> binary itself is machine-global under `%LOCALAPPDATA%\ms-playwright`).

> **Render the iOS subset ONLY (scope discipline).** `renderAll()` also rewrites
> `public/icon-512.png`, `public/icon-192.png`, `public/apple-touch-icon.png`,
> `public/og.png`, and the five Android `mipmap-*/ic_launcher.png` files. Running
> the full battery would churn all of those into a PR that should only touch iOS.
> So the script is refactored to expose `renderJobs(jobs)` and this task renders
> **only** the iOS jobs:
> `node -e "import('./scripts/render-brand-pngs.mjs').then(m => m.renderJobs(m.IOS_JOBS))"`.
> After rendering, `git status` must show only new/changed
> `ios/Runner/Assets.xcassets/AppIcon.appiconset/*.png` — nothing under `public/`
> or `mipmap-*`. If anything else changed, `git restore` it.

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
corners filling dark. The tile rect is `<rect width="512" height="512" rx="118"
fill="#0f0e0d"/>` — confirmed the only `rx="118"` in the file (the waveform bars
use `rx="15"`), so the replace is safe and unambiguous.

This is implemented **data-driven**, not by branching in the loop: each job tuple
gains an optional 6th element `transform` (an `svg => svg` function applied after
`sized()`). The existing `JOBS` entries stay 5-element (no transform); the iOS
jobs carry `transform: squareTile` where
`squareTile = (svg) => svg.replace('rx="118"', 'rx="0"')`. `JOBS` itself is
untouched.

### Sizes

Add a new exported `IOS_JOBS` array (the loop is extracted into an exported
`renderJobs(jobs)`; `renderAll()` becomes `renderJobs([...JOBS, ...IOS_JOBS])`
so the canonical "render everything" path stays correct, while this task can
render `IOS_JOBS` alone). `IOS_JOBS` emits every filename already referenced by
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

Extend the existing `scripts/tests/render-brand-pngs.test.mjs` (runs via
`npm run test:hooks` → `node scripts/run-hooks-tests.mjs`; it imports the job
arrays without launching chromium):

- `IOS_JOBS` has all 15 entries with the correct filenames and pixel sizes,
  each writing under `apps/android/ios/Runner/Assets.xcassets/AppIcon.appiconset/`.
- Each iOS job is square + opaque: `omitBackground` is `false` and its
  `transform` turns `rx="118"` into `rx="0"` (assert by applying the transform
  to a sample string).
- The existing hand-designed-favicon no-clobber invariant still holds across
  **both** `JOBS` and `IOS_JOBS` (neither emits `public/favicon-16.png`,
  `favicon-32.png`, or `favicon.svg`).

## Part B — short-form tagline (app-16 / #706)

### Brand constants

New `apps/android/lib/src/brand.dart` (mirrors the web app's `src/lib/brand.ts`).
Names use the codebase's descriptive lowerCamelCase top-level-const convention
(e.g. `companionAudioServiceConfig`, `demoBooks`) — **no `k` prefix**:

```dart
/// Castwright brand copy — single source for the companion app.
const String brandTagline =
    'Any book, performed by a full cast — kept true, kept yours, book after book.';
const String brandTaglineShort = 'Any book, fully cast.';
```

### Surfaces

Show `brandTaglineShort` on the two first-run brand moments, each wrapped in a
keyed `Text` so the widget tests can find it:

- **Pairing screen** (`lib/src/ui/pairing_screen.dart`) — as a subtitle at the
  top of the body (above the "Scan the pairing QR…" instruction), keyed
  `Key('pair-tagline')`. This is the genuine first-run moment.
- **Empty home state** (`lib/src/ui/home_screen.dart`) — inside the existing
  `Key('continue-empty')` block, alongside "Nothing in progress yet — start a
  book from Library.", keyed `Key('home-tagline')`.

Keep it small and quiet (secondary text style) — this is a utility client, not a
marketing page.

### Test (Part B)

Dart tests under `apps/android/test/`, reusing existing pump scaffolding:

- **Extend `test/ui/pairing_screen_test.dart`** — its `open()` helper already
  pumps `PairingScreen` with a `FakeStore` + `PairingService`; add a case
  asserting `find.byKey(const Key('pair-tagline'))` is `findsOneWidget` and
  carries `brandTaglineShort`.
- **Extend `test/ui/home_screen_test.dart`** — its "empty state" case already
  pumps `HomeScreen(books: [sb('x')], …)`; add an assertion that
  `find.byKey(const Key('home-tagline'))` is `findsOneWidget`.
- **New `test/brand_test.dart`** — a guard that walks `lib/**/*.dart` (via
  `dart:io`; `flutter test`'s cwd is the package root) and asserts no source
  file contains a retired-tagline phrase (`effortlessly`, `even in your own
  voice`) or banned word (`seamless`). Stronger than a constant-only check —
  it is the companion mirror of the web app's "no retired tagline survives
  anywhere" guard.

## Verification

- **Node:** `npm run test:hooks` for the render-script spec; then render the
  iOS subset only —
  `node -e "import('./scripts/render-brand-pngs.mjs').then(m => m.renderJobs(m.IOS_JOBS))"` —
  and confirm `git status` shows only `AppIcon.appiconset/*.png` changed
  (nothing under `public/` or `mipmap-*`; `git restore` anything else).
- **Flutter:** `flutter test` in `apps/android` (run manually — Flutter is not
  in the Node `verify` battery; invoke `flutter.bat` under PowerShell). No new
  pub dependency, so no `flutter pub get` needed.
- **Visual sanity:** open the regenerated `Icon-App-1024x1024@1x.png` to confirm
  a square, opaque, Castwright-branded icon (not the blue Flutter logo). The
  iOS *build* can't be exercised on Windows (no iOS target until app-12), so
  acceptance is the visual asset check, not an `xcodebuild`/`flutter build ios`.

## Closeout

- Drop the app-15 and app-16 rows from `docs/BACKLOG.md`.
- `Closes #632` / `Closes #706` in the PR body.
- Add a ship-note line to plan 188 referencing this finish.
