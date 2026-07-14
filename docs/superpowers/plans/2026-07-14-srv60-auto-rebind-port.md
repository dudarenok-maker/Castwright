# srv-60 Auto-Rebind Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On startup, when the configured listen port is already in use, the server auto-shifts to the next free port (production/launcher only) instead of a fatal exit, propagating the actual bound port to every downstream consumer.

**Architecture:** A new `listenWithAutoRebind` helper in `crash-logging.ts` owns the `listen` loop: it binds the start port, and on `EADDRINUSE` (when `autoRebind` is on) walks upward to the next port up to a cap, then fatal-exits. The success handler is attached **once** via `once('listening')` and receives the real bound port from `server.address()`. `index.ts` wires both listen branches through the helper and moves the port-dependent wiring (`setLanRuntime`, the `:443` forwarder target) to the resolved port. `csrf-origin.ts` reads the runtime port so a device paired on a shifted port isn't CSRF-rejected.

**Tech Stack:** Node 20 `node:http` / `node:https` / `node:net`, TypeScript, Vitest (node env), Express.

**Spec:** [docs/superpowers/specs/2026-07-14-srv60-auto-rebind-port-design.md](../specs/2026-07-14-srv60-auto-rebind-port-design.md) · **Issue:** #1608

## Global Constraints

Every task's requirements implicitly include these — copied verbatim from the spec:

- **Scope gate:** auto-rebind fires **only when `NODE_ENV === 'production'`** (verified: `start:prod`/`start:lan` → `start-app-prod.mjs` sets `NODE_ENV:'production'`; Pinokio `start.js` sets it too). In dev — including `npm start` (dev stack) — the behavior is byte-for-byte today's: `formatListenError` + `exit(1)`. `autoRebind` is a **parameter** (`process.env.NODE_ENV === 'production'` computed in `index.ts`) so tests drive both modes.
- **Success handler attached exactly once** via `server.once('listening', …)`; every `listen(port[, host])` call passes **no** callback. A re-passed callback accumulates (a failed bind emits `'error'`, never `'listening'`) and would run the heavy wiring once per attempt → double-spawn the sidecar supervisor / mDNS / forwarder (the #1030 recycle-storm).
- **Cap = 20 attempts, attempt 1 = the initial bind** → tries `startPort … startPort + 19` (8080→8099 / 8443→8462), then fatal-exits.
- **Resolved port is the single source of truth** (`server.address().port` → `getLanRuntime()`); the two sites that today read the port constant directly — the `:443` forwarder and `csrf-origin.ts` `allowedOrigins()` — must read the resolved/runtime port.
- **No persistence** of the chosen port; `castwright.local:443` (forwarder) stays the durable address.
- Commit convention: `<type>(<scope>): <subject>`. Branch is `chore/server-auto-rebind-port`.

---

## File Structure

- `server/src/crash-logging.ts` — add `listenWithAutoRebind` + `formatRebindExhausted` + `RebindServer`/`AutoRebindOptions` types; remove `attachListenErrorHandler` (+ its now-unused export). Keep `formatListenError` (used by the helper and tests).
- `server/src/crash-logging.test.ts` — replace the `attachListenErrorHandler` describe block with `listenWithAutoRebind` tests.
- `server/src/index.ts` — route both listen branches through the helper; make `listenerCallback` take the resolved port; move `setLanRuntime` into it; point the forwarder at the resolved port; add the `node:http` import; compute `autoRebind`.
- `server/src/csrf-origin.ts` — `allowedOrigins()` reads `getLanRuntime().port`.
- `server/src/csrf-origin.test.ts` — seed `setLanRuntime` in `beforeEach`; add the shifted-port regression test.
- `docs/features/255-srv60-auto-rebind-port.md` (new) + `docs/features/INDEX.md` — regression plan + index entry.
- `docs/release-notes-next.md` + `RELEASE_NOTES.md` — paired release-notes entries.

---

## Task 1: `listenWithAutoRebind` helper

**Files:**
- Modify: `server/src/crash-logging.ts`
- Test: `server/src/crash-logging.test.ts`

**Interfaces:**
- Consumes: existing `formatListenError(port, err)` (unchanged).
- Produces:
  - `interface RebindServer { on(event:'error', cb:(err:NodeJS.ErrnoException)=>void):void; once(event:'listening', cb:()=>void):void; listen(port:number, host?:string):void; address():import('node:net').AddressInfo | string | null; }`
  - `interface AutoRebindOptions { startPort:number; host?:string; onListening:(port:number)=>void; autoRebind:boolean; maxAttempts?:number; onLog?:(msg:string)=>void; onExit?:(code:number)=>void; }`
  - `function listenWithAutoRebind(server: RebindServer, opts: AutoRebindOptions): void`
  - `function formatRebindExhausted(startPort:number, maxAttempts:number): string`

- [ ] **Step 1: Write the failing tests**

Replace the entire `describe('attachListenErrorHandler', …)` block (currently the last block in the file) with the following. Also update the import at the top of the file — change the imported symbol list from `formatListenError, attachListenErrorHandler` to `formatListenError, listenWithAutoRebind, formatRebindExhausted`.

```typescript
/* srv-60 — a busy port is now recovered by walking upward to a free one
 * (production only). listenWithAutoRebind owns the listen loop. A tiny fake
 * server records listen() calls and lets the test drive 'error'/'listening'. */
class FakeServer extends EventEmitter {
  listened: number[] = [];
  private boundPort: number | null = null;
  listen(port: number, _host?: string): void {
    this.listened.push(port);
    this.boundPort = port;
  }
  address() {
    return this.boundPort === null
      ? null
      : { address: '0.0.0.0', family: 'IPv4', port: this.boundPort };
  }
  /** Test helper: simulate the OS rejecting the most recent bind. */
  failInUse() {
    this.boundPort = null;
    this.emit('error', Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' }));
  }
  /** Test helper: simulate the most recent bind succeeding. */
  succeed() {
    this.emit('listening');
  }
}

describe('listenWithAutoRebind', () => {
  it('autoRebind: first port busy → re-listens on port+1, does NOT exit', () => {
    const server = new FakeServer();
    const onListening = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening,
      autoRebind: true,
      onLog: vi.fn(),
      onExit,
    });

    server.failInUse(); // 8080 busy
    server.succeed(); // 8081 binds

    expect(server.listened).toEqual([8080, 8081]);
    expect(onListening).toHaveBeenCalledTimes(1);
    expect(onListening).toHaveBeenCalledWith(8081); // the REAL bound port
    expect(onExit).not.toHaveBeenCalled();
  });

  it('autoRebind: onListening fires exactly once across a multi-attempt rebind', () => {
    const server = new FakeServer();
    const onListening = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening,
      autoRebind: true,
      onLog: vi.fn(),
      onExit: vi.fn(),
    });

    server.failInUse(); // 8080
    server.failInUse(); // 8081
    server.succeed(); // 8082

    expect(onListening).toHaveBeenCalledTimes(1);
    expect(onListening).toHaveBeenCalledWith(8082);
  });

  it('dev (autoRebind off): EADDRINUSE → actionable line AND exit(1), no rebind', () => {
    const server = new FakeServer();
    const onLog = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening: vi.fn(),
      autoRebind: false,
      onLog,
      onExit,
    });

    server.failInUse();

    expect(server.listened).toEqual([8080]); // no retry
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('already in use'));
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('autoRebind: every port busy → after maxAttempts, exit(1); last try is startPort+19', () => {
    const server = new FakeServer();
    const onLog = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8443,
      onListening: vi.fn(),
      autoRebind: true,
      onLog,
      onExit,
    });

    for (let i = 0; i < 20; i++) server.failInUse();

    expect(server.listened).toHaveLength(20);
    expect(server.listened[0]).toBe(8443);
    expect(server.listened[19]).toBe(8462); // startPort + (maxAttempts - 1)
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('8443'));
    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('8462'));
    expect(onExit).toHaveBeenCalledWith(1);
  });

  it('a non-EADDRINUSE error → FATAL line AND exit(1), even with autoRebind on', () => {
    const server = new FakeServer();
    const onLog = vi.fn();
    const onExit = vi.fn();
    listenWithAutoRebind(server as never, {
      startPort: 8080,
      onListening: vi.fn(),
      autoRebind: true,
      onLog,
      onExit,
    });

    server.emit('error', Object.assign(new Error('permission denied'), { code: 'EACCES' }));

    expect(onLog).toHaveBeenCalledWith(expect.stringContaining('FATAL listen error'));
    expect(onExit).toHaveBeenCalledWith(1);
  });
});

describe('formatRebindExhausted', () => {
  it('names the scanned range and attempt count', () => {
    const line = formatRebindExhausted(8443, 20);
    expect(line).toContain('8443');
    expect(line).toContain('8462');
    expect(line).toContain('20');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server run test -- crash-logging`
Expected: FAIL — `listenWithAutoRebind is not a function` / `formatRebindExhausted is not a function`.

- [ ] **Step 3: Implement the helper**

In `server/src/crash-logging.ts`: (a) add `import type { AddressInfo } from 'node:net';` at the top; (b) **delete** the `attachListenErrorHandler` function and its `ListenErrorTarget` interface (the block under `/* ---- srv-17: actionable listen-error handling ---- */` from `export interface ListenErrorTarget` through the end of `attachListenErrorHandler`), but **keep** `formatListenError`; (c) update the file-header comment: the srv-17 paragraph (~lines 21–27) describes `attachListenErrorHandler` intercepting EADDRINUSE and exiting — reword it so it no longer describes a removed function, noting instead that `listenWithAutoRebind` now owns the listen loop and (in production) recovers from EADDRINUSE by shifting ports; (d) append the new code below `formatListenError`:

```typescript
/** Minimal surface of a freshly-created (not-yet-listening) HTTP/HTTPS server
 *  that listenWithAutoRebind drives. net/http/https `.Server` all satisfy it;
 *  a fake stands in for tests. */
export interface RebindServer {
  on(event: 'error', cb: (err: NodeJS.ErrnoException) => void): void;
  once(event: 'listening', cb: () => void): void;
  listen(port: number, host?: string): void;
  address(): AddressInfo | string | null;
}

export interface AutoRebindOptions {
  /** First port to try; auto-shift walks upward from here. */
  startPort: number;
  /** Bind host (loopback vs 0.0.0.0). Omitted → Node default. */
  host?: string;
  /** Called ONCE, on the final successful bind, with the ACTUAL bound port. */
  onListening: (port: number) => void;
  /** Auto-shift on EADDRINUSE (production) vs actionable fatal-exit (dev). */
  autoRebind: boolean;
  /** Total bind attempts incl. the first. Default 20 (startPort..startPort+19). */
  maxAttempts?: number;
  onLog?: (msg: string) => void;
  onExit?: (code: number) => void;
}

/** Format the "scanned the whole range, gave up" fatal line. */
export function formatRebindExhausted(startPort: number, maxAttempts: number): string {
  const last = startPort + maxAttempts - 1;
  return (
    `[server] Ports ${startPort}–${last} are all in use — could not bind after ` +
    `${maxAttempts} attempts. Stop the conflicting server(s), then retry.`
  );
}

/** Own the listen loop: bind `startPort`, and on EADDRINUSE (when `autoRebind`)
 *  walk upward to the next port, up to `maxAttempts` total binds, then
 *  fatal-exit. The success handler is attached ONCE via `once('listening')` — a
 *  re-passed listen callback would accumulate (a failed bind emits 'error', not
 *  'listening') and fire once PER attempt, double-spawning everything the
 *  success handler wires up (#1030 recycle-storm). `onListening` receives the
 *  real bound port from `server.address()`. In dev (`autoRebind:false`) an
 *  EADDRINUSE keeps the pre-srv-60 behavior: actionable message + exit(1). */
export function listenWithAutoRebind(server: RebindServer, opts: AutoRebindOptions): void {
  const maxAttempts = opts.maxAttempts ?? 20;
  const log = opts.onLog ?? ((m: string) => console.error(m));
  const exit = opts.onExit ?? ((c: number) => process.exit(c));

  let attempt = 0; // 0-based; attempt 0 is the initial bind
  let port = opts.startPort;

  const listen = () => {
    if (opts.host !== undefined) server.listen(port, opts.host);
    else server.listen(port);
  };

  server.once('listening', () => {
    const addr = server.address();
    const bound = typeof addr === 'object' && addr !== null ? addr.port : port;
    opts.onListening(bound);
  });

  server.on('error', (err) => {
    const inUse = err.code === 'EADDRINUSE';
    if (inUse && opts.autoRebind && attempt < maxAttempts - 1) {
      log(`[server] Port ${port} is in use — trying ${port + 1}…`);
      attempt += 1;
      port += 1;
      listen();
      return;
    }
    if (inUse && opts.autoRebind) {
      log(formatRebindExhausted(opts.startPort, maxAttempts));
      exit(1);
      return;
    }
    // dev EADDRINUSE, or any non-EADDRINUSE error → unchanged actionable/fatal exit
    log(formatListenError(port, err));
    exit(1);
  });

  listen();
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix server run test -- crash-logging`
Expected: PASS — all `formatCrash` / `installCrashHandlers` / `formatListenError` / `listenWithAutoRebind` / `formatRebindExhausted` tests green.

- [ ] **Step 5: Commit**

```bash
git add server/src/crash-logging.ts server/src/crash-logging.test.ts
git commit -m "feat(server): add listenWithAutoRebind port-fallback helper (srv-60)"
```

---

## Task 2: Wire `index.ts` through the helper + propagate the resolved port

**Files:**
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `listenWithAutoRebind(server, opts)` from Task 1; existing `setLanRuntime`, `startPortForwarder`, `enumerateLanUrls`, `selectBindHost`.
- Produces: nothing new for later tasks (this is the integration seam).

**Note:** No boot code reads `getLanRuntime()` before the listen callback fires — every reader is a request-time route handler (`routes/devices.ts`, `routes/export-lan.ts`, `routes/pairing.ts`, `tts/loopback-url.ts`) plus the new `csrf-origin.ts` (also request-time). So moving `setLanRuntime` into `listenerCallback` is safe.

- [ ] **Step 1: Add the `node:http` import and swap the crash-logging import**

At the top of `server/src/index.ts`, next to `import { createServer as createHttpsServer } from 'node:https';`, add:

```typescript
import { createServer as createHttpServer } from 'node:http';
```

Change the crash-logging import from:

```typescript
import { installCrashHandlers, attachListenErrorHandler } from './crash-logging.js';
```

to:

```typescript
import { installCrashHandlers, listenWithAutoRebind } from './crash-logging.js';
```

- [ ] **Step 2: Remove the pre-bind `setLanRuntime`**

Delete this line (currently ~line 204, the one that sets the port from the constant before the bind):

```typescript
  setLanRuntime({ httpsActive: lanHttps, port: lanHttps ? LAN_HTTPS_PORT : PORT });
```

Keep the comment above it if it reads generally; otherwise remove the now-orphaned comment lines that specifically describe that pre-bind call. Leave the following `const bindHost = selectBindHost(lanHttps);` line intact.

- [ ] **Step 3: Make `listenerCallback` take the resolved port and set runtime state**

Change the callback signature from `const listenerCallback = () => {` to:

```typescript
  const listenerCallback = (listenPort: number) => {
```

Inside the callback, **delete** the line that recomputes the port from constants:

```typescript
    const listenPort = lanHttps ? LAN_HTTPS_PORT : PORT;
```

Immediately after the opening of the callback (before the `console.log('[server] listening …')` line), add:

```typescript
    // Record what we ACTUALLY bound (post-rebind) so GET /lan + pairing + CSRF
    // advertise the real protocol/port, not the requested constant.
    setLanRuntime({ httpsActive: lanHttps, port: listenPort });
```

- [ ] **Step 4: Point the `:443` forwarder at the resolved port**

Change the forwarder call inside the callback from:

```typescript
      portForwarderHandle = startPortForwarder(LAN_HTTPS_PORT);
```

to:

```typescript
      portForwarderHandle = startPortForwarder(listenPort);
```

- [ ] **Step 5: Replace the listen block with the helper (both branches)**

Replace the final `if (lanHttps) { … } else { … }` listen block (currently ~lines 403–425, from `if (lanHttps) {` through its closing `}`) with:

```typescript
  const autoRebind = process.env.NODE_ENV === 'production';

  if (lanHttps) {
    // lanHttps already implies certsPresent (see the effective-LAN check above),
    // so cert files are guaranteed here.
    const key = readFileSync(LAN_KEY_FILE);
    const cert = readFileSync(LAN_CERT_FILE);
    const server = createHttpsServer({ key, cert }, app);
    // Expose the live server so the cert-regen route (routes/lan-cert.ts) can
    // setSecureContext() on it without a circular import.
    app.set('lanHttpsServer', server);
    listenWithAutoRebind(server, {
      startPort: LAN_HTTPS_PORT,
      host: bindHost,
      onListening: listenerCallback,
      autoRebind,
    });
  } else {
    const server = createHttpServer(app);
    listenWithAutoRebind(server, {
      startPort: PORT,
      host: bindHost,
      onListening: listenerCallback,
      autoRebind,
    });
  }
```

- [ ] **Step 6: Typecheck and run the server suite**

Run: `npm run typecheck`
Expected: PASS — no type errors (confirms `RebindServer` is satisfied by `http.Server`/`https.Server`, and `listenerCallback`'s new signature type-checks).

Run: `npm --prefix server run test`
Expected: PASS — the existing server suite stays green (no test drives `index.ts` boot directly; this confirms nothing that imports `index.ts`'s siblings broke, and that the removed `attachListenErrorHandler` export has no remaining importer).

- [ ] **Step 7: Commit**

```bash
git add server/src/index.ts
git commit -m "feat(server): auto-rebind both listen branches, propagate bound port (srv-60)"
```

---

## Task 3: `csrf-origin.ts` reads the runtime port

**Files:**
- Modify: `server/src/csrf-origin.ts`
- Test: `server/src/csrf-origin.test.ts`

**Interfaces:**
- Consumes: `getLanRuntime()` from `./lan-runtime.js`; `setLanRuntime` in the test.
- Produces: nothing new.

- [ ] **Step 1: Write the failing test**

In `server/src/csrf-origin.test.ts`: change the imports at the top from:

```typescript
import { requireSameOrigin } from './csrf-origin.js';
import { enumerateLanUrls } from './routes/export-lan.js';
```

to:

```typescript
import { requireSameOrigin } from './csrf-origin.js';
import { enumerateLanUrls } from './routes/export-lan.js';
import { setLanRuntime } from './lan-runtime.js';
```

Change the `beforeEach` from:

```typescript
beforeEach(() => { process.env.LAN_HTTPS_PORT = '8443'; });
```

to:

```typescript
beforeEach(() => {
  process.env.LAN_HTTPS_PORT = '8443';
  setLanRuntime({ httpsActive: true, port: 8443 });
});
```

Then append this new test at the end of the file:

```typescript
it('passes a cookie POST from a LAN origin on the SHIFTED (auto-rebound) port', () => {
  // srv-60: the server auto-shifted 8443 → 8444; a device paired on 8444 must
  // not be CSRF-rejected. allowedOrigins() reads getLanRuntime().port, so
  // seeding the runtime to the shifted port allows that origin.
  setLanRuntime({ httpsActive: true, port: 8444 });
  const { urls } = enumerateLanUrls(8444, 'https'); // ['https://<live-nic-ip>:8444', ...]
  if (urls.length === 0) return; // no non-loopback NIC in this env — nothing to assert
  const next = vi.fn();
  const r = res();
  requireSameOrigin(mk('POST', { cookie: '__Host-cw_lan=x', origin: urls[0] }), r, next);
  expect(next).toHaveBeenCalled();
  expect(r.statusCode).toBe(200);
});

it('403s a cookie POST on the OLD port after an auto-rebind shifted it', () => {
  setLanRuntime({ httpsActive: true, port: 8444 }); // shifted; 8443 is stale
  const next = vi.fn();
  const r = res();
  requireSameOrigin(
    mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://localhost:8443' }),
    r,
    next,
  );
  expect(next).not.toHaveBeenCalled();
  expect(r.statusCode).toBe(403);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm --prefix server run test -- csrf-origin`
Expected: FAIL — the shifted-port test 403s (allowedOrigins still reads `process.env.LAN_HTTPS_PORT`=8443, so `:8444` is not allowed), and the stale-port test may pass for the wrong reason. Both lock the behavior once Step 3 lands.

- [ ] **Step 3: Read the runtime port in `allowedOrigins`**

In `server/src/csrf-origin.ts`: add the import next to the existing `enumerateLanUrls` import:

```typescript
import { getLanRuntime } from './lan-runtime.js';
```

Change the first line of `allowedOrigins()` from:

```typescript
  const port = Number(process.env.LAN_HTTPS_PORT ?? 8443);
```

to:

```typescript
  // srv-60: the actual bound port (post auto-rebind), not the start constant —
  // otherwise a device paired on a shifted port 403s on every mutating request.
  const port = getLanRuntime().port;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm --prefix server run test -- csrf-origin`
Expected: PASS — all existing CSRF tests plus the two new shifted-port tests are green.

- [ ] **Step 5: Commit**

```bash
git add server/src/csrf-origin.ts server/src/csrf-origin.test.ts
git commit -m "fix(server): CSRF allow-list follows the auto-rebound port (srv-60)"
```

---

## Task 4: Regression plan + release notes

**Files:**
- Create: `docs/features/255-srv60-auto-rebind-port.md`
- Modify: `docs/features/INDEX.md`, `docs/release-notes-next.md`, `RELEASE_NOTES.md`

- [ ] **Step 1: Write the regression plan doc**

Create `docs/features/255-srv60-auto-rebind-port.md` with:

```markdown
---
status: active
---

# srv-60 — Server auto-rebinds to a free port when 8080/8443 is in use

**Issue:** #1608 · **Design:** [docs/superpowers/specs/2026-07-14-srv60-auto-rebind-port-design.md](../superpowers/specs/2026-07-14-srv60-auto-rebind-port-design.md)

## What

On startup, when the configured listen port is in use (`EADDRINUSE`), the
server auto-shifts upward to the next free port instead of a fatal exit —
**production/launcher only** (`NODE_ENV=production`: `start:prod`, `start:lan`,
Pinokio). Dev (incl. `npm start`) keeps the actionable "already in use" exit so
Vite's pinned proxy never silently breaks. Exactly one listen branch runs per
boot (HTTP `PORT` 8080 or HTTPS `LAN_HTTPS_PORT` 8443).

## Invariants

- Auto-rebind walks `startPort … startPort+19` (20 attempts), then fatal-exits
  with a range-named message.
- The success handler runs **exactly once**, on the final bind — the heavy boot
  wiring (sidecar supervisor, mDNS, `:443` forwarder) must never double-spawn.
- The **actual** bound port propagates to the listening log, LAN URLs + pairing
  QR (`getLanRuntime()`), the `:443` forwarder target, and the CSRF origin
  allow-list. No persistence — `castwright.local:443` stays the durable address.

## Automated coverage

- `server/src/crash-logging.test.ts` — `listenWithAutoRebind`: rebind on busy
  port, once-only success handler, dev fatal-exit, range exhaustion, non-EADDRINUSE
  passthrough; `formatRebindExhausted`.
- `server/src/csrf-origin.test.ts` — a device on the shifted port is allowed; the
  stale (old) port is rejected.

## Manual acceptance (on-box, LAN HTTPS)

1. Occupy 8443 (e.g. run any TLS server there), then `npm run start:lan`.
2. Confirm the server logs `Port 8443 is in use — trying 8444…` then
   `listening on https://localhost:8444`, and does NOT exit.
3. Scan the pairing QR from a phone → it reaches the server (via `:443`
   forwarder / `castwright.local`), pairs, and a mutating action (e.g. rename a
   book) succeeds — i.e. no CSRF 403 on the shifted port.
4. Repeat with HTTP: occupy 8080, `NODE_ENV=production` start → binds 8081.
5. Dev check: occupy 8080, `npm start` → still the actionable "already in use"
   exit (no shift).

## Ship notes

_(filled at merge: shipped date + commit SHA)_
```

- [ ] **Step 2: Add the INDEX entry**

In `docs/features/INDEX.md`, add an entry for this plan under the server (`srv`) area section, matching the surrounding format, e.g.:

```markdown
- [255 — srv-60 auto-rebind to a free port](255-srv60-auto-rebind-port.md) — server auto-shifts off a busy 8080/8443 (production only).
```

(Place it near the other `srv-*` entries; match the exact bullet style used in that section.)

- [ ] **Step 3: Add the technical release note**

In `docs/release-notes-next.md`, under the `## 🐛 Fixes` section, append:

```markdown
- **The server no longer dies on `EADDRINUSE` — in production it auto-shifts to the next free port (srv-60, #1608).** When the configured listen port is already taken, `listenWithAutoRebind` (`server/src/crash-logging.ts`, replacing `attachListenErrorHandler`) walks upward `startPort…startPort+19` and binds the first free one, for both the HTTP `PORT` (8080) and the HTTPS `LAN_HTTPS_PORT` (8443) branch. Gated to `NODE_ENV=production` (`start:prod`/`start:lan`/Pinokio) — dev (incl. `npm start`, whose Vite proxy is port-pinned) keeps the actionable "already in use" exit. The success handler is attached once via `once('listening')` so the sidecar supervisor / mDNS / `:443` forwarder never double-spawn on a retried bind, and the **actual** bound port (`server.address().port`) propagates to the listening log, LAN URLs + pairing QR (`getLanRuntime()`), the `:443` forwarder target, and — the easily-missed second reader — `csrf-origin.ts` `allowedOrigins()`, so a device paired on a shifted port isn't CSRF-403'd. No persistence: `castwright.local:443` stays the durable address. Regression tests in `crash-logging.test.ts` + `csrf-origin.test.ts`. (#PR)
```

**Note:** replace `(#PR)` with the real PR number when the PR is opened — this is the one value that cannot exist before the PR.

- [ ] **Step 4: Add the user-facing release note**

In `RELEASE_NOTES.md`, under the top-most `# Castwright 1.14.0` heading, append a bullet:

```markdown
- **Castwright now starts even when another app is already using its port.** If something else on your machine — another web app, or a leftover copy of Castwright — is already using the port Castwright wants, it used to refuse to start at all. Now it quietly finds the next free port and starts there, so a busy port no longer blocks your launch. Your phone and tablet still reach it at the same friendly address as always.
```

- [ ] **Step 5: Commit**

```bash
git add docs/features/255-srv60-auto-rebind-port.md docs/features/INDEX.md docs/release-notes-next.md RELEASE_NOTES.md
git commit -m "docs(server): srv-60 regression plan + release notes"
```

---

## Self-Review

**Spec coverage:**
- Scope gate (production only) → Task 2 Step 5 (`autoRebind = NODE_ENV === 'production'`) + Task 1 tests (dev vs prod).
- Retry-on-EADDRINUSE mechanism → Task 1 helper + tests.
- `once('listening')` single-fire → Task 1 helper + the "exactly once" test.
- Cap = 20, attempt 1 = initial bind → Task 1 helper (`attempt < maxAttempts - 1`) + the `startPort+19` test.
- Propagation: listening log / LAN URLs / `setLanRuntime` / forwarder → Task 2; CSRF allow-list → Task 3.
- Testing #1–#6 from the spec → Task 1 (#1,2,3,5) + Task 3 (#6). Spec test #4 (resolved port reaches `setLanRuntime`) is covered **transitively**: Task 1 test 1 asserts `onListening` receives the shifted bound port (8081), locking the helper→callback contract that `index.ts`'s `listenerCallback` consumes to call `setLanRuntime(listenPort)`. `index.ts` boot has no test harness anywhere in the repo (consistent with existing practice), so there is no unit seam for the callback body itself — typecheck confirms the wiring compiles, not that it propagates.
- Docs (regression plan, INDEX, release notes ×2) → Task 4.

**Placeholder scan:** the only deferred value is `(#PR)` in the technical release note, explicitly flagged as fill-at-PR-open (it genuinely cannot exist earlier). No other TBDs.

**Type consistency:** `listenWithAutoRebind` / `RebindServer` / `AutoRebindOptions` / `formatRebindExhausted` names and the `onListening(port:number)` signature are identical across Task 1 (definition + tests) and Task 2 (call sites). `getLanRuntime().port` / `setLanRuntime({httpsActive,port})` match `lan-runtime.ts`.
