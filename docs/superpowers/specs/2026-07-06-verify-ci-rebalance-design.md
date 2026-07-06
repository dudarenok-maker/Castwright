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
  legs (server/frontend integration suites, Playwright, build) as routine,
  on-every-push behavior *when they're not relevant to the change*.
- Nothing loses **enforcement**: every cloud-safe leg still runs on every
  PR, in the cloud instead of locally, AND `verify.yml` becomes a **required
  status check** on `main` — so it actually blocks merge on red, closing the
  gap where today's local pre-push is the only thing that refuses a push.
  (An earlier draft of this spec claimed cloud coverage alone was
  equivalent to today's local gate; adversarial review found that's false
  while `verify.yml` isn't required — see the design-doc history / PR
  discussion for that correction.)
- The local machine is reserved for what genuinely requires it: real
  GPU/CUDA + the bootstrapped Python sidecar venv + actual model weights.
  `test:golden-audio` and manual generation/model testing become
  deliberate, on-demand, manual commands. `test:sidecar` is the one
  exception that stays in the **automatic** local gate, but scope-gated —
  it auto-runs in the new pre-push hook only when the branch diff actually
  touches `server/tts-sidecar/**`, so it doesn't burden unrelated commits
  but still catches sidecar regressions on the one path where the machine
  is genuinely needed and the work is actually relevant. None of this runs
  in the cloud (cloud runners can't load real models).
- CI flips from opt-in (`run-ci` label / manual dispatch) to opt-out
  (runs by default on every PR; docs-only PRs stay exempt, same as today).

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
| test:sidecar | **no** (local-only, auto) | needs the bootstrapped venv + real model weights. **There is no `test:sidecar` step in `verify.yml` today at all** — cloud coverage has always been zero, not "skipped." Stays out of the cloud workflow, but rejoins the local automatic gate scope-gated (§4) |
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
- Keep the existing `paths-ignore` docs-only fast-path and the per-scope
  `if:` gating on each leg (still worth skipping legs a PR didn't touch —
  now framed as "don't run tests that can't fail," not "save money").
- **Add its check as a required status check** in `main`'s branch-protection
  ruleset. This is the load-bearing change: without it, cloud verify running
  on every PR is only *advisory* — mergeable-past on red — which is a net
  enforcement regression versus today's push-refusing local pre-push. This
  is a one-time, manual GitHub settings action (same category as the
  pending `pr-issue-link.yml` required-check wiring already noted in
  `docs/features/235-model-routing-review-gates.md` — bundle both into the
  same ruleset-setup step rather than doing it twice).
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
existing tolerant-on-uncertainty behavior for `--scope-staged`.

New npm script:

```
"verify:fast:branch": "node scripts/verify-cache.mjs --steps lint,typecheck,config:check,test:hooks,test,test:server,build,test:sidecar --scope-branch"
```

`test:sidecar` is in this list, but — unlike every other step here — it
should remain scope-gated to fire **only** when the branch diff touches
`server/tts-sidecar/**`, even though `--scope-branch` is otherwise just a
speed/diff-basis choice, not an exclusion mechanism. Concretely: pass it
through the same `stepTouchedByDiff` scope check that `--scope-staged`
already uses (verify-cache.mjs:391-399) — `test:sidecar` runs only when
its own step-scope (`server/tts-sidecar/**`) intersects the branch diff;
every other step in the list still always runs (they're fast/CPU-only, no
reason to skip them for speed). This is the one place local pre-push does
real, unconditional model/venv work — deliberately, since that's the
"machine reserved for what needs it" case (§ Goals) — and it runs
automatically (not just a reminder) because a silently-skipped sidecar
regression on the one branch that's actively touching sidecar code is a
worse outcome than the extra local runtime when it fires.

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
to discover. The new `--scope-branch` diff path (`git merge-base HEAD
main` → `git diff --name-only`) and the `test:sidecar`-only scope
exclusion inside a `--scope-branch` run are both new behavior with zero
existing coverage — both need new test cases, mirroring how
`stagedDiffFiles`/`--scope-staged` are already tested.

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
  `pr-issue-link.yml`. Update it to also cover `verify.yml` in the same
  ruleset action (§3), so the manual setup step is done once for both
  rather than as two separate asks of the user.
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
  quietly assume it's done as a side effect of merging code.
- `scripts/tests/verify-cache.test.mjs` needs updating in the same change
  as the `--scope-branch`/`scopeBranch` work (see §4) — flagged here again
  since a plan that treats this as a follow-up rather than in-scope would
  violate CLAUDE.md's testing discipline.
