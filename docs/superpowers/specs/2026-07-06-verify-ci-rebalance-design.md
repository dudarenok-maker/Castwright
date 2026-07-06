---
status: draft
date: 2026-07-06
---

# Verify / CI rebalance: cloud-first gating, machine reserved for model-bound work

## Problem

Running `npm run verify` (the full battery: lint, typecheck, config:check,
test:hooks, test:pinokio, test, test:server, test:server-slow, test:scripts,
test:sidecar, test:e2e, test:e2e:visual, build) locally on every push, per
the current `.husky/pre-push` hook, wasted 2-3 hours in a single day this
week. The user confirmed no external workload (e.g. a generation run) was
competing — verify was contending with itself. The most likely mechanism:
the current branch's changes touched sidecar/server code (side-11 work), so
`test:sidecar` and `test:server*` re-ran (their cached input hash changed),
and a killed/timed-out attempt leaves orphaned vitest/Playwright/pytest
child processes behind (documented already in
`feedback_merge_via_ci_when_gpu_throttles_local_verify` memory); each retry
then contends with the prior attempt's zombies, compounding until a
different step fails each time and the whole thing crawls. This spec does
not chase that zombie-process bug directly — it removes the underlying
reason to run the heavy battery locally at all, which makes the failure
mode moot for routine work.

Separately: the repo went public (`castwright.ai` live). GitHub-hosted
Actions runners are free and uncapped for public repos. The current
"CI is opt-in, minimize runs" design (plans 103, 118, 215) was built around
private-repo minute costs that no longer apply. Its rationale is stale.

## Goals

- Local pre-push/pre-commit work stops running the heavy, contention-prone
  legs (server/frontend integration suites, Playwright, sidecar pytest,
  build) as routine, on-every-push behavior.
- Nothing loses coverage: every leg that's cloud-safe still runs on every
  PR, just in the cloud instead of locally.
- The local machine is reserved for what genuinely requires it: real
  GPU/CUDA + the bootstrapped Python sidecar venv + actual model weights
  (`test:sidecar`, `test:golden-audio`, manual generation/model testing).
  These become deliberate, on-demand, manual commands — never triggered
  automatically by routine commits/pushes on unrelated work, in EITHER
  local hooks or cloud CI (cloud runners can't load models either).
- CI flips from opt-in (`run-ci` label / manual dispatch) to opt-out
  (runs by default on every PR; docs-only PRs stay exempt, same as today).

## Non-goals

- Not fixing the orphaned-child-process bug directly (no longer load-bearing
  once the heavy battery isn't run routinely; can be a separate follow-up if
  it recurs during genuine local sidecar work).
- Not changing the mandatory code-review gate, PR-issue-link gate, or
  commit-msg validation — those are unaffected.
- Not touching `test:golden-audio` mechanics — it's already opt-in/manual
  today; this spec just confirms it stays that way and stays out of both
  local-hook and cloud-CI automatic paths.

## Design

### 1. New default dev loop

Finalize the code change → run the new branch-scoped fast command (§4) →
open the PR → cloud verify fires automatically (§3) and the mandatory
code-review subagent is dispatched in parallel → merge once both are green.

### 2. STEPS reclassification

Audited every step in `scripts/verify-cache.mjs`'s `STEPS` array against
whether it needs this machine's actual hardware (GPU + bootstrapped
sidecar venv + real model weights) or can run on a stock GitHub-hosted
runner:

| Step | Cloud-safe? | Notes |
|---|---|---|
| lint | yes | already cloud, unchanged |
| typecheck | yes | already cloud, unchanged |
| config:check | yes | **new to cloud** — currently only ran via local full `verify` |
| test:hooks | yes | already cloud, unchanged |
| test:pinokio | yes | **new to cloud** — currently only ran via local full `verify` |
| test | yes | already cloud (`--changed` narrowed), unchanged |
| test:server | yes | already cloud (`--changed` narrowed), unchanged |
| test:server-slow | yes | already cloud, unchanged |
| test:scripts (Pester) | yes | already cloud (ubuntu has pwsh), unchanged |
| test:sidecar | **no** | needs the bootstrapped venv + real model weights; CI already skips it today (venv absent) — this was already silently zero-coverage in the cloud |
| test:e2e | yes | already cloud, unchanged |
| test:e2e:visual | yes | already cloud, unchanged |
| build | yes | already cloud, unchanged |
| test:golden-audio | **no** | not in STEPS today (already separate opt-in command); stays manual-only |

Two gaps found: `config:check` and `test:pinokio` are cloud-safe but are
**not currently in `verify.yml` at all** — they only ever ran via the local
full `npm run verify`. Once pre-push stops running that, they'd silently
lose all coverage unless added to the cloud workflow. This spec adds them.

`test:sidecar` was already effectively cloud-uncovered (CI's venv isn't
bootstrapped, so it would skip-with-banner even if invoked) — formalizing
it as local-manual-only changes nothing about actual coverage, just removes
the illusion that it was part of the automatic gate.

### 3. CI trigger: opt-in → opt-out

`.github/workflows/verify.yml`:

- Drop the `labeled` event and the `run-ci` label requirement from the job
  `if:` gate — the workflow runs on every `pull_request` (opened,
  synchronize, reopened, ready_for_review) by default.
- Keep the existing `paths-ignore` docs-only fast-path and the per-scope
  `if:` gating on each leg (still worth skipping legs a PR didn't touch —
  now framed as "don't run tests that can't fail," not "save money").
- Add a `pinokio` key to the scope-detection step (`match '^pinokio/'`) and
  a `Config check` step (`npm run config:check`, gated on
  `server == 'true' || shared == 'true'`) and a `Pinokio tests` step
  (`npm run test:pinokio`, gated on `pinokio == 'true' || shared == 'true'`).
- Comment/header text describing "OPT-IN" gets rewritten to describe the
  new opt-out default and why (public repo, free runners).

### 4. Pre-push hook trim + new `verify:fast:branch`

`scripts/verify-cache.mjs` gets a new scope basis alongside the existing
`--scope-staged` (which diffs `git diff --cached`, correct for
pre-commit): `--scope-branch`, which diffs
`git merge-base HEAD main` against `HEAD` — i.e. every file touched by
every commit on the current branch since it diverged from local `main`.
This is the right basis for a pre-push-time check, where "staged" is
usually empty or meaningless (commits already exist). Falls back to
running everything if the merge-base/diff git calls fail, mirroring the
existing tolerant-on-uncertainty behavior for `--scope-staged`.

New npm script:

```
"verify:fast:branch": "node scripts/verify-cache.mjs --steps lint,typecheck,config:check,test:hooks,test,test:server,build --scope-branch"
```

This single command serves two purposes with no duplication:

1. **The developer's own "test what I touched" step** in the new default
   loop (§1) — run manually before opening the PR.
2. **The new pre-push hook body** — the same command runs automatically as
   a backstop, so an accidental unstaged/unbuilt push still gets caught
   fast, locally, before round-tripping through a 10-15 min cloud run.

`.husky/pre-push` changes from calling `npm run verify` to calling
`npm run verify:fast:branch`, after the existing guard scripts
(`guard-protected-push`, `guard-commit-subjects`, `is-docs-only-push`),
unchanged. Drops entirely from local pre-push: `test:pinokio`,
`test:server-slow`, `test:scripts`, `test:sidecar`, `test:e2e`,
`test:e2e:visual` — all now covered by cloud verify per §3 (or, for
`test:sidecar`, intentionally left manual-only per §2).

`.husky/pre-commit` (`npm run verify:fast:scoped`, staged-diff based) is
unchanged — it's already fast/scoped and wasn't implicated in the waste.

### 5. `cross-os.yml` cadence bump

Once local pre-push no longer runs `test:scripts` (Pester/Windows) or a
real Windows/macOS pass at all, the weekly `cross-os.yml` cron becomes the
only regular cross-platform coverage. Bump from weekly (Sunday 02:00 UTC)
to twice weekly: add Wednesday 02:00 UTC alongside the existing Sunday
02:00 UTC slot (`cron: '0 2 * * 3'` and `'0 2 * * 0'`).

### 6. What stays the same

- `.husky/pre-commit` (staged-scoped fast tests).
- commit-msg validation (`.husky/commit-msg`).
- Mandatory code-review gate and PR-issue-link gate (model-routing SKILL.md).
- `npm run verify` still exists as a full local command for manual use
  (e.g. before a release cut, or when actually debugging something that
  needs the full battery) — it's just no longer force-invoked by the hook.
- `release.yml`'s full cross-platform gate on a version tag.
- `test:golden-audio` — already opt-in/manual, unaffected.

## Docs to update

- `CLAUDE.md`: "Commit gate" section (pre-push behavior, new
  `verify:fast:branch`), "GitHub CI is OPT-IN" section (rewrite framing to
  opt-out + why), "Working practice" (drop "run `npm run verify` before
  every push" as the primary loop; describe the new default loop).
- `CONTRIBUTING.md`: any CI-cost / opt-in language mirrored from CLAUDE.md.
- `docs/features/118-ci-cost-round-2.md` and
  `docs/features/215-ci-label-gated-verify.md`: add a superseded/updated
  note pointing at this spec, don't delete (historical record of why the
  opt-in design existed while the repo was private).
- `feedback_ci_cost_shipping_practice` memory: update once implemented —
  the draft-PR-to-save-minutes rationale is retired (repo is public, cost
  is no longer the reason); note whether the draft-PR practice itself is
  kept for other reasons (signal/noise) or dropped.

## Risks / follow-ups

- If the zombie-process contention bug recurs during genuine local
  `test:sidecar`/manual generation work (the one case still run locally),
  it isn't fixed by this spec — only made rare (routine commits no longer
  trigger it). A follow-up cleanup-on-kill fix may still be worth doing
  separately if it bites again.
- `verify:fast:branch`'s `--scope-branch` diffs against local `main`, not
  `origin/main` — assumes the developer's local `main` is reasonably
  current. Acceptable for a pre-push speed check (cloud verify is the real
  gate); flagged here rather than silently assumed.
