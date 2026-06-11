---
title: Companion pairing — ML Kit decoder + deep-link readiness (app-only); launch flip = app-17
date: 2026-06-11
status: draft
scope: app, docs
supersedes-on-device: 2026-06-10-pairing-qr-redesign (the "shrink the QR" fix did not address the root cause)
defers: app-17 (#729) — server QR→URL flip + host assetlinks.json at the castwright.ai launch
---

# Pairing QR — ML Kit decoder + deep-link readiness

## Problem

The companion app cannot pair. On a real device (Android 16 / API 36) the in-app QR
scanner **does not decode the desktop pairing QR at all** — not from the live camera,
not from a static gallery screenshot.

Root cause, confirmed (not assumed):

- The desktop emits a **valid** `CWP1*host:port*code*fpTag` QR — an independent
  decoder (OpenCV) read it cleanly from 8/8 video frames:
  `CWP1*192.168.86.20:8443*8N3T59HV*27XZYE1RRV3A8Y4P`.
- The phone runs the **current** APK (built 2026-06-11 08:16, redesign included).
- `libflutter_zxing.so` **is** bundled for `arm64-v8a` — not a missing-native-lib issue.
- `flutter_zxing` (zxing-cpp via FFI) simply **fails to decode** this QR on this device
  — a documented zxing weakness ("unreliable on newer devices; low recognition rates
  for smaller barcodes; can fail to decode altogether").

The prior fix (PR #696) shrank the QR on the theory that *density* was the cause. It
was not — the decoder library is (zxing is actually *worse* at smaller codes). The
redesign was never verified on a real device ("OWED on-device acceptance"); the user's
screen recording is that verification, arriving late and failing.

## Goals

1. **Fix pairing now**, on a real Android 16 device, **LAN-only** — no dependency on
   any public infrastructure.
2. **Make the app fully deep-link-ready now** so the launch is a small, well-understood
   flip (server payload → URL + host `assetlinks.json`), not another app change.

## Decisions (reviewed 2026-06-11)

- **App-only change; QR stays `CWP1`/v3.** The server keeps emitting `CWP1*…` for now.
  The app ships the URL parser + deep-link plumbing so it's *ready*, but we do **not**
  re-densify the live QR (URL would be v5/37×37 vs CWP1 v3/29×29) for users who can't
  use the deep-link until launch anyway. The server payload flip moves to app-17.
- **Set up release signing now.** App Link verification pins the signing-cert SHA-256;
  a debug-signed (per-machine) alpha can't be pinned. The signing wiring already exists
  (app-11: `key.properties` → real key, debug fallback). This change makes it real and
  records the SHA for app-17.
- **Skip a pre-build decoder spike.** Commit to ML Kit; prove it at on-device
  acceptance. The decoder sits behind an injectable seam, so a pivot (→ `zxing2` /
  manual-only) is a one-file change if it NPEs.

## Scope: `apps/android`

### 1. Decoder swap (the fix)
- Remove `flutter_zxing`; add `google_mlkit_barcode_scanning` + `image_picker`.
- Decode a **still image** (camera capture or gallery pick) via
  `BarcodeScanner.processImage` — never the live-camera widget that NPE'd on API 36.
- **UX (v1):** tap-to-capture. *Scan QR* → camera or gallery → it decodes and fills the
  pairing form for review. One extra tap on a once-per-device flow, traded for
  reliability and zero live-camera lifecycle risk.
- **Decoder seam (testability + pivot insurance):**
  `typedef BarcodeDecoder = Future<List<String>> Function(String imagePath);`
  injected into the scan screen (defaults to ML Kit). Isolates the untestable native
  call so decode→parse→pop/error logic is unit-testable with a fake — and makes a
  decoder swap trivial if ML Kit fails on-device.

### 2. Deep-link readiness (dormant until app-17)
- **`PairingQr`:** parse the **URL** form (`Uri.parse` → `queryParameters` `h`/`c`/`f`)
  *and* keep the **`CWP1`** form (the live QR today). Same `{hostPort, code, fpTag}`
  output + empty-field validation.
- **`app_links`:** handle an incoming `https://castwright.ai/pair?…` intent on **cold
  start and warm resume** → reuse the same `PairingQr` → `PairingService.pair()` path.
  Inert today (no URL QR, no verification); unit-testable via a fake link stream;
  on-device testable pre-hosting via `adb shell am start -a android.intent.action.VIEW`.
- **Manifest:** add the `autoVerify` App Link intent-filter (scheme `https`, host
  `castwright.ai`, path `/pair`). Harmless while unverified. Package = `ai.castwright`.
- **Already-paired / malicious-link handling:** an incoming link when already paired
  routes to the same review-before-pair form (no silent re-pair). A link still requires
  a valid **single-use, short-lived code** + matching **fpTag** to redeem — same threat
  model as scanning a QR; a forged link without a live code fails at `/api/pair/redeem`.

### 3. Release signing (operational, now)
- Wiring already present (app-11). Steps: **user** runs `keytool` to create a keystore +
  `android/key.properties` (both git-ignored — already covered by `android/.gitignore`).
  Build a release APK → release-signed. **Record the cert SHA-256** (`keytool -list`)
  into app-17 (#729) for the future `assetlinks.json`. I provide the exact commands; I
  do not generate or store the secrets.

### 4. Platform must-verifies (gates, not assumptions)
- **16 KB page alignment (Android 15+/16):** confirm `google_mlkit_barcode_scanning` +
  `image_picker` ship 16 KB-aligned native libs (the project already fights this for
  `flutter_secure_storage`). Misalignment → libs fail to load on the Android 16 device.
- **Plugin compat:** ML Kit may bump AGP / Play Services — confirm no conflict with
  `drift` / `audio_service` / `flutter_foreground_task`, and `flutter build apk` is green.
- **APK size:** note the ML Kit bundled-model delta (~few MB, no Play Services download).

### Unchanged
- `pairing_service.dart` handshake, `pairing_screen.dart` manual-entry form (the
  always-works floor), server, frontend, and the `CWP1` QR + its density test.

## Testing

- **Unchanged & green:** `pairing_service_test.dart`.
- **`pairing_qr_test.dart` (extended):** parses the URL form (with/without URL-encoded
  `:`); still parses `CWP1`; rejects malformed/empty.
- **Scan-screen logic (new, fake `BarcodeDecoder`):** valid string → pops `PairingQr`;
  non-pairing string → no pop + error; `[]` → no pop + error.
- **Deep-link handler (new, fake `app_links` stream):** pair URL → parse→pair path; a
  non-pair URL ignored.
- **On-device acceptance — HARD GATE (the step this bug existed for lack of):** build the
  **release-signed** APK, install on the real Android 16 device, **in-app scan** the live
  `CWP1` desktop QR → pairs end-to-end. Plus an `adb`-simulated VIEW intent → pairs
  (proves the deep-link handler pre-hosting). If ML Kit NPEs here → pivot the
  `BarcodeDecoder` impl; do not ship without this gate green.

## Caveats (post-launch, for app-17)
- **Already-installed apps don't retroactively verify** App Links when `assetlinks.json`
  first appears — only new installs / update / reboot / `pm verify-app-links` do.
- The pre-launch "stock camera hits a dead browser page" risk **does not apply here** —
  the QR stays `CWP1` (not a URL) until the app-17 launch flip, by which point
  `assetlinks.json` is hosted.

## Deferred & filed: app-17 (#729)
- Flip the server `/session` payload to `https://castwright.ai/pair?h=…&c=…&f=…`
  (re-anchor `pairing-qr-density.test.ts`: rationale shifts from zxing → ML Kit/stock-
  camera scannability; v5 is comfortably fine).
- Host `/.well-known/assetlinks.json` pinning `ai.castwright` + the release-signing
  SHA-256 recorded in this change.
- Optional minimal `/pair` fallback page.
- On-device: **stock camera** auto-opens the app post-hosting.
</content>
