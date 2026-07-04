# castwright.local port-443 default + in-app cert regeneration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `https://castwright.local` (no port) work from any LAN device against `start:lan`, add an in-app button to regenerate the LAN mkcert certificate with a live hot-swap (no restart), and fix a live CSRF-origin 403 bug affecting the friendly LAN hostnames.

**Architecture:** A host-blind raw-TCP forwarder relays `:443` → `:8443` (its upstream connection deliberately sourced from `127.0.0.2`, not `127.0.0.1`, so it never masquerades as trusted loopback traffic). A new `POST /api/lan/cert/regenerate` route shells out to the existing `scripts/setup-lan-certs.mjs` and hot-swaps the live HTTPS server's TLS context via `app.set()`/`app.get()`. `csrf-origin.ts`'s allow-list gains the friendly hostnames plus a dynamic port-less variant of every LAN IP (needed because the forwarder is host-blind).

**Tech Stack:** Node.js `net`/`https`/`child_process` (server), Express 5, Vitest + supertest (server tests), React + Vitest/RTL (frontend), OpenAPI (`openapi-typescript`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-04-castwright-local-port-cert-design.md` — went through 3 rounds of mandatory adversarial review. Treat every specific value below as locked, not open for re-litigation:
  - Forwarder's upstream connect uses `localAddress: '127.0.0.2'` (NOT `127.0.0.1`) — this is a security invariant (closes an auth-bypass), not a style choice.
  - Cert-regen subprocess timeout is `90_000` ms (NOT 30s — the wrapped script's own worst-case budget is ~63s).
  - Live HTTPS server is exposed to the cert-regen route via `app.set('lanHttpsServer', server)` / `req.app.get('lanHttpsServer')` — NOT a new registry module.
  - CSRF allow-list gets BOTH the friendly-hostname literals AND a dynamic port-less variant of every enumerated LAN IP (the forwarder is host-blind, so both paths need covering).
  - Port-443 forwarder is `start:lan`-only (gated identically to the existing mDNS responder: `lanHttps && NODE_ENV === 'production'`) — never `dev:lan`.
- Every child_process spawn in `server/src/**` must include `windowsHide: true` — a repo-wide static-scan test (`server/src/spawn-windows-hide.test.ts`) enforces this and will fail the build otherwise.
- `server/src/http.ts` re-exports Express types — route files import `Request`/`Response` from `../http.js`, never directly from `express`.
- OpenAPI is the type source of truth for `/api/*` shapes (`CLAUDE.md` "Conventions worth preserving") — every new endpoint gets a path entry in root `openapi.yaml`, followed by `npm run openapi:types` to regenerate `src/lib/api-types.ts`.
- Frontend API client (`src/lib/api.ts`) exports one `real*` (fetch-based) and one `mock*` implementation per method, switched by `USE_MOCKS` — components only ever call `api.*`.

---

## Task 1: Port-443 TCP forwarder (`server/src/lan-port-forwarder.ts`)

**Files:**
- Create: `server/src/lan-port-forwarder.ts`
- Test: `server/src/lan-port-forwarder.test.ts`

**Interfaces:**
- Produces: `shouldSpawnPortForwarder(lanHttps: boolean, env?: NodeJS.ProcessEnv): boolean`, `startPortForwarder(targetPort: number, opts?: { listenPort?: number; createServerFn?: typeof net.createServer; connectFn?: typeof net.connect; warn?: (...args: unknown[]) => void }): PortForwarderHandle`, `interface PortForwarderHandle { server: net.Server; close: () => Promise<void> }` — all consumed by Task 2 (`server/src/index.ts`).

- [ ] **Step 1: Write the failing tests**

Create `server/src/lan-port-forwarder.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import net from 'node:net';
import { shouldSpawnPortForwarder, startPortForwarder } from './lan-port-forwarder.js';

describe('shouldSpawnPortForwarder', () => {
  it('is false when lanHttps is false, regardless of NODE_ENV', () => {
    expect(shouldSpawnPortForwarder(false, { NODE_ENV: 'production' })).toBe(false);
  });

  it('is true for the start:lan shape: lanHttps=true AND NODE_ENV=production', () => {
    expect(shouldSpawnPortForwarder(true, { NODE_ENV: 'production' })).toBe(true);
  });

  it('is false for the dev:lan server-leg shape: lanHttps=true but NODE_ENV unset', () => {
    expect(shouldSpawnPortForwarder(true, {})).toBe(false);
  });

  it('is false when NODE_ENV is set but not production', () => {
    expect(shouldSpawnPortForwarder(true, { NODE_ENV: 'development' })).toBe(false);
  });
});

/* Real net sockets throughout (no mocking) — this is the integration test the
   design spec calls for, and it doubles as the one place that actually proves
   the 127.0.0.2 localAddress bind works on the box running the tests (the
   spec explicitly flags this as needing a real bind, not just inference). */
describe('startPortForwarder', () => {
  function listenAndGetPort(server: net.Server): Promise<number> {
    return new Promise((resolve) => {
      server.once('listening', () => {
        const addr = server.address();
        if (addr === null || typeof addr === 'string') throw new Error('expected AddressInfo');
        resolve(addr.port);
      });
    });
  }

  it('relays bytes in both directions between client and upstream', async () => {
    // Dummy upstream: an echo server on an ephemeral port. IPv4-pinned for
    // the same reason as the SECURITY test below (avoid dual-stack ambiguity).
    const upstream = net.createServer((sock) => sock.pipe(sock));
    upstream.listen(0, '127.0.0.1');
    const upstreamPort = await listenAndGetPort(upstream);

    const handle = startPortForwarder(upstreamPort, { listenPort: 0 });
    const forwarderPort = await listenAndGetPort(handle.server);

    const client = net.connect({ port: forwarderPort, host: '127.0.0.1' });
    const received = await new Promise<string>((resolve) => {
      client.once('connect', () => client.write('ping'));
      client.once('data', (chunk) => resolve(chunk.toString()));
    });
    expect(received).toBe('ping');

    client.destroy();
    await handle.close();
    upstream.close();
  });

  it('SECURITY: the upstream connection presents as 127.0.0.2, never 127.0.0.1', async () => {
    let observedRemoteAddress: string | undefined;
    const upstream = net.createServer((sock) => {
      observedRemoteAddress = sock.remoteAddress;
      sock.end();
    });
    /* Bind IPv4-only explicitly (not the default unspecified host, which
       binds the dual-stack `::` when available) — a dual-stack socket
       reports an accepted IPv4 peer as the IPv4-mapped `::ffff:127.0.0.2`,
       which would false-fail the exact-string assertion below on a
       perfectly correct implementation. This is the ONLY automated guardian
       of the auth-bypass fix (adversarial review round 2) — pin the family
       so a false failure can never tempt a future editor into loosening the
       assertion instead of fixing the real test. */
    upstream.listen(0, '127.0.0.1');
    const upstreamPort = await listenAndGetPort(upstream);

    const handle = startPortForwarder(upstreamPort, { listenPort: 0 });
    const forwarderPort = await listenAndGetPort(handle.server);

    const client = net.connect({ port: forwarderPort, host: '127.0.0.1' });
    await new Promise<void>((resolve) => client.once('close', () => resolve()));

    // This is the assertion that would fail loudly if the localAddress
    // invariant were ever accidentally dropped, e.g. during a refactor —
    // 127.0.0.1 here would mean forwarded LAN traffic silently bypasses
    // requireLanToken's isLoopbackRequest() check (server/src/lan-auth.ts).
    expect(observedRemoteAddress).toBe('127.0.0.2');
    expect(observedRemoteAddress).not.toBe('127.0.0.1');

    await handle.close();
    upstream.close();
  });

  it('warns (does not throw) when the listen port is already in use', async () => {
    const blocker = net.createServer();
    /* Bind 0.0.0.0 explicitly, matching the family startPortForwarder itself
       binds — a blocker on a different address family than the forwarder's
       0.0.0.0 bind may not actually collide on every platform (a dual-stack
       ::-only blocker vs. an IPv4-only forwarder bind, for instance), which
       would hang this test waiting for an 'error' that never fires. */
    blocker.listen(0, '0.0.0.0');
    const blockedPort = await listenAndGetPort(blocker);

    const warn = vi.fn();
    const handle = startPortForwarder(9999, { listenPort: blockedPort, warn });

    await new Promise<void>((resolve) => handle.server.once('error', () => resolve()));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain(String(blockedPort));

    await handle.close();
    blocker.close();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/lan-port-forwarder.test.ts`
Expected: FAIL with "Cannot find module './lan-port-forwarder.js'"

- [ ] **Step 3: Write the implementation**

Create `server/src/lan-port-forwarder.ts`:

```typescript
/* castwright-local-port-cert — the server-owned port-443 TCP forwarder that
   lets `https://castwright.local` (and any bare LAN IP) work with no port
   typed, by relaying raw bytes to the real HTTPS server on LAN_HTTPS_PORT
   (default 8443). See the design spec:
   docs/superpowers/specs/2026-07-04-castwright-local-port-cert-design.md

   Host-blind by design: this never inspects the Host header or SNI, so it
   relays ANY connection reaching :443 to the real server — simple (no TLS
   termination, no per-hostname routing table), but it means every LAN IP
   also becomes reachable on :443 with no port, not just the friendly
   hostname (see server/src/csrf-origin.ts's port-less-IP allow-list entry,
   which exists specifically to cover this). */

import net from 'node:net';

export interface PortForwarderHandle {
  server: net.Server;
  close: () => Promise<void>;
}

/** True only for the start:lan shape (lanHttps AND NODE_ENV=production) —
    identical shape and rationale to shouldSpawnMdnsResponder (mdns-owner.ts):
    dev:lan's server leg also sets LAN_HTTPS=1, and must not also get a
    port-443 forwarder it doesn't advertise or own. */
export function shouldSpawnPortForwarder(
  lanHttps: boolean,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return lanHttps && env.NODE_ENV === 'production';
}

/** Start the :443-to-targetPort raw TCP forwarder. Never throws — a bind
    failure surfaces via the server's own 'error' event (logged here), not a
    synchronous throw, so the caller always gets a usable handle back. */
export function startPortForwarder(
  targetPort: number,
  opts: {
    listenPort?: number;
    createServerFn?: typeof net.createServer;
    connectFn?: typeof net.connect;
    warn?: (...args: unknown[]) => void;
  } = {},
): PortForwarderHandle {
  const {
    listenPort = 443,
    createServerFn = net.createServer,
    connectFn = net.connect,
    warn = console.warn,
  } = opts;

  const server = createServerFn((client) => {
    /* localAddress: '127.0.0.2' (NOT the default 127.0.0.1) is a required
       security invariant, not an incidental detail (adversarial review
       round 2). Without it, this connection would present as trusted
       loopback to server/src/lan-auth.ts's isLoopbackRequest(), silently
       bypassing the LAN_AUTH_TOKEN gate (requireLanToken) for every client
       reaching the app through this forwarder. 127.0.0.0/8 is entirely
       loopback (RFC 5735), so 127.0.0.2 is just as non-routable and
       local-only as 127.0.0.1 — it costs nothing functionally. */
    const upstream = connectFn({
      port: targetPort,
      host: '127.0.0.1',
      localAddress: '127.0.0.2',
    });

    const destroyBoth = () => {
      client.destroy();
      upstream.destroy();
    };

    client.pipe(upstream);
    upstream.pipe(client);
    /* If the bind above ever fails at runtime (e.g. Windows refuses an
       unassigned 127.x local address), the failure is per-connection, not a
       server-level bind error: :443 still accepts the client fine, then
       THIS connect errors. Distinct log line from the listener-level warn
       below so the two failure modes aren't conflated. */
    upstream.once('error', (err) => {
      warn(`[lan-port-forwarder] upstream connect failed: ${(err as Error).message}`);
      destroyBoth();
    });
    client.once('error', destroyBoth);
    client.once('close', destroyBoth);
    upstream.once('close', destroyBoth);
  });

  server.once('error', (err) => {
    warn(
      `[lan-port-forwarder] could not bind :${listenPort} (port already in use, or ` +
        `permission denied): ${(err as Error).message}. The bare-hostname/bare-IP ` +
        `convenience won't work; the explicit :${targetPort} URL is unaffected.`,
    );
  });

  server.listen(listenPort, '0.0.0.0');

  return {
    server,
    close: () =>
      new Promise<void>((resolvePromise) => {
        server.close(() => resolvePromise());
      }),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/lan-port-forwarder.test.ts`
Expected: PASS (4 tests in `shouldSpawnPortForwarder`, 3 in `startPortForwarder` — 7 total). If the `127.0.0.2` test fails on this box, STOP — this is the one platform assumption the whole feature depends on; do not proceed to Task 2 until it's green here.

- [ ] **Step 5: Commit**

```bash
git add server/src/lan-port-forwarder.ts server/src/lan-port-forwarder.test.ts
git commit -m "feat(server): add the castwright.local port-443 TCP forwarder"
```

---

## Task 2: Wire the forwarder + live-server registry into `server/src/index.ts`

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `shouldSpawnPortForwarder`, `startPortForwarder`, `type PortForwarderHandle` from `./lan-port-forwarder.js` (Task 1).
- Produces: `app.get('lanHttpsServer')` becomes resolvable to the live `https.Server` instance from any route handler — consumed by Task 5 (`server/src/routes/lan-cert.ts`).

No dedicated automated test for this task — matching how the existing mDNS wiring in this exact file has no test of its own either (its unit tests live entirely in `mdns-owner.test.ts`, already covered by Task 1 here). This task is verified by typecheck + the manual smoke check in Step 4.

- [ ] **Step 1: Add the import**

In `server/src/index.ts`, right after the existing `mdns-owner.js` import block (currently lines 67-71):

```typescript
import {
  shouldSpawnMdnsResponder,
  spawnMdnsResponder,
  type MdnsResponderHandle,
} from './mdns-owner.js';
import {
  shouldSpawnPortForwarder,
  startPortForwarder,
  type PortForwarderHandle,
} from './lan-port-forwarder.js';
```

- [ ] **Step 2: Add the module-scoped handle + spawn call**

Right after the existing `mdnsResponderHandle` declaration (currently line 135):

```typescript
let mdnsResponderHandle: MdnsResponderHandle | null = null;
/* castwright-local-port-cert — mirrors mdnsResponderHandle above: only ever
   set for start:lan (see shouldSpawnPortForwarder), closed in shutdown()
   alongside the sidecar and the mDNS responder. */
let portForwarderHandle: PortForwarderHandle | null = null;
```

Right after the existing mDNS spawn block inside `listenerCallback` (currently lines 269-271):

```typescript
  if (shouldSpawnMdnsResponder(lanHttps)) {
    mdnsResponderHandle = spawnMdnsResponder('castwright.local', repoRoot);
  }

  /* castwright-local-port-cert — server-owned :443 forwarder to LAN_HTTPS_PORT,
     start:lan only (same NODE_ENV-gated shape as the mDNS responder above —
     dev:lan's server leg also sets LAN_HTTPS=1 and must not also get this). */
  if (shouldSpawnPortForwarder(lanHttps)) {
    portForwarderHandle = startPortForwarder(LAN_HTTPS_PORT);
  }
};
```

- [ ] **Step 3: Expose the live HTTPS server via `app.set()`, and reap the forwarder on shutdown**

In the `if (lanHttps) { ... }` block (currently lines 335-352), right after the server is created:

```typescript
  const key = readFileSync(LAN_KEY_FILE);
  const cert = readFileSync(LAN_CERT_FILE);
  const server = createHttpsServer({ key, cert }, app).listen(
    LAN_HTTPS_PORT,
    bindHost,
    listenerCallback,
  );
  /* castwright-local-port-cert — expose the live server so the cert-regen
     route (server/src/routes/lan-cert.ts) can call setSecureContext() on it
     without a circular import (index.ts imports the router; the router
     can't import back from index.ts). Express's own app.set()/app.get() is
     the idiomatic pattern for exactly this "expose a singleton to route
     handlers" need — no new module required. */
  app.set('lanHttpsServer', server);
  attachListenErrorHandler(server, LAN_HTTPS_PORT);
```

In `shutdown()` (currently lines 364-378), add the forwarder to the reap list:

```typescript
function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  stopBackupScheduler();
  console.log(`[server] ${signal} received, tearing down sidecar...`);
  releaseSidecarOwnership(runDir);
  const reap = sidecarSupervisor?.stop() ?? Promise.resolve();
  const mdnsKilled = mdnsResponderHandle?.kill() ?? Promise.resolve();
  const forwarderClosed = portForwarderHandle?.close() ?? Promise.resolve();
  void Promise.all([reap, mdnsKilled, forwarderClosed]).finally(() => process.exit(0));
}
```

- [ ] **Step 4: Typecheck + manual smoke verification**

Run: `npm run typecheck`
Expected: no errors.

Run (manual, requires `server/.env` with `LAN_HTTPS=1` and a built `dist/`): `npm run build && npm run start:lan`
Expected console output includes both the existing `[server] listening on https://localhost:8443` line AND no new error/warn lines about port 443 (unless something else on the box already holds it, in which case you should see the `[lan-port-forwarder] could not bind :443 ...` warning and the server should otherwise come up normally).

- [ ] **Step 5: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): spawn the port-443 forwarder and expose the live HTTPS server for hot-swap"
```

---

## Task 3: CSRF-origin fix (`server/src/csrf-origin.ts`)

**Files:**
- Modify: `server/src/csrf-origin.ts`
- Modify: `server/src/csrf-origin.test.ts`

**Interfaces:**
- No new exports — `requireSameOrigin`'s existing signature is unchanged; only its internal `allowedOrigins()` helper grows.

- [ ] **Step 1: Write the failing tests**

Add to `server/src/csrf-origin.test.ts` (after the existing tests, before the final closing of the file):

```typescript
import { enumerateLanUrls } from './routes/export-lan.js';

it('passes a cookie POST from the explicit-port castwright.local origin', () => {
  const next = vi.fn();
  requireSameOrigin(
    mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://castwright.local:8443' }),
    res(),
    next,
  );
  expect(next).toHaveBeenCalled();
});

it('passes a cookie POST from the bare (no-port) castwright.local origin — the port-443 forwarder path', () => {
  const next = vi.fn();
  requireSameOrigin(
    mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://castwright.local' }),
    res(),
    next,
  );
  expect(next).toHaveBeenCalled();
});

it('passes a cookie POST from the dev:lan castwright.dev.local origin', () => {
  const next = vi.fn();
  requireSameOrigin(
    mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://castwright.dev.local:5173' }),
    res(),
    next,
  );
  expect(next).toHaveBeenCalled();
});

it('passes a cookie POST from a bare (no-port) LAN-IP origin — the host-blind forwarder makes this reachable too', () => {
  const { urls } = enumerateLanUrls(8443, 'https');
  if (urls.length === 0) return; // sandboxed runner with no LAN interface — nothing to assert
  const bareIp = urls[0].replace(':8443', '');
  const next = vi.fn();
  requireSameOrigin(
    mk('POST', { cookie: '__Host-cw_lan=x', origin: bareIp }),
    res(),
    next,
  );
  expect(next).toHaveBeenCalled();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/csrf-origin.test.ts`
Expected: the three hostname-literal tests FAIL (origin not in allow-list → 403); the bare-LAN-IP test either fails or no-ops depending on the sandbox's network interfaces.

- [ ] **Step 3: Implement the fix**

In `server/src/csrf-origin.ts`, replace the `allowedOrigins` function:

```typescript
function allowedOrigins(): Set<string> {
  const port = Number(process.env.LAN_HTTPS_PORT ?? 8443);
  const loopback = [
    `https://localhost:${port}`,
    `https://127.0.0.1:${port}`,
    `https://[::1]:${port}`,
  ];
  /* castwright-local-port-cert — the friendly hostnames, plus a port-less
     variant of every enumerated LAN IP. Both are needed: the port-443
     forwarder (server/src/lan-port-forwarder.ts) is host-blind, so it makes
     a bare `https://<lan-ip>` reachable in addition to
     `https://castwright.local` — cookies aren't port-scoped, so a session
     cookie minted on the :8443 origin would otherwise 403 on either bare
     path. An unused entry here is inert (nobody's Origin will ever equal it
     if that URL isn't actually served), so all of these are added
     unconditionally rather than threading the forwarder's/dev:lan's
     live/dead state into this module. */
  const friendlyHostnames = [
    `https://castwright.local:${port}`,
    'https://castwright.local',
    'https://castwright.dev.local:5173',
  ];
  try {
    const { urls } = enumerateLanUrls(port, 'https'); // ['https://192.168.x.y:8443', ...]
    const bareIps = urls.map((u) => u.replace(`:${port}`, ''));
    return new Set<string>([...urls, ...bareIps, ...friendlyHostnames, ...loopback]);
  } catch {
    // Fail closed: if NIC enumeration ever throws, still allow loopback +
    // the friendly hostnames — never let an exception turn every
    // cookie-bearing write into a 500.
    return new Set<string>([...friendlyHostnames, ...loopback]);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/csrf-origin.test.ts`
Expected: PASS, all tests including the pre-existing "403s a foreign origin" case (verifies no over-widening).

- [ ] **Step 5: Commit**

```bash
git add server/src/csrf-origin.ts server/src/csrf-origin.test.ts
git commit -m "fix(server): allow the friendly LAN hostnames and bare LAN IPs in the CSRF origin check"
```

---

## Task 4: `POST /api/lan/cert/regenerate` route

**Files:**
- Create: `server/src/routes/lan-cert.ts`
- Create: `server/src/routes/lan-cert.test.ts`
- Modify: `openapi.yaml`
- Modify: `src/lib/api-types.ts` (regenerated, not hand-edited)
- Modify: `server/src/app.ts` (mount the router)

**Interfaces:**
- Produces: `export const lanCertRouter: Router` (Express router mounted at `/api/lan`, exposing `POST /cert/regenerate`) — consumed by Task 4's own `app.ts` mount and, transitively, by Task 6's frontend client.
- Consumes: `resolveRunDir` from `../app-dirs.js` (existing).

- [ ] **Step 1: Write the failing tests**

Create `server/src/routes/lan-cert.test.ts`:

```typescript
/* castwright-local-port-cert — POST /api/lan/cert/regenerate.
 *
 * Mocks node:child_process's execFileSync so no real mkcert install runs in
 * CI. Mirrors cert-root.test.ts's makeApp() isolation pattern — mount just
 * this router in a fresh express() app via supertest, no full app.ts needed. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
import { lanCertRouter, __setCertPathsForTest } from './lan-cert.js';

function makeApp(lanHttpsServer?: { setSecureContext: (...args: unknown[]) => void }): Express {
  const app = express();
  if (lanHttpsServer) app.set('lanHttpsServer', lanHttpsServer);
  app.use('/api/lan', lanCertRouter);
  return app;
}

describe('POST /api/lan/cert/regenerate', () => {
  let certDir: string;

  beforeEach(() => {
    certDir = mkdtempSync(join(tmpdir(), 'lan-cert-route-test-'));
    __setCertPathsForTest({
      certFile: join(certDir, 'lan-cert.pem'),
      keyFile: join(certDir, 'lan-key.pem'),
    });
  });

  afterEach(() => {
    rmSync(certDir, { recursive: true, force: true });
    __setCertPathsForTest(null);
    vi.mocked(execFileSync).mockReset();
  });

  it('on success: hot-swaps the live server and returns 200 with the host list', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFileSync).mockReturnValue(
      '[setup-lan-certs] generating cert for hosts: localhost, 127.0.0.1, castwright.local, castwright.dev.local, 192.168.1.42\n' +
        '[setup-lan-certs] cert: ...\n',
    );
    const setSecureContext = vi.fn();

    const res = await request(makeApp({ setSecureContext })).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual([
      'localhost',
      '127.0.0.1',
      'castwright.local',
      'castwright.dev.local',
      '192.168.1.42',
    ]);
    expect(setSecureContext).toHaveBeenCalledWith({
      key: Buffer.from('FAKE-KEY'),
      cert: Buffer.from('FAKE-CERT'),
    });
  });

  it('on failure: returns 500 with the captured stderr and does NOT call setSecureContext', async () => {
    const err = Object.assign(new Error('mkcert exited 1'), {
      stderr: Buffer.from('[setup-lan-certs] [FAIL] mkcert is not on PATH.'),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
    });
    const setSecureContext = vi.fn();

    const res = await request(makeApp({ setSecureContext })).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('mkcert is not on PATH');
    expect(setSecureContext).not.toHaveBeenCalled();
  });

  it('when no live HTTPS server is registered, skips the hot-swap without erroring', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFileSync).mockReturnValue(
      '[setup-lan-certs] generating cert for hosts: localhost, castwright.local\n',
    );

    const res = await request(makeApp(undefined)).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual(['localhost', 'castwright.local']);
  });

  it('passes the 90s timeout and windowsHide:true to execFileSync', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFileSync).mockReturnValue('[setup-lan-certs] generating cert for hosts: localhost\n');

    await request(makeApp()).post('/api/lan/cert/regenerate');

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringContaining('setup-lan-certs.mjs')]),
      expect.objectContaining({ timeout: 90_000, windowsHide: true }),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd server && npx vitest run src/routes/lan-cert.test.ts`
Expected: FAIL with "Cannot find module './lan-cert.js'"

- [ ] **Step 3: Write the implementation**

Create `server/src/routes/lan-cert.ts`:

```typescript
/* castwright-local-port-cert — POST /api/lan/cert/regenerate: in-app LAN-cert
   regeneration + live hot-swap into the running HTTPS server, so a user
   doesn't have to shell out to `npm run install:cert-mobile` themselves.
   See the design spec: docs/superpowers/specs/2026-07-04-castwright-local-port-cert-design.md

   Spawns scripts/setup-lan-certs.mjs as a SUBPROCESS, not an in-process
   import — setupLanCerts() calls process.exit(1) directly on any mkcert
   failure, which would take this entire server down on exactly the error
   path a "regenerate" click is most likely to hit (mkcert not installed).
   Mirrors how server/src/mdns-owner.ts and scripts/start-app-prod.mjs
   already cross this same scripts/-vs-server module boundary. */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { resolveRunDir } from '../app-dirs.js';

export const lanCertRouter = Router();

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '..', '..', '..');
const scriptPath = resolve(repoRoot, 'scripts', 'setup-lan-certs.mjs');

/* Known, currently-inert gap (plan review): scripts/setup-lan-certs.mjs
   hardcodes its cert output to `<repoRoot>/.run/certs`, NOT resolveRunDir()'s
   APP_RUN_DIR override — so in a hypothetical future versioned-dir install
   with APP_RUN_DIR set, this route (and index.ts's served LAN_CERT_FILE,
   which IS resolveRunDir-based) would look in the wrong place and the
   hot-swap would silently no-op. Inert today because setup-lan-certs.mjs
   isn't shipped in the release manifest at all (see mdns-owner.ts's own
   comment — a packaged install can't generate LAN certs regardless), and in
   a dev checkout APP_RUN_DIR is unset so both paths already agree. Not fixed
   here — out of scope for this plan, which doesn't touch setup-lan-certs.mjs
   — but documented rather than silently left for someone to discover later. */
let certFile = resolve(resolveRunDir(repoRoot), 'certs', 'lan-cert.pem');
let keyFile = resolve(resolveRunDir(repoRoot), 'certs', 'lan-key.pem');

/** Test-only seam — lets lan-cert.test.ts point at a temp dir instead of the
    real .run/certs/. Pass null to restore the real paths. Not used by any
    production code path. */
export function __setCertPathsForTest(paths: { certFile: string; keyFile: string } | null): void {
  if (paths === null) {
    certFile = resolve(resolveRunDir(repoRoot), 'certs', 'lan-cert.pem');
    keyFile = resolve(resolveRunDir(repoRoot), 'certs', 'lan-key.pem');
    return;
  }
  certFile = paths.certFile;
  keyFile = paths.keyFile;
}

/** Extract the host list from setup-lan-certs.mjs's own
    `generating cert for hosts: a, b, c` stdout line — avoids re-deriving
    (and risking drift from) buildCertHosts()'s own list, without importing
    across the scripts/-vs-server boundary (see the module comment above). */
export function parseHostsFromOutput(stdout: string): string[] {
  const match = stdout.match(/generating cert for hosts: (.+)/);
  if (!match) return [];
  return match[1].split(',').map((h) => h.trim());
}

lanCertRouter.post('/cert/regenerate', (req: Request, res: Response) => {
  let stdout: string;
  try {
    stdout = execFileSync(process.execPath, [scriptPath], {
      timeout: 90_000,
      windowsHide: true,
      encoding: 'utf8',
    });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer | string } | undefined)?.stderr;
    const message = stderr ? stderr.toString() : (err as Error).message;
    res.status(500).json({ error: message });
    return;
  }

  const hosts = parseHostsFromOutput(stdout);

  if (existsSync(certFile) && existsSync(keyFile)) {
    const server = req.app.get('lanHttpsServer') as
      | { setSecureContext: (opts: { key: Buffer; cert: Buffer }) => void }
      | undefined;
    server?.setSecureContext({ key: readFileSync(keyFile), cert: readFileSync(certFile) });
  }

  res.status(200).json({ hosts });
});
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd server && npx vitest run src/routes/lan-cert.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Add the OpenAPI path entry**

In root `openapi.yaml`, add a new path entry right after the existing `/cert/root.crt`-adjacent LAN group — insert immediately after the `/api/devices/{id}` block (which ends with the `'404': { description: Unknown device }` line):

```yaml
  /api/lan/cert/regenerate:
    post:
      summary: Regenerate the LAN mkcert certificate and hot-swap it into the live server
      operationId: regenerateLanCert
      description: |
        Shells out to scripts/setup-lan-certs.mjs to regenerate the mkcert LAN
        certificate (covering localhost, castwright.local, castwright.dev.local,
        and every detected LAN IP), then hot-swaps it into the already-running
        HTTPS server via setSecureContext() -- no restart needed. Desktop-only
        in practice (the LAN Access card gates this button behind the same
        check that hides device management from a paired phone/tablet).
      responses:
        '200':
          description: Regenerated successfully
          content:
            application/json:
              schema:
                type: object
                required: [hosts]
                properties:
                  hosts:
                    type: array
                    items: { type: string }
                    description: 'The hostnames/IPs the new certificate covers.'
        '500':
          description: mkcert failed (not installed, generation error, etc.)
          content:
            application/json:
              schema:
                type: object
                required: [error]
                properties:
                  error: { type: string }
```

- [ ] **Step 6: Regenerate the frontend type contract**

Run: `npm run openapi:types`
Expected: `src/lib/api-types.ts` is regenerated with no manual edits needed; `git diff src/lib/api-types.ts` shows a new `regenerateLanCert` operation entry and nothing else changed.

- [ ] **Step 7: Mount the router in `app.ts`**

In `server/src/app.ts`, add the import alongside the other route imports (near `certRootRouter`, currently line 52):

```typescript
import { certRootRouter } from './routes/cert-root.js';
import { lanCertRouter } from './routes/lan-cert.js';
```

Add the mount right after the existing `/cert` mount (currently line 181):

```typescript
app.use('/cert', certRootRouter); // plan 81 — mounts /root.crt (mkcert root CA download for mobile LAN HTTPS)
app.use('/api/lan', lanCertRouter); // castwright-local-port-cert — mounts POST /cert/regenerate (in-app mkcert LAN cert regeneration + hot-swap)
```

- [ ] **Step 8: Run the full server test suite + typecheck**

Run: `cd server && npm run test`
Expected: PASS, including the pre-existing `spawn-windows-hide.test.ts` (confirms the new `execFileSync` call in `lan-cert.ts` correctly includes `windowsHide: true`).

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add server/src/routes/lan-cert.ts server/src/routes/lan-cert.test.ts server/src/app.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): add POST /api/lan/cert/regenerate with live TLS hot-swap"
```

---

## Task 5: Frontend API client method (`src/lib/api.ts`)

**Files:**
- Modify: `src/lib/api.ts`

**Interfaces:**
- Produces: `api.regenerateLanCert(): Promise<{ hosts: string[] }>` — consumed by Task 6 (`src/components/lan-access-card.tsx`).

No dedicated test for this task: this codebase's established convention is that thin `real*`/`mock*` fetch wrappers (e.g. `realRevokeDevice`, `realCreateDevicePairSession`) are not unit-tested directly — coverage comes from the component test (Task 6, which mocks `api.*` at the module boundary) plus the server-side route test (Task 4). Verified here by typecheck only.

- [ ] **Step 1: Add the real + mock implementations**

In `src/lib/api.ts`, right after `realRevokeDevice` (currently ends at line 6037):

```typescript
async function realRegenerateLanCert() {
  const res = await fetch('/api/lan/cert/regenerate', { method: 'POST' });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new ApiError(body?.error ?? `regenerate cert failed (${res.status})`, res.status);
  }
  return res.json() as Promise<{ hosts: string[] }>;
}
```

Right after `mockRevokeDevice` (currently line 6049):

```typescript
const mockRegenerateLanCert = async () => ({
  hosts: ['localhost', 'castwright.local', 'castwright.dev.local', '192.168.1.42'],
});
```

- [ ] **Step 2: Register both in the `real`/`mock` object literals**

In the `real` object (right after `revokeDevice: realRevokeDevice,`, currently line 7447):

```typescript
  revokeDevice: realRevokeDevice,
  regenerateLanCert: realRegenerateLanCert,
```

In the `mock` object (right after `revokeDevice: mockRevokeDevice,`, currently line 7714):

```typescript
  revokeDevice: mockRevokeDevice,
  regenerateLanCert: mockRegenerateLanCert,
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/lib/api.ts
git commit -m "feat(frontend): add api.regenerateLanCert client method"
```

---

## Task 6: "Regenerate certificate" button (`src/components/lan-access-card.tsx`)

**Files:**
- Modify: `src/components/lan-access-card.tsx`
- Modify: `src/components/lan-access-card.test.tsx`

**Interfaces:**
- Consumes: `api.regenerateLanCert()` from `../lib/api.js` (Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `src/components/lan-access-card.test.tsx`, extending the existing `vi.mock('../lib/api', ...)` block's returned `api` object to include `regenerateLanCert: vi.fn()`:

```typescript
vi.mock('../lib/api', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../lib/api')>();
  return {
    ...mod,
    api: {
      listDevices: vi.fn(),
      createDevicePairSession: vi.fn(),
      revokeDevice: vi.fn(),
      regenerateLanCert: vi.fn(),
    },
  };
});
```

Then add new test cases (after the existing "shows manage from desktop" test, before the closing of the `describe` block):

```typescript
it('Regenerate certificate: click -> success shows the returned host list', async () => {
  vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
  vi.mocked(api.regenerateLanCert).mockResolvedValue({
    hosts: ['localhost', 'castwright.local', '192.168.1.42'],
  });

  render(<LanAccessCard />);
  await waitFor(() => screen.getByText('LAN access'));

  const btn = screen.getByRole('button', { name: /regenerate certificate/i });
  fireEvent.click(btn);

  await waitFor(() => expect(api.regenerateLanCert).toHaveBeenCalled());
  await waitFor(() =>
    expect(screen.getByText(/localhost, castwright\.local, 192\.168\.1\.42/i)).toBeInTheDocument(),
  );
});

it('Regenerate certificate: click -> failure shows the server error message', async () => {
  vi.mocked(api.listDevices).mockResolvedValue({ devices: [] });
  vi.mocked(api.regenerateLanCert).mockRejectedValue(new Error('mkcert is not installed'));

  render(<LanAccessCard />);
  await waitFor(() => screen.getByText('LAN access'));

  fireEvent.click(screen.getByRole('button', { name: /regenerate certificate/i }));

  await waitFor(() => expect(screen.getByText('mkcert is not installed')).toBeInTheDocument());
});

it('Regenerate certificate button is hidden when viewing from a paired phone (401 on listDevices)', async () => {
  vi.mocked(api.listDevices).mockRejectedValue(new ApiError('Unauthorized', 401));

  render(<LanAccessCard />);
  await waitFor(() =>
    expect(screen.getByText(/manage devices from the desktop/i)).toBeInTheDocument(),
  );
  expect(screen.queryByRole('button', { name: /regenerate certificate/i })).not.toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: FAIL — no "Regenerate certificate" button exists yet.

- [ ] **Step 3: Implement the button**

In `src/components/lan-access-card.tsx`, replace the collapsed `<details>` block (the `"Phone shows 'Not secure' / certificate warning?"` disclosure) with:

```tsx
export function LanAccessCard() {
  const [devices, setDevices] = useState<PublicDevice[] | null>(null);
  const [manageHint, setManageHint] = useState(false); // true on 401 (viewing from a phone)
  const [label, setLabel] = useState('');
  const [session, setSession] = useState<{ url: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [certState, setCertState] = useState<
    { status: 'idle' } | { status: 'loading' } | { status: 'success'; hosts: string[] } | { status: 'error'; message: string }
  >({ status: 'idle' });

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
  const revoke = async (id: string) => {
    setErr(null);
    try {
      await api.revokeDevice(id);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
    refresh(); // re-read: a revoked device drops out of the list below
  };
  const regenerateCert = async () => {
    setCertState({ status: 'loading' });
    try {
      const { hosts } = await api.regenerateLanCert();
      setCertState({ status: 'success', hosts });
    } catch (e) {
      setCertState({ status: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  };

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
            {(devices ?? []).filter((d) => !d.revoked).map((d) => (
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
          <div className="mt-5 text-xs text-ink/55">
            <button
              type="button"
              onClick={regenerateCert}
              disabled={certState.status === 'loading'}
              className="px-3 py-1.5 rounded-lg border border-ink/15 bg-white text-xs text-ink/70 hover:bg-ink/5 min-h-[44px] sm:min-h-0 disabled:opacity-50"
            >
              {certState.status === 'loading' ? 'Regenerating…' : 'Regenerate certificate'}
            </button>
            <p className="mt-2 leading-relaxed">
              Run this if a phone or tablet shows "Not secure" — it refreshes this
              computer's local certificate (covering every LAN address it's
              currently reachable on) without restarting the app.
            </p>
            {certState.status === 'success' && (
              <p className="mt-2 text-emerald-700">Now covers: {certState.hosts.join(', ')}</p>
            )}
            {certState.status === 'error' && (
              <p className="mt-2 text-rose-700">{certState.message}</p>
            )}
          </div>
        </>
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/components/lan-access-card.test.tsx`
Expected: PASS, all tests (existing 5 + new 3 = 8 total).

- [ ] **Step 5: Commit**

```bash
git add src/components/lan-access-card.tsx src/components/lan-access-card.test.tsx
git commit -m "feat(frontend): add a Regenerate certificate button to the LAN Access card"
```

---

## Task 7: Docs — manual acceptance + release notes

**Files:**
- Modify: `docs/features/239-castwright-local-hostnames.md`
- Modify: `docs/release-notes-next.md`
- Modify: `RELEASE_NOTES.md`

No automated test — this is a docs-only task per CLAUDE.md's before-shipping checklist items 2 and 4.

- [ ] **Step 1: Extend the manual acceptance walkthrough**

In `docs/features/239-castwright-local-hostnames.md`, under "### Manual acceptance walkthrough" (the existing 7-step list), append:

```markdown
8. Run `npm run build && npm run start:lan`. From a real phone/tablet on the same LAN, browse
   to `https://castwright.local` with **no port**. Expected: loads exactly like the explicit
   `:8443` URL, with no certificate warning.
9. From that same connection, perform a mutating action (e.g. rename a book, revoke a paired
   device). Expected: succeeds — no 403 "Cross-origin request rejected".
10. In the app's LAN Access card (desktop session), click "Regenerate certificate". Expected:
    the app keeps serving uninterrupted throughout (no dropped requests), the button shows the
    new host list on success, and a **fresh** browser tab opened afterward shows no certificate
    warning — without restarting the app.
```

- [ ] **Step 2: Add the technical release-notes entry**

In `docs/release-notes-next.md`, add a bullet in the existing PR-refed list (matching the format of the existing entry) — fill in the actual PR number once the PR is opened:

```markdown
- **`castwright.local` now works with no port typed, and the LAN certificate can be regenerated from inside the app.** A new port-443 forwarder relays to the existing `:8443` LAN HTTPS server; a "Regenerate certificate" button in the LAN Access card hot-swaps a fresh mkcert certificate into the running server with no restart. Also fixes a live CSRF-origin bug where mutating requests via `castwright.local`/`castwright.dev.local` 403'd (#PR_NUMBER).
```

- [ ] **Step 3: Add the user-facing brand-voice entry**

In `RELEASE_NOTES.md`, under the current in-progress `# Castwright 1.11.0` section, add:

```markdown
- **One address, no port to remember.** When you're listening from another device on your network, `castwright.local` now works exactly as typed — no `:8443` to type or mistype.
- **Renew your network certificate without leaving the app.** A new button lets you refresh your computer's local certificate on the spot, so a new device or a new network trusts it right away.
```

- [ ] **Step 4: Commit**

```bash
git add docs/features/239-castwright-local-hostnames.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs: extend 239's manual acceptance and add release notes for castwright.local port-443 + cert regen"
```

---

## Task 8: Full verification + open the PR

**Files:** none (verification + process only)

- [ ] **Step 1: Run the full pre-push battery**

Run: `npm run verify`
Expected: PASS — typecheck, all unit/integration suites (frontend, server, server-slow, scripts, sidecar), e2e, and build all green. If anything is red, triage per `CLAUDE.md`'s "Working practice" (related-to-this-change → fix in this branch; pre-existing → stop and surface to the user, do not silently fix unrelated breakage).

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/server-castwright-local-port-cert
gh pr create --title "feat(server): castwright.local works with no port, plus in-app cert regeneration" --body "$(cat <<'EOF'
## Summary
- Adds a port-443-to-8443 TCP forwarder so `https://castwright.local` (no port) works from any LAN device against `start:lan`.
- Adds a "Regenerate certificate" button (LAN Access card) that regenerates the mkcert LAN cert and hot-swaps it into the running server with no restart.
- Fixes a live CSRF-origin bug: mutating requests via `castwright.local`/`castwright.dev.local` (and, after this PR, bare LAN IPs via the new forwarder) were 403ing.

Design spec (3 rounds of mandatory adversarial review): docs/superpowers/specs/2026-07-04-castwright-local-port-cert-design.md
Implementation plan: docs/superpowers/plans/2026-07-04-castwright-local-port-cert.md

## Test plan
- [x] `npm run verify` green locally
- [x] Manual acceptance steps 8-10 in docs/features/239-castwright-local-hostnames.md
EOF
)"
```

This is a multi-scope PR (server + frontend + docs) per `CONTRIBUTING.md`'s commit-convention vocabulary — per the model-routing skill, it gets the `high` effort tier for the mandatory independent `code-review` pass (no `--fix`) once fully staged, before merge. File/link a GitHub issue per the PR-gate issue-verification convention if one doesn't already exist for this work.

- [ ] **Step 3: Run the mandatory code-review gate**

Once pushed, run the `code-review` skill at `high` effort against the full diff (no `--fix`). Triage findings by hand per `CLAUDE.md`: clear-cut bugs get fixed and pushed (which re-triggers one more review pass, capped at 2 re-review rounds); judgment-call findings route through a normal ask-first conversation with the user rather than being auto-applied.

---

## Self-Review Notes

**Spec coverage check:**
- Component 1 (forwarder) → Task 1 + Task 2. ✓
- Component 2 (index.ts wiring incl. `app.set`/`app.get`) → Task 2. ✓
- Component 3 (CSRF fix) → Task 3. ✓
- Component 4 (cert-regen route) → Task 4. ✓
- Component 5 (UI button) → Task 6 (plus Task 5 for the client method it needs). ✓
- OpenAPI contract convention (`CLAUDE.md`) → Task 4 Steps 5-6. ✓
- Manual acceptance + release notes (spec's Testing section + `CLAUDE.md` before-shipping checklist) → Task 7. ✓
- `127.0.0.2` Windows-bind assumption, flagged by the spec as needing real-bind verification → proven by Task 1's integration test (real `net` sockets, no mocks) before any later task depends on it.
- Rate-limit key collapse (spec's non-blocking round-3 note) → documentation-only, already captured in the spec itself; no code task needed since the spec explicitly calls it non-blocking and inherent to any TCP forwarder.

**Type consistency check:** `PortForwarderHandle` (Task 1) is used identically in Task 2's `let portForwarderHandle: PortForwarderHandle | null`. `lanCertRouter` (Task 4) is imported by exact name in Task 4's own `app.ts` step. `api.regenerateLanCert` (Task 5) returns `Promise<{ hosts: string[] }>`, matching exactly what Task 6's component destructures (`const { hosts } = await api.regenerateLanCert()`) and what Task 4's route actually returns (`res.status(200).json({ hosts })`).
