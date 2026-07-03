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
- Both names resolve from other LAN devices (phone, tablet, another PC), not just the dev
  box itself.
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
  the **current** LAN IPv4 addresses, computed live per query via `enumerateLanIps()`
  (already exported from `scripts/setup-lan-certs.mjs` — reused, not duplicated). No
  caching, so it stays correct if the dev box changes networks mid-session. All other
  queries are ignored — this responder never answers for any name it wasn't told to serve.
- Non-fatal failure: if binding the multicast socket fails (port 5353 already claimed by a
  real Bonjour/Chromecast/etc. service, or the OS blocks multicast), log one clear warning
  line and exit — never crash or block the caller. `dev:lan`/`start:lan` continue exactly
  as they do today, LAN-IP URLs unaffected.
- Extracted as a pure function (`buildAnswer(queriedName, configuredHostnames, ips)` or
  similar) so the answer-construction logic is unit-testable without a real socket.

### 2. `scripts/setup-lan-certs.mjs`

Add `castwright.local` and `castwright.dev.local` to the `hosts` array already passed to
`mkcert -cert-file ... -key-file ...`. This is the cert `server/src/index.ts` reads for
`LAN_HTTPS=1` (`start:lan`), so the built-bundle path gets HTTPS coverage for the new name
as a byproduct of the existing one-time `npm run install:cert-mobile` step (users on an
older cert without the new SANs re-run that command, same as today's LAN-IP-change flow).

### 3. `vite.config.ts`

- `mkcert({ hosts: ['castwright.dev.local'] })` — the plugin already supports a `hosts`
  option (default: `localhost` + detected local IPs); this adds the dev hostname to its
  auto-generated cert.
- `server.allowedHosts` gains `castwright.dev.local`. Vite 8's DNS-rebinding protection
  rejects requests whose `Host` header isn't `localhost`/an IP/an explicitly allowed name;
  LAN IPs already pass today, but a bare hostname needs to be listed explicitly.
- Both changes are gated behind the existing `useHttps` branch (i.e., only apply in LAN
  mode) — plain `npm run dev` config is untouched.

### 4. Wiring into the LAN scripts

- `dev:lan` (root `package.json`): add a third `concurrently` leg —
  `"node scripts/mdns-responder.mjs --name castwright.dev.local"` — alongside the existing
  `vite --host 0.0.0.0` and server legs.
- `start:lan` → `scripts/start-app-prod.mjs`: spawn the responder (`--name castwright.local`)
  as a child process using the same spawn/track/teardown pattern already used for the TTS
  sidecar child — started after the server is confirmed up, killed together with the rest
  of the stack on Ctrl+C (`taskkill /T /F` on Windows, matching existing shutdown handling).

### 5. `scripts/print-cert-install-instructions.mjs` (`install:cert-mobile`)

Print the new friendly URLs alongside the existing LAN-IP ones:
`https://castwright.dev.local:5173` and `https://castwright.local:8443`. Add one line
noting that iOS/Android/macOS resolve `.local` names automatically, while a Windows LAN
peer may need Bonjour installed — the LAN-IP URL remains the reliable fallback there.

## Data flow

1. Developer runs `npm run dev:lan` (or `npm run start:lan`).
2. The launcher starts the app server (Vite or Node) bound to `0.0.0.0`, plus the new mDNS
   responder child process advertising the one hostname relevant to that script.
3. A phone/tablet on the same LAN broadcasts a standard mDNS query for
   `castwright.dev.local` (e.g. because the user typed that URL into a browser).
4. The responder answers with the dev box's current LAN IPv4 address(es); the OS's native
   mDNS resolver on the client device completes the lookup with no extra configuration.
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
  `build-companion-apk.test.mjs`): correct A-record answer for a configured name, no answer
  for an unconfigured name, correct multi-IP answer when multiple LAN interfaces are active.
- `scripts/setup-lan-certs.mjs`: extend its existing test coverage (if any) or add a test
  asserting `castwright.local` / `castwright.dev.local` are included in the `hosts` array
  passed to `mkcert`.
- No e2e coverage — this is dev/LAN tooling, not shipped product behavior reachable from
  `npm run test:e2e`'s mock-mode Vite instance.
- Manual acceptance (documented in the regression plan, not automatable): run `dev:lan` and
  `start:lan` on the dev box, confirm `castwright.dev.local` / `castwright.local` resolve
  and load over HTTPS with no warning from a real phone on the LAN.

## Open items carried into planning

- Exact spawn/teardown wiring inside `start-app-prod.mjs` (child-process bookkeeping
  alongside the sidecar) is an implementation detail for the plan, not locked here.
- Whether `scripts/setup-lan-certs.mjs` already has a test file to extend vs. needing a new
  one is a planning-time check, not a design decision.
