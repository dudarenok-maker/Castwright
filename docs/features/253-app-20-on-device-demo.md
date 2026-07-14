---
status: active
shipped: null
owner: null
---

# 253 — app-20: On-device demo / guest mode on the pairing entry

> Status: active
> Key files: `apps/android/lib/main.dart` (`HomePage`: `try-demo` button, `_startDemo`/`_exitDemo`,
> `_demoMode`, `demoRootResolver`/`demoFileStore`/`demoAssetLoader` injection seams),
> `apps/android/lib/src/demo/demo_runtime.dart` (optional `engine` param),
> `apps/android/lib/src/demo/demo_ticking_audio_engine.dart` (new),
> `apps/android/lib/src/data/companion_runtime.dart` (`forDemo`, no longer `@visibleForTesting`),
> `apps/android/lib/src/ui/library_home_screen.dart` + `app_settings_screen.dart` (`demoMode`),
> `apps/android/assets/demo-covers/*.png` (new, committed), `apps/android/pubspec.yaml`,
> `scripts/*.mjs` (new cover render/copy script)
> URL surface: native app only — no web URL surface. Companion pairing screen ("Not paired yet")
> gains a "Try the demo" button.
> OpenAPI ops: none — the demo runtime is a fully in-process fake transport (`demoHttpSend`),
> zero network calls.

## Benefit / Rationale

- **User:** anyone who installs the companion app — including a Google Play reviewer with
  no Castwright server to pair to — can tap "Try the demo" on first launch and see the real
  app (library, browse, interactive playback) with zero setup, airplane-mode safe.
- **Technical:** promotes the existing marketing-capture demo runtime
  (`buildDemoRuntime()` / `CompanionRuntime.forDemo`) from a test-only fixture into a real,
  additive production entry point — no changes to the real pairing/sync/player code paths.
- **Architectural:** locks in a leak-safety contract for any future demo/guest surface —
  in-memory-only persistence (Drift `NativeDatabase.memory()`), the real pairing keystore is
  never touched (`store.save()` is never called from the demo path), and all on-disk residue
  lives under a single app-private demo root that's `deleteDir`'d on exit. Unblocks the Google
  Play **"Sign-in details"** app-content review question — Castwright can now truthfully tick
  **"provides full access to all features"** — which gates promoting the companion app from
  Internal testing to the reviewed Open testing / production tracks.

## Architectural impact

- **New seams / extension points:**
  - `HomePage` gains `_demoMode` state plus `_startDemo()` / `_exitDemo()`, and three
    injectable seams defaulted to production implementations: `demoRootResolver` (→
    `getApplicationDocumentsDirectory()/demo-runtime`), `demoFileStore` (→
    `DiskFileStore`), `demoAssetLoader` (→ `rootBundle`). These exist purely so
    `flutter test` (no platform channels) can drive the *real* `_startDemo` control flow with
    an `InMemoryFileStore` + fixed root + fake asset loader.
  - `buildDemoRuntime` gains an optional `AudioEngine? engine` param, defaulted to the existing
    posed `DemoAudioEngine()` so the three pre-existing callers (`demo_runtime_test.dart`,
    `marketing_capture_test.dart`) are unaffected. The shipped `_startDemo` passes the new
    `DemoTickingAudioEngine`.
  - `LibraryHomeScreen` / `AppSettingsScreen` gain an optional `bool demoMode = false`,
    defaulted off so every existing non-demo caller (real pairing, marketing capture) is
    unaffected.
  - `CompanionRuntime.forDemo` drops `@visibleForTesting` — it is now a sanctioned production
    call path, not just a test fixture.
- **Invariants preserved:**
  - The real pairing / sync / player code paths are untouched — the demo is fully additive.
  - `_boot()`'s `runtimeOverride` reload-from-store branch (`main.dart:178`) is never invoked
    by the demo path; `_startDemo` sets `_runtime`/`_paired`/`_demoMode` directly via
    `setState`, because routing through `_boot()` would call `store.load()` against the real
    `SecurePairingStore`, which returns `null` in production and would silently fall back to
    "Not paired yet".
  - The demo attaches no `audioHandler` (mirrors `CompanionRuntime.forDemo` passing `null`),
    so it never appears on the lock screen / Bluetooth / Android Auto.
- **Migration story:** none — no persisted schema changes. The demo's Drift instance is
  `NativeDatabase.memory()` and is discarded on dispose.
- **Reversibility:** the entire feature is one additive UI button + two new methods on
  `HomePage`. Reverting means dropping the button and the `_startDemo`/`_exitDemo` methods;
  nothing else in the app depends on the demo path existing.

## Invariants to preserve

1. **Leak-safety — in-memory Drift.** The demo's `NativeDatabase.memory()`
   (`demo_runtime.dart:57`) means no book metadata, chapters, playback, or resume rows ever
   persist to disk. `dispose()` closes it (`companion_runtime.dart:302`).
2. **Leak-safety — keystore never written.** `_startDemo` never calls `store.save()`. On the
   next cold launch, `store.load()` still returns `null` → "Not paired yet" again. There is no
   paired state to clear on exit because none was ever written.
3. **Leak-safety — demo-root cleanup.** `_exitDemo()` disposes the runtime (cancelling the
   `DemoTickingAudioEngine` timer), `deleteDir`'s the demo root
   (`getApplicationDocumentsDirectory()/demo-runtime` — covers, thumbnail cache,
   `settings.json` if the demo user changed a setting), and resets `_runtime = null`,
   `_paired = null`, `_demoMode = false`. Even if cleanup were skipped, all residue lives only
   in the app's own private sandbox and is wiped on uninstall.
4. **`offline: false` / four-books contract.** `_startDemo` calls `buildDemoRuntime(...,
   offline: false)`. The fake transport (`demoHttpSend`) never opens a socket regardless of
   this flag — `offline:` means "simulate the server returning 503," not "the device is
   offline." `offline: true` would 503 the manifest and drop the not-downloaded
   `hollow-tide-3` book (`demo_runtime_test.dart:37`), leaving only three books and failing
   acceptance. `false` is both the airplane-safe value and the one that shows all **four**
   books.
5. **`DemoTickingAudioEngine` stream contract.** `positionStream` / `playingStream` /
   `durationStream` must be **broadcast** streams — `positionStream` is subscribed three times
   (`player_controller.dart:75`, `player_screen.dart:269, 292`) and `durationStream` once
   direct (`player_screen.dart:288`); a single-subscriber stream throws "Stream has already
   been listened to" on the second listener. `dispose()` must cancel the internal `Timer` and
   close the controllers — the dispose chain is real
   (`runtime.dispose → player.dispose → _engine.dispose`), and a leaked timer would keep
   firing `setState` on a torn-down tree.
6. **Covers are committed, pre-downscaled assets, not runtime-rendered.** The four demo cover
   PNGs (`hollow-tide-1`, `hollow-tide-2`, `hollow-tide-3`'s row is absent by design —
   `coalfall-commission`) live at `apps/android/assets/demo-covers/*.png`, downscaled at
   build time by a Node ESM script under `scripts/`, declared in `pubspec.yaml`. `_startDemo`
   extracts them via `demoAssetLoader` into `$root/covers/{bookId}.png` at launch time — no
   runtime downscale. `buildDemoRuntime` itself stays cover-agnostic (keeps its existing
   `coversDir` disk-read); a `rootBundle` selector inside it would break the deliberately
   asset-free host widget tests.
7. **Demo-mode chrome only fires when `demoMode: true`.** The marketing capture's
   `runtimeOverride` path keeps `demoMode: false`, so its settings scene (full Server section
   visible) stays unchanged. Only the shipped `_startDemo` path renders the "Demo" badge and
   the settings-screen Server-section suppression.

## Test plan

### Automated coverage

- Widget (`apps/android/test/ui/home_page_demo_test.dart` or colocated) — tapping `try-demo`
  on "Not paired yet" runs the real `_startDemo` (injected `InMemoryFileStore` + fixed root +
  fake asset loader): asserts the demo library renders all **four** book tiles
  (`Key('book-hollow-tide-1')` … `hollow-tide-3`, `coalfall-commission`) and the
  `Key('demo-badge')`. Locks both the shipped control flow and the `offline: false`
  four-books contract.
- Widget — exit demo returns to "Not paired yet"; asserts the pairing store was never written
  (a spy store whose `save` was never called and whose `load()` is still `null`).
- Widget + unit (`apps/android/test/ui/demo_exit_cleanup_test.dart`, #1592) — the leak-safety
  disk cleanup. A full widget-driven exit deadlocks on runtime dispose while
  `LibraryHomeScreen` is mounted (`library.close()` blocks on the live `_refresh` stream), so
  `_exitDemo`'s cleanup half is extracted into a `deleteDemoRoot(fs, root)` seam and tested
  directly: drive the real `_startDemo` (which writes covers under the demo root), assert the
  footprint exists, then `deleteDemoRoot` removes it and the pairing store stays untouched.
  Plus unit cases for the null-root no-op and swallowed-delete-failure guards.
- Widget — in `demoMode`, `AppSettingsScreen` shows the demo badge / "Exit demo" wording and
  renders no Server section (no URL, no fingerprint, no "Paired since").
- Unit (`apps/android/test/demo/demo_ticking_audio_engine_test.dart`) —
  `DemoTickingAudioEngine`: position advances over pumped time; `positionStream` survives
  multiple concurrent subscribers (broadcast); `pause`/`seek`/`setSpeed` honored; `dispose`
  cancels the timer (no emissions after dispose).
- Unit — the cover-render script's pure helpers (source→`bookId` mapping, downscale target
  dimensions).
- Regression guard — the existing marketing capture keeps the posed `DemoAudioEngine` +
  `coversDir` path and `demoMode: false` (`test/demo/*`, `test/ui/*`, and
  `marketing_capture_test.dart` stay green with zero changes).

If any of the above lands short of this list at ship time, note the gap explicitly in Ship
notes rather than silently shipping without it.

### Manual acceptance walkthrough

On-device, via Android Studio, driving taps with adb `input tap` (the known emulator recipe —
no CDP). Run against a real device or emulator with the built app installed.

1. **Cold launch, unpaired** → "Not paired yet" screen shows a **"Try the demo"** button
   alongside "Pair a device."
2. **Enable airplane mode**, tap "Try the demo" → the demo library loads with **all four**
   books, covers rendered (three real covers + one placeholder tile for the
   not-downloaded `hollow-tide-3`), and the Continue-listening rail — with no network
   reachable.
3. Open a book, tap ▶ → the position timer **advances** (not frozen); pause, seek, and
   speed controls respond and change the on-screen state.
4. Confirm the persistent **"Demo" badge** in the library AppBar. Open Settings → no server
   URL, no cert fingerprint, no "Paired since" row; the unpair action reads **"Exit demo."**
5. Tap "Exit demo" → returns to "Not paired yet."
6. **Kill and relaunch** the app → still shows "Not paired yet" (no leaked paired session,
   confirming the keystore was never written).

## Out of scope

- Real demo audio playback — the demo produces no sound (`DemoTickingAudioEngine` advances a
  position timer; it does not decode/play audio). See the spec's Non-goals.
- Per-book distinct covers/audio, or any demo content beyond the existing four books.
- A demo entry inside the deeper `PairingScreen` host/code/fingerprint form — the affordance
  lives on the "Not paired yet" home screen only.
- Any change to the real pairing / sync / player paths.
- Updating an external Play-publishing runbook — no such file exists in this repo; the Play
  "Sign-in details" / Open-testing tracking lives in external project notes. This plan's
  release-notes entry (covering the "full access to all features" unblock) is the in-repo
  record of the change.

## Suggested follow-ups

- Reconcile demo-mode chrome (try-demo button, Demo badge, settings) with app-21 tablet
  adaptive UI (PR #1590) once it lands — verify 3 viewports + 44px touch targets.

## Ship notes

(Filled in when status flips to `stable`.)
