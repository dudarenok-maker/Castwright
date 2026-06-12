# Companion marketing screenshot capture (piece #1b) — design

**Status:** design (approved in brainstorm 2026-06-12)
**Sibling:** piece #1 (web marketing capture) — `docs/superpowers/specs/2026-06-12-demo-mode-marketing-capture-design.md`
**App:** `apps/android` (Flutter companion, plan 188)
**Branch:** `feat/app-companion-marketing-capture`

## Goal

A canonical, repeatable recipe that produces on-brand marketing screenshots of
the Android companion app, mirroring piece #1's web harness. Six screens ×
light + dark, driven from posed demo data (the fictional "The Hollow Tide"
series + the real "The Coalfall Commission"), with no paired server, no network,
and no real audio.

## Non-goals

- No production behaviour change beyond two additive, test-injectable seams and
  one genuinely-shippable feature (a dark theme).
- No real device-frame status bar (see Capture mechanism — we capture the
  Flutter surface only, by design).
- No live QR-scan glamour shot (an emulator camera renders black; we ship the
  pre-filled pairing form instead).
- No committed brand cover art (covers stay git-ignored and operator-supplied,
  exactly like piece #1).

## Decisions (locked in brainstorm)

| Decision | Choice | Why |
|---|---|---|
| Capture mechanism | `flutter drive` + `integration_test` + `binding.takeScreenshot()` | The only reliably-scriptable Flutter screenshot path; deterministic; one driven test does every scene × theme. |
| Status bar | None (Flutter surface only) | `takeScreenshot()` captures the Flutter surface; the system status bar is out of frame. Marketing crops it anyway. |
| Themes | Light **and** dark | Parity with the web set. Requires wiring a real `darkTheme` (a shippable feature, not just a capture artifact). |
| Pairing scene | Pre-filled review **form** | The pairing screen is a manual host/code/fingerprint form; the camera is a separate screen. The form is the achievable, realistic shot. |
| Covers | `adb push` downscaled 250×250 thumbs to the app's external files dir | No copyrighted art in `pubspec.yaml` assets; clean clones still build. |
| Demo-data seam | A `CompanionRuntime.demo()` factory wired from fakes, injected via a new `HomePage` test seam | Mirrors the codebase's existing `service`/`store`/`deepLinks` injection; screens run unmodified; dodges `AudioService.init()` and native audio. |

## Scenes (5)

> **Adversarial-review correction:** `PlayerScreen.build()` is a *single* screen —
> a chapter `ListView` plus a bottom transport bar (waveform/scrubber, position,
> skip, play/pause). There is **no** art-forward "now playing" screen and **no
> cover art on the player**. The earlier `player-now-playing` + `player-chapters`
> split was wrong; they are one shot. Marketing should expect a functional
> list-plus-transport, not a glamour now-playing screen.

| id | Screen | Posed state |
|---|---|---|
| `library-home` | `LibraryHomeScreen` | Author→series grid, "Continue listening" rail populated, per-book progress bars, mixed download states (downloaded · tap to listen / update-available / not-downloaded). |
| `player` | `PlayerScreen` | Chapter list with durations + current-chapter highlight, and the bottom transport showing the **waveform** (peaks supplied via the fake `HttpSend` — without them the bar degrades to a plain `Slider`), position, and play/pause. The capture step **taps the current chapter** so `_playing` (a local bool, not an engine stream) flips to the playing look. `DemoAudioEngine` reports a fixed position/duration (no ticking). |
| `settings` | `AppSettingsScreen` | Volume boost, paired-server info (URL / cert fingerprint / paired-since), sleep-timer + skip controls, posed defaults. Reads `runtime.settings` + `runtime.sleepTimer` + `server`. |
| `library-offline` | `LibraryHomeScreen` | Same library with the fake `HttpSend` returning 5xx on the manifest paths → `loadLibrary` throws → `loadLocalLibrary` fallback → "Offline" chip shown; only downloaded books appear (realistic offline shelf). |
| `pairing` | `PairingScreen` | Pre-filled review form (host:port, code, fingerprint tag) via a demo `initialQr`. |

Each scene is captured in `light` and `dark` → **10 PNGs**.

## Architecture

### Verified facts (grounding)

- **`ApiClient` is fully fakeable via an injected `HttpSend`**
  (`ApiClient(connection, {HttpSend? send})`). `getChapterPeaks`,
  `syncManifestIndex`, `bookDetail`, `getListenProgress` all route through
  `_send`. The default `_pinnedSend` builds a `SecurityContext` from `caPem`
  **at construction** (would crash on a fake cert) — but passing `send:`
  short-circuits it (`send ?? _pinnedSend`). So **one fake `HttpSend`** drives
  the manifest index, book details, the **waveform peaks** (no peaks →
  `WaveformBar` draws a bare `Slider`), and 404 listen-progress, with **zero
  TLS**. This is the spine of the demo runtime and replaces a separate
  `ManifestApi` fake (use `api.manifestApi`). `getBytes`/`pinnedRangeFetch`/
  `putListenProgress` build their own `SecurityContext` on call — the demo must
  never reach them (covers come from a `CoverFetcher` override; resume sync gets
  a no-op `ListenProgressApi`).
- `LibraryDatabase` supports an in-memory backing explicitly:
  `LibraryDatabase(NativeDatabase.memory())` (the production opener is
  `LibraryDatabase.open()`). No schema change, no drift codegen.
- `AudioEngine` is an injectable seam (`PlayerController(audioEngine: ...)`);
  the real `JustAudioEngine` is one impl. A `DemoAudioEngine` poses the player
  with no native audio.
- `PairingScreen` is a manual form (`_host`/`_code`/`_fpTag` controllers); the
  camera lives in a separate `QrScanScreen` behind a "Scan" button. `initialQr`
  pre-fills the form.
- `HomePage`/`AudiobookCompanionApp` already inject `service`, `store`,
  `deepLinks` for tests — we extend that pattern, we don't invent it.
- All Drift seeding methods exist on `DriftLocalLibrary`: `upsertBookMeta`,
  `recordChapterMeta` (sets `fingerprint` → counts as downloaded), `savePlayback`
  (resume point → progress bars + current-chapter highlight), `markPlayed`
  (`lastPlayedAt` → Continue rail), `setCoverThumbPath`. `loadLibrary` iterates
  the **manifest index** and computes download state from drift fingerprints — so
  every library book lives in the fake manifest; drift seeding picks its state
  (downloaded / update-available via an older drift `updatedAt` / not-downloaded =
  no seeded chapters).
- `ThumbnailCache` already downscales on-device (`resizeJpegToWidth`,
  package:image) → **no `sharp`/Node image lib needed**; push full-res covers.
- `PlayerScreen._playing` is a **local bool starting `false`** (not from
  `engine.playingStream`) — flipped only by tapping a chapter / play. The capture
  step taps to get the playing look; the waveform itself loads on `_prepare`.

### New files (all under `apps/android/`)

| File | Responsibility |
|---|---|
| `lib/src/demo/demo_data.dart` | Canonical companion demo content: the Hollow Tide series + Coalfall as the **JSON bodies the fake `HttpSend` returns** (manifest index, per-book details, per-chapter `{peaks:[...]}`) + the drift seed rows (books, chapters, playback). Mirrors the web fixtures' titles/authors/series (deliberate duplication — Dart can't import the TS fixtures). |
| `lib/src/demo/demo_http_send.dart` | `HttpSend demoHttpSend({bool offline})` — pattern-matches the request path: `/api/library/sync-manifest` → index JSON; `…?bookId=` → detail JSON; `/api/books/…/audio` → `{peaks}`; `/api/books/…/listen-progress` → 404; `/api/info` → version. When `offline`, the manifest paths return 503 (drives the offline scene). Replaces the separate `ManifestApi` fake. |
| `lib/src/demo/demo_audio_engine.dart` | `DemoAudioEngine implements AudioEngine`: `setFilePath`/`setStreamUrl`/`seek`/`play`/`pause` no-op; reports a fixed `duration`/`position`, `playing == true`, single-emit streams (`positionStream`/`playingStream`/`durationStream`), empty `completionStream`. No ticking. |
| `lib/src/demo/demo_pairing_store.dart` | `DemoPairingStore implements PairingStore`: returns a canned `PairedServer` + a non-empty (placeholder) `caPem` — never parsed into a `SecurityContext` because the demo `ApiClient` uses the injected send. |
| `lib/src/demo/demo_runtime.dart` | `Future<CompanionRuntime> buildDemoRuntime({bool offline})` — builds `ApiClient(demoConnection, send: demoHttpSend(offline))`, an in-memory `DriftLocalLibrary` (`LibraryDatabase(NativeDatabase.memory())`) seeded from `demo_data`, a `ThumbnailCache` whose `CoverFetcher` reads pushed cover bytes, `DemoAudioEngine`, a `ResumeSyncService` with a **no-op `ListenProgressApi`**, and inert `SleepTimer`/`audioHandler: null`/`_subs: []`. Constructs the real `CompanionRuntime` via a new `@visibleForTesting` factory exposed on it (the private `_` constructor stays). Skips connectivity/auto-sync/foreground/media-session. |
| `integration_test/marketing/scenes.dart` | Scene registry: one row per shot (`id`, builder/navigator, optional `offline` flag). The single source of truth, like `e2e/marketing/scenes.ts`. |
| `integration_test/marketing_capture_test.dart` | The driven test: for each scene × theme, pump `AudiobookCompanionApp` (demo store + injected demo runtime + forced `themeMode`), navigate, settle, `binding.takeScreenshot('<id>.<theme>')`. |
| `test_driver/integration_test.dart` | The `flutter drive` driver: `integrationDriver(onScreenshot: ...)` writes PNG bytes. **`flutter drive` runs with CWD `apps/android`** — the driver resolves the repo root (`../../`) and writes to `mockups/marketing-screens/companion/<name>.png`. |
| `integration_test/marketing/README.md` | The canonical recipe (AVD boot, cover push, run command, re-run guidance). |
| `scripts/capture-companion.mjs` | Orchestrator behind `npm run capture:companion`: verify an emulator is up, `adb push` the **full-res** brand covers to the app's external files dir (the on-device cache downscales — no Node image lib), run `flutter drive` once. Windows-aware (`flutter.bat` via `shell:true`). |

### Modified files (additive seams)

| File | Change |
|---|---|
| `lib/main.dart` | (a) Add a real `darkTheme` (`ColorScheme.fromSeed(seedColor: 0xFFA43C6C, brightness: Brightness.dark)`) + a `themeMode` param on `AudiobookCompanionApp` (defaults to `ThemeMode.system` in production — **a real, user-visible change**: dark-mode phones get the dark app on next release). (b) Add an injectable `CompanionRuntime? runtimeOverride` to `HomePage`; `_boot()` short-circuits **at the very top** — `if (runtimeOverride != null) { _paired = await store.load(); setState(() { _runtime = override; _loading = false; }); return; }` — before the `caPem`/`forConnection` path. Mirrors the existing `service`/`store`/`deepLinks` injection. No behaviour change when omitted. |
| `apps/android/pubspec.yaml` | Add `integration_test` to `dev_dependencies` if absent. **No** brand-cover assets. |
| `package.json` (root) | Add `capture:companion` script → `node scripts/capture-companion.mjs`. |
| `.gitignore` | Ensure `mockups/` (already ignored) covers `mockups/marketing-screens/companion/`. Confirm no demo cover art is tracked. |

### Data flow (capture run)

```
npm run capture:companion
  └─ scripts/capture-companion.mjs
       ├─ assert `adb devices` shows a booted emulator
       ├─ adb push <brand covers, full-res> → /sdcard/Android/data/<appId>/files/demo-covers/
       └─ flutter drive
            --driver=test_driver/integration_test.dart
            --target=integration_test/marketing_capture_test.dart
              └─ convertFlutterSurfaceToImage()  // once, before the first shot
                 for theme in [light, dark]:
                   for scene in scenes.dart:        // 5 scenes
                     pump AudiobookCompanionApp(
                       store: DemoPairingStore(),
                       runtimeOverride: await buildDemoRuntime(offline: scene.offline),
                       themeMode: theme,
                       audioHandler: null)        // no AudioService.init
                     navigate to scene (player scene taps the current chapter)
                     await settle (static — no ticking/animation)
                     binding.takeScreenshot('<scene.id>.<theme>')
            driver.onScreenshot writes →
              ../../mockups/marketing-screens/companion/<scene.id>.<theme>.png
```

The demo runtime's `CoverFetcher` reads cover bytes from the app's external
files dir (pushed above), so `getExternalStorageDirectory()` needs no runtime
permission; `ThumbnailCache` downscales them to 250px on-device.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| Constructing `ApiClient` with the **default** send parses `caPem` into a `SecurityContext` and **crashes on a fake cert** | The demo **always** passes `send: demoHttpSend(...)`, which short-circuits `_pinnedSend`. Resume sync gets a no-op `ListenProgressApi`; covers use a `CoverFetcher` — so `getBytes`/`pinnedRangeFetch`/`putListenProgress` (which build their own `SecurityContext`) are never reached. |
| `convertFlutterSurfaceToImage()` can leave subsequent frames black in a multi-shot test | Convert once, then pump a fresh widget tree per shot (documented Flutter multi-screenshot pattern). Fallback if frames blacken: one scene per test file (slower, bulletproof). Documented in README. |
| Running production `main()` would call `AudioService.init()` (native, flaky) | The test pumps `AudiobookCompanionApp` directly with `audioHandler: null` — never calls `main()`. |
| Player "playing" chrome doesn't appear | `_playing` is a local bool flipped by tapping a chapter / play — the `player` scene taps the current chapter before the shot. |
| Non-deterministic player frame (position ticking, waveform animation) | `DemoAudioEngine` emits a single fixed position and never ticks; verify `waveform_bar` has no implicit animation (the painter is static given fixed peaks+progress). |
| Cover read permission | Use `getExternalStorageDirectory()` (scoped, permission-free), not `/data/local/tmp`. |
| In-memory Drift needs the native `sqlite3` lib on device | Bundled transitively via `drift_flutter` → `sqlite3_flutter_libs` in the APK; available in `integration_test` (runs as the app). |
| Driver writes shots to the wrong tree | `flutter drive` CWD is `apps/android`; the driver resolves `../../mockups/...`. |
| Demo runtime must supply every field the 4 screens read | Build it against what they actually read (`sync`, `library`, `thumbnails`, `player`, `settingsStore`, `settings`, `sleepTimer`, `server`); pass inert real instances for the rest (`resumeSync` w/ no-op api, `foreground`, `audioHandler: null`, `_subs: []`). Confirm during impl by rendering each scene. |
| Dark theme exposes hardcoded colors **app-wide** (not just captured screens) | `themeMode: system` flips dark-mode users on next release → audit **all** screens (incl. pairing, QR scan, "not paired", bootstrap-error) for non-theme colors. The app is Material 3 `fromSeed`, so most adapt automatically. |
| Emulator/`flutter`/`adb` not on PATH on a clean box | README documents one-time setup; the script fails fast with a clear hint (mirrors piece #1's chromium hint). |

## Testing

This is capture tooling, not shipped UI — but two pieces carry real test value:

- **`darkTheme`** is a shippable feature: add a widget test asserting
  `AudiobookCompanionApp(themeMode: ThemeMode.dark)` resolves a dark
  `ColorScheme` (`Brightness.dark`) on a representative screen.
- **`demo_data` + `demoHttpSend`**: a unit test feeding `demoHttpSend` through a
  real `ApiClient` and asserting the round-trip is self-consistent — every index
  book resolves a detail, peaks parse, and `offline: true` makes the manifest
  paths throw `ApiException` — so the fixture can't silently rot as the manifest
  contract evolves.
- The existing companion test suite (`apps/android/test/**`) must stay green —
  the injected seams are additive and default-off.

## Effort note

Materially larger than piece #1: a demo runtime + fakes (`demoHttpSend`,
`DemoAudioEngine`, `DemoPairingStore`), a real dark theme, an `integration_test`
+ `flutter drive` driver, and the emulator/adb recipe. Five scenes × light/dark
= **10 PNGs**. Trims available if a faster v1 is wanted: light-only (halves the
shots, drops the app-wide dark audit) or drop `pairing` + `library-offline`
(3 scenes).

## Output

Git-ignored `mockups/marketing-screens/companion/<scene>.<theme>.png` — same
home and naming grammar as the web set.
