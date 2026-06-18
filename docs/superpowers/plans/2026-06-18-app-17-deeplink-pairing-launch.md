# app-17 Deep-Link Pairing Launch Flip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the companion pairing QR to a verified `https://www.castwright.ai/pair?…` deep link and host the `assetlinks.json` that lets a phone's stock camera auto-open the app and pair.

**Architecture:** Three surfaces across two repos. In **Castwright** (this repo): the server `/session` route **and the frontend mock** emit a deep-link URL instead of `CWP1*…`, and the Android manifest declares the verified hosts. In **Castwright-Website**: the Cloudflare Worker serves `assetlinks.json` (pinning the upload-key cert) plus a minimal `/pair` fallback page. The app-side parser already handles the URL form, so no Dart *logic* changes — only the manifest, plus regression-lock tests.

**Tech Stack:** TypeScript/Express + Vitest (server), React + Vitest + Playwright (frontend), Flutter/Dart + `flutter_test` (app), Astro + Vitest + Playwright (website), `qrcode` (QR density), Cloudflare Worker static assets.

## Global Constraints

- **Verified host = `www.castwright.ai`** (the served host; apex `castwright.ai` is a Porkbun 301-forward and cannot host `assetlinks.json` at 200/no-redirect).
- **Manifest declares `www.castwright.ai` ONLY.** Effective `minSdkVersion` is **24** (merged manifest), so the app runs on API 24–30, where `autoVerify` is **all-or-nothing across hosts** — declaring the unverifiable apex `castwright.ai` would fail `www` verification too on those devices. Per-host verify is API 31+ only. Do NOT add the apex host.
- **`assetlinks.json` pins the UPLOAD-key SHA-256 only** (`upload-keystore.jks`), in an **array**. The project uses **Google Play App Signing** (`apps/android/README.md`, plan 188): the upload key signs **sideloaded** APKs (today's beta), so acceptance must use a sideloaded install; the Play app-signing SHA is a *different* cert appended later.
- **Package name = `ai.castwright`** (matches release `applicationId`, no suffix).
- **Both the server (`pairing.ts`) AND the frontend mock (`src/lib/api.ts`) emit the payload.** Mock mode (`VITE_USE_MOCKS`, default in dev/e2e/screenshots) renders the **mock** string — both must flip identically or the shipped app keeps the old QR.
- **QR query params unchanged:** `h` = LAN `host:port`, `c` = code, `f` = fpTag. Built with `URLSearchParams` (encodes `:` → `%3A`).
- **Rollout ordering is load-bearing:** `assetlinks.json` must be live on `www` *before* the rebuilt APK is installed (verification caches failure). Tasks 6–7 (website) deploy before Task 12 acceptance.
- Commit convention: `<type>(<scope>): <subject>`. This-repo branch: `feat/app-17-deeplink-pairing-launch`. Website-repo branch: `feat/app-17-assetlinks-pair-page`.

---

## Task 1: Server payload flip (`/session` emits the deep-link URL)

**Repo:** Castwright (this repo)

**Files:**
- Modify: `server/src/routes/pairing.ts:55` (the `qrPayload` line)
- Test: `server/src/routes/pairing.test.ts:66` (existing exact-payload assertion — paired regression test)

**Interfaces:**
- Consumes: `host` (`"192.168.1.5:8443"`), `code`, `fpTag` already computed in the handler.
- Produces: `res.body.qrPayload` = `https://www.castwright.ai/pair?h=<urlenc host>&c=<code>&f=<fpTag>`. `hostPort`, `code`, `fpTag` fields unchanged.

- [ ] **Step 1: Update the failing test assertion**

In `server/src/routes/pairing.test.ts`, replace the `qrPayload` assertion (line 66):

```ts
    expect(res.body.qrPayload).toBe(
      `https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=${res.body.code}&f=5CEE77RAKV3EN9JX`,
    );
```

(The mock makes `enumerateLanUrls` return `192.168.1.5:8443`; the test cert's fpTag is `5CEE77RAKV3EN9JX`. `URLSearchParams` encodes `:` → `%3A`. Verified: this exact string is what the impl produces.)

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd server && npx vitest run src/routes/pairing.test.ts -t "returns a qrPayload"`
Expected: FAIL — actual is `CWP1*192.168.1.5:8443*…`, expected is the `https://…` URL.

- [ ] **Step 3: Implement the payload flip**

In `server/src/routes/pairing.ts`, replace line 55 (`` const qrPayload = `CWP1*${host}*${code}*${fpTag}`; ``):

```ts
  const q = new URLSearchParams({ h: host, c: code, f: fpTag });
  const qrPayload = `https://www.castwright.ai/pair?${q.toString()}`;
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: PASS (all cases in the file).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pairing.ts server/src/routes/pairing.test.ts
git commit -m "feat(server): emit verified deep-link pairing URL (app-17)"
```

---

## Task 2: Frontend mock flip + paired test

**Repo:** Castwright (this repo, frontend)

**Why:** In mock mode (`VITE_USE_MOCKS`, the default for dev / e2e / marketing screenshots) the modal renders `mockCreatePairSession`'s payload, **not** the server's. So the mock must flip too, or the running/demoed app keeps the old QR. The mock is currently un-exported and has **no** direct test — so the flip needs *new* paired coverage (export it + assert the URL). The three pre-existing `CWP1*` literals do **not** go red on the flip (verified): `api-pair-session.test.ts` is a `fetch`-stubbed pass-through wire test (its own fixture in → same value asserted out), and `pair-device.test.tsx` / `companion-app-banner.test.tsx` inject `qrPayload` into a *mocked* api and never assert it. Update those three only so no stale `CWP1*` literal lingers.

**Files:**
- Modify: `src/lib/api.ts:5568,5574` (export + flip `mockCreatePairSession`)
- Create: `src/lib/api-pair-session-mock.test.ts` (paired coverage for the flip)
- Modify (representativeness, not red): `src/lib/api-pair-session.test.ts:19,42`, `src/modals/pair-device.test.tsx:11,36`, `src/components/listen/companion-app-banner.test.tsx:11`

**Interfaces:**
- Consumes: nothing new.
- Produces: exported `mockCreatePairSession(): Promise<PairSessionInfo>` whose `qrPayload` is `https://www.castwright.ai/pair?h=192.168.1.42%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R`.

- [ ] **Step 1: Write the failing paired test**

Create `src/lib/api-pair-session-mock.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { mockCreatePairSession } from './api';

// app-17: the pairing mock must emit the verified deep-link URL (mock mode drives
// the modal in dev / e2e / marketing screenshots), not the retired CWP1 string.
describe('mockCreatePairSession qrPayload', () => {
  it('is the verified www.castwright.ai deep-link URL carrying h/c/f', async () => {
    const info = await mockCreatePairSession();
    const url = new URL(info.qrPayload);
    expect(url.origin + url.pathname).toBe('https://www.castwright.ai/pair');
    expect(url.searchParams.get('h')).toBe(info.hostPort);
    expect(url.searchParams.get('c')).toBe(info.code);
    expect(url.searchParams.get('f')).toBe(info.fpTag);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/api-pair-session-mock.test.ts`
Expected: FAIL — `mockCreatePairSession` is not exported (import error), and the payload is still `CWP1*…`.

- [ ] **Step 3: Export + flip the mock**

In `src/lib/api.ts`, add `export` to the function (line 5568) and replace the `qrPayload` line (5574):

```ts
export async function mockCreatePairSession(): Promise<PairSessionInfo> {
```
```ts
    qrPayload: `https://www.castwright.ai/pair?${new URLSearchParams({ h: hostPort, c: code, f: fpTag }).toString()}`,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/api-pair-session-mock.test.ts`
Expected: PASS.

- [ ] **Step 5: Refresh the three stale `CWP1*` literals (representativeness — these stay green)**

In `src/lib/api-pair-session.test.ts`, change both `CWP1*…` literals (fetch fixture at line 19 and its pass-through assertion at line 42) to:

```ts
'https://www.castwright.ai/pair?h=192.168.1.42%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'
```

In `src/modals/pair-device.test.tsx`, change both `qrPayload` literals (lines 11, 36) from `'CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R'` to:

```ts
'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'
```

In `src/components/listen/companion-app-banner.test.tsx`, change the `qrPayload` literal (line 11) from `'CWP1*192.168.86.20:8443*ABCD1234*TAGABC123'` to:

```ts
'https://www.castwright.ai/pair?h=192.168.86.20%3A8443&c=ABCD1234&f=TAGABC123'
```

- [ ] **Step 6: Run all touched suites to verify green**

Run: `npx vitest run src/lib/api-pair-session.test.ts src/lib/api-pair-session-mock.test.ts src/modals/pair-device.test.tsx src/components/listen/companion-app-banner.test.tsx`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/lib/api-pair-session-mock.test.ts src/lib/api-pair-session.test.ts src/modals/pair-device.test.tsx src/components/listen/companion-app-banner.test.tsx
git commit -m "feat(frontend): flip pairing mock to deep-link URL + paired test (app-17)"
```

---

## Task 3: Re-anchor the QR density regression guard

**Repo:** Castwright (this repo, frontend)

**Files:**
- Test: `src/modals/pairing-qr-density.test.ts`

**Interfaces:**
- Consumes: the URL payload shape from Tasks 1–2 (worst case).
- Produces: nothing (regression lock).

**Note:** Regression-guard test (written green; fails only if the payload bloats). The worst-case URL (`https://www.castwright.ai/pair?h=255.255.255.255%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R`, 85 bytes) was **measured** to encode to QR **version 5 (37×37)** at EC-M; the retired JSON measures **version 9**. The guard allows ≤ v7 (two versions of headroom) and asserts it stays below the retired payload.

- [ ] **Step 1: Rewrite the test body**

Replace the whole `describe(...)` block in `src/modals/pairing-qr-density.test.ts` with:

```ts
/* Regression for the real-phone pairing-scan failure (2026-06-10), re-anchored
   for app-17. The pairing QR is now a verified deep-link URL
   (https://www.castwright.ai/pair?h=…&c=…&f=…) so the phone's STOCK camera can
   auto-open the app. The bound is no longer zxing-cpp's ≤ v4 ceiling — stock-
   camera / in-app ML Kit decode far denser codes — but we still lock the
   density so the payload can never silently bloat back toward the unscannable
   JSON that broke the original (measured v9). The worst-case URL measures v5
   (37×37); ≤ v7 leaves headroom. QRCode options (errorCorrectionLevel 'M')
   mirror the modal's QRCode.toDataURL in pair-device.tsx.
   Spec: docs/superpowers/specs/2026-06-18-app-17-deeplink-pairing-launch-design.md */
describe('pairing QR density (scan-failure regression)', () => {
  // Worst-case realistic payload: longest IPv4 + port (LAN host is IPv4-only,
  // enumerateLanUrls filters family !== 'IPv4'), 8-char code, 16-char fpTag.
  const urlPayload =
    'https://www.castwright.ai/pair?h=255.255.255.255%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R';

  it('encodes to a stock-camera-comfortable QR (≤ v7) at EC-M', () => {
    const qr = QRCode.create(urlPayload, { errorCorrectionLevel: 'M' });
    expect(qr.version).toBeLessThanOrEqual(7);
  });

  it('stays strictly smaller than the retired JSON payload', () => {
    const retiredJson = JSON.stringify({
      url: 'https://255.255.255.255:8443',
      token: 'Q'.repeat(32),
      caFingerprint: Array.from({ length: 32 }, () => 'AB').join(':'),
    });
    const retiredVersion = QRCode.create(retiredJson, { errorCorrectionLevel: 'M' }).version;
    const urlVersion = QRCode.create(urlPayload, { errorCorrectionLevel: 'M' }).version;
    expect(urlVersion).toBeLessThan(retiredVersion);
  });
});
```

- [ ] **Step 2: Run the test to verify it passes**

Run: `npx vitest run src/modals/pairing-qr-density.test.ts`
Expected: PASS (both cases; worst case measures v5 ≤ 7, and 5 < 9). If `version` is > 7, stop — the payload regressed.

- [ ] **Step 3: Commit**

```bash
git add src/modals/pairing-qr-density.test.ts
git commit -m "test(frontend): re-anchor pairing QR density to deep-link URL (app-17)"
```

---

## Task 4: e2e — refresh the stale CWP1 comment (URL prefix locked by Task 2)

**Repo:** Castwright (this repo, e2e)

**Files:**
- Modify: `e2e/download-tiles.spec.ts:103-107` (stale comment only)

**Interfaces:**
- Consumes: the mock from Task 2 (the e2e runs in mock mode).
- Produces: an accurate comment; behavior assertions unchanged.

**Why no new browser-level URL assertion:** the QR renders as an opaque
`data:image/png` and `pair-qr-image` carries a static `alt="Pairing QR code"`
(verified in `src/modals/pair-device.tsx:155`), so the payload string is not in
any DOM-visible attribute. The manual-entry fallback intentionally shows only
the `h`/`c`/`f` values (host:port + code), never the `www.castwright.ai/pair`
prefix. Adding a Playwright assertion on the URL prefix would require exposing
the payload as a production-only `data-*` attribute purely for the test — scope
creep. The URL prefix is already locked by the Task 2 unit tests
(`api-pair-session.test.ts` asserts the exact string); this e2e keeps the
existing manual-entry visibility assertions and only corrects the stale comment.

- [ ] **Step 1: Update the stale comment**

In `e2e/download-tiles.spec.ts`, replace the comment above the manual-entry assertions (currently `// Manual-entry fallback (collapsed <details>) carries the compact CWP1 // values: …`) with:

```ts
    // Manual-entry fallback (collapsed <details>) carries the LAN host:port and
    // the pairing code — the deep-link URL's h/c params. (app-17: the QR now
    // encodes https://www.castwright.ai/pair?h=…&c=…&f=… ; the exact URL string
    // is locked by the api-pair-session unit test, since the QR is an opaque PNG.)
```

Leave the three `await expect(...)` lines below it unchanged.

- [ ] **Step 2: Run the e2e to verify it still passes**

Run: `npx playwright test e2e/download-tiles.spec.ts --project=chromium`
Expected: PASS (behavior unchanged; only the comment moved).

- [ ] **Step 3: Commit**

```bash
git add e2e/download-tiles.spec.ts
git commit -m "test(e2e): refresh stale CWP1 comment in pairing e2e (app-17)"
```

---

## Task 5: Android manifest www-only host + coverage

**Repo:** Castwright (this repo, `apps/android`)

**Files:**
- Modify: `apps/android/android/app/src/main/AndroidManifest.xml:42-50` (comment + the `autoVerify` intent-filter `<data>` element)
- Modify: `apps/android/test/domain/pairing_qr_test.dart` (add www URL case; update literals)
- Modify: `apps/android/test/main_deep_link_test.dart:35-36` (update apex literal for honesty)
- Create: `apps/android/test/android_manifest_test.dart` (lock www host present, apex absent)

**Interfaces:**
- Consumes: nothing new.
- Produces: a manifest whose `/pair` `autoVerify` filter declares **only** `www.castwright.ai` (apex removed — minSdk 24, pre-31 all-or-nothing verification).

- [ ] **Step 1: Write the failing manifest guard test**

Create `apps/android/test/android_manifest_test.dart`:

```dart
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('pairing autoVerify filter declares www host only (apex would sink pre-31 verify)', () {
    final xml = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(xml.contains('android:autoVerify="true"'), isTrue);
    expect(xml.contains('android:host="www.castwright.ai"'), isTrue);
    expect(xml.contains('android:pathPrefix="/pair"'), isTrue);
    // The bare apex must NOT be declared: on minSdk 24 (pre-API-31) autoVerify is
    // all-or-nothing, and the apex 301-forwards (no assetlinks) so it can't verify.
    // (host="castwright.ai" with a leading quote won't match host="www.castwright.ai".)
    expect(xml.contains('android:host="castwright.ai"'), isFalse);
  });
}
```

(`flutter test` runs with the package root `apps/android` as CWD — confirmed by the existing `brand_test.dart`, which reads `Directory('lib')` the same way.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/android && flutter test test/android_manifest_test.dart`
Expected: FAIL — manifest declares `castwright.ai`, not `www.castwright.ai`.

- [ ] **Step 3: Repoint the host to `www` in the manifest**

In `apps/android/android/app/src/main/AndroidManifest.xml`, the `autoVerify` intent-filter holds a **single 3-line `<data>` element** (`:48-50`). Change only its host:

```xml
                <data android:scheme="https"
                      android:host="www.castwright.ai"
                      android:pathPrefix="/pair"/>
```

Then update the comment above the intent-filter (`:40-43`): change its assetlinks URL to `https://www.castwright.ai/.well-known/assetlinks.json` (it currently names the apex), AND fix the stale "Dormant (no auto-verify) until then" phrasing — the filter already carries `android:autoVerify="true"`, so reword to e.g. "Auto-verified against www's assetlinks.json once hosted." Do NOT add a second `<data>` host — the apex is intentionally absent (minSdk 24 / pre-31 all-or-nothing).

- [ ] **Step 4: Run the manifest guard to verify it passes**

Run: `cd apps/android && flutter test test/android_manifest_test.dart`
Expected: PASS.

- [ ] **Step 5: Add a `www` parser case + update literals (host-agnostic lock)**

In `apps/android/test/domain/pairing_qr_test.dart`, add this test after the existing percent-encoded case:

```dart
  test('parses the deep-link URL form on the www host', () {
    final qr = PairingQr.parse(
        'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R');
    expect(qr.hostPort, '192.168.1.5:8443');
    expect(qr.code, 'K7QF3M2P');
    expect(qr.fpTag, 'J4XQ2A7BWZ9K3M5R');
  });
```

Change the two existing `https://castwright.ai/pair?…` literals (the "raw colon" and "percent-encoded colon" cases) to `https://www.castwright.ai/pair?…`. Leave the "rejects a URL missing a pairing field" case as-is (host irrelevant). Also update the apex literal in `apps/android/test/main_deep_link_test.dart:36` (`https://castwright.ai/pair?…`) to `https://www.castwright.ai/pair?…` for the same honesty rationale.

- [ ] **Step 6: Run the full app gate (Dart tests + analyze)**

`npm run verify` does NOT run any Flutter tests (CLAUDE.md: "no local hook runs `flutter analyze`/`test`" — only the `app.yml` CI on `apps/android/**` pushes). So this is the gate for all Task 5 changes:

Run: `cd apps/android && flutter analyze && flutter test`
Expected: analyze clean; all tests PASS (manifest guard + `pairing_qr_test.dart` + `main_deep_link_test.dart`). Pushing the app branch also triggers `app.yml` as a second check.

- [ ] **Step 7: Commit**

```bash
git add apps/android/android/app/src/main/AndroidManifest.xml apps/android/test/domain/pairing_qr_test.dart apps/android/test/main_deep_link_test.dart apps/android/test/android_manifest_test.dart
git commit -m "feat(app): point pairing deep-link autoVerify host to www-only (app-17)"
```

---

## Task 6: Host `assetlinks.json` (+ content-type header + test)

**Repo:** Castwright-Website (branch `feat/app-17-assetlinks-pair-page`)

**Files:**
- Create: `public/.well-known/assetlinks.json`
- Modify: `public/_headers` (append content-type rule)
- Create: `src/lib/assetlinks.test.ts`

**Interfaces:**
- Consumes: the upload-key SHA-256 (derived at build time).
- Produces: `https://www.castwright.ai/.well-known/assetlinks.json` served 200/json/no-redirect.

- [ ] **Step 1: Derive the upload-key SHA-256**

In the Castwright repo, from the keystore recorded by `fix/app-pairing-mlkit-decoder` (`apps/android/android/app/upload-keystore.jks` + `key.properties`):

```bash
keytool -list -v -keystore apps/android/android/app/upload-keystore.jks -alias <keyAlias from key.properties>
# or, from a built signed APK:
apksigner verify --print-certs apps/android/build/app/outputs/flutter-apk/app-release.apk
```

Copy the **SHA-256** line, colon-separated, uppercase hex (e.g. `BA:7B:14:7D:…`). This is the cert on a **sideloaded** APK (Play re-signs separately — out of scope). `keytool`/`apksigner` ship with the Android Studio JBR if not on PATH (see `project_android_play_store_path.md`).

- [ ] **Step 2: Write the failing structure test**

Create `src/lib/assetlinks.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

// Digital Asset Links statement that lets the stock camera auto-open the
// companion app from the pairing deep link (app-17). Android verifies this at
// https://www.castwright.ai/.well-known/assetlinks.json; a wrong package or
// fingerprint = silent verify failure.
describe('assetlinks.json', () => {
  const raw = readFileSync(resolve(process.cwd(), 'public/.well-known/assetlinks.json'), 'utf8')
  const json = JSON.parse(raw) as Array<{
    relation: string[]
    target: { namespace: string; package_name: string; sha256_cert_fingerprints: string[] }
  }>

  it('is a non-empty statement array', () => {
    expect(Array.isArray(json)).toBe(true)
    expect(json.length).toBeGreaterThan(0)
  })

  it('delegates handle_all_urls to the ai.castwright android app', () => {
    const stmt = json[0]
    expect(stmt.relation).toContain('delegate_permission/common.handle_all_urls')
    expect(stmt.target.namespace).toBe('android_app')
    expect(stmt.target.package_name).toBe('ai.castwright')
  })

  it('pins at least one valid SHA-256 fingerprint (64 hex, colon-separated)', () => {
    const fps = json[0].target.sha256_cert_fingerprints
    expect(fps.length).toBeGreaterThan(0)
    for (const fp of fps) {
      expect(fp).toMatch(/^([0-9A-F]{2}:){31}[0-9A-F]{2}$/)
    }
  })
})
```

- [ ] **Step 3: Run it to verify it fails, then create the file**

Run: `npx vitest run src/lib/assetlinks.test.ts`
Expected: FAIL — file does not exist.

Create `public/.well-known/assetlinks.json` (replace the fingerprint with the Step 1 value):

```json
[
  {
    "relation": ["delegate_permission/common.handle_all_urls"],
    "target": {
      "namespace": "android_app",
      "package_name": "ai.castwright",
      "sha256_cert_fingerprints": ["BA:7B:14:7D:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:FF"]
    }
  }
]
```

(`public/.well-known/README.md` already lives here — the fs-44 MCP placeholder. Harmless: Android fetches only the exact `assetlinks.json` path.)

- [ ] **Step 4: Add the content-type header**

Append to `public/_headers` (mirrors the existing `/llms.txt` content-type block):

```
# app-17 — Android App Links statement; pin JSON content-type (no redirect, 200).
/.well-known/assetlinks.json
  Content-Type: application/json
```

**Sanity check `_headers` is honored by the assets-only Worker** (it's a Pages
convention; this site is a plain assets Worker per `wrangler.jsonc`): the existing
`/llms.txt` charset rule is the proof case. Confirm in prod with
`curl -sI https://www.castwright.ai/llms.txt | grep -i content-type` → it should
show `charset=utf-8`. If `_headers` is a no-op here, the JSON content-type instead
comes from Cloudflare's `.json` extension inference (still served correctly) — note
that and don't block on the header.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/assetlinks.test.ts`
Expected: PASS. (If the fingerprint regex fails, the SHA-256 wasn't pasted in colon-hex uppercase form.)

- [ ] **Step 6: Verify the build emits it**

Run: `npm run build && test -f dist/.well-known/assetlinks.json && echo OK`
Expected: `OK` (Astro copies `public/` → `dist/`).

- [ ] **Step 7: Commit**

```bash
git add public/.well-known/assetlinks.json public/_headers src/lib/assetlinks.test.ts
git commit -m "feat: host assetlinks.json for companion deep-link pairing (app-17)"
```

---

## Task 7: `/pair` fallback page (+ e2e smoke)

**Repo:** Castwright-Website (branch `feat/app-17-assetlinks-pair-page`)

**Files:**
- Modify: `src/layouts/Base.astro` (add an optional `noAnalytics` prop)
- Create: `src/pages/pair.astro`
- Modify: `e2e/pages.spec.ts` (add `/pair` to the route table)
- Create: `src/lib/pair-page-privacy.test.ts` (lock: no beacon in the built `/pair`)

**Interfaces:**
- Consumes: existing `Base` layout + `SectionHeading` component (mirrors `download.astro`; no `URLS` import needed).
- Produces: `Base.astro` gains `noAnalytics?: boolean` (default `false` — no change for any other page); a static `/pair` page rendering an `<h1>` "Pair your phone" with the analytics beacon suppressed.

**CTA caveat:** `/download` is the **desktop** app page, and the site has **no
public companion-APK download** today (companion ships sideloaded / Play-internal).
So the page must NOT say "get the companion app → /download" (wrong install flow).
It frames the in-app-scan path as primary; it does not link to a companion
download that doesn't exist.

**Privacy requirement (round-3 review):** an unverified scan *navigates* to
`/pair?h=<LAN-IP>&c=<live code>&f=<tag>`. `Base.astro` injects the Cloudflare Web
Analytics beacon when `CF_PAGES=1`, which would feed those params to the
third-party beacon + referrer. So `/pair` must render **without** the beacon and
with `<meta name="referrer" content="no-referrer">`. (The edge *request log* still
sees the URL — inherent and low-risk; see the spec's "Security delta".)

- [ ] **Step 1: Add the failing e2e route assertion**

In `e2e/pages.spec.ts`, add to the `pages` array (generates the test title `"/pair renders its h1"`):

```ts
  { path: '/pair', h1: /pair your phone/i },
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/pages.spec.ts --project=chromium -g "/pair renders"`
Expected: FAIL — `/pair` 404s (page doesn't exist yet).

- [ ] **Step 3: Add a `noAnalytics` opt-out to `Base.astro`**

`Base.astro` currently injects the beacon unconditionally when `CF_PAGES=1` (lines ~7-16 declare `Props { title?, description? }` and `cfWebAnalytics = process.env.CF_PAGES === '1'`; lines ~55-62 render the `<script ... cloudflareinsights ...>`). Add an opt-out prop, default off so no other page changes:

In the frontmatter, extend `Props` and gate the flag:

```ts
interface Props {
  title?: string
  description?: string
  noAnalytics?: boolean
}
const { title, description, noAnalytics = false } = Astro.props
const cfWebAnalytics = process.env.CF_PAGES === '1' && !noAnalytics
```

In `<head>`, when `noAnalytics` is set, also emit a no-referrer meta. Add near the top of `<head>`:

```astro
{noAnalytics && <meta name="referrer" content="no-referrer" />}
```

(The existing `{cfWebAnalytics && (<script .../>)}` block now skips automatically when `noAnalytics` is true, because `cfWebAnalytics` folds in `!noAnalytics`.)

- [ ] **Step 4: Create the page (analytics suppressed)**

Create `src/pages/pair.astro`:

```astro
---
import Base from '@/layouts/Base.astro'
import SectionHeading from '@/components/SectionHeading.astro'
---

<Base
  noAnalytics
  title="Pair your phone — Castwright"
  description="Pair the Castwright companion app with your library. Open the app, then scan the pairing code from inside it."
>
  <div class="max-w-2xl">
    <SectionHeading as="h1">Pair your phone</SectionHeading>
    <p class="mt-4">
      Pairing happens inside the <b class="text-magenta">Castwright</b> companion app.
      Open the app on your phone and scan this code from its built-in scanner.
    </p>
    <p class="mt-4">
      Your phone's normal camera can open the app directly once it's installed and its
      link is verified — until then, scan from inside the app.
    </p>
  </div>
</Base>
```

(`SectionHeading` renders `<Tag>` from its `as` prop, so `as="h1"` emits a real `<h1>`. `noAnalytics` suppresses the beacon + sets `no-referrer` so the scanned `?h=…&c=…` params aren't fed to the third-party beacon/referrer. No JS, no query-param handling, no `/download` link — that's the desktop app, and there's no public companion-APK download to point at.)

- [ ] **Step 5: Run the e2e to verify it passes**

Run: `npx playwright test e2e/pages.spec.ts --project=chromium -g "/pair renders"`
Expected: PASS (the webServer config rebuilds + previews).

- [ ] **Step 6: Lock the beacon-suppression with a prod-style build check**

The beacon only renders when `CF_PAGES=1`, so prove the opt-out against a prod-style build. Create `src/lib/pair-page-privacy.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

// app-17: an unverified pairing scan navigates to /pair?h=<LAN-IP>&c=<code>&f=<tag>.
// /pair must NOT load the Cloudflare Web Analytics beacon (it would feed the live
// code to the third-party beacon/referrer). Build with CF_PAGES=1 and assert the
// beacon is present site-wide but absent on /pair.
describe('/pair suppresses the analytics beacon', () => {
  it('omits the cloudflareinsights beacon while the home page keeps it', () => {
    execFileSync('npm', ['run', 'build'], { env: { ...process.env, CF_PAGES: '1' }, stdio: 'inherit' })
    const pair = resolve(process.cwd(), 'dist/pair/index.html')
    const home = resolve(process.cwd(), 'dist/index.html')
    expect(existsSync(pair)).toBe(true)
    expect(readFileSync(pair, 'utf8')).not.toContain('cloudflareinsights')
    expect(readFileSync(pair, 'utf8')).toContain('referrer')
    expect(readFileSync(home, 'utf8')).toContain('cloudflareinsights')
  })
})
```

Run: `npx vitest run src/lib/pair-page-privacy.test.ts`
Expected: PASS. (Slow — it runs a full build; this single test is the privacy gate. If the project prefers not to build inside vitest, instead run the `CF_PAGES=1 npm run build` manually and `grep -L cloudflareinsights dist/pair/index.html` as an acceptance step — but the automated form is preferred per CLAUDE.md.)

- [ ] **Step 7: Commit**

```bash
git add src/layouts/Base.astro src/pages/pair.astro src/lib/pair-page-privacy.test.ts e2e/pages.spec.ts
git commit -m "feat: /pair fallback page, analytics-suppressed for scan privacy (app-17)"
```

---

## Task 8: Reject non-private QR hosts (anti-phishing-QR, app)

**Repo:** Castwright (this repo, `apps/android`)

**Why:** the app trusts the QR's `h` as the server to pair with (`pairing_service.dart:54-81` fetches the CA from `https://<h>/cert/root.crt` over a validation-bypassing client, then redeems). A phishing `https://www.castwright.ai/pair?h=<public-IP>&…` could point the app at an attacker's internet server. Constrain `h` to private/loopback IPv4 so a QR can't aim the app off-LAN. (The host is already *shown* to the user — `pairing_screen.dart` pre-fills the editable `field-host` — so this adds the missing *rejection*.) Validating in `PairingQr` covers all three entry paths: scan, deep link, and manual entry (`pairing_screen.dart:_pair` constructs a `PairingQr`).

**Files:**
- Modify: `apps/android/lib/src/domain/pairing_qr.dart` (`_checked` gains a private-host check)
- Modify: `apps/android/test/domain/pairing_qr_test.dart`

**Interfaces:**
- Produces: `PairingQr.parse`/constructor throws `FormatException` when `hostPort`'s host is not RFC1918 / loopback / link-local IPv4.

- [ ] **Step 1: Write the failing tests**

Add to `apps/android/test/domain/pairing_qr_test.dart`:

```dart
  test('rejects a non-private (public) host', () {
    expect(
        () => PairingQr.parse(
            'https://www.castwright.ai/pair?h=8.8.8.8:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'),
        throwsFormatException);
  });

  test('rejects a non-IP host', () {
    expect(
        () => PairingQr.parse(
            'https://www.castwright.ai/pair?h=evil.example.com:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'),
        throwsFormatException);
  });

  test('accepts the three RFC1918 ranges + loopback', () {
    for (final h in ['10.0.0.4:8443', '172.16.5.6:8443', '192.168.1.5:8443', '127.0.0.1:8443']) {
      expect(PairingQr.parse('https://www.castwright.ai/pair?h=$h&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R').hostPort, h);
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/android && flutter test test/domain/pairing_qr_test.dart`
Expected: FAIL — public + hostname cases currently parse instead of throwing.

- [ ] **Step 3: Implement the private-host check**

In `apps/android/lib/src/domain/pairing_qr.dart`, add a pure helper (no `dart:io` — keep the file platform-free) and call it from `_checked`:

```dart
  static bool _isPrivateIpv4Host(String hostPort) {
    final lastColon = hostPort.lastIndexOf(':');
    final host = lastColon >= 0 ? hostPort.substring(0, lastColon) : hostPort;
    final octets = host.split('.');
    if (octets.length != 4) return false;
    final n = <int>[];
    for (final o in octets) {
      final v = int.tryParse(o);
      if (v == null || v < 0 || v > 255) return false;
      n.add(v);
    }
    return n[0] == 10 ||
        (n[0] == 172 && n[1] >= 16 && n[1] <= 31) ||
        (n[0] == 192 && n[1] == 168) ||
        n[0] == 127 ||
        (n[0] == 169 && n[1] == 254);
  }
```

In `_checked`, after the empty-field guard, add:

```dart
    if (!_isPrivateIpv4Host(hostPort)) {
      throw const FormatException('pairing host is not a private/LAN address');
    }
```

(Tradeoff to note in the commit: this rejects exotic LAN setups — CGNAT `100.64/10`, Tailscale `100.x`, raw hostnames/mDNS. `enumerateLanUrls` only emits RFC1918 IPv4 today, so legit pairing is unaffected; widen the allowlist if a real setup needs it.)

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/android && flutter test test/domain/pairing_qr_test.dart`
Expected: PASS (existing private-host cases stay green).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/pairing_qr.dart apps/android/test/domain/pairing_qr_test.dart
git commit -m "feat(app): reject non-private pairing-QR hosts (anti-phishing) (app-17)"
```

---

## Task 9: Deep-link re-entrancy guard (app)

**Repo:** Castwright (this repo, `apps/android`)

**Why:** `_handleDeepLink` → `_openPairing` does an unconditional `Navigator.push` (`main.dart:251-257`); the `_lastHandledLink` de-dupe only catches the *same* URI. Two *different* links (a legit-then-attacker sequence) stack pairing screens. Guard so a second link no-ops while a pairing screen is open.

**Files:**
- Modify: `apps/android/lib/main.dart` (`_openPairing` re-entrancy guard)
- Modify: `apps/android/test/main_deep_link_test.dart`

**Interfaces:**
- Produces: at most one `PairingScreen` on the stack regardless of how many deep links arrive.

- [ ] **Step 1: Write the failing test**

Add to `apps/android/test/main_deep_link_test.dart`:

```dart
  testWidgets('a second deep link does not stack a second pairing screen',
      (tester) async {
    final links = StreamController<Uri>();
    addTearDown(links.close);
    await tester.pumpWidget(AudiobookCompanionApp(
      store: _NoopStore(), service: PairingService(), deepLinks: links.stream));
    await tester.pumpAndSettle();

    links.add(Uri.parse('https://www.castwright.ai/pair?h=192.168.1.5:8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'));
    await tester.pumpAndSettle();
    links.add(Uri.parse('https://www.castwright.ai/pair?h=192.168.1.9:8443&c=ZZZZZZZZ&f=J4XQ2A7BWZ9K3M5R'));
    await tester.pumpAndSettle();

    expect(find.text('Pair a device'), findsOneWidget); // AppBar title — exactly one screen
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd apps/android && flutter test test/main_deep_link_test.dart`
Expected: FAIL — two pairing screens (`findsNWidgets(2)`), so `findsOneWidget` fails.

- [ ] **Step 3: Add the guard**

In `apps/android/lib/main.dart`, add a field to `_HomePageState` and wrap `_openPairing`:

```dart
  bool _pairingOpen = false;

  Future<void> _openPairing({PairingQr? initialQr}) async {
    if (_pairingOpen) return;
    _pairingOpen = true;
    try {
      final result = await Navigator.of(context).push<PairedServer>(
        MaterialPageRoute(
          builder: (_) => PairingScreen(
              service: widget.service, store: widget.store, initialQr: initialQr),
        ),
      );
      if (result != null && mounted) {
        _paired = result;
        await _boot();
      }
    } finally {
      _pairingOpen = false;
    }
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd apps/android && flutter test test/main_deep_link_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/main.dart apps/android/test/main_deep_link_test.dart
git commit -m "fix(app): guard against stacked pairing screens from deep links (app-17)"
```

---

## Task 10: Redeem private-network guard (server)

**Repo:** Castwright (this repo, server)

**Why:** `/api/pair/redeem` is mounted pre-guard (`index.ts:190`) and reachable by the whole LAN — and the internet if the box is ever port-forwarded. Bounding it to private/loopback source IPs makes it structurally LAN-only, which also caps the blast radius of app-17's edge-log code leak.

**Files:**
- Modify: `server/src/lan-auth.ts` (add `isPrivateNetworkRequest` + invariant comment)
- Modify: `server/src/routes/pairing.ts` (gate the redeem handler)
- Modify: `server/src/routes/pairing.test.ts` (mock + 403 test)

**Interfaces:**
- Produces: `isPrivateNetworkRequest(req): boolean` (loopback + RFC1918 IPv4). `/api/pair/redeem` returns 403 for non-private callers.

- [ ] **Step 1: Write the failing test**

In `server/src/routes/pairing.test.ts`, extend the `vi.mock('../lan-auth.js', …)` to also export `isPrivateNetworkRequest: vi.fn(() => true)`, import it alongside `isLoopbackRequest`, and add:

```ts
  it('POST /redeem 403s a non-private caller', async () => {
    vi.mocked(isPrivateNetworkRequest).mockReturnValueOnce(false);
    const session = await request(appWith(pairSessionRouter)).post('/api/pair/session').send({});
    const res = await request(appWith(pairRedeemRouter))
      .post('/api/pair/redeem').send({ code: session.body.code });
    expect(res.status).toBe(403);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/routes/pairing.test.ts -t "non-private"`
Expected: FAIL — redeem currently 201s (no network guard).

- [ ] **Step 3: Implement**

In `server/src/lan-auth.ts`, add (and note the trust-proxy invariant):

```ts
/* Loopback + RFC1918 IPv4. NOTE: relies on `req.ip` being the real socket peer —
   do NOT enable Express `trust proxy`, or `X-Forwarded-For` could forge this. */
const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./];
export function isPrivateNetworkRequest(req: Request): boolean {
  let ip = req.ip ?? req.socket?.remoteAddress ?? '';
  if (ip.startsWith('::ffff:')) ip = ip.slice('::ffff:'.length);
  if (ip === '::1') return true;
  return PRIVATE_V4.some((re) => re.test(ip));
}
```

In `server/src/routes/pairing.ts`, import `isPrivateNetworkRequest` and add at the top of the `/redeem` handler:

```ts
  if (!isPrivateNetworkRequest(req)) {
    res.status(403).json({ error: 'Pairing can only be redeemed from the local network.' });
    return;
  }
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: PASS (loopback supertest calls resolve via the mock's default `true`; the new test forces `false` → 403).

- [ ] **Step 5: Commit**

```bash
git add server/src/lan-auth.ts server/src/routes/pairing.ts server/src/routes/pairing.test.ts
git commit -m "feat(server): restrict pair redeem to the local network (app-17)"
```

---

## Task 11: Cap redeem label length (server)

**Repo:** Castwright (this repo, server)

**Why:** the redeem `label` is attacker-controllable body input (`pairing.ts` passes it to `createDevice`); it's persisted unbounded. Cap it. (Brute-force note: a runtime per-code lockout is **intentionally not added** — the code is 40-bit single-use with a 5-min TTL, already locked by `pairing.test.ts:63`'s `/^[0-9A-HJKMNP-TV-Z]{8}$/` assertion; a lockout for a cryptographically-infeasible brute would be speculative complexity. Revisit only if the code ever shrinks.)

**Files:**
- Modify: `server/src/workspace/device-tokens.ts` (`createDevice` label cap)
- Modify: `server/src/workspace/device-tokens.test.ts` (or the nearest existing test for `createDevice`)

**Interfaces:**
- Produces: stored `label` is `.trim().slice(0, 64) || 'Device'`.

- [ ] **Step 1: Write the failing test**

In the device-tokens test, add:

```ts
  it('caps an over-long label at 64 chars', async () => {
    const { device } = await createDevice('x'.repeat(200));
    expect(device.label.length).toBe(64);
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `cd server && npx vitest run src/workspace/device-tokens.test.ts -t "caps an over-long label"`
Expected: FAIL — label is 200 chars.

- [ ] **Step 3: Implement**

In `server/src/workspace/device-tokens.ts`, change the `label` line in `createDevice`:

```ts
    label: label.trim().slice(0, 64) || 'Device',
```

- [ ] **Step 4: Run to verify pass**

Run: `cd server && npx vitest run src/workspace/device-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/device-tokens.ts server/src/workspace/device-tokens.test.ts
git commit -m "feat(server): cap pairing device label length (app-17)"
```

---

## Task 12: Deploy, rebuild, on-device acceptance (delivery — not code)

**Repos:** both. **Ordering is load-bearing (verification caches failure).**

- [ ] **Step 1: Deploy the website first**

In Castwright-Website: merge `feat/app-17-assetlinks-pair-page`, then `npx wrangler deploy`.

- [ ] **Step 2: Verify the statement is served correctly**

```bash
curl -sI https://www.castwright.ai/.well-known/assetlinks.json
```
Expected: `HTTP/2 200`, **no** `3xx`, `content-type: application/json`. Confirm `curl -s` returns the JSON with the right fingerprint. (Curl `www` directly — the apex `castwright.ai/.well-known/…` returns the Porkbun 301; that is expected, not a failure.)

- [ ] **Step 3: Run the full local battery in this repo**

Run: `npm run verify`
Expected: green (typecheck + frontend/server tests + e2e + build). **Note:** this covers the **frontend + server** tasks (1–4, 10, 11) — it does NOT run any Flutter test, so the **app** tasks (5, 8, 9) are gated by `cd apps/android && flutter analyze && flutter test` (plus `app.yml` CI on the app-branch push). Then merge `feat/app-17-deeplink-pairing-launch`.

- [ ] **Step 4: Rebuild + SIDELOAD the signed release APK**

Build the release APK signed with `upload-keystore.jks` (whose SHA-256 is in `assetlinks.json`), **sideload-install** it on an Android device (NOT a Play-track install — Play re-signs with a different cert that won't match the pin), then reboot or:

```bash
adb shell pm verify-app-links --re-verify ai.castwright
adb shell pm get-app-links ai.castwright
```
Expected: `www.castwright.ai → verified` (the only declared host).

- [ ] **Step 5: End-to-end stock-camera pair**

Start the desktop server in LAN HTTPS mode (`npm run dev:lan` or `start:lan`), open the pairing modal, scan the QR with the phone's **stock camera** → app opens → pairs. Record the `pm get-app-links` output in issue #729.

- [ ] **Step 6: Close out (CLAUDE.md before-shipping checklist)**

- `Closes #729` in the website PR or the app PR; remove its row from `docs/BACKLOG.md`.
- Set the spec `status:` to `stable`, fill Ship notes (date + SHAs).
- Update `docs/features/INDEX.md` if the spec/plan is indexed there.
- (Optional honesty edit) `docs/features/208-pairing-qr-mlkit-decoder.md` mentions the host-agnostic parser accepting `castwright.ai/pair?…` (lines ~11/32/41/63) — these describe what the parser *accepts*, not a hosted assetlinks URL, so they need no change unless you want them to read `www` for consistency.
- Note in the BACKLOG/issue that the **Play App Signing SHA-256** is still owed when Play distribution lands (append to the `assetlinks.json` array).

- [ ] **Step 7: Rollback note (keep handy)**

If `assetlinks.json` ships with a wrong fingerprint, fixing it isn't enough — Android caches the failure. Recover: correct the file → `npx wrangler deploy` → on each test device `adb shell pm verify-app-links --re-verify ai.castwright`. Production installs self-heal on the next periodic re-verify or app update.

---

## Self-Review

**Spec coverage:**
- Server payload flip → Task 1 ✓
- Frontend mock flip + new paired test (mock was un-exported/untested); 3 stale `CWP1*` literals refreshed (verified NOT red) → Task 2 ✓
- Density re-anchor (measured v5/v9) → Task 3 ✓
- e2e stale-comment refresh; URL prefix locked by Task 2 unit test (QR is opaque PNG) → Task 4 ✓
- Manifest **www-only** (apex removed — minSdk 24 / pre-31 all-or-nothing) + Dart host-agnostic lock + main_deep_link literal + explicit `flutter analyze`/`test` gate → Task 5 ✓
- assetlinks.json (upload-key cert, array) + content-type → Task 6 ✓
- /pair fallback page (no `/download` CTA) + analytics-beacon suppression for scan privacy + build-grep lock → Task 7 ✓
- Security delta (unverified-scan leak: bounded, beacon/referrer mitigated, edge-log residual accepted) → spec "Security delta" + Task 7 ✓
- Anti-phishing-QR: reject non-private hosts → Task 8 ✓
- Deep-link re-entrancy guard (no stacked pairing screens) → Task 9 ✓
- Redeem private-network guard (LAN-only redeem, bounds edge-log leak) → Task 10 ✓
- Redeem label cap; runtime brute-lockout intentionally omitted (40-bit single-use already test-locked) → Task 11 ✓
- Rollout ordering + sideloaded on-device acceptance + curl/pm + doc close-out → Task 12 ✓
- Out-of-scope (Play SHA, apex move, 128-bit fp tag) → Global Constraints + spec follow-ups + Task 12 ✓

**Placeholder scan:** The only fill-at-build value is the SHA-256 in Task 6 Step 3, with an explicit derivation command (Step 1) and a format-validating test (Step 2); the dummy fingerprint is replaced in the same step. No conditional/deferred steps remain (the Task 4 `alt`-attribute branch was resolved away — the QR is an opaque PNG, so the URL prefix is locked by Task 2's unit test instead).

**Type/name consistency:** `qrPayload` URL shape identical across Task 1 (server impl + test), Task 2 (mock + paired test + 3 refreshed literals), and Task 3 (density). `package_name: "ai.castwright"` matches the manifest `applicationId` and the Dart guard. Host literal `www.castwright.ai` consistent across Tasks 1–7, and is the **only** manifest host (apex removed). Mock host `192.168.1.42` / `pair-device` host `192.168.1.5` / banner host `192.168.86.20` each preserved per their own fixture. Note the differing local-var names: `host` in the server (Task 1) vs `hostPort` in the mock (Task 2) — both correct in context.
