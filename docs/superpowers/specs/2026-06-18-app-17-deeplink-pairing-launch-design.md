# app-17 — Launch flip for stock-camera deep-link pairing

- **Date:** 2026-06-18
- **Issue:** [app-17 / #729](https://github.com/dudarenok-maker/Castwright/issues/729)
- **Status:** draft (spec)
- **Builds on:** `fix/app-pairing-mlkit-decoder` (deep-link readiness shipped),
  `docs/superpowers/specs/2026-06-11-pairing-qr-mlkit-decoder-design.md`,
  `docs/superpowers/specs/2026-06-10-pairing-qr-redesign-design.md`
- **Spans two repos:** `Castwright` (this repo) + `Castwright-Website` (Cloudflare Worker, serves `www`)

## Goal

When a phone scans the companion pairing QR with its **stock camera**, Android
auto-opens the verified companion app and pairs end-to-end — no in-app scanner
step. The robust in-app ML Kit scanner remains the fallback for any device where
verification hasn't completed (or the app isn't installed yet).

This is the **launch flip**, not new app logic: the app side already ships the
deep-link parser (`PairingQr._fromUrl`), the `app_links` handler, and an
`autoVerify` intent-filter. What's missing is (a) the server emitting a verified
**URL** payload instead of the compact `CWP1*…` string, and (b) a hosted
`assetlinks.json` pinning this app's signing cert so Android trusts the link.

## Key decisions

1. **Verified host = `www.castwright.ai`** (the *served* host). The bare
   `castwright.ai` is a **Porkbun 301 URL-forward** to `www` (per
   `Castwright-Website/docs/GO-LIVE-RUNBOOK.md`, deliberately kept that way so
   email stays at Porkbun). Android App Links verification requires
   `assetlinks.json` to be reachable at **HTTP 200 with no redirect** on the
   manifest host; a 301 = silent verify failure. The Worker serves `www`
   directly, so `www` is the only host that can host `assetlinks.json` today
   without a DNS re-home. Accepts **one app rebuild** (fine — the open beta
   redistributes anyway).

2. **Manifest declares BOTH `www.castwright.ai` and `castwright.ai`.** Per-host
   verification (API 31+) means a host that fails to verify doesn't break the
   others. We generate + verify only `www` at launch; the `castwright.ai` entry
   sits dormant (it can't verify while the apex 301-forwards) and costs nothing.
   This future-proofs a "user types the bare domain" case without a *second*
   rebuild if the apex is ever moved to serve directly.

3. **Pin the upload-key cert only** (`upload-keystore.jks`), in an **array** so
   the Play App Signing SHA-256 can be appended later. The project uses **Google
   Play App Signing** (`apps/android/README.md`, plan 188), so the upload key is
   the cert that signs **directly-installed** APKs — which is exactly today's
   beta-tester install path. A Play-track install is re-signed by Google's
   app-signing key (a *different* SHA) and would NOT verify against this pin —
   hence on-device acceptance must use a **sideloaded** APK, and the Play SHA is
   appended to the array when Play distribution lands.

4. **Ship a minimal `/pair` fallback page** on `www` for unverified / no-app
   scans, so they land on "install the app" rather than a 404. It ignores the
   query params (the LAN host + ephemeral code are useless on the public web and
   nothing JS-side acts on them).

## Architecture — three surfaces

### Surface 1 — Server payload flip (this repo)

`server/src/routes/pairing.ts`, the `/session` handler:

```ts
// before:
const qrPayload = `CWP1*${host}*${code}*${fpTag}`;
// after:
const q = new URLSearchParams({ h: host, c: code, f: fpTag });
const qrPayload = `https://www.castwright.ai/pair?${q}`;
```

- `host` (`192.168.x.x:8443`), `code`, `fpTag` semantics are **unchanged**. `h`
  is still the **LAN** pairing target; `www.castwright.ai` exists only to satisfy
  App Links verification. The two never conflate.
- `URLSearchParams` URL-encodes `host:port` → `h=…%3A8443`; the Dart parser
  decodes it via `uri.queryParameters` (already covered by
  `pairing_qr_test.dart:39`, the `%3A` round-trip case).
- The modal (`src/modals/pair-device.tsx`) renders whatever string the API
  returns via `QRCode.toDataURL` — **no modal change**.
- **The frontend mock must flip too.** `src/lib/api.ts` (`mockCreatePairSession`)
  emits its own `CWP1*…` string, and with `VITE_USE_MOCKS` on (the default for
  dev, e2e, and marketing screenshots) the **mock** — not the server — is what the
  modal renders. It must build the identical `URLSearchParams` URL, or the
  shipped/demoed app keeps the old QR while only the server changes.

### Surface 2 — App manifest host (this repo, `apps/android`)

`apps/android/android/app/src/main/AndroidManifest.xml` — the `autoVerify`
intent-filter gains `www.castwright.ai` and keeps `castwright.ai`:

```xml
<intent-filter android:autoVerify="true">
  <action android:name="android.intent.action.VIEW"/>
  <category android:name="android.intent.category.DEFAULT"/>
  <category android:name="android.intent.category.BROWSABLE"/>
  <data android:scheme="https" android:host="www.castwright.ai" android:pathPrefix="/pair"/>
  <data android:scheme="https" android:host="castwright.ai"     android:pathPrefix="/pair"/>
</intent-filter>
```

- `PairingQr.parse` / `_fromUrl`, the `app_links` handler, and the in-app
  scanner are **host-agnostic** — no Dart logic changes. Requires a rebuild +
  redistribute of the signed release APK.

### Surface 3 — Website hosting (`Castwright-Website` repo)

- **`public/.well-known/assetlinks.json`** (deploys to `dist/.well-known/`, served
  at `https://www.castwright.ai/.well-known/assetlinks.json`):

  ```json
  [
    {
      "relation": ["delegate_permission/common.handle_all_urls"],
      "target": {
        "namespace": "android_app",
        "package_name": "ai.castwright",
        "sha256_cert_fingerprints": ["<RELEASE_KEY_SHA256_COLON_HEX_UPPER>"]
      }
    }
  ]
  ```

  The fingerprint is obtained from the **actual release keystore** at build time
  (see Acceptance). `sha256_cert_fingerprints` is an array — append the Play App
  Signing SHA-256 here when Play distribution goes live.

- **`public/_headers`** — add an explicit content-type (Cloudflare infers it from
  `.json`, but pin it to remove a variable):

  ```
  /.well-known/assetlinks.json
    Content-Type: application/json
  ```

- **`src/pages/pair.astro`** — minimal static fallback (mirrors `download.astro`'s
  `Base` layout): "To pair, install the Castwright companion app, then scan from
  inside it," linking `/download`. No JS, no query-param handling.

## Data flow

- **Verified install (happy path):** stock camera reads
  `https://www.castwright.ai/pair?h=…&c=…&f=…` → OS matches the verified
  intent-filter → opens the app **with no network request** (the URL is never
  fetched) → `PairingQr.parse` → redeem over the already-cert-pinned LAN channel.
- **No app / unverified:** the URL opens in a browser → `/pair` "get the app"
  page renders directly on `www` (no redirect — the QR targets `www`, not the
  apex). A user who *manually types* the bare `castwright.ai/pair` gets the
  Porkbun 301 → `www/pair`; that 301 is irrelevant to QR scans.
- **Old installed app + new QR:** stock-camera auto-open won't fire (old build
  verified `castwright.ai`, not `www`) → falls back to the in-app ML Kit scanner,
  which is host-agnostic and pairs normally. **No regression.**

## Failure modes & mitigations

| Failure | Cause | Mitigation |
|---|---|---|
| Deep link opens browser instead of app | `assetlinks.json` SHA-256 ≠ installed APK's signing cert | Derive the fingerprint from the real release keystore; verify post-deploy with `pm get-app-links` |
| Verification silently fails | `assetlinks.json` served via a redirect / non-200 | File lives on served `www` (200, no redirect) — the reason www was chosen; `curl -sI` in acceptance |
| Early installs cache a failed verify | APK distributed **before** `assetlinks.json` was live (verification caches failure) | **Rollout ordering** (below): assetlinks live first |
| Debug build won't auto-open | Debug-signed; assetlinks pins the release key | Expected — documented; testers use the signed release APK |
| Play-delivered install won't verify (future) | Play App Signing re-signs with Google's cert, not pinned | Append Play app-signing SHA to the array when Play goes live (out of scope now) |

## Rollout ordering (load-bearing)

Verification **caches failure**, so order matters:

1. **Deploy `assetlinks.json` + `/pair` to `www` first**; confirm
   `curl -sI https://www.castwright.ai/.well-known/assetlinks.json` → `200`, no
   `3xx`, `Content-Type: application/json`.
2. **Then** ship together: the server build emitting the URL payload **and** the
   rebuilt signed release APK (www host).

All **three** artifacts must align for an end-to-end pair — assetlinks live, a
server build that emits the URL payload, and the rebuilt APK. A tester on an old
desktop server still receives `CWP1*…`.

## Testing

**This repo:**
- `server/src/routes/pairing.test.ts:66` — **update** the exact-payload assertion
  to the new URL form (`https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=${code}&f=…`).
  This *is* the paired regression test for the flip.
- **Frontend mock + its consumers** (all hard-assert `CWP1*` today): flip the mock
  in `src/lib/api.ts` and update `src/lib/api-pair-session.test.ts` (wire-contract,
  exact equality), `src/modals/pair-device.test.tsx`, and
  `src/components/listen/companion-app-banner.test.tsx`. Without these, `npm run
  verify` is red and the mock-mode app shows the old QR.
- **e2e** `e2e/download-tiles.spec.ts` — update the stale "compact CWP1" comment and
  add an assertion that the rendered pairing payload is the verified
  `https://www.castwright.ai/pair?…` URL (the only browser-level lock on the
  UI-visible flip).
- `src/modals/pairing-qr-density.test.ts` — re-anchor: assert the worst-case URL
  payload (longest IPv4 + port + 8-char code + 16-char tag = 85 bytes) encodes to
  **≤ v7 (45×45)** at EC-M (measured worst case is **v5, 37×37**; ≤ v7 leaves two
  versions of headroom so an added param can't silently regress), and that it
  stays **strictly smaller than the retired JSON** (measured **v9**). Rewrite the
  rationale comment (the bound is now ML-Kit / stock-camera headroom, not
  zxing-cpp's ≤ v4 ceiling).
- `apps/android/test/domain/pairing_qr_test.dart` — add/confirm a case that a
  `https://www.castwright.ai/pair?h=…&c=…&f=…` URL parses (locks host-agnosticism,
  the property that keeps old installs working); update existing literals
  `castwright.ai` → `www.castwright.ai` for honesty.

**Website repo:**
- Unit/structure test: `assetlinks.json` is valid JSON, `package_name ==
  "ai.castwright"`, exactly one 64-hex colon-form fingerprint, correct relation.
- Smoke: `/pair` renders (matches the repo's existing Astro/Playwright patterns).

**On-device acceptance (manual — Android 16 / API 36):**
1. Get the **upload-key** fingerprint (the cert on a *sideloaded* APK):
   `keytool -list -v -keystore upload-keystore.jks -alias <alias>` (or
   `apksigner verify --print-certs app-release.apk`) → copy the **SHA-256**
   (colon-hex, uppercase) into `assetlinks.json`. Acceptance must install this
   **sideloaded** APK — a Play-track install is Google-re-signed and won't match.
2. Deploy website; `curl -sI` the assetlinks URL (expect 200/json/no-redirect).
3. Fresh-install the rebuilt signed release APK; reboot or
   `adb shell pm verify-app-links --re-verify ai.castwright`.
4. `adb shell pm get-app-links ai.castwright` → `www.castwright.ai` shows
   `verified`. (`castwright.ai` may show non-verified — expected, dormant.)
5. Scan the QR with the **stock camera** → app opens → pairs end-to-end. Record
   the `pm get-app-links` output in the issue.

## Out of scope

- Play App Signing SHA-256 (additive to the array when Play distribution lands).
- Moving the apex to Cloudflare / serving `castwright.ai` directly.
- Any change to the in-app scanner, the redeem protocol, or pairing crypto.

## Alternatives considered

- **Move apex to Cloudflare** to keep the app host = `castwright.ai` with no host
  rebuild — rejected: requires re-homing the DNS zone (and email) the runbook
  deliberately kept at Porkbun; higher risk for a cosmetic host preference, and a
  rebuild is needed anyway for the open beta.
- **www-only manifest host** — rejected in favour of declaring both, since the
  second host is free during the rebuild and saves a future rebuild.
- **Smart `/pair` page** that re-renders the scan flow — rejected as
  over-engineered for a rare unverified-scan path.
