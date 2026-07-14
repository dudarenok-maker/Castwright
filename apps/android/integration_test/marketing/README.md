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

## Tablet & foldable surfaces (app-22)

The same demo runtime also drives three more capture passes, producing Play
Store marketing assets for the app-21 two-pane adaptive UI:

    npm run capture:companion:tablet7    # raw surfaces → mockups/marketing-screens/companion/tablet7/
    npm run capture:companion:tablet10   # raw surfaces → mockups/marketing-screens/companion/tablet10/
    npm run capture:companion:fold       # raw surfaces → mockups/marketing-screens/companion/fold/

Boot the matching AVD **before** running the script — it doesn't launch one
for you, same as `capture:companion`:

| Script | AVD |
|---|---|
| `capture:companion:tablet7` | a 7" tablet profile (e.g. `Nexus 7`) |
| `capture:companion:tablet10` | the Pixel Tablet AVD |
| `capture:companion:fold` | the Pixel Fold AVD |

The Pixel Tablet and Pixel Fold AVDs already exist from app-21. The 7" AVD is
new — create it once with the same recipe used for those (adjust the API
level/image to whatever the box already has installed):

    # JAVA_HOME must point at Android Studio's bundled JBR (JDK 21) — avdmanager
    # ships against that JDK, not a standalone JRE.
    export JAVA_HOME="/path/to/Android Studio/jbr"   # or the JDK21 dir on Windows
    avdmanager create avd \
      -n Nexus_7_API_34 \
      -k "system-images;android-34;google_apis;x86_64" \
      -d "Nexus 7"

Confirm with `flutter emulators` / `adb devices` as usual once it's booted.

### What each pass captures

Each tablet script runs **two `flutter drive` passes** against the booted AVD:
a **landscape** pass for the four scenes that need the two-pane layout
(`library-home`, `player`, `book-detail`, `library-offline` — the two-pane
shell only renders at `≥840` dp, which only landscape clears on these AVDs),
then a **portrait** pass for `settings`/`pairing` (single-pane on any size, so
no orientation flip is needed for those two). `capture:companion:fold`
captures **only the half-open seam** shot (`library-home`, one scene) — the
*unfolded* fold marketing assets are **not** separately captured; the framing
step (`npm run frame:play`) reframes the `tablet10` landscape raws into a
fold bezel template instead, since unfolded-Fold and landscape-Pixel-Tablet
render pixel-identically.

Before each pass the script sets rotation via adb:

    adb shell settings put system accelerometer_rotation 0
    adb shell settings put system user_rotation <N>   # N derived per device

**The `user_rotation` value is device-specific**, because "which rotation is
landscape" depends on the device's *natural* orientation. Natural-portrait
devices (phones, the **Nexus 7**) reach landscape at `user_rotation 1`; the
**Pixel Tablet is natural-landscape**, so landscape is `user_rotation 0` and 1
would rotate it *into* portrait (the app-side `expanded` guard then rejects the
pass). The script reads the natural orientation once from `adb shell wm size`
(`Physical size: WxH` — reported in the natural orientation regardless of the
current rotation) and picks the correct index automatically; you don't set it
by hand. It restores `accelerometer_rotation 1` afterwards (in a `finally`, so a
failed pass doesn't leave the AVD rotation-locked for the next one).

### Fold posture

The half-open seam pass needs the AVD's **posture (device_state) index for
`HALF_OPENED`** — this index is box-specific (it comes from whatever
`device_states.textproto` config the emulator ships), so never hardcode it.
Before your first fold capture on a given box, find it once:

    adb shell cmd device_state print-states

Look for the entry named `HALF_OPENED` and note its `identifier`. The script
auto-detects it from that same `print-states` output; if auto-detection ever
fails (unexpected output format, or you want to be explicit), set it yourself:

    FOLD_HALF_OPEN_STATE=1 npm run capture:companion:fold

After the seam shot, the script resets posture with
`adb shell cmd device_state state reset`.

### Fail-loud guards

Two hard assertions turn "the rotation/posture command silently didn't take"
into a failed test, instead of a wrong-looking-but-passing screenshot:

- **Landscape passes** assert the window actually reads as `expanded`
  (`windowSizeClassFor(width) == WindowSizeClass.expanded`) before the first
  shot. If this fails, it means `adb ... user_rotation` didn't actually
  rotate the AVD — it is **not** a code bug in the two-pane layout itself.
- **The fold seam pass** asserts a vertical fold/hinge `DisplayFeature` is
  present before the first shot. If this fails, the `device_state` posture
  index didn't take (wrong index, or the AVD reset to flat `OPENED`) — again,
  not a layout bug.

If either fires, re-check the adb commands above ran against the right
booted device (`adb devices`) rather than debugging the Flutter layout code.

### Output

Raw captures land under `mockups/marketing-screens/companion/<tablet7|tablet10|fold>/`
(git-ignored, mirroring the flat phone raws). `npm run frame:play` now emits
framed Play-ready assets for every surface, light + dark:

- `screenshots/tablet-7/` — 2560×1600 landscape / 1600×2560 portrait
- `screenshots/tablet-10/` — same dimensions, Pixel Tablet raws
- `screenshots/fold/` — foldable-bezel template, reusing `tablet-10` landscape
  raws for the four unfolded scenes plus the dedicated half-open seam shot

alongside the existing `screenshots/phone/` set, all under `brand/` (git-ignored).

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
