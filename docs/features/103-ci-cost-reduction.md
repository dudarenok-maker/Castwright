---
status: active
shipped: null
owner: null
---

# CI cost reduction — path-filtered verify steps + cross-OS consolidation

> Status: active (archive to `archive/` once shipped + Ship notes filled)
> Key files: `.github/workflows/verify.yml`, `.github/workflows/cross-os.yml`, `.github/workflows/release.yml`, `.github/workflows/pr-title-lint.yml`, `CLAUDE.md`
> URL surface: GitHub Actions — `pull_request`, `push` (tags), `workflow_dispatch`, `schedule`
> OpenAPI ops: none

## Benefit / Rationale

The repo is GitHub Free / private (2,000 included Actions minutes/month, OS multipliers: Linux 1×, Windows 2×, macOS 10×). A usage audit found a single busy day (2026-05-22) burning **806 Linux + 9 macOS + 29 Windows** billed minutes — driven not by the release pipeline but by **per-PR cost × PR volume** (~62 PR push events that day, each firing `verify` ~10 min + `e2e-mobile` ~2 min + `pr-title-lint` ~1 min).

- **User (maintainer):** stops running out of free Actions minutes on heavy iteration days. A scoped PR (e.g. frontend-only) now runs only the legs its diff can affect, ~3–7 min instead of ~10. Drafts cost zero CI until marked ready.
- **Technical:** the dominant lever is per-PR, so the fix is per-PR — a single `verify` job detects changed scopes via `git diff` against the PR base, then gates each leg behind an `if:`. Skipped legs cost ~0 with no per-job `npm ci` duplication and no 1-min-per-job rounding floor (the trap a job-per-leg matrix would fall into). The cross-OS release matrix (macOS 10× multiplier on a <4-min job) is retired from per-release and moved to a weekly cron + manual button.
- **Architectural:** locks in "CI runs the scoped subset; the local pre-push hook still runs the FULL `npm run verify` battery." Nothing is permanently un-covered — a developer who broke a server test in a frontend-scoped PR would still be caught at push time. Cross-OS deployer-spread coverage (Windows + macOS + Linux, an alpha-tester invariant) is preserved as a weekly pulse + on-demand `workflow_dispatch`, fired manually before any release announce.

## Architectural impact

- **New seam — scope detector** (`verify.yml` "Detect changed scopes" step): a pure-bash `git diff --name-only <base> <head>` classified into seven outputs (`frontend`, `server`, `sidecar`, `e2e`, `scripts`, `hooks`, `shared`). Each leg's `if:` references these. Deliberately **not** `dorny/paths-filter` — that would be the first third-party action in an otherwise all-`actions/*` workflow set; the bash detector keeps the supply-chain surface at zero new trust.
- **New seam — `shared` fallback:** a change to root `package.json`/`package-lock.json` sets `shared=true`, which is OR'd into every leg's `if:`. A dependency/lockfile bump runs the full battery — the safe default.
- **New workflow — `cross-os.yml`:** `workflow_dispatch` + weekly `cron: '0 2 * * 0'`. Job `cross-os-verify` (matrix `[macos-latest, windows-latest]`, Ubuntu omitted since per-PR `verify.yml` covers it) + job `mobile-e2e` (the former per-PR `e2e-mobile.yml`, now `continue-on-error: false`).
- **New cache layer — node_modules:** `actions/cache` over `node_modules` + `server/node_modules`, keyed on both lockfiles. On a hit, `npm ci` is skipped entirely; a lockfile change busts the key. Shrinks the always-paid setup tax for every run (including multi-scope PRs that run every leg).
- **Invariants preserved:**
  - The `verify` job's `name:` stays exactly `npm run verify` (the would-be branch-protection required-check name; the repo is currently on Free with no protected-branches wall per plan 101, but keeping the name avoids a silent gate-drop if protection is ever enabled).
  - Plan 101's `paths-ignore: [docs/**, *.md, .github/*.md]` stays on `verify.yml` — docs-only PRs short-circuit before the job starts; the scope detector is the second tier.
  - `pr-title-lint.yml` still runs on every PR (now minus the `edited` re-fire); title convention still enforced.
  - `release.yml` still gates publish on a verify pass — just Ubuntu-only.
- **Reversibility:** revert the four workflow edits. `cross-os.yml` deletion + restoring `e2e-mobile.yml` + restoring the 3-OS matrix in `release.yml` undoes the cross-OS move; reverting `verify.yml` restores the single full-battery job. No data migration.

## Invariants to preserve

- `verify.yml` job `name:` MUST remain `npm run verify` (`.github/workflows/verify.yml`, `jobs.verify.name`) — it is the required-check identity. Renaming silently drops the gate.
- Every expensive leg in `verify.yml` MUST carry an `if:` referencing `steps.changes.outputs.*`; a leg with no `if:` runs unconditionally and defeats the filter. The `shared` output MUST be OR'd into every leg so a root-lockfile bump runs the full battery.
- The `Detect changed scopes` step MUST run after `actions/checkout` with `fetch-depth: 0` — a shallow clone can't reach `github.event.pull_request.base.sha`.
- `cross-os.yml` MUST omit `ubuntu-latest` from its verify matrix (covered per-PR) and keep `mobile-e2e` blocking (`continue-on-error` absent/false) — the whole point of moving it off per-PR is that its signal now matters when it fires.
- The node_modules cache key MUST include both lockfile hashes (`hashFiles('package-lock.json', 'server/package-lock.json')`) so a dep change can't serve stale modules.
- `verify.yml` `on.pull_request.types` MUST include `ready_for_review` as long as the job carries the `draft == false` skip — otherwise a promoted draft never re-fires the required check and merge is blocked.

## Test plan

### Automated coverage

This is GitHub-side workflow configuration with no in-repo executable surface — there is no Vitest / Pester / Playwright shape that exercises `if:` gating or `paths-ignore` (same rationale as plan 101). The contract is documented here + in each workflow's header comments; verification is the post-merge smoke walkthrough below. If the repo gains an `actionlint` harness later, these workflows should land there.

### Manual acceptance walkthrough

1. **This PR is the first canary.** It touches `.github/workflows/**` + `docs/**` + `CLAUDE.md` only → the scope detector sets every output `false` (no `src/`/`server/`/`e2e/`/`scripts/` match), so every code leg SKIPS and the `verify` job finishes in ~1 min (checkout + detect + setup) and reports green. Confirm via `gh pr checks` that `npm run verify` is green and fast.
2. **Frontend-scoped probe:** push a no-op comment in `src/App.tsx` → expect lint + typecheck + frontend tests + e2e + build to run, **server tests to skip**. Revert before merge.
3. **Server-scoped probe:** push a no-op comment in `server/src/index.ts` → expect server tests + build to run, **frontend unit + Playwright e2e to skip**.
4. **Draft probe:** open a draft PR → expect no `verify` run; mark Ready for review → expect `verify` to fire (proves the `ready_for_review` trigger).
5. **Cross-OS workflow:** Actions tab → "Cross-OS Verify" → Run workflow against `main` → expect 2 verify jobs (macos-latest, windows-latest) + 1 mobile-e2e job, all green on a clean main.
6. **Scheduled pulse:** confirm the Sunday 02:00 UTC cron lands a `Cross-OS Verify` run (follow-up, non-blocking).
7. **Release smoke:** next `v*.*.*` tag → expect `release.yml` to fire `Verify (ubuntu-latest)` + `Publish release zip` only; no macOS/Windows jobs.

## Out of scope

- **Branch-protection rules.** Repo is GitHub Free / private with no protected-branches wall (per plan 101 "Out of scope"). The `verify` name is preserved for the day that changes; nothing to configure now.
- **`actionlint` CI-config harness** — flagged as a future option; not added here.
- **Further per-PR cuts** parked on BACKLOG: serialize `regen-visual-baselines.yml`'s 3-leg matrix; composite setup action to DRY `verify.yml` ↔ `cross-os.yml`; path-filter `cross-os.yml`'s mobile-e2e on frontend/e2e scope.

## Ship notes

(Filled when status flips to `stable`. Append shipped date + merge commit SHA, then `git mv` to `docs/features/archive/` and move the INDEX entry to the Shipped section.)
