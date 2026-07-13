# Companion marketing screenshot capture (piece #1b)

Two-step pipeline for the Google Play listing assets:

1. **Capture** — `npm run capture:companion` drives the app through the demo
   runtime and writes the raw Flutter surfaces to
   `mockups/marketing-screens/companion/<scene>.<theme>.png`.
2. **Frame** — `npm run frame:play` composes those raws into Play-ready assets
   under `brand/go-to-market/play-store/` (see "Framing" below).

Six scenes × light + dark = 12 raw PNGs. Posed demo data: the fictional "The
Hollow Tide" series + the real "The Coalfall Commission" (`lib/src/demo/`). No
server, no network, no real audio.

## Scenes

Every scene drives the **real wired surface** through the demo runtime so cover
art, download states, progress bars and the player waveform all render (a
posed-pump screen can't load covers, so we don't use those for marketing):

| Scene | Surface | Shows |
|---|---|---|
| `library-home` | `LibraryHomeScreen` | hero: Continue-listening rail + series-grouped library + covers + download states |
| `player` | player, The Drowning Bell | listening: cover, 7-chapter list, **waveform** in the docked player |
| `book-detail` | player, The Coalfall Commission | a second book opened at its resume point |
| `library-offline` | `LibraryHomeScreen` (offline) | the offline chip + only-downloaded books |
| `settings` | `SettingsScreen` | playback + sync/download prefs + paired server |
| `pairing` | `PairingScreen` | pair-to-your-own-server QR/manual form |

The player waveform renders because `buildDemoRuntime` seeds `demoPeaks` for
every chapter (`savePeaks`) — `peaksFor` is local-first, so without the seed it
falls back to an async server fetch that may not resolve before `takeScreenshot`.

## One-time setup

1. Flutter + Android SDK on PATH; `adb` available.
2. A booted emulator (AVD). e.g.:
   - `flutter emulators` to list, `flutter emulators --launch <id>` to boot, or
   - Android Studio → Device Manager → ▶.
   Confirm with `adb devices` (one `emulator-xxxx  device`).
3. Brand covers in `brand/book-covers/` (git-ignored). The script pushes them to
   `/data/local/tmp/demo-covers`; the app downscales them on-device. Filenames
   must match the `bookId`s in `lib/src/demo/demo_data.dart`:
   `hollow-tide-1.png`, `hollow-tide-2.png`, `hollow-tide-3.png`,
   `coalfall-commission.png`.
4. Playwright chromium (for the framing step): `npx playwright install chromium`.

## Run

From the repo root:

    npm run capture:companion   # raw surfaces → mockups/marketing-screens/companion/
    npm run frame:play          # framed assets → brand/go-to-market/play-store/

## Framing (`scripts/frame-play-screenshots.mjs`)

Composes each raw surface onto a Google-Play canvas in **headless chromium**
(Playwright), not sharp/librsvg — the brand caption font (General Sans, woff2)
renders via CSS `@font-face` in a browser but silently falls back to monospace
in librsvg. Fonts and the raw screenshots are inlined as `data:` URIs, and every
output's dimensions are asserted with sharp before the run is declared green.

Outputs (`brand/` is git-ignored — these are local-only brand assets):

- `screenshots/phone/<NN>-<id>.png` — 1764×3136, 9:16 — the **light** set (primary)
- `screenshots/phone/dark/<NN>-<id>.png` — 1764×3136 — the **dark** alternates
- `feature-graphic.png` — 1024×500

The curated order + caption per scene lives in the `SCENES` array at the top of
the script. Recommended upload order (hero first): `library-home` → `player` →
`book-detail` → `library-offline` → `pairing` → `settings`.

## When features change

Add a screen → add a `Scene` to `integration_test/marketing/scenes.dart` and (if
it needs navigation) a branch in `integration_test/marketing_capture_test.dart`,
plus an entry in the `SCENES` array in `scripts/frame-play-screenshots.mjs`.
Re-run both steps. Update the demo content in `lib/src/demo/demo_data.dart`.

## Notes / troubleshooting

- **Black screenshots:** Android replaces the live surface on
  `convertFlutterSurfaceToImage()`. If frames come back black, split the capture
  into one scene per `testWidgets` (each converts + shoots once).
- **`pumpAndSettle` hangs:** a scene with a perpetual animation (e.g. a
  `CircularProgressIndicator` for an in-progress download) never settles and
  times out the whole run. Don't pose an infinite-spinner state for capture.
- **No status bar:** by design — `takeScreenshot()` captures the Flutter surface
  only. The framing step composites the device frame that replaces it.
- **App ID:** the push target uses the `applicationId` (`ai.castwright`) from
  `android/app/build.gradle`; keep `scripts/capture-companion.mjs` in sync if it
  changes.
