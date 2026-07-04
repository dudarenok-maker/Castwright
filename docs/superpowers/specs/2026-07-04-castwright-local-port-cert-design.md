---
status: draft
date: 2026-07-04
topic: castwright.local port-443 default + in-app cert regeneration + CSRF-origin fix
---

# castwright.local without a port, plus in-app cert regeneration

_Design spec · 2026-07-04_

This spec is **design/plan only** — implementation is a separate handover.

## Problem

The friendly-hostname feature (`docs/features/239-castwright-local-hostnames.md`) makes
`start:lan` reachable at `https://castwright.local:8443` — but browsers default to port 443
for `https://` URLs with no explicit port, so a bare `https://castwright.local` silently
tries the wrong port and fails. Separately, while diagnosing that, two more gaps surfaced:

1. **Stale-cert UX gap**: the mkcert-generated LAN cert's SAN list only gets refreshed by
   manually running `npm run install:cert-mobile`. Nothing in the app detects or surfaces
   "your cert doesn't cover this hostname" — a user just gets a silent TLS failure and has
   to already know to re-run the script. Today's in-app guidance (the LAN Access card's
   collapsed disclosure, and the `phone-cant-reach` help topic) both assume the failure mode
   is "a new device hasn't trusted the cert yet," not "the cert is stale."
2. **CSRF-origin gap**: `server/src/csrf-origin.ts`'s `allowedOrigins()` enumerates loopback
   + raw LAN IPs only, never the friendly hostnames. Any cookie-authenticated mutating
   request (POST/PUT/PATCH/DELETE) made while browsing via `castwright.local` or
   `castwright.dev.local` today gets rejected with a 403, independent of the port-443 work
   below — this is a live bug in the already-shipped hostname feature.

## Goals

- `https://castwright.local` (no port) reaches the same app as `https://castwright.local:8443`
  today, from any LAN device — without changing the main app's listening port or its fault
  characteristics (a bind failure on 443 must not take down the app on :8443).
- A user can regenerate the LAN cert from inside the running app (a button), instead of only
  via a script run outside it — and the running server picks up the new cert immediately,
  with no restart.
- Mutating requests over `castwright.local` / `castwright.dev.local` / bare `castwright.local`
  no longer 403.
- All of this is additive to the existing LAN-IP flow, which keeps working unchanged in every
  failure mode (port 443 taken, mkcert missing, etc.).

## Non-goals (out of scope for this spec)

- **dev:lan / `castwright.dev.local:5173` getting its own port-443 forwarder.** Dev workflow
  keeps its explicit Vite port; only the production `start:lan` path gets the bare-hostname
  treatment. (User decision, 2026-07-04.)
- **Detecting/warning about a stale cert proactively** (e.g. a startup check comparing the
  cert's SANs against expected hosts). Named as a real gap above, but the fix here is the
  regenerate button — making staleness cheap to resolve — not automatic detection. Tracked as
  a possible follow-up, not built here.
- **HTTPS/SVCB DNS records or any other DNS-level port hinting.** Investigated and rejected:
  browsers don't consult DNS to determine which port a manually-typed `https://` URL uses
  (it's always 443, full stop, unless the URL states otherwise), and the existing
  `multicast-dns`-based responder only ever answers plain A-records. No DNS mechanism solves
  this problem for a typed URL; only listening on the right port does.
- **Rebinding the main app itself to port 443.** Rejected in favor of a thin forwarder — see
  "Approach" below for the fault-isolation reasoning.
- **Windows peer resolution of `.local` names.** Pre-existing, documented gap from the parent
  feature (239) — unchanged here.

## Approach

Three independent pieces, each additive to what 239 already shipped:

1. **Port-443 forwarder**: a raw TCP byte-forwarder (not an HTTP redirect, not a TLS-terminating
   proxy) listening on :443 and piping to the real server on `LAN_HTTPS_PORT` (default 8443).
   Raw TCP forwarding was chosen over the alternatives:
   - *HTTP-level redirect* (443 → issue a 301 to `:8443`) was rejected because the browser's
     address bar updates to show the target of a cross-origin redirect — the port would
     reappear in the URL bar the moment the redirect fires, defeating the purpose. A redirect
     also runs the TLS handshake for the *hostname* origin (443) separately from the
     handshake for the *port-visible* origin (8443), doubling handshake cost per navigation.
   - *Rebinding the main app to port 443 directly* (`LAN_HTTPS_PORT=443`) was rejected for
     fault isolation: if 443 is already taken (a common conflict — IIS, Skype, a VPN client),
     the entire app fails to start. A thin forwarder's bind failure, by contrast, only means
     the bare-hostname convenience doesn't work; the app keeps serving on :8443 exactly as
     before, unaffected.
   - Raw TCP forwarding (chosen): the browser makes one connection, to :443; the forwarder
     blindly relays bytes to :8443 without terminating TLS itself, so the browser's TLS
     session is genuinely end-to-end with the real server (using the real server's cert,
     SNI, etc.). The address bar never learns about :8443 and never changes.
2. **In-app cert regeneration**: a button in the LAN Access card that regenerates the mkcert
   LAN cert (calling the existing `scripts/setup-lan-certs.mjs` machinery) and hot-swaps it
   into the already-running HTTPS server via `server.setSecureContext()` — no restart needed.
3. **CSRF-origin fix**: add the friendly hostnames (with and without an explicit port) to
   `csrf-origin.ts`'s allow-list.

## Components

### 1. `server/src/lan-port-forwarder.ts` (new)

- `shouldSpawnPortForwarder(lanHttps: boolean, env = process.env): boolean` — identical shape
  to `shouldSpawnMdnsResponder`: `lanHttps && env.NODE_ENV === 'production'`. Same rationale:
  `dev:lan`'s server leg also sets `LAN_HTTPS=1`, and must not also get a port-443 forwarder
  it doesn't advertise or own.
- `startPortForwarder(targetPort: number, opts?): PortForwarderHandle | null` — creates a
  `net.createServer()` bound to `0.0.0.0:443`. On each `'connection'` event, opens
  `net.connect({ port: targetPort, host: '127.0.0.1' })` and pipes both directions
  (`socket.pipe(upstream); upstream.pipe(socket)`); on either side closing or erroring, destroy
  both ends (no half-open leaks). Returns a handle with a `close()` method (mirrors
  `MdnsResponderHandle`'s `kill()` shape, but this is an in-process `net.Server` — `close()`
  is the standard Node API, no child-process teardown needed).
- Bind failure (`'error'` event on the server, e.g. `EADDRINUSE`/`EACCES`): `console.warn` once,
  do not throw, do not retry. The main app's :8443 listener is entirely unaffected — it was
  already up before this call runs.

### 2. `server/src/index.ts` wiring

- Import and call `shouldSpawnPortForwarder`/`startPortForwarder` immediately after the
  existing mDNS spawn call (~line 269-271), same `if (...)` shape, same `lanHttps` variable
  already in scope.
- New module-scoped `let portForwarderHandle: PortForwarderHandle | null = null;` alongside
  the existing `mdnsResponderHandle`, closed in `shutdown()` alongside it.
- **Live-HTTPS-server registry** (new, small — `server/src/lan-https-registry.ts`): exports
  `setLiveHttpsServer(server: https.Server)` and `getLiveHttpsServer(): https.Server | null`.
  `index.ts` calls the setter immediately after `createHttpsServer(...).listen(...)` succeeds
  (inside `listenerCallback`, mirroring where the mDNS/forwarder spawns already happen). This
  indirection exists because the cert-regeneration route (Component 4) needs a reference to
  the live server to call `setSecureContext()`, but is defined in its own route module —
  importing the concrete server instance directly from `index.ts` would be circular (`index.ts`
  imports the router; the router can't import back from `index.ts`). A tiny shared module
  avoids that without restructuring `index.ts`.

### 3. `server/src/csrf-origin.ts`

Add three literal entries to `allowedOrigins()`'s returned set, alongside the existing
loopback + LAN-IP entries (matching the existing house style of repeating hostname literals
rather than introducing a shared-constants module — see `buildCertHosts()` in
`scripts/setup-lan-certs.mjs` and the `'castwright.local'` literal in
`spawnMdnsResponder('castwright.local', repoRoot)` for precedent):

- `` `https://castwright.local:${port}` `` (port = `LAN_HTTPS_PORT`, already computed in this
  file) — covers today's explicit-port access, already possible and already broken.
- `'https://castwright.local'` (no port — the `Origin` header omits a default port, so this
  bare form is what a request made through the new port-443 forwarder actually sends).
- `'https://castwright.dev.local:5173'` — the `dev:lan` Vite port is a fixed literal in
  `package.json`'s `dev:lan` script, not derived from `LAN_HTTPS_PORT`, so it's added as its
  own fixed entry.

An unused allow-list entry is inert (nobody's `Origin` header will ever equal it if that URL
is never actually served), so all three are added unconditionally rather than threading the
port-443 forwarder's live/dead state into this module.

### 4. `server/src/routes/lan-cert.ts` (new)

- `POST /api/lan/cert/regenerate`, mounted via `app.use('/api/lan', lanCertRouter)` alongside
  the other `/api/...` routers in `app.ts` — inherits the existing `requireLanToken` +
  `requireSameOrigin` middleware already applied to the whole `/api` prefix (lines 117/120),
  no new auth logic needed.
- Handler: spawns `scripts/setup-lan-certs.mjs` as a **subprocess**
  (`execFileSync(process.execPath, [scriptPath], { timeout: 30_000, windowsHide: true })`) —
  not an in-process import. This is a hard requirement, not a style choice:
  `setupLanCerts()` calls `process.exit(1)` directly on any mkcert failure (missing binary,
  generation error), and importing it in-process would take the entire running server down on
  exactly the error path a "regenerate" button is most likely to hit (mkcert not installed).
  Spawning as a subprocess is also consistent with how `spawnMdnsResponder` and
  `start-app-prod.mjs` already cross this same scripts/-vs-server module boundary (see
  `mdns-owner.ts`'s own comment on why scripts/ and server/ don't cross-import).
- On subprocess success (exit code 0): re-read `lan-cert.pem`/`lan-key.pem` from
  `.run/certs/`, call `getLiveHttpsServer()?.setSecureContext({ key, cert })`. If no live
  HTTPS server is registered (plain-HTTP mode, `LAN_HTTPS` off), skip the hot-swap silently —
  the cert files are still regenerated and ready for the next time LAN HTTPS is enabled.
  Respond `200 { hosts: [...] }` with the host list the script generated for (parsed from its
  stdout, or by re-deriving via the same `enumerateLanIps()`/`buildCertHosts()` the script
  itself uses — exact parsing approach is a planning-time detail, not locked here).
- On subprocess failure (nonzero exit / timeout): respond `500 { error: <captured stderr> }`.

### 5. `src/components/lan-access-card.tsx`

Replace the collapsed `<details>` block ("Phone shows 'Not secure'?") with a
**"Regenerate certificate"** button, gated behind the existing `!manageHint` check (the same
check that already hides device management when the card is viewed from a paired phone/tablet
— this keeps the action to the desktop session, since mkcert must run on the machine hosting
the server). Behavior:

- Idle → click → loading spinner → `POST /api/lan/cert/regenerate`.
- Success: show the returned host list inline (e.g. "Now covers: localhost, castwright.local,
  castwright.dev.local, 192.168.86.20").
- Failure: reuse the card's existing `err` state / rendering to show the server's error
  message (e.g. "mkcert not installed").

## Data flow

**Bare-hostname request:**
1. Phone resolves `castwright.local` via the existing mDNS responder (239) to the LAN IP.
2. Phone's browser connects HTTPS to `<lan-ip>:443` (its own default — no port in the typed URL).
3. `lan-port-forwarder.ts`'s listener accepts the TCP connection, opens a second TCP connection
   to `127.0.0.1:8443`, and pipes bytes both ways.
4. The real server (already listening on :8443) performs the TLS handshake and serves the
   request exactly as it would for an explicit `:8443` request — it has no awareness the
   connection arrived via the forwarder.
5. The browser's address bar shows `https://castwright.local` for the whole session; every
   subsequent request (assets, API calls) goes through the same forwarded path.

**Cert regeneration:**
1. User clicks "Regenerate certificate" in the LAN Access card (desktop session).
2. `POST /api/lan/cert/regenerate` → passes `requireLanToken` + `requireSameOrigin` like any
   other mutating `/api` call.
3. Route spawns `scripts/setup-lan-certs.mjs` as a subprocess; waits for it to exit.
4. On success, re-reads the regenerated PEM files and calls `setSecureContext()` on the live
   HTTPS server (via the registry from Component 2) — new TLS handshakes immediately use the
   new cert; already-open connections are unaffected until they reconnect.
5. UI shows the new host list.

## Error handling

- **Port 443 already taken / permission denied**: `lan-port-forwarder.ts` logs one
  `console.warn`, the main app's :8443 listener is unaffected. No health-endpoint field, no UI
  banner (user decision, 2026-07-04) — the explicit `:8443` URL remains the fallback, same
  posture as every other degrade-gracefully path in the parent feature (239).
- **mkcert not installed / generation fails** (regenerate button): subprocess exits nonzero,
  route responds 500 with the captured stderr, UI surfaces it inline. The running server's
  cert and TLS state are untouched — a failed regeneration never disrupts an already-working
  setup.
- **Regenerate button clicked while `LAN_HTTPS` is off**: cert files still regenerate (useful
  prep for later), hot-swap step is a no-op (`getLiveHttpsServer()` returns null).
- **CSRF allow-list entries for hostnames that aren't actually being served** (e.g.
  `castwright.dev.local:5173` listed even when only `start:lan` is running): inert, as noted
  in Component 3 — no request's `Origin` will ever match an unserved hostname.

## Testing

- `server/src/lan-port-forwarder.test.ts` (new) — mirrors `mdns-owner.test.ts`'s shape: pins
  `shouldSpawnPortForwarder`'s `NODE_ENV` discriminator; an integration-style test spins up a
  dummy TCP echo server as the "upstream" and asserts bytes round-trip through the forwarder
  in both directions; asserts a bind failure (e.g. binding to an already-used port in the
  test) triggers the warn path without throwing.
- `server/src/csrf-origin.test.ts` — add cases: `https://castwright.local:8443` passes,
  `https://castwright.local` (no port) passes, `https://castwright.dev.local:5173` passes;
  existing "403s a foreign origin" case stays green (no widening beyond the three new
  literals).
- `server/src/routes/lan-cert.test.ts` (new) — mocks the child-process spawn: success path
  asserts `setSecureContext` is called with the freshly-read PEM contents and the route
  returns 200 with a host list; failure path (nonzero exit) asserts a 500 with the captured
  stderr and that `setSecureContext` is NOT called; no-live-server path (registry returns
  null) asserts the hot-swap is skipped without erroring.
- `src/components/lan-access-card.test.tsx` — add cases for the new button's idle/loading/
  success/error states, mocking the `api` call.
- Manual acceptance, added to `docs/features/239-castwright-local-hostnames.md`: run
  `npm run start:lan`, browse to bare `https://castwright.local` from a real LAN device,
  confirm it loads with no port in the URL; perform a mutating action (e.g. rename a book)
  and confirm no 403; click "Regenerate certificate," confirm the app keeps serving
  uninterrupted and a fresh browser tab shows no cert warning without restarting the app.
- No e2e coverage for the forwarder/cert-regen server internals (same rationale as 239 — LAN
  tooling, not reachable from the e2e mock-mode Vite instance). The LAN Access card button's
  presence/click-through IS reachable and gets a Vitest+RTL test, consistent with how the rest
  of that component is already tested.

## Open items carried into planning

- Exact shape of parsing the regenerated host list out of `setup-lan-certs.mjs`'s subprocess
  output (stdout parsing vs. re-deriving via `enumerateLanIps()`/`buildCertHosts()` directly
  in the route) is a planning-time choice, not locked here.
- Whether `lan-access-card.test.tsx` already exists to extend vs. needs to be created is a
  planning-time check.
- The CSRF-origin fix (Component 3) was discovered as a live bug in the already-shipped 239
  feature, not something introduced by this spec's own changes — folded in here per user
  decision (2026-07-04) rather than filed as a separate bug PR, to avoid a second review cycle
  for two changes that touch the same feature area back-to-back.
