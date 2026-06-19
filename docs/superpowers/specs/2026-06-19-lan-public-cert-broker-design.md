---
title: LAN public-cert broker (zero-install trusted HTTPS over LAN)
date: 2026-06-19
revision: 2 (folded two adversarial passes — security + feasibility)
status: draft — adversarial-reviewed, ready for user review → plan. NOT implemented.
area: cloud (Castwright-Website / Cloudflare Worker + Durable Object) + server (install-side)
supersedes-approach-of: 2026-06-19-lan-cert-trust-bootstrap-design.md (REJECTED)
follows: srv-42 / docs/features/225-lan-browser-device-auth.md
---

# LAN public-cert broker — zero-install trusted HTTPS over LAN

## Problem

A phone **browser** hitting the LAN server over HTTPS shows
`NET::ERR_CERT_AUTHORITY_INVALID` — it doesn't trust the dev box's mkcert root CA,
and the only secure fix (install the CA) is a manual per-device chore. The
rejected `2026-06-19-lan-cert-trust-bootstrap-design.md` proved there is **no
secure + smooth way to bootstrap a private CA into a phone browser's OS trust
store**. The only path to a **clean lock with zero device install** is a
**publicly-trusted certificate** — and public CAs won't issue for a private LAN
IP, so the server must be reachable under a **public hostname** that resolves to
the LAN IP, with a real (Let's Encrypt) cert for it.

## Approved approach

`‹installId›.lan.castwright.ai` resolves (public DNS) to the install's LAN IP; the
install serves a **per-install Let's Encrypt cert** for that hostname; a Cloudflare
**broker** (Worker + Durable Object) automates the DNS record + cert issuance. The
install's private key is generated locally and **never leaves the install**.
mkcert + manual-install + the companion app remain the **offline fallback** — and
provisioning is **best-effort**: any failure falls back, never blocks `start:lan`.

This is a **two-part project**, built broker-first:

- **Sub-project 1 — the broker (THIS spec):** Cloudflare Worker + Durable Object +
  the delegated `lan.castwright.ai` zone. (Implemented in the `Castwright-Website`
  repo.)
- **Sub-project 2 — install-side cert lifecycle (separate spec/plan):** installId/
  keypair/CSR, async provision + poll, store/serve/renew, A-only re-point on IP
  change, **listener cert hot-reload**, fallback. Contract defined below.

## DNS setup (no email disruption) — with the two issuance landmines defused

`castwright.ai` stays at **Porkbun** (apex, MX/email, www untouched). Only the
subdomain `lan.castwright.ai` is delegated to Cloudflare:

1. Create a **standalone Cloudflare zone literally named `lan.castwright.ai`**
   (NOT a partial/CNAME setup, NOT records inside the `castwright.ai` zone).
   Cloudflare assigns nameservers.
2. At Porkbun, add **NS records for the `lan` label** → those Cloudflare
   nameservers. (Surgical; cannot touch apex/email.)
3. **CAA (MANDATORY):** publish `lan.castwright.ai CAA 0 issue "letsencrypt.org"`
   (and `0 issuewild ";"`) in the Cloudflare zone. CAA checks walk UP the tree and
   stop at the first level with a record — so this **shields the subdomain from any
   future apex CAA added at Porkbun**, which would otherwise silently break ALL
   issuance. Optionally pin `accounturi` to the broker's ACME account. Runbook note
   at Porkbun: "never delete the `lan` CAA."
4. **DNSSEC:** if `castwright.ai` has DNSSEC enabled at Porkbun, the `lan`
   delegation must be left **insecure** (no DS record at the parent for `lan`)
   unless a verified DS chain is established — otherwise validating resolvers
   (incl. Let's Encrypt's) SERVFAIL the `_acme-challenge` TXT → every issuance
   fails with a confusing DNS error. **Pre-flight:** `dig +dnssec` the TXT from a
   validating resolver before declaring the zone ready.

The broker is hosted on a name that does **NOT depend on the delegated zone
resolving** (e.g. a `*.workers.dev` route or a `castwright.ai` apex host) so broker
availability is independent of the delegation it manages.

## Sub-project 1 — the broker (Cloudflare Worker + Durable Object)

### Ownership binding (CRITICAL — the security crux)

`installId` is **guaranteed public**: it is the DNS label, it is in the pairing
QR, and **every issued cert publishes it forever in Certificate Transparency logs**
(`crt.sh?q=%.lan.castwright.ai`). Therefore **security MUST NOT rest on installId
secrecy.** Every state-changing call is gated by **proof-of-possession of a
per-install auth key**:

- On `start:lan`, the install generates a long-lived **auth keypair** (separate
  from the TLS cert keypair) and a high-entropy random `installId`
  (≥122-bit UUIDv4, NEVER derived from email/hostname/MAC).
- **First** `/provision` for a never-seen `installId` registers its auth **public
  key** (TOFU) in Durable Object state, keyed by `installId`.
- **Every** call (provision, dns, renew) carries a **JWS** signed by the auth
  private key over `{ installId, op, lanIp, csrHash?, nonce, iat }`. The broker:
  rejects if the `installId` is already bound to a *different* key; rejects stale
  `iat` (replay window, e.g. ±300s) and reused `nonce`; verifies the signature.
  An attacker who harvests an `installId` from CT/DNS has the *name* but not the
  *key* → every state-changing call is rejected.
- TOFU is safe because `installId` is locally-random and unpredictable — an
  attacker cannot pre-register a victim's *future* id. "installId already bound to
  a different key" is a hard, logged failure the install surfaces ("hostname
  already claimed — regenerate").

### Endpoints

**`POST /provision`** (async — issuance is too slow for a synchronous response):
Body `{ installId, lanIp, csr, jws }`. Worker validates (below), then **enqueues
work on a Durable Object keyed by `installId`** and returns
`202 { jobId, status: "pending", retryAfter }`. The DO drives the ACME order via
**alarms** (sleep-and-repoll without holding a request or burning subrequests):
create order → write `_acme-challenge` TXT via Cloudflare API → poll authz → poll
order after finalize-with-CSR → store chain. Idempotent: if a job is already
pending or a valid unexpired cert for this `installId`+CSR exists, return it.

**`GET /provision/:jobId`** — install polls; returns `pending` | `ready
{ certChainPem, notAfter }` | `failed { code }`. Error codes (enumerated, so the
install can branch to fallback): `dns-propagation-timeout`, `rate-limited`,
`caa-blocked`, `invalid-csr`, `not-rfc1918`, `id-claimed`, `acme-error`.

**`POST /dns`** (cheap, A-only, NO ACME — for mid-session LAN-IP changes): Body
`{ installId, lanIp, jws }`. Upserts the A record only; **costs zero LE quota**.
Short TTL (60s). The install calls this immediately on detecting an IP change, so
an IP move doesn't burn an issuance.

### Validation (every call)

1. **JWS / ownership** (above) — first gate.
2. **`installId`** matches `^[a-z0-9-]{N}$` (DNS-safe label); the broker builds the
   FQDN as `‹label›.lan.castwright.ai` and **re-validates the constructed FQDN ends
   in `.lan.castwright.ai`** before any DNS write (treat installId as hostile —
   no dots, no injection; cf. the project's `safe-path` sanitizer discipline).
3. **`lanIp`** — **allow only RFC1918 IPv4** (`10/8`, `172.16/12`, `192.168/16`).
   **Reject** loopback `127/8`, `0.0.0.0`, link-local `169.254/16`, CGNAT
   `100.64/10`, and **all IPv6** (v1). (RFC1918-only is necessary but NOT
   sufficient — see residual risks.)
4. **CSR** — parse; **SAN dNSName set must equal exactly `{‹id›.lan.castwright.ai}`**
   (no extra SANs; CN ignored for validation); **verify the CSR self-signature**
   (proof the requester holds the CSR key); enforce a **min-key allow-list**
   (RSA ≥2048 / P-256+; reject weak/known keys) — fail fast before burning an ACME
   order.

### Issuance budget (fail-closed) — protects the shared LE quota

Let's Encrypt limits are per *registered domain* = **`castwright.ai`** (~50 new
certs/week, 300 new-orders/3h, 5 duplicate/week) — and the subdomain delegation
does **not** give `lan.castwright.ai` its own bucket. So an open issuer is a DoS
lever against issuance for ALL installs (and possibly the website's cert).

- A **global broker budget** (DO/KV counter): **refuse new issuance above ~45 per
  rolling week** (headroom under 50), returning `rate-limited` → install falls back
  to mkcert. **Renewals of already-registered installIds are prioritized over
  first-time registrations** (an established install always renews; a brand-new one
  degrades gracefully at the cap).
- **Per-installId single-flight** (the DO) prevents retry storms from burning the
  5-duplicate/week limit.
- **Confirm the public website's cert does NOT share the LE `castwright.ai`
  bucket** (Cloudflare Universal SSL is not LE-rate-limited the same way); if it
  does, move LAN issuance under a **separate registered domain**.
- **All broker dev/test uses the LE staging environment** — production quota is
  never touched by CI.

### Cleanup / lifecycle

- **TXT cleanup is tied to job completion** (a guaranteed `finally`), not the N-day
  sweep — no stale `_acme-challenge` accumulation. A short-horizon sweep reaps
  orphaned TXT from crashed jobs (minutes).
- A **cron** purges A-records for installIds not refreshed in N days (abandoned
  installs).
- **Renewal cadence:** LE certs are 90 days → install renews at **~day 60**
  (≈ every 8.57 weeks). Steady-state load ≈ N/8.57 certs/week.

### Broker secrets / scope

- Cloudflare DNS API token **scoped to the `lan.castwright.ai` zone ID only**,
  `Zone.DNS:Edit` (no `Zone.Zone:Edit`, no account scope) — a broker bug/compromise
  cannot touch apex/email/website. Acceptance check: verify the token's resource
  scope is exactly that zone.
- ACME account key + DNS token stored as **Cloudflare Secrets** (encrypted env),
  never KV/R2 plaintext or code. Invariant to document: *the ACME account's
  effective authority == the DNS token's scope; never widen the token.*

## Install-side contract (sub-project 2 — summarized so the broker is reviewable)

On `start:lan`: read/generate persistent `installId` + auth keypair + TLS keypair;
build CSR; `POST /provision` (signed); **poll `GET /provision/:jobId`** with backoff
to an overall deadline; on `ready`, write the chain + local key to the existing
`.run/certs/` files. **On LAN-IP change mid-session: call the cheap `POST /dns`**
(no re-issue). Two existing URL-builders — **`export-lan.ts enumerateLanUrls` AND
`pairing.ts`** — switch from the IP literal to `https://‹id›.lan.castwright.ai:8443`
when a public cert is active. **Listener cert hot-reload:** the server currently
reads `LAN_CERT_FILE`/`LAN_KEY_FILE` once at boot and `https.createServer` does NOT
hot-swap — so renewal/fallback needs a **listener reload** (brief drop) that does
not exist today; sub-project 2 must build it. The served app must add **Host-header
anti-rebinding validation** (reject `Host` not matching the expected hostname / LAN
IPs). **Fallback is the default:** broker unreachable / offline / any `failed`
code → keep today's mkcert + manual-install + companion (`225` behavior); never
fatal to `start:lan`.

## Residual risks (documented + accepted, or with a guard)

- **RFC1918-only is necessary, not sufficient.** With ownership-binding in place an
  install can only point *its own* name at an RFC1918 IP — blast radius is the
  install owner attacking their *own* LAN visitors (gateway-pointing phish / DNS
  rebinding with a *valid* cert). Mitigated by: the IP deny-list above, the short
  TTL, and the **sub-project-2 Host-header anti-rebinding** requirement. Accepted
  for the home-LAN threat model; stated, not glossed.
- **CT enumeration:** every installId is permanently public in CT logs (install
  census + its current RFC1918 IP). Accepted — inherent to using a public CA;
  harmless because installId carries nothing sensitive and all security rests on
  the PoP key.
- **Phone-home:** the install contacts the broker at setup + renewal (≤~60 days) +
  on IP change; otherwise fully offline. Bounded cloud dependency, additive to the
  local-first model (offline still works via fallback).
- **LE ~50/week cap** on `castwright.ai`: fine for beta with the fail-closed budget
  + renewal priority; scale needs LE's free rate-limit increase.

## Testing

- Broker is **independently testable** with a synthetic keypair+CSR + test
  installId against **LE staging** — no install needed. Cover: JWS accept/reject
  (wrong key, replay, stale iat), id-claimed, all validation rejects (non-RFC1918,
  IPv6, bad SAN set, bad CSR sig, weak key), async job lifecycle (202 → pending →
  ready/failed), `/dns` A-only (no LE order), budget fail-closed at the cap,
  single-flight idempotency, TXT cleanup on success AND failure.

## Out of scope (this spec)

- Sub-project 2 (install-side) — its own spec + plan once the broker is settled.
- Migrating `castwright.ai` off Porkbun (only the subdomain delegates).
- Wildcard / shared-key certs (rejected: shared private key).
