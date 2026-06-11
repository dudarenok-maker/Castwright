---
title: Companion pairing — ML Kit decoder now + deep-link forward-compat prep
date: 2026-06-11
status: draft
scope: app, server, frontend
supersedes-on-device: 2026-06-10-pairing-qr-redesign (the "shrink the QR" fix did not address the root cause)
defers: app-17 (host castwright.ai/.well-known/assetlinks.json at launch — the only piece NOT shipped here)
---

# Pairing QR — ML Kit decoder + deep-link forward-compat

## Problem

The companion app cannot pair. On a real device (Android 16 / API 36), the in-app
QR scanner **does not decode the desktop pairing QR at all** — neither from the
live camera nor from a static gallery screenshot.

Root cause, confirmed by investigation (not assumed):

- The desktop emits a **valid** compact `CWP1*host:port*code*fpTag` QR — an
  independent decoder (OpenCV) read it cleanly from 8/8 video frames:
  `CWP1*192.168.86.20:8443*8N3T59HV*27XZYE1RRV3A8Y4P`.
- The phone runs the **current** APK (built 2026-06-11 08:16, redesign included).
- `libflutter_zxing.so` **is** bundled for `arm64-v8a` — not a missing-native-lib
  build issue.
- `flutter_zxing` (zxing-cpp via FFI) simply **fails to decode** this QR on this
  device — a documented zxing weakness ("unreliable on newer devices; low
  recognition rates for smaller barcodes; can fail to decode altogether").

The prior merged fix (PR #696) shrank the QR on the theory that *density* was the
cause. It was not — the decoder library is. zxing is actually **worse** at smaller
codes. The redesign was never verified on a real device ("OWED on-device scan
acceptance"); the user's screen recording is that verification, arriving late and
failing.

## Goals

1. **Fix pairing now**, on a real Android 16 device, with **no dependency on any
   public infrastructure** — pairing is LAN-only and must work before
   `castwright.ai` is live.
2. **Prep the deep-link experience now** so that when `castwright.ai` later serves
   `/.well-known/assetlinks.json`, the phone's **stock camera auto-opens the app
   from the same QR with zero app rebuild** — "drop the file and it just works."

Goal 1 is the bug fix. Goal 2 is forward-compat the user explicitly asked to bake
in now (one QR format forever, no second format churn at launch).

## Design decision: one https-URL QR, two read paths

Change the QR payload from `CWP1*…` to a real URL carrying the same three fields:

```
https://castwright.ai/pair?h=<host:port>&c=<code>&f=<fpTag>
```

The **same** QR is read two independent ways:

- **Now — in-app ML Kit scanner.** Decodes the QR to the URL string and parses the
  query params locally. **Never contacts castwright.ai** — pairing happens over the
  LAN exactly as today. This is the path that fixes the device immediately.
- **Later — stock-camera App Link** (no app rebuild). The app already declares an
  `autoVerify` intent-filter for `castwright.ai/pair` and already handles the
  incoming deep link. The day `assetlinks.json` is hosted, Android verifies the
  domain and the stock camera opens the app straight from the QR.

A non-URL QR (like `CWP1*…`) can *never* be auto-opened by a camera, so the URL
form is what makes Goal 2 a pure ops flip rather than a future format change.

### Pre-launch caveat (accepted)
Until `assetlinks.json` is live, the **in-app scanner is the documented path**. If a
user scans the QR with their *stock* camera before launch, the camera offers to open
`https://castwright.ai/pair?…` in a browser, which fails (site not live). Acceptable
for alpha; resolved automatically at launch (and optionally by a minimal `/pair`
page — see app-17).

## Scope

### Server (`server/src/routes/pairing.ts`)
- `/session` builds `qrPayload = https://castwright.ai/pair?h=…&c=…&f=…`
  (URL-encoded) instead of `CWP1*…`. The separate `hostPort` / `code` / `fpTag`
  fields in the JSON response stay (manual entry + the desktop "enter manually"
  panel read them). One-line payload change.

### Frontend (desktop modal)
- Renders whatever `qrPayload` the server returns — no logic change. Update any
  test asserting the `CWP1` shape and the QR-density expectation (the URL is a
  longer payload → a few more modules; still well within ML-Kit/stock-camera range).

### App (`apps/android`)
- **Decoder swap:** remove `flutter_zxing`; add `google_mlkit_barcode_scanning` +
  `image_picker`. Decode a **still image** (camera capture or gallery pick) via
  `BarcodeScanner.processImage` — never the live-camera widget that NPE'd on API 36.
  - **UX (v1):** tap-to-capture. *Scan QR* → choose camera or gallery → it decodes
    and fills the pairing form for review. One extra tap on a once-per-device flow,
    traded for reliability and zero live-camera lifecycle risk.
  - **Decoder seam (testability):** `typedef BarcodeDecoder =
    Future<List<String>> Function(String imagePath);` injected into the scan screen
    (defaults to ML Kit), so the decode→parse→pop/error logic is unit-testable with
    a fake. Mirrors `PairingService`'s DI style.
- **`PairingQr` parser:** parse the **URL** form (primary) via `Uri.parse` →
  `queryParameters`; **keep `CWP1` parsing** as a legacy path so a not-yet-updated
  desktop still pairs during rollout. Same `{hostPort, code, fpTag}` output; same
  empty-field validation.
- **Deep-link receive:** add `app_links` to handle the incoming
  `https://castwright.ai/pair?…` intent on **both cold start and warm resume** →
  reuse the same `PairingQr` → `PairingService.pair()` flow as the scanner.
- **Manifest:** add the `autoVerify` App Link intent-filter for host
  `castwright.ai`, path `/pair`, scheme `https`. Harmless while unverified (no
  auto-open until `assetlinks.json` exists). CAMERA permission already present;
  `image_picker` gallery uses the system photo picker (no storage permission).

### Unchanged
- `pairing_service.dart` handshake (fetch CA → verify fpTag → redeem code → token),
  `pairing_screen.dart` manual-entry form (the always-works floor),
  `pairing-sessions.ts`, `device-tokens.ts`.

## Data flow

```
desktop renders https://castwright.ai/pair?h=…&c=…&f=…  (one QR)
 ┌─ NOW: in-app scan → ML Kit decodes URL → PairingQr.parse(query) ─┐
 └─ LATER: stock camera → App Link → app receives intent → PairingQr.parse(query) ─┘
        → PairingService.pair(): fetch CA → verify fpTag → redeem code → token   (unchanged)
```

## Testing

- **Unchanged & green:** `pairing_service_test.dart`.
- **`pairing_qr_test.dart` (extended):** parses the new URL form (with/without
  URL-encoded `:` in host); still parses legacy `CWP1`; rejects malformed/empty.
- **Scan-screen logic (new, fake `BarcodeDecoder`):** valid URL string → pops a
  `PairingQr`; non-pairing string → no pop + error; `[]` → no pop + error.
- **Deep-link handler (new):** a fake `app_links` link stream emitting the pair URL
  drives the same parse→pair path; a non-pair URL is ignored. On-device, simulate
  with `adb shell am start -W -a android.intent.action.VIEW -d "https://castwright.ai/pair?h=…&c=…&f=…"`
  (works pre-verification, straight to the activity).
- **Server (`pairing.test.ts`):** assert `/session` returns the `https://…/pair`
  payload with the three params; update the density test.
- **On-device acceptance (the gate this bug exists for lack of):** build release
  APK, install on the real Android 16 device, **in-app scan** the live desktop QR →
  pairs end-to-end. The stock-camera/App-Link path is verified later under app-17
  (needs hosting).

## Risks

1. **ML Kit on Android 16 / API 36.** The removed crash was in `mobile_scanner`'s
   live-camera start path; standalone still-image `processImage` is a different
   path and ML Kit's decode capability on these QRs is already proven. Must be
   confirmed on-device before claiming done. Contingency if it still NPEs (not
   built preemptively — YAGNI): pure-Dart decoder (`zxing2`) or manual-entry-only.
   Manual entry already works today regardless.
2. **App Link signing-cert pinning (app-17, launch-time).** `assetlinks.json` must
   pin the SHA-256 of the keystore that signs the **distributed** APK. If the alpha
   APK is signed with a different key than the one pinned, verification silently
   fails. Captured in app-17 so it isn't discovered at launch.
3. **APK size.** `google_mlkit_barcode_scanning` bundles the barcode model
   (~few MB, no Play Services download). Note the delta.

## Deferred & filed: app-17

The **only** piece not shipped here (gated on the `castwright.ai` public launch):

- Host `/.well-known/assetlinks.json` on `castwright.ai`, pinning the distributed
  APK's signing-cert SHA-256.
- Optional minimal `/pair` fallback page for pre-app / unverified scans.
- On-device verification that the **stock camera** auto-opens the app post-hosting.

Tracked as GitHub issue **app-17** + a `docs/BACKLOG.md` row so the deep-link
completion is not lost. Everything app-side that makes it "just work" ships in this
change; app-17 is the ops flip.
</content>
