# Companion marketing screenshot capture (piece #1b)

Produces `mockups/marketing-screens/companion/<scene>.<theme>.png` — 5 scenes
(`library-home`, `player`, `settings`, `library-offline`, `pairing`) × light+dark
= 10 PNGs. Sibling of the web capture (piece #1). Posed demo data: the fictional
"The Hollow Tide" series + the real "The Coalfall Commission". No server, no
network, no real audio.

## One-time setup

1. Flutter + Android SDK on PATH; `adb` available.
2. A booted emulator (AVD). e.g.:
   - `flutter emulators` to list, `flutter emulators --launch <id>` to boot, or
   - Android Studio → Device Manager → ▶.
   Confirm with `adb devices` (one `emulator-xxxx  device`).
3. Brand covers in `brand/book-covers/` (git-ignored). The script pushes them to
   the app's external files dir; the app downscales them on-device. Filenames
   must match the `bookId`s in `lib/src/demo/demo_data.dart`:
   `hollow-tide-1.png`, `hollow-tide-2.png`, `hollow-tide-3.png`,
   `coalfall-commission.png`. Rename copies if needed.

## Run

From the repo root:

    npm run capture:companion

This pushes the covers and runs `flutter drive` once. Shots land in
`mockups/marketing-screens/companion/`.

## When features change

Add a screen → add a `Scene` to `integration_test/marketing/scenes.dart` and (if
it needs navigation) a branch in `integration_test/marketing_capture_test.dart`.
Re-run the capture. Update the demo content in `lib/src/demo/demo_data.dart`.

## Notes / troubleshooting

- **Black screenshots:** Android replaces the live surface on
  `convertFlutterSurfaceToImage()`. If frames come back black, split the capture
  into one scene per `testWidgets` (each converts + shoots once).
- **No status bar:** by design — `takeScreenshot()` captures the Flutter surface
  only. Crop/compose externally if a device frame is wanted.
- **App ID:** the push target uses the `applicationId` (`ai.castwright`) from
  `android/app/build.gradle`; keep `scripts/capture-companion.mjs` in sync if it
  changes.
