---
status: stable
shipped: 2026-05-23
owner: null
---

# CI: composite setup action + path-filtered cross-os mobile-e2e

> Status: stable
> Key files: `.github/actions/setup/action.yml`, `.github/workflows/verify.yml`, `.github/workflows/cross-os.yml`
> URL surface: GitHub Actions — `pull_request` (verify.yml), `workflow_dispatch` + weekly `schedule` (cross-os.yml)
> OpenAPI ops: none

Two CI tidiness items shipped together (BACKLOG Could #38 + #39). Both stack on plan 103 (archived/stable — `docs/features/archive/103-ci-cost-reduction.md`); this plan does NOT reopen 103, it factors out duplication 103 left behind and adds one more cron-side gate.

## Benefit / Rationale

- **User:** n/a — CI-only, no app surface changes.
- **Technical (#38):** the setup preamble (`setup-node` + `node_modules` cache + conditional `npm ci`) was byte-duplicated across `verify.yml` and `cross-os.yml`. A Node-major bump or a cache-key change now lands in ONE file (`.github/actions/setup/action.yml`) instead of drifting across three call sites. `cross-os.yml`'s two jobs gain `node_modules` caching as a bonus (they previously ran two bare `npm ci` calls with no unpacked-modules cache).
- **Technical (#39):** the weekly `cross-os.yml` cron always ran `mobile-e2e` (~2 min ubuntu) even on weeks where `main` saw no frontend/e2e change at all, so the run learned nothing. A cheap `changes` probe now skips it on those weeks; manual `workflow_dispatch` always runs it.
- **Architectural:** keeps the all-first-party (`actions/*` + local composite) convention plan 103 established — no third-party marketplace action introduced. The composite encapsulates ONLY the truly-shared, unconditional steps; scope-gated / OS-specific steps stay per-workflow so 103's path-filter savings are untouched.

## Architectural impact

### New seam — `.github/actions/setup` composite action

A local composite action (`runs.using: composite`) with a single input `node-version` (default `'24'`). Its three steps are the exact preamble that was duplicated:

1. `actions/setup-node@v4` — `node-version: ${{ inputs.node-version }}`, npm download cache, `cache-dependency-path` = both lockfiles.
2. `actions/cache@v4` for the UNPACKED `node_modules` (root + `server/node_modules`), key `${{ runner.os }}-node24-modules-${{ hashFiles('package-lock.json', 'server/package-lock.json') }}`.
3. Conditional `npm ci && npm --prefix server ci` — `if: steps.node-modules-cache.outputs.cache-hit != 'true'`, `shell: bash` (composite `run` steps require an explicit shell).

### What stayed per-workflow (and why)

- **`actions/checkout`** — the composite action file only exists on disk *after* checkout, so checkout must precede `uses: ./.github/actions/setup`. `verify.yml`'s checkout also needs `fetch-depth: 0` for its scope-diff against the PR base; folding checkout into the composite would hide that requirement.
- **ffmpeg** — scope-gated in `verify.yml` (`server` / `sidecar` / `e2e` / `shared`), OS-specific in `cross-os.yml` (`brew` on macOS, `choco` on Windows, `apt` on ubuntu). A composite would need `runner.os` branches and would break `verify.yml`'s "skip ffmpeg on a frontend-only PR" saving.
- **Playwright cache + install** — scope-gated in `verify.yml`; only one `cross-os.yml` job needs it. Out of scope for a DRY-the-unconditional-preamble refactor.

### #39 — `mobile-e2e` cron gate

New `changes` job (ubuntu, ~seconds): checkout `fetch-depth: 0`, then a bash step that lists files changed on `origin/main` in the last 7 days and greps for the frontend/e2e path vocabulary, writing `frontend_e2e=true|false` to `$GITHUB_OUTPUT`. The regex mirrors `verify.yml`'s `frontend` + `e2e` scopes plus the shared root package files:

```
^(src/|e2e/|index\.html$|vite\.config\.ts$|tailwind\.config\.ts$|playwright\.config\.ts$|package(-lock)?\.json$)
```

`mobile-e2e` gains `needs: changes` and:

```
if: github.event_name == 'workflow_dispatch' || needs.changes.outputs.frontend_e2e == 'true'
```

So a **manual dispatch always runs `mobile-e2e`**; a **cron week with no frontend/e2e change on `main` skips it cleanly**. `cross-os-verify` is intentionally NOT gated — the cross-OS smoke runs every cron/dispatch regardless of which scope changed.

### Reversibility

Pure CI-workflow refactor. Reverting is a `git revert` of the two commits — no data shape, no app code, no migration.

## Invariants to preserve

- `verify.yml`'s `verify` job `name:` stays exactly `npm run verify` (plan 103 invariant — it's the branch-protection required-status-check name). This plan does not touch the job name.
- `verify.yml`'s "Detect changed scopes" step and every scoped `if:` leg are unchanged — the composite swap only replaces the three setup steps between the scope-detector and the first leg.
- The composite's `node_modules` cache key string is byte-identical to the key plan 103 used in `verify.yml`, so warm caches carry over (no cold-start regression on the first post-merge run).
- All-first-party action convention (plan 103): only `actions/*` + the local `./.github/actions/setup`. No marketplace action added.

## Test plan

### Automated coverage

CI-workflow YAML is not unit-testable from the app harnesses. Validation is:

- **`actionlint` (v1.7.7)** run locally over `.github/workflows/verify.yml` + `cross-os.yml` — exit 0 (both reference the local composite; actionlint resolves the `uses: ./.github/actions/setup` path). The composite `action.yml` itself was structurally validated by parsing it (`runs.using: composite`, three steps, `node-version` input, `shell: bash` on the run step) — actionlint v1.7.x parses an action.yml passed directly as if it were a workflow, so it is validated via the referencing workflows, not standalone.
- **`verify.yml` self-validates on this PR** — the PR's own CI run exercises the rewired composite end-to-end (setup-node → node_modules cache → conditional ci → scoped legs).

### Manual acceptance walkthrough

1. **`#38` — `verify.yml` on a frontend PR** → Actions tab shows the `verify` job: "Setup Node + deps" composite step runs (expands to setup-node + cache + install), then the scoped legs fire. No regression vs. the prior inline steps.
2. **`#38` — `cross-os.yml` manual dispatch** (Actions → Cross-OS Verify → Run workflow) → both `cross-os-verify` (macOS + Windows) and `mobile-e2e` (ubuntu) pass; each uses the composite. Confirm the matrix jobs now hit a `node_modules` cache on the second run.
3. **`#39` — `mobile-e2e` always-on dispatch** → a `workflow_dispatch` ALWAYS runs `mobile-e2e` (the `if:` short-circuits on `github.event_name == 'workflow_dispatch'`) regardless of recent `main` activity.
4. **`#39` — `mobile-e2e` cron skip** → on a weekly cron where `main` saw no frontend/e2e change in the prior 7 days, the `changes` job outputs `frontend_e2e=false` and `mobile-e2e` is skipped (grey "Skipped" in the run summary); `cross-os-verify` still runs. A week with a `src/**` change runs `mobile-e2e` as before. (Verify by inspecting a real cron run's `changes` job log, or by firing a dispatch and reading the resolved `if:`.)

## Out of scope

- Folding checkout / ffmpeg / Playwright into the composite — see "What stayed per-workflow" above.
- Any change to plan 103's path-filter regex or the `verify` job structure (103 is archived/stable; this plan layers on top, it does not reopen it).
- `regen-visual-baselines.yml` matrix collapse (BACKLOG Could #37) — separate item, untouched.

## Ship notes

Shipped 2026-05-23. Two commits on branch `ci/setup-action-and-mobile-filter`:

1. `ci: extract composite setup action to DRY verify.yml and cross-os.yml` — new `.github/actions/setup/action.yml`; rewired both workflows (verify.yml `verify` job, cross-os.yml `cross-os-verify` + `mobile-e2e`).
2. `ci: path-filter cross-os mobile-e2e on frontend/e2e change window` — new `changes` job + `needs:`/`if:` gate on `mobile-e2e`.

Validated with `actionlint` v1.7.7 (exit 0 on both workflows). BACKLOG Could #38 + #39 removed. No app code changed.
