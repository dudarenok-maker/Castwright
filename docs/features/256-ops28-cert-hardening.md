---
status: active
shipped: null
owner: null
---

# ops-28 — LAN cert hardening in the first-run wizard

> Status: active — implementation landing on `feat/ops-28-cert-hardening`.
> Key files: `server/src/lan-hosts.ts`, `server/src/lan-cert-health.ts`,
> `server/src/routes/lan-cert.ts`, `src/lib/api.ts` (`getLanCertStatus`),
> `src/components/lan-cert-status.tsx`, `src/components/lan-access-card.tsx`,
> `src/components/setup/step-lan-cert.tsx`, `src/components/setup/setup-wizard.tsx`,
> `src/lib/wiki-links.ts`, `docs/wiki/LAN-HTTPS-Troubleshooting.md`.
> URL surface: `#/setup` (guided-mode `lanCert` step, and the checklist board's
> navigational LAN-access row), `#/admin` (LAN-access card).
> OpenAPI ops: `GET /api/lan/cert/status` (new, read-only); `POST
> /api/lan/cert/regenerate` (existing, reused unchanged).

## Benefit / Rationale

- **User:** a dismissed `mkcert -install` prompt (or an unavailable mkcert) used
  to leave phone/tablet pairing silently off — the app just serves loopback
  HTTP with nothing surfaced. The wizard and Admin now show that state plainly
  and let the user repair it in one click, instead of a beta reviewer having to
  read server logs to discover the degradation.
- **Technical:** a single new read-only status endpoint
  (`GET /api/lan/cert/status`) composes presence + expiry (via pure,
  exhaustively-unit-tested `computeCertHealth`) with informational IP-coverage,
  reusing the existing `POST /api/lan/cert/regenerate` repair route verbatim —
  no new mutation surface.
- **Architectural:** extracts a shared `<LanCertStatus>` component so the wizard
  step and the Admin `LanAccessCard` render one detect+repair UI instead of two
  divergent copies; Admin gains expiry detection it didn't previously have.

## Architectural impact

- **New seams:** `server/src/lan-hosts.ts` (`enumerateLanIps`) and
  `server/src/lan-cert-health.ts` (`parseCertIps`, `computeCertHealth`) are new
  pure, filesystem-free/side-effect-free leaves consumed only by
  `routes/lan-cert.ts`. Frontend gains `api.getLanCertStatus()` and the shared
  `src/components/lan-cert-status.tsx` (`LanCertStatus` component +
  `isCertWarning` helper).
- **Invariants preserved:** the cert check is advisory only — it never touches
  `server/src/routes/setup-readiness.ts`, the `blockers` object, or
  `BlockerActionKind`; `buildSummaryRows()` in `setup-wizard.tsx` stays a pure
  sync function keyed off `readiness.blockers`, so the new wizard step's
  checklist row is a static "review" row, not a live-health row. IP-coverage
  (`uncoveredIps`) is reported but never feeds `health` or the warning banner —
  see "Why IP-coverage is informational" in the design spec.
- **Migration story:** none — no state.json/cast.json/openapi.yaml shape
  change. `LanCertStatus` is a new response shape, not a stored one.
- **Reversibility:** the new step/route/component can be reverted independently
  of `POST /api/lan/cert/regenerate`, which is untouched. Removing the wizard
  step is a one-line `STEPS`/`renderStep`/`buildSummaryRows` revert.

## Invariants to preserve

1. **Advisory, never gating.** `StepLanCert` (`src/components/setup/step-lan-cert.tsx`)
   never disables Next/Finish; the cert step's `key: 'lanCert'` row in
   `buildSummaryRows()` (`setup-wizard.tsx`) always has `status: 'ok'` — the
   step is a navigational entry, not a blocker-derived one.
2. **IP-coverage never triggers the warning.** `isCertWarning(s)`
   (`src/components/lan-cert-status.tsx`) is `s.requested && (s.health ===
   'missing' || s.health === 'expired')` — `uncoveredIps` is not read. A
   non-empty `uncoveredIps` renders only the neutral `lan-cert-coverage-hint`.
3. **`healthy && !active` ⇒ restart note.** `LanCertStatus`
   (`src/components/lan-cert-status.tsx`, `restartNeeded` const) renders
   `data-testid="lan-cert-restart-note"` whenever `status.health === 'healthy'
   && !status.active` — the expected outcome right after an in-wizard repair on
   a box that booted cert-less (no `lanHttpsServer` to hot-swap).
4. **Cert health precedence.** `computeCertHealth`
   (`server/src/lan-cert-health.ts`) resolves `missing > expired > healthy`:
   missing cert/key file or an unparseable cert ⇒ `missing`; parseable but
   `notAfter <= now` ⇒ `expired`; otherwise `healthy`.
5. **Cert is not a readiness blocker.** `server/src/routes/setup-readiness.ts`
   is untouched by this plan — no `blockers` key for LAN cert exists.

## Test plan

### Automated coverage

- Vitest server (`server/src/lan-hosts.test.ts`) — `enumerateLanIps` keeps
  non-internal IPv4, drops loopback/IPv6/`169.254.*`; returns `[]` with no
  external interfaces.
- Vitest server (`server/src/lan-cert-health.test.ts`) — `parseCertIps` extracts
  `IP Address:` SAN entries from the comma-joined string, ignores `DNS:`;
  `computeCertHealth` exhaustively covers missing (no cert/no key/unparseable),
  expired, healthy, and the coverage-hint-without-affecting-health case.
- Vitest server (`server/src/routes/lan-cert.test.ts`) — `GET
  /api/lan/cert/status`: missing (no files), missing (unparseable), healthy
  (real fixture PEM, reports `certHosts`/`uncoveredIps`/`expiresAt`), and the
  `requested`/`active` flags reflect env + `lan-runtime`.
- Vitest frontend (`src/components/lan-cert-status.test.tsx`) — restart note
  when `healthy && !active`; coverage hint when `uncoveredIps` non-empty;
  Regenerate calls `api.regenerateLanCert()` then re-fetches status; wiki
  troubleshooting link shown on regenerate error.
- Vitest frontend (`src/components/setup/step-lan-cert.test.tsx`) — warning
  banner shows only when `requested && health` is `missing`/`expired`; no
  banner when healthy (even with a coverage hint); no banner when not
  `requested` even if `missing`.
- Vitest frontend (`src/components/lan-access-card.test.tsx`) — updated to mock
  `api.getLanCertStatus` and assert the card mounts `lan-cert-status-admin`.
- Playwright e2e (`e2e/setup-lan-cert.spec.ts`) — walks the guided wizard
  (`/#/?setup=notready`) to the LAN-access step, asserts
  `lan-cert-status-wizard` + `lan-cert-warning-banner` render (mock status is
  `missing`/`requested:true`), and exercises the repair button.
- Playwright e2e (`e2e/setup-wizard.spec.ts`, updated) — the pre-existing
  5-step step-count/Finish-loop assertions swept to 6 steps so the new step
  doesn't regress the existing wizard spec.

### Manual acceptance walkthrough

Run against a real box (mock mode can't exercise mkcert/cert files), or in mock
mode for the UI-only steps (1–3, 6):

1. **Dismiss mkcert** — on a fresh box, decline the `mkcert -install` OS
   trust-store prompt (or run without mkcert on PATH) so no cert files are
   written under `resolveLanCertPaths(repoRoot)`.
2. **Boot** the app in production/Pinokio mode (`isLanHttpsEnabled()` true by
   default) → server degrades to loopback HTTP, no crash.
3. **Open the first-run wizard** (`#/setup`, guided mode) → step through to
   **LAN access** → expected: `GET /api/lan/cert/status` returns
   `health: 'missing'`, `requested: true` → the wizard shows the soft-warning
   banner ("Phone/tablet pairing is off…") and the `LanCertStatus` body with a
   "Set up LAN certificate" button. Next/Finish stay enabled throughout.
4. **Click Regenerate** ("Set up LAN certificate") → `POST
   /api/lan/cert/regenerate` succeeds (mkcert now available/re-run) → status
   re-fetches: `health: 'healthy'`, `active: false` (no live `lanHttpsServer`
   on this cert-less boot) → the restart-note (`lan-cert-restart-note`) shows:
   "Certificate ready — restart Castwright once to serve over HTTPS."
5. **Restart Castwright** → server now finds cert + key files present at boot
   → binds HTTPS → `GET /api/lan/cert/status` now returns `active: true` → the
   restart note no longer shows; Admin → LAN access card shows the same
   healthy state.
6. **Confirm HTTPS is live** — a phone on the same LAN reaches
   `https://<lan-ip>:8443` (root CA already trusted, or via
   `npm run install:cert-mobile`) and pairing succeeds.

## Out of scope

- OS trust-store membership verification — no reliable cross-platform `mkcert`
  query exists; deliberately excluded (see design spec §Non-goals).
- ops-26's larger LAN cert-broker streamlining (#1333).
- fe-1's phone-side in-app cert banner (#401) — a different surface.
- Any change to install-time cert provisioning (`scripts/setup-lan-certs.mjs`
  generation path) or `POST /api/lan/cert/regenerate` itself.
- Reconciling the pre-existing third copy of the LAN-IP filter in
  `server/src/routes/export-lan.ts` (`enumerateLanUrls`) — noted, not
  consolidated here.

## Ship notes

(Filled in when status flips to `stable`.)

See also: design spec
[docs/superpowers/specs/2026-07-14-ops28-cert-hardening-design.md](../superpowers/specs/2026-07-14-ops28-cert-hardening-design.md)
and implementation plan
[docs/superpowers/plans/2026-07-14-ops28-cert-hardening.md](../superpowers/plans/2026-07-14-ops28-cert-hardening.md).
