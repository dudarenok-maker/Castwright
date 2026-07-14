# ops-28 Cert Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a non-gating LAN-HTTPS cert-check + in-place repair step to the fs-21 first-run wizard so a silently-degraded HTTPS setup becomes visible and self-healing.

**Architecture:** A new read-only `GET /api/lan/cert/status` reports cert health (presence + expiry) plus informational IP-coverage; the existing `POST /api/lan/cert/regenerate` performs repair unchanged. A shared `<LanCertStatus>` React component renders detect+repair UI and is consumed by both a new wizard step and the existing Admin `LanAccessCard` (which gains the new detection). A dedicated wiki page carries manual fallback steps.

**Tech Stack:** Node/Express + TypeScript (server, ESM `.js` import specifiers), Vitest + supertest (server tests), React 18 + Vitest/RTL (frontend), Playwright (e2e).

**Design spec:** `docs/superpowers/specs/2026-07-14-ops28-cert-hardening-design.md`

## Global Constraints

- **Import specifiers in `server/src/**` use `.js` extensions** even for `.ts` sources (NodeNext ESM). Copy the existing style in each file.
- **No OS trust-store probing** — detection is presence + expiry only; IP-coverage is informational and never sets `health` or triggers the warning.
- **Cert is NOT a readiness blocker** — do not touch `server/src/routes/setup-readiness.ts`, the `blockers` object, or `BlockerActionKind`. `buildSummaryRows()` stays a pure sync function.
- **Design tokens only** — no hex literals in components; use existing Tailwind classes / CSS vars (`text-ink`, `bg-magenta`, `text-rose-700`, `text-emerald-700`, `text-amber-600`, etc.) exactly as `lan-access-card.tsx` does.
- **Touch targets** — interactive controls get `min-h-[44px] fine-pointer:min-h-0` (match `lan-access-card.tsx`).
- **Wiki links are page-level only** — no `#anchor` fragments; every referenced `WikiPage` must have a `docs/wiki/<page>.md` file (guard test enforces).
- **Cert path source of truth** is `resolveLanCertPaths(repoRoot)` (`server/src/app-dirs.ts`) — never hardcode `.run/certs/...`.
- **Frontend components import the API only via `api.*`** from `src/lib/api` — never `fetch` directly.

---

### Task 1: LAN-IP enumeration helper (`server/src/lan-hosts.ts`)

Server-side re-derivation of the current LAN IPv4 list, matching `scripts/setup-lan-certs.mjs`'s `enumerateLanIps` filter rules, so the status route doesn't import across the scripts↔server boundary.

**Files:**
- Create: `server/src/lan-hosts.ts`
- Test: `server/src/lan-hosts.test.ts`

**Interfaces:**
- Consumes: `node:os` `networkInterfaces`.
- Produces: `export function enumerateLanIps(): string[]` — non-internal IPv4 addresses, excluding `169.254.*`, in `networkInterfaces()` enumeration order.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/lan-hosts.test.ts
import { describe, it, expect, vi } from 'vitest';

vi.mock('node:os', () => ({ networkInterfaces: vi.fn() }));
import { networkInterfaces } from 'node:os';
import { enumerateLanIps } from './lan-hosts.js';

describe('enumerateLanIps', () => {
  it('keeps non-internal IPv4, drops loopback / IPv6 / link-local', () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
      eth0: [
        { address: '192.168.1.42', family: 'IPv4', internal: false } as never,
        { address: 'fe80::1', family: 'IPv6', internal: false } as never,
      ],
      wsl: [{ address: '169.254.10.5', family: 'IPv4', internal: false } as never],
      docker0: [{ address: '172.17.0.1', family: 'IPv4', internal: false } as never],
    });
    expect(enumerateLanIps()).toEqual(['192.168.1.42', '172.17.0.1']);
  });

  it('returns [] when there are no external IPv4 interfaces', () => {
    vi.mocked(networkInterfaces).mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true } as never],
    });
    expect(enumerateLanIps()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/lan-hosts.test.ts`
Expected: FAIL — cannot find module `./lan-hosts.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lan-hosts.ts
/* ops-28 — server-side LAN IPv4 enumeration for GET /api/lan/cert/status.
   Deliberately re-derived here rather than imported from
   scripts/setup-lan-certs.mjs: that .mjs can process.exit and lives across the
   scripts↔server boundary the regenerate route already avoids crossing (see
   routes/lan-cert.ts). The parity test pins the filter rules to the script's
   enumerateLanIps. NOTE: routes/export-lan.ts holds a third copy of this same
   filter (enumerateLanUrls) — left as-is (out of ops-28 scope). */
import { networkInterfaces } from 'node:os';

export function enumerateLanIps(): string[] {
  const ips: string[] = [];
  for (const list of Object.values(networkInterfaces())) {
    if (!list) continue;
    for (const iface of list) {
      if (iface.internal) continue;
      if (iface.family !== 'IPv4') continue;
      if (iface.address.startsWith('169.254.')) continue;
      ips.push(iface.address);
    }
  }
  return ips;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/lan-hosts.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add server/src/lan-hosts.ts server/src/lan-hosts.test.ts
git commit -m "feat(server): add server-side LAN IPv4 enumeration for cert status"
```

---

### Task 2: Cert-health pure logic (`server/src/lan-cert-health.ts`)

Pure, filesystem-free functions that parse a cert's SAN IPs and decide health. Isolating these keeps the health matrix exhaustively unit-testable without minting PEMs.

**Files:**
- Create: `server/src/lan-cert-health.ts`
- Test: `server/src/lan-cert-health.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces:
  - `export function parseCertIps(subjectAltName: string | undefined): string[]` — extracts `IP Address:` SAN entries (prefix stripped), ignores `DNS:` entries.
  - `export type CertHealth = 'healthy' | 'missing' | 'expired'`
  - `export function computeCertHealth(args: { certExists: boolean; keyExists: boolean; parsed: { notAfter: Date; ips: string[] } | null; currentLanIps: string[]; now: Date }): { health: CertHealth; uncoveredIps: string[] }` — precedence `missing > expired > healthy`; `uncoveredIps` computed independently and never affects `health`.

- [ ] **Step 1: Write the failing test**

```ts
// server/src/lan-cert-health.test.ts
import { describe, it, expect } from 'vitest';
import { parseCertIps, computeCertHealth } from './lan-cert-health.js';

describe('parseCertIps', () => {
  it('extracts IP SANs from the comma-joined subjectAltName string, ignoring DNS', () => {
    const san = 'DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.42';
    expect(parseCertIps(san)).toEqual(['127.0.0.1', '192.168.1.42']);
  });
  it('returns [] for undefined', () => {
    expect(parseCertIps(undefined)).toEqual([]);
  });
});

describe('computeCertHealth', () => {
  const now = new Date('2026-07-14T00:00:00Z');
  const base = { certExists: true, keyExists: true, currentLanIps: [] as string[], now };

  it('missing when cert file absent', () => {
    expect(computeCertHealth({ ...base, certExists: false, parsed: null }).health).toBe('missing');
  });
  it('missing when key file absent', () => {
    expect(computeCertHealth({ ...base, keyExists: false, parsed: null }).health).toBe('missing');
  });
  it('missing when files present but unparseable (parsed null)', () => {
    expect(computeCertHealth({ ...base, parsed: null }).health).toBe('missing');
  });
  it('expired when notAfter is in the past', () => {
    const parsed = { notAfter: new Date('2020-01-01T00:00:00Z'), ips: ['192.168.1.42'] };
    expect(computeCertHealth({ ...base, parsed }).health).toBe('expired');
  });
  it('healthy when present, unexpired', () => {
    const parsed = { notAfter: new Date('2099-01-01T00:00:00Z'), ips: ['192.168.1.42'] };
    expect(computeCertHealth({ ...base, parsed }).health).toBe('healthy');
  });
  it('reports uncoveredIps but stays healthy when a current IP is not in SANs', () => {
    const parsed = { notAfter: new Date('2099-01-01T00:00:00Z'), ips: ['192.168.1.42'] };
    const r = computeCertHealth({ ...base, parsed, currentLanIps: ['192.168.1.42', '10.0.0.9'] });
    expect(r.health).toBe('healthy');
    expect(r.uncoveredIps).toEqual(['10.0.0.9']);
  });
  it('empty uncoveredIps when the cert is missing (nothing to compare)', () => {
    const r = computeCertHealth({ ...base, certExists: false, parsed: null, currentLanIps: ['10.0.0.9'] });
    expect(r.uncoveredIps).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/lan-cert-health.test.ts`
Expected: FAIL — cannot find module `./lan-cert-health.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// server/src/lan-cert-health.ts
/* ops-28 — pure cert-health decision logic for GET /api/lan/cert/status.
   No filesystem / no crypto here so the health matrix is exhaustively
   unit-testable. The route (routes/lan-cert.ts) does the fs + X509 parse and
   feeds the results in. IP-coverage is INFORMATIONAL: uncoveredIps is reported
   but never changes `health` (see the spec's "Why IP-coverage is
   informational"). */

export type CertHealth = 'healthy' | 'missing' | 'expired';

/** Parse the `IP Address:`-prefixed entries out of X509Certificate.subjectAltName,
    which is a single comma-joined string like
    "DNS:localhost, IP Address:127.0.0.1, IP Address:192.168.1.42". */
export function parseCertIps(subjectAltName: string | undefined): string[] {
  if (!subjectAltName) return [];
  return subjectAltName
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.startsWith('IP Address:'))
    .map((entry) => entry.slice('IP Address:'.length).trim());
}

export function computeCertHealth(args: {
  certExists: boolean;
  keyExists: boolean;
  parsed: { notAfter: Date; ips: string[] } | null;
  currentLanIps: string[];
  now: Date;
}): { health: CertHealth; uncoveredIps: string[] } {
  const { certExists, keyExists, parsed, currentLanIps, now } = args;
  if (!certExists || !keyExists || parsed === null) {
    return { health: 'missing', uncoveredIps: [] };
  }
  if (parsed.notAfter.getTime() <= now.getTime()) {
    return { health: 'expired', uncoveredIps: [] };
  }
  const covered = new Set(parsed.ips);
  const uncoveredIps = currentLanIps.filter((ip) => !covered.has(ip));
  return { health: 'healthy', uncoveredIps };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/lan-cert-health.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add server/src/lan-cert-health.ts server/src/lan-cert-health.test.ts
git commit -m "feat(server): add pure cert-health decision logic (presence/expiry/coverage)"
```

---

### Task 3: `GET /api/lan/cert/status` route + tests + fixture

Wire the pure logic to the filesystem, X509 parse, LAN-IP enumeration, and runtime/requested flags, in the existing `lan-cert.ts` router.

**Files:**
- Modify: `server/src/routes/lan-cert.ts`
- Modify: `server/src/routes/lan-cert.test.ts`
- Create: `server/src/routes/__fixtures__/lan-cert-healthy.pem` (committed test fixture — see Step 1)

**Interfaces:**
- Consumes: `enumerateLanIps` (Task 1), `parseCertIps`/`computeCertHealth`/`CertHealth` (Task 2), `resolveLanCertPaths`, `getLanRuntime`, `isLanHttpsEnabled`, `X509Certificate`.
- Produces: `GET /api/lan/cert/status` returning JSON `LanCertStatus` (shape below); `export interface LanCertStatus`.

- [ ] **Step 1: Generate the committed healthy fixture (one-time, run locally)**

The cert-parse seam needs one real PEM. Generate a 100-year self-signed cert with IP SANs and commit it (CI never regenerates it):

```bash
mkdir -p server/src/routes/__fixtures__
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout /dev/null -out server/src/routes/__fixtures__/lan-cert-healthy.pem \
  -days 36500 -subj "/CN=castwright-test" \
  -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:192.168.1.42"
```

(If `openssl` isn't on PATH, `mkcert -cert-file server/src/routes/__fixtures__/lan-cert-healthy.pem -key-file /dev/null localhost 127.0.0.1 192.168.1.42` also works. On Windows use a throwaway path instead of `/dev/null` for the key, then delete it — only the cert is committed.)

- [ ] **Step 2: Write the failing tests**

Add to `server/src/routes/lan-cert.test.ts`. Mock `../lan-hosts.js` so `enumerateLanIps` is deterministic; drive `requested`/`active` via env + the real `setLanRuntime` setter (no mock needed). Add these imports near the top with the existing ones:

```ts
import { readFileSync, copyFileSync } from 'node:fs';
import { setLanRuntime } from '../lan-runtime.js';

vi.mock('../lan-hosts.js', () => ({ enumerateLanIps: vi.fn(() => [] as string[]) }));
import { enumerateLanIps } from '../lan-hosts.js';
```

Then a new describe block:

```ts
describe('GET /api/lan/cert/status', () => {
  let certDir: string;
  const fixture = join(__dirname, '__fixtures__', 'lan-cert-healthy.pem');

  beforeEach(() => {
    certDir = mkdtempSync(join(tmpdir(), 'lan-cert-status-test-'));
    __setCertPathsForTest({
      certFile: join(certDir, 'lan-cert.pem'),
      keyFile: join(certDir, 'lan-key.pem'),
    });
    vi.mocked(enumerateLanIps).mockReturnValue([]);
    setLanRuntime({ httpsActive: false, port: 8080 });
    delete process.env.LAN_HTTPS;
  });
  afterEach(() => {
    rmSync(certDir, { recursive: true, force: true });
    __setCertPathsForTest(null);
    setLanRuntime({ httpsActive: false, port: 8080 });
    delete process.env.LAN_HTTPS;
  });

  it('missing when no cert files exist', async () => {
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.status).toBe(200);
    expect(res.body.health).toBe('missing');
    expect(res.body.certHosts).toEqual([]);
    expect(res.body.expiresAt).toBeNull();
  });

  it('missing when files present but unparseable', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.body.health).toBe('missing');
  });

  it('healthy for a real cert; reports certHosts + uncoveredIps informationally', async () => {
    copyFileSync(fixture, join(certDir, 'lan-cert.pem'));
    writeFileSync(join(certDir, 'lan-key.pem'), 'KEY-EXISTS');
    vi.mocked(enumerateLanIps).mockReturnValue(['192.168.1.42', '10.0.0.9']);
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.body.health).toBe('healthy');
    expect(res.body.certHosts).toEqual(['127.0.0.1', '192.168.1.42']);
    expect(res.body.uncoveredIps).toEqual(['10.0.0.9']);
    expect(typeof res.body.expiresAt).toBe('string');
  });

  it('reflects requested (env) and active (runtime) flags', async () => {
    process.env.LAN_HTTPS = '1';
    setLanRuntime({ httpsActive: true, port: 8443 });
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.body.requested).toBe(true);
    expect(res.body.active).toBe(true);
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/lan-cert.test.ts`
Expected: FAIL — 404 on `/api/lan/cert/status` (route not defined yet).

- [ ] **Step 4: Implement the route**

In `server/src/routes/lan-cert.ts`, extend the imports and add the handler + interface. Update the top-of-file imports:

```ts
import { X509Certificate } from 'node:crypto';
import { enumerateLanIps } from '../lan-hosts.js';
import { parseCertIps, computeCertHealth, type CertHealth } from '../lan-cert-health.js';
import { getLanRuntime } from '../lan-runtime.js';
import { isLanHttpsEnabled } from './export-lan.js';
```

Add the response interface (near the top of the file, after `lanCertRouter`):

```ts
export interface LanCertStatus {
  requested: boolean;
  active: boolean;
  health: CertHealth;
  certHosts: string[];
  currentLanIps: string[];
  uncoveredIps: string[];
  expiresAt: string | null;
}
```

Add the handler (place it above the existing `.post('/cert/regenerate', …)`):

```ts
/* ops-28 — read-only cert health for the first-run wizard + Admin card.
   GET (non-mutating) passes the /api guards on localhost: requireSameOrigin
   only gates mutating methods, and requireLanToken is bypassed for loopback. */
lanCertRouter.get('/cert/status', (_req: Request, res: Response) => {
  const certExists = existsSync(certFile);
  const keyExists = existsSync(keyFile);

  let parsed: { notAfter: Date; ips: string[] } | null = null;
  if (certExists && keyExists) {
    try {
      const x = new X509Certificate(readFileSync(certFile));
      parsed = { notAfter: new Date(x.validTo), ips: parseCertIps(x.subjectAltName) };
    } catch {
      parsed = null; // unparseable → treated as missing
    }
  }

  const currentLanIps = enumerateLanIps();
  const { health, uncoveredIps } = computeCertHealth({
    certExists,
    keyExists,
    parsed,
    currentLanIps,
    now: new Date(),
  });

  const body: LanCertStatus = {
    requested: isLanHttpsEnabled(),
    active: getLanRuntime().httpsActive,
    health,
    certHosts: parsed?.ips ?? [],
    currentLanIps,
    uncoveredIps,
    expiresAt: parsed ? parsed.notAfter.toISOString() : null,
  };
  res.status(200).json(body);
});
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/lan-cert.test.ts`
Expected: PASS (existing regenerate tests + 4 new status tests).

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/lan-cert.ts server/src/routes/lan-cert.test.ts server/src/routes/__fixtures__/lan-cert-healthy.pem
git commit -m "feat(server): add GET /api/lan/cert/status cert-health endpoint"
```

---

### Task 4: Frontend API — `getLanCertStatus` (`src/lib/api.ts`)

Add the real + mock API functions and the frontend `LanCertStatus` type.

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.test.ts` (only if a colocated api test exists; otherwise coverage rides on the component tests in Task 6 — note it explicitly in the commit).

**Interfaces:**
- Consumes: server `GET /api/lan/cert/status`.
- Produces: `api.getLanCertStatus(): Promise<LanCertStatus>` and `export interface LanCertStatus` (frontend copy, kept in sync with the server interface).

- [ ] **Step 1: Add the frontend type**

Near the other LAN types in `src/lib/api.ts` (search for `regenerateLanCert` to find the neighborhood), add:

```ts
export interface LanCertStatus {
  requested: boolean;
  active: boolean;
  health: 'healthy' | 'missing' | 'expired';
  certHosts: string[];
  currentLanIps: string[];
  uncoveredIps: string[];
  expiresAt: string | null;
}
```

- [ ] **Step 2: Add the real implementation**

Directly after `realRegenerateLanCert` (around line 6694):

```ts
async function realGetLanCertStatus(): Promise<LanCertStatus> {
  const res = await fetch('/api/lan/cert/status');
  if (!res.ok) throw new ApiError(`cert status failed (${res.status})`, res.status);
  return res.json() as Promise<LanCertStatus>;
}
```

- [ ] **Step 3: Add the mock implementation**

Directly after `mockRegenerateLanCert` (around line 6714):

```ts
const mockGetLanCertStatus = async (): Promise<LanCertStatus> => ({
  requested: true,
  active: false,
  health: 'missing',
  certHosts: [],
  currentLanIps: ['192.168.1.42'],
  uncoveredIps: [],
  expiresAt: null,
});
```

- [ ] **Step 4: Wire both into the api objects**

Add `getLanCertStatus: realGetLanCertStatus,` next to `regenerateLanCert: realRegenerateLanCert,` (~line 9294) and `getLanCertStatus: mockGetLanCertStatus,` next to `regenerateLanCert: mockRegenerateLanCert,` (~line 9570).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS — no type errors; `api.getLanCertStatus` resolves on both branches.

- [ ] **Step 6: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): add api.getLanCertStatus (real + mock)"
```

---

### Task 5: Dedicated wiki page `LAN-HTTPS-Troubleshooting`

**Files:**
- Modify: `src/lib/wiki-links.ts`
- Create: `docs/wiki/LAN-HTTPS-Troubleshooting.md`

**Interfaces:**
- Consumes: nothing.
- Produces: `'LAN-HTTPS-Troubleshooting'` added to the `WikiPage` union; used by Task 6 via `<WikiLink page="LAN-HTTPS-Troubleshooting" …/>`.

- [ ] **Step 1: Run the guard test to confirm current green**

Run: `npm run test -- src/lib/wiki-links.test.ts`
Expected: PASS (baseline before edit).

- [ ] **Step 2: Add the page to the union**

In `src/lib/wiki-links.ts`, add to the `WikiPage` union (after `'Mobile-Tablet-and-Companion-App'`):

```ts
  | 'Mobile-Tablet-and-Companion-App'
  | 'LAN-HTTPS-Troubleshooting'
  | 'Admin';
```

- [ ] **Step 3: Run the guard test to verify it now fails**

Run: `npm run test -- src/lib/wiki-links.test.ts`
Expected: FAIL — asserts `docs/wiki/LAN-HTTPS-Troubleshooting.md` does not exist.

- [ ] **Step 4: Create the wiki page mirror**

```markdown
<!-- docs/wiki/LAN-HTTPS-Troubleshooting.md -->
# LAN HTTPS Troubleshooting

Castwright serves your library over HTTPS on your local network so phones and
tablets can pair and listen. That needs a local certificate, created once at
install. If a phone shows "Not secure", or pairing is unavailable, the
certificate is missing, expired, or doesn't cover your current network.

## Fix it from the app

Open **Set up Castwright → LAN access** (or **Admin → LAN access**) and click
**Regenerate certificate**. If the app booted without HTTPS, restart it once
afterwards to bind HTTPS.

## Fix it from a terminal

Run `npm run install:cert-mobile` on the computer running Castwright. It prints
a QR code and per-OS steps to install the local root certificate on your phone.

## Install the root certificate on a device (one-time)

Download it from `https://<computer-ip>:8443/cert/root.crt`, then:

- **Android:** Settings → Security → Install a certificate → CA certificate.
- **iOS:** install the profile, then General → About → Certificate Trust
  Settings → enable it.

The companion app trusts the certificate automatically (pinning) — only phone
browsers need this step.

## Still stuck?

Make sure `mkcert` is installed (bundled with the Pinokio install; otherwise
`brew install mkcert` / `choco install mkcert` / `apt install mkcert`), then
regenerate again.
```

- [ ] **Step 5: Run the guard test to verify green**

Run: `npm run test -- src/lib/wiki-links.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/wiki-links.ts docs/wiki/LAN-HTTPS-Troubleshooting.md
git commit -m "docs(frontend): add dedicated LAN-HTTPS-Troubleshooting wiki page"
```

---

### Task 6: Shared `<LanCertStatus>` component + Admin card refactor

Extract the cert detect+repair UI into a shared component; refactor `LanAccessCard` to consume it (gaining health detection); the wizard step (Task 7) is the second consumer.

**Files:**
- Create: `src/components/lan-cert-status.tsx`
- Create: `src/components/lan-cert-status.test.tsx`
- Modify: `src/components/lan-access-card.tsx`
- Modify: `src/components/lan-access-card.test.tsx` (if present; else note coverage rides on the new test)

**Interfaces:**
- Consumes: `api.getLanCertStatus` (Task 4), `api.regenerateLanCert` (existing), `LanCertStatus` type, `WikiLink` + `'LAN-HTTPS-Troubleshooting'` (Task 5).
- Produces: `export function LanCertStatus({ variant }: { variant: 'wizard' | 'admin' })`. Also `export function healthLabel(health, active)` for reuse by the wizard step's banner logic.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/lan-cert-status.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { LanCertStatus } from './lan-cert-status';
import { api } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { ...actual.api, getLanCertStatus: vi.fn(), regenerateLanCert: vi.fn() } };
});

const status = (over: Partial<import('../lib/api').LanCertStatus> = {}) => ({
  requested: true, active: false, health: 'healthy' as const,
  certHosts: ['127.0.0.1', '192.168.1.42'], currentLanIps: ['192.168.1.42'],
  uncoveredIps: [], expiresAt: '2099-01-01T00:00:00.000Z', ...over,
});

describe('LanCertStatus', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows a "restart to apply" note when healthy but not active', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue(status({ health: 'healthy', active: false }));
    render(<LanCertStatus variant="wizard" />);
    expect(await screen.findByTestId('lan-cert-restart-note')).toBeInTheDocument();
  });

  it('shows the coverage hint when uncoveredIps is non-empty', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue(
      status({ health: 'healthy', active: true, uncoveredIps: ['10.0.0.9'] }),
    );
    render(<LanCertStatus variant="admin" />);
    expect(await screen.findByTestId('lan-cert-coverage-hint')).toHaveTextContent('10.0.0.9');
  });

  it('regenerate calls the API then re-fetches status', async () => {
    vi.mocked(api.getLanCertStatus)
      .mockResolvedValueOnce(status({ health: 'missing', active: false, certHosts: [], expiresAt: null }))
      .mockResolvedValueOnce(status({ health: 'healthy', active: false }));
    vi.mocked(api.regenerateLanCert).mockResolvedValue({ hosts: ['192.168.1.42'] });
    render(<LanCertStatus variant="wizard" />);
    fireEvent.click(await screen.findByRole('button', { name: /set up|regenerate/i }));
    await waitFor(() => expect(api.regenerateLanCert).toHaveBeenCalled());
    await waitFor(() => expect(api.getLanCertStatus).toHaveBeenCalledTimes(2));
  });

  it('shows the wiki troubleshooting link on regenerate error', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue(status({ health: 'missing', certHosts: [], expiresAt: null }));
    vi.mocked(api.regenerateLanCert).mockRejectedValue(new Error('mkcert not found'));
    render(<LanCertStatus variant="wizard" />);
    fireEvent.click(await screen.findByRole('button', { name: /set up|regenerate/i }));
    expect(await screen.findByRole('link', { name: /troubleshoot/i })).toHaveAttribute(
      'href', expect.stringContaining('LAN-HTTPS-Troubleshooting'),
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/lan-cert-status.test.tsx`
Expected: FAIL — cannot find module `./lan-cert-status`.

- [ ] **Step 3: Implement the component**

```tsx
// src/components/lan-cert-status.tsx
/* ops-28 — shared cert detect+repair UI. Consumed by the first-run wizard
   step (step-lan-cert.tsx) and Admin's LanAccessCard. Detection is
   presence+expiry (health); IP-coverage is an informational hint only. */
import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { LanCertStatus as CertStatus } from '../lib/api';
import { WikiLink } from './wiki-link';

const HEALTH_COPY: Record<CertStatus['health'], string> = {
  healthy: 'LAN certificate is set up.',
  missing: 'Phone/tablet pairing is currently off — no HTTPS certificate is set up.',
  expired: 'The LAN certificate has expired — phone/tablet pairing is off until it’s renewed.',
};

/** True when the warning banner should show: LAN was requested but the cert is
    in a deterministically-broken state. Coverage hints never trigger this. */
export function isCertWarning(s: CertStatus): boolean {
  return s.requested && (s.health === 'missing' || s.health === 'expired');
}

export function LanCertStatus({ variant }: { variant: 'wizard' | 'admin' }) {
  const [status, setStatus] = useState<CertStatus | null>(null);
  const [regen, setRegen] = useState<
    { k: 'idle' } | { k: 'loading' } | { k: 'error'; message: string }
  >({ k: 'idle' });

  const refresh = useCallback(() => {
    api.getLanCertStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(refresh, [refresh]);

  const regenerate = async () => {
    setRegen({ k: 'loading' });
    try {
      await api.regenerateLanCert();
      setRegen({ k: 'idle' });
      refresh();
    } catch (e) {
      setRegen({ k: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

  if (!status) {
    return (
      <div className="text-sm text-ink/55" data-testid="lan-cert-loading">
        Checking LAN certificate…
      </div>
    );
  }

  const restartNeeded = status.health === 'healthy' && !status.active;
  const buttonLabel =
    regen.k === 'loading'
      ? 'Working…'
      : status.health === 'healthy'
        ? 'Regenerate certificate'
        : 'Set up LAN certificate';

  return (
    <div className="text-sm" data-testid={`lan-cert-status-${variant}`} data-health={status.health}>
      <p className={status.health === 'healthy' ? 'text-ink/70' : 'text-amber-700'}>
        {HEALTH_COPY[status.health]}
        {status.health !== 'healthy' && (
          <> You can set it up now, or skip if you only use Castwright on this computer.</>
        )}
      </p>

      {restartNeeded && (
        <p className="mt-2 text-amber-700" data-testid="lan-cert-restart-note">
          Certificate ready — restart Castwright once to serve over HTTPS.
        </p>
      )}

      {status.uncoveredIps.length > 0 && (
        <p className="mt-2 text-ink/60" data-testid="lan-cert-coverage-hint">
          This certificate doesn’t list {status.uncoveredIps.join(', ')} — regenerate to include
          your current network.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          onClick={regenerate}
          disabled={regen.k === 'loading'}
          className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs text-ink/70 hover:bg-ink/5 min-h-[44px] fine-pointer:min-h-0 disabled:opacity-50"
        >
          {buttonLabel}
        </button>
        <WikiLink page="LAN-HTTPS-Troubleshooting" label="Troubleshooting" className="text-xs" />
      </div>

      {regen.k === 'error' && (
        <p className="mt-2 text-rose-700" data-testid="lan-cert-error">{regen.message}</p>
      )}

      <details className="mt-4 text-xs text-ink/55">
        <summary className="cursor-pointer text-ink/70">Phone shows "Not secure"?</summary>
        <p className="mt-2 leading-relaxed">
          The phone must trust this computer's local certificate once. Run{' '}
          <code className="px-1 py-0.5 rounded bg-ink/5">npm run install:cert-mobile</code> for a
          QR + per-OS steps (served at{' '}
          <code className="px-1 py-0.5 rounded bg-ink/5">/cert/root.crt</code>). The companion app
          trusts it automatically.
        </p>
      </details>
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/lan-cert-status.test.tsx`
Expected: PASS (4 tests).

- [ ] **Step 5: Refactor `LanAccessCard` to consume it**

In `src/components/lan-access-card.tsx`: remove the local `certState` state (lines 19-21), the `regenerateCert` function (lines 44-52), the regenerate `<div className="mt-5 …">` block (lines 101-121), and the `<details>` block (lines 122-133). Replace the removed cert UI with `<LanCertStatus variant="admin" />` (add `import { LanCertStatus } from './lan-cert-status';`). Keep the header `<WikiLink page={ADMIN_WIKI.lanAccess} …/>` (general LAN help) and all device-pairing UI untouched. Remove the now-unused `ADMIN_WIKI` import only if nothing else in the file uses it (the header still does — keep it).

- [ ] **Step 6: Update `lan-access-card.test.tsx` if it asserted the old cert UI**

Run: `npm run test -- src/components/lan-access-card.test.tsx`
If it references the removed "Regenerate certificate" inline text/`certState`, update those assertions to mock `api.getLanCertStatus` and assert `<LanCertStatus>` renders (e.g. `screen.findByTestId('lan-cert-status-admin')`). If no such test exists, note it in the commit.

- [ ] **Step 7: Run the frontend suite for both files**

Run: `npm run test -- src/components/lan-cert-status.test.tsx src/components/lan-access-card.test.tsx`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/components/lan-cert-status.tsx src/components/lan-cert-status.test.tsx src/components/lan-access-card.tsx src/components/lan-access-card.test.tsx
git commit -m "feat(frontend): shared LanCertStatus component; Admin card gains cert-health detection"
```

---

### Task 7: Wizard step `step-lan-cert.tsx` + wiring

**Files:**
- Create: `src/components/setup/step-lan-cert.tsx`
- Create: `src/components/setup/step-lan-cert.test.tsx`
- Modify: `src/components/setup/setup-wizard.tsx`

**Interfaces:**
- Consumes: `LanCertStatus`/`isCertWarning` component (Task 6), `api.getLanCertStatus`.
- Produces: `export function StepLanCert()`; a `'lanCert'` step in the wizard between `defaults` and `finish`.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/setup/step-lan-cert.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StepLanCert } from './step-lan-cert';
import { api } from '../../lib/api';

vi.mock('../../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/api')>();
  return { ...actual, api: { ...actual.api, getLanCertStatus: vi.fn(), regenerateLanCert: vi.fn() } };
});

const base = {
  requested: true, active: false, certHosts: [] as string[],
  currentLanIps: ['192.168.1.42'], uncoveredIps: [] as string[], expiresAt: null,
};

describe('StepLanCert', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows the soft-warning banner when requested && missing', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({ ...base, health: 'missing' });
    render(<StepLanCert />);
    expect(await screen.findByTestId('lan-cert-warning-banner')).toBeInTheDocument();
  });

  it('no warning banner when healthy (only a coverage hint / restart note may show)', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({
      ...base, health: 'healthy', active: true, uncoveredIps: ['10.0.0.9'],
    });
    render(<StepLanCert />);
    await screen.findByTestId('lan-cert-status-wizard');
    expect(screen.queryByTestId('lan-cert-warning-banner')).not.toBeInTheDocument();
  });

  it('no warning banner when not requested even if missing', async () => {
    vi.mocked(api.getLanCertStatus).mockResolvedValue({ ...base, requested: false, health: 'missing' });
    render(<StepLanCert />);
    await screen.findByTestId('lan-cert-status-wizard');
    expect(screen.queryByTestId('lan-cert-warning-banner')).not.toBeInTheDocument();
  });
});
```

Note: the banner decision must live in the step, driven by the same status fetch. Have `StepLanCert` fetch status itself for the banner, and render `<LanCertStatus variant="wizard" />` for the body — two fetches is acceptable (both hit the cheap mock/endpoint), OR lift the fetch. For simplicity and to keep the test above valid, fetch once in the step and pass nothing down (the component re-fetches). If you prefer a single fetch, refactor `LanCertStatus` to accept an optional `initialStatus` — not required for this plan.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test -- src/components/setup/step-lan-cert.test.tsx`
Expected: FAIL — cannot find module `./step-lan-cert`.

- [ ] **Step 3: Implement the step**

```tsx
// src/components/setup/step-lan-cert.tsx
/* ops-28 — first-run wizard "LAN access" step. Advisory + soft-warning:
   never gates Finish; warns only when LAN HTTPS is requested yet the cert is
   missing/expired. */
import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import type { LanCertStatus as CertStatus } from '../../lib/api';
import { LanCertStatus, isCertWarning } from '../lan-cert-status';

export function StepLanCert() {
  const [status, setStatus] = useState<CertStatus | null>(null);
  useEffect(() => {
    api.getLanCertStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="font-serif text-xl font-bold text-ink">LAN access</h2>
        <p className="mt-1 text-sm text-ink/60">
          Serve your library to phones and tablets over your local network.
        </p>
      </div>

      {status && isCertWarning(status) && (
        <div
          data-testid="lan-cert-warning-banner"
          className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-800"
        >
          Phone/tablet pairing is off because the HTTPS certificate isn’t ready.
        </div>
      )}

      <LanCertStatus variant="wizard" />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm run test -- src/components/setup/step-lan-cert.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Wire the step into `setup-wizard.tsx`**

Make these edits in `src/components/setup/setup-wizard.tsx`:

1. Import: add `import { StepLanCert } from './step-lan-cert';`.
2. Union (line 30): `type StepId = 'environment' | 'ffmpeg' | 'models' | 'defaults' | 'lanCert' | 'finish';`
3. `STEPS` array (lines 32-38): insert before `finish`:
```ts
  { id: 'defaults', title: 'Defaults' },
  { id: 'lanCert', title: 'LAN access' },
  { id: 'finish', title: 'Finish' },
```
4. `renderStep` switch (lines 56-67): add before the `finish` case:
```ts
    case 'lanCert':
      return <StepLanCert />;
```
5. `buildSummaryRows` (lines 248-284): the `finish` step is not a summary row; `defaults` stays `stepIndex: 3`. Add a navigational LAN row after the `defaults` row (it does NOT show live health — `buildSummaryRows` is pure/sync off `blockers`, and cert is intentionally not a blocker):
```ts
    {
      key: 'defaults',
      label: 'Defaults',
      detail: 'New-book starting points',
      status: 'ok',
      stepIndex: 3,
    },
    {
      key: 'lanCert',
      label: 'LAN access',
      detail: 'Phone/tablet HTTPS certificate',
      status: 'ok',
      stepIndex: 4,
    },
```
6. Docstring (lines 2-8): update "five step components" → "six step components" and "Step N of 5" → "Step N of 6".

- [ ] **Step 6: Run the wizard suite**

Run: `npm run test -- src/components/setup/`
Expected: PASS — `setup-wizard.test.tsx` still green (dots/counter derive off `STEPS.length`; new nav row present). If `setup-wizard.test.tsx` hardcodes "Step 1 of 5" or a step count, update those assertions to 6.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add src/components/setup/step-lan-cert.tsx src/components/setup/step-lan-cert.test.tsx src/components/setup/setup-wizard.tsx
git commit -m "feat(frontend): add LAN-access wizard step with soft-warning banner"
```

---

### Task 8: E2E — wizard LAN-access step (Playwright, mock mode)

**Files:**
- Create: `e2e/setup-lan-cert.spec.ts` (or extend an existing setup-wizard spec if one exists — check `e2e/` first)

**Interfaces:**
- Consumes: mock-mode `api.getLanCertStatus` (Task 4 mock returns `health: 'missing'`, `requested: true`).

- [ ] **Step 1: Check for an existing setup-wizard e2e**

Run: `ls e2e/ | grep -i setup`
If a setup spec exists, add a test case to it instead of a new file. Otherwise create `e2e/setup-lan-cert.spec.ts`.

- [ ] **Step 2: Write the spec**

```ts
// e2e/setup-lan-cert.spec.ts
import { test, expect } from '@playwright/test';

test('first-run wizard surfaces the LAN-access cert step and can regenerate', async ({ page }) => {
  await page.goto('/#/setup');
  // Page through to the LAN access step (Next is never gated).
  for (let i = 0; i < 4; i++) {
    await page.getByRole('button', { name: 'Next' }).click();
  }
  await expect(page.getByTestId('lan-cert-status-wizard')).toBeVisible();
  // Mock status is health:'missing' + requested:true → warning banner shows.
  await expect(page.getByTestId('lan-cert-warning-banner')).toBeVisible();
  // Repair button is present and clickable (mock regenerate resolves).
  await page.getByRole('button', { name: /set up lan certificate/i }).click();
});
```

Adjust the number of `Next` clicks to land on the LAN-access step (index 4: environment→ffmpeg→models→defaults→lanCert = 4 clicks). Confirm the route (`/#/setup`) matches `SetupRoute` in `src/routes/index.tsx`; if the wizard opens in `checklist` mode (setup already complete in the mock), instead click the `setup-summary-row-lanCert` row to drill in.

- [ ] **Step 3: Run the spec**

Run: `npm run test:e2e -- setup-lan-cert`
Expected: PASS (chromium). If it opens in checklist mode, use the summary-row drill-in path.

- [ ] **Step 4: Commit**

```bash
git add e2e/setup-lan-cert.spec.ts
git commit -m "test(e2e): cover the first-run wizard LAN-access cert step"
```

---

### Task 9: Ship artifacts — regression plan, release notes, index

**Files:**
- Create: `docs/features/<NNN>-ops28-cert-hardening.md` (next free plan number — check `docs/features/INDEX.md`)
- Modify: `docs/features/INDEX.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

- [ ] **Step 1: Pick the next plan number**

Run: `ls docs/features/ | grep -oE '^[0-9]+' | sort -n | tail -1`
Use the next integer as `<NNN>`.

- [ ] **Step 2: Create the regression plan**

Copy `docs/features/TEMPLATE.md` to `docs/features/<NNN>-ops28-cert-hardening.md`, frontmatter `status: active`. Fill: the invariants (advisory never gates Finish; IP-coverage never triggers the warning; `healthy && !active` ⇒ restart note; cert not in `blockers`), the manual acceptance walkthrough (dismiss mkcert → boot → wizard shows `missing` + warning → Regenerate → healthy + restart note → restart → HTTPS live), and links to the spec + this plan.

- [ ] **Step 3: Add the INDEX entry**

Add a row under the ops area in `docs/features/INDEX.md` pointing at the new plan.

- [ ] **Step 4: Release notes — technical register**

Append to `docs/release-notes-next.md` under the current in-progress version:

```markdown
- **ops-28 — LAN cert hardening in the setup wizard.** The first-run wizard now
  detects a missing/expired LAN-HTTPS certificate (previously a silent fallback
  to loopback HTTP) and can regenerate it in place; the Admin LAN-access card
  gained the same health detection. New `GET /api/lan/cert/status`. (#1609)
```

- [ ] **Step 5: Release notes — user-facing brand voice**

Add to the top in-progress version section of `RELEASE_NOTES.md`:

```markdown
- **Phone & tablet pairing, now self-healing.** Castwright's setup now checks
  the local certificate that powers listening on your phone or tablet — and
  fixes it in one click if it's missing, so pairing never silently stays off.
```

- [ ] **Step 6: Commit**

```bash
git add docs/features/ docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(ops): ops-28 regression plan + release notes"
```

---

## Self-Review

**Spec coverage check:**
- Advisory + soft-warning, not a blocker → Tasks 6 (`isCertWarning`), 7 (banner + no blocker touch). ✅
- Detection presence+expiry, coverage informational → Tasks 2 (`computeCertHealth`), 3 (route). ✅
- `GET /api/lan/cert/status` shape → Tasks 3, 4. ✅
- Reuse existing regenerate route → Task 6 (`api.regenerateLanCert`). ✅
- Shared component; Admin gains detection → Task 6. ✅
- `healthy && !active` restart note (flagged-bug primary outcome) → Task 6 (`restartNeeded`), tested. ✅
- Host-enum option (b) + parity test → Task 1. ✅
- SAN comma-string parse → Task 2 (`parseCertIps`). ✅
- Loopback-bypass auth note → Task 3 handler comment. ✅
- Dedicated wiki page → Task 5. ✅
- Navigational summary row; `buildSummaryRows` stays pure → Task 7 step 5. ✅
- Long-validity PEM fixture, enumerator stub → Task 3 steps 1-2. ✅
- E2E → Task 8. ✅
- Ship artifacts (plan, INDEX, both release notes, `Closes #1609`) → Task 9 + PR body. ✅

**Type consistency check:** `LanCertStatus` shape identical in server (Task 3) and frontend (Task 4). `CertHealth`/`health` union `'healthy'|'missing'|'expired'` consistent across Tasks 2, 3, 4, 6. `enumerateLanIps` name consistent Tasks 1, 3. `isCertWarning` defined in Task 6, consumed in Task 7. `computeCertHealth` args shape identical between Task 2 def and Task 3 call. ✅

**Placeholder scan:** no TBD/TODO; every code step carries complete code. ✅
