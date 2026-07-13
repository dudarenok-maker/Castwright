# app-20 — On-device demo / guest mode on the pairing entry (design)

**Status:** design approved 2026-07-13 (revised after independent review)
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
  series + "The Coalfall Commission", **all four books**), interactive playback,
  hierarchical browse — with **zero network/server calls** (works in airplane mode).
- A clear, unmistakable indication the app is in demo mode, and a clear way back to
  real pairing. Demo state **never leaks** into a real paired session.
- After shipping, Play "Sign-in details" can truthfully tick **"provides full access to
  all features."**
- Paired automated coverage **and** on-device manual acceptance via Android Studio.

## Non-goals (deliberately out of scope)

- Real demo audio playback (the demo produces no sound — see §3).
- Per-book distinct covers/audio, or any demo content beyond the existing four books.
- A demo entry inside the deeper `PairingScreen` host/code/fingerprint form — the
  affordance lives on the "Not paired yet" home screen only.
- Any change to the real pairing / sync / player paths.

## Design

The demo runtime (`buildDemoRuntime()` in `lib/src/demo/demo_runtime.dart`) already
returns a real `CompanionRuntime` — the exact type `main.dart` renders. This work adds a
production entry point, an interactive audio engine, a bundled-cover pipeline, and a
demo-mode chrome, all as **additive, optional-defaulted** changes so the existing
marketing-capture and widget-test callers stay green.

### 1. Entry point & flow (`apps/android/lib/main.dart`, `HomePage`)

- The **"Not paired yet"** screen (the true first screen for an unpaired reviewer, which
  today shows only a "Pair a device" button) gains a secondary **"Try the demo"** button
  (`Key('try-demo')`) beside it.
  - The issue names `pairing_screen.dart` as the key file loosely; the home screen is
    the zero-taps-deep, most-discoverable spot and is where the affordance lands.
- `HomePage` gains `_demoMode` state and a `_startDemo()` / `_exitDemo()` pair.
- **`_startDemo()` sets `_runtime` + a demo-sentinel `_paired` + `_demoMode = true`
  DIRECTLY via `setState` — it must NOT route through `_boot()`.** (Do-not-refactor
  constraint: `_boot`'s `runtimeOverride` branch reloads `_paired = await store.load()`
  (`main.dart:178`); for the production `SecurePairingStore` that returns `null`, so the
  build would fall back to "Not paired yet" and the library would never render. The
  marketing path only survives this because `DemoPairingStore.load()` returns a sentinel.)
- **It never calls `store.save()`**, so nothing touches the `SecurePairingStore`. On the
  next cold launch `store.load()` still returns `null` → "Not paired yet" again.
- The demo runtime attaches **no** `audioHandler` (as `CompanionRuntime.forDemo` already
  does — it passes `null`, `companion_runtime.dart:106`), so the fake book never appears
  on the lock screen / Bluetooth / Android Auto.

**Host-testability seam.** The shipped `_startDemo` depends on three things that are
unavailable in a plain `flutter test`: `getApplicationDocumentsDirectory()`
(`path_provider`, throws `MissingPluginException` on host), `rootBundle` asset reads, and
`DiskFileStore`. So `_startDemo`'s dependencies are **injectable on `HomePage` /
`AudiobookCompanionApp`**, each defaulted to the production implementation:

- `demoRootResolver` — `Future<String> Function()`, default `getApplicationDocumentsDirectory()/demo-runtime`.
- `demoFileStore` — `FileStore`, default `const DiskFileStore()`.
- `demoAssetLoader` — `Future<List<int>> Function(String assetKey)`, default `rootBundle`-backed.

Widget tests inject an `InMemoryFileStore`, a fixed root, and a fake asset loader, so the
**real** `_startDemo` control flow (button → `buildDemoRuntime` → `LibraryHomeScreen`)
runs on host. (Covers degrade to the placeholder tile in-test because `Image.file` can't
read an in-memory path — acceptable; cover rendering is verified on-device, and the build
script's downscale is unit-tested separately.)

### 2. Isolation — leak-safe, zero network

The demo is leak-safe by two facts, **not** by avoiding disk (it can't — covers render
via `Image.file`, see §4):

- **Drift is `NativeDatabase.memory()`** (`demo_runtime.dart:57`) — no book metadata,
  chapters, playback, or resume rows ever persist. `dispose` closes it
  (`companion_runtime.dart:302`). Confirmed safe on real devices (the marketing
  integration test already exercises it on-device).
- **The pairing keystore is never written** — `_startDemo` never calls `store.save()`,
  so no paired-server record and no credentials touch the `SecurePairingStore`.

The disk footprint is **everything written under the app-private demo root** —
`getApplicationDocumentsDirectory()/demo-runtime`: the extracted cover PNGs, any
thumbnail cache `ThumbnailCache` writes, and `settings.json` if the demo user changes a
setting (`settingsStore.save`, `companion_runtime.dart:286`). All of it is `deleteDir`'d
when the demo exits (§5). Even if that cleanup were skipped, the residue lives only in the
app's own private sandbox, is invisible to any real paired session, and is wiped on
uninstall.

Airplane-mode safety is independent of all of the above: the demo's fake-HTTP `send`
returns canned JSON with **zero TLS and zero sockets** regardless of network state. Note
`_startDemo` passes **`offline: false`** (see §4 for why) — `demoHttpSend(offline:)` means
"simulate the server returning 503," not "the device is offline," so `false` is the
airplane-safe value that shows all four books.

### 3. Playback — new `DemoTickingAudioEngine`

Today `DemoAudioEngine` is a *posed* fake: fixed position `7:12 / 23:40`, always
"playing", every control a no-op — correct for deterministic screenshots, but a Play
reviewer who taps ▶ sees a frozen timer and may read it as broken.

- Add a second demo engine, `DemoTickingAudioEngine` (`lib/src/demo/`): position advances
  on a `Timer.periodic`, and `play` / `pause` / `seek` / `setSpeed` mutate real internal
  state.
- **Hard runtime contract (not a test detail):**
  - `positionStream` / `playingStream` / `durationStream` must be **broadcast** streams.
    `positionStream` is subscribed three times (`player_controller.dart:75`,
    `player_screen.dart:269, 292`) and `durationStream` direct
    (`player_screen.dart:288`); the posed engine survives only because each getter mints a
    fresh single-use `Stream.value`. A single-subscriber `StreamController.stream` would
    throw "Stream has already been listened to" on the second listener.
  - `dispose()` must **cancel the `Timer` and close the controllers.** The dispose chain
    is real — `runtime.dispose → player.dispose (companion_runtime.dart:301) →
    _engine.dispose (player_controller.dart:446)` — but the posed engine's `dispose` is a
    no-op, so a leaked timer would keep firing `setState` on a torn-down tree and
    accumulate across enter/exit cycles.
- `buildDemoRuntime` gains an **optional** engine selector (e.g. `AudioEngine? engine`),
  defaulted to a posed `DemoAudioEngine()` so the three existing call sites
  (`demo_runtime_test.dart:8,21,29`, `marketing_capture_test.dart:35`) stay green. The
  production `_startDemo` passes a `DemoTickingAudioEngine`. `DemoAudioEngine` is retained
  unchanged for deterministic screenshots.

### 4. Covers — committed assets, extracted to disk by `_startDemo`

The library renders covers with `Image.file(File(path))` (`library_home_screen.dart:273,
472`), so covers require a real on-disk root — an in-memory store cannot back
`Image.file`. `buildDemoRuntime` **stays cover-agnostic** (keeps its existing `coversDir`
disk-read, `demo_runtime.dart:122-126`); a `rootBundle` selector inside it would break the
deliberately asset-free host tests (`library_home_screen_test.dart:90`). Extraction lives
in `_startDemo` instead:

- **Build-time:** a Node ESM script under `scripts/` downscales the git-ignored
  `brand/book-covers/` sources to display size into **committed**
  `apps/android/assets/demo-covers/{bookId}.png` (4 files: `hollow-tide-1`,
  `hollow-tide-2`, `hollow-tide-3`, `coalfall-commission`), declared in
  `apps/android/pubspec.yaml` under `flutter: assets:`. Mirrors the web pattern
  (git-ignored `brand/` sources → committed generated PNGs in `public/`). The script
  carries an explicit source-filename → `bookId` mapping (raw brand files are not named by
  `bookId`; the capture README notes "rename copies if needed"). The **downscale happens
  here, in the script** — not at runtime.
- **Launch-time (`_startDemo`):** read the four bundled asset PNGs via `demoAssetLoader`
  and write them into `$root/covers/{bookId}.png` via `demoFileStore`, then call
  `buildDemoRuntime(coversDir: '$root/covers', root: root, engine: DemoTickingAudioEngine(),
  offline: false)`. The three downloaded books get their `coverThumbPath` pre-seeded to
  that path (`demo_runtime.dart:74`), so `ThumbnailCache.ensureThumbnail` early-returns it
  (`cover_thumbnails.dart:53`) and `Image.file` renders it directly (no runtime downscale
  relied on — that's why the script pre-sizes them). The not-downloaded `hollow-tide-3` has
  no cover row; it degrades to the placeholder tile — acceptable.
- **Why `offline: false`:** the fake transport never hits a socket, so `false` is
  airplane-safe; and `false` keeps the manifest serving all four books. `offline: true`
  would 503 the manifest, dropping the not-downloaded `hollow-tide-3`
  (`demo_runtime_test.dart:37` proves this) → only three books, failing acceptance.
- Covers are polish, not blocking: both `Image.file` call sites guard `path != null`, so a
  missing cover degrades to the existing placeholder tile.

**Assumption (confirm before build):** committing 4 small downscaled demo covers into the
tracked app is acceptable — the Coalfall cover is a Castwright-owned original, and "The
Hollow Tide" covers are fictional demo art. This is consistent with shipping generated
brand assets in `public/`. *Fallback if declined:* procedural placeholder covers drawn at
runtime (no committed assets).

### 5. "You're in demo mode" indication + exit

`LibraryHomeScreen` takes a `PairedServer server` and `Future<void> Function() onUnpair`,
and forwards them into `AppSettingsScreen` (`library_home_screen.dart:327-334`) — the
**same widget instance** real paired sessions use (single call site `main.dart:350`). Add
one optional `bool demoMode = false` threaded through `LibraryHomeScreen` →
`AppSettingsScreen`. When true:

- A persistent, unmistakable **"Demo" badge** in the library AppBar (`Key('demo-badge')`).
- In `AppSettingsScreen`, **suppress the entire Server section** — the URL row, the cert
  fingerprint (would show `demo-fingerprint`), and "Paired since …"
  (`app_settings_screen.dart:202-218`) — since all three read as a real (broken) pairing.
- Rewrite the unpair affordance for demo: the tile subtitle
  ("Disconnect + forget this server", `:233`) and the confirm-dialog body
  ("removes the saved certificate + downloaded library", `:108-110`) become demo-accurate
  copy, and the action label reads **"Exit demo."**
- The marketing `runtimeOverride` path keeps `demoMode: false`, so
  `marketing_capture_test.dart`'s settings scene stays green.
- `HomePage` renders the demo library with `demoMode: true` and wires
  `onUnpair → _exitDemo()`.
- `_exitDemo()` disposes the runtime (cancelling the ticking timer, §3), `deleteDir`'s the
  demo root (§2), and resets to "Not paired yet" (`_runtime = null`, `_paired = null`,
  `_demoMode = false`). The keystore was never written, so there is no paired state to
  clear.

### 6. The `forDemo` boundary

`CompanionRuntime.forDemo` is currently `@visibleForTesting`, with `buildDemoRuntime` as
its one sanctioned non-test caller. Shipping the demo in the production UI makes it a real
production path, so:

- Drop `@visibleForTesting` on `CompanionRuntime.forDemo`.
- Remove the `// ignore: invalid_use_of_visible_for_testing_member` in
  `demo_runtime.dart:143`. (A now-stale identical ignore also sits at
  `library_home_screen_test.dart:105`; harmless — `unnecessary_ignore` isn't enabled — but
  tidy it in the same pass.)

## Testing

Paired automated coverage per the repo's testing discipline, plus on-device acceptance.

### Automated

- **Widget** — tapping `try-demo` on "Not paired yet" runs the **real** `_startDemo`
  (injected `InMemoryFileStore` + fixed root + fake asset loader, empty deep-link stream,
  production-style store returning `null`): assert the demo library renders with **all
  four** book tiles (`Key('book-hollow-tide-1')` … `hollow-tide-3`,
  `coalfall-commission`) and the `demo-badge`. This locks both the shipped control flow
  **and** the `offline: false` four-books contract.
- **Widget** — exit demo returns to "Not paired yet"; assert the pairing store was
  **never written** (a spy store whose `save` was never called and whose `load()` is still
  `null`).
- **Widget** — in `demoMode`, `AppSettingsScreen` shows the `demo-badge` / "Exit demo"
  wording and renders **no** Server section (no URL, no fingerprint, no "Paired since").
- **Unit** — `DemoTickingAudioEngine`: position advances over pumped time; `positionStream`
  survives **multiple concurrent subscribers** (broadcast); `pause`/`seek`/`setSpeed`
  honored; `dispose` cancels the timer (no emissions after dispose).
- **Unit** — the cover-render **script's** pure helpers (source→`bookId` mapping, downscale
  target dimensions).
- **Regression guard** — the marketing capture keeps the posed engine + `coversDir` path
  and `demoMode: false` (existing `test/demo/*`, `test/ui/*`, and the marketing
  integration test stay green).

### On-device acceptance (Android Studio)

Run the built app on a real device / emulator via Android Studio and walk through:

1. Cold launch unpaired → "Not paired yet" shows **"Try the demo."**
2. Enable **airplane mode**, tap "Try the demo" → the demo library loads (**four** books,
   covers rendered, Continue-listening rail) with no network.
3. Open a book → tap ▶ → the timer **advances**; pause/seek/speed respond.
4. Confirm the persistent **"Demo" badge**; open settings → no server URL/fingerprint,
   action reads **"Exit demo."**
5. Exit demo → back to "Not paired yet."
6. Kill and relaunch → still "Not paired yet" (no leaked paired session).

Drive taps via the known emulator recipe (adb `input tap`, no CDP). Recorded in the
regression plan's manual walkthrough.

## Docs / ship

- New regression plan `docs/features/NN-app-20-on-device-demo.md` (number assigned at
  implementation time after scanning in-flight worktrees; ~252), plus an `INDEX.md` entry.
- Update the Play publishing runbook / Play-Store-path tracking so "Sign-in details" can
  truthfully tick **"provides full access to all features"** and the Open-testing
  promotion is unblocked (confirm its canonical home during planning).
- Release-notes entry in both `docs/release-notes-next.md` (technical) and
  `RELEASE_NOTES.md` (brand voice).
- PR body: `Closes #1575`.

## Key files

- `apps/android/lib/main.dart` — `HomePage`/`AudiobookCompanionApp`: `try-demo` button,
  `_startDemo`/`_exitDemo`, `_demoMode`, and the `demoRootResolver` / `demoFileStore` /
  `demoAssetLoader` injection seams (defaulted to production). **`_startDemo` sets state
  directly, not via `_boot`.**
- `apps/android/lib/src/demo/demo_runtime.dart` — optional `engine` param (default posed);
  stays cover-agnostic; drop the `visibleForTesting` ignore.
- `apps/android/lib/src/demo/demo_ticking_audio_engine.dart` — **new**, broadcast-stream,
  timer-backed engine with a real `dispose`.
- `apps/android/lib/src/data/companion_runtime.dart` — drop `@visibleForTesting` on
  `forDemo`.
- `apps/android/lib/src/ui/library_home_screen.dart` — optional `demoMode` (AppBar badge +
  thread to settings).
- `apps/android/lib/src/ui/app_settings_screen.dart` — `demoMode`: suppress Server section,
  demo unpair copy + "Exit demo" label.
- `apps/android/assets/demo-covers/*.png` — **new**, committed downscaled covers.
- `apps/android/pubspec.yaml` — declare the asset dir.
- `scripts/*.mjs` (+ colocated test) — **new** cover render/copy script (build-time
  downscale).

## Depends on

- Nothing to build — the demo runtime, demo data, and marketing harness already exist.
- **Gates** the Open-testing / public-beta promotion.
