---
title: Companion pairing — replace the dead zxing decoder with ML Kit still-image decode
date: 2026-06-11
status: draft
scope: app
supersedes-on-device: 2026-06-10-pairing-qr-redesign (the "shrink the QR" fix did not address the root cause)
---

# Pairing QR — ML Kit still-image decoder

## Problem

The companion app cannot pair. On a real device (Android 16 / API 36), the
in-app QR scanner **does not decode the desktop pairing QR at all** — neither
from the live camera nor from a static gallery screenshot.

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
codes, so shrinking could not have helped. The redesign was never verified on a
real device ("OWED on-device scan acceptance"); the user's screen recording is
that verification, arriving late and failing.

## Goal

Make pairing work on a real Android 16 device, **with no dependency on any public
infrastructure** (no website, no DNS, no `castwright.ai` — pairing is LAN-only).

## Non-goals (explicitly deferred)

- **Deep-link / App Link pairing** (stock-camera auto-open via
  `https://castwright.ai/pair?…` + hosted `/.well-known/assetlinks.json`). This is
  the agreed *long-term* experience but is gated on the public launch of
  `castwright.ai`, which is unresolved. It is a separate future piece of work and
  is **not** part of this change. The QR payload format (`CWP1*…`) is therefore
  **unchanged** here — nothing in this change references the domain.
- Any server / desktop-frontend change. The desktop already emits a valid QR.

## Approach

Replace the decoder, keep everything else. The pairing **handshake**
(`PairingService`, CA-fingerprint verification, `/api/pair/redeem`) and the QR
**payload** (`PairingQr.parse`, `CWP1*…`) are correct and stay untouched. Only the
thing that turns camera pixels into a string changes.

**Decoder:** Google ML Kit barcode scanning (`google_mlkit_barcode_scanning`),
run on a **still image** — not a live-camera preview widget.

- ML Kit is the decoder the original investigation proved *can* read these QRs
  ("native ML Kit can").
- Using a **still image** sidesteps the reason ML Kit was removed in the first
  place: `mobile_scanner` 7.2.0's live-camera lifecycle NPE'd on start on API 36.
  We never start that widget — we hand ML Kit a single captured/selected image and
  call `processImage` once.

**Image source:** `image_picker` —
- "Take a photo of the QR" → system camera capture → returns a file.
- "Choose a screenshot" → gallery pick → returns a file (also the fallback the old
  UI offered).

**UX (v1):** tap-to-capture, not continuous live scan. The user taps *Scan QR* →
chooses camera or gallery → frames/picks the QR → it decodes and fills the pairing
form for review. One extra tap versus a live scanner, on a once-per-device flow —
traded for reliability and zero live-camera lifecycle risk. (A live ML-Kit-on-frames
preview is possible later if desired; out of scope for the fix.)

## Components

### `qr_scan_screen.dart` (rewritten)
A small screen with two actions (Take photo / Choose screenshot) and an inline
status line. Logic:

1. Obtain an image path from `image_picker`.
2. Decode via an **injected** `BarcodeDecoder` (default: ML Kit).
3. For each decoded string, try `PairingQr.parse`; first valid `CWP1` payload →
   `Navigator.pop(qr)`.
4. No image / no barcode / no valid pairing payload → inline retry message; the
   screen stays open. ML Kit throwing → "Couldn't read that image — try again or
   enter the code manually."

### Decoder seam (testability)
```dart
typedef BarcodeDecoder = Future<List<String>> Function(String imagePath);
```
The screen takes an optional `BarcodeDecoder` (defaults to the ML Kit
implementation). This isolates the untestable native call so the screen's
decode→parse→pop/error logic is unit-testable with a fake decoder. Mirrors the
existing dependency-injection style in `PairingService`.

### Dependencies (`pubspec.yaml`)
- **Remove** `flutter_zxing`.
- **Add** `google_mlkit_barcode_scanning` and `image_picker`.
- Update the stale `flutter_zxing`-justifying comment.

### Unchanged
- `pairing_qr.dart` / `PairingQr.parse` and its tests.
- `pairing_service.dart`, `pairing_screen.dart` manual-entry form (the always-works
  floor), `pairing-sessions.ts`, `server/src/routes/pairing.ts`, desktop modal.
- `AndroidManifest.xml` CAMERA permission already present. `image_picker` gallery
  uses the system photo picker (no storage permission). Confirm no extra manifest
  entries needed during implementation.

## Data flow (unchanged except the decode box)

```
desktop renders CWP1 QR  →  user captures photo / picks screenshot
  →  ML Kit decodes → "CWP1*192.168.86.20:8443*8N3T59HV*27XZYE1RRV3A8Y4P"
  →  PairingQr.parse  →  fields fill in pairing_screen
  →  PairingService.pair(): fetch CA → verify fpTag → redeem code → token   (all unchanged)
```

## Testing

- **Unchanged & green:** `pairing_qr_test.dart`, `pairing_service_test.dart`.
- **New unit test** (`qr_scan_screen` logic via fake `BarcodeDecoder`):
  - decoder returns a valid `CWP1` string → screen pops a `PairingQr` with the
    right fields;
  - decoder returns a non-pairing string (e.g. a random URL) → no pop, error shown;
  - decoder returns `[]` (no barcode) → no pop, error shown.
- **On-device acceptance (the gate this whole bug exists for lack of):** build the
  release APK, install on the real Android 16 device, scan the live desktop QR →
  pairs end-to-end. Captured in the regression plan's manual walkthrough.

## Risks

1. **ML Kit on Android 16 / API 36.** The removed crash was in `mobile_scanner`'s
   live-camera start path; the standalone still-image `processImage` is a different
   path and ML Kit's decode capability on these QRs is already proven. *But* this
   must be confirmed on-device before claiming done. Contingency if it still NPEs
   on this device (not built preemptively — YAGNI): fall back to a pure-Dart
   decoder (`zxing2`/`qr_code_dart`) or manual-entry-only. Manual entry already
   works today regardless.
2. **APK size / Play Services.** `google_mlkit_barcode_scanning` bundles the
   barcode model (~few MB, no Play Services download). Acceptable; note the delta.

## Out of scope / follow-up

- File a Backlog item for the deferred **deep-link App Link pairing** (gated on the
  `castwright.ai` public launch), referencing the design we worked out: https-URL
  QR + `autoVerify` intent-filter + hosted `assetlinks.json`.
</content>
</invoke>
