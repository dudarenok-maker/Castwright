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

## Scenes (6)

| id | Screen | Posed state |
|---|---|---|
| `library-home` | `LibraryHomeScreen` | Author→series grid, "Continue listening" rail populated, per-book progress bars, mixed download states (downloaded · tap to listen / update-available / not-downloaded). |
| `player-now-playing` | `PlayerScreen` | Mid-chapter: cover art, waveform with progress, transport, speed pill. Posed `DemoAudioEngine` (playing chrome, fixed position, no ticking). |
| `player-chapters` | `PlayerScreen` chapter picker | Chapter rows with durations, current-chapter highlight. |
| `settings` | `AppSettingsScreen` | Storage cap / default speed / sleep timer, posed defaults. |
| `library-offline` | `LibraryHomeScreen` | Same library with the demo manifest forced to throw → "Offline" chip shown; only downloaded books appear (realistic offline shelf). |
| `pairing` | `PairingScreen` | Pre-filled review form (host:port, code, fingerprint tag) via a demo `initialQr`. |

Each scene is captured in `light` and `dark` → **12 PNGs**.

## Architecture

### Verified facts (grounding)

- `ManifestApi` is a 2-method seam: `index({String? since})`,
  `bookDetail(String bookId)` — both return plain data classes
  (`SyncManifestIndex`, `SyncManifestBookDetail`). Trivially fakeable.
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

### New files (all under `apps/android/`)

| File | Responsibility |
|---|---|
| `lib/src/demo/demo_data.dart` | Canonical companion demo content: the Hollow Tide series + Coalfall as `SyncManifestIndex` + per-book `SyncManifestBookDetail` + the drift seed rows (books, chapters, playback). Mirrors the web fixtures' titles/authors/series (deliberate duplication — Dart can't import the TS fixtures). |
| `lib/src/demo/demo_manifest_api.dart` | `DemoManifestApi implements ManifestApi`, returns `demo_data`'s index/details. A `bool offline` flag makes `index()`/`bookDetail()` throw (drives the offline scene). |
| `lib/src/demo/demo_audio_engine.dart` | `DemoAudioEngine implements AudioEngine`: `setFilePath`/`setStreamUrl` no-op; reports a fixed `duration`/`position`, `playing == true`, empty completion stream. No ticking. |
| `lib/src/demo/demo_pairing_store.dart` | `DemoPairingStore implements PairingStore`: returns a canned `PairedServer` + a non-empty `caPem` so boot takes the offline-capable branch. |
| `lib/src/demo/demo_runtime.dart` | `Future<CompanionRuntime> buildDemoRuntime({bool offline})` — wires the fakes + an in-memory `DriftLocalLibrary`, seeds it from `demo_data`, and a demo `ThumbnailCache.fetch` that reads pushed cover bytes. Constructs the real `CompanionRuntime` via a new package-private/exposed constructor path (the `_` constructor stays; add a thin `@visibleForTesting` factory or widen it for demo use). Skips connectivity/auto-sync/foreground/media-session. |
| `integration_test/marketing/scenes.dart` | Scene registry: one row per shot (`id`, builder/navigator, optional `offline` flag). The single source of truth, like `e2e/marketing/scenes.ts`. |
| `integration_test/marketing_capture_test.dart` | The driven test: for each scene × theme, pump `AudiobookCompanionApp` (demo store + injected demo runtime + forced `themeMode`), navigate, settle, `binding.takeScreenshot('<id>.<theme>')`. |
| `test_driver/integration_test.dart` | The `flutter drive` driver: `integrationDriver(onScreenshot: ...)` writes PNG bytes to `mockups/marketing-screens/companion/<name>.png`. |
| `integration_test/marketing/README.md` | The canonical recipe (AVD boot, cover push, run command, re-run guidance). |
| `scripts/capture-companion.mjs` | Orchestrator behind `npm run capture:companion`: verify an emulator is up, downscale brand covers → temp (sharp), `adb push` to the app's external files dir, run `flutter drive` once. Windows-aware (`flutter.bat` via `shell:true`). |

### Modified files (additive seams)

| File | Change |
|---|---|
| `lib/main.dart` | (a) Add a real `darkTheme` (`ColorScheme.fromSeed(seedColor: 0xFFA43C6C, brightness: Brightness.dark)`) + a `themeMode` param on `AudiobookCompanionApp` (defaults to `ThemeMode.system` in production). (b) Add an injectable `CompanionRuntime? runtimeOverride` to `HomePage`; when present, `_boot()` uses it instead of building one from the connection. Mirrors the existing `service`/`store`/`deepLinks` injection. No behaviour change when the new params are omitted. |
| `apps/android/pubspec.yaml` | Add `integration_test` to `dev_dependencies` if absent. **No** brand-cover assets. |
| `package.json` (root) | Add `capture:companion` script → `node scripts/capture-companion.mjs`. |
| `.gitignore` | Ensure `mockups/` (already ignored) covers `mockups/marketing-screens/companion/`. Confirm no demo cover art is tracked. |

### Data flow (capture run)

```
npm run capture:companion
  └─ scripts/capture-companion.mjs
       ├─ assert `adb devices` shows a booted emulator
       ├─ sharp: brand covers → 250×250 → temp/
       ├─ adb push temp/*.png → /sdcard/Android/data/<appId>/files/demo-covers/
       └─ flutter drive
            --driver=test_driver/integration_test.dart
            --target=integration_test/marketing_capture_test.dart
              └─ for theme in [light, dark]:
                   for scene in scenes.dart:
                     pump AudiobookCompanionApp(
                       store: DemoPairingStore(),
                       runtimeOverride: buildDemoRuntime(offline: scene.offline),
                       themeMode: theme,
                       audioHandler: null)        // no AudioService.init
                     navigate to scene
                     await settle (static — no ticking/animation)
                     binding.takeScreenshot('<scene.id>.<theme>')
            driver.onScreenshot writes →
              mockups/marketing-screens/companion/<scene.id>.<theme>.png
```

The demo runtime reads cover bytes from the app's external files dir (pushed
above) via the demo `ThumbnailCache.fetch`, so `getExternalStorageDirectory()`
needs no runtime permission.

## Risks & mitigations

| Risk | Mitigation |
|---|---|
| `takeScreenshot()` on Android needs `convertFlutterSurfaceToImage()` | Call it once in the test before the first screenshot (standard Flutter recipe). Documented in README. |
| Running production `main()` would call `AudioService.init()` (native, flaky) | The test pumps `AudiobookCompanionApp` directly with `audioHandler: null` — never calls `main()`. |
| Non-deterministic player frame (position ticking, waveform animation) | `DemoAudioEngine` emits a single fixed position and never ticks; verify `waveform_bar` has no implicit animation, disable if present. |
| Cover read permission | Use `getExternalStorageDirectory()` (scoped, permission-free), not `/data/local/tmp`. |
| `AppSettingsScreen`/`PlayerScreen` read runtime fields the demo factory skips | Build `demo_runtime` against what those four screens actually read (`sync`, `library`, `thumbnails`, `player`, `settingsStore`, `settings`); pass inert real instances for the rest (`resumeSync`, `sleepTimer`, `foreground`, `audioHandler: null`, `_subs: []`). Confirm during impl by rendering each scene. |
| Dark theme exposes hardcoded colors | Audit the four screens for non-theme colors during the dark visual check; the app is Material 3 `fromSeed`, so most adapt automatically. |
| Emulator/`flutter`/`adb` not on PATH on a clean box | README documents one-time setup; the script fails fast with a clear hint (mirrors piece #1's chromium hint). |

## Testing

This is capture tooling, not shipped UI — but two pieces carry real test value:

- **`darkTheme`** is a shippable feature: add a widget test asserting
  `AudiobookCompanionApp(themeMode: ThemeMode.dark)` resolves a dark
  `ColorScheme` (`Brightness.dark`) on a representative screen.
- **`demo_data` + `DemoManifestApi`**: a unit test asserting the index/detail
  shapes are self-consistent (every index book has a detail; chapter `uuid`s in
  playback exist) so the fixture can't silently rot as the manifest contract
  evolves.
- The existing companion test suite (`apps/android/test/**`) must stay green —
  the injected seams are additive and default-off.

## Effort note

Materially larger than piece #1: a demo runtime + four fakes, a real dark
theme, an `integration_test` + `flutter drive` driver, and the emulator/adb
recipe. Trims available if a faster v1 is wanted: light-only (halves the shots,
drops the dark audit) or drop `pairing` + `library-offline` (4 scenes).

## Output

Git-ignored `mockups/marketing-screens/companion/<scene>.<theme>.png` — same
home and naming grammar as the web set.
