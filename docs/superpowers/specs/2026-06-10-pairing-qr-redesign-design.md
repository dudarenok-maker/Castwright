---
title: Pairing-QR redesign — tiny code + ephemeral pairing session
date: 2026-06-10
status: draft
area: app (companion pairing) / server / frontend
supersedes-flow: plan 188 app-2 pairing-QR (JSON {url, token, caFingerprint})
---

# Pairing-QR redesign

## Problem

The Castwright Companion app cannot pair to the server by scanning the desktop
pairing QR on a **real phone**. Root cause (confirmed, not inferred):

- The QR encodes `{url, token, caFingerprint}` as JSON — **193 chars → QR
  version 10 (57×57 modules)**. Displayed at 224 px that is ~3.9 px/module.
- The companion scans with `flutter_zxing` (zxing-cpp). We switched to it
  because `mobile_scanner`'s ML Kit decoder NPEs on Android 16 / API 36.
- **zxing-cpp cannot decode this dense code captured off a screen.** Proven by
  feeding the user's actual camera frames (from a screen recording) into the
  identical engine (`zxing-wasm`): **0/8 frames decoded**, even tightly cropped,
  2× upscaled, sharpened, and contrast-boosted. The phone's *native* camera
  (Google/ML Kit) decodes the same code off the same screen — ML Kit is simply
  far more robust to real-world capture (perspective skew + screen moiré + dense
  grid) than zxing-cpp.

Prior fixes (`tryHarder`, `veryHigh`, `cropPercent 1.0`) tuned the weak decoder
instead of the code, so none stuck. The fix is to make the QR **trivially
decodable** by shrinking it, while preserving the security model.

## Goals

- The pairing QR decodes reliably with `flutter_zxing` off a screen (no decoder
  swap, no ML Kit dependency).
- **No security regression** vs today's cert-fingerprint pinning. Ideally an
  improvement.
- No manual fingerprint compare on the phone.
- Already-paired devices keep working with no migration.

## Non-goals

- Replacing the scanner library or re-introducing ML Kit.
- Changing how a *paired* device authenticates afterward (the existing srv-20 /
  srv-33 LAN-token guard is unchanged).
- mDNS / discovery / deep-link pairing.

## Decision: keep out-of-band integrity, shrink the QR

The QR shrinks from **193 chars (v10, 57²)** to **~50 chars (v3, 29²)** —
modules ~2× bigger — by moving the bulky token (32 ch) and full fingerprint
(95 ch) *off* the QR. Out-of-band MitM protection is retained via a short
fingerprint **tag** carried in the QR.

## QR payload format

A compact string in QR **alphanumeric mode** (the densest mode; charset is
`0-9 A-Z space $ % * + - . / :`), not JSON:

```
CWP1*192.168.86.20:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R
└──┘ └─── host:port ───┘ └─code─┘ └── fpTag ─────┘
magic                     8 ch     16 ch (80-bit)
```

| Field      | Meaning                                                              |
|------------|---------------------------------------------------------------------|
| `CWP1`     | Format magic + version (lets the app reject foreign QRs and future-proof). |
| `host:port`| First reachable LAN IPv4 + HTTPS port (e.g. `192.168.86.20:8443`).   |
| `code`     | Ephemeral pairing code, 8-char Crockford base32 (40 bits), server-minted. |
| `fpTag`    | Crockford base32 of the **first 10 bytes (80 bits)** of the CA cert's SHA-256. |

Encoding decision: **Crockford base32** (RFC-variant without ambiguous
`I L O U`), upper-cased, for both `code` and `fpTag`. One shared helper
mirrored server-side (TS) and app-side (Dart). Crockford-legal output is a
subset of QR alphanumeric mode, so density is preserved.

- Separator `*` is in the alphanumeric charset and never appears in a field.
- Max length: `255.255.255.255:8443` (20) → total ~51 chars → **QR v3 at EC-M**.
- Forbidden-char guard: `code`/`fpTag` use base32 (upper-case, no `*`/`:`), host
  is digits + `.` + `:` — all alphanumeric-mode-legal.

## Server

New router `server/src/routes/pairing.ts`, in-memory ephemeral session store.
Reuses `createDevice()` (`workspace/device-tokens.ts`) to mint the per-device
token, so the paired device uses the existing srv-33 token system unchanged.

### Endpoints

1. **`POST /api/pair/session`** — *loopback-only* (the desktop UI is loopback;
   the LAN guard already bypasses loopback). Behind the normal `/api` LAN guard.
   - Mints `code`, computes `fpTag` from the resolved CA cert, enumerates LAN
     URLs (reuse `enumerateLanUrls`).
   - **Mints no token yet** — an unredeemed session leaves no device behind.
   - Returns `{ urls: string[], port, code, fpTag, expiresAt }`.
   - Returns `409`/structured "unavailable" when not in LAN-HTTPS mode or the CA
     can't be resolved (the modal already has an "unavailable" state).

2. **`POST /api/pair/redeem`** — **exempt from the LAN-token guard** (mounted
   like `/cert/root.crt`, which is also exempt), because an unpaired device
   holds only the `code`, not a token. Gated by the `code` itself.
   - Body `{ code, label? }`.
   - Valid + unexpired + unconsumed code → `createDevice(label)`, mark consumed,
     return `{ token }` (raw token, shown once).
   - Else `401` (bad code) / `410` (expired or already consumed).

### Session store

- Map `code → { expiresAt, consumed }`. **5-minute TTL**, **single-use**.
- In-memory only (lost on restart → re-open the modal). No persistence: an
  ephemeral pre-auth secret should not be written to disk.
- Lazy sweep of expired entries on each access (no background timer needed).
- `code` generated with `randomBytes` → Crockford base32, 40 bits.

### Why redeem must be guard-exempt but safe

The redeem endpoint is reachable without a LAN token, but it is gated by a
40-bit single-use 5-minute code AND only ever returns the token over a channel
the client has already cert-pinned (see app flow). A caller without the code
gets `401`; the code can't be brute-forced inside its window.

## App (companion)

### Parse (`domain/`)
- New `PairingQr` value type + parser for the `CWP1*host:port*code*fpTag` string
  (replaces `PairedServer.fromQrPayload`'s JSON parse). Strict: wrong magic /
  arity / empty field → `FormatException` (scanner keeps scanning).

### Cert tag check (`data/cert_pinning.dart`)
- Add `fingerprintTagMatches(pem, tag)`: SHA-256 the DER, take the first 10
  bytes, Crockford-base32-encode, compare to `tag` (case-insensitive). Reuses
  the existing `pemToDer`.

### Flow (`data/pairing_service.dart`)
1. From `PairingQr`, build `baseUrl = https://host:port`.
2. Fetch `/cert/root.crt` over the one-shot bad-cert-bypass client.
3. **Verify `fingerprintTagMatches(caPem, fpTag)`** → else
   `PairingErrorKind.fingerprintMismatch` (MitM refusal).
4. Build a CA-pinned `HttpClient` trusting only the fetched CA.
5. `POST /api/pair/redeem {code, label}` over the **pinned** client → `{token}`
   (token never crosses an unpinned channel). `401/410` → `tokenRejected`.
6. Compute the **full** SHA-256 fingerprint from the fetched cert and store a
   `PairedServer { url, token, caFingerprint: <full>, pairedAt }` + the CA PEM.
   Downstream code (which expects the full fingerprint) is unchanged.

### Screen (`ui/pairing_screen.dart`)
- Scan → run the flow above (no token/fingerprint text fields needed).
- Manual fallback fields shrink to **host:port + code + fpTag** — all short and
  copyable, so the manual path keeps the same integrity guarantee as the QR path
  (no first-use-trust hole).
- `qr_scan_screen.dart` keeps zxing (now reads a tiny v3 QR easily); its tuned
  `ReaderWidget` config and its regression test stay.

## Frontend (desktop modal)

`src/modals/pair-device.tsx`:
- On open: `POST /api/pair/session` (was `GET /api/export/lan`). Build the
  `CWP1*…` string from `{urls[0], port, code, fpTag}`.
- Render the QR **larger, on white, `margin: 4`, crisp** (`image-rendering:
  pixelated`, bigger box) — belt-and-suspenders so even this tiny code is
  bullet-proof.
- Show a countdown (`expiresAt`) and a "Regenerate code" action (re-calls
  `/session`).
- Manual-entry fallback: host:port + code + fpTag (all short, copyable).
- Keep the existing "unavailable" state (not LAN-HTTPS / no CA).
- `api.ts` / `lib/types.ts`: add `createPairSession()` + `PairSessionInfo`.

## Compatibility

- **Paired devices:** unaffected — they hold `{url, token, fingerprint, caPem}`
  and the guard still accepts their token. No migration, no re-pair.
- **Old JSON QR format:** dropped. Web + app ship in lockstep (version 1.6.0),
  pairing is one-time, so no old-format fallback parser (YAGNI). A *new* app
  against an *old* desktop build won't pair — but they upgrade together.

## Security analysis

| Property        | Today                                  | After                                            |
|-----------------|----------------------------------------|--------------------------------------------------|
| Server identity | Full SHA-256 in QR, app pins on match  | 80-bit prefix tag in QR, app pins on match. Forging an 80-bit SHA-256 prefix is infeasible → equivalent MitM protection. |
| Token exposure  | Static shared token **printed in the QR** (anyone who photographs the screen gets the permanent secret) | Per-device token minted on redeem, returned **only over the cert-pinned channel** → never visible to a MitM or a shoulder-surfer. **Improvement.** |
| Pairing secret  | n/a                                    | 40-bit, single-use, 5-min TTL `code` → not brute-forceable in-window. |

Net: equal-or-better security, ~4× fewer QR chars.

## Testing

- **Server (Vitest):** `pairing.ts` — session create returns code+fpTag;
  redeem mints a token and is single-use; expired/consumed/bad code → 401/410;
  redeem is reachable without a LAN token but `/session` is loopback-gated;
  fpTag = first-10-bytes base32 of the CA.
- **Frontend (RTL):** modal calls `/session`, builds the correct `CWP1*…`
  string, renders the QR, shows countdown, manual fallback copies host+code;
  "unavailable" state preserved.
- **App (Dart):** `PairingQr` parse (happy + malformed); `fingerprintTagMatches`
  (match / mismatch / case); `PairingService` redeem flow with injected
  fetch+redeem (fingerprint mismatch, 401, success).
- **Lock-the-fix regression:** a test that **generates the new QR string and
  decodes it through zxing** (zxing-wasm in a Node test, or `flutter_zxing`
  still-image decode in a Dart test) — asserts the v3 code round-trips. This is
  the assertion that would have caught the original bug.

## Resolved implementation details

- **base32:** Crockford, shared helper mirrored in TS + Dart (see QR-format note).
- **Modal QR display size:** ~288 px square, white background, `margin: 4`
  quiet zone, `image-rendering: pixelated`, no rounded corners on the code image.
