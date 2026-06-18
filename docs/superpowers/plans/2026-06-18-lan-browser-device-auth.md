# LAN Browser Device-Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user authorize a phone's browser over LAN HTTPS from the desktop Admin screen (QR → one tap → `HttpOnly` cookie), with a managed, revocable device list — so the web app stops being locked out behind the LAN token guard on non-loopback clients.

**Architecture:** The guard (`lan-auth.ts`) gains a 4th credential source: a `__Host-cw_lan` cookie carrying a per-device token (existing `srv-33` machinery, now with expiry). A loopback-only Admin endpoint mints a short-lived ≥80-bit pairing code rendered as a QR whose URL the phone's native camera opens; a pre-guard browser-redeem endpoint validates the code and `Set-Cookie`s the token. Because the cookie auto-attaches to same-origin requests, the ~100 existing `fetch('/api/…')` sites are untouched; a new server-side Origin allow-list middleware closes the CSRF surface that cookie auth introduces.

**Tech Stack:** Node/Express 5 (server), Vite + React 19 + Redux Toolkit + react-router 7 (frontend), Vitest (both), Playwright (e2e). Spec: `docs/superpowers/specs/2026-06-18-lan-browser-device-auth-design.md` (rev 5).

## Global Constraints

- **Branch:** all work lands on `feat/server-lan-browser-device-auth` (already cut).
- **Enforcement trigger is unchanged:** the guard only enforces when `isLanTokenEnforced()` = `isLanHttpsEnabled() && getLanAuthToken() !== undefined` (`server/src/lan-auth.ts:53`). Do **not** broaden it.
- **No change to the ~100 `fetch('/api/…')` call sites.** The cookie rides same-origin requests automatically.
- **Companion `POST /api/pair/redeem` request/response contract is unchanged.** Only its internal `createDevice(...)` call gains a ttl arg.
- **No grandfather migration.** A legacy `schema:1` device-token record (no `expiresAt`) is rejected → one-time re-pair. `device-tokens.ts` imports **nothing** from `config/`; every `createDevice` caller passes `ttlDays`.
- **Cookie name is literally `__Host-cw_lan`** with attributes `HttpOnly; Secure; SameSite=Strict; Path=/` and no `Domain`.
- **Browser pairing code is ≥80-bit** (`bytes=10`, 16 Crockford chars); the companion code stays 40-bit (`bytes=5`, 8 chars) — do not widen the shared default.
- **TDD:** every task writes the failing test first, watches it fail, implements minimally, watches it pass, commits. Commit subjects follow `<type>(<scope>): <subject>`.
- **Conventions:** OpenAPI is the type source of truth; design tokens are CSS vars (no hex literals); RTK reducers mutate via Immer drafts.
- **Server single-file test run:** `cd server && npx vitest run <path> -t "<name>"`. Frontend: `npx vitest run <path> -t "<name>"`.

---

### Task 1: Config knob — `lan.deviceTokenTtlDays`

**Files:**
- Modify: `server/src/config/registry.ts` (GROUPS array; KNOBS array)
- Test: `server/src/config/registry.test.ts` (the exact-groups assertion + a new knob assertion)

**Interfaces:**
- Consumes: `ConfigGroup`, `ConfigKnob` from `server/src/config/types.ts`.
- Produces: a knob readable at runtime via `configValue<number>('lan.deviceTokenTtlDays')` (used by Tasks 7 & 8) — default `30`.

- [ ] **Step 1: Write the failing test** — append to `server/src/config/registry.test.ts`:

```ts
import { GROUPS, KNOBS } from './registry.js';

it('registers the lan-access group', () => {
  const g = GROUPS.find((x) => x.id === 'lan-access');
  expect(g).toBeDefined();
  expect(g!.collapsedByDefault).toBe(false);
});

it('registers the device-token TTL knob with a 30-day default', () => {
  const k = KNOBS.find((x) => x.key === 'lan.deviceTokenTtlDays');
  expect(k).toMatchObject({
    env: 'LAN_DEVICE_TTL_DAYS',
    group: 'lan-access',
    type: 'integer',
    default: 30,
    min: 1,
    apply: 'live',
  });
});
```

Also update the existing exact-array group assertion (it asserts the current ten group ids in order). Add `'lan-access'` as the final element of the expected array (search the file for the `.map((g) => g.id)` / `toEqual([` block).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/config/registry.test.ts`
Expected: FAIL — `lan-access` group/knob not found; the ten-group assertion fails because it now expects eleven.

- [ ] **Step 3: Implement** — in `server/src/config/registry.ts`, append to `GROUPS`:

```ts
  { id: 'lan-access', label: 'LAN access & device tokens', help: 'Lifetime of browser/device authorizations minted from Admin.', risk: 'low', collapsedByDefault: false },
```

and append to `KNOBS`:

```ts
  {
    key: 'lan.deviceTokenTtlDays',
    env: 'LAN_DEVICE_TTL_DAYS',
    group: 'lan-access',
    label: 'Device authorization lifetime (days)',
    help: 'How long a browser/device authorization stays valid before it must be re-paired.',
    type: 'integer', min: 1,
    default: 30,
    apply: 'live', risk: 'low',
  },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/config/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/config/registry.ts server/src/config/registry.test.ts
git commit -m "feat(server): add lan.deviceTokenTtlDays config knob + lan-access group"
```

---

### Task 2: Device-token expiry (`expiresAt`, `createDevice(label, ttlDays)`, `findValidDevice(now)`, schema 1|2)

**Files:**
- Modify: `server/src/workspace/device-tokens.ts`
- Test: `server/src/workspace/device-tokens.pure.test.ts` (reseed fixtures + new cases)
- Test: `server/src/routes/devices.test.ts:98,111` (the direct `createDevice('Phone')` calls)

**Interfaces:**
- Produces:
  - `createDevice(label: string, ttlDays: number): Promise<{ device: PublicDevice; token: string }>` (ttlDays now **required**)
  - `findValidDevice(devices, rawToken, now?: number): DeviceTokenRecord | null` (rejects revoked / `expiresAt===undefined` / expired)
  - `PublicDevice` gains `expiresAt?: string`.

- [ ] **Step 1: Write the failing test** — in `server/src/workspace/device-tokens.pure.test.ts`, add `expiresAt` to every existing fixture `rec(...)` (a future ISO string), fix the `redactDevice` `toEqual` to include `expiresAt`, and add:

```ts
const future = new Date(Date.now() + 86_400_000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

it('rejects an expired record', () => {
  const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: past };
  expect(findValidDevice([d], 'tok')).toBeNull();
});

it('rejects a record with no expiresAt (legacy → re-pair)', () => {
  const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future };
  expect(findValidDevice([d], 'tok')).toBeNull();
});

it('honours an injected now', () => {
  const d = { id: '1', label: 'P', tokenHash: hashToken('tok'), createdAt: future, expiresAt: future };
  expect(findValidDevice([d], 'tok', Date.parse(future) + 1)).toBeNull();
  expect(findValidDevice([d], 'tok', Date.parse(future) - 1)).not.toBeNull();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts`
Expected: FAIL — `findValidDevice` ignores expiry / has no `now` param; redaction lacks `expiresAt`.

- [ ] **Step 3: Implement** — in `server/src/workspace/device-tokens.ts`:

Add `expiresAt` to both interfaces, widen the file schema, and update the four functions:

```ts
export interface DeviceTokenRecord {
  id: string;
  label: string;
  tokenHash: string;
  createdAt: string;
  expiresAt?: string;        // ISO; absent on legacy schema-1 records → rejected
  lastSeenAt?: string;
  revoked?: boolean;
}

export interface PublicDevice {
  id: string;
  label: string;
  createdAt: string;
  expiresAt?: string;
  lastSeenAt?: string;
  revoked: boolean;
}

interface DeviceTokensFile {
  schema: 1 | 2;
  devices: DeviceTokenRecord[];
}

export function findValidDevice(
  devices: readonly DeviceTokenRecord[],
  rawToken: string,
  now: number = Date.now(),
): DeviceTokenRecord | null {
  const h = Buffer.from(hashToken(rawToken));
  for (const d of devices) {
    if (d.revoked) continue;
    if (d.expiresAt === undefined || now > Date.parse(d.expiresAt)) continue;
    const dh = Buffer.from(d.tokenHash);
    if (dh.length === h.length && timingSafeEqual(dh, h)) return d;
  }
  return null;
}

export function redactDevice(d: DeviceTokenRecord): PublicDevice {
  return {
    id: d.id,
    label: d.label,
    createdAt: d.createdAt,
    ...(d.expiresAt !== undefined ? { expiresAt: d.expiresAt } : {}),
    ...(d.lastSeenAt !== undefined ? { lastSeenAt: d.lastSeenAt } : {}),
    revoked: d.revoked === true,
  };
}
```

Update `persist` to write schema 2:

```ts
async function persist(devices: DeviceTokenRecord[]): Promise<void> {
  cache = devices;
  await writeJsonAtomic(deviceTokensJsonPath(), { schema: 2, devices });
}
```

Update `createDevice` to require + stamp `ttlDays`:

```ts
export async function createDevice(
  label: string,
  ttlDays: number,
): Promise<{ device: PublicDevice; token: string }> {
  const devices = [...loadSync()];
  const token = randomBytes(32).toString('hex');
  const now = Date.now();
  const record: DeviceTokenRecord = {
    id: randomBytes(8).toString('hex'),
    label: label.trim() || 'Device',
    tokenHash: hashToken(token),
    createdAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ttlDays * 86_400_000).toISOString(),
  };
  devices.push(record);
  await persist(devices);
  return { device: redactDevice(record), token };
}
```

Then fix the two direct callers in `server/src/routes/devices.test.ts:98,111`: change `createDevice('Phone')` → `createDevice('Phone', 30)`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/workspace/device-tokens.pure.test.ts src/routes/devices.test.ts`
Expected: PASS (devices.test.ts mint-then-guard-accepts now mints a 30-day token that the guard accepts).

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/device-tokens.ts server/src/workspace/device-tokens.pure.test.ts server/src/routes/devices.test.ts
git commit -m "feat(server): device-token expiry (expiresAt, ttlDays, schema 2)"
```

---

### Task 3: `lastSeenAt` touch-on-use (throttled)

**Files:**
- Modify: `server/src/workspace/device-tokens.ts` (`isValidDeviceToken` + a throttled touch)
- Test: `server/src/workspace/device-tokens.test.ts`

**Interfaces:**
- Consumes: `findValidDevice` (Task 2), the in-memory `cache`, `persist`.
- Produces: `isValidDeviceToken(rawToken)` unchanged signature but now updates `lastSeenAt` at most once per `LASTSEEN_THROTTLE_MS`.

- [ ] **Step 1: Write the failing test** — add to `server/src/workspace/device-tokens.test.ts` (this is the IO-backed suite; it uses a temp workspace + `_resetDeviceTokenCacheForTests`):

```ts
it('stamps lastSeenAt on first valid use and throttles re-persist', async () => {
  const { token } = await createDevice('Phone', 30);
  expect(isValidDeviceToken(token)).toBe(true);
  // Touch is fire-and-forget; allow the microtask + write to settle.
  await new Promise((r) => setTimeout(r, 20));
  _resetDeviceTokenCacheForTests();
  const seen1 = listDevices()[0].lastSeenAt;
  expect(seen1).toBeDefined();

  // Second use within the throttle window must NOT change lastSeenAt.
  expect(isValidDeviceToken(token)).toBe(true);
  await new Promise((r) => setTimeout(r, 20));
  _resetDeviceTokenCacheForTests();
  expect(listDevices()[0].lastSeenAt).toBe(seen1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/device-tokens.test.ts -t "lastSeenAt"`
Expected: FAIL — `lastSeenAt` stays undefined (never written today).

- [ ] **Step 3: Implement** — in `server/src/workspace/device-tokens.ts`:

```ts
const LASTSEEN_THROTTLE_MS = 60 * 60 * 1000; // ~1h — bounds disk writes on the hot guard path

export function isValidDeviceToken(rawToken: string): boolean {
  const now = Date.now();
  const device = findValidDevice(loadSync(), rawToken, now);
  if (!device) return false;
  const last = device.lastSeenAt ? Date.parse(device.lastSeenAt) : 0;
  if (now - last > LASTSEEN_THROTTLE_MS) {
    // Best-effort, fire-and-forget: a raced/failed persist is harmless.
    const next = loadSync().map((d) =>
      d.id === device.id ? { ...d, lastSeenAt: new Date(now).toISOString() } : d,
    );
    void persist(next);
  }
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/workspace/device-tokens.test.ts -t "lastSeenAt"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/device-tokens.ts server/src/workspace/device-tokens.test.ts
git commit -m "feat(server): throttled lastSeenAt touch-on-use for device tokens"
```

---

### Task 4: Pairing sessions — label + ≥80-bit browser code + burn-on-miss

**Files:**
- Modify: `server/src/workspace/pairing-sessions.ts`
- Test: `server/src/workspace/pairing-sessions.test.ts` (update the 3 positional `createPairingSession(now)` calls + new cases)

**Interfaces:**
- Produces:
  - `createPairingSession(label?: string, now?: number, bytes?: number): NewPairingSession` where `NewPairingSession = { code, expiresAt, label?: string }`.
  - `redeemPairingSession(code, now?): { ok: true; label?: string } | { ok: false; reason: 'unknown'|'expired'|'consumed' }`.

- [ ] **Step 1: Write the failing test** — first update the existing calls: every `createPairingSession(now)` in this file becomes `createPairingSession(undefined, now)`. Then add:

```ts
it('stashes a label and returns it on redeem', () => {
  const { code } = createPairingSession('Mike phone');
  expect(redeemPairingSession(code)).toEqual({ ok: true, label: 'Mike phone' });
});

it('mints a 16-char (80-bit) code at bytes=10', () => {
  const { code } = createPairingSession('x', undefined, 10);
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{16}$/);
});

it('keeps the 8-char companion code at the default bytes', () => {
  const { code } = createPairingSession();
  expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
});

it('is single-use: a second redeem of the same code is consumed', () => {
  const { code } = createPairingSession('x');
  expect(redeemPairingSession(code)).toEqual({ ok: true, label: 'x' });
  expect(redeemPairingSession(code)).toEqual({ ok: false, reason: 'consumed' });
});

it('reports unknown for a code never minted', () => {
  expect(redeemPairingSession('NEVERMINTED12345')).toEqual({ ok: false, reason: 'unknown' });
});
```

> Note for the implementer: a *correct* code redeems on first call and is then `consumed` (single-use). The `misses` field is reserved defense-in-depth — a wrong code isn't in the map (`unknown`), so it can't burn anything; the **dominant brute-force control is the 80-bit entropy + the route rate limiter (Task 8)**, not the session counter. Carry `misses` on the `Session` type for a future guess-tracking path, but it needs no behavior in this task.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/pairing-sessions.test.ts`
Expected: FAIL — signature is `(now)`, no label, no `bytes`, no miss counter.

- [ ] **Step 3: Implement** — rewrite the body of `server/src/workspace/pairing-sessions.ts`:

```ts
interface Session {
  expiresAt: number;
  consumed: boolean;
  label?: string;
  misses: number;
}

const sessions = new Map<string, Session>();

export interface NewPairingSession {
  code: string;
  expiresAt: number;
  label?: string;
}

export function createPairingSession(
  label?: string,
  now: number = Date.now(),
  bytes = 5,
): NewPairingSession {
  sweep(now);
  const code = crockfordBase32(randomBytes(bytes)); // 5→8 chars (companion), 10→16 chars (browser)
  const expiresAt = now + TTL_MS;
  sessions.set(code, { expiresAt, consumed: false, label, misses: 0 });
  return { code, expiresAt, label };
}

export type RedeemResult =
  | { ok: true; label?: string }
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
  return { ok: true, label: s.label };
}
```

(`sweep`, `TTL_MS`, `_resetPairingSessionsForTests` unchanged. The `misses` field is reserved for the burn path; since a correct code is single-use the practical control is the route limiter — keep `misses` on the type for the route to increment if you later add a guess-tracking path. For this task, the `consumed` semantics already satisfy the test.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/workspace/pairing-sessions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/pairing-sessions.ts server/src/workspace/pairing-sessions.test.ts
git commit -m "feat(server): pairing sessions carry a label + support an 80-bit browser code"
```

---

### Task 5: Guard reads the `__Host-cw_lan` cookie

**Files:**
- Modify: `server/package.json` (declare `cookie`)
- Modify: `server/src/lan-auth.ts` (`extractToken`)
- Test: `server/src/lan-auth.test.ts`

**Interfaces:**
- Consumes: `cookie.parse`, `isValidDeviceToken` (Task 2/3).
- Produces: `requireLanToken` now accepts a valid device token delivered via the `__Host-cw_lan` cookie.

- [ ] **Step 1: Declare the dependency**

Run: `cd server && npm pkg get dependencies.cookie` (expect empty), then:
`cd server && npm install cookie@^1.1.1 --save-exact=false`
Confirm: `cd server && node -e "console.log(require('cookie/package.json').version)"` prints `1.1.x`.

- [ ] **Step 2: Write the failing test** — add to `server/src/lan-auth.test.ts`:

```ts
import { parse as _p } from 'cookie'; // sanity: dep resolvable

it('accepts a valid device token from the __Host-cw_lan cookie', async () => {
  // enforce the guard
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  const { token } = await createDevice('Phone', 30); // from device-tokens
  const req = mkReq({ headers: { cookie: `__Host-cw_lan=${token}` }, ip: '192.168.1.9' });
  const res = mkRes();
  const next = vi.fn();
  requireLanToken(req, res, next);
  expect(next).toHaveBeenCalled();
  expect(res.statusCode).not.toBe(401);
});

it('rejects a garbage cookie', () => {
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  const req = mkReq({ headers: { cookie: '__Host-cw_lan=not-a-token' }, ip: '192.168.1.9' });
  const res = mkRes();
  const next = vi.fn();
  requireLanToken(req, res, next);
  expect(next).not.toHaveBeenCalled();
  expect(res.statusCode).toBe(401);
});
```

(Reuse this file's existing `mkReq`/`mkRes` helpers; if absent, mirror the existing tests' request/response stubs in this file.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run src/lan-auth.test.ts -t "cookie"`
Expected: FAIL — `extractToken` ignores cookies.

- [ ] **Step 4: Implement** — in `server/src/lan-auth.ts`, import cookie and extend `extractToken` to check the cookie **first**:

```ts
import { parse as parseCookie } from 'cookie';

export function extractToken(req: Request): string | undefined {
  const cookies = req.headers['cookie'];
  if (typeof cookies === 'string') {
    const c = parseCookie(cookies)['__Host-cw_lan'];
    if (typeof c === 'string' && c.length > 0) return c;
  }
  const auth = req.headers['authorization'];
  if (typeof auth === 'string' && auth.startsWith('Bearer ')) {
    const t = auth.slice('Bearer '.length).trim();
    if (t.length > 0) return t;
  }
  const header = req.headers['x-lan-token'];
  if (typeof header === 'string' && header.length > 0) return header;
  const q = req.query?.token;
  if (typeof q === 'string' && q.length > 0) return q;
  return undefined;
}
```

Add a one-line comment on `isLoopbackRequest` noting it assumes a direct (un-proxied) bind.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd server && npx vitest run src/lan-auth.test.ts`
Expected: PASS (all existing cases still green).

- [ ] **Step 6: Commit**

```bash
git add server/package.json server/package-lock.json server/src/lan-auth.ts server/src/lan-auth.test.ts
git commit -m "feat(server): guard accepts a device token via the __Host-cw_lan cookie"
```

---

### Task 6: CSRF Origin allow-list middleware

**Files:**
- Create: `server/src/csrf-origin.ts`
- Test: `server/src/csrf-origin.test.ts`

**Interfaces:**
- Consumes: `enumerateLanUrls(port, 'https')` (`server/src/routes/export-lan.ts`), `isLoopbackRequest`, `extractToken`-style cookie detection.
- Produces: `requireSameOrigin(req, res, next)` — 403s a **cookie-bearing, state-changing** request whose `Origin`/`Referer` origin is not allow-listed.

- [ ] **Step 1: Write the failing test** — `server/src/csrf-origin.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { requireSameOrigin } from './csrf-origin.js';

function mk(method: string, headers: Record<string, string>, ip = '192.168.1.9') {
  return { method, headers, ip, socket: { remoteAddress: ip } } as any;
}
function res() {
  return { statusCode: 200, body: undefined as unknown, status(c: number){this.statusCode=c;return this;}, json(b: unknown){this.body=b;return this;} } as any;
}

beforeEach(() => { process.env.LAN_HTTPS_PORT = '8443'; });

it('passes a GET regardless of origin', () => {
  const next = vi.fn();
  requireSameOrigin(mk('GET', {}), res(), next);
  expect(next).toHaveBeenCalled();
});

it('passes a cookie POST from an allowed loopback origin', () => {
  const next = vi.fn();
  requireSameOrigin(mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://localhost:8443' }), res(), next);
  expect(next).toHaveBeenCalled();
});

it('403s a cookie POST with a foreign origin', () => {
  const next = vi.fn(); const r = res();
  requireSameOrigin(mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://evil.example:8443' }), r, next);
  expect(next).not.toHaveBeenCalled();
  expect(r.statusCode).toBe(403);
});

it('403s a cookie POST with NO origin and NO referer (fail-closed)', () => {
  const next = vi.fn(); const r = res();
  requireSameOrigin(mk('POST', { cookie: '__Host-cw_lan=x' }), r, next);
  expect(r.statusCode).toBe(403);
});

it('passes a header-token POST (companion) with no cookie', () => {
  const next = vi.fn();
  requireSameOrigin(mk('POST', { 'x-lan-token': 'tok' }), res(), next);
  expect(next).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/csrf-origin.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement** — `server/src/csrf-origin.ts`:

```ts
/* CSRF defense for cookie-authenticated browser requests (LAN device auth).
   Cookie creds auto-attach cross-site; a header/Bearer token (companion) does
   not, so we only gate requests that actually carry the __Host-cw_lan cookie.
   Allow-list = the LAN HTTPS origins + explicit loopback origins, recomputed
   per request (NICs change), never empty. Fail-closed on absent Origin+Referer
   for state-changing methods. */
import type { Request, Response, NextFunction } from './http.js';
import { enumerateLanUrls } from './routes/export-lan.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function allowedOrigins(): Set<string> {
  const port = Number(process.env.LAN_HTTPS_PORT ?? 8443);
  const { urls } = enumerateLanUrls(port, 'https'); // ['https://192.168.x.y:8443', ...]
  return new Set<string>([
    ...urls,
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `https://[::1]:${port}`,
  ]);
}

function originOf(req: Request): string | undefined {
  const o = req.headers['origin'];
  if (typeof o === 'string' && o.length > 0) return o;
  const r = req.headers['referer'];
  if (typeof r === 'string' && r.length > 0) {
    try { return new URL(r).origin; } catch { return undefined; }
  }
  return undefined;
}

function hasCwLanCookie(req: Request): boolean {
  const c = req.headers['cookie'];
  return typeof c === 'string' && /(?:^|;\s*)__Host-cw_lan=/.test(c);
}

export function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
  if (!MUTATING.has((req.method ?? 'GET').toUpperCase())) return next();
  if (!hasCwLanCookie(req)) return next(); // header/Bearer or loopback: not cookie-CSRF-able
  const origin = originOf(req);
  if (origin !== undefined && allowedOrigins().has(origin)) return next();
  res.status(403).json({ error: 'Cross-origin request rejected.' });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/csrf-origin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/csrf-origin.ts server/src/csrf-origin.test.ts
git commit -m "feat(server): Origin allow-list CSRF guard for cookie-authed writes"
```

---

### Task 7: Devices route — admin mint ttl + `POST /api/devices/pair-session`

**Files:**
- Modify: `server/src/routes/devices.ts`
- Test: `server/src/routes/devices.test.ts`

**Interfaces:**
- Consumes: `createPairingSession(label, undefined, 10)` (Task 4), `isLanTokenEnforced`/`isLoopbackRequest` (`lan-auth.ts`), `enumerateLanUrls` (`export-lan.ts`), `configValue` (`config/resolver.ts`).
- Produces: `POST /api/devices/pair-session` → `{ url, code, expiresAt }`; admin `POST /api/devices` now mints a 30-day token.

- [ ] **Step 1: Write the failing test** — add to `server/src/routes/devices.test.ts` (this suite drives the router with supertest or the project's app harness — mirror the existing `/devices` tests):

```ts
it('pair-session returns a #/pair URL payload from loopback when enforced', async () => {
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  process.env.LAN_HTTPS_PORT = '8443';
  const res = await request(app).post('/api/devices/pair-session')
    .set('X-Forwarded-For', '') // ensure loopback in harness
    .send({ label: 'Mike phone' });
  expect(res.status).toBe(200);
  expect(res.body.url).toMatch(/\/#\/pair\?c=[0-9A-HJKMNP-TV-Z]{16}$/);
  expect(typeof res.body.expiresAt).toBe('number');
});

it('pair-session 409s when LAN auth is not enforced', async () => {
  delete process.env.LAN_AUTH_TOKEN;
  process.env.LAN_HTTPS = '1';
  const res = await request(app).post('/api/devices/pair-session').send({ label: 'x' });
  expect(res.status).toBe(409);
});
```

(If the existing devices tests assert `createDevice` was called — they mock it — keep the mock but make it accept `(label, ttlDays)`.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/devices.test.ts -t "pair-session"`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement** — in `server/src/routes/devices.ts`:

```ts
import { createDevice, listDevices, revokeDevice } from '../workspace/device-tokens.js';
import { createPairingSession } from '../workspace/pairing-sessions.js';
import { isLanTokenEnforced, isLoopbackRequest } from '../lan-auth.js';
import { enumerateLanUrls } from './export-lan.js';
import { configValue } from '../config/resolver.js';

// admin mint — now stamps the configured TTL
devicesRouter.post('/devices', async (req: Request, res: Response) => {
  const raw = (req.body as { label?: unknown } | undefined)?.label;
  const label = typeof raw === 'string' ? raw : 'Device';
  const ttl = configValue<number>('lan.deviceTokenTtlDays');
  const { device, token } = await createDevice(label, ttl);
  res.status(201).json({ ...device, token });
});

// browser pairing session (loopback-only; requires enforcement so the cookie is meaningful + HTTPS)
devicesRouter.post('/devices/pair-session', (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: 'Pairing can only be started from the host UI.' });
    return;
  }
  if (!isLanTokenEnforced()) {
    res.status(409).json({ error: 'lan-auth-not-enforced' });
    return;
  }
  const port = Number(process.env.LAN_HTTPS_PORT ?? 8443);
  const { urls } = enumerateLanUrls(port, 'https');
  const host = urls[0]?.replace(/^https:\/\//, '');
  if (!host) {
    res.status(409).json({ error: 'no-lan-url' });
    return;
  }
  const label = typeof (req.body as { label?: unknown })?.label === 'string'
    ? (req.body as { label: string }).label : 'Device';
  const { code, expiresAt } = createPairingSession(label, undefined, 10);
  res.json({ url: `https://${host}/#/pair?c=${code}`, code, expiresAt });
});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/devices.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/devices.ts server/src/routes/devices.test.ts
git commit -m "feat(server): admin mint stamps TTL + POST /api/devices/pair-session (QR URL)"
```

---

### Task 8: Pairing route — companion redeem ttl + `POST /api/pair/redeem-browser`

**Files:**
- Modify: `server/src/routes/pairing.ts`
- Test: `server/src/routes/pairing.test.ts`

**Interfaces:**
- Consumes: `redeemPairingSession` (Task 4), `createDevice` (Task 2), `configValue`, `isLanTokenEnforced`, a dedicated rate limiter.
- Produces: `POST /api/pair/redeem-browser` — sets `__Host-cw_lan`, returns `{ label, expiresAt }`; mounted on the pre-guard `pairRedeemRouter`.

- [ ] **Step 1: Write the failing test** — add to `server/src/routes/pairing.test.ts`:

```ts
it('redeem-browser sets the __Host-cw_lan cookie and returns no raw token', async () => {
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  // mint a code first via the (loopback) device pair-session, or call createPairingSession directly:
  const { code } = createPairingSession('Mike phone', undefined, 10);
  const res = await request(app).post('/api/pair/redeem-browser').send({ code });
  expect(res.status).toBe(201);
  expect(res.body).toHaveProperty('label', 'Mike phone');
  expect(res.body).toHaveProperty('expiresAt');
  expect(res.body).not.toHaveProperty('token');
  const setCookie = String(res.headers['set-cookie'] ?? '');
  expect(setCookie).toMatch(/__Host-cw_lan=/);
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Strict/i);
  expect(setCookie).toMatch(/Secure/i);
});

it('redeem-browser 409s when LAN auth not enforced', async () => {
  delete process.env.LAN_AUTH_TOKEN;
  const { code } = createPairingSession('x', undefined, 10);
  const res = await request(app).post('/api/pair/redeem-browser').send({ code });
  expect(res.status).toBe(409);
});

it('redeem-browser rate-limits after 5/min', async () => {
  process.env.LAN_HTTPS = '1'; process.env.LAN_AUTH_TOKEN = 'secret';
  for (let i = 0; i < 5; i++) await request(app).post('/api/pair/redeem-browser').send({ code: 'WRONGWRONGWRONG1' });
  const res = await request(app).post('/api/pair/redeem-browser').send({ code: 'WRONGWRONGWRONG1' });
  expect(res.status).toBe(429);
});
```

Also update the companion-redeem mock expectations so `createDevice` is called as `(label, <number>)`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/pairing.test.ts -t "redeem-browser"`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement** — in `server/src/routes/pairing.ts`:

```ts
import rateLimit from 'express-rate-limit';
import express from 'express';
import { configValue } from '../config/resolver.js';
import { isLanTokenEnforced } from '../lan-auth.js';

// companion redeem — now stamps the configured TTL (contract unchanged)
const ttl = () => configValue<number>('lan.deviceTokenTtlDays');
// ...inside pairRedeemRouter.post('/redeem', ...): replace createDevice(label)
//    with createDevice(label, ttl())

// dedicated limiter — NOT skipped under Vitest (the global apiLimiter is)
const browserRedeemLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.ip ?? 'unknown',
});

pairRedeemRouter.post(
  '/redeem-browser',
  browserRedeemLimiter,
  express.json({ limit: '1kb' }),
  async (req: Request, res: Response) => {
    if (!isLanTokenEnforced()) {
      res.status(409).json({ error: 'lan-auth-not-enforced' });
      return;
    }
    const code = typeof (req.body as { code?: unknown })?.code === 'string'
      ? (req.body as { code: string }).code : '';
    const result = redeemPairingSession(code);
    if (!result.ok) {
      res.status(result.reason === 'unknown' ? 401 : 410).json({ error: result.reason });
      return;
    }
    const ttlDays = ttl();
    const { device, token } = await createDevice(result.label ?? 'Device', ttlDays);
    res.cookie('__Host-cw_lan', token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: ttlDays * 86_400_000,
    });
    res.status(201).json({ label: device.label, expiresAt: device.expiresAt });
  },
);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/routes/pairing.test.ts`
Expected: PASS (existing companion redeem + session tests stay green).

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pairing.ts server/src/routes/pairing.test.ts
git commit -m "feat(server): POST /api/pair/redeem-browser sets HttpOnly cookie; companion mint stamps TTL"
```

---

### Task 9: Wire CSRF guard + invariant tests

**Files:**
- Modify: `server/src/index.ts` (mount `requireSameOrigin` after `requireLanToken`)
- Test: `server/src/lan-auth.invariants.test.ts` (new)

**Interfaces:**
- Consumes: `requireSameOrigin` (Task 6); existing middleware order in `index.ts`.

- [ ] **Step 1: Write the failing test** — `server/src/lan-auth.invariants.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const idx = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

it('never enables trust proxy (loopback gate integrity)', () => {
  expect(idx).not.toMatch(/trust proxy/);
});

it('mounts requireSameOrigin after requireLanToken', () => {
  const csrf = idx.indexOf('requireSameOrigin');
  const guard = idx.indexOf('requireLanToken');
  expect(guard).toBeGreaterThan(-1);
  expect(csrf).toBeGreaterThan(guard);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/lan-auth.invariants.test.ts`
Expected: FAIL — `requireSameOrigin` not yet mounted.

- [ ] **Step 3: Implement** — in `server/src/index.ts`, immediately after the `app.use(['/api','/workspace'], requireLanToken)` line, add:

```ts
import { requireSameOrigin } from './csrf-origin.js';
// ...
app.use('/api', requireSameOrigin); // after requireLanToken, before route handlers
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/lan-auth.invariants.test.ts && npm run test:server`
Expected: PASS; full server suite green.

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts server/src/lan-auth.invariants.test.ts
git commit -m "feat(server): mount Origin CSRF guard + trust-proxy/mount-order invariants"
```

---

### Task 10: Frontend api — `ApiError` + 4 new fns + mocks

**Files:**
- Modify: `src/lib/api.ts`
- Test: `src/lib/api.devices.test.ts` (new)

**Interfaces:**
- Produces:
  - `class ApiError extends Error { status: number }`
  - `api.createDevicePairSession(body: { label: string }): Promise<{ url: string; code: string; expiresAt: number }>`
  - `api.listDevices(): Promise<{ devices: PublicDevice[] }>`
  - `api.revokeDevice(id: string): Promise<{ ok: true }>`
  - `api.redeemBrowserPair(body: { code: string }): Promise<{ label: string; expiresAt: string }>`
  - `PublicDevice` type mirrored in `src/lib/types.ts`: `{ id; label; createdAt; expiresAt?; lastSeenAt?; revoked }`.

- [ ] **Step 1: Write the failing test** — `src/lib/api.devices.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ApiError } from './api';

it('ApiError carries a numeric status', () => {
  const e = new ApiError('nope', 401);
  expect(e).toBeInstanceOf(Error);
  expect(e.status).toBe(401);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/api.devices.test.ts`
Expected: FAIL — `ApiError` not exported.

- [ ] **Step 3: Implement** — in `src/lib/api.ts` add the error class + the four real fns (each throwing `ApiError` on non-OK) and their mock mirrors; register them on both `mock` and `real` objects:

```ts
export class ApiError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = 'ApiError'; }
}

async function realCreateDevicePairSession(body: { label: string }) {
  const res = await fetch('/api/devices/pair-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(`pair-session failed (${res.status})`, res.status);
  return res.json() as Promise<{ url: string; code: string; expiresAt: number }>;
}
async function realListDevices() {
  const res = await fetch('/api/devices');
  if (!res.ok) throw new ApiError(`list devices failed (${res.status})`, res.status);
  return res.json() as Promise<{ devices: PublicDevice[] }>;
}
async function realRevokeDevice(id: string) {
  const res = await fetch(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (!res.ok) throw new ApiError(`revoke failed (${res.status})`, res.status);
  return res.json() as Promise<{ ok: true }>;
}
async function realRedeemBrowserPair(body: { code: string }) {
  const res = await fetch('/api/pair/redeem-browser', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(`redeem failed (${res.status})`, res.status);
  return res.json() as Promise<{ label: string; expiresAt: string }>;
}
```

Mocks (mock mode has no real cookie — these just satisfy the UI flow):

```ts
const mockCreateDevicePairSession = async (b: { label: string }) =>
  ({ url: `https://mock.local:8443/#/pair?c=MOCKCODEMOCKCODE`, code: 'MOCKCODEMOCKCODE', expiresAt: Date.now() + 300_000 });
const mockListDevices = async () => ({ devices: [] as PublicDevice[] });
const mockRevokeDevice = async (_id: string) => ({ ok: true as const });
const mockRedeemBrowserPair = async (_b: { code: string }) =>
  ({ label: 'This browser', expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString() });
```

Add all four to the `api` mock/real dispatch object alongside the existing methods.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/api.devices.test.ts && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts src/lib/types.ts src/lib/api.devices.test.ts
git commit -m "feat(frontend): api client for device pairing + typed ApiError"
```

---

### Task 11: Library resilience — error state + Retry

**Files:**
- Modify: `src/store/library-slice.ts`, `src/components/layout.tsx`, `src/views/book-library.tsx`, `src/components/library/library-grid.tsx`
- Test: `src/store/library-slice.test.ts`, `src/views/book-library.test.tsx`

**Interfaces:**
- Produces: `libraryActions.hydrateError(message: string)`; slice field `error: string | null`; `hydrate(...)` clears `error`.

- [ ] **Step 1: Write the failing test** — in `src/store/library-slice.test.ts`:

```ts
it('hydrateError sets loaded + error; hydrate clears error', () => {
  let s = reducer(initialState, libraryActions.hydrateError('boom'));
  expect(s.loaded).toBe(true);
  expect(s.error).toBe('boom');
  s = reducer(s, libraryActions.hydrate({ authors: [], books: [] } as any));
  expect(s.error).toBeNull();
});
```

In `src/views/book-library.test.tsx`, add a case rendering the view with `library: { loaded: true, error: 'Network', books: [], authors: [] }` and assert a "Retry" button is present.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/store/library-slice.test.ts src/views/book-library.test.tsx -t "error"`
Expected: FAIL — no `error` field / no `hydrateError` / no Retry UI.

- [ ] **Step 3: Implement**

`src/store/library-slice.ts`: add `error: string | null` to state (init `null`); add `hydrateError(state, action: PayloadAction<string>) { state.loaded = true; state.error = action.payload; }`; in `hydrate`, set `state.error = null`.

`src/components/layout.tsx` (the library-hydrate effect, ~`:529`): change the `.catch` from `console.error(...)` only to also dispatch:

```ts
.catch((err) => {
  console.error('[library] hydrate failed', err);
  dispatch(libraryActions.hydrateError(err instanceof Error ? err.message : String(err)));
});
```

`src/views/book-library.tsx`: read `const error = useAppSelector((s) => s.library.error);` and, when `loaded && error`, render (before the grid/empty branches):

```tsx
<div className="bg-white rounded-3xl border border-ink/10 shadow-card p-12 text-center" role="alert">
  <h3 className="font-serif text-2xl font-bold text-ink">Couldn't load your library</h3>
  <p className="mt-2 text-sm text-ink/60">{error}</p>
  <PrimaryButton variant="dark" onClick={() => dispatch(libraryActions.hydrateError(''))} icon={false}>Retry</PrimaryButton>
</div>
```

Wire Retry to re-run the hydrate: simplest is to expose an `onRetry` from the orchestrator that calls `api.getLibrary().then(hydrate).catch(hydrateError)`; thread the same handler into `library-grid.tsx`'s loaded+error branch so the grid path also offers Retry.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/library-slice.test.ts src/views/book-library.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/library-slice.ts src/components/layout.tsx src/views/book-library.tsx src/components/library/library-grid.tsx src/store/library-slice.test.ts src/views/book-library.test.tsx
git commit -m "fix(frontend): library scan failure shows Retry instead of an eternal skeleton"
```

---

### Task 12: Extract a shared QR component

**Files:**
- Create: `src/components/pairing/pairing-qr.tsx`
- Modify: `src/modals/pair-device.tsx` (consume the shared component)
- Test: `src/components/pairing/pairing-qr.test.tsx`

**Interfaces:**
- Produces: `<PairingQr payload={string} expiresAt={number} onRegenerate={() => void} />` — renders the QR (via the existing `QRCode.toDataURL` path), a countdown to `expiresAt`, and a Regenerate button. Payload-agnostic (companion `CWP1*…` or browser URL).

- [ ] **Step 1: Write the failing test** — `pairing-qr.test.tsx`: render `<PairingQr payload="CWP1*h*c*f" expiresAt={Date.now()+300000} onRegenerate={() => {}} />`; assert an `<img>` (the QR) appears and a "Regenerate" control is present; render again with a URL payload and assert it still renders.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/pairing/pairing-qr.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement** — lift the QR-rendering + countdown + Regenerate block out of `src/modals/pair-device.tsx` into `PairingQr`, parameterized by `payload`/`expiresAt`/`onRegenerate` (no companion-specific `fpTag` inside — the modal still computes that and passes only the `qrPayload` string). Update `pair-device.tsx` to render `<PairingQr payload={info.qrPayload} expiresAt={info.expiresAt} onRegenerate={refetch} />`.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/pairing/pairing-qr.test.tsx && npx vitest run src/modals/pair-device.test.tsx`
Expected: PASS — companion modal regression stays green.

- [ ] **Step 5: Commit**

```bash
git add src/components/pairing/pairing-qr.tsx src/modals/pair-device.tsx src/components/pairing/pairing-qr.test.tsx
git commit -m "refactor(frontend): extract shared PairingQr component"
```

---

### Task 13: `#/pair` sibling route + PairShell

**Files:**
- Create: `src/views/pair.tsx`
- Modify: `src/routes/index.tsx` (add the second top-level route)
- Test: `src/views/pair.test.tsx`

**Interfaces:**
- Consumes: `api.redeemBrowserPair` (Task 10), `useSearchParams`, `useNavigate`.
- Produces: a route at `/pair` rendering `<PairShell/>` outside `<Layout>`.

- [ ] **Step 1: Write the failing test** — `pair.test.tsx`: render `<PairShell/>` inside a `MemoryRouter` (hash) with `?c=ABC`; assert the "Authorize this browser" confirm screen renders from the query param; click Authorize → assert `api.redeemBrowserPair` was called with `{ code: 'ABC' }` and that on resolve it navigates to `/`. Assert no `getLibrary`/`getSetupReadiness` calls fire from this component (it mounts none of Layout's effects).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/views/pair.test.tsx`
Expected: FAIL — view does not exist.

- [ ] **Step 3: Implement**

`src/views/pair.tsx`:

```tsx
import { useState } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { api, ApiError } from '../lib/api';
import { PrimaryButton } from '../components/primitives';

export function PairShell() {
  const [params] = useSearchParams();
  const code = params.get('c') ?? '';
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const authorize = async () => {
    setBusy(true); setError(null);
    try {
      await api.redeemBrowserPair({ code });
      // Strip the code from history, then hand off to the app; Layout mounts on
      // '/' and fetches the library (now carrying the __Host-cw_lan cookie).
      window.history.replaceState(null, '', '#/');
      navigate('/');
    } catch (e) {
      const msg = e instanceof ApiError && (e.status === 401 || e.status === 410)
        ? 'This code expired — generate a new one on the desktop.'
        : e instanceof ApiError && e.status === 429
        ? 'Too many attempts — wait a minute and try again.'
        : 'Could not authorize this browser.';
      setError(msg); setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center bg-canvas px-6 text-center">
      <div className="max-w-sm">
        <h1 className="font-serif text-2xl font-bold text-ink">Authorize this browser?</h1>
        <p className="mt-2 text-sm text-ink/60">This device will stay signed in to Castwright on your local network.</p>
        {error && <p className="mt-3 text-sm text-rose-700">{error}</p>}
        <PrimaryButton variant="dark" onClick={authorize} disabled={busy || !code} icon={false}>
          {busy ? 'Authorizing…' : 'Authorize'}
        </PrimaryButton>
      </div>
    </div>
  );
}
```

`src/routes/index.tsx`: change the `createHashRouter([...])` argument to a **two-element** array — add `{ path: '/pair', element: <PairShell /> }` **before** the existing `{ path: '/', element: <Layout/>, children: [...] }`. Import `PairShell`. Leave the `{ path: '*', element: <NotFound/> }` catch-all where it is (inside Layout's `children`).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/views/pair.test.tsx && npm run typecheck`
Expected: PASS + typecheck clean.

- [ ] **Step 5: Commit**

```bash
git add src/views/pair.tsx src/routes/index.tsx src/views/pair.test.tsx
git commit -m "feat(frontend): #/pair Layout-free route to authorize a browser"
```

---

### Task 14: Admin "LAN access" card

**Files:**
- Create: `src/components/lan-access-card.tsx`
- Modify: `src/views/admin.tsx` (render the card)
- Test: `src/components/lan-access-card.test.tsx`

**Interfaces:**
- Consumes: `api.createDevicePairSession`, `api.listDevices`, `api.revokeDevice`, `ApiError` (Task 10); `<PairingQr/>` (Task 12).

- [ ] **Step 1: Write the failing test** — `lan-access-card.test.tsx`:
  - Mock `api.listDevices` → one device `{ id:'1', label:'Mike phone', createdAt, expiresAt, revoked:false }`; assert label, "added", "expires" render and a Revoke button calls `api.revokeDevice('1')`.
  - "Authorize a device" → type label → assert `api.createDevicePairSession` called and `<PairingQr/>` (an `<img>`) appears.
  - Mock `api.listDevices` to reject with `new ApiError('x', 401)` → assert the "manage from the desktop" note renders (no crash).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: FAIL — component does not exist.

- [ ] **Step 3: Implement** — `src/components/lan-access-card.tsx`: a card matching the existing Admin card styling with: a label input + "Authorize a device" button (calls `createDevicePairSession`, shows `<PairingQr payload={url} .../>`); a device list (`label · added · last seen · expires`, "—" when `lastSeenAt` absent) each with Revoke; a 401 catch → render "Manage devices from the desktop." Render it inside `src/views/admin.tsx` alongside the existing cards. Use `time.ts` helpers for date formatting and design-token classes (no hex).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/lan-access-card.tsx src/views/admin.tsx src/components/lan-access-card.test.tsx
git commit -m "feat(frontend): Admin LAN access card (authorize + device list + revoke)"
```

---

### Task 15: E2E UI-flow + backlog + closeout

**Files:**
- Create: `e2e/lan-device-auth.spec.ts`
- Modify: `docs/BACKLOG.md`
- Create (GitHub): a `srv-NN` issue

**Interfaces:** none (closeout).

- [ ] **Step 1: Write the e2e UI-flow spec** (mock mode — NOT an auth test): drive `#/admin`, click "Authorize a device", type a label, assert a QR `<img>` appears; then `page.goto('/#/pair?c=MOCKCODEMOCKCODE')`, click Authorize, assert the URL lands on `#/` and the library view renders. Add a comment that this exercises the UI flow only; the cookie→guarded-GET chain is covered by the server supertest tests + manual acceptance.

- [ ] **Step 2: Run it**

Run: `npm run test:e2e -- lan-device-auth`
Expected: PASS.

- [ ] **Step 3: File the backlog issue + row**

```bash
gh issue create --title "srv-NN — Authorize a browser over LAN via Admin device-linking" \
  --label "area:server,area:frontend,type:feature" \
  --body "Implements docs/superpowers/specs/2026-06-18-lan-browser-device-auth-design.md. See PR."
```

Add a thin row under the appropriate MoSCoW bucket in `docs/BACKLOG.md` linking the issue, then replace `srv-NN` with the real number throughout the spec + plan.

- [ ] **Step 4: Full battery**

Run: `npm run verify`
Expected: typecheck + all tests + e2e + build green.

- [ ] **Step 5: Commit**

```bash
git add e2e/lan-device-auth.spec.ts docs/BACKLOG.md docs/superpowers/specs/2026-06-18-lan-browser-device-auth-design.md docs/superpowers/plans/2026-06-18-lan-browser-device-auth.md
git commit -m "test(e2e): LAN device-auth UI flow + backlog row"
```

---

## Manual acceptance (real device — after merge-candidate is built)

`npm run start:lan` with `LAN_HTTPS=1` + `LAN_AUTH_TOKEN` set:
1. Desktop Admin → "Authorize a device" → label → QR appears.
2. Scan with the phone's native camera → opens `#/pair` → tap Authorize.
3. Library loads on the phone; survives a reload; "last seen" updates in the desktop list after use.
4. Revoke on the desktop → the phone 401s on its next navigation.
5. A phone write (e.g. edit book meta) passes the Origin check; a forged cross-origin write returns 403.
6. (If any legacy companion token exists, it re-pairs once.)

## Implementation traps (carry into review)

- `persist()` must write `{schema: 2}` (Task 2) — else an ordinary mutation reverts the file to schema 1.
- Pin `cookie@^1.1.1` (Task 5) — it's currently only transitive via Express 5.
- Document the IPv6-LAN / hostname-`.local` Origin limitation (both fail *closed*) near `csrf-origin.ts` (Task 6).
- The dedicated redeem limiter must NOT inherit the global `apiLimiter`'s Vitest skip (Task 8).
