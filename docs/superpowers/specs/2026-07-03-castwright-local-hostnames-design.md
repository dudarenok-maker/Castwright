---
status: draft
date: 2026-07-03
topic: Friendly LAN hostnames (castwright.local / castwright.dev.local) via mDNS
---

# Friendly LAN hostnames — castwright.local / castwright.dev.local

_Design spec · 2026-07-03_

This spec is **design/plan only** — implementation is a separate handover.

## Problem

The existing LAN HTTPS flow (plan 81, `npm run dev:lan` / `npm run start:lan`) makes the
app reachable from a phone or tablet on the same network, but only via a raw LAN IP —
`https://192.168.1.42:5173` or `https://192.168.1.42:8443`. That's fine functionally
(mkcert already makes it trust-once, no-warning HTTPS — see "Mobile testing protocol" in
`CLAUDE.md`), but it's not memorable, it changes whenever DHCP reassigns the address, and
it doesn't read as a real product. The ask: replace those raw-IP URLs with
`castwright.dev.local` (Vite dev server) and `castwright.local` (built bundle), reachable
from any device on the LAN, wired into the normal `dev:lan`/`start:lan` flow rather than a
one-off manual step.

## Goals

- `https://castwright.dev.local:5173` reaches the Vite dev server exactly like
  `npm run dev:lan`'s LAN-IP URL does today.
- `https://castwright.local:8443` reaches the built-bundle Node server exactly like
  `npm run start:lan`'s LAN-IP URL does today.
- Both names resolve from other LAN devices with native mDNS support — iOS, Android,
  macOS — not just the dev box itself. (A Windows LAN peer is a known gap, not a goal —
  see Non-goal 3; the dev box itself is Windows, but it advertises the names rather than
  needing to resolve its own broadcast.)
- No new manual per-run step — the hostnames come up automatically whenever `dev:lan` /
  `start:lan` run, the same way LAN-IP HTTPS already does.
- Degrades gracefully: if hostname resolution can't be set up on a given network (firewall,
  port conflict, a Windows peer without mDNS support), the existing LAN-IP URLs keep working
  unaffected. This feature is additive, never a new failure mode for `dev:lan`/`start:lan`.

## Non-goals (out of scope for this spec)

- **Plain `npm run dev` / `npm run start`** (loopback-only, no LAN). Those stay
  `localhost`-only, unchanged. Friendly hostnames only apply to the LAN-mode scripts.
- **Publicly-trusted certificates for these names.** `.local` is a reserved special-use TLD
  (RFC 6762) — public CAs including Let's Encrypt are contractually forbidden from issuing
  for it. These hostnames will always rely on the existing mkcert local root CA and its
  existing one-time per-device trust step (`npm run install:cert-mobile`). This is a
  deliberate, discussed trade-off (see "Relationship to the LAN public-cert broker" below).
- **Guaranteed resolution from Windows LAN peers.** Windows has no built-in mDNS responder
  and historically has patchy client-side `.local` resolution without Bonjour installed.
  This spec documents the gap rather than solving it — Windows peers fall back to the
  existing LAN-IP URL.
- **IPv6 / AAAA records.** IPv4-only, matching the existing `enumerateLanIps()` helper the
  LAN-cert flow already uses.
- **The `npm start` + `server/.env` `LAN_HTTPS=1` path** (`start-app.ps1`, which flips Vite
  and the server into LAN HTTPS without going through the dedicated `dev:lan`/`start:lan`
  scripts). This spec only wires the two scripts named in the original ask; this third,
  less-common LAN entry point keeps today's LAN-IP-only behavior with no friendly hostname —
  a known, accepted gap rather than a silent one, matching this spec's general "LAN-IP URL
  is always the fallback" posture.

## Relationship to the LAN public-cert broker

A separate, larger effort ([[project_lan_public_cert_broker]], designed but not yet built)
solves a related-but-distinct problem: **zero-install** trusted HTTPS for LAN devices via a
Cloudflare Worker issuing real Let's Encrypt certs for `‹installId›.lan.castwright.ai`. That
project deliberately avoids `.local` names for exactly the reason above — a public CA can't
certify them. This spec is a smaller, immediate stepping stone that reuses today's mkcert
infrastructure; it does not block or duplicate the broker work. When the broker ships, the
friendly-hostname *idea* carries forward (a memorable name beats a raw IP either way) but
the resolution + cert mechanism for it would shift to whatever the broker provides. Nothing
built here needs to be torn out for that migration — the mDNS responder and the extra mkcert
SANs are simply superseded, not depended upon, by the broker's DNS + ACME approach.

## Approach

Two independent pieces make a hostname "just work" over HTTPS: **resolution** (name → IP)
and **certificate coverage** (no browser warning). `.local` is mDNS's reserved TLD, so
resolution uses a small custom mDNS responder rather than any DNS server or hosts-file
editing — modern mobile OSes (iOS, Android, macOS) resolve mDNS natively with zero
per-device setup, which fits the "part of the normal build" requirement better than
per-device hosts-file entries. Certificate coverage extends the two cert-generation paths
that already exist (`vite-plugin-mkcert` for Vite, `scripts/setup-lan-certs.mjs` for the
Node server) to include the new hostnames as extra SANs — both already support a `hosts`
list, so this is additive configuration, not new cert machinery.

## Components

### 1. `scripts/mdns-responder.mjs` (new)

Thin wrapper around the `multicast-dns` npm package (`^7.2.5`, latest as of this spec — pin
to latest at install time rather than an older cached version, per user preference, so this
doesn't need an immediate follow-up bump). Pure JS, no native bindings, cross-platform.

- CLI: `node scripts/mdns-responder.mjs --name castwright.dev.local` (repeatable `--name`
  for multiple hostnames from one process, though the two call sites below each pass one).
- Listens for standard mDNS A-record queries. For each configured hostname, answers with
  the dev box's **current primary LAN IPv4 address**, computed live per query. This is
  *not* `enumerateLanIps()` (the helper `scripts/setup-lan-certs.mjs` already exports and
  reuses for cert SANs) — that helper returns every non-internal IPv4 interface, which is
  fine for a cert's SAN list (an extra SAN is inert) but wrong for an mDNS answer (an extra
  A-record actively misdirects a client to whichever interface it picks — e.g. a Docker
  Desktop/WSL/VPN virtual adapter that happens to also be non-internal IPv4, and isn't
  filtered out by that helper's `internal`/`169.254.*` checks). Instead, the responder
  determines the single interface the OS itself would use for outbound traffic to an
  external address (the standard `dgram` "connect a UDP socket to an external address, read
  back the local address the OS bound" trick — no packets are actually sent), and answers
  with that one address. No caching, so it stays correct if the dev box changes networks
  mid-session. All other queries are ignored — this responder never answers for any name it
  wasn't told to serve.
  - **Known limitation, accepted for v1:** this picks the OS's *default-route* interface,
    which is correct for the common single-LAN dev box but can still misdirect on a box
    with an active VPN (default route through the tunnel adapter) or two real LAN interfaces
    on different subnets (e.g. Ethernet holds the default route but the phone is on Wi-Fi).
    This is a best-effort simplification, not a guarantee — the same class of accepted,
    documented gap as the Windows-peer-resolution limitation (Non-goal 3), not a new failure
    mode: a misdirected connection just times out and the tester falls back to the existing
    LAN-IP URL, same as today. A fuller fix (answer per the interface the query arrived on,
    or return multiple candidate addresses and let the OS's own Happy-Eyeballs-style retry
    sort it out — note `vite.config.ts:90-96` already documents this repo hitting that
    exact multi-address-timeout tradeoff for IPv4/IPv6) is out of scope for this spec.
- Non-fatal failure: if binding the multicast socket fails (port 5353 already claimed by a
  real Bonjour/Chromecast/etc. service, or the OS blocks multicast), log one clear warning
  line and exit — never crash or block the caller. `dev:lan`/`start:lan` continue exactly
  as they do today, LAN-IP URLs unaffected.
- Extracted as a pure function (`buildAnswer(queriedName, configuredHostnames, primaryIp)`
  or similar — note singular `primaryIp`, matching the single-address design above) so the
  answer-construction logic is unit-testable without a real socket.

### 2. `scripts/setup-lan-certs.mjs`

Add `castwright.local` and `castwright.dev.local` to the `hosts` array already passed to
`mkcert -cert-file ... -key-file ...`. This is the cert `server/src/index.ts` reads for
`LAN_HTTPS=1` (`start:lan`), so the built-bundle path gets HTTPS coverage for the new name
as a byproduct of the existing one-time `npm run install:cert-mobile` step (users on an
older cert without the new SANs re-run that command, same as today's LAN-IP-change flow).

### 3. `vite.config.ts`

- `mkcert({ hosts: ['castwright.dev.local'] })` — the plugin already supports a `hosts`
  option (confirmed against `vite-plugin-mkcert`'s own README: "Custom hosts, default value
  is `localhost` + `local ip addrs`"); this adds the dev hostname to its auto-generated cert
  on top of, not instead of, its existing defaults.
- `server.allowedHosts` gains `castwright.dev.local`. Vite 8's DNS-rebinding protection
  rejects requests whose `Host` header isn't `localhost`/an IP/an explicitly allowed name;
  LAN IPs already pass today (today's `dev:lan` works over a raw LAN IP with no
  `allowedHosts` config, which is the behavioral evidence for this), but a bare hostname
  needs to be listed explicitly — verify this against Vite's actual source during
  implementation rather than taking it purely on inference.
- Both changes are gated behind the existing `useHttps` branch (i.e., only apply in LAN
  mode) — plain `npm run dev` config is untouched.

### 4. Wiring into the LAN scripts

The two LAN scripts have different process shapes, so they own the responder differently —
but both ultimately spawn the same `scripts/mdns-responder.mjs` CLI as a child process, so
the responder logic itself stays single-sourced.

- **`dev:lan`** (root `package.json`): `dev:lan` today is exactly two `concurrently
  --kill-others-on-fail` legs — `vite --host 0.0.0.0` and `cross-env LAN_HTTPS=1 npm
  --prefix server run dev` (`package.json:18`). This becomes a **third** leg —
  `"node scripts/mdns-responder.mjs --name castwright.dev.local"` — torn down automatically
  with the other two by `concurrently`'s `--kill-others-on-fail` — not `-k`, since the mDNS
  leg's own graceful bind-failure `exit(0)` must not be treated as a reason to tear the
  others down.
- **`start:lan`**: **not** owned by `scripts/start-app-prod.mjs`. That launcher spawns the
  server `detached: true` (`scripts/start-app-prod.mjs:234`), `unref()`s it (`:248`), and
  calls `process.exit(0)` once the health check passes (`:260`) — it has no `SIGINT`/
  `SIGTERM` handling and isn't a supervising process, so nothing owned by *it* survives past
  `start:lan` returning. The actual long-lived process is the Node **server** itself, which
  already owns exactly this kind of child-process lifecycle for the TTS sidecar:
  `server/src/index.ts` spawns the sidecar via `server/src/tts/spawn-sidecar.ts` and reaps
  it in a real `shutdown()` handler registered on `SIGINT`/`SIGTERM`
  (`server/src/index.ts:341-357`).

  The mDNS responder for `castwright.local` follows the identical pattern, with one
  additional discriminator that the dev-mode case above doesn't need: **both** `start:lan`
  and `dev:lan` set `LAN_HTTPS=1`, so gating the server-side spawn on `lanHttps` alone would
  make the server *also* spawn a `castwright.local` responder during `dev:lan` — racing the
  dedicated `concurrently` leg above for the UDP :5353 socket, for a hostname `dev:lan`
  never advertises anywhere else. The two flows are distinguished by `NODE_ENV`, not
  `LAN_HTTPS`: `start-app-prod.mjs:232` sets `NODE_ENV: 'production'` on the server child's
  env for `start:lan`; the server's plain `dev` script (`tsx watch …`, `server/package.json`)
  never sets it. So the server spawns the responder only when
  `lanHttps && process.env.NODE_ENV === 'production'`. The spawn point is inside
  `listenerCallback` (`server/src/index.ts:150`, invoked by both the HTTPS and plain-HTTP
  `.listen()` calls) — the `if (lanHttps && …)` guard is required there regardless, since
  that callback already runs on the non-LAN path too. The child handle is stored in a
  module-scoped variable (mirroring `sidecarSupervisor` at `index.ts:126`) so `shutdown()`
  can see and kill it alongside `sidecarSupervisor?.stop()`. Exact new-file placement (e.g.
  alongside `bind-host.ts`) is left to the implementation plan; the ownership model
  (server-owned, `NODE_ENV`-gated, reaped in `shutdown()`) is the locked decision here.

### 5. `scripts/print-cert-install-instructions.mjs` (`install:cert-mobile`)

Print the new friendly URLs alongside the existing LAN-IP ones:
`https://castwright.dev.local:5173` and `https://castwright.local:8443`. Add one line
noting that iOS/Android/macOS resolve `.local` names automatically, while a Windows LAN
peer may need Bonjour installed — the LAN-IP URL remains the reliable fallback there.

## Data flow

1. Developer runs `npm run dev:lan` (or `npm run start:lan`).
2. The app server (Vite or Node) binds `0.0.0.0`, and the mDNS responder child process for
   that script's hostname comes up alongside it — as a sibling `concurrently` leg for
   `dev:lan`, or spawned and owned by the Node server itself for `start:lan` (see Component
   4). Either way, the responder is tied to the same lifecycle as the server it serves: it
   dies when the server does, not when a short-lived launcher script happens to exit.
3. A phone/tablet on the same LAN broadcasts a standard mDNS query for
   `castwright.dev.local` (e.g. because the user typed that URL into a browser).
4. The responder answers with the dev box's current primary LAN IPv4 address (the OS's
   preferred outbound interface, not every detected interface); the OS's native mDNS
   resolver on the client device completes the lookup with no extra configuration.
5. The browser connects over HTTPS. The TLS handshake presents a cert whose SAN list
   includes `castwright.dev.local` (Vite) or `castwright.local` (Node) — no warning, since
   the device already trusts the mkcert root CA from the existing one-time LAN setup.

## Error handling

- **mDNS responder can't bind** (port conflict, blocked multicast): warn once, exit; app
  continues on LAN-IP URLs as it does today. Never fatal to `dev:lan`/`start:lan`.
- **Cert missing the new SANs** (stale cert from before this change): same failure mode
  that already exists today for a stale/missing cert — `server/src/index.ts` already prints
  `Run 'npm run install:cert-mobile' first...` when the cert files are absent; a stale cert
  without the new names simply won't validate for the new hostname specifically, which
  surfaces in-browser as a cert-name-mismatch warning, prompting a re-run of
  `install:cert-mobile`.
- **Windows Firewall prompt**: the Node process binding a UDP multicast socket may trigger
  a first-run Windows Firewall prompt (Private network). Documented in the
  `install:cert-mobile` output, not auto-suppressed — consistent with the project's existing
  stance of not silently bypassing OS security prompts.

## Testing

- `scripts/mdns-responder.mjs`'s answer-construction logic extracted as a pure function and
  unit-tested (Vitest, following the existing `scripts/*.test.mjs` pattern used by
  `build-companion-apk.test.mjs`): correct single-address A-record answer for a configured
  name, no answer for an unconfigured name.
- `scripts/setup-lan-certs.mjs`: extend its existing test coverage (if any) or add a test
  asserting `castwright.local` / `castwright.dev.local` are included in the `hosts` array
  passed to `mkcert`.
- The new server-owned spawn/reap logic for `start:lan` (Component 4) gets its own test,
  mirroring however `server/src/tts/spawn-sidecar.ts` / the sidecar supervisor are
  themselves tested — this is the piece most likely to regress silently (a leaked or
  never-started child), so it does not get waved off to manual acceptance alone. Explicitly
  covers the `NODE_ENV` discriminator: `lanHttps=true, NODE_ENV!=='production'` (the
  `dev:lan` server-leg shape) must NOT spawn a responder — this is exactly the double-spawn
  bug the round-2 design review caught, so it gets a regression test rather than relying on
  the discriminator being correctly re-derived by a future reader.
- The "primary LAN IP" selection helper (the outbound-socket trick used for mDNS answers,
  as distinct from `enumerateLanIps()`) gets a unit test asserting it returns a single
  address, not the full interface list.
- No e2e coverage — this is dev/LAN tooling, not shipped product behavior reachable from
  `npm run test:e2e`'s mock-mode Vite instance.
- Manual acceptance (documented in the regression plan, not automatable): run `dev:lan` and
  `start:lan` on the dev box, confirm `castwright.dev.local` / `castwright.local` resolve
  and load over HTTPS with no warning from a real phone on the LAN.

## Open items carried into planning

- Exact new-file placement for the server-side mDNS-owner module (Component 4) is a
  planning-time choice, not locked here — the ownership model (server-owned via the
  existing `shutdown()` handler, not the launcher) is the locked decision.
- Whether `scripts/setup-lan-certs.mjs` already has a test file to extend vs. needing a new
  one is a planning-time check, not a design decision.
- **Resolved by user 2026-07-03:** three adversarial review rounds surfaced that the
  "primary LAN IP" mDNS-answer heuristic (Component 1) is a best-effort default, not a
  correctness guarantee, under a VPN or dual-homed LAN. User confirmed shipping the v1
  default now (documented limitation, LAN-IP URL always the fallback) rather than building
  per-interface/multi-address answers as part of this spec. Tracked as a follow-up:
  [`ops-21`](https://github.com/dudarenok-maker/Castwright/issues/1239) /
  `docs/BACKLOG.md`.
