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
competing — verify was contending with itself, with different steps failing
across retries and the whole run getting progressively slower.

**The exact mechanism is not fully pinned down, and this spec does not
depend on it being.** A candidate explanation (self-contention from the
battery's own heavy fork-pool/Playwright/pytest concurrency, possibly
compounded by orphaned child processes left behind by a prior killed/
timed-out attempt) is plausible but only partially evidenced — the
documented zombie-process precedent (`feedback_merge_via_ci_when_gpu_
throttles_local_verify` memory) describes that mechanism specifically under
an *active competing GPU generation*, which the user says wasn't the case
here. Rather than chase the exact cause, this spec removes the reason to
run the heavy battery locally **at all** for routine work, which makes
whatever the mechanism was moot for that path. It does NOT resolve
contention for the one path that still runs heavy local work on purpose
(scope-gated sidecar testing, §4) — that remains a real, open risk (see
Risks).

Separately: the repo went public (`castwright.ai` live). GitHub-hosted
Actions runners are free and uncapped for public repos. The current
"CI is opt-in, minimize runs" design (plans 103, 118, 215) was built around
private-repo minute costs that no longer apply. Its rationale is stale.

## Goals

- Local pre-push/pre-commit work stops running the heavy, contention-prone
  legs (server/frontend integration suites, Playwright, build)
  *unconditionally on every push* — every step in the new local command is
  scope-gated to whether the branch diff actually touches its own declared
  inputs, the same uniform mechanism `--scope-staged` already uses for
  pre-commit, just applied to a branch-level diff instead of a staged one.
  Nothing is special-cased to "always run regardless of relevance."
- Nothing loses **enforcement**: every cloud-safe leg still runs on every
  PR, in the cloud instead of locally, AND `verify.yml` becomes a **required
  status check** on `main` — so it actually blocks merge on red, closing the
  gap where today's local pre-push is the only thing that refuses a push.
  (An earlier draft of this spec claimed cloud coverage alone was
  equivalent to today's local gate; adversarial review found that's false
  while `verify.yml` isn't required — see the design-doc history / PR
  discussion for that correction. This action is required regardless of
  whether the separately-pending `pr-issue-link.yml` required-check wiring
  in doc 235 has happened yet — see §3.)
- The local machine is reserved for what genuinely requires it: things CI
  cannot do at all — real GPU/CUDA + actual model weights
  (`test:golden-audio`, manual generation/model testing) — and things CI
  merely doesn't have set up (the bootstrapped Python sidecar venv/deps,
  `test:sidecar`). These stay local; only `test:golden-audio` and manual
  model work are fully manual-only. `test:sidecar` itself is **model-free**
  (`-m "not golden"`) — it's local because CI has no bootstrapped venv, not
  because it needs a GPU — and rejoins the automatic local gate like every
  other step, scope-gated to its own real inputs (§4). None of this runs in
  the cloud.
- CI flips from opt-in (`run-ci` label / manual dispatch) to opt-out
  (runs by default on every PR, including docs-only — see §3 for why
  docs-only can't stay exempt once the check is required).

## Non-goals

- Not fixing a specific orphaned-child-process bug directly — its existence
  as *the* cause here isn't confirmed (see Problem). It remains a real,
  open risk specifically for the one path that still runs heavy local work
  on purpose (scope-gated `test:sidecar`, §4) — flagged in Risks, not
  resolved by this spec.
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
whether it needs something a stock GitHub-hosted runner doesn't have —
either the bootstrapped Python sidecar venv/deps (`test:sidecar`) or real
GPU/CUDA + actual model weights (`test:golden-audio`, not itself a `STEPS`
entry) — versus everything else, which is plain Node/TS/Python-mock work
any runner can do:

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
| test:sidecar | **no** (local-only, auto) | needs the bootstrapped Python venv/deps CI doesn't have — **not** real model weights (it runs `-m "not golden"`, explicitly model-free). **There is no `test:sidecar` step in `verify.yml` today at all** — cloud coverage has always been zero, not "skipped." Stays out of the cloud workflow, but rejoins the local automatic gate scope-gated to its own real inputs, same as every other step (§4) |
| test:e2e | yes | already cloud, unchanged |
| test:e2e:visual | yes | already cloud, unchanged |
| build | yes | already cloud, unchanged |
| test:golden-audio | **no** (manual-only) | not in STEPS today (already separate opt-in command); stays manual-only, never auto-triggered anywhere |

Two gaps found: `config:check` and `test:pinokio` are cloud-safe but are
**not currently in `verify.yml` at all** — they only ever ran via the local
full `npm run verify`. Once pre-push stops running that, they'd silently
lose all coverage unless added to the cloud workflow. This spec adds them
(§3), with scope-matcher fixes for both (§3) since the obvious matches
turned out to miss real inputs.

On this dev box specifically, the sidecar venv is bootstrapped, so today's
local pre-push actually runs all of `test:sidecar`'s pytest files on **every
push**, regardless of whether the push touches sidecar code. Simply
dropping it to a fully-manual command (as an earlier draft of this spec
did) would be a real regression on the one path most relevant to current
work (the side-11 sidecar branch) — nobody would remember to run it by
hand consistently. Instead it rejoins the automatic local gate, scope-gated
so it only fires when relevant (§4).

### 3. CI trigger: opt-in → opt-out, and made a real gate

`.github/workflows/verify.yml`:

- Drop the `labeled` event and the `run-ci` label requirement from the job
  `if:` gate — the workflow runs on every `pull_request` (opened,
  synchronize, reopened, ready_for_review) by default.
- **Drop the `paths-ignore: [docs/**, *.md, .github/*.md]` block entirely.**
  Keeping it while also making this a required status check would deadlock
  every docs-only PR: `verify.yml`'s own header explains branch protection
  today *deliberately* excludes it as required specifically so doc-only PRs
  "can't deadlock" against a check that never fires. Once required, the
  workflow must always trigger. This isn't a new cost, though: the existing
  per-leg scope `if:` gating already makes every leg's condition false for
  a genuinely docs-only diff (none of `frontend`/`server`/`sidecar`/`e2e`/
  `scripts`/`hooks`/`pinokio` match a docs-only file set), so the job still
  completes in roughly the time of "Setup Node + deps" alone (~20-40s) and
  reports green — no deadlock, negligible added time, no new logic needed.
- Keep the per-scope `if:` gating on each leg otherwise (still worth
  skipping legs a PR didn't touch — now framed as "don't run tests that
  can't fail," not "save money").
- **Add its check as a required status check** in `main`'s branch-protection
  ruleset. This is the load-bearing change: without it, cloud verify running
  on every PR is only *advisory* — mergeable-past on red — which is a net
  enforcement regression versus today's push-refusing local pre-push. This
  is a one-time, manual GitHub settings action that must happen as part of
  implementing this spec, **independently of** whether the separately
  pending `pr-issue-link.yml` required-check wiring
  (`docs/features/235-model-routing-review-gates.md`) has landed yet — do
  the ruleset edit for both checks together if 235's wiring happens to be
  done at the same time, but don't make this spec's completion contingent
  on that other item finally landing (it's been pending independently;
  treat them as two separate action items that happen to touch the same
  GitHub settings page).
- Add a `pinokio` key to the scope-detection step. Match both the test
  files and the runner script, not just the directory: `match
  '^(pinokio/|scripts/run-pinokio-tests\.mjs$)'` — the plain `^pinokio/`
  match alone misses a runner-only edit, since `test:pinokio`'s actual
  `extraFiles` entry (`scripts/run-pinokio-tests.mjs`) lives outside
  `pinokio/`.
- Add a `Config check` step (`npm run config:check`) gated on
  `server == 'true' || shared == 'true'`, **and widen the `server` scope
  match** to also catch `config:check`'s real inputs that fall outside the
  current regex: `server/.env.example` and
  `server/scripts/sync-env-example.ts`. Today's `server` matcher
  (`^(server/src/|server/package(-lock)?\.json$|server/tsconfig\.json$|
  server/vitest\.config(\.slow)?\.ts$|openapi\.yaml$)`) doesn't cover
  either — a direct edit to `.env.example` (exactly the drift this guard
  exists to catch) would silently never trigger it. New matcher: add
  `|server/\.env\.example$|server/scripts/sync-env-example\.ts$` to the
  existing alternation.
- Add a `Pinokio tests` step (`npm run test:pinokio`), gated on
  `pinokio == 'true' || shared == 'true'`.
- Comment/header text describing "OPT-IN" gets rewritten to describe the
  new opt-out-and-required default and why (public repo, free runners).

### 4. Pre-push hook trim + new `verify:fast:branch`

`scripts/verify-cache.mjs` gets a new scope basis alongside the existing
`--scope-staged` (which diffs `git diff --cached`, correct for
pre-commit): `--scope-branch`, which diffs
`git merge-base HEAD main` against `HEAD` — i.e. every file touched by
every commit on the current branch since it diverged from local `main`.
This is the right basis for a pre-push-time check, where "staged" is
usually empty or meaningless (commits already exist). Falls back to
running everything if the merge-base/diff git calls fail, mirroring the
existing tolerant-on-uncertainty behavior for `--scope-staged`. Distinct
from that failure case: a **successful** merge-base diff that comes back
*empty* (branch fully merged into local `main`, run directly on `main`, or
a branch with no commits yet) must NOT be treated the same as "git
failed" — it's a legitimate zero-file diff, and the existing scope-filter
semantics would correctly skip every step for it. That's fine given
`verify.yml` is now the required backstop (§3), but it should be a
deliberate, documented behavior of `branchDiffFiles`, not an accidental
side effect an implementer discovers later.

New npm script:

```
"verify:fast:branch": "node scripts/verify-cache.mjs --steps lint,typecheck,config:check,test:hooks,test,test:server,build,test:sidecar --scope-branch"
```

`--scope-branch` applies the **same uniform per-step scope filter**
`--scope-staged` already applies today (verify-cache.mjs's main loop
checks `stepTouchedByDiff(step, scopeDiff)` for every step in the active
list, not a hand-picked subset — see `runPipeline`'s loop). No special-
casing: `test:sidecar` isn't treated differently from `test:server` or
`build` in the mechanism, it just happens to have narrower globs
(`server/tts-sidecar/**/*.py`, `requirements*.txt`, `run-tests.ps1` — its
own already-declared `STEPS` entry, reused as-is, not a new
`server/tts-sidecar/**` match invented for this spec) so it fires less
often in practice. `test:server`/`build`/`test` are scope-gated by their
own existing globs (`server/src/**`, `src/** + server/src/**`, `src/**`
respectively) exactly the same way — an earlier draft of this spec
incorrectly described them as "always run regardless of relevance," which
would have defeated the point of the whole redesign (`test:server` is one
of only two `RETRIABLE_POOL_STEPS`, i.e. the exact fork-pool-crash-prone
leg the Problem section is about). Of the remaining steps, `lint` (`**/*.
{ts,tsx,js,jsx,cjs,mjs}`) and `typecheck` (`src/**`, `server/src/**`) have
broad-enough globs that they'll fire on nearly every code PR — that's
expected and fine, they're cheap. `test:hooks` and `config:check` are
actually narrow (`scripts/tests/*.test.mjs` / `.husky`+validator, and
`server/src/config/*.ts` + the two extraFiles respectively) and correctly
skip on PRs outside their scope — narrow-but-correct, not "broad."

This means on a branch that touches `server/tts-sidecar/**`, `test:sidecar`
auto-runs and blocks the push on failure — real, automatic local coverage
on the one path where the machine is genuinely relevant — without any new
selective-gating logic beyond what the existing scope-filter engine
already does for `--scope-staged`.

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
`test:server-slow`, `test:scripts`, `test:e2e`, `test:e2e:visual` — all now
covered by cloud verify per §3. `test:golden-audio` stays fully manual,
never in this list.

**Implementation note (test-coverage obligation, per CLAUDE.md's testing
discipline):** `scripts/tests/verify-cache.test.mjs`'s existing `parseFlags`
tests assert an exact `deepEqual` against today's return shape
(`{ noCache, steps, scopeStaged }`); adding a `scopeBranch` field breaks
every one of them and must be updated in the same change, not left for CI
to discover. The new `git merge-base HEAD main` → `git diff --name-only`
logic has no equivalent to mirror: `stagedDiffFiles` (the `--scope-staged`
counterpart) isn't exported and isn't unit-tested today — only the pure
predicates `stepTouchedByDiff`/`computeShared` are, and `runPipeline`
itself is explicitly documented as exercised by manual walkthrough, not
unit tests. Don't assert test parity that doesn't exist: the new function
(name it e.g. `branchDiffFiles`) should be **exported** specifically so it
can be unit-tested directly (with `cwd` pointed at a throwaway git repo
fixture, or by injecting a `spawnSync`-like seam), closing a gap that
`stagedDiffFiles` itself still has rather than just matching its
(non-)existing coverage.

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
- `docs/features/235-model-routing-review-gates.md`: this already documents
  a pending, one-time required-status-check ruleset setup for
  `pr-issue-link.yml`. Note that `verify.yml` also needs the same
  ruleset-required treatment (§3) — do both in one GitHub settings visit if
  235's item happens to still be open at the same time, but treat them as
  independent action items rather than coupling this spec's completion to
  235's.
- `feedback_ci_cost_shipping_practice` memory: update once implemented —
  the draft-PR-to-save-minutes rationale is retired (repo is public, cost
  is no longer the reason); note whether the draft-PR practice itself is
  kept for other reasons (signal/noise) or dropped.

## Risks / follow-ups

- **Open, not resolved by this spec:** if the (unconfirmed) self-contention
  mechanism recurs specifically during scope-gated local `test:sidecar` runs
  or manual generation/model work — the one case that still does real local
  work automatically — it isn't fixed here. A follow-up cleanup-on-kill fix
  (or actually root-causing the original 2-3h/day incident, which this spec
  deliberately did not chase) may still be worth doing if it bites again on
  that path.
- **Also open, narrower than the above:** on any server- or full-stack-
  touching branch (not just sidecar work), `verify:fast:branch` still runs
  `test:server` — one of only two `RETRIABLE_POOL_STEPS`, i.e. the exact
  fork-pool-crash-prone leg named in the Problem section — plus `test` and
  `build`, whenever that branch's diff actually touches their scopes (which
  is the common case for backend/full-stack work). Scope-gating removes
  these from *irrelevant* pushes, and the steps run sequentially rather
  than concurrently, so the residual load per push is real but smaller
  than today's full parallel battery — but this spec does not claim, and
  should not be read as claiming, that a routine server-touching push can
  no longer reproduce any version of the original contention. If the
  incident recurs there, that's a signal to revisit this leg specifically,
  not evidence the whole redesign failed.
- `verify:fast:branch`'s `--scope-branch` diffs against local `main`, not
  `origin/main` — assumes the developer's local `main` is reasonably
  current. This is a materially bigger deal now than an earlier draft
  treated it: with `verify.yml` required (§3) covering the branch's actual
  diff on the PR side, the local pre-push's job is narrower (fast smoke +
  scope-gated sidecar), so an under-approximated local scope mostly just
  means the cloud gate catches it instead — acceptable, but worth being
  explicit that local pre-push is deliberately not the last line of defense
  anymore, `verify.yml`-as-required-check is.
- The `main` branch-protection ruleset change (§3) is a manual, one-time
  GitHub settings action this spec's file changes cannot perform by
  themselves — implementation must call this out explicitly rather than
  quietly assume it's done as a side effect of merging code. It's
  deliberately treated as its own action item, not contingent on doc 235's
  separate (still-pending) `pr-issue-link.yml` wiring actually landing.
- `scripts/tests/verify-cache.test.mjs` needs updating in the same change
  as the `--scope-branch`/`scopeBranch` work (see §4) — flagged here again
  since a plan that treats this as a follow-up rather than in-scope would
  violate CLAUDE.md's testing discipline. The new diff-listing function
  needs to be exported and directly unit-tested (§4) rather than assumed
  covered by analogy to `stagedDiffFiles`, which has no such test itself.
- Dropping `verify.yml`'s `paths-ignore` (§3) means every docs-only PR now
  spins up the workflow (env setup only, ~20-40s) instead of never
  triggering — a deliberate, confirmed tradeoff to avoid the required-check
  deadlock, not an oversight.
