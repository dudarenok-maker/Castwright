# Pairing-QR Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Shrink the companion pairing QR from v10 (57×57, undecodable by flutter_zxing off a screen) to ~v3 (29×29) by moving the token + full fingerprint off the QR, replacing them with an ephemeral pairing code + an 80-bit fingerprint tag — without weakening the security model.

**Architecture:** The QR carries `CWP1*host:port*code*fpTag`. The server mints an ephemeral `code` + computes `fpTag` (first 10 bytes of the CA SHA-256, Crockford-base32) via a loopback-only `POST /api/pair/session`; it mints a per-device token only when the app redeems the code over `POST /api/pair/redeem` (guard-exempt, code-gated). The app verifies the fetched cert against `fpTag` before pinning, then redeems over the pinned channel.

**Tech Stack:** Node/Express + Vitest (server), Vite/React/RTK + Vitest/RTL (frontend), Flutter/Dart + flutter_test (app), `qrcode` (render), `flutter_zxing` (scan), `zxing-wasm` (decode regression test).

**Spec:** `docs/superpowers/specs/2026-06-10-pairing-qr-redesign-design.md`

**Worktree:** `C:\Claude\wt-pairing-qr` on branch `feat/pairing-qr-redesign`.

---

## File Structure

**Server (`server/src/`)**
- Create `lib/crockford-base32.ts` — encode-only Crockford base32 (shared by code + fpTag). One responsibility: byte[] → base32 string.
- Create `workspace/pairing-sessions.ts` — in-memory ephemeral pairing-code store (create / redeem / expiry / single-use).
- Create `routes/pairing.ts` — exports `pairSessionRouter` (POST /session, loopback) + `pairRedeemRouter` (POST /redeem, guard-exempt). Computes `fpTag`, builds the QR payload, calls `createDevice` on redeem.
- Modify `routes/index` wiring in `index.ts` — mount redeem before the LAN guard, session after.
- Tests: `lib/crockford-base32.test.ts`, `workspace/pairing-sessions.test.ts`, `routes/pairing.test.ts`.

**Frontend (`src/`)**
- Modify `lib/types.ts` — add `PairSessionInfo`.
- Modify `lib/api.ts` — add `createPairSession()`.
- Modify `modals/pair-device.tsx` — fetch `/session`, render the compact QR larger/white/crisp, countdown, manual fields, regenerate.
- Tests: `modals/pair-device.test.tsx` (update).

**App (`apps/android/lib/src/`)**
- Create `domain/pairing_qr.dart` — `PairingQr` value type + `CWP1*…` parser.
- Create `data/crockford_base32.dart` — encode-only Crockford base32 (mirror of the server helper).
- Modify `data/cert_pinning.dart` — add `fingerprintTagMatches(pem, tag)`.
- Modify `data/pairing_service.dart` — redeem flow (verify tag → redeem code over pinned client → token).
- Modify `ui/qr_scan_screen.dart` — return `PairingQr` instead of `PairedServer`.
- Modify `ui/pairing_screen.dart` — host/code/fpTag fields + run the redeem flow.
- Modify `domain/paired_server.dart` — remove `fromQrPayload` (JSON `fromJson` for storage stays).
- Tests: `test/domain/pairing_qr_test.dart`, `test/data/crockford_base32_test.dart`, `test/data/cert_pinning_test.dart` (extend), `test/data/pairing_service_test.dart` (rewrite), `test/ui/pairing_screen_test.dart` (update), `test/ui/qr_scan_screen_test.dart` (update).

**Regression**
- Create `apps/android` or server-side decode test proving the new QR round-trips through zxing (Task 12).

---

## Task 1: Crockford base32 encode helper (server)

**Files:**
- Create: `server/src/lib/crockford-base32.ts`
- Test: `server/src/lib/crockford-base32.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest';
import { crockfordBase32 } from './crockford-base32.js';

describe('crockfordBase32', () => {
  it('encodes 10 bytes to 16 chars (80 bits / 5)', () => {
    const bytes = Buffer.from('00112233445566778899', 'hex');
    expect(crockfordBase32(bytes)).toHaveLength(16);
  });

  it('encodes 5 bytes to 8 chars (40 bits / 5)', () => {
    expect(crockfordBase32(Buffer.from('0000000000', 'hex'))).toBe('00000000');
  });

  it('uses the Crockford alphabet (no I L O U, upper-case)', () => {
    // 0xFF repeated → all-ones nibbles map to the top of the alphabet
    const out = crockfordBase32(Buffer.from('ffffffffff', 'hex'));
    expect(out).toBe('ZZZZZZZZ');
    expect(out).not.toMatch(/[ILOU]/);
  });

  it('is deterministic and stable for a known vector', () => {
    // bytes 0x01 0x02 0x03 0x04 0x05 => 5 bytes => 8 chars
    expect(crockfordBase32(Buffer.from('0102030405', 'hex'))).toBe('0420C205');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/lib/crockford-base32.test.ts`
Expected: FAIL — "Cannot find module './crockford-base32.js'".

- [ ] **Step 3: Write minimal implementation**

```ts
/* Crockford base32 (no padding) — encode-only. Used for the ephemeral pairing
   code and the 80-bit CA fingerprint tag in the companion pairing QR. Output is
   a subset of QR alphanumeric mode, so the QR stays in its densest encoding.
   Alphabet excludes I, L, O, U to avoid visual ambiguity in manual entry. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function crockfordBase32(bytes: Uint8Array): string {
  let out = '';
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(buffer >>> bits) & 0x1f];
    }
  }
  if (bits > 0) {
    out += ALPHABET[(buffer << (5 - bits)) & 0x1f];
  }
  return out;
}
```

> Note: 10 bytes (80 bits) and 5 bytes (40 bits) are both exact multiples of 5,
> so the trailing-bits branch never pads for our two real inputs.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/lib/crockford-base32.test.ts`
Expected: PASS (4 tests). If the known-vector in Step 1 differs from your encoder, compute the real value once with a scratch node REPL and lock it in — do not change the algorithm to match a guessed constant.

- [ ] **Step 5: Commit**

```bash
git add server/src/lib/crockford-base32.ts server/src/lib/crockford-base32.test.ts
git commit -m "feat(server): Crockford base32 encoder for pairing code + fp tag"
```

---

## Task 2: Ephemeral pairing-session store (server)

**Files:**
- Create: `server/src/workspace/pairing-sessions.ts`
- Test: `server/src/workspace/pairing-sessions.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import {
  createPairingSession,
  redeemPairingSession,
  _resetPairingSessionsForTests,
} from './pairing-sessions.js';

describe('pairing-sessions', () => {
  beforeEach(() => _resetPairingSessionsForTests());

  it('creates a session with an 8-char code and future expiry', () => {
    const now = 1_000_000;
    const s = createPairingSession(now);
    expect(s.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(s.expiresAt).toBeGreaterThan(now);
  });

  it('redeems a valid code exactly once', () => {
    const now = 1_000_000;
    const { code } = createPairingSession(now);
    expect(redeemPairingSession(code, now + 1)).toEqual({ ok: true });
    // second redemption fails (single-use)
    expect(redeemPairingSession(code, now + 2)).toEqual({ ok: false, reason: 'consumed' });
  });

  it('rejects an unknown code', () => {
    expect(redeemPairingSession('ZZZZZZZZ', 1)).toEqual({ ok: false, reason: 'unknown' });
  });

  it('rejects an expired code', () => {
    const now = 1_000_000;
    const { code, expiresAt } = createPairingSession(now);
    expect(redeemPairingSession(code, expiresAt + 1)).toEqual({ ok: false, reason: 'expired' });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/pairing-sessions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
/* In-memory ephemeral pairing sessions for the companion QR redesign.

   A session is a single-use, time-boxed `code` that authorises minting ONE
   per-device token via POST /api/pair/redeem. We deliberately persist nothing:
   a pre-auth secret should never hit disk, and losing pending sessions on a
   restart is harmless (re-open the desktop modal). `now` is injected so the
   store is unit-testable without a clock. */
import { randomBytes } from 'node:crypto';
import { crockfordBase32 } from '../lib/crockford-base32.js';

const TTL_MS = 5 * 60 * 1000; // 5 minutes

interface Session {
  expiresAt: number;
  consumed: boolean;
}

const sessions = new Map<string, Session>();

function sweep(now: number): void {
  for (const [code, s] of sessions) {
    if (s.consumed || now > s.expiresAt) sessions.delete(code);
  }
}

export interface NewPairingSession {
  code: string;
  expiresAt: number;
}

export function createPairingSession(now: number = Date.now()): NewPairingSession {
  sweep(now);
  // 5 bytes = 40 bits => 8 Crockford chars.
  const code = crockfordBase32(randomBytes(5));
  const expiresAt = now + TTL_MS;
  sessions.set(code, { expiresAt, consumed: false });
  return { code, expiresAt };
}

export type RedeemResult =
  | { ok: true }
  | { ok: false; reason: 'unknown' | 'expired' | 'consumed' };

export function redeemPairingSession(code: string, now: number = Date.now()): RedeemResult {
  const s = sessions.get(code);
  if (!s) return { ok: false, reason: 'unknown' };
  if (s.consumed) return { ok: false, reason: 'consumed' };
  if (now > s.expiresAt) {
    sessions.delete(code);
    return { ok: false, reason: 'expired' };
  }
  s.consumed = true;
  return { ok: true };
}

export function _resetPairingSessionsForTests(): void {
  sessions.clear();
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/workspace/pairing-sessions.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/pairing-sessions.ts server/src/workspace/pairing-sessions.test.ts
git commit -m "feat(server): in-memory ephemeral pairing-session store"
```

---

## Task 3: Pairing routes + fpTag + wiring (server)

**Files:**
- Create: `server/src/routes/pairing.ts`
- Modify: `server/src/index.ts` (mount redeem before the LAN guard at line ~176; mount session after)
- Test: `server/src/routes/pairing.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { pairSessionRouter, pairRedeemRouter } from './pairing.js';
import { _resetPairingSessionsForTests } from '../workspace/pairing-sessions.js';

// Force LAN-HTTPS mode + a resolvable CA fingerprint for the session route.
vi.mock('./export-lan.js', async (orig) => {
  const real = await orig<typeof import('./export-lan.js')>();
  return {
    ...real,
    isLanHttpsEnabled: () => true,
    enumerateLanUrls: () => ({ urls: ['https://192.168.1.5:8443'], port: 8443, protocol: 'https' as const }),
  };
});
vi.mock('./cert-root.js', () => ({
  resolveRootCaPath: () => ({ path: 'FAKE', source: 'default' as const }),
}));
// Stub the cert read so fpTag is deterministic.
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return { ...real, readFileSync: (p: string, ...rest: unknown[]) =>
    p === 'FAKE' ? Buffer.from(TEST_CERT_PEM) : (real.readFileSync as any)(p, ...rest) };
});

// A self-signed test cert (PEM). Generate once with:
//   openssl req -x509 -newkey ed25519 -nodes -days 1 -subj "/CN=t" -keyout /dev/null -out cert.pem
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
<PASTE A REAL SHORT TEST CERT — see Step 1 note>
-----END CERTIFICATE-----`;

function appWith(router: express.Router, base = '/api/pair') {
  const app = express();
  app.use(express.json());
  app.use(base, router);
  return app;
}

describe('pairing routes', () => {
  beforeEach(() => _resetPairingSessionsForTests());

  it('POST /session returns a qrPayload + code + fpTag (loopback)', async () => {
    const res = await request(appWith(pairSessionRouter)).post('/api/pair/session').send({});
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(res.body.fpTag).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(res.body.qrPayload).toBe(`CWP1*192.168.1.5:8443*${res.body.code}*${res.body.fpTag}`);
    expect(res.body.expiresAt).toBeGreaterThan(0);
  });

  it('POST /redeem mints a token for a fresh code, then 410 on reuse', async () => {
    const session = await request(appWith(pairSessionRouter)).post('/api/pair/session').send({});
    const redeem = appWith(pairRedeemRouter);
    const first = await request(redeem).post('/api/pair/redeem').send({ code: session.body.code, label: 'Pixel' });
    expect(first.status).toBe(201);
    expect(typeof first.body.token).toBe('string');
    expect(first.body.token.length).toBeGreaterThan(0);
    const second = await request(redeem).post('/api/pair/redeem').send({ code: session.body.code });
    expect(second.status).toBe(410);
  });

  it('POST /redeem 401s an unknown code', async () => {
    const res = await request(appWith(pairRedeemRouter)).post('/api/pair/redeem').send({ code: 'ZZZZZZZZ' });
    expect(res.status).toBe(401);
  });
});
```

> Step 1 note: replace `<PASTE A REAL SHORT TEST CERT>` with an actual PEM block
> (the test only needs the cert to parse + hash). Generate one and paste it; do
> NOT leave the placeholder. The `createDevice` call writes to the workspace —
> rely on the existing test workspace setup used by other `routes/*.test.ts`
> files (check `server/vitest.config.ts` / `setup` for the tmp workspace), or
> mock `../workspace/device-tokens.js`'s `createDevice` to return
> `{ device: { id: 'd1' }, token: 'tok_abc' }` for hermeticity. Prefer the mock.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: FAIL — module `./pairing.js` not found.

- [ ] **Step 3: Write minimal implementation**

```ts
/* Companion pairing routes (QR redesign).

   POST /api/pair/session  — loopback-only (the desktop UI). Mints an ephemeral
     code, computes the 80-bit CA fingerprint tag, and returns the compact QR
     payload string the modal renders. Mints NO device token.
   POST /api/pair/redeem   — guard-exempt (an unpaired device holds only the
     code, not a LAN token). Gated by the code; mints a per-device token over
     the caller's already-cert-pinned channel.

   The redeem router MUST be mounted BEFORE the `/api` LAN-token guard in
   index.ts; the session router AFTER it. */
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { isLanHttpsEnabled, enumerateLanUrls } from './export-lan.js';
import { resolveRootCaPath } from './cert-root.js';
import { crockfordBase32 } from '../lib/crockford-base32.js';
import { createPairingSession, redeemPairingSession } from '../workspace/pairing-sessions.js';
import { createDevice } from '../workspace/device-tokens.js';
import { isLoopbackRequest } from '../lan-auth.js';

/** First 10 bytes (80 bits) of the CA cert's SHA-256, Crockford-base32. */
export function caFingerprintTag(): string | undefined {
  try {
    const ca = resolveRootCaPath();
    if (!ca) return undefined;
    const hex = new X509Certificate(readFileSync(ca.path)).fingerprint256; // "AB:CD:.."
    const bytes = Buffer.from(hex.replace(/:/g, ''), 'hex'); // 32 bytes
    return crockfordBase32(bytes.subarray(0, 10)); // 16 chars
  } catch {
    return undefined;
  }
}

export const pairSessionRouter = Router();

pairSessionRouter.post('/session', (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: 'Pairing sessions can only be created from the host UI.' });
    return;
  }
  if (!isLanHttpsEnabled()) {
    res.status(409).json({ error: 'not-lan-https' });
    return;
  }
  const { urls, port } = enumerateLanUrls(Number(process.env.LAN_HTTPS_PORT ?? 8443), 'https');
  const host = urls[0]?.replace(/^https:\/\//, '');
  const fpTag = caFingerprintTag();
  if (!host || !fpTag) {
    res.status(409).json({ error: !host ? 'no-lan-url' : 'no-ca' });
    return;
  }
  const { code, expiresAt } = createPairingSession();
  const qrPayload = `CWP1*${host}*${code}*${fpTag}`;
  res.json({ qrPayload, hostPort: host, port, code, fpTag, expiresAt });
});

export const pairRedeemRouter = Router();

pairRedeemRouter.post('/redeem', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as { code?: unknown; label?: unknown };
  const code = typeof body.code === 'string' ? body.code : '';
  const label = typeof body.label === 'string' ? body.label : 'Device';
  const result = redeemPairingSession(code);
  if (!result.ok) {
    const status = result.reason === 'unknown' ? 401 : 410;
    res.status(status).json({ error: result.reason });
    return;
  }
  const { token } = await createDevice(label);
  res.status(201).json({ token });
});
```

- [ ] **Step 4: Wire into `index.ts`**

Find the LAN guard line (`app.use(['/api', '/workspace'], requireLanToken);`, ~line 176). Add the import near the other route imports (~line 72):

```ts
import { pairSessionRouter, pairRedeemRouter } from './routes/pairing.js';
```

Mount the **redeem** router BEFORE the guard (so it's reachable without a token), immediately above the `requireLanToken` line:

```ts
app.use('/api/pair', pairRedeemRouter); // QR pairing — code-gated, intentionally pre-guard
app.use(['/api', '/workspace'], requireLanToken);
```

Mount the **session** router AFTER the guard, near the other `/api` mounts (e.g. just after the `devicesRouter` mount, ~line 192):

```ts
app.use('/api/pair', pairSessionRouter); // QR pairing — loopback-only session mint (post-guard)
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: PASS (3 tests).
Run: `cd server && npx tsc --noEmit` (confirm index.ts wiring type-checks).
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/pairing.ts server/src/routes/pairing.test.ts server/src/index.ts
git commit -m "feat(server): /api/pair session + redeem routes for QR pairing"
```

---

## Task 4: Frontend API + types (`createPairSession`)

**Files:**
- Modify: `src/lib/types.ts` (add `PairSessionInfo`)
- Modify: `src/lib/api.ts` (add `createPairSession`)
- Test: `src/lib/api.mock-state.test.ts` or a focused `src/lib/api.test.ts` (follow the file the repo uses for `getExportLanUrls`)

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { api } from './api';

describe('api.createPairSession', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('POSTs /api/pair/session and returns the payload', async () => {
    const info = {
      qrPayload: 'CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R',
      hostPort: '192.168.1.5:8443', port: 8443,
      code: 'K7QF3M2P', fpTag: 'J4XQ2A7BWZ9K3M5R', expiresAt: 99,
    };
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(info), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    await expect(api.createPairSession()).resolves.toEqual(info);
  });
});
```

> Adjust the import/mocking to match how the repo's existing `getExportLanUrls`
> test stubs the transport (some tests mock the real client, not global fetch).
> Mirror that file's pattern exactly.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api.mock-state.test.ts`
Expected: FAIL — `api.createPairSession is not a function`.

- [ ] **Step 3: Add the type + the method**

In `src/lib/types.ts`:

```ts
/** Result of POST /api/pair/session — the companion pairing QR payload + the
    fields the modal also shows for manual entry. */
export interface PairSessionInfo {
  qrPayload: string;
  hostPort: string;
  port: number;
  code: string;
  fpTag: string;
  expiresAt: number;
}
```

In `src/lib/api.ts`, add to BOTH the `mock` and `real` API objects (mirror how
`getExportLanUrls` is defined in each). Real:

```ts
async createPairSession(): Promise<PairSessionInfo> {
  const res = await fetch('/api/pair/session', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  if (!res.ok) throw new Error(`pair session failed: ${res.status}`);
  return (await res.json()) as PairSessionInfo;
},
```

Mock (returns a deterministic fake so the modal renders in mock mode):

```ts
async createPairSession(): Promise<PairSessionInfo> {
  const code = 'K7QF3M2P';
  const fpTag = 'J4XQ2A7BWZ9K3M5R';
  const hostPort = '192.168.1.5:8443';
  return { qrPayload: `CWP1*${hostPort}*${code}*${fpTag}`, hostPort, port: 8443, code, fpTag, expiresAt: Date.now() + 300000 };
},
```

Import `PairSessionInfo` where the other type imports live.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api.mock-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/types.ts src/lib/api.ts src/lib/api.mock-state.test.ts
git commit -m "feat(frontend): api.createPairSession + PairSessionInfo type"
```

---

## Task 5: Rewrite the pair-device modal

**Files:**
- Modify: `src/modals/pair-device.tsx`
- Test: `src/modals/pair-device.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { PairDeviceModal } from './pair-device';
import { api } from '../lib/api';

describe('PairDeviceModal (QR redesign)', () => {
  beforeEach(() => vi.restoreAllMocks());

  it('renders the compact QR from the session payload', async () => {
    vi.spyOn(api, 'createPairSession').mockResolvedValue({
      qrPayload: 'CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R',
      hostPort: '192.168.1.5:8443', port: 8443,
      code: 'K7QF3M2P', fpTag: 'J4XQ2A7BWZ9K3M5R', expiresAt: Date.now() + 300000,
    });
    render(<PairDeviceModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pair-qr-image')).toBeInTheDocument());
    // manual-entry fields
    expect(screen.getByText('192.168.1.5:8443')).toBeInTheDocument();
    expect(screen.getByText('K7QF3M2P')).toBeInTheDocument();
  });

  it('shows the unavailable state when the session 409s', async () => {
    vi.spyOn(api, 'createPairSession').mockRejectedValue(new Error('pair session failed: 409'));
    render(<PairDeviceModal open onClose={() => {}} />);
    await waitFor(() => expect(screen.getByTestId('pair-device-unavailable')).toBeInTheDocument());
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/modals/pair-device.test.tsx`
Expected: FAIL — modal still calls `getExportLanUrls` / asserts old structure.

- [ ] **Step 3: Rewrite the modal**

Replace the data-fetch + payload logic. Key changes (keep the existing JSX shell,
`CopyRow`, and the header):

```tsx
import { useEffect, useMemo, useState } from 'react';
import QRCode from 'qrcode';
import { api } from '../lib/api';
import type { PairSessionInfo } from '../lib/types';
// (icons import unchanged)

export function PairDeviceModal({ open, onClose }: PairDeviceModalProps) {
  const [info, setInfo] = useState<PairSessionInfo | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'unavailable' | 'error'>('loading');
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0); // bump to regenerate

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setStatus('loading');
    setQrDataUrl(null);
    api.createPairSession()
      .then((r) => { if (!cancelled) { setInfo(r); setStatus('ready'); } })
      .catch((e: Error) => {
        if (cancelled) return;
        // 409 == not LAN-HTTPS / no CA → explain how to enable; else generic error
        setStatus(/\b409\b/.test(e.message) ? 'unavailable' : 'error');
      });
    return () => { cancelled = true; };
  }, [open, nonce]);

  useEffect(() => {
    if (status !== 'ready' || !info) { setQrDataUrl(null); return; }
    let cancelled = false;
    QRCode.toDataURL(info.qrPayload, { margin: 4, scale: 8, errorCorrectionLevel: 'M' })
      .then((d) => { if (!cancelled) setQrDataUrl(d); })
      .catch(() => { if (!cancelled) setQrDataUrl(null); });
    return () => { cancelled = true; };
  }, [status, info]);

  if (!open) return null;
  // ... render: 'loading' | 'error' | 'unavailable' (existing copy) | 'ready'
}
```

For the `ready` branch render the QR on **white**, larger, crisp, no rounded
corners on the code itself:

```tsx
<div className="grid place-items-center">
  <div className="bg-white p-3 rounded-2xl border border-ink/10">
    {qrDataUrl ? (
      <img
        src={qrDataUrl}
        alt="Pairing QR code"
        data-testid="pair-qr-image"
        width={288}
        height={288}
        className="block w-72 h-72"
        style={{ imageRendering: 'pixelated' }}
      />
    ) : (
      <div className="w-72 h-72 grid place-items-center text-ink/40">Generating…</div>
    )}
  </div>
</div>
```

Manual-entry `<details>` uses the new fields:

```tsx
<CopyRow label="Server" value={info.hostPort} mono />
<CopyRow label="Pairing code" value={info.code} mono />
<CopyRow label="Fingerprint tag" value={info.fpTag} mono />
```

Add a "Regenerate code" button in the ready branch: `onClick={() => setNonce((n) => n + 1)}`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/modals/pair-device.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/modals/pair-device.tsx src/modals/pair-device.test.tsx
git commit -m "feat(frontend): pair-device modal renders compact QR from /pair/session"
```

---

## Task 6: App — `PairingQr` parser

**Files:**
- Create: `apps/android/lib/src/domain/pairing_qr.dart`
- Test: `apps/android/test/domain/pairing_qr_test.dart`

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/domain/pairing_qr.dart';

void main() {
  test('parses a valid CWP1 payload', () {
    final qr = PairingQr.parse('CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R');
    expect(qr.baseUrl, 'https://192.168.1.5:8443');
    expect(qr.code, 'K7QF3M2P');
    expect(qr.fpTag, 'J4XQ2A7BWZ9K3M5R');
  });

  test('rejects wrong magic', () {
    expect(() => PairingQr.parse('XXXX*h:1*c*t'), throwsFormatException);
  });

  test('rejects wrong arity / empty field', () {
    expect(() => PairingQr.parse('CWP1*h:1*c'), throwsFormatException);
    expect(() => PairingQr.parse('CWP1**c*t'), throwsFormatException);
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && flutter test test/domain/pairing_qr_test.dart`
Expected: FAIL — `pairing_qr.dart` not found.

- [ ] **Step 3: Write minimal implementation**

```dart
/// Parsed companion pairing QR (`CWP1*host:port*code*fpTag`). Pure data, no
/// platform deps — fully unit-testable. Replaces the old JSON QR payload.
class PairingQr {
  const PairingQr({required this.hostPort, required this.code, required this.fpTag});

  final String hostPort;
  final String code;
  final String fpTag;

  String get baseUrl => 'https://$hostPort';

  factory PairingQr.parse(String raw) {
    final parts = raw.split('*');
    if (parts.length != 4 || parts[0] != 'CWP1') {
      throw const FormatException('not a CWP1 pairing payload');
    }
    final hostPort = parts[1], code = parts[2], fpTag = parts[3];
    if (hostPort.isEmpty || code.isEmpty || fpTag.isEmpty) {
      throw const FormatException('pairing payload has an empty field');
    }
    return PairingQr(hostPort: hostPort, code: code, fpTag: fpTag);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/android && flutter test test/domain/pairing_qr_test.dart`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/domain/pairing_qr.dart apps/android/test/domain/pairing_qr_test.dart
git commit -m "feat(app): PairingQr parser for the compact CWP1 pairing payload"
```

---

## Task 7: App — Crockford base32 + `fingerprintTagMatches`

**Files:**
- Create: `apps/android/lib/src/data/crockford_base32.dart`
- Modify: `apps/android/lib/src/data/cert_pinning.dart`
- Test: `apps/android/test/data/crockford_base32_test.dart`, extend `apps/android/test/data/cert_pinning_test.dart`

- [ ] **Step 1: Write the failing tests**

```dart
// crockford_base32_test.dart
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/crockford_base32.dart';

void main() {
  test('matches the server vector', () {
    expect(crockfordBase32([0x01, 0x02, 0x03, 0x04, 0x05]), '0420C205');
  });
  test('all-ones 5 bytes => ZZZZZZZZ', () {
    expect(crockfordBase32([0xff, 0xff, 0xff, 0xff, 0xff]), 'ZZZZZZZZ');
  });
}
```

```dart
// add to cert_pinning_test.dart
import 'package:castwright/src/data/crockford_base32.dart';
import 'dart:convert';
import 'package:crypto/crypto.dart';

test('fingerprintTagMatches accepts the first-10-byte tag of the cert', () {
  // Build the expected tag from the same PEM used elsewhere in this file.
  final der = pemToDer(testPem); // reuse the file's existing test PEM constant
  final digest = sha256.convert(der).bytes;
  final tag = crockfordBase32(digest.sublist(0, 10));
  expect(fingerprintTagMatches(testPem, tag), isTrue);
  expect(fingerprintTagMatches(testPem, tag.toLowerCase()), isTrue); // case-insensitive
  expect(fingerprintTagMatches(testPem, 'Z' * 16), isFalse);
});
```

> If `cert_pinning_test.dart` has no shared `testPem`, add a small valid PEM
> constant at the top of the test file (any cert that base64-decodes); the test
> only hashes it.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/android && flutter test test/data/crockford_base32_test.dart test/data/cert_pinning_test.dart`
Expected: FAIL — `crockford_base32.dart` missing + `fingerprintTagMatches` undefined.

- [ ] **Step 3: Write the implementations**

`crockford_base32.dart` (mirror of the server encoder):

```dart
/// Crockford base32 (no padding), encode-only. Mirrors the server's
/// `crockford-base32.ts` so the companion can recompute the CA fingerprint tag
/// and compare it to the QR's `fpTag`. Alphabet excludes I, L, O, U.
const _alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

String crockfordBase32(List<int> bytes) {
  final out = StringBuffer();
  var buffer = 0, bits = 0;
  for (final byte in bytes) {
    buffer = (buffer << 8) | (byte & 0xff);
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out.write(_alphabet[(buffer >> bits) & 0x1f]);
    }
  }
  if (bits > 0) out.write(_alphabet[(buffer << (5 - bits)) & 0x1f]);
  return out.toString();
}
```

Add to `cert_pinning.dart`:

```dart
import 'crockford_base32.dart';

/// True when [tag] equals the Crockford-base32 of the first 10 bytes (80 bits)
/// of the certificate's SHA-256 — the QR's compact integrity tag. Case- and
/// separator-insensitive (the tag has no separators, but we normalise anyway).
bool fingerprintTagMatches(String pem, String tag) {
  final digest = sha256.convert(pemToDer(pem)).bytes;
  final expected = crockfordBase32(digest.sublist(0, 10));
  String norm(String s) => s.toUpperCase().replaceAll(RegExp('[^0-9A-Z]'), '');
  return norm(expected) == norm(tag);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/android && flutter test test/data/crockford_base32_test.dart test/data/cert_pinning_test.dart`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/crockford_base32.dart apps/android/lib/src/data/cert_pinning.dart apps/android/test/data/crockford_base32_test.dart apps/android/test/data/cert_pinning_test.dart
git commit -m "feat(app): Crockford base32 + fingerprintTagMatches for compact pairing"
```

---

## Task 8: App — redeem-based pairing flow

**Files:**
- Modify: `apps/android/lib/src/data/pairing_service.dart`
- Test: `apps/android/test/data/pairing_service_test.dart` (rewrite)

- [ ] **Step 1: Write the failing test**

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:castwright/src/data/pairing_service.dart';
import 'package:castwright/src/domain/pairing_qr.dart';

const _qr = 'CWP1*192.168.1.5:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R';
const _pem = '-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----'; // real short PEM

void main() {
  PairingQr qr() => PairingQr.parse(_qr);

  test('verifies tag, redeems code over pinned channel, returns token+full fp', () async {
    final svc = PairingService(
      fetchCa: (_) async => _pem,
      verifyTag: (_, __) => true, // inject tag check for hermeticity
      redeem: (baseUrl, code, caPem) async {
        expect(baseUrl, 'https://192.168.1.5:8443');
        expect(code, 'K7QF3M2P');
        return RedeemResult(token: 'tok_abc', caFingerprint: 'AB:CD:..');
      },
    );
    final conn = await svc.pair(qr(), label: 'Pixel');
    expect(conn.server.token, 'tok_abc');
    expect(conn.server.url, 'https://192.168.1.5:8443');
    expect(conn.caPem, _pem);
  });

  test('refuses on fingerprint-tag mismatch (MitM)', () async {
    final svc = PairingService(fetchCa: (_) async => _pem, verifyTag: (_, __) => false);
    expect(
      () => svc.pair(qr(), label: 'x'),
      throwsA(isA<PairingException>().having((e) => e.kind, 'kind', PairingErrorKind.fingerprintMismatch)),
    );
  });

  test('maps a 401/410 redeem to tokenRejected', () async {
    final svc = PairingService(
      fetchCa: (_) async => _pem, verifyTag: (_, __) => true,
      redeem: (_, __, ___) async => throw const RedeemRejected(),
    );
    expect(
      () => svc.pair(qr(), label: 'x'),
      throwsA(isA<PairingException>().having((e) => e.kind, 'kind', PairingErrorKind.tokenRejected)),
    );
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/android && flutter test test/data/pairing_service_test.dart`
Expected: FAIL — new signatures (`verifyTag`, `redeem`, `RedeemResult`, `pair(PairingQr,...)`) don't exist.

- [ ] **Step 3: Rewrite `pairing_service.dart`**

```dart
import 'dart:convert';
import 'dart:io';

import '../domain/paired_server.dart';
import '../domain/pairing_qr.dart';
import 'cert_pinning.dart';

enum PairingErrorKind { unreachable, fingerprintMismatch, tokenRejected, server }

class PairingException implements Exception {
  const PairingException(this.kind, this.message);
  final PairingErrorKind kind;
  final String message;
  @override
  String toString() => 'PairingException($kind): $message';
}

/// Thrown by a redeem fn when the server rejects the code (401/410).
class RedeemRejected implements Exception {
  const RedeemRejected();
}

class Connection {
  const Connection({required this.server, required this.caPem});
  final PairedServer server;
  final String caPem;
}

class RedeemResult {
  const RedeemResult({required this.token, required this.caFingerprint});
  final String token;
  final String caFingerprint; // full SHA-256, stored on PairedServer
}

typedef CaFetcher = Future<String> Function(String baseUrl);
typedef TagVerifier = bool Function(String caPem, String fpTag);
typedef CodeRedeemer = Future<RedeemResult> Function(String baseUrl, String code, String caPem);

class PairingService {
  PairingService({CaFetcher? fetchCa, TagVerifier? verifyTag, CodeRedeemer? redeem})
      : _fetchCa = fetchCa ?? _defaultFetchCa,
        _verifyTag = verifyTag ?? fingerprintTagMatches,
        _redeem = redeem ?? _defaultRedeem;

  final CaFetcher _fetchCa;
  final TagVerifier _verifyTag;
  final CodeRedeemer _redeem;

  Future<Connection> pair(PairingQr qr, {required String label}) async {
    String caPem;
    try {
      caPem = await _fetchCa(qr.baseUrl);
    } catch (e) {
      throw PairingException(PairingErrorKind.unreachable,
          'Could not reach the server to fetch its certificate ($e).');
    }
    if (!_verifyTag(caPem, qr.fpTag)) {
      throw const PairingException(PairingErrorKind.fingerprintMismatch,
          'The server certificate did not match the pairing code. Refusing to pair.');
    }
    RedeemResult r;
    try {
      r = await _redeem(qr.baseUrl, qr.code, caPem);
    } on RedeemRejected {
      throw const PairingException(PairingErrorKind.tokenRejected,
          'The server rejected the pairing code. Re-scan a fresh code.');
    } catch (e) {
      throw PairingException(PairingErrorKind.unreachable,
          'Certificate verified, but redeeming the code failed ($e).');
    }
    final server = PairedServer(url: qr.baseUrl, token: r.token, caFingerprint: r.caFingerprint);
    return Connection(server: server, caPem: caPem);
  }
}

Future<String> _defaultFetchCa(String baseUrl) async {
  final client = HttpClient()..badCertificateCallback = (_, __, ___) => true;
  try {
    final req = await client.getUrl(Uri.parse('$baseUrl/cert/root.crt'));
    final res = await req.close();
    return await res.transform(utf8.decoder).join();
  } finally {
    client.close(force: true);
  }
}

Future<RedeemResult> _defaultRedeem(String baseUrl, String code, String caPem) async {
  final ctx = SecurityContext(withTrustedRoots: false)
    ..setTrustedCertificatesBytes(utf8.encode(caPem));
  final client = HttpClient(context: ctx);
  try {
    final req = await client.postUrl(Uri.parse('$baseUrl/api/pair/redeem'));
    req.headers.contentType = ContentType.json;
    req.write(jsonEncode({'code': code, 'label': Platform.localHostname}));
    final res = await req.close();
    if (res.statusCode == 401 || res.statusCode == 410) throw const RedeemRejected();
    if (res.statusCode >= 400) throw HttpException('redeem status ${res.statusCode}');
    final body = jsonDecode(await res.transform(utf8.decoder).join()) as Map<String, dynamic>;
    final token = body['token'] as String;
    // Compute the FULL fingerprint from the verified cert for storage.
    return RedeemResult(token: token, caFingerprint: caFingerprintFromPem(caPem));
  } finally {
    client.close(force: true);
  }
}
```

> `caFingerprintFromPem` already exists in `cert_pinning.dart` (Task 7 file). The
> `label` param on `pair()` is threaded for symmetry but the default redeemer
> uses `Platform.localHostname`; the injected test redeemer ignores it. If you
> prefer the screen to pass the label, change `_defaultRedeem` to accept it via
> a closure in `pairing_screen.dart` instead — keep ONE source of the label.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/android && flutter test test/data/pairing_service_test.dart`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/android/lib/src/data/pairing_service.dart apps/android/test/data/pairing_service_test.dart
git commit -m "feat(app): redeem-based pairing flow (verify tag, redeem code, pin)"
```

---

## Task 9: App — wire scan + pairing screen

**Files:**
- Modify: `apps/android/lib/src/ui/qr_scan_screen.dart` (return `PairingQr`)
- Modify: `apps/android/lib/src/ui/pairing_screen.dart` (host/code/fpTag fields + redeem flow)
- Modify: `apps/android/lib/src/domain/paired_server.dart` (remove `fromQrPayload`)
- Test: update `apps/android/test/ui/qr_scan_screen_test.dart`, `apps/android/test/ui/pairing_screen_test.dart`

- [ ] **Step 1: Update the scan screen** — change the generic + parse:

```dart
import '../domain/pairing_qr.dart';
// ...
void _onScan(Code code) {
  if (_handled || !mounted) return;
  final raw = code.text;
  if (raw == null || raw.isEmpty) return;
  try {
    final qr = PairingQr.parse(raw);
    _handled = true;
    Navigator.of(context).pop(qr);
  } on FormatException {
    // not a pairing payload — keep scanning
  }
}
```

And the push type in `pairing_screen.dart` `_scan()` becomes `push<PairingQr>`.
The existing `qr_scan_screen_test.dart` (ReaderWidget config asserts) is unaffected
— keep it; just confirm it still compiles against the new import.

- [ ] **Step 2: Rewrite `pairing_screen.dart`** — replace the three controllers
with host/code/fpTag, and `_pair()` to build a `PairingQr` + call the new service:

```dart
Future<void> _pair() async {
  setState(() { _busy = true; _error = null; });
  try {
    final qr = PairingQr(
      hostPort: _host.text.trim(), code: _code.text.trim(), fpTag: _fpTag.text.trim());
    final conn = await widget.service.pair(qr, label: 'Companion');
    final stamped = conn.server.copyWith(pairedAt: DateTime.now().toIso8601String());
    await widget.store.save(stamped);
    await widget.store.saveCaPem(conn.caPem);
    if (mounted) Navigator.of(context).pop(stamped);
  } on PairingException catch (e) {
    setState(() => _error = e.message);
  } on FormatException catch (e) {
    setState(() => _error = e.message);
  } finally {
    if (mounted) setState(() => _busy = false);
  }
}

Future<void> _scan() async {
  final qr = await Navigator.of(context).push<PairingQr>(
    MaterialPageRoute(builder: (_) => const QrScanScreen()));
  if (qr != null && mounted) {
    setState(() { _host.text = qr.hostPort; _code.text = qr.code; _fpTag.text = qr.fpTag; _error = null; });
  }
}
```

Update the three `TextField`s to keys `field-host` / `field-code` / `field-fptag`
with labels "Server (host:port)", "Pairing code", "Fingerprint tag".

- [ ] **Step 3: Remove `fromQrPayload` from `paired_server.dart`** (the JSON
`fromJson`/`toJson` used by `PairingStore` STAY). Delete the now-unused `dart:convert`
import only if nothing else in the file uses it.

- [ ] **Step 4: Update the two UI tests** to drive host/code/fpTag fields and a
fake `PairingService` whose `pair(PairingQr,...)` returns a stub `Connection`.
Mirror the existing `pairing_screen_test.dart` structure.

- [ ] **Step 5: Run the app test suite**

Run: `cd apps/android && flutter test`
Expected: PASS (all suites, including the unchanged scanner-config + cert-pinning tests).

- [ ] **Step 6: Commit**

```bash
git add apps/android/lib/src/ui/qr_scan_screen.dart apps/android/lib/src/ui/pairing_screen.dart apps/android/lib/src/domain/paired_server.dart apps/android/test/ui/
git commit -m "feat(app): wire compact-QR scan + redeem into the pairing screen"
```

---

## Task 10: Lock-the-fix regression — decode the new QR through zxing

**Files:**
- Create: `apps/android/test/data/pairing_qr_decode_test.dart`

**Why:** This is the assertion that would have caught the original bug — it proves
the *new* QR is decodable by the same engine the app scans with.

- [ ] **Step 1: Write the test** (uses `flutter_zxing`'s still-image decode on a
generated QR; `qr_flutter` or the `qrcode` equivalent renders it to bytes). If a
Dart-side QR *generator* isn't already a dep, instead assert via a Node test using
`zxing-wasm` + `qrcode` (the harness already proven in this session under
`C:\Claude\qr-decode-test`), committed as `server`-adjacent tooling. Prefer the
Node approach to avoid adding a Flutter QR-gen dependency:

```js
// server/scripts/pairing-qr-decode.test.mjs (run via node --test or a tiny vitest)
import QRCode from 'qrcode';
import { readBarcodes } from 'zxing-wasm/reader';
import { test } from 'node:test';
import assert from 'node:assert';

test('compact CWP1 pairing QR decodes through zxing', async () => {
  const payload = 'CWP1*192.168.86.20:8443*K7QF3M2P*J4XQ2A7BWZ9K3M5R';
  const buf = await QRCode.toBuffer(payload, { margin: 4, scale: 8, errorCorrectionLevel: 'M' });
  const res = await readBarcodes(new Blob([buf], { type: 'image/png' }), { formats: ['QRCode'], tryHarder: true });
  assert.equal(res[0]?.text, payload);
});
```

> Add `zxing-wasm` as a server devDependency for this test, or keep the harness
> standalone and reference it from the plan's manual acceptance. Decide during
> execution based on whether the team wants it in CI; if in CI, wire it into
> `npm run test:server`.

- [ ] **Step 2: Run it**

Run: `cd server && node --test scripts/pairing-qr-decode.test.mjs` (or the vitest equivalent)
Expected: PASS — the v3 QR round-trips.

- [ ] **Step 3: Commit**

```bash
git add server/scripts/pairing-qr-decode.test.mjs server/package.json
git commit -m "test(server): regression — compact pairing QR decodes through zxing"
```

---

## Task 11: Full verify + docs

- [ ] **Step 1: Run the fast battery** (server + frontend)

Run: `npm run verify:quick`
Expected: green. Fix any fallout in the touched files only.

- [ ] **Step 2: Frontend e2e (optional but preferred for the modal)** — add a
Playwright spec `e2e/pair-device.spec.ts` that opens the modal in mock mode and
asserts `pair-qr-image` + the manual fields render. Run `npm run test:e2e -- pair-device`.

- [ ] **Step 3: Update the spec status + INDEX**

In `docs/superpowers/specs/2026-06-10-pairing-qr-redesign-design.md` set
`status: implemented`. Add a one-line entry to `docs/features/INDEX.md` if a
feature plan home is expected (the companion lives under plan 188 — link there).

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(docs): mark pairing-QR redesign spec implemented"
```

---

## Self-Review notes (author)

- **Spec coverage:** QR format (T6), server session+redeem+fpTag (T1–T3), guard
  exemption wiring (T3), frontend session+render (T4–T5), app parse+tag+redeem+UI
  (T6–T9), security (token only over pinned channel — T8 `_defaultRedeem`),
  compat (paired devices untouched; old `fromQrPayload` removed — T9), regression
  decode (T10), testing across all three tiers. ✓
- **Known execution caveats:** (a) the server route test needs a real PEM pasted
  and prefers mocking `createDevice` for hermeticity (called out in T3). (b) The
  Crockford known-vector `'0420C205'` in T1/T7 must be confirmed once with a
  scratch REPL and locked identically on both sides — do NOT let server + app
  drift. (c) Flutter tests require the local Flutter SDK (`C:\Users\dudar\flutter`).
- **Worktree husky:** commits run from the worktree — set up worktree-scoped
  hooks (`.husky-wt` + `git config --worktree core.hooksPath`) before the first
  code commit so `verify:fast:scoped` runs without `--no-verify`.
