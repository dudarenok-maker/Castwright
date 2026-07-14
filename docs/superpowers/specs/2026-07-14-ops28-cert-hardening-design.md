# ops-28 — Cert hardening: first-run-wizard cert check + in-place repair

- **Issue:** #1609 (`area:ops`, `moscow:must`, `type:chore`, `feedback`)
- **Date:** 2026-07-14
- **Status:** design approved
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

## Design decisions (locked)

1. **Advisory + soft warning, never a hard readiness blocker.** The cert step
   never gates wizard completion (desktop-only users legitimately never need
   LAN HTTPS). It escalates to a **warning** visual state only when LAN HTTPS
   was actually *requested* yet certs are not healthy. It is **not** added to
   the derived-readiness `blockers` object.
2. **Detection depth = presence + expiry + current-LAN-IP coverage.** No OS
   trust-store probe.
3. **Frontend = shared component reused by both surfaces.** Extract the
   detect+repair UI into a shared `<LanCertStatus>`; the new wizard step and
   the existing Admin `LanAccessCard` both consume it. Admin **gains** the new
   expiry / stale-coverage detection as part of this work.
4. **A dedicated wiki page** for LAN-HTTPS troubleshooting (not the general
   `Mobile-Tablet-and-Companion-App` page), to avoid user confusion.

## Architecture

### Backend — new read-only status endpoint

Add `GET /api/lan/cert/status` to the **existing** `server/src/routes/lan-cert.ts`
(already mounted at `/api/lan`, so it inherits the same-origin guard the
localhost wizard satisfies). Read-only; never spawns, never mutates.

Response body:

```ts
interface LanCertStatus {
  requested: boolean;   // isLanHttpsEnabled() — on-by-default in prod/Pinokio
  active: boolean;      // getLanRuntime().httpsActive — is HTTPS actually bound
  health: 'healthy' | 'missing' | 'expired' | 'stale-coverage';
  certHosts: string[];  // SANs parsed from the cert (empty when missing)
  currentLanIps: string[];
  uncoveredIps: string[]; // current LAN IPs absent from cert SANs → stale-coverage
  expiresAt: string | null; // ISO 8601, or null when missing/unparseable
}
```

Health is computed with precedence **`missing` > `expired` > `stale-coverage` > `healthy`**:

- **missing** — `resolveLanCertPaths(repoRoot)` cert + key files don't both
  exist (`existsSync`). This is the flagged bug's signature.
- **expired** — cert parses via `node:crypto` `X509Certificate` but `validTo`
  is in the past.
- **stale-coverage** — at least one current LAN IPv4 is not present in the
  cert's `subjectAltName` IP entries (`uncoveredIps` non-empty). This is the
  "laptop moved networks" case; the phone then gets a name-mismatch error.
- **healthy** — files present, parses, unexpired, all current LAN IPs covered.

**Consistency principle.** Current-IP enumeration reuses the *same* host logic
that generates the cert, so detection and generation cannot disagree, and
virtual-adapter IPs (Docker/VirtualBox/WSL) cannot produce false `stale-coverage`
flags — whatever IPs the enumerator returns now, the same enumerator produced
the SAN list at generation time. Only a genuine change (new Wi-Fi network)
produces drift.

**Implementation detail deferred to the plan:** how the server obtains the
current-IP list without diverging from `scripts/setup-lan-certs.mjs`. Two
options — (a) extract `enumerateLanIps` / `buildCertHosts` into a shared pure
ESM module imported by both the script and the server; (b) re-derive in a new
`server/src/lan-hosts.ts` with a parity unit test pinning the identical filter
rules (IPv4, non-internal, skip `169.254.*`). **Lean: (a) shared module.**
Final call in writing-plans.

**Repair reuses the existing route verbatim.** `POST /api/lan/cert/regenerate`
(`server/src/routes/lan-cert.ts`) already spawns `setup-lan-certs.mjs` as a
subprocess (90 s timeout, single-in-flight 409 guard) and hot-swaps the running
HTTPS context via `lanHttpsServer.setSecureContext()`. No backend repair work —
the wizard step and Admin card call `api.regenerateLanCert()` unchanged.

### Frontend — shared component + two consumers

Extract from the current `src/components/lan-access-card.tsx` a shared
`src/components/lan-cert-status.tsx`:

- `<LanCertStatus variant="wizard" | "admin">`.
- Fetches `api.getLanCertStatus()` (new) on mount; renders a **health badge** +
  human-readable message per `health` state.
- **Regenerate** button (idle / loading / success / error) calling the existing
  `api.regenerateLanCert()`; on success, re-fetches status and shows the covered
  hosts.
- A `<WikiLink>` to the new troubleshooting page.
- The "Phone shows 'Not secure'?" `<details>` block (moved from `LanAccessCard`).

Consumers:

- **`step-lan-cert.tsx`** (new, `src/components/setup/`) wraps
  `<LanCertStatus variant="wizard">` with wizard chrome, Back/Next (Next
  **never** gated), and the soft-warning banner.
- **`lan-access-card.tsx`** refactors to render `<LanCertStatus variant="admin">`,
  **gaining** expiry + stale-coverage detection it does not have today.

**Soft-warning rule.** The banner (and the step's warning visual state) shows
when `requested && health !== 'healthy'`. In prod/Pinokio, `requested` is true
by default (`isLanHttpsEnabled()` unset → on in production), so the warning
fires exactly for the beta reviewer's audience; in dev (`LAN_HTTPS` off) it
stays a quiet neutral advisory. Edge case: `health === 'healthy' && !active`
(certs fine but HTTPS not bound) renders a mild "restart to apply HTTPS" note,
not a warning.

**Wizard wiring** (`src/components/setup/setup-wizard.tsx`):

- Add `'lanCert'` to the `StepId` union and a `STEPS` entry titled
  **"LAN access"**, positioned **between `defaults` and `finish`**.
- Add the `renderStep()` case.
- Add a summary row in `buildSummaryRows()` so the checklist re-entry flow
  surfaces the cert state too.
- Progress dots / "Step N of M" derive off `STEPS.length` automatically.

### Wiki

Add a dedicated page **`LAN-HTTPS-Troubleshooting`** to the `WikiPage` union in
`src/lib/wiki-links.ts`, with its `docs/wiki/LAN-HTTPS-Troubleshooting.md`
in-repo mirror (the `src/lib/wiki-links.test.ts` guard test asserts every
referenced page has a `docs/wiki/<page>.md` file). Content: per-OS manual
cert-trust + regeneration steps, the `npm run install:cert-mobile` fallback, and
the `/cert/root.crt` CA-download reference. Both the wizard step and the Admin
card link this page (via the shared component). Publishing to the live GitHub
wiki is the usual out-of-repo sync chore.

## Data flow

1. Wizard mounts the LAN-access step → `<LanCertStatus>` calls
   `GET /api/lan/cert/status`.
2. Server resolves cert paths, reads/parses the cert, enumerates current LAN
   IPs, computes `health`, returns the status body.
3. Component renders the badge + message; if `requested && !healthy`, the step
   shows the soft-warning banner.
4. User clicks **Regenerate** → `POST /api/lan/cert/regenerate` (existing
   subprocess spawn + hot-swap) → on success the component re-fetches status,
   which should now report `healthy`.
5. If regeneration fails (e.g. mkcert absent), the error state shows the
   `<WikiLink>` to `LAN-HTTPS-Troubleshooting` for the manual per-OS steps.
6. Next is never gated; the user Finishes regardless.

## Error handling

- **Status endpoint** — never throws to the client for a missing/unparseable
  cert; those are *health states*, not errors. A genuine server fault returns
  500 with a message; the component falls back to an "unable to check" state
  that still offers Regenerate + the wiki link.
- **Regenerate** — reuses the existing route's contract: 409 on an in-flight
  regeneration (component disables the button while loading), 500 with stderr
  on failure (component surfaces the wiki link).
- **Hot-swap best-effort** — regeneration writes new cert files even if the
  running server can't hot-swap; the "restart to apply" note covers the
  `healthy && !active` case.

## Testing

- **Backend** — extend `server/src/routes/lan-cert.test.ts` using its existing
  `__setCertPathsForTest` + `mkdtempSync` temp-dir + `execFile` mock seams.
  Cover each health state: `healthy`, `missing` (no files), `expired` (crafted
  fixture cert), `stale-coverage` (cert whose SANs omit a stubbed current LAN
  IP). Stub `isLanHttpsEnabled()` / `getLanRuntime()` to drive `requested` /
  `active`.
- **Host enumeration** — a parity unit test for the shared host logic (option
  (a)) or the re-derived server helper (option (b)), pinning the IPv4 /
  non-internal / skip-`169.254.*` filter rules.
- **Frontend** — `src/components/lan-cert-status.test.tsx` (renders each health
  state; Regenerate calls `api.regenerateLanCert()` then re-fetches; wiki link
  present in the error state); `src/components/setup/step-lan-cert.test.tsx`
  (soft-warning appears only when `requested && unhealthy`; Next never gated);
  update `src/components/lan-access-card.test.tsx` for the new states.
- **E2E** — one Playwright spec walking the wizard to the LAN-access step and
  asserting render + a mock Regenerate round-trip (the step crosses
  router/redux, so it earns an e2e per the testing-discipline bar). Extend
  `e2e/responsive/coverage.spec.ts` if a new view case is warranted.

## Acceptance criteria (from #1609)

- [ ] Wizard detects missing/invalid LAN certs and surfaces a clear state
      (never silent).
- [ ] In-wizard re-provision succeeds where mkcert is available; the app serves
      HTTPS on next start.
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
| Cert path source of truth | `server/src/app-dirs.ts` (`resolveLanCertPaths`) |
| HTTPS bind + runtime | `server/src/index.ts`, `server/src/lan-runtime.ts`, `server/src/routes/export-lan.ts` (`isLanHttpsEnabled`) |
| API layer | `src/lib/api.ts` (`getLanCertStatus` new, `regenerateLanCert` existing) |
| Shared component (new) | `src/components/lan-cert-status.tsx` |
| Admin consumer | `src/components/lan-access-card.tsx` |
| Wizard | `src/components/setup/setup-wizard.tsx`, `src/components/setup/step-lan-cert.tsx` (new) |
| Wiki | `src/lib/wiki-links.ts`, `docs/wiki/LAN-HTTPS-Troubleshooting.md` (new) |
