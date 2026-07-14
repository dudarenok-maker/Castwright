# ops-28 — Cert hardening: first-run-wizard cert check + in-place repair

- **Issue:** #1609 (`area:ops`, `moscow:must`, `type:chore`, `feedback`)
- **Date:** 2026-07-14
- **Status:** design approved (revised after adversarial assumption-check)
- **Related (not duplicates):** ops-26 / #1333 (larger LAN cert-broker), fe-1 / #401 (phone-side cert banner)

## Problem

LAN-HTTPS certs are provisioned best-effort at install time
(`pinokio-scripts/install.js` → `scripts/setup-lan-certs.mjs --best-effort`,
non-fatal). If the `mkcert -install` OS-trust-store step is dismissed, or
mkcert is unavailable, `setupLanCerts()` returns `null`, no cert files are
written, and the server (`server/src/index.ts`) sees `certsPresent === false`
and **silently degrades to loopback HTTP**. Phone/tablet pairing quietly stays
off with nothing surfaced to the user. A beta reviewer (Pinokio launcher
review, 2026-07-14) flagged this exact silent point of failure.

## Goal

Make the cert state **visible and self-healing** from the fs-21 first-run
wizard, without changing install-time provisioning (belt stays; this is the
suspenders). Detect cert health, offer in-place repair, and link a focused
troubleshooting page when repair still fails.

## Non-goals (out of scope)

- OS trust-store membership verification (platform-specific, no reliable
  `mkcert` query — deliberately excluded).
- The larger ops-26 LAN cert-broker streamlining (#1333).
- The fe-1 phone-side in-app cert banner (#401) — a different surface.
- Any change to install-time provisioning or the `setup-lan-certs.mjs`
  generation path itself.
- Reconciling the pre-existing third copy of the LAN-IP filter in
  `server/src/routes/export-lan.ts` (`enumerateLanUrls`) — noted, not in scope.

## Design decisions (locked)

1. **Advisory + soft warning, never a hard readiness blocker.** The cert step
   never gates wizard completion (desktop-only users legitimately never need
   LAN HTTPS). It escalates to a **warning** visual state only when LAN HTTPS
   was *requested* yet the cert is in a **deterministically broken** state
   (`missing` or `expired`). It is **not** added to the derived-readiness
   `blockers` object.
2. **Detection depth = presence + expiry drive health; IP-coverage is
   informational-only.** The `health` field is one of `healthy | missing |
   expired`. Current-LAN-IP coverage is reported as data (`uncoveredIps`) and
   shown as a neutral hint with a "regenerate to include this network"
   affordance, but it does **not** set `health` and does **not** trigger the
   warning. Rationale in §"Why IP-coverage is informational". No OS trust-store
   probe.
3. **Frontend = shared component reused by both surfaces.** Extract the
   detect+repair UI into a shared `<LanCertStatus>`; the new wizard step and
   the existing Admin `LanAccessCard` both consume it. Admin **gains** the new
   expiry detection + coverage hint as part of this work.
4. **A dedicated wiki page** for LAN-HTTPS troubleshooting (not the general
   `Mobile-Tablet-and-Companion-App` page), to avoid user confusion.

## Architecture

### Backend — new read-only status endpoint

Add `GET /api/lan/cert/status` to the **existing** `server/src/routes/lan-cert.ts`
(mounted at `/api/lan`). Read-only; never spawns, never mutates.

**Auth reachability (verified).** A same-origin localhost GET reaches the
handler because (a) `requireSameOrigin` only gates *mutating* methods — a `GET`
falls straight through — and (b) `requireLanToken` is **bypassed for loopback**
requests. So the wizard (served from localhost) needs no token. A phone-over-LAN
GET would also pass (still non-mutating); acceptable, the payload is
non-sensitive.

Response body:

```ts
interface LanCertStatus {
  requested: boolean;   // isLanHttpsEnabled() — on-by-default in prod/Pinokio
  active: boolean;      // getLanRuntime().httpsActive — is HTTPS actually bound
  health: 'healthy' | 'missing' | 'expired';
  certHosts: string[];  // SANs parsed from the cert (empty when missing)
  currentLanIps: string[];
  uncoveredIps: string[]; // current LAN IPs absent from cert SANs — INFORMATIONAL only
  expiresAt: string | null; // ISO 8601, or null when missing/unparseable
}
```

Health is computed with precedence **`missing` > `expired` > `healthy`**:

- **missing** — `resolveLanCertPaths(repoRoot)` cert + key files don't both
  exist (`existsSync`). This is the flagged bug's signature.
- **expired** — cert parses via `node:crypto` `X509Certificate` but `validTo`
  is in the past.
- **healthy** — files present, parses, unexpired.

`uncoveredIps` is computed independently of `health`: parse the cert's IP SANs,
diff against the current LAN IPs, and report the difference — but a non-empty
`uncoveredIps` never makes the cert "unhealthy".

**SAN parsing note (non-trivial, for the plan).** `X509Certificate.subjectAltName`
is a **single comma-joined string** (e.g. `"DNS:localhost, IP Address:127.0.0.1,
IP Address:192.168.1.42"`), not an array. The parser must split on `, `, keep
only `IP Address:`-prefixed entries (stripping the prefix), and ignore `DNS:`
entries (`localhost`, `castwright.local`, `castwright.dev.local`). Node may
quote SAN values containing special chars — inert for mkcert's plain IPs, but
the parser shouldn't assume raw.

### Why IP-coverage is informational (not a warning)

The cert is generated **once at install time**; the status check runs later,
against whatever network state exists then. `enumerateLanIps()`
(`setup-lan-certs.mjs`) filters only internal / non-IPv4 / `169.254.*` — it has
**no RFC1918 or virtual-adapter filter**, so it returns *any* non-internal
IPv4: Docker Desktop, WSL2 `vEthernet`, VirtualBox host-only, VPN/WireGuard/
Tailscale (`100.x`). Those adapters toggle up/down independently of when the
cert was minted, so an adapter that was **down at generation but up at detection**
yields an IP absent from the SAN — a *false* "stale" signal indistinguishable
from a genuine Wi-Fi change. Using coverage to drive a warning would cry wolf on
exactly the developer/power-user boxes and train users to ignore it. Therefore
coverage is surfaced as a neutral, actionable hint only ("this cert doesn't list
`<ip>` — regenerate to include your current network"), and the user decides.

### Host enumeration (option b — chosen)

The status handler needs the current LAN IPs. Re-derive them in a **new
`server/src/lan-hosts.ts`** (~15 lines over `os.networkInterfaces()`: IPv4,
non-internal, skip `169.254.*`) rather than importing the `.mjs`. Reasoning:
the existing regenerate route deliberately parses hosts from subprocess stdout
(`parseHostsFromOutput`) specifically to **avoid a scripts↔server import
boundary**, and static-importing a sibling `.mjs` with no `.d.mts` from
`server/src` fights the TS build. A **parity unit test** pins the filter rules
identical to `setup-lan-certs.mjs`'s `enumerateLanIps`. (`export-lan.ts` holds a
third copy of the same filter; left as-is per non-goals, but noted so a future
sweep can consolidate.)

### Repair reuses the existing route verbatim

`POST /api/lan/cert/regenerate` (`server/src/routes/lan-cert.ts`) already spawns
`setup-lan-certs.mjs` as a subprocess (90 s timeout, single-in-flight 409
guard) and best-effort hot-swaps the running HTTPS context via
`lanHttpsServer.setSecureContext()`. No backend repair work — the wizard step
and Admin card call `api.regenerateLanCert()` unchanged.

**Post-repair reality for the flagged bug (important).** On a box that booted
cert-less (the exact flagged scenario), the server bound plain HTTP and **no
`lanHttpsServer` exists**, so the hot-swap is a no-op. After a successful
in-wizard regenerate, `health` flips to `healthy` but `active` stays `false`
**until the app is restarted** (the bound protocol is fixed for the process
lifetime). This is the *expected* outcome for the flagged path, not an edge
case: the UI must show a clear "restart to apply HTTPS" instruction whenever
`health === 'healthy' && !active`.

### Frontend — shared component + two consumers

Extract from the current `src/components/lan-access-card.tsx` a shared
`src/components/lan-cert-status.tsx`:

- `<LanCertStatus variant="wizard" | "admin">`.
- Fetches `api.getLanCertStatus()` (new) on mount; renders a **health badge** +
  human-readable message per `health` state, plus the coverage hint when
  `uncoveredIps` is non-empty, plus the "restart to apply" note when
  `healthy && !active`.
- **Regenerate** button (idle / loading / success / error) calling the existing
  `api.regenerateLanCert()`; on success, re-fetches status.
- A `<WikiLink>` to the new troubleshooting page (always available; prominent in
  the error state).
- The "Phone shows 'Not secure'?" `<details>` block (moved from `LanAccessCard`).

Consumers:

- **`step-lan-cert.tsx`** (new, `src/components/setup/`) wraps
  `<LanCertStatus variant="wizard">` with wizard chrome, Back/Next (Next
  **never** gated), and the soft-warning banner.
- **`lan-access-card.tsx`** refactors to render `<LanCertStatus variant="admin">`,
  **gaining** expiry detection + the coverage hint it does not have today.

**Soft-warning rule.** The banner (and the step's warning visual state) shows
when `requested && (health === 'missing' || health === 'expired')`. Copy is
framed as non-naggy with an explicit out — e.g. *"Phone/tablet pairing is
currently off (HTTPS certificate not set up). Set it up now, or skip if you only
use Castwright on this computer."* In prod/Pinokio `requested` is on by default,
so this surfaces the silent degradation for the reviewer's audience; in dev
(`LAN_HTTPS` off) it stays a quiet neutral advisory. `healthy && !active`
renders the "restart to apply" note, not a warning. Coverage hints never
escalate to the warning.

**Wizard wiring** (`src/components/setup/setup-wizard.tsx`):

- Add `'lanCert'` to the `StepId` union and a `STEPS` entry titled
  **"LAN access"**, positioned **between `defaults` and `finish`** (index 4).
- Add the `renderStep()` case.
- Add a **navigational** summary row for the checklist re-entry board. Because
  `buildSummaryRows()` is a pure sync function off `readiness.blockers` (and
  cert is deliberately *not* in `blockers`), the row does **not** show live
  health — it is a neutral "LAN access — review" row that drills into the step,
  where the live `<LanCertStatus>` fetch runs. `buildSummaryRows` stays pure;
  verify no existing row's hardcoded `stepIndex` references `finish` (the new
  step inserts before it).
- Update the wizard's "Step N of 5" / "five step components" docstring/prose to
  6 (dots/counter already derive off `STEPS.length`).

### Wiki

Add a dedicated page **`LAN-HTTPS-Troubleshooting`** to the `WikiPage` union in
`src/lib/wiki-links.ts`, with its `docs/wiki/LAN-HTTPS-Troubleshooting.md`
in-repo mirror (the `src/lib/wiki-links.test.ts` guard test asserts every
referenced page has a `docs/wiki/<page>.md` file). Content: per-OS manual
cert-trust + regeneration steps, the `npm run install:cert-mobile` fallback, the
`/cert/root.crt` CA-download reference, and the "regenerate + restart" note.
Both the wizard step and the Admin card link this page (via the shared
component). Publishing to the live GitHub wiki is the usual out-of-repo sync
chore.

## Data flow

1. Wizard mounts the LAN-access step → `<LanCertStatus>` calls
   `GET /api/lan/cert/status`.
2. Server resolves cert paths, reads/parses the cert, enumerates current LAN
   IPs, computes `health` (presence + expiry) and `uncoveredIps` (informational),
   returns the status body.
3. Component renders the badge + message; if `requested && health ∈ {missing,
   expired}`, the step shows the soft-warning banner; a coverage hint shows if
   `uncoveredIps` is non-empty.
4. User clicks **Regenerate** → `POST /api/lan/cert/regenerate` → on success the
   component re-fetches status. `health` should now be `healthy`. **On the
   flagged cert-less-boot path, `active` stays `false` → the component shows
   "restart to apply HTTPS".** On a box that already had HTTPS bound, the
   hot-swap makes it live immediately.
5. If regeneration fails (e.g. mkcert absent), the error state surfaces the
   `<WikiLink>` to `LAN-HTTPS-Troubleshooting` for the manual per-OS steps.
6. Next is never gated; the user Finishes regardless.

## Error handling

- **Status endpoint** — never throws to the client for a missing/unparseable
  cert; those are *health states* (`missing`, or `expired`/parse-fail → treat
  unparseable as `missing`), not errors. A genuine server fault returns 500 with
  a message; the component falls back to an "unable to check" state that still
  offers Regenerate + the wiki link.
- **Regenerate** — reuses the existing route's contract: 409 on an in-flight
  regeneration (component disables the button while loading), 500 with stderr on
  failure (component surfaces the wiki link).
- **Hot-swap best-effort** — regeneration writes new cert files even when the
  running server can't hot-swap; the `healthy && !active` "restart to apply"
  note covers that (the common case for the flagged bug).

## Testing

- **Backend** — extend `server/src/routes/lan-cert.test.ts` using its existing
  `__setCertPathsForTest` + `mkdtempSync` temp-dir + `execFile` mock seams.
  Cover each health state: `healthy`, `missing` (no files), `expired`, plus an
  informational `uncoveredIps` case. **Fixture dependency (unstated new work):**
  `X509Certificate` throws on the harness's current `'FAKE-CERT'` string, so
  `healthy`/`expired`/coverage cases need **committed openssl-minted PEM
  fixtures**. The `healthy`/coverage fixtures must use **~100-year validity** to
  avoid future-dating flakes; the `expired` fixture is a real already-expired
  PEM. Stub the LAN-IP enumerator (via the mockable `server/src/lan-hosts.ts`
  import) to drive `uncoveredIps`. Stub `isLanHttpsEnabled()` / `getLanRuntime()`
  to drive `requested` / `active`.
- **Host enumeration** — parity unit test for `server/src/lan-hosts.ts` pinning
  the IPv4 / non-internal / skip-`169.254.*` filter rules against
  `setup-lan-certs.mjs`'s behavior.
- **Frontend** — `src/components/lan-cert-status.test.tsx` (renders each health
  state; the `healthy && !active` restart note; the coverage hint; Regenerate
  calls `api.regenerateLanCert()` then re-fetches; wiki link present in the
  error state); `src/components/setup/step-lan-cert.test.tsx` (soft-warning
  appears only when `requested && health ∈ {missing, expired}`, never on a
  coverage hint; Next never gated); update
  `src/components/lan-access-card.test.tsx` for the new states.
- **E2E** — one Playwright spec walking the wizard to the LAN-access step and
  asserting render + a mock Regenerate round-trip (the step crosses
  router/redux, so it earns an e2e per the testing-discipline bar).

## Acceptance criteria (from #1609)

- [ ] Wizard detects missing/invalid LAN certs and surfaces a clear state
      (never silent).
- [ ] In-wizard re-provision succeeds where mkcert is available; the app serves
      HTTPS on next start (restart expected on the cert-less-boot path).
- [ ] Re-provision failure links the (new, dedicated) wiki troubleshooting page.
- [ ] Detect + repair path is covered by tests.

## Ship artifacts

- Regression plan under `docs/features/` (new file from `TEMPLATE.md`, or a
  section of the 1.14 startup-wizard batch plan — confirmed in writing-plans).
- Entries in **both** release-notes docs (`docs/release-notes-next.md` +
  `RELEASE_NOTES.md`): the wizard gains a LAN-access step; degraded HTTPS is now
  surfaced and self-healing.
- `docs/features/INDEX.md` entry if a standalone plan is created.
- PR body: `Closes #1609`.

## Key files

| Area | File |
|---|---|
| Cert generator (untouched) | `scripts/setup-lan-certs.mjs` |
| Status + repair routes | `server/src/routes/lan-cert.ts` (+ `.test.ts`) |
| LAN-IP enumeration (new) | `server/src/lan-hosts.ts` (+ parity test) |
| Cert path source of truth | `server/src/app-dirs.ts` (`resolveLanCertPaths`) |
| HTTPS bind + runtime | `server/src/index.ts`, `server/src/lan-runtime.ts`, `server/src/routes/export-lan.ts` (`isLanHttpsEnabled`) |
| API layer | `src/lib/api.ts` (`getLanCertStatus` new, `regenerateLanCert` existing) |
| Shared component (new) | `src/components/lan-cert-status.tsx` |
| Admin consumer | `src/components/lan-access-card.tsx` |
| Wizard | `src/components/setup/setup-wizard.tsx`, `src/components/setup/step-lan-cert.tsx` (new) |
| Wiki | `src/lib/wiki-links.ts`, `docs/wiki/LAN-HTTPS-Troubleshooting.md` (new) |
