# app-17 Deep-Link Pairing Launch Flip — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the companion pairing QR to a verified `https://www.castwright.ai/pair?…` deep link and host the `assetlinks.json` that lets a phone's stock camera auto-open the app and pair.

**Architecture:** Three surfaces across two repos. In **Castwright** (this repo): the server `/session` route **and the frontend mock** emit a deep-link URL instead of `CWP1*…`, and the Android manifest declares the verified hosts. In **Castwright-Website**: the Cloudflare Worker serves `assetlinks.json` (pinning the upload-key cert) plus a minimal `/pair` fallback page. The app-side parser already handles the URL form, so no Dart *logic* changes — only the manifest, plus regression-lock tests.

**Tech Stack:** TypeScript/Express + Vitest (server), React + Vitest + Playwright (frontend), Flutter/Dart + `flutter_test` (app), Astro + Vitest + Playwright (website), `qrcode` (QR density), Cloudflare Worker static assets.

## Global Constraints

- **Verified host = `www.castwright.ai`** (the served host; apex `castwright.ai` is a Porkbun 301-forward and cannot host `assetlinks.json` at 200/no-redirect).
- **Manifest declares BOTH** `www.castwright.ai` and `castwright.ai` (per-host verify, API 31+); only `www` is generated + verified at launch, apex sits dormant.
- **`assetlinks.json` pins the UPLOAD-key SHA-256 only** (`upload-keystore.jks`), in an **array**. The project uses **Google Play App Signing** (`apps/android/README.md`, plan 188): the upload key signs **sideloaded** APKs (today's beta), so acceptance must use a sideloaded install; the Play app-signing SHA is a *different* cert appended later.
- **Package name = `ai.castwright`** (matches release `applicationId`, no suffix).
- **Both the server (`pairing.ts`) AND the frontend mock (`src/lib/api.ts`) emit the payload.** Mock mode (`VITE_USE_MOCKS`, default in dev/e2e/screenshots) renders the **mock** string — both must flip identically or the shipped app keeps the old QR.
- **QR query params unchanged:** `h` = LAN `host:port`, `c` = code, `f` = fpTag. Built with `URLSearchParams` (encodes `:` → `%3A`).
- **Rollout ordering is load-bearing:** `assetlinks.json` must be live on `www` *before* the rebuilt APK is installed (verification caches failure). Tasks 6–7 deploy before Task 8 acceptance.
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

## Task 2: Frontend mock flip + consumer tests

**Repo:** Castwright (this repo, frontend)

**Why:** In mock mode (`VITE_USE_MOCKS`, the default for dev / e2e / marketing screenshots) the modal renders `mockCreatePairSession`'s payload, **not** the server's. Three existing tests hard-assert the old `CWP1*` string and go red after this flip; they are the paired coverage.

**Files:**
- Modify: `src/lib/api.ts:5574` (`mockCreatePairSession`)
- Test: `src/lib/api-pair-session.test.ts:19,42` (wire-contract, exact equality)
- Test: `src/modals/pair-device.test.tsx:11,36`
- Test: `src/components/listen/companion-app-banner.test.tsx:11`

**Interfaces:**
- Consumes: nothing new.
- Produces: `api.createPairSession()` resolves `qrPayload` of the same URL shape as Task 1.

- [ ] **Step 1: Update the failing wire-contract test**

In `src/lib/api-pair-session.test.ts`, change both `CWP1*…` literals (the input fixture at line 19 and the assertion at line 42) to:

```ts
'https://www.castwright.ai/pair?h=192.168.1.42%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'
```

(The mock's host is `192.168.1.42:8443`, code `K7QF3M2P`, fpTag `J4XQ2A7BWZ9K3M5R`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run src/lib/api-pair-session.test.ts`
Expected: FAIL — mock still returns `CWP1*192.168.1.42:8443*…`.

- [ ] **Step 3: Flip the mock**

In `src/lib/api.ts`, replace the `qrPayload` line in `mockCreatePairSession` (line 5574):

```ts
    qrPayload: `https://www.castwright.ai/pair?${new URLSearchParams({ h: hostPort, c: code, f: fpTag }).toString()}`,
```

- [ ] **Step 4: Run it to verify it passes**

Run: `npx vitest run src/lib/api-pair-session.test.ts`
Expected: PASS.

- [ ] **Step 5: Update the two other consumer tests**

In `src/modals/pair-device.test.tsx`, change both `qrPayload` literals (lines 11 and 36) from `'CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R'` to:

```ts
'https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=K7QF3M2P&f=J4XQ2A7BWZ9K3M5R'
```

In `src/components/listen/companion-app-banner.test.tsx`, change the `qrPayload` literal (line 11) from `'CWP1*192.168.86.20:8443*ABCD1234*TAGABC123'` to:

```ts
'https://www.castwright.ai/pair?h=192.168.86.20%3A8443&c=ABCD1234&f=TAGABC123'
```

- [ ] **Step 6: Run both suites to verify they pass**

Run: `npx vitest run src/modals/pair-device.test.tsx src/components/listen/companion-app-banner.test.tsx`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/api.ts src/lib/api-pair-session.test.ts src/modals/pair-device.test.tsx src/components/listen/companion-app-banner.test.tsx
git commit -m "feat(frontend): flip pairing mock to deep-link URL + update consumers (app-17)"
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

## Task 5: Android manifest dual-host + coverage

**Repo:** Castwright (this repo, `apps/android`)

**Files:**
- Modify: `apps/android/android/app/src/main/AndroidManifest.xml:42-50` (comment + the `autoVerify` intent-filter `<data>` element)
- Modify: `apps/android/test/domain/pairing_qr_test.dart` (add www URL case; update literals)
- Modify: `apps/android/test/main_deep_link_test.dart:35-36` (update apex literal for honesty)
- Create: `apps/android/test/android_manifest_test.dart` (lock both hosts)

**Interfaces:**
- Consumes: nothing new.
- Produces: a manifest whose `/pair` `autoVerify` filter declares `www.castwright.ai` and `castwright.ai`.

- [ ] **Step 1: Write the failing manifest guard test**

Create `apps/android/test/android_manifest_test.dart`:

```dart
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('manifest declares both pairing deep-link hosts with autoVerify', () {
    final xml = File('android/app/src/main/AndroidManifest.xml').readAsStringSync();
    expect(xml.contains('android:autoVerify="true"'), isTrue);
    expect(xml.contains('android:host="www.castwright.ai"'), isTrue);
    expect(xml.contains('android:host="castwright.ai"'), isTrue);
    expect(xml.contains('android:pathPrefix="/pair"'), isTrue);
  });
}
```

(`flutter test` runs with the package root `apps/android` as CWD — confirmed by the existing `brand_test.dart`, which reads `Directory('lib')` the same way.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd apps/android && flutter test test/android_manifest_test.dart`
Expected: FAIL — `www.castwright.ai` host not present.

- [ ] **Step 3: Add the `www` host to the manifest**

In `apps/android/android/app/src/main/AndroidManifest.xml`, the `autoVerify` intent-filter currently holds a **single 3-line `<data>` element** (`:48-50`):

```xml
                <data android:scheme="https"
                      android:host="castwright.ai"
                      android:pathPrefix="/pair"/>
```

Replace that 3-line element with two elements (www first):

```xml
                <data android:scheme="https"
                      android:host="www.castwright.ai"
                      android:pathPrefix="/pair"/>
                <data android:scheme="https"
                      android:host="castwright.ai"
                      android:pathPrefix="/pair"/>
```

Then update the comment above the intent-filter (`:42`) so its assetlinks URL reads `https://www.castwright.ai/.well-known/assetlinks.json` and add: `castwright.ai is a dormant second host (apex 301-forwards today; per-host verify means it can't break www).`

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

- [ ] **Step 6: Run the parser + deep-link suites to verify they pass**

Run: `cd apps/android && flutter test test/domain/pairing_qr_test.dart test/main_deep_link_test.dart`
Expected: PASS (all cases).

- [ ] **Step 7: Commit**

```bash
git add apps/android/android/app/src/main/AndroidManifest.xml apps/android/test/domain/pairing_qr_test.dart apps/android/test/main_deep_link_test.dart apps/android/test/android_manifest_test.dart
git commit -m "feat(app): verify both www + apex pairing deep-link hosts (app-17)"
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
- Create: `src/pages/pair.astro`
- Modify: `e2e/pages.spec.ts` (add `/pair` to the route table)

**Interfaces:**
- Consumes: existing `Base` layout + `SectionHeading` component (mirrors `download.astro`; no `URLS` import needed — the download link is a literal `/download`).
- Produces: a static `/pair` page rendering an `<h1>` "Pair your phone".

- [ ] **Step 1: Add the failing e2e route assertion**

In `e2e/pages.spec.ts`, add to the `pages` array (generates the test title `"/pair renders its h1"`):

```ts
  { path: '/pair', h1: /pair your phone/i },
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx playwright test e2e/pages.spec.ts --project=chromium -g "/pair renders"`
Expected: FAIL — `/pair` 404s (page doesn't exist yet).

- [ ] **Step 3: Create the page**

Create `src/pages/pair.astro`:

```astro
---
import Base from '@/layouts/Base.astro'
import SectionHeading from '@/components/SectionHeading.astro'
---

<Base
  title="Pair your phone — Castwright"
  description="Pair the Castwright companion app with your library. Install the app, then scan the pairing code from inside it."
>
  <div class="max-w-2xl">
    <SectionHeading as="h1">Pair your phone</SectionHeading>
    <p class="mt-4">
      To pair, install the <b class="text-magenta">Castwright</b> companion app, then
      open it and scan the pairing code from inside the app.
    </p>
    <p class="mt-4">
      Scanning from your phone's normal camera only works once the app is installed and
      its link is verified — until then, use the in-app scanner.
    </p>
    <a class="mt-6 inline-block underline" href="/download">Get the companion app →</a>
  </div>
</Base>
```

(`SectionHeading` renders `<Tag>` from its `as` prop, so `as="h1"` emits a real `<h1>`. No JS, no query-param handling — the LAN host + ephemeral code are useless on the public web.)

- [ ] **Step 4: Run the e2e to verify it passes**

Run: `npx playwright test e2e/pages.spec.ts --project=chromium -g "/pair renders"`
Expected: PASS (the webServer config rebuilds + previews).

- [ ] **Step 5: Commit**

```bash
git add src/pages/pair.astro e2e/pages.spec.ts
git commit -m "feat: minimal /pair fallback page for unverified scans (app-17)"
```

---

## Task 8: Deploy, rebuild, on-device acceptance (delivery — not code)

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
Expected: green (typecheck + all tests + e2e + build). Then merge `feat/app-17-deeplink-pairing-launch`.

- [ ] **Step 4: Rebuild + SIDELOAD the signed release APK**

Build the release APK signed with `upload-keystore.jks` (whose SHA-256 is in `assetlinks.json`), **sideload-install** it on an Android 16 / API 36 device (NOT a Play-track install — Play re-signs), then reboot or:

```bash
adb shell pm verify-app-links --re-verify ai.castwright
adb shell pm get-app-links ai.castwright
```
Expected: `www.castwright.ai → verified`. (`castwright.ai` may show non-verified — expected/dormant.)

- [ ] **Step 5: End-to-end stock-camera pair**

Start the desktop server in LAN HTTPS mode (`npm run dev:lan` or `start:lan`), open the pairing modal, scan the QR with the phone's **stock camera** → app opens → pairs. Record the `pm get-app-links` output in issue #729.

- [ ] **Step 6: Close out (CLAUDE.md before-shipping checklist)**

- `Closes #729` in the website PR or the app PR; remove its row from `docs/BACKLOG.md`.
- Set the spec `status:` to `stable`, fill Ship notes (date + SHAs).
- Update `docs/features/INDEX.md` if the spec/plan is indexed there.
- Fix the stale apex assetlinks URLs in `docs/features/208-pairing-qr-mlkit-decoder.md` (lines ~18, ~32) to `www.castwright.ai`.
- Note in the BACKLOG/issue that the **Play App Signing SHA-256** is still owed when Play distribution lands (append to the `assetlinks.json` array).

---

## Self-Review

**Spec coverage:**
- Server payload flip → Task 1 ✓
- Frontend mock flip + 3 red consumer tests → Task 2 ✓
- Density re-anchor (measured v5/v9) → Task 3 ✓
- e2e stale-comment refresh; URL prefix locked by Task 2 unit test (QR is opaque PNG) → Task 4 ✓
- Manifest dual-host + Dart host-agnostic lock + main_deep_link literal → Task 5 ✓
- assetlinks.json (upload-key cert, array) + content-type → Task 6 ✓
- /pair fallback page → Task 7 ✓
- Rollout ordering + sideloaded on-device acceptance + curl/pm + doc close-out → Task 8 ✓
- Out-of-scope (Play SHA, apex move) → Global Constraints + Task 8 ✓

**Placeholder scan:** The only fill-at-build value is the SHA-256 in Task 6 Step 3, with an explicit derivation command (Step 1) and a format-validating test (Step 2); the dummy fingerprint is replaced in the same step. No conditional/deferred steps remain (the Task 4 `alt`-attribute branch was resolved away — the QR is an opaque PNG, so the URL prefix is locked by Task 2's unit test instead).

**Type/name consistency:** `qrPayload` URL shape identical across Task 1 (server impl + test), Task 2 (mock + 3 tests), and Task 3 (density). `package_name: "ai.castwright"` matches the manifest `applicationId` and the Dart guard. Host literals `www.castwright.ai` consistent across Tasks 1–7. Mock host `192.168.1.42` / `pair-device` host `192.168.1.5` / banner host `192.168.86.20` each preserved per their own fixture.
