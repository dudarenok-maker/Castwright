---
status: active
shipped: null
owner: dudarenok
---

# 208 — Companion pairing: live ML Kit camera + deep-link readiness

> Status: active (on-device confirmed 2026-06-12; PR open, not yet merged)
> Key files: `apps/android/lib/src/ui/qr_scan_screen.dart`, `apps/android/lib/src/domain/pairing_qr.dart`, `apps/android/lib/main.dart`, `apps/android/android/app/build.gradle.kts`, `apps/android/android/app/src/main/AndroidManifest.xml`
> URL surface: in-app pairing screen; future App Link `https://castwright.ai/pair?h=&c=&f=` (dormant until app-17)
> OpenAPI ops: none (uses existing `POST /api/pair/{session,redeem}`)

## Benefit / Rationale

- **User:** the companion app actually pairs on a real Android 16 phone again. Point the live camera at the desktop QR and it reads it; a "Choose a screenshot" gallery fallback covers awkward angles; manual entry remains the floor.
- **Technical:** removes the dead `flutter_zxing` decoder (zxing-cpp could not decode the QR off a screen on newer devices) and the R8 minification gap that crashed ML Kit in release builds. One ML Kit (`mobile_scanner`) serves both live frames and the gallery still.
- **Architectural:** ships the app side of the deep-link experience (URL `PairingQr` parser + `app_links` cold/warm handler + `autoVerify` intent-filter) so the stock-camera path is a pure ops flip at launch (app-17 / #729). No server/frontend change — the live `CWP1` QR is unchanged.

## What happened (root-cause arc)

The 2026-06-10 "shrink the QR" redesign (PR #696) never got on-device acceptance and **failed it** here:

1. **`flutter_zxing` cannot decode the QR on this device, full stop** — confirmed: OpenCV decoded the same image from the user's video frames instantly (8/8), `libflutter_zxing.so` was bundled for arm64, and gallery-import of a clean static screenshot *also* failed. zxing-cpp is a weak decoder on newer devices; shrinking made it worse (zxing is worse at small codes), so density was never the cause.
2. Swapped to **Google ML Kit** still-image decode → it **NPE'd** on-device: `NullPointerException: …getClass() on a null object reference` inside an `r8-map`-obfuscated `processImage`. Root cause: **R8 minification stripped ML Kit's reflection targets** in the release build (`google_mlkit_barcode_scanning` ships no consumer ProGuard rules). `flutter_zxing` was fine under R8 because it's C++/FFI (no reflection). **Fix: disable `isMinifyEnabled` + `isShrinkResources` for release.**
3. With R8 off, ML Kit ran — but a **single still photo of a screen QR is finicky** (focus/glare/moiré). Switched to a **live `mobile_scanner` (ML Kit) camera** that decodes continuous frames. This works on-device, and proves the *original* mobile_scanner "API-36 NPE" that drove the flee-to-zxing was **also just R8** all along.

## Architectural impact

- **New seams:** `BarcodeDecoder`/`PickImage` typedefs + `liveCamera` flag on `QrScanScreen` (injectable for tests); `Stream<Uri>? deepLinks` on `AudiobookCompanionApp`/`HomePage` (injectable App Links source).
- **Invariants preserved:** the pairing handshake (`PairingService`: fetch CA → verify 80-bit fingerprint tag → redeem code → token) and the `CWP1*host:port*code*fpTag` QR payload are unchanged. Manual entry unchanged.
- **Migration:** none. `PairingQr.parse` now also accepts the future `https://castwright.ai/pair?h=&c=&f=` URL (forward-compat) while still parsing `CWP1`.
- **Reversibility:** the decoder lives behind `BarcodeDecoder`; re-enabling R8 later requires ML Kit keep rules (`-keep class com.google.mlkit.** { *; }` + the gms internal barcode package). Disabling minify is the certain alpha fix; tuning keep rules to reclaim APK size (~+12 MB) is a follow-up.

## Invariants to preserve

- `PairingQr.parse` (`apps/android/lib/src/domain/pairing_qr.dart`) accepts **both** `CWP1*…` and `https://…/pair?h=&c=&f=`; empty/missing field → `FormatException`.
- Release build keeps `isMinifyEnabled = false` / `isShrinkResources = false` (`apps/android/android/app/build.gradle.kts`) until ML Kit keep rules are added — otherwise the scanner NPEs at runtime.
- `QrScanScreen` keeps the `errorBuilder` → gallery-fallback path so a camera-start failure degrades gracefully instead of crashing.
- `HomePage` cancels `_deepLinkSub` in `dispose` and de-dupes the cold-start link (`_lastHandledLink`).
- Manifest declares both `CAMERA` (live preview) and the `autoVerify` `castwright.ai/pair` intent-filter.

## Test plan

### Automated coverage

- `apps/android/test/domain/pairing_qr_test.dart` — parses `CWP1` + the URL form (raw + percent-encoded colon); rejects malformed/empty.
- `apps/android/test/ui/qr_scan_screen_test.dart` — gallery path via injected `BarcodeDecoder`/`PickImage` (`liveCamera: false`): valid QR pops a `PairingQr`; non-pairing barcode → error + stays open; no barcode → error; cancel → no-op.
- `apps/android/test/ui/pairing_screen_initial_qr_test.dart` — `initialQr` pre-fills host/code/fingerprint.
- `apps/android/test/main_deep_link_test.dart` — a pair deep link opens a pre-filled pairing screen; a non-pair link is ignored.
- `apps/android/test/widget_test.dart` — app-shell test injects `Stream<Uri>.empty()` to avoid the App Links platform channel.
- The live `mobile_scanner` preview is platform-only — not unit-testable; covered by the on-device walkthrough below.
- Whole suite: **211 tests green** (`cd apps/android && flutter test`).

### Manual acceptance walkthrough (on-device — the hard gate)

Run the desktop in LAN-HTTPS (`npm run build && npm run start:lan`), open **Pair a device**.

1. Install the release APK: `adb install -r companion\castwright-companion.apk`. → installs (debug-signed for alpha; release signing deferred to app-17).
2. App → **Pair a device → Scan QR** → grant camera. → **live camera preview** shows.
3. Point at the desktop QR. → decodes, fills the form, pairs; app reaches the library. **(Confirmed 2026-06-12 on a real Android 16 device.)**
4. If the camera can't start → "Camera preview unavailable — use Choose a screenshot below" (no crash); the gallery + manual paths still pair.
5. Deep-link handler (pre-hosting): `adb shell am start -W -a android.intent.action.VIEW -d "https://castwright.ai/pair?h=<lan-ip>:8443&c=<fresh-code>&f=<fpTag>" ai.castwright` → opens the pre-filled pairing screen.

## Deferred — app-17 (#729)

The launch flip (gated on the `castwright.ai` public launch): flip the server `/session` payload to the `https://…/pair` URL, host `/.well-known/assetlinks.json` pinning `ai.castwright` + the release-signing SHA-256, and establish the **release keystore** (deferred from this change per decision 2026-06-11 — pairing works debug-signed; the SHA is only needed once the domain serves `assetlinks.json`). Then the stock camera auto-opens the app from the same QR with no rebuild.

## Ship notes

- Built in worktree `C:\Claude\wt-pairing-mlkit` (node_modules junctioned, `local.properties` copied). APK ~84 MB (minify off; `+~12 MB` vs the prior minified build).
- Spec: `docs/superpowers/specs/2026-06-11-pairing-qr-mlkit-decoder-design.md`. Plan: `docs/superpowers/plans/2026-06-11-pairing-qr-mlkit-decoder.md`.
</content>
