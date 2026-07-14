# srv-60 — Server auto-rebinds to a free port when 8080/8443 is in use

- **Issue:** [#1608](https://github.com/dudarenok-maker/Castwright/issues/1608) (`area:srv`, `type:chore`, `moscow:must`, `feedback`)
- **Date:** 2026-07-14
- **Status:** draft

## Problem

On startup, when the configured listen port is already in use (`EADDRINUSE`),
the server logs an actionable-but-terminal error and exits
(`server/src/crash-logging.ts` → `attachListenErrorHandler`). A co-running web
server on the default port therefore makes Castwright fail to launch outright —
the failure a beta reviewer hit through the Pinokio launcher (2026-07-14).

This affects **both** listen paths, exactly one of which runs per boot:

- HTTP `PORT` (default 8080) — the `app.listen(PORT)` branch.
- HTTPS `LAN_HTTPS_PORT` (default 8443) — the `NODE_ENV=production` /
  `LAN_HTTPS=1` `createHttpsServer(...).listen(LAN_HTTPS_PORT)` branch.

The fix lives in the server, so one change covers every **production** launch
path — `start:prod`, `start:lan`, and Pinokio — superseding the narrower
Pinokio-only `{{port}}` suggestion (which would not have covered the
HTTPS-default path). `npm start` is the **dev** launcher (`scripts/start-app.mjs`
→ `npm run dev`, no `NODE_ENV=production`) and deliberately keeps the fatal exit
— see the scope decision.

## Scope decision: production/launcher only

Auto-rebind fires **only when `NODE_ENV === 'production'`** — the `start:prod` /
`start:lan` (both `scripts/start-app-prod.mjs`) and Pinokio
(`pinokio-scripts/start.js`) paths. In dev — including `npm start`, which runs
the dev stack (`scripts/start-app.mjs` → `npm run dev`) — it is off: a port
collision keeps today's loud, actionable `formatListenError` + `exit(1)`.

Rationale — a silent port shift is safe in production but harmful in dev:

- **Production:** the frontend is served same-origin (port-agnostic relative
  URLs), Pinokio's `on:` matcher already captures any port
  (`/(https?:\/\/localhost:[0-9]+)/`), and LAN clients reach the box via the
  `:443` forwarder + `castwright.local`, not a pinned `IP:port`. A shifted port
  is invisible to every consumer.
- **Dev:** Vite's proxy targets a **pinned** API port
  (`vite.config` — `VITE_API_PORT ?? PORT ?? (useHttps ? 8443 : 8080)`), and
  `npm start` runs exactly that dev stack. A silent shift to 8081 would break
  `/api` and hide the real signal, which in dev is almost always "you already
  have an instance running" — precisely what srv-17's actionable message tells
  you. Keeping the fatal exit in dev preserves that double-start diagnostic.

`autoRebind` is passed to the helper as a parameter (`NODE_ENV === 'production'`
computed in `index.ts`) so tests can drive both modes without touching the real
environment.

## Mechanism: retry-on-`EADDRINUSE` (bind is the probe)

`server.listen(port)`; on an `'error'` event with `code === 'EADDRINUSE'`,
re-issue `listen(port + 1)` on the **same** server object, up to a cap. A
`net` / `http` / `https.Server` is reusable after a bind error (the TLS context
lives on the server, so `createHttpsServer({key,cert}, app)` re-`listen`s fine).
Chosen over probe-then-bind because bind *is* the probe — no
time-of-check/time-of-use gap where another process grabs the port between
"looked free" and "we took it" — and it reuses the existing
`attachListenErrorHandler` seam rather than duplicating bind logic.

The **actual** bound port is read back from `server.address().port` and becomes
the single source of truth (via `getLanRuntime()`) that all downstream wiring —
**including the two sites that today read the port constant directly** — must
read.

### Registering the success handler exactly once (critical)

The success handler (`listenerCallback`) MUST be attached **once** via
`server.once('listening', listenerCallback)` **before** the first `listen`, and
every `listen(port[, host])` call passes **no** callback. Node's
`server.listen(port, host, cb)` registers `cb` through `once('listening')` on
*each* call, and a failed bind emits `'error'`, never `'listening'`, so a
re-passed callback is **not** consumed — after k failed binds the k-th
(successful) bind would fire all k accumulated listeners, running
`listenerCallback` once **per attempt**. `listenerCallback` spawns the sidecar
supervisor (`createSidecarSupervisor().start()` + `enforceSingleSidecarOwner`),
the mDNS responder, and the `:443` forwarder — so per-attempt firing would
double-spawn them, i.e. the #1030 recycle-storm the sidecar-owner guard exists
to prevent. One `once('listening')` guarantees the heavy wiring runs exactly
once, on the final successful bind.

### The helper (`server/src/crash-logging.ts`)

`attachListenErrorHandler` is replaced by a helper that **owns the `listen`
call** so it can re-issue it — e.g.
`listenWithAutoRebind(server, { startPort, host, onListening, autoRebind, maxAttempts, onLog, onExit })`:

- attaches `server.once('listening', onListening)` once, up front.
- `EADDRINUSE` + `autoRebind` + attempts remaining → log
  `[server] Port <N> in use — trying <N+1>…`, then `server.listen(N+1, host)` — **no callback**.
- `EADDRINUSE` + **not** `autoRebind` (dev) → today's `formatListenError` + `exit(1)`, unchanged.
- `EADDRINUSE` + attempts **exhausted** → fatal exit with the actionable
  message, noting the scanned range.
- any **non-`EADDRINUSE`** error → unchanged fatal path
  (`FATAL listen error on port <N> — <stack>`).

`onLog` / `onExit` keep defaulting to `console.error` / `process.exit` and stay
injectable for tests, mirroring the current handler.

**Cap = 20 attempts, where attempt 1 is the initial bind** — it tries
`startPort … startPort + 19` (8080→8099 / 8443→8462), then fatal-exits. A box
with 20 consecutive ports occupied is a genuinely broken environment worth a
loud exit. (Pin this semantic in the plan + test #3 so an implementer doesn't
read `maxAttempts` as retries-after-initial and scan 21 ports.)

## Propagation of the resolved port

Today the port-dependent wiring uses the up-front `PORT` / `LAN_HTTPS_PORT`
**constants**. After this change, all of it reads the **actual** bound port
(`server.address().port`), resolved inside `listenerCallback` (which now fires
exactly once, on the final bind):

| Consumer | File | Change |
|---|---|---|
| `[server] listening on …:<port>` line | `index.ts` `listenerCallback` | use resolved port |
| LAN URLs + pairing QR (`enumerateLanUrls`) | `index.ts` → `routes/export-lan.ts` | pass resolved port |
| `setLanRuntime({ httpsActive, port })` | `index.ts` | **moved into `listenerCallback`**; today it is set at the pre-bind site with the constant |
| `:443` forwarder target (`startPortForwarder`) | `index.ts` `listenerCallback` | target resolved HTTPS port, not `LAN_HTTPS_PORT` |
| CSRF origin allow-list (`allowedOrigins`) | `csrf-origin.ts` | read `getLanRuntime().port`, not `process.env.LAN_HTTPS_PORT` |

`setLanRuntime` is the linchpin: pairing QR and `GET /api/export/lan` are
request-time reads of `getLanRuntime()` (`server/src/routes/devices.ts`), so
recording the true port there makes the QR and LAN URLs correct for free. No new
persistence — `castwright.local:443` (stable via the forwarder) remains the
durable address; `IP:port` is ephemeral and may drift across restarts, which is
deliberate.

**Second source of truth — `csrf-origin.ts` (do not miss this).**
`allowedOrigins()` independently computes the CSRF allow-list from
`process.env.LAN_HTTPS_PORT ?? 8443` — both its loopback origins and, via
`enumerateLanUrls(port, 'https')`, the enumerated LAN-IP origins. Left
unchanged, a device paired on a **shifted** port (e.g. 8444) sends
cookie-authenticated writes with Origin `https://<ip>:8444`, which is absent
from the 8443-pinned allow-list → **403 on every mutating request** (the device
can browse but not act — exactly the pairing this feature is supposed to keep
working). Switching `allowedOrigins()` to `getLanRuntime().port` fixes the
loopback origins, the port-scoped friendly hostname, and the enumerated IP
origins in one line. (Loopback/desktop is unaffected — CSRF only gates requests
bearing the `__Host-cw_lan` cookie; the bare-hostname `castwright.local:443`
forwarder path already matches the port-less allow-list entry, so that path
never depended on the port constant.) In HTTP-only (non-LAN) mode
`getLanRuntime().port` is the HTTP `PORT` (8080), so `allowedOrigins()` would
compute `https://localhost:8080` etc. rather than the old `:8443` — this is
inert, not a regression: the `__Host-`-prefixed `Secure` cookie only exists over
HTTPS LAN, so no HTTP-mode request ever reaches the origin check.

## Non-goals

- **No persistence** of the chosen port. The pretty `castwright.local:443`
  address ships by default and is the address to hand out.
- **No rebind of the `:443` forwarder itself.** It binds `:443`; a `:443`
  collision is a separate concern the forwarder already owns and is out of
  scope here.
- **No dev auto-rebind** (see scope decision) — this includes `npm start`.

## Testing

`server/src/crash-logging.test.ts` — the current fatal-exit-on-`EADDRINUSE`
assertion is replaced/augmented with:

1. `autoRebind: true`, first `listen` emits `EADDRINUSE`, second succeeds →
   helper re-listens on `port + 1`, **no `exit`** called.
2. `autoRebind: false` (dev) → `EADDRINUSE` still calls `exit(1)` with the
   actionable `formatListenError` message.
3. `autoRebind: true`, every attempt emits `EADDRINUSE` → after `maxAttempts`
   (attempt 1 = initial bind, so `startPort … startPort+19`), `exit(1)` with the
   range-scanned message. Assert the last attempted port is `startPort + 19`.
4. Propagation: the resolved (shifted) port is what reaches `setLanRuntime` /
   the listening-log seam, not the start constant.
5. The `onListening` success handler runs **exactly once** across a multi-attempt
   rebind (a spy passed as `onListening` fires once, not per attempt) — the
   regression guard for the callback-accumulation / double-spawn bug.

`server/src/csrf-origin.test.ts` (or the existing CSRF test file):

6. A request bearing the `__Host-cw_lan` cookie with Origin on the **shifted**
   runtime port passes `allowedOrigins()` — regression for the
   403-on-paired-device gap. Drive it by setting `getLanRuntime()` to a shifted
   port and asserting `https://<lan-ip>:<shifted>` is allowed.

Existing crash-handler tests (`uncaughtException` / `unhandledRejection`) stay
green.

## Acceptance (from #1608)

- [ ] 8080 pre-occupied → HTTP-mode start binds the next free port, prints it, no fatal exit.
- [ ] 8443 pre-occupied → HTTPS-mode (`NODE_ENV=production`) start binds the next free HTTPS port; the `:443` forwarder + `castwright.local` still reach it; the pairing QR shows the live port.
- [ ] Pinokio `pinokio-scripts/start.js` `on:` matcher still captures the live URL (its regex already matches any port).
- [ ] Regression test replaces the fatal-exit assertion in `server/src/crash-logging.test.ts` with an auto-rebind assertion.

## Key files

- `server/src/crash-logging.ts` (+ `.test.ts`) — the rebind helper + the
  `once('listening')` fix.
- `server/src/index.ts` — pass `autoRebind`/`startPort`; attach `listenerCallback`
  via `once('listening')`; move `setLanRuntime` and the forwarder target to the
  resolved port.
- `server/src/csrf-origin.ts` (+ test) — `allowedOrigins()` reads the runtime
  port so a device paired on a shifted port isn't CSRF-rejected.
- `server/src/lan-runtime.ts` — unchanged shape; now fed (and read for) the real port.
- `server/src/routes/export-lan.ts` (`enumerateLanUrls`) — receives resolved port.
