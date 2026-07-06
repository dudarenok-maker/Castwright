# One-click castwright.local pairing link Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a loopback-authorized browser (e.g. `https://localhost:8443`) one-click-open a
new tab that authorizes itself for `https://castwright.local`, without a phone camera to scan
the existing pairing QR.

**Architecture:** `POST /api/devices/pair-session` gains an optional `friendlyUrl` field,
populated only when the server can prove (not just infer from config) that both the mDNS
responder and the `:443` port forwarder are actually up. `LanAccessCard` renders that URL as a
plain link next to the existing QR when present; everything else about the QR/raw-IP pairing
path is untouched.

**Tech Stack:** TypeScript, Express (server), React + Vitest + Testing Library (frontend),
Node `child_process`/`net` (the two LAN helper processes).

## Global Constraints

- **Scope: start:lan (production) only.** `castwright.local` is only server-tracked under
  `NODE_ENV === 'production'` LAN HTTPS. `dev:lan`/`castwright.dev.local` is out of scope —
  `LanAccessCard` must fall back to QR-only there exactly as it does today (no `friendlyUrl`
  field at all, not an empty one).
- **Additive only.** No existing field (`url`, `code`, `expiresAt`) on the pair-session
  response changes shape or meaning. No existing QR/raw-IP pairing behavior changes.
- **Gate on real liveness, not launch config.** `friendlyUrl` must only appear when the mDNS
  responder and the `:443` forwarder are both observed to be actually serving — never merely
  "were told to start." (This is the Critical finding two rounds of adversarial review fixed
  in the spec — see `docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md`.)
- **No circular imports.** `server/src/routes/devices.ts` must never import from
  `server/src/index.ts`. Use `app.set()`/`app.get()` (the exact idiom `index.ts:376-382`
  already uses for `lanHttpsServer`) to cross that boundary.
- **`mdns-owner.ts`'s `isAlive()` must flip false on ANY non-intentional exit, code 0
  included** — `scripts/mdns-responder.mjs`'s only voluntary exit path reachable from this
  spawn (a graceful multicast-bind failure) uses `process.exit(0)`, not a nonzero code.
- Every new/changed unit gets a paired automated test (this project's "Testing discipline" —
  see `CLAUDE.md`). No e2e test is needed — this is additive UI behind an already-loopback-
  gated admin flow, not new mock-mode-reachable surface.
- Full spec (with its adversarial-review history) lives at
  `docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md` — read it
  if any task below feels under-explained; it has the full "why," this plan has the full "how."

---

### Task 1: `PortForwarderHandle.isBound()` — real bind-liveness for the `:443` forwarder

**Files:**
- Modify: `server/src/lan-port-forwarder.ts`
- Test: `server/src/lan-port-forwarder.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `net.Server`, `'listening'`/`'error'` events already
  wired in this file).
- Produces: `PortForwarderHandle.isBound(): boolean` — `false` until the server's `'listening'`
  event has fired at least once, `true` forever after (a later transient `'error'` does not
  reset it). Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Open `server/src/lan-port-forwarder.test.ts`. Add this new `describe` block directly before the
file's final closing `});` (i.e. inside the existing `describe('startPortForwarder', ...)`
block, after the last `it(...)` — the `listenAndGetPort` helper defined near the top of that
block is in scope):

```ts
  describe('isBound()', () => {
    it('is false before listening, true after', async () => {
      const handle = startPortForwarder(9999, { listenPort: 0 });
      expect(handle.isBound()).toBe(false);
      await listenAndGetPort(handle.server);
      expect(handle.isBound()).toBe(true);
      await handle.close();
    });

    it('stays true across a later transient error (the EMFILE-after-bind case — net.Server can emit "error" more than once without dying)', async () => {
      const handle = startPortForwarder(9999, { listenPort: 0 });
      await listenAndGetPort(handle.server);
      expect(handle.isBound()).toBe(true);
      handle.server.emit('error', new Error('transient EMFILE'));
      expect(handle.isBound()).toBe(true);
      await handle.close();
    });

    it('is false if the bind fails before "listening" ever fires (never-bound case)', async () => {
      const blocker = net.createServer();
      blocker.listen(0, '0.0.0.0');
      const blockedPort = await listenAndGetPort(blocker);

      const warn = vi.fn();
      const handle = startPortForwarder(9999, { listenPort: blockedPort, warn });
      await new Promise<void>((resolve) => handle.server.once('error', () => resolve()));

      expect(handle.isBound()).toBe(false);

      await handle.close();
      blocker.close();
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run lan-port-forwarder.test.ts`
Expected: FAIL — `handle.isBound is not a function` (3 new failures; all other tests in the
file still pass).

- [ ] **Step 3: Implement `isBound()`**

In `server/src/lan-port-forwarder.ts`:

1. Widen the interface (around line 34):

```ts
export interface PortForwarderHandle {
  server: net.Server;
  close: () => Promise<void>;
  isBound: () => boolean;
}
```

2. Add the closure-scoped flag right after `openClientSockets` is declared (around line 86),
   and register the listener right after `server.listen(...)` is called (around line 157):

```ts
  const openClientSockets = new Set<net.Socket>();
  let bound = false;
```

...leave everything in between unchanged, then right after the existing
`server.listen(listenPort, '0.0.0.0');` line:

```ts
  server.listen(listenPort, '0.0.0.0');
  server.once('listening', () => {
    bound = true;
  });

  return {
    server,
    isBound: () => bound,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
        // Force-evict any still-open client sockets (see openClientSockets'
        // own comment above) so the close() callback above can fire promptly
        // instead of waiting on a connection that may never end naturally.
        for (const socket of openClientSockets) socket.destroy();
      }),
  };
```

(Only the `return` statement's shape changes — the `close` implementation body is unchanged
from what's already there; the diff is adding `isBound` as a sibling key.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run lan-port-forwarder.test.ts`
Expected: PASS — all tests in the file green (the 3 new ones plus every pre-existing one).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/lan-port-forwarder.ts server/src/lan-port-forwarder.test.ts
git commit -m "feat(server): add isBound() liveness check to the LAN port forwarder"
```

---

### Task 2: `MdnsResponderHandle.isAlive()` — real liveness for the mDNS responder

**Files:**
- Modify: `server/src/mdns-owner.ts`
- Test: `server/src/mdns-owner.test.ts`

**Interfaces:**
- Consumes: nothing new (uses the existing `child.once('exit', ...)` handler already wired in
  this file).
- Produces: `MdnsResponderHandle.isAlive(): boolean` — `true` immediately after a successful
  spawn; flips to `false` on ANY non-intentional exit (code `0` included — this script's only
  voluntary self-exit reachable from this spawn is its graceful bind-failure path, which uses
  `process.exit(0)`); stays at whatever it already was across an intentional `kill()`.
  Consumed by Task 3.

- [ ] **Step 1: Write the failing tests**

Open `server/src/mdns-owner.test.ts`. Add these new tests inside the existing
`describe('spawnMdnsResponder', ...)` block, anywhere after the existing
`makeFakeChild`-using tests (e.g. right after the `"does NOT warn on a clean exit(0)..."` test):

```ts
  it('isAlive() is true right after a normal spawn', () => {
    const spawnFn = vi.fn(() => makeFakeChild());
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
    });
    expect(handle!.isAlive()).toBe(true);
  });

  it('isAlive() flips false after a graceful bind-failure exit(0) — the exact case round 2 of adversarial review caught missing', () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
    });
    child.emit('exit', 0, null);
    expect(handle!.isAlive()).toBe(false);
  });

  it('isAlive() flips false after an unexpected nonzero exit', () => {
    const child = makeFakeChild();
    const spawnFn = vi.fn(() => child);
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
    });
    child.emit('exit', 1, null);
    expect(handle!.isAlive()).toBe(false);
  });

  it('isAlive() stays at its prior value across an intentional kill() (the killedIntentionally guard skips the flip entirely, matching the existing no-warn behavior for this case)', async () => {
    const child = makeFakeChild();
    // Stub .kill so the non-win32 kill() branch (child.kill('SIGTERM')) has something
    // to call — makeFakeChild() is a bare EventEmitter with no .kill method otherwise,
    // matching the existing "kill() on non-win32 sends SIGTERM directly" test's setup.
    const killSpy = vi.fn();
    (child as unknown as { kill: typeof killSpy }).kill = killSpy;
    const spawnFn = vi.fn(() => child);
    const handle = spawnMdnsResponder('castwright.local', '/repo', {
      spawnFn: spawnFn as unknown as typeof import('node:child_process').spawn,
      warn: vi.fn(),
      platform: 'linux',
    });
    expect(handle!.isAlive()).toBe(true);
    await handle!.kill();
    child.emit('exit', null, 'SIGTERM');
    expect(handle!.isAlive()).toBe(true);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run mdns-owner.test.ts`
Expected: FAIL — `handle.isAlive is not a function` (4 new failures; every pre-existing test in
the file still passes).

- [ ] **Step 3: Implement `isAlive()`**

In `server/src/mdns-owner.ts`:

1. Widen the interface (around line 37):

```ts
export interface MdnsResponderHandle {
  child: ChildProcess;
  kill: () => Promise<void>;
  isAlive: () => boolean;
}
```

2. Add the closure-scoped flag and the corrected exit handler. Replace the existing block:

```ts
  let killedIntentionally = false;

  child.once('error', (err) => {
    warn(`[mdns] responder for ${hostname} reported an error:`, err);
  });
  /* The 'error' handler above only catches a SYNCHRONOUS spawn throw (e.g.
     a bad node binary). A child that starts fine but then crashes (e.g.
     "Cannot find module" if the responder script or a dependency is
     missing) exits ASYNCHRONOUSLY with a nonzero code — without this, that
     failure is silent: the caller holds a handle to an already-dead child
     and is never told. Only a clean exit(0) (the responder's own graceful
     bind-failure path — see scripts/mdns-responder.mjs) and
     killedIntentionally (an explicit kill() call — checked first, so it
     wins regardless of what exit code/signal the OS reports for it;
     Windows' `taskkill /F` reports a NONZERO code (commonly 1) while POSIX
     SIGTERM reports code=null+signal=SIGTERM) do NOT warn. Everything else
     warns, including a null code we did NOT ask for — e.g. an OS OOM-kill,
     an external `pkill`, or a SIGSEGV crash, all of which Node reports as
     code=null with `signal` set. */
  child.once('exit', (code, signal) => {
    if (killedIntentionally) return;
    if (code !== 0) {
      warn(
        `[mdns] responder for ${hostname} exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ''})`,
      );
    }
  });
```

with:

```ts
  let killedIntentionally = false;
  let alive = true;

  child.once('error', (err) => {
    warn(`[mdns] responder for ${hostname} reported an error:`, err);
  });
  /* The 'error' handler above only catches a SYNCHRONOUS spawn throw (e.g.
     a bad node binary). A child that starts fine but then crashes (e.g.
     "Cannot find module" if the responder script or a dependency is
     missing) exits ASYNCHRONOUSLY with a nonzero code — without this, that
     failure is silent: the caller holds a handle to an already-dead child
     and is never told. Only killedIntentionally (an explicit kill() call —
     checked first, so it wins regardless of what exit code/signal the OS
     reports for it; Windows' `taskkill /F` reports a NONZERO code (commonly
     1) while POSIX SIGTERM reports code=null+signal=SIGTERM) skips both the
     `alive` flip and the warning below.

     `alive` flips false on ANY non-intentional exit, code 0 included —
     unlike the warn condition below, which stays gated to `code !== 0`.
     scripts/mdns-responder.mjs's only voluntary exit path reachable from
     this caller's spawn (which always passes --name) is a graceful
     multicast-bind failure, and that path uses process.exit(0) — so
     code===0 here does NOT mean "fine, still serving," it means "gave up
     and already logged its own message." Treating it as still-alive was a
     Critical bug caught by round 2 of adversarial review on the design
     spec (docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md):
     it let a dead responder keep answering isFriendlyHostnameReachable()
     with "true," handing a friendlyUrl to a user with no other way to
     pair. The warn() call stays code-gated because the graceful path
     already logs its own message from inside mdns-responder.mjs itself —
     warning here too would just be a redundant second line, not a
     correctness issue. */
  child.once('exit', (code, signal) => {
    if (killedIntentionally) return;
    alive = false;
    if (code !== 0) {
      warn(
        `[mdns] responder for ${hostname} exited unexpectedly (code=${code}${signal ? `, signal=${signal}` : ''})`,
      );
    }
  });
```

3. Add `isAlive` to the returned object (around line 118 — only the first line of the `return`
   changes, the rest of the object is unchanged):

```ts
  return {
    child,
    isAlive: () => alive,
    /* Returns a Promise that resolves once the kill attempt has genuinely
       ... (unchanged) */
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run mdns-owner.test.ts`
Expected: PASS — all tests in the file green (the 4 new ones plus every pre-existing one,
including `"does NOT warn on a clean exit(0)..."`, which must still pass unchanged since only
`alive` — not the `warn()` gating — changed).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/mdns-owner.ts server/src/mdns-owner.test.ts
git commit -m "feat(server): add isAlive() liveness check to the mDNS responder handle"
```

---

### Task 3: wire `isFriendlyHostnameReachable` through `index.ts` and add `friendlyUrl` to the pair-session response

**Files:**
- Modify: `server/src/index.ts`
- Modify: `server/src/routes/devices.ts`
- Test: `server/src/routes/devices.test.ts`

**Interfaces:**
- Consumes: `PortForwarderHandle.isBound()` (Task 1), `MdnsResponderHandle.isAlive()` (Task 2).
- Produces: an Express app setting, `app.get('isFriendlyHostnameReachable')`, typed
  `(() => boolean) | undefined` at the call site — read by `devices.ts`'s pair-session handler
  to decide whether to include `friendlyUrl` in its JSON response. This is the same
  `app.set()`/`app.get()` idiom `index.ts` already uses for `'lanHttpsServer'`
  (`index.ts:376-382`), not a new mechanism.

- [ ] **Step 1: Write the failing tests**

Open `server/src/routes/devices.test.ts`. Add these three tests directly after the existing
`'pair-session returns a #/pair URL payload from loopback when enforced'` test (which stays
completely unchanged — it never sets `isFriendlyHostnameReachable`, so it must keep passing
with `res.body.friendlyUrl` simply absent from the assertions, exactly as today):

```ts
  it('pair-session includes a friendlyUrl when isFriendlyHostnameReachable is set true', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    app.set('isFriendlyHostnameReachable', () => true);
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    expect(res.body.friendlyUrl).toMatch(/^https:\/\/castwright\.local\/#\/pair\?c=[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  it('pair-session omits friendlyUrl when isFriendlyHostnameReachable is set false', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    app.set('isFriendlyHostnameReachable', () => false);
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    expect(res.body.friendlyUrl).toBeUndefined();
  });

  it('pair-session omits friendlyUrl when the getter was never set (a bare test app that skipped app.set — not any real server mode, which always sets it via the shared listenerCallback)', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    expect(res.body.friendlyUrl).toBeUndefined();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd server && npx vitest run routes/devices.test.ts`
Expected: FAIL on the first new test — `res.body.friendlyUrl` is `undefined` when the test
expects it to match the URL pattern (the field doesn't exist in the response yet). The other
two new tests pass trivially already (nothing to omit yet) but re-run them anyway once the
field exists, in Step 4.

- [ ] **Step 3: Implement**

**3a. `server/src/routes/devices.ts`** — in the `POST /devices/pair-session` handler, replace:

```ts
  const label = typeof (req.body as { label?: unknown })?.label === 'string'
    ? (req.body as { label: string }).label : 'Device';
  const { code, expiresAt } = createPairingSession(label, undefined, 10);
  res.json({ url: `https://${host}/#/pair?c=${code}`, code, expiresAt });
});
```

with:

```ts
  const label = typeof (req.body as { label?: unknown })?.label === 'string'
    ? (req.body as { label: string }).label : 'Device';
  const { code, expiresAt } = createPairingSession(label, undefined, 10);
  const isFriendlyHostnameReachable = req.app.get('isFriendlyHostnameReachable') as
    (() => boolean) | undefined;
  const friendlyUrl = isFriendlyHostnameReachable?.() === true
    ? `https://castwright.local/#/pair?c=${code}`
    : undefined;
  res.json({ url: `https://${host}/#/pair?c=${code}`, code, expiresAt, friendlyUrl });
});
```

**3b. `server/src/index.ts`** — in `listenerCallback` (the block that spawns the mDNS responder
and the port forwarder), replace:

```ts
    if (shouldSpawnPortForwarder(lanHttps)) {
      portForwarderHandle = startPortForwarder(LAN_HTTPS_PORT);
    }
  };
```

with:

```ts
    if (shouldSpawnPortForwarder(lanHttps)) {
      portForwarderHandle = startPortForwarder(LAN_HTTPS_PORT);
    }

    /* castwright-local-pairing-link — expose a single combined liveness check
       for the friendly-hostname pairing link (server/src/routes/devices.ts),
       via app.set()/app.get() — the same idiom this file already uses for
       'lanHttpsServer' just above (see that comment), avoiding a circular
       import: devices.ts is mounted by app.js, which this file imports, so
       devices.ts importing back from here would be circular. This runs on
       EVERY boot (LAN-HTTPS or not) since listenerCallback is shared by both
       app.listen() branches — in non-LAN-HTTPS mode both handles are null,
       so the getter is still set, just permanently false, not unset. */
    app.set('isFriendlyHostnameReachable', () =>
      mdnsResponderHandle?.isAlive() === true && portForwarderHandle?.isBound() === true,
    );
  };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd server && npx vitest run routes/devices.test.ts`
Expected: PASS — all tests in the file green, including the pre-existing
`'pair-session returns a #/pair URL payload from loopback when enforced'` test (unaffected —
it never sets the getter, so `friendlyUrl` is simply absent, which that test's assertions never
check for either way).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add server/src/index.ts server/src/routes/devices.ts server/src/routes/devices.test.ts
git commit -m "feat(server): add friendlyUrl to the pair-session response, gated on real liveness"
```

---

### Task 4: widen the frontend API types for `friendlyUrl`

**Files:**
- Modify: `src/lib/api.ts:6092-6098` (`realCreateDevicePairSession`)
- Modify: `src/lib/api.ts:6125-6126` (`mockCreateDevicePairSession`)

**Interfaces:**
- Consumes: the widened JSON shape from Task 3 (`{ url, code, expiresAt, friendlyUrl? }`).
- Produces: `api.createDevicePairSession(...)` now resolves
  `Promise<{ url: string; code: string; expiresAt: number; friendlyUrl?: string }>` under both
  the real and mock implementations — consumed by Task 5.

This task is a type-surface fix, not a runtime behavior change (the real fetch already returns
`friendlyUrl` at runtime once Task 3 ships server-side; only the TypeScript cast was blind to
it) — so its verification is `npm run typecheck`, not a new unit test, matching how this file's
existing hand-cast wire functions are verified elsewhere in the codebase.

- [ ] **Step 1: Widen `realCreateDevicePairSession`'s return type**

In `src/lib/api.ts`, replace:

```ts
async function realCreateDevicePairSession(body: { label: string }) {
  const res = await fetch('/api/devices/pair-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(`pair-session failed (${res.status})`, res.status);
  return res.json() as Promise<{ url: string; code: string; expiresAt: number }>;
}
```

with:

```ts
async function realCreateDevicePairSession(body: { label: string }) {
  const res = await fetch('/api/devices/pair-session', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!res.ok) throw new ApiError(`pair-session failed (${res.status})`, res.status);
  return res.json() as Promise<{ url: string; code: string; expiresAt: number; friendlyUrl?: string }>;
}
```

- [ ] **Step 2: Add `friendlyUrl` to `mockCreateDevicePairSession`**

Replace:

```ts
const mockCreateDevicePairSession = async (_b: { label: string }) =>
  ({ url: `https://mock.local:8443/#/pair?c=MOCKCODEMOCKCODE`, code: 'MOCKCODEMOCKCODE', expiresAt: Date.now() + 300_000 });
```

with:

```ts
const mockCreateDevicePairSession = async (_b: { label: string }) =>
  ({
    url: `https://mock.local:8443/#/pair?c=MOCKCODEMOCKCODE`,
    code: 'MOCKCODEMOCKCODE',
    expiresAt: Date.now() + 300_000,
    friendlyUrl: 'https://castwright.local/#/pair?c=MOCKCODEMOCKCODE',
  });
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no new errors (this also confirms `real`/`mock`'s `createDevicePairSession` return
shapes still unify cleanly under `export const api = USE_MOCKS ? mock : real`).

- [ ] **Step 4: Run the full frontend test suite** (confirms this widening didn't regress
anything already depending on this function's shape)

Run: `npm test`
Expected: PASS — no failures introduced.

- [ ] **Step 5: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): widen createDevicePairSession's type for friendlyUrl"
```

---

### Task 5: render the pairing link in `LanAccessCard`

**Files:**
- Modify: `src/components/lan-access-card.tsx`
- Test: `src/components/lan-access-card.test.tsx`

**Interfaces:**
- Consumes: `api.createDevicePairSession(...)`'s widened return type (Task 4).
- Produces: nothing further downstream — this is the final, user-visible piece.

- [ ] **Step 1: Write the failing tests**

Open `src/components/lan-access-card.test.tsx`. Add these two tests directly after the existing
`'Authorize a device: type label → createDevicePairSession called → QR img appears'` test:

```tsx
  it('shows a "castwright.local" pairing link when the session includes a friendlyUrl', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockResolvedValue({
      ...PAIR_SESSION,
      friendlyUrl: 'https://castwright.local/#/pair?c=ABC',
    });

    render(<LanAccessCard />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() => expect(screen.getByTestId('mock-qr')).toBeInTheDocument());

    const link = screen.getByRole('link', { name: /open pairing link on castwright\.local/i });
    expect(link).toHaveAttribute('href', 'https://castwright.local/#/pair?c=ABC');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('does not show the pairing link when the session has no friendlyUrl (dev:lan, or a live-but-unreachable start:lan)', async () => {
    vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
    vi.mocked(api.createDevicePairSession).mockResolvedValue(PAIR_SESSION); // no friendlyUrl field

    render(<LanAccessCard />);

    fireEvent.change(screen.getByPlaceholderText('Device name'), { target: { value: 'My Laptop' } });
    fireEvent.click(screen.getByRole('button', { name: 'Authorize a device' }));

    await waitFor(() => expect(screen.getByTestId('mock-qr')).toBeInTheDocument());

    expect(
      screen.queryByRole('link', { name: /open pairing link on castwright\.local/i }),
    ).not.toBeInTheDocument();
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: FAIL on the first new test — no element with role `link` and that accessible name
exists yet. The second new test passes trivially already (nothing renders) — re-run it in
Step 4 to confirm it still passes once the link exists but is correctly gated.

- [ ] **Step 3: Implement**

In `src/components/lan-access-card.tsx`:

**3a.** Widen the session state type. Replace:

```tsx
  const [session, setSession] = useState<{ url: string; expiresAt: number } | null>(null);
```

with:

```tsx
  const [session, setSession] = useState<
    { url: string; friendlyUrl?: string; expiresAt: number } | null
  >(null);
```

**3b.** Render the link inside the existing session block. Replace:

```tsx
          {session && (
            <div className="mt-4">
              <PairingQr payload={session.url} expiresAt={session.expiresAt} onRegenerate={authorize} />
            </div>
          )}
```

with:

```tsx
          {session && (
            <div className="mt-4">
              <PairingQr payload={session.url} expiresAt={session.expiresAt} onRegenerate={authorize} />
              {session.friendlyUrl && (
                <a
                  href={session.friendlyUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-3 inline-block text-sm text-magenta hover:underline"
                >
                  Open pairing link on castwright.local
                </a>
              )}
            </div>
          )}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: PASS — all tests in the file green, including every pre-existing one (the QR
rendering, revoke, cert-regen, and 401-hint tests are all untouched by this change).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/components/lan-access-card.tsx src/components/lan-access-card.test.tsx
git commit -m "feat(frontend): render a one-click castwright.local pairing link on LAN Access"
```

---

### Task 6: regression-plan + release-notes updates

**Files:**
- Modify: `docs/features/239-castwright-local-hostnames.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

**Interfaces:** none — documentation only.

This feature extends plan 239's LAN-access flow, so per this project's "Before-shipping
checklist" the update lands in that existing plan rather than a new file.

- [ ] **Step 1: Add a manual acceptance step to plan 239**

Open `docs/features/239-castwright-local-hostnames.md`. In its "Test plan" → "Manual acceptance
walkthrough" numbered list, add a new step after the existing step 10 (the "Regenerate
certificate" step):

```markdown
11. From the same desktop session (loopback, e.g. `https://localhost:8443`), open **Admin →
    LAN access** and click **Authorize a device**. Expected: alongside the existing pairing QR,
    an **"Open pairing link on castwright.local"** link now appears. Click it (opens a new
    tab). Expected: the new tab loads `PairShell`'s "Authorize this browser?" confirmation at
    `https://castwright.local`; click **Authorize**; the tab redirects to `#/` and the library
    loads with no further pairing step. Confirm the link is absent under `dev:lan` (QR-only,
    unchanged).
```

Also add one line to that file's "Architectural impact" → "New seams" bullet, appending:

```markdown
`server/src/lan-port-forwarder.ts`'s `PortForwarderHandle.isBound()` and
`server/src/mdns-owner.ts`'s `MdnsResponderHandle.isAlive()` (real liveness checks, combined
via `app.get('isFriendlyHostnameReachable')` in `server/src/routes/devices.ts`) — added by the
one-click pairing-link feature; see
`docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md`.
```

- [ ] **Step 2: Append a technical release-notes entry**

Open `docs/release-notes-next.md`. Add a new bullet under the current in-progress version
section (following that file's existing entry format — copy the style of the most recent
entry immediately above where you insert):

```markdown
- **One-click castwright.local pairing link.** The LAN Access card's "Authorize a device" flow
  now also shows a plain link ("Open pairing link on castwright.local") alongside the existing
  QR, gated on real observed liveness of the mDNS responder + `:443` forwarder (not just
  launch config) — lets a loopback-authorized browser one-click-authorize itself for
  `castwright.local` without a phone camera to scan the QR. `start:lan` only; `dev:lan` keeps
  the QR-only flow. See `docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md`.
```

- [ ] **Step 3: Append a user-facing release-notes line**

Open `RELEASE_NOTES.md`. In the in-progress version section at the top, add a brand-voice line
matching the surrounding entries' tone (short, benefit-first, no jargon):

```markdown
- Pairing your own computer for `castwright.local` is now one click — no phone required.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/239-castwright-local-hostnames.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(docs): document the one-click castwright.local pairing link"
```

---

## After all tasks: full verification

- [ ] Run `npm run verify:fast:branch` from the repo root (matches this project's pre-push
      gate) and confirm it's green before moving to PR.
- [ ] Re-read `docs/superpowers/specs/2026-07-06-lan-pairing-friendly-hostname-link-design.md`
      once more against the finished diff — confirm every "Design" section subsection (backend
      liveness tracking, the `devices.ts`/`index.ts` wiring, `api.ts`, `LanAccessCard`) has a
      corresponding task above with no gaps.
