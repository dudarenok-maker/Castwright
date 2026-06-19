---
title: LAN public-cert broker (zero-install trusted HTTPS over LAN)
date: 2026-06-19
revision: 3 (folded security + feasibility + coherence passes)
status: draft — adversarial-reviewed (3 passes), ready for user review → plan. NOT implemented.
area: cloud (Castwright-Website / Cloudflare Worker + Durable Object). Install-side is contract-only here (full build = sub-project 2).
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
install's TLS private key is generated locally and **never leaves the install**.
mkcert + manual-install + the companion app remain the **offline fallback** — and
provisioning is **best-effort**: any failure falls back, never blocks `start:lan`.

Two-part project, built broker-first:

- **Sub-project 1 — the broker (THIS spec):** Cloudflare Worker + Durable Object +
  the delegated `lan.castwright.ai` zone. (Implemented in the `Castwright-Website`
  repo.)
- **Sub-project 2 — install-side cert lifecycle (separate spec/plan):** installId/
  keypairs/CSR, async provision + poll, store/serve/renew, A-only re-point on IP
  change, **listener cert hot-reload**, fallback. Contract defined below.

## DNS setup (no email disruption) — with the two issuance landmines defused

`castwright.ai` stays at **Porkbun** (apex, MX/email, www untouched). Only the
subdomain `lan.castwright.ai` is delegated to Cloudflare:

1. Create a **standalone Cloudflare zone literally named `lan.castwright.ai`** (NOT
   a partial/CNAME setup, NOT records inside the `castwright.ai` zone). Cloudflare
   assigns nameservers.
2. At Porkbun, add **NS records for the `lan` label** → those Cloudflare
   nameservers. (Surgical; cannot touch apex/email.)
3. **CAA (MANDATORY, a setup prerequisite — not a runtime broker action):** publish
   `lan.castwright.ai CAA 0 issue "letsencrypt.org"` and `0 issuewild ";"` in the
   Cloudflare zone. CAA checks walk UP the tree and stop at the first level with a
   record — so this **shields the subdomain from any future apex CAA added at
   Porkbun**, which would otherwise silently break ALL issuance. Optionally pin
   `accounturi` to the broker's ACME account. Runbook note at Porkbun: "never
   delete the `lan` CAA."
4. **DNSSEC:** if `castwright.ai` has DNSSEC enabled at Porkbun, the `lan`
   delegation must be left **insecure** (no DS record at the parent for `lan`)
   unless a verified DS chain is established — otherwise validating resolvers
   (incl. Let's Encrypt's) SERVFAIL the `_acme-challenge` TXT → every issuance
   fails. **Pre-flight:** `dig +dnssec` the TXT from a validating resolver before
   declaring the zone ready.

The broker is hosted on a name that does **NOT depend on the delegated zone
resolving** (e.g. a `*.workers.dev` route, or a Worker route on the `castwright.ai`
apex zone at Porkbun) so broker availability is independent of the delegation it
manages.

**LE-bucket isolation (RESOLVED, was an open item):** the public website is on
**Cloudflare Pages**, whose TLS is **Cloudflare-managed Universal SSL** (issued/
renewed by Cloudflare via Google Trust Services / its own ACME, NOT against the
project's own Let's Encrypt registered-domain quota). So broker issuance under
`lan.castwright.ai` and the website's cert do **not** share an LE bucket — the
website cannot be starved by broker traffic. *Pre-implementation verification gate:
confirm the live Pages cert issuer is Cloudflare-managed before sub-project 1
ships; if it is ever switched to a self-run LE cert on `castwright.ai`, move LAN
issuance to a separate registered domain.*

## Sub-project 1 — the broker (Cloudflare Worker + Durable Object)

### Ownership binding (the security crux)

`installId` is **guaranteed public**: it is the DNS label, it is in the pairing QR,
and **every issued cert publishes it forever in Certificate Transparency logs**
(`crt.sh?q=%.lan.castwright.ai`). Therefore **security MUST NOT rest on installId
secrecy.** Every state-changing call is gated by **proof-of-possession of a
per-install auth key** (distinct from the TLS cert key):

- On `start:lan`, the install generates a long-lived **auth keypair** (separate
  from the TLS cert keypair) and a high-entropy random `installId` — a lowercased
  **UUIDv4** (≥122 bits), NEVER derived from email/hostname/MAC.
- Every request carries a **JWS** signed by the **auth private key** over the
  payload `{ installId, op, lanIp, csrHash?, nonce, iat }`, with the **auth public
  key in the JWS protected header (`jwk`)**.
  - `op` is exactly `"provision"` or `"dns"` (there is no `/renew` endpoint —
    renewal is a `/provision` call; see Renewal below).
  - `csrHash` is **REQUIRED when `op="provision"`** (SHA-256 of the DER CSR, binding
    the signature to the exact CSR the broker will finalize) and **MUST be absent
    when `op="dns"`**. The broker recomputes `csrHash` from the received CSR and
    rejects a mismatch.
- **First-seen `installId` (TOFU):** the broker verifies the JWS against the `jwk`
  in the request header, then **stores that public key** in Durable Object state
  keyed by `installId`.
- **Subsequent calls:** the broker verifies the JWS against the **stored** key and
  **rejects** any request whose header `jwk` differs from the stored key
  (`id-claimed`). It also rejects stale `iat` (replay window ±300s) and reused
  `nonce`.
- TOFU is safe because `installId` is locally-random and unpredictable — an
  attacker cannot pre-register a victim's *future* id. An attacker who harvests an
  `installId` from CT/DNS has the *name* but not the *key* → every state-changing
  call is rejected. `/dns` for an `installId` with no stored key is rejected
  (`unauthorized`) — a `/provision` must establish the binding first.

### Endpoints

**`POST /provision`** — async (ACME is too slow for a synchronous response).
Body `{ installId, lanIp, csr, jws }` (the auth pubkey rides in the JWS header).
The Worker runs **synchronous validation** (below); on success it **enqueues work
on a Durable Object keyed by `installId`** and returns `202 { jobId, status:
"pending", retryAfter }`, where **`retryAfter` is the integer seconds the install
should wait before its first poll**. The DO job, driven by **alarms** (sleep-and-
repoll without holding a request or burning subrequests):

1. **Upsert the A record** `‹id›.lan.castwright.ai → lanIp` (short TTL, 60s).
2. Create the ACME order; write `_acme-challenge.‹id›.lan.castwright.ai` TXT.
3. Poll authz; finalize with the install's **CSR**; poll order; **store the chain**.
4. **Guaranteed TXT cleanup** in a `finally` (success or failure).

**Idempotency / single-flight:** at most one in-flight job per `installId`. A
`POST /provision` while a job for that `installId` is already pending returns the
**existing** `jobId` — the in-flight CSR wins; the caller treats the returned
`jobId` as authoritative and does not assume it reflects a just-submitted CSR. If a
**valid, unexpired cert for this exact `installId`+CSR** already exists, the broker
returns it and **consumes zero budget** (a re-submitted identical CSR).

**`GET /provision/:jobId`** — install polls; returns `pending` | `ready
{ certChainPem, notAfter }` | `failed { code }`.

**`POST /dns`** — cheap, **A-only, no ACME, no budget** (for mid-session LAN-IP
changes). Body `{ installId, lanIp, jws }` (`op:"dns"`, no `csrHash`). Upserts the A
record only, short TTL (60s). Synchronous `200`/`4xx` (no job). The install calls
this immediately on detecting an IP change, so an IP move never burns an issuance.

### Error codes (split by where they surface)

- **Synchronous — returned as a `4xx` on `POST /provision` / `POST /dns`** (before
  any job/jobId exists), because the validation runs before enqueue:
  `jws-invalid` (bad/replayed/stale-iat signature or `op` mismatch), `unauthorized`
  (`/dns` for an unbound installId), `id-claimed` (jwk ≠ stored key),
  `not-rfc1918`, `invalid-csr` (bad SAN set / bad self-signature / weak key /
  `csrHash` mismatch), `rate-limited` (budget cap hit at admission).
- **Asynchronous — returned via `GET /provision/:jobId` as `failed { code }`:**
  `dns-propagation-timeout`, `caa-blocked`, `acme-error` (catch-all for ACME/DNS
  API failures).

The install branches on both classes to decide fallback (any code → fall back to
mkcert; `rate-limited`/timeout may retry later).

### Synchronous validation (every call, before enqueue)

1. **JWS / ownership** (above) — first gate → `jws-invalid` / `id-claimed` /
   `unauthorized`.
2. **`installId`** is a lowercased UUIDv4
   (`^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`, ≤63-char
   DNS-label bound satisfied). The broker builds the FQDN `‹id›.lan.castwright.ai`
   and **re-validates the constructed FQDN ends in `.lan.castwright.ai`** before any
   DNS write (treat installId as hostile — no injection; cf. `safe-path`
   discipline).
3. **`lanIp`** — **allow only RFC1918 IPv4** (`10/8`, `172.16/12`, `192.168/16`).
   **Reject** loopback `127/8`, `0.0.0.0`, link-local `169.254/16`, CGNAT
   `100.64/10`, and **all IPv6** (v1) → `not-rfc1918`.
4. **CSR** (when `op="provision"`) — parse; **SAN dNSName set must equal exactly
   `{‹id›.lan.castwright.ai}`** (no extra SANs; CN ignored); **verify the CSR
   self-signature**; enforce a **min-key allow-list** (RSA ≥2048 / P-256+; reject
   weak/known keys); **`csrHash` must match** the recomputed hash → else
   `invalid-csr`.

### Issuance budget (fail-closed) — protects the shared LE quota

LE limits are per *registered domain* = **`castwright.ai`** (~50 new certs/week,
300 new-orders/3h, 5 duplicate/week); the subdomain delegation does NOT give
`lan.castwright.ai` its own bucket. An open issuer is a DoS lever.

- **Renewal vs first-registration is decided by DO state:** a request whose
  `installId` is **already key-bound** is a **renewal**; otherwise a
  **first-registration**. Both issue and therefore both consume budget (a renewal
  uses a *new* CSR/validity window, so it does NOT hit the zero-budget idempotency
  short-circuit).
- A **global broker budget** (DO/KV counter) refuses **first-registrations** once
  the rolling-week new-cert count reaches **~45** (headroom under 50), returning
  `rate-limited`. **Renewals are still admitted above that line** (the reserved
  headroom is for them) so an established install always renews; only brand-new
  installs degrade to mkcert at the cap.
- **Per-installId single-flight** (the DO) prevents retry storms from burning the
  5-duplicate/week limit.
- **All broker dev/test uses the LE staging environment** — production quota is
  never touched by CI.

### Cleanup / lifecycle

- **TXT cleanup** is tied to **job completion** (guaranteed `finally`), not the
  N-day sweep. An **orphan-TXT sweep (every 10 min)** reaps `_acme-challenge` TXT
  left by crashed jobs.
- **Renewal cadence:** LE certs are 90 days → the install renews at **~day 60**
  (≈ every 8.57 weeks) via `POST /provision`, which re-asserts the A record
  (step 1) — so a live install's A record is refreshed at least every ~60 days.
- **Cron A-record purge:** delete A records for installIds not refreshed in
  **90 days** (must exceed the ~60-day renewal cadence so a live, stable-IP install
  is never purged). Abandoned installs age out.

### Broker secrets / scope

- Cloudflare DNS API token **scoped to the `lan.castwright.ai` zone ID only**,
  `Zone.DNS:Edit` (no `Zone.Zone:Edit`, no account scope) — a broker bug/compromise
  cannot touch apex/email/website. Acceptance check: verify the token's resource
  scope is exactly that zone.
- ACME account key + DNS token stored as **Cloudflare Secrets** (encrypted env),
  never KV/R2 plaintext or code. Invariant: *the ACME account's effective authority
  == the DNS token's scope; never widen the token.*

## Install-side contract (sub-project 2 — summarized so the broker is reviewable)

On `start:lan`: read/generate persistent `installId` (UUIDv4) + **auth keypair** +
**TLS keypair**; build CSR; sign a JWS (`op:"provision"`, `csrHash`, the auth pubkey
in the header); `POST /provision`; **poll `GET /provision/:jobId`** starting after
`retryAfter`, backing off to an **overall deadline of 120s**; on `ready`, write the
chain + the local TLS key to the existing `.run/certs/` files. **On LAN-IP change
mid-session: call the cheap `POST /dns`** (`op:"dns"`, no re-issue). Two existing
URL-builders — **`export-lan.ts enumerateLanUrls` AND `pairing.ts`** — switch from
the IP literal to `https://‹id›.lan.castwright.ai:8443` when a public cert is active
(forward dependency of sub-project 2). **Listener cert hot-reload:** the server
currently reads `LAN_CERT_FILE`/`LAN_KEY_FILE` once at boot and
`https.createServer` does NOT hot-swap — so renewal/fallback needs a **listener
reload** (brief drop) that does not exist today; sub-project 2 builds it. The served
app must add **Host-header anti-rebinding validation** (reject `Host` not matching
the expected hostname / LAN IPs). **Fallback is the default:** broker unreachable /
offline / any error code → keep today's mkcert + manual-install + companion (`225`
behavior); never fatal to `start:lan`.

## Residual risks (documented + accepted, or with a guard)

- **RFC1918-only is necessary, not sufficient.** With ownership-binding in place an
  install can only point *its own* name at an RFC1918 IP — blast radius is the
  install owner attacking their *own* LAN visitors (gateway-pointing phish / DNS
  rebinding with a *valid* cert). Mitigated by the IP deny-list, the 60s TTL, and
  the **sub-project-2 Host-header anti-rebinding** requirement. Accepted for the
  home-LAN threat model; stated, not glossed.
- **CT enumeration:** every installId is permanently public in CT logs (install
  census + its current RFC1918 IP). Accepted — inherent to using a public CA;
  harmless because installId carries nothing sensitive and all security rests on the
  PoP key.
- **Phone-home:** the install contacts the broker at setup + renewal (≤~60 days) +
  on IP change; otherwise fully offline. Bounded, additive to the local-first model.
- **LE ~50/week cap** on `castwright.ai`: fine for beta with the fail-closed budget
  + renewal priority; scale needs LE's free rate-limit increase.

## Testing

Broker is **independently testable** with a synthetic auth-keypair + cert-keypair +
CSR + test installId against **LE staging** — no install needed. Cover: JWS
accept/reject (wrong key, replay, stale `iat`, `op` mismatch, `csrHash` mismatch);
TOFU first-call (jwk stored) then `id-claimed` on a different key; `unauthorized`
`/dns` for an unbound id; validation rejects (non-RFC1918, IPv6, bad SAN set, bad
CSR sig, weak key); async lifecycle (`202`+`retryAfter` → `pending` → `ready`/
`failed`) incl. the 120s-deadline path; `/dns` A-only (no LE order); A-record
written on first `/provision`; budget fail-closed (first-reg refused at cap,
renewal admitted); single-flight collision (second POST returns existing jobId);
TXT cleanup on success AND failure.

## Out of scope (this spec)

- Sub-project 2 (install-side) — its own spec + plan once the broker is settled.
- Migrating `castwright.ai` off Porkbun (only the subdomain delegates).
- Wildcard / shared-key certs (rejected: shared private key).
