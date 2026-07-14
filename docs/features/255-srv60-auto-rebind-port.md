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
