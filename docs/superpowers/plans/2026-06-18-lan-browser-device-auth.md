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

Update `persist` to write schema 2 **and set the cache AFTER a successful write**
(defense-in-depth: a failed write leaves cache and disk consistent — no phantom
unpaired device, no revocation silently resurrected on restart):

```ts
async function persist(devices: DeviceTokenRecord[]): Promise<void> {
  await writeJsonAtomic(deviceTokensJsonPath(), { schema: 2, devices });
  cache = devices; // only after the write durably succeeds
}
```

Add a pure TTL clamp (a second validation boundary — `configValue` does NOT
enforce the knob's `min:1` on the override/default paths, so a bad override could
otherwise mint instantly-dead tokens or throw `Invalid Date`). Keep it config-free
(it takes the raw value; the route reads `configValue` and passes it in):

```ts
/** Clamp a configured TTL to a sane positive integer; fall back to the 30-day default. */
export function clampTtlDays(raw: unknown): number {
  return typeof raw === 'number' && Number.isInteger(raw) && raw >= 1 ? raw : 30;
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
- Modify: `server/src/workspace/device-tokens.ts` (`isValidDeviceToken` + an awaitable touch + a pure throttle predicate)
- Create: `server/src/workspace/device-tokens.test.ts` (**does not exist today** — create it with a temp-workspace harness)

**Interfaces:**
- Consumes: `findValidDevice` (Task 2), the in-memory `cache`, `persist`.
- Produces:
  - `shouldTouchLastSeen(record: DeviceTokenRecord, now: number): boolean` (pure — testable).
  - `touchLastSeen(id: string, now: number): Promise<void>` (awaitable — updates cache + persists).
  - `isValidDeviceToken(rawToken)` keeps its sync signature; it calls `touchLastSeen` **fire-and-forget** (`void`) when `shouldTouchLastSeen` is true.

> Why a separate file + harness: `WORKSPACE_ROOT` is read once at module load (`server/src/workspace/paths.ts`), so the only IO-backed device-token tests today live in `routes/devices.test.ts`. There is **no** `device-tokens.test.ts`. We must create it and point the workspace at a temp dir **before importing** the module, or `persist()` writes to the real `castwright-workspace`.

- [ ] **Step 1: Write the failing test** — create `server/src/workspace/device-tokens.test.ts`. Mirror the harness `routes/devices.test.ts` uses (temp `WORKSPACE_DIR` + `vi.resetModules()` + dynamic import). The deterministic assertion uses the **awaitable** `touchLastSeen`, not a timer:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let dt: typeof import('./device-tokens.js');

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-devtok-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();                       // re-read WORKSPACE_ROOT at module load
  dt = await import('./device-tokens.js');
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

it('shouldTouchLastSeen is throttled (pure)', async () => {
  const now = 1_000_000_000_000;
  const fresh = { id: '1', label: 'P', tokenHash: 'h', createdAt: '', lastSeenAt: new Date(now - 1000).toISOString() };
  const stale = { ...fresh, lastSeenAt: new Date(now - 2 * 60 * 60 * 1000).toISOString() };
  const never = { id: '1', label: 'P', tokenHash: 'h', createdAt: '' };
  expect(dt.shouldTouchLastSeen(fresh, now)).toBe(false);
  expect(dt.shouldTouchLastSeen(stale, now)).toBe(true);
  expect(dt.shouldTouchLastSeen(never, now)).toBe(true);
});

it('touchLastSeen persists lastSeenAt; isValidDeviceToken triggers it', async () => {
  const { device } = await dt.createDevice('Phone', 30);
  await dt.touchLastSeen(device.id, Date.now());      // awaitable → deterministic
  dt._resetDeviceTokenCacheForTests();
  expect(dt.listDevices()[0].lastSeenAt).toBeDefined();

  const { token } = await dt.createDevice('Phone2', 30);
  expect(dt.isValidDeviceToken(token)).toBe(true);     // fire-and-forget touch path still returns true
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/device-tokens.test.ts`
Expected: FAIL — `shouldTouchLastSeen` / `touchLastSeen` not exported.

- [ ] **Step 3: Implement** — in `server/src/workspace/device-tokens.ts`:

```ts
const LASTSEEN_THROTTLE_MS = 60 * 60 * 1000; // ~1h — bounds disk writes on the hot guard path

/** Pure: has it been long enough since lastSeenAt to be worth a write? */
export function shouldTouchLastSeen(record: DeviceTokenRecord, now: number): boolean {
  const last = record.lastSeenAt ? Date.parse(record.lastSeenAt) : 0;
  return now - last > LASTSEEN_THROTTLE_MS;
}

/** Awaitable: stamp lastSeenAt for one device and persist. */
export async function touchLastSeen(id: string, now: number): Promise<void> {
  const next = loadSync().map((d) =>
    d.id === id ? { ...d, lastSeenAt: new Date(now).toISOString() } : d,
  );
  await persist(next);
}

export function isValidDeviceToken(rawToken: string): boolean {
  const now = Date.now();
  const device = findValidDevice(loadSync(), rawToken, now);
  if (!device) return false;
  // Best-effort, fire-and-forget: a raced/failed persist is harmless.
  if (shouldTouchLastSeen(device, now)) void touchLastSeen(device.id, now);
  return true;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd server && npx vitest run src/workspace/device-tokens.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/workspace/device-tokens.ts server/src/workspace/device-tokens.test.ts
git commit -m "feat(server): throttled lastSeenAt touch-on-use for device tokens"
```

---

### Task 4: Pairing sessions — label + ≥80-bit browser code

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

> Note for the implementer: a *correct* code redeems on first call and is then `consumed` (single-use). A wrong code isn't in the `sessions` map, so it returns `unknown` and burns nothing — the brute-force control is the **80-bit entropy + the route rate limiter (Task 8)**, not a session counter. Do NOT add a `misses` field — it would be dead code.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/workspace/pairing-sessions.test.ts`
Expected: FAIL — signature is `(now)`, no label, no `bytes`.

- [ ] **Step 3: Implement** — rewrite the body of `server/src/workspace/pairing-sessions.ts`:

```ts
interface Session {
  expiresAt: number;
  consumed: boolean;
  label?: string;
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
  sessions.set(code, { expiresAt, consumed: false, label });
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

(`sweep`, `TTL_MS`, `_resetPairingSessionsForTests` unchanged. The `consumed` single-use semantics already satisfy the test; the brute-force control is entropy + the Task 8 route limiter, so no session-level counter is needed.)

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

Run: `cd server && npm pkg get dependencies.cookie` (expect empty), then declare
the version Express 5 already resolves, so it **dedupes** (declaring `^1.x` would
add a second copy):
`cd server && npm install cookie@^0.7.2 --save-exact=false`
Confirm: `cd server && node -e "console.log(require('cookie/package.json').version)"` prints `0.7.x`, and `npm ls cookie` shows a single deduped entry.

- [ ] **Step 2: Write the failing test** — add to `server/src/lan-auth.test.ts`. **Mock `device-tokens` so the guard test does no workspace IO** (this file has no temp-workspace harness and must not touch the real `castwright-workspace`). Put the mock at the top of the file with the other imports:

```ts
vi.mock('./workspace/device-tokens.js', () => ({
  isValidDeviceToken: (t: string) => t === 'goodtoken',
}));
```

Then:

```ts
it('accepts a valid device token from the __Host-cw_lan cookie', () => {
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  const req = mkReq({ headers: { cookie: '__Host-cw_lan=goodtoken' }, ip: '192.168.1.9' });
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

(Reuse this file's existing `mkReq`/`mkRes` helpers — they exist near the top of `lan-auth.test.ts`. If the file already imports `device-tokens` indirectly, ensure the `vi.mock` is hoisted above that import.)

- [ ] **Step 3: Run test to verify it fails**

Run: `cd server && npx vitest run src/lan-auth.test.ts -t "cookie"`
Expected: FAIL — `extractToken` ignores cookies.

- [ ] **Step 4: Implement** — in `server/src/lan-auth.ts`, import cookie and extend `extractToken` to check the cookie **first**:

```ts
import { parse as parseCookie } from 'cookie';

/** Parse the cw_lan cookie defensively — this runs on EVERY /api request, so an
 *  unguarded throw here (e.g. a future `cookie` version that rejects bad input)
 *  would 500 the entire API. cookie@0.7.x doesn't throw, but the catch is cheap
 *  insurance for the hottest path. The same helper backs the CSRF guard's
 *  cookie detection (Task 6) so auth and CSRF agree on "is this a cookie request". */
export function readCwLanCookie(cookieHeader: unknown): string | undefined {
  if (typeof cookieHeader !== 'string' || cookieHeader.length === 0) return undefined;
  try {
    const v = parseCookie(cookieHeader)['__Host-cw_lan'];
    return typeof v === 'string' && v.length > 0 ? v : undefined;
  } catch {
    return undefined;
  }
}

export function extractToken(req: Request): string | undefined {
  const c = readCwLanCookie(req.headers['cookie']);
  if (c !== undefined) return c;
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

it('still gates a cookie that cookie.parse accepts but a naive regex might miss', () => {
  // Leading whitespace + other pairs first — cookie.parse handles it; assert CSRF still fires.
  const next = vi.fn(); const r = res();
  requireSameOrigin(mk('POST', { cookie: 'foo=bar; __Host-cw_lan=x', origin: 'https://evil.example:8443' }), r, next);
  expect(next).not.toHaveBeenCalled();
  expect(r.statusCode).toBe(403);
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
import { readCwLanCookie } from './lan-auth.js';

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function allowedOrigins(): Set<string> {
  const port = Number(process.env.LAN_HTTPS_PORT ?? 8443);
  const loopback = [
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `https://[::1]:${port}`,
  ];
  try {
    const { urls } = enumerateLanUrls(port, 'https'); // ['https://192.168.x.y:8443', ...]
    return new Set<string>([...urls, ...loopback]);
  } catch {
    // Fail closed: if NIC enumeration ever throws, still allow loopback only —
    // never let an exception turn every cookie-bearing write into a 500.
    return new Set<string>(loopback);
  }
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
  // Use the SAME parser as the auth guard (readCwLanCookie → cookie.parse), so a
  // cookie that authenticates the request is never treated as "no cookie" here —
  // a regex/parse divergence would silently drop CSRF protection.
  return readCwLanCookie(req.headers['cookie']) !== undefined;
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

- [ ] **Step 1: Write the failing test** — add to `server/src/routes/devices.test.ts` (this suite uses **supertest against a real `app`** — `request(app)`; under supertest `req.ip === '::ffff:127.0.0.1'`, which is in the `LOOPBACK` set, so loopback-only routes pass). **Mock `enumerateLanUrls`** so the 200 case doesn't depend on a live LAN NIC (a no-NIC box would otherwise return `409 no-lan-url`). Add at the top of the file:

```ts
vi.mock('./export-lan.js', async (orig) => ({
  ...(await orig<typeof import('./export-lan.js')>()),
  enumerateLanUrls: () => ({ urls: ['https://192.168.1.7:8443'], port: 8443, protocol: 'https' }),
}));
```

Then:

```ts
it('pair-session returns a #/pair URL payload from loopback when enforced', async () => {
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  process.env.LAN_HTTPS_PORT = '8443';
  const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
  expect(res.status).toBe(200);
  expect(res.body.url).toMatch(/^https:\/\/192\.168\.1\.7:8443\/#\/pair\?c=[0-9A-HJKMNP-TV-Z]{16}$/);
  expect(typeof res.body.expiresAt).toBe('number');
});

it('pair-session 409s when LAN auth is not enforced', async () => {
  delete process.env.LAN_AUTH_TOKEN;
  process.env.LAN_HTTPS = '1';
  const res = await request(app).post('/api/devices/pair-session').send({ label: 'x' });
  expect(res.status).toBe(409);
});

it('admin mint POST /api/devices is loopback-only (403 from a non-loopback request)', async () => {
  // Under supertest req.ip is loopback, so mock the gate to simulate a LAN client.
  // Add at top of file: vi.mock('../lan-auth.js', async (o) => ({ ...(await o()),
  //   isLoopbackRequest: vi.fn(() => true), isLanTokenEnforced: vi.fn(() => true) }));
  vi.mocked(isLoopbackRequest).mockReturnValueOnce(false);
  const res = await request(app).post('/api/devices').send({ label: 'x' });
  expect(res.status).toBe(403);
});
```

(Note: `devices.test.ts` uses the **real** `createDevice` against its temp workspace — there is no `createDevice` mock to update here. The loopback-gate test needs `isLoopbackRequest` mockable; spread the real module and override just `isLoopbackRequest`/`isLanTokenEnforced` as shown, so `requireLanToken` stays real for the existing guard tests.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/devices.test.ts -t "pair-session"`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement** — in `server/src/routes/devices.ts`:

```ts
import { createDevice, listDevices, revokeDevice, clampTtlDays } from '../workspace/device-tokens.js';
import { createPairingSession } from '../workspace/pairing-sessions.js';
import { isLanTokenEnforced, isLoopbackRequest } from '../lan-auth.js';
import { enumerateLanUrls } from './export-lan.js';
import { configValue } from '../config/resolver.js';

// admin mint — LOOPBACK-ONLY (defense-in-depth: a stolen browser cookie must NOT
// be able to mint a fresh, durable device token that survives revoking the stolen
// one — minting stays a physical-desktop capability), and clamps the TTL.
devicesRouter.post('/devices', async (req: Request, res: Response) => {
  if (!isLoopbackRequest(req)) {
    res.status(403).json({ error: 'Devices can only be minted from the host UI.' });
    return;
  }
  const raw = (req.body as { label?: unknown } | undefined)?.label;
  const label = typeof raw === 'string' ? raw : 'Device';
  const ttl = clampTtlDays(configValue('lan.deviceTokenTtlDays'));
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

- [ ] **Step 1: Extend the existing mocks** in `server/src/routes/pairing.test.ts`. This file mocks `../lan-auth.js` (currently exporting only `isLoopbackRequest`) and `../workspace/device-tokens.js` (mock `createDevice(label)` returning no `expiresAt`). Both must change or Task 8 throws/asserts wrong:

```ts
// lan-auth mock — add isLanTokenEnforced (default true; per-test override for the 409 case)
vi.mock('../lan-auth.js', () => ({
  isLoopbackRequest: () => true,
  isLanTokenEnforced: vi.fn(() => true),
}));
import { isLanTokenEnforced } from '../lan-auth.js';

// device-tokens mock — accept (label, ttlDays), return a device WITH expiresAt
vi.mock('../workspace/device-tokens.js', () => ({
  createDevice: vi.fn(async (label: string, ttlDays: number) => ({
    device: { id: 'd1', label, createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000).toISOString(), revoked: false },
    token: 'tok_test',
  })),
}));
```

Reset the dedicated limiter between tests so the 5/min budget doesn't bleed (under supertest every request keys to `::ffff:127.0.0.1`). Task 8 Step 3 **exports** `browserRedeemLimiter`; reset it here:

```ts
import { browserRedeemLimiter } from './pairing.js';
beforeEach(() => { browserRedeemLimiter.resetKey('::ffff:127.0.0.1'); });
```

Then add the tests:

```ts
it('redeem-browser sets the __Host-cw_lan cookie and returns no raw token', async () => {
  const { code } = createPairingSession('Mike phone', undefined, 10);
  const res = await request(app).post('/api/pair/redeem-browser').send({ code });
  expect(res.status).toBe(201);
  expect(res.body).toHaveProperty('label', 'Mike phone');
  expect(res.body).toHaveProperty('expiresAt');
  expect(res.body).not.toHaveProperty('token');
  const setCookie = String(res.headers['set-cookie'] ?? '');
  expect(setCookie).toMatch(/__Host-cw_lan=tok_test/);
  expect(setCookie).toMatch(/HttpOnly/i);
  expect(setCookie).toMatch(/SameSite=Strict/i);
  expect(setCookie).toMatch(/Secure/i);
});

it('redeem-browser 409s when LAN auth not enforced', async () => {
  vi.mocked(isLanTokenEnforced).mockReturnValueOnce(false); // env won't reach the mocked module
  const { code } = createPairingSession('x', undefined, 10);
  const res = await request(app).post('/api/pair/redeem-browser').send({ code });
  expect(res.status).toBe(409);
});

it('redeem-browser rate-limits after 5/min', async () => {
  for (let i = 0; i < 5; i++) await request(app).post('/api/pair/redeem-browser').send({ code: 'WRONGWRONGWRONG1' });
  const res = await request(app).post('/api/pair/redeem-browser').send({ code: 'WRONGWRONGWRONG1' });
  expect(res.status).toBe(429);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd server && npx vitest run src/routes/pairing.test.ts -t "redeem-browser"`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement** — in `server/src/routes/pairing.ts`:

```ts
import rateLimit from 'express-rate-limit';
import express from 'express';
import { configValue } from '../config/resolver.js';
import { isLanTokenEnforced } from '../lan-auth.js';
import { clampTtlDays } from '../workspace/device-tokens.js';

// companion redeem — now stamps the configured TTL (contract unchanged).
// clampTtlDays guards a bad override: NaN→Invalid Date→500, or 0/negative→instantly-dead token.
const ttl = () => clampTtlDays(configValue('lan.deviceTokenTtlDays'));
// ...inside pairRedeemRouter.post('/redeem', ...): replace createDevice(label)
//    with createDevice(label, ttl())

// dedicated limiter — NOT skipped under Vitest (the global apiLimiter is).
// Exported so tests can reset its store between cases (shared IP under supertest).
export const browserRedeemLimiter = rateLimit({
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

- [ ] **Step 4b: Write the END-TO-END integration test (the spec's promised cookie→guarded-GET chain).** `pairing.test.ts` mocks the guard + device-tokens, so it can't prove the real chain. Create a dedicated file with **no mocks** + a temp workspace + the real app, exercising redeem → capture `Set-Cookie` → replay on a guarded GET → assert it passes; and a foreign-Origin write → 403. Create `server/src/routes/lan-cookie-integration.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let app: import('express').Express;
let createPairingSession: typeof import('../workspace/pairing-sessions.js').createPairingSession;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-lan-int-'));
  process.env.WORKSPACE_DIR = dir;
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'secret';
  process.env.LAN_HTTPS_PORT = '8443';
  vi.resetModules();
  ({ createPairingSession } = await import('../workspace/pairing-sessions.js'));
  ({ app } = await import('../app.js')); // the assembled Express app (real guard + csrf + redeem-browser)
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR; delete process.env.LAN_AUTH_TOKEN; delete process.env.LAN_HTTPS;
  rmSync(dir, { recursive: true, force: true });
});

it('a redeem-browser cookie authorizes a subsequent guarded GET from a LAN IP', async () => {
  const { code } = createPairingSession('Phone', undefined, 10);
  const redeem = await request(app).post('/api/pair/redeem-browser').send({ code });
  expect(redeem.status).toBe(201);
  const cookie = redeem.headers['set-cookie'];
  // From a NON-loopback IP the guard would 401 without the cookie; with it, it passes.
  const guarded = await request(app).get('/api/library')
    .set('Cookie', cookie).set('X-Forwarded-For', '10.0.0.9');
  expect(guarded.status).not.toBe(401);
});

it('a cookie-bearing write with a foreign Origin is 403 (CSRF)', async () => {
  const { code } = createPairingSession('Phone', undefined, 10);
  const cookie = (await request(app).post('/api/pair/redeem-browser').send({ code })).headers['set-cookie'];
  const res = await request(app).post('/api/devices') // a guarded state-changing route
    .set('Cookie', cookie).set('Origin', 'https://evil.example:8443').send({ label: 'x' });
  expect(res.status).toBe(403);
});
```

> If the app isn't exported from a `server/src/app.ts` (it may be assembled inline in `index.ts`), first check `index.ts`: if `app` is not separately importable, extract the app assembly into `app.ts` and have `index.ts` import + `listen()` on it (a small, mechanical refactor) so the integration test can import the wired app without binding a port. Note `req.ip` is `::ffff:127.0.0.1` under supertest regardless of `X-Forwarded-For` (trust proxy is unset), so the guard sees loopback for the redeem (fine — redeem is pre-guard) but the **guarded GET must be tested with the cookie**, which is what proves the chain.

Run: `cd server && npx vitest run src/routes/lan-cookie-integration.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/pairing.ts server/src/routes/pairing.test.ts server/src/routes/lan-cookie-integration.test.ts
git commit -m "feat(server): POST /api/pair/redeem-browser sets HttpOnly cookie; companion mint stamps TTL"
```

---

### Task 9: Wire CSRF guard + invariant tests

**Files:**
- Create: `server/src/lan-safety.ts` (runtime trust-proxy assertion + exposure warning)
- Modify: `server/src/index.ts` (mount `requireSameOrigin` after `requireLanToken`; call the two runtime guards at assembly/startup)
- Test: `server/src/lan-auth.invariants.test.ts` (new) + `server/src/lan-safety.test.ts` (new)

**Interfaces:**
- Consumes: `requireSameOrigin` (Task 6); `isLanTokenEnforced`, `isLanHttpsEnabled`.
- Produces:
  - `assertNoTrustProxy(app)` — throws at assembly if `trust proxy` is ever set (a **runtime** layer that survives test deletion; the loopback gate is single-tier on this).
  - `lanExposureWarning(): string | null` — the WARN to log when bound non-loopback but unauthenticated.

- [ ] **Step 1: Write the failing tests** — `server/src/lan-safety.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import express from 'express';
import { assertNoTrustProxy, lanExposureWarning } from './lan-safety.js';

it('assertNoTrustProxy throws when trust proxy is set', () => {
  const a = express(); a.set('trust proxy', true);
  expect(() => assertNoTrustProxy(a)).toThrow(/trust proxy/i);
});
it('assertNoTrustProxy passes by default', () => {
  expect(() => assertNoTrustProxy(express())).not.toThrow();
});

beforeEach(() => { delete process.env.LAN_HTTPS; delete process.env.LAN_AUTH_TOKEN; });
it('warns when bound to LAN but token unset', () => {
  process.env.LAN_HTTPS = '1';
  expect(lanExposureWarning()).toMatch(/unauthenticated/i);
});
it('is silent when enforced or loopback-only', () => {
  process.env.LAN_HTTPS = '1'; process.env.LAN_AUTH_TOKEN = 'secret';
  expect(lanExposureWarning()).toBeNull();
  delete process.env.LAN_HTTPS; delete process.env.LAN_AUTH_TOKEN;
  expect(lanExposureWarning()).toBeNull();
});
```

And `server/src/lan-auth.invariants.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
const idx = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');

it('never enables trust proxy in source (early-catch layer; the runtime assert is the real gate)', () => {
  expect(idx).not.toMatch(/trust proxy/);
});
it('mounts requireSameOrigin after requireLanToken', () => {
  const csrf = idx.indexOf('requireSameOrigin');
  const guard = idx.indexOf('requireLanToken');
  expect(guard).toBeGreaterThan(-1);
  expect(csrf).toBeGreaterThan(guard);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/lan-safety.test.ts src/lan-auth.invariants.test.ts`
Expected: FAIL — `lan-safety.ts` missing; `requireSameOrigin` not yet mounted.

- [ ] **Step 3: Implement**

`server/src/lan-safety.ts`:

```ts
import type { Express } from 'express';
import { getLanAuthToken } from './lan-auth.js';      // already exported (lan-auth.ts:18)
import { isLanHttpsEnabled } from './routes/export-lan.js';

/** The loopback gate (isLoopbackRequest) is spoofable if trust proxy honours
 *  X-Forwarded-For. This is the runtime layer that survives a deleted test. */
export function assertNoTrustProxy(app: Express): void {
  if (app.get('trust proxy')) {
    throw new Error('LAN auth requires `trust proxy` unset — the loopback gate would be spoofable.');
  }
}

/** WARN text when the server is bound to the LAN but the guard is a no-op. */
export function lanExposureWarning(): string | null {
  if (isLanHttpsEnabled() && getLanAuthToken() === undefined) {
    return 'WARN: LAN HTTPS is bound to all interfaces but LAN_AUTH_TOKEN is unset — the API is reachable UNAUTHENTICATED from the LAN.';
  }
  return null;
}
```

In `server/src/index.ts` (or `app.ts` if extracted per Task 8 Step 4b): call `assertNoTrustProxy(app)` right after `const app = express()`, mount the CSRF guard after the LAN guard, and log the exposure warning at startup:

```ts
import { requireSameOrigin } from './csrf-origin.js';
import { assertNoTrustProxy, lanExposureWarning } from './lan-safety.js';
// after `const app = express()`:
assertNoTrustProxy(app);
// after `app.use(['/api','/workspace'], requireLanToken)`:
app.use('/api', requireSameOrigin);
// near listen():
const warn = lanExposureWarning();
if (warn) console.warn(warn);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/lan-safety.test.ts src/lan-auth.invariants.test.ts && npm run test:server`
Expected: PASS; full server suite green.

- [ ] **Step 5: Commit**

```bash
git add server/src/lan-safety.ts server/src/index.ts server/src/lan-safety.test.ts server/src/lan-auth.invariants.test.ts
git commit -m "feat(server): mount CSRF guard + runtime trust-proxy assert + unauth-LAN exposure warning"
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
- Modify: `src/store/library-slice.ts`, `src/components/layout.tsx`, `src/views/book-library.tsx`
- Test: `src/store/library-slice.test.ts`, `src/views/book-library.test.tsx`

> The error panel is rendered by the **orchestrator** (`book-library.tsx`), short-circuiting before the grid/table/empty branches — so `library-grid.tsx` stays a pure render and needs no new props.

**Interfaces:**
- Produces: `libraryActions.hydrateError(message: string)`; slice field `error: string | null`; `hydrate(...)` clears `error`.

- [ ] **Step 1: Write the failing test** — in `src/store/library-slice.test.ts` (`hydrate` takes a `LibraryResponse`, which is `{ authors }` only — `books` is derived, so don't pass it):

```ts
it('hydrateError sets loaded + error; hydrate clears error', () => {
  let s = reducer(initialState, libraryActions.hydrateError('boom'));
  expect(s.loaded).toBe(true);
  expect(s.error).toBe('boom');
  s = reducer(s, libraryActions.hydrate({ authors: [] }));
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

`src/views/book-library.tsx`: read `const error = useAppSelector((s) => s.library.error);`, define a concrete retry that re-fetches (the orchestrator has `useAppDispatch` + imports `api`), and short-circuit the render before the `showNoResults`/card/table branches:

```tsx
const retry = () => {
  api
    .getLibrary()
    .then((res) => dispatch(libraryActions.hydrate(res)))
    .catch((e) => dispatch(libraryActions.hydrateError(e instanceof Error ? e.message : String(e))));
};

// ...in the returned JSX, immediately inside the outer wrapper, before <ContinueListeningRail/>/grid:
{loaded && error ? (
  <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-12 text-center" role="alert">
    <h3 className="font-serif text-2xl font-bold text-ink">Couldn't load your library</h3>
    <p className="mt-2 text-sm text-ink/60">{error}</p>
    <div className="mt-6"><PrimaryButton variant="dark" onClick={retry} icon={false}>Retry</PrimaryButton></div>
  </div>
) : (
  /* existing showNoResults / card / table branches unchanged */
)}
```

(`library-grid.tsx` is **not** modified — the orchestrator owns the error branch.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/store/library-slice.test.ts src/views/book-library.test.tsx`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/store/library-slice.ts src/components/layout.tsx src/views/book-library.tsx src/store/library-slice.test.ts src/views/book-library.test.tsx
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

- [ ] **Step 1: Write the failing test** — `pair.test.tsx`. Mount under `MemoryRouter` with a **plain** location carrying the query (NOT a hash fragment — `useSearchParams` reads `?c=` from the location's search): `<MemoryRouter initialEntries={['/pair?c=ABC']}><Routes><Route path="/pair" element={<PairShell/>}/><Route path="/" element={<div>home</div>}/></Routes></MemoryRouter>`. Mock `api.redeemBrowserPair` (resolve). Assert the "Authorize this browser" screen renders; click Authorize → assert `api.redeemBrowserPair` was called with `{ code: 'ABC' }` and the rendered tree navigates to `/` (the `home` div appears). (PairShell imports none of Layout's effects, so "no `getLibrary` fires" is structurally guaranteed — no need to assert it.)

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

`src/routes/index.tsx`: this file exports `const router = createHashRouter([...])` (imported + mounted by `main.tsx`). Change that single-element array to a **two-element** array — add `{ path: '/pair', element: <PairShell /> }` **before** the existing `{ path: '/', element: <Layout/>, children: [...] }`. Import `PairShell` from `../views/pair`. Leave the `{ path: '*', element: <NotFound/> }` catch-all where it is (inside Layout's `children`, so it doesn't swallow `/pair`).

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

- [ ] **Step 3: Implement** — `src/components/lan-access-card.tsx`. Match the existing Admin card shell (`bg-white rounded-3xl border border-ink/10 shadow-card`, per `admin.tsx`). **`time.ts` has no date formatter** (only duration helpers) — format ISO dates inline with `new Date(iso).toLocaleDateString()`. Design-token classes only (no hex):

```tsx
import { useEffect, useState } from 'react';
import { api, ApiError } from '../lib/api';
import type { PublicDevice } from '../lib/types';
import { PairingQr } from './pairing/pairing-qr';
import { PrimaryButton } from './primitives';

const fmt = (iso?: string) => (iso ? new Date(iso).toLocaleDateString() : '—');

export function LanAccessCard() {
  const [devices, setDevices] = useState<PublicDevice[] | null>(null);
  const [manageHint, setManageHint] = useState(false); // true on 401 (viewing from a phone)
  const [label, setLabel] = useState('');
  const [session, setSession] = useState<{ url: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const refresh = () => {
    api.listDevices()
      .then((r) => setDevices(r.devices))
      .catch((e) => { if (e instanceof ApiError && e.status === 401) setManageHint(true); else setErr(String(e)); });
  };
  useEffect(refresh, []);

  const authorize = async () => {
    setErr(null);
    try { setSession(await api.createDevicePairSession({ label: label.trim() || 'Device' })); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
  };
  const revoke = async (id: string) => { await api.revokeDevice(id); refresh(); };

  return (
    <section className="bg-white rounded-3xl border border-ink/10 shadow-card p-6">
      <h2 className="font-serif text-xl font-bold text-ink">LAN access</h2>
      {manageHint ? (
        <p className="mt-2 text-sm text-ink/60">Manage devices from the desktop app.</p>
      ) : (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <input
              value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Device name"
              className="px-3 py-2 rounded-xl border border-ink/15 bg-white text-sm text-ink min-h-[44px] sm:min-h-0"
            />
            <PrimaryButton variant="dark" onClick={authorize} icon={false}>Authorize a device</PrimaryButton>
          </div>
          {err && <p className="mt-2 text-sm text-rose-700">{err}</p>}
          {session && (
            <div className="mt-4">
              <PairingQr payload={session.url} expiresAt={session.expiresAt} onRegenerate={authorize} />
            </div>
          )}
          <ul className="mt-6 divide-y divide-ink/8">
            {(devices ?? []).map((d) => (
              <li key={d.id} className="py-3 flex items-center justify-between gap-3 text-sm">
                <span className="text-ink">
                  <span className="font-medium">{d.label}</span>
                  <span className="text-ink/55"> · added {fmt(d.createdAt)} · last seen {fmt(d.lastSeenAt)} · expires {fmt(d.expiresAt)}</span>
                </span>
                <button
                  type="button" onClick={() => revoke(d.id)}
                  className="px-3 py-1.5 rounded-lg border border-rose-200 bg-white text-xs text-rose-700 hover:bg-rose-50 min-h-[44px] sm:min-h-0"
                >Revoke</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
```

Render `<LanAccessCard/>` inside `src/views/admin.tsx` alongside the existing cards.

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
  --label "area:fs,type:feature" \
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
- Pin `cookie@^0.7.2` (Task 5) to match Express 5's resolved version so it dedupes — `^1.x` would add a second copy.
- Document the IPv6-LAN / hostname-`.local` Origin limitation (both fail *closed*) near `csrf-origin.ts` (Task 6).
- The dedicated redeem limiter must NOT inherit the global `apiLimiter`'s Vitest skip (Task 8).
