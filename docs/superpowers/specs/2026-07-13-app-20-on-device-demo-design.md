# app-20 — On-device demo / guest mode on the pairing entry (design)

**Status:** design approved 2026-07-13
**Issue:** #1575 (`app-20`, `area:app`, `moscow:must`, `type:feature`)
**Area:** Android companion (`apps/android/`)

## Problem

Every real surface of the companion app (library, downloads, playback, browse) is
gated behind QR-pairing to a self-hosted, LAN-only Castwright server. Google Play's
App-content **"Sign-in details"** review cannot exercise such an app — a reviewer
can't run the user's server, and we won't expose a local server to an external
reviewer. Without a self-contained on-device experience, we cannot promote from
**Internal testing** (unreviewed, ships fine today) to the reviewed **Open testing
(public beta) / production** tracks.

A fully-posed demo runtime already exists — it backs the marketing screenshot capture
(`apps/android/integration_test/marketing_capture_test.dart`). This work promotes that
runtime into a real, shipped **"Try the demo"** entry so the whole app runs on-device
with **no paired server and no network** (airplane-mode safe).

## Goals

- A visible **"Try the demo"** (guest-mode) affordance on the first screen a
  cold-launched, unpaired app shows.
- Tapping it runs the app against the demo runtime — sample library ("The Hollow Tide"
  series + "The Coalfall Commission"), interactive playback, hierarchical browse — with
  **zero network/server calls** (works in airplane mode).
- A clear, unmistakable indication the app is in demo mode, and a clear way back to
  real pairing. Demo state **never leaks** into a real paired session.
- After shipping, Play "Sign-in details" can truthfully tick **"provides full access to
  all features."**
- Paired automated coverage **and** on-device manual acceptance via Android Studio.

## Non-goals (deliberately out of scope)

- Real demo audio playback (the demo produces no sound — see Playback below).
- Per-book distinct covers/audio, or any demo content beyond the existing four books.
- A demo entry inside the deeper `PairingScreen` host/code/fingerprint form — the
  affordance lives on the "Not paired yet" home screen only.
- Any change to the real pairing / sync / player paths.

## Design

The demo runtime (`buildDemoRuntime()` in `lib/src/demo/demo_runtime.dart`) already
returns a real `CompanionRuntime` — the exact type `main.dart` renders via its existing
`runtimeOverride` seam. So this is a small, in-convention extension, not new plumbing.

### 1. Entry point & flow (`apps/android/lib/main.dart`, `HomePage`)

- The **"Not paired yet"** screen (the true first screen for an unpaired reviewer, which
  today shows only a "Pair a device" button) gains a secondary **"Try the demo"** button
  (`Key('try-demo')`) beside it.
  - The issue names `pairing_screen.dart` as the key file loosely; the home screen is
    the zero-taps-deep, most-discoverable spot and is where the affordance lands.
- `HomePage` gains `_demoMode` state and a `_startDemo()` / `_exitDemo()` pair.
- `_startDemo()` builds the demo runtime (§3), sets `_runtime` + a demo-sentinel
  `_paired`, and `_demoMode = true`. **It never calls `store.save()`**, so nothing
  touches the `SecurePairingStore`. On the next cold launch `store.load()` still returns
  `null` → the app is "Not paired yet" again. This satisfies "demo state never leaks."
- The demo runtime attaches **no** `audioHandler` (as `CompanionRuntime.forDemo` already
  does), so the fake book never appears on the lock screen / Bluetooth / Android Auto.

### 2. Isolation — leak-safe, zero network

The demo is leak-safe by two facts, **not** by avoiding disk (it can't — covers render
via `Image.file`, see §4):

- **Drift is `NativeDatabase.memory()`** — no book metadata, chapters, playback, or
  resume rows ever persist. Nothing survives the process.
- **The pairing keystore is never written** — `_startDemo` never calls `store.save()`,
  so no paired-server record and no credentials touch the `SecurePairingStore`. On the
  next cold launch `store.load()` still returns `null` → "Not paired yet."

The **only** disk footprint is the transient cover-thumbnail cache (§4), written under an
app-private demo root — `getApplicationDocumentsDirectory()/demo-runtime` — and
`deleteDir`'d when the demo exits (§5). Even if that cleanup were skipped, the residue is
a few cached JPEGs in the app's own private sandbox, invisible to any real paired session
and wiped on uninstall.

Airplane-mode safety is independent: the demo's fake-HTTP `send` returns canned JSON with
zero TLS, so no request ever leaves the process regardless of network state.

### 3. Playback — new `DemoTickingAudioEngine`

Today `DemoAudioEngine` is a *posed* fake: fixed position `7:12 / 23:40`, always
"playing", every control a no-op — correct for deterministic screenshots, but a Play
reviewer who taps ▶ sees a frozen timer and may read it as broken.

- Add a second demo engine, `DemoTickingAudioEngine` (`lib/src/demo/`): position
  advances on a `Timer.periodic`, and `play` / `pause` / `seek` / `setSpeed` mutate real
  internal state and emit on the position/playing/duration streams. **No actual audio.**
- `buildDemoRuntime` gains an engine selector. **The marketing capture path keeps the
  posed `DemoAudioEngine`** so its screenshots stay frozen and deterministic; the
  production demo path selects the ticking engine.
- `DemoAudioEngine` is retained unchanged.

### 4. Covers — committed assets extracted to a real disk root

The library renders covers with `Image.file(File(path))` (`library_home_screen.dart:273,
472`), and `ThumbnailCache.ensureThumbnail` (`cover_thumbnails.dart:51-60`) writes a
downscaled JPEG through the `FileStore` and returns its **path** for the widget to open
as a real `dart:io` `File`. So covers require a real on-disk root — an in-memory store
cannot back `Image.file`. The demo therefore uses `DiskFileStore` rooted at the
app-private demo dir (§2), not `InMemoryFileStore`.

Source bytes come from committed assets (the marketing capture adb-pushes the git-ignored
`brand/book-covers/*.png`; that push step does not exist for a shipped APK):

- A Node ESM script under `scripts/` downscales the git-ignored `brand/book-covers/`
  sources into a **committed** `apps/android/assets/demo-covers/{bookId}.png` (4 files:
  `hollow-tide-1`, `hollow-tide-2`, `hollow-tide-3`, `coalfall-commission`), declared in
  `apps/android/pubspec.yaml` under `flutter: assets:`. This mirrors the established web
  pattern (git-ignored `brand/` sources → committed generated PNGs in `public/`). The
  script carries an explicit source-filename → `bookId` mapping, since the raw brand
  files are not named by `bookId` (the capture README notes "rename copies if needed").
- At demo launch, the bundled asset bytes are read via `rootBundle` and written into the
  demo root through `DiskFileStore`, so `ThumbnailCache` finds/downscales them and the
  UI's `Image.file` renders real covers. The marketing capture keeps its existing
  `coversDir` disk path unchanged.
- Covers are polish, not blocking: both `Image.file` call sites guard `path != null`, so
  a missing cover degrades to the existing placeholder tile.

**Assumption (confirm before build):** committing 4 small downscaled demo covers into the
tracked app is acceptable — the Coalfall cover is a Castwright-owned original, and "The
Hollow Tide" covers are fictional demo art. This is consistent with shipping generated
brand assets in `public/`.

### 5. "You're in demo mode" indication + exit (`lib/src/ui/library_home_screen.dart`)

`LibraryHomeScreen` takes a `PairedServer server` and `Future<void> Function() onUnpair`,
which it forwards to its settings screen (where the "Unpair" affordance lives).

- Add one optional `bool demoMode = false` to `LibraryHomeScreen`, threaded into its
  settings screen. When true:
  - A persistent, unmistakable **"Demo" badge** in the AppBar (`Key('demo-badge')`).
  - The settings screen's "Unpair" action reads **"Exit demo."**
  - The settings screen **suppresses the server-URL row** — otherwise it would show the
    fake sentinel (`https://studio.local:8443`) and read as a bogus real pairing.
- `HomePage` renders the demo library with `demoMode: true` and wires
  `onUnpair → _exitDemo()`.
- `_exitDemo()` disposes the runtime, `deleteDir`'s the demo root (the only disk
  footprint — the transient thumbnail cache), and resets to "Not paired yet"
  (`_runtime = null`, `_paired = null`, `_demoMode = false`). The keystore was never
  written, so there is no paired state to clear.

### 6. The `forDemo` boundary

`CompanionRuntime.forDemo` is currently `@visibleForTesting`, with `buildDemoRuntime` as
its one sanctioned non-test caller. Shipping the demo in the production UI makes it a real
production path, so:

- Drop `@visibleForTesting` on `CompanionRuntime.forDemo`.
- Remove the `// ignore: invalid_use_of_visible_for_testing_member` in `buildDemoRuntime`.

## Testing

Paired automated coverage per the repo's testing discipline, plus on-device acceptance.

### Automated

- **Widget** — "Not paired yet" shows `try-demo`; tapping it launches the demo library
  **offline** (empty deep-link stream, no network): assert a demo book tile
  (`Key('book-hollow-tide-1')`) and the `demo-badge` render.
- **Widget** — exit demo returns to "Not paired yet", and assert the pairing store was
  **never written** (a spy/`DemoPairingStore` whose `load()` is still `null` and whose
  `save` was never called).
- **Widget** — in `demoMode`, the settings screen shows the `demo-badge` / "Exit demo"
  wording and **does not** render the fake server URL.
- **Unit** — `DemoTickingAudioEngine` advances position over pumped time (live broadcast
  streams, not one-shot `Stream.value`) and honors `pause` / `seek` / `setSpeed`.
- **Unit** — the cover-render script's pure helpers (filename mapping, downscale params).
- **Regression guard** — the marketing capture keeps the posed engine + `coversDir` path
  (existing `test/demo/*`, `test/ui/*`, and the marketing integration test stay green).

### On-device acceptance (Android Studio)

Run the app on a real device / emulator via Android Studio and walk through:

1. Cold launch unpaired → "Not paired yet" shows **"Try the demo."**
2. Enable **airplane mode**, tap "Try the demo" → the demo library loads (four books,
   covers rendered, Continue-listening rail) with no network.
3. Open a book → tap ▶ → the timer **advances**; pause/seek/speed respond.
4. Confirm the persistent **"Demo" badge** is visible; open settings → **"Exit demo."**
5. Exit demo → back to "Not paired yet."
6. Kill and relaunch → still "Not paired yet" (no leaked paired session).

Drive taps via the known emulator recipe (adb `input tap`, no CDP). This acceptance step
is recorded in the regression plan's manual walkthrough.

## Docs / ship

- New regression plan `docs/features/NN-app-20-on-device-demo.md` (number assigned at
  implementation time after scanning in-flight worktrees; ~252), plus an `INDEX.md`
  entry.
- Update the Play publishing runbook / Play-Store-path tracking so "Sign-in details" can
  truthfully tick **"provides full access to all features"** and the Open-testing
  promotion is unblocked (confirm its canonical home during planning).
- Release-notes entry in both `docs/release-notes-next.md` (technical) and
  `RELEASE_NOTES.md` (brand voice).
- PR body: `Closes #1575`.

## Key files

- `apps/android/lib/main.dart` — `HomePage`: `try-demo` button, `_startDemo`/`_exitDemo`,
  `_demoMode`.
- `apps/android/lib/src/demo/demo_runtime.dart` — engine + cover-source selectors; drop
  the `visibleForTesting` ignore.
- `apps/android/lib/src/demo/demo_ticking_audio_engine.dart` — **new**, the interactive
  demo engine.
- `apps/android/lib/src/data/companion_runtime.dart` — drop `@visibleForTesting` on
  `forDemo`.
- `apps/android/lib/src/ui/library_home_screen.dart` — optional `demoMode` (badge + "Exit
  demo" wording).
- `apps/android/assets/demo-covers/*.png` — **new**, committed downscaled covers.
- `apps/android/pubspec.yaml` — declare the asset dir.
- `scripts/*.mjs` (+ colocated test) — **new** cover render/copy script.

## Depends on

- Nothing to build — the demo runtime, demo data, and marketing harness already exist.
- **Gates** the Open-testing / public-beta promotion.
