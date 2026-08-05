---
status: draft
date: 2026-08-05
---

# Verify scope-map unification: one dependency map, one guard

Closes the design work behind **#2119** (ops-19) and **#2120** (ops-20).

## Problem

"Which files does this verify step depend on?" is currently answered in
three places, and nothing checks them against each other:

| # | Representation | Consumer |
|---|---|---|
| 1 | `.github/workflows/verify.yml` bash regexes (`:142-180`) | cloud — **the required status check** |
| 2 | `scripts/verify-cache.mjs` `STEPS[].inputs` | local `[cached]`/`[run]` decision |
| 3 | The real module graph + runtime reads | reality |

#2119 is "**1 disagrees with 3**": `launch.mjs` matches no regex at all, so a
PR changing only that file runs no leg that tests it, and the required check
reports green. `server/tts-sidecar/scripts/install-qwen3.mjs` sets
`sidecar=true`, which runs pytest — not the `test:hooks` suite that actually
covers it. `pinokio.js` sets `pinokio=true`, which runs `test:pinokio` — a
different suite from the `pinokio-entry.test.mjs` that loads it.
`eslint.config.mjs` sets only `frontend=true`, which does not gate the Hooks
step at all.

#2120 is "**2 disagrees with 3, invisibly**". PR #2117's completeness guard
asserts "every producer a hooks test imports is a cache input", but it scans
only test files for their own direct specifiers. It structurally cannot see
transitive edges (`pinokio-scripts/lib/menu.js`, reached via `pinokio.js`) or
runtime reads (`check-no-budget-poll.mjs` scanning `server/src/**/*.test.ts`).

Nobody checks **1 against 2** either. That gap is unowned by either issue and
is the shared cause: fixing the two symptoms independently leaves three maps
and guarantees a fourth instance.

### Two further defects found while scoping this

Neither appears in either issue.

**A. The guard's resolution step fails open.** `verify-cache.test.mjs:538`
does `if (!existsSync(absProducer)) continue;` — a specifier that does not
resolve *as written* is silently dropped rather than reported. Currently
latent (measured: 0 specifiers skipped), but it is the "absent reads as
clean" shape that has bitten this repo repeatedly.

**B. The anti-vacuity floor does not bound the failure it exists to catch.**
The guard asserts `producersScanned >= 30`; the measured actual is **60
occurrences**. A regression that silently dropped *half* the extraction
coverage would still pass green.

**C. `verify.yml` has no sidecar pytest leg at all.** The `sidecar` scope
gates only the ffmpeg install and the server TS suite. A sidecar-only PR runs
zero `npm run test:sidecar` on the required check. This is a third instance
of #2119's exact shape, found while enumerating the step↔scope mapping.

## Decisions taken

Four decisions were made explicitly during design; this spec implements them
as stated rather than re-opening them.

1. **Unify at the cause**, not the two symptoms — one map, one guard.
2. **Split `check-no-budget-poll` into its own verify step** rather than
   widening `test:hooks`' inputs, so a server-test edit does not bust the
   ~25s hooks cache.
3. **Full per-step derivation** of `verify.yml` — the nine scope booleans are
   retired; every `if:` references a derived per-step output. *(Flagged at
   design time as the highest-blast-radius option, since it rewrites the
   required check; chosen deliberately. §Risks states the containment.)*
4. **Fix the missing sidecar leg in this work** rather than filing it.

## Goals

- A single-file PR touching `launch.mjs`,
  `server/tts-sidecar/scripts/install-qwen3.mjs`, `pinokio.js`, or
  `eslint.config.mjs` runs the leg that covers it, on the required check.
- Editing `pinokio-scripts/lib/menu.js`, or adding a budgeted-poll loop to a
  `server/src` test, does not leave `test:hooks` reporting `[cached]`.
- `verify.yml` and `verify-cache.mjs` cannot disagree about a step's inputs,
  because only one of them defines them.
- Every verify-cache STEP is either wired to a CI step or *declared*
  unwired — never silently unwired.

## Non-goals

- Changing which tests exist, or what any suite asserts.
- Re-tuning cache granularity beyond the `check:budget-poll` split.
- Solving dependency discovery for `server/`'s TS graph. This work covers the
  `scripts/tests/*.test.mjs` surface only.

## Architecture

`scripts/verify-cache.mjs`'s `STEPS[]` becomes the single source of truth.
Each STEP gains a `ci` field naming its CI home. `verify.yml` stops deciding
scope and starts *reading* it.

```
                   STEPS[] in verify-cache.mjs
                    (globs + extraFiles + ci)
                              |
                 +------------+------------+
                 |                         |
        stepTouchedByDiff          scripts/ci-scope.mjs
        (local [cached]/[run])     (emits step_<slug>=bool)
                 |                         |
        npm run verify                 verify.yml
        verify:fast:scoped             every `if:` reads an output
        verify:fast:branch             (required status check)
```

### `scripts/ci-scope.mjs` (new)

Imports `STEPS`, reads the changed-file list, and for each step emits
`step_<slug>=true|false` in `GITHUB_OUTPUT` format, computed with the same
`stepTouchedByDiff` + `computeShared` the local cache uses. Slug = step name
lowercased with `:` and `-` → `_` (`test:e2e:visual` → `step_test_e2e_visual`).

Two keys are **not** derived from STEPS and are declared explicitly in the
same module, because they have no cache step:

- `openapi` — gates the "OpenAPI types up to date" drift check, which is
  CI-only.
- `shared` — the root-manifest global escape hatch.

**Fail-safe (load-bearing).** On *any* internal error — unreadable file, bad
parse, unknown step — `ci-scope.mjs` emits **every key true**, prints a
warning to stderr, and exits **0**. It must never exit non-zero and must
never emit all-false. A crash degrades to "run the whole battery", never to
"skip everything". Without this, one bad commit to a script blocks merges
repo-wide.

### The trap this creates, and how it is closed

GitHub Actions evaluates an **unknown** `needs.detect.outputs.X` to the empty
string. So `needs.detect.outputs.step_test_hooks_typo == 'true'` is simply
`false`: the step never runs, the required check goes **green**, and nothing
errors. Today a typo'd bash variable is at least visible in the `scope k=`
echo; after derivation, a renamed step or fat-fingered `if:` silently
disables a leg of the required check.

**Per-step derivation is strictly worse than the status quo unless this is
closed in the same change.** It is closed by a bidirectional wiring assertion
over the parsed workflow:

| Direction | Assertion | Catches |
|---|---|---|
| **→** | every `needs.detect.outputs.X` in the YAML is a key `ci-scope.mjs` emits | typos, renamed steps, deleted steps |
| **←** | every emitted key is referenced by ≥1 `if:`, or listed in `KNOWN_UNWIRED` with an issue ref | orphaned steps — defect **C**'s shape |

`KNOWN_UNWIRED` is **empty** once the sidecar leg lands, so the ← direction
starts fully strict. It exists so a future unwired step must be declared in a
reviewed diff rather than going quietly missing.

Both directions carry an anti-vacuity floor calibrated to **measured**
counts, not round numbers — see defect **B**.

### Completeness guard, hardened (#2120)

`scripts/tests/verify-cache.test.mjs`'s guard gains, in order:

1. **Comment stripping before extraction.** Load-bearing, not cosmetic: the
   existing regexes match specifiers inside comments, and
   `verify-cache.mjs`'s own comment contains a literal
   `require('../../pinokio.js')`. Under fail-closed resolution (step 4) that
   would be a *false failure*. Stripping comments also retires the awkward
   rule at `verify-cache.test.mjs:497` ("do not spell out a literal example
   specifier in this comment") — the constraint disappears instead of being
   documented around.
2. **Resolution candidates**: exact → `.js`/`.mjs`/`.cjs` → **`.js` → `.ts`**
   (TS emits `.js` specifiers for `.ts` sources; `scripts/diff-analysis-ab.mjs`
   imports `../server/src/handoff/schemas.js`) → `/index.{js,mjs}`.
3. **Transitive walk** with a visited-set cycle guard, following resolved
   relative specifiers recursively. Bare specifiers (`node:fs`, `archiver`)
   are never followed, so `node_modules` is never entered.
4. **Stop rule: do not follow git-untracked paths.** This is what makes the
   walk correct rather than merely complete —
   `scripts/repair-cast-id-drift.mjs:1203` dynamically imports
   `../server/dist/**` inside `main()`, and its test deliberately injects
   stand-ins instead. `server/dist/` is gitignored build output; declaring it
   as a cache input would be meaningless (missing on a clean checkout) and
   noisy (regenerated by every build).
5. **Unresolvable ⇒ fail**, not `continue` — closes defect **A**. Safe only
   because of step 1.
6. **Floor recalibrated against the right metric** — closes defect **B**.
   The current counter measures *occurrences* (one per `(test file,
   specifier)` pair); the hardened guard walks a closure and should assert on
   *unique tracked files*. These are different units and must not be
   conflated — conflating them is how defect **B** arose. See §Measurements
   for the unit-tagged values and the floor rule.

### `check:budget-poll` split (#2120b)

`check-no-budget-poll.mjs` moves out of `run-hooks-tests.mjs:24-28` into its
own npm script, its own `STEPS[]` entry (globs `server/src/**/*.test.ts`,
extraFiles the script itself), and its own CI step.

This is not merely bookkeeping. Today, on a **server-only staged diff**,
`verify:fast:scoped` skips `test:hooks` outright — so the guardrail that
exists to reject budgeted-poll loops never runs on the very commit
introducing one. Splitting it fixes that, and costs ~1s instead of busting
the ~25s hooks cache on the repo's hottest surface.

### Sidecar leg (defect C)

`verify.yml` gains a sidecar pytest step wired to `test:sidecar`. It reuses
the existing venv-bootstrap path and retains `npm run test:sidecar`'s
SKIP-and-exit-0 behaviour on an unbootstrapped venv, so it cannot become a
new source of red on runners without the venv.

## Measurements

Taken against the tree at design time (commit `922cf129`). These are the
numbers the floors and the expected-delta assertions are calibrated to; a
plan step re-measures rather than trusting them.

> **Read the units.** Three of these values land on 59–60 while measuring
> different things. Do not carry a number from one row into an assertion
> about another — that conflation *is* defect **B**.

| Quantity | Unit | Value |
|---|---|---|
| Hooks test files | files | 59 |
| **Metric A** — imports scanned by today's guard | *occurrences* | 60 |
| Today's anti-vacuity floor (asserts on Metric A) | occurrences | 30 |
| Naive transitive closure, no stop rule | unique files | 81 |
| — missing from `test:hooks` | unique files | 24 |
| — of those, gitignored `server/dist/**` artifacts | unique files | 22 |
| **Metric B** — closure **with** git-tracked stop rule | unique files | 59 |
| — genuinely missing from `test:hooks` | unique files | **2** |
| Unresolvable specifiers (comment / `.js`→`.ts`) | specifiers | 2 |

The two genuine additions are `pinokio-scripts/lib/menu.js` (the #2120(a)
instance) and `server/src/handoff/schemas.ts`.

**Floor rule.** The hardened guard asserts on **Metric B**. The floor exists
to catch *extraction or resolution breakage*, whose signature is a collapse
toward zero — not a legitimate one- or two-file removal. Set it at **50**
(~15% headroom under the measured 59): low enough that removing a few hooks
tests does not cause spurious red, high enough that losing even a fifth of
the closure fails. The plan **re-measures** rather than trusting 59, and the
assertion message states both the observed and expected values so a genuine
drop is diagnosable rather than merely red.

## Testing

Every new guard ships with a **named mutation** that makes it go red. A guard
that cannot be shown failing is not a guard.

| # | Mutation | Must go red with |
|---|---|---|
| M1 | rename an emitted key in `ci-scope.mjs` | → direction, naming the orphaned `if:` |
| M2 | add `outputs.step_nope` to `verify.yml` | → direction |
| M3 | unwire a step's CI home | ← direction (defect C's shape) |
| M4 | make the YAML parse return nothing | anti-vacuity floor |
| M5 | drop `pinokio-scripts/lib/menu.js` from extraFiles | completeness guard, naming that path |
| M6 | limit the walk to depth 1 | same — proves recursion is load-bearing |
| M7 | remove comment-stripping | false positive on `../../pinokio.js` |
| M8 | follow git-untracked paths | 22 `server/dist/**` entries |
| M9 | revert unresolvable→fail to `continue` | resolver unit test |
| M10 | throw inside `ci-scope.mjs` | fail-safe emits all-true, exit 0 |
| M11 | break the extraction regex so it matches nothing | Metric B floor, message citing observed vs expected |

M6 and M11 deliberately target *different* assertions: a depth-1 walk still
clears the Metric B floor, so only the missing-input assertion catches it,
while a dead regex collapses the closure and only the floor catches it.
Neither alone demonstrates the guard works.

### Acceptance

- **#2119** — table-driven over the four cited paths (`launch.mjs`,
  `server/tts-sidecar/scripts/install-qwen3.mjs`, `pinokio.js`,
  `eslint.config.mjs`): each must yield `step_test_hooks=true`.
- **#2120** — the issue explicitly rejects `stepTouchedByDiff` as sufficient
  proof, because PR #2117 showed it and the real decision are different code
  paths. The test therefore drives the **real `[cached]`/`[run]` decision**
  through `selectStepFiles` + `composeInputHash` + `decide`: editing
  `menu.js`, and adding a budgeted-poll loop to a `server/src` test, must
  both come back `[run]`.
- **Defect C** — a sidecar-only diff yields `step_test_sidecar=true`.

New tests must be wired into the verify-cache `extraFiles` and `verify.yml`'s
own coverage, or they are not gated.

## PR shape

Two PRs, **sequential** — both touch `verify-cache.mjs` (A adds the `ci`
field, B adds a STEP), so running them in parallel invites a conflict on the
one file that must stay coherent.

| PR | Closes | Contents |
|---|---|---|
| **A** | #2119 | `ci-scope.mjs`, `verify.yml` per-step derivation, bidirectional wiring assertion, sidecar pytest leg |
| **B** | #2120 | comment-stripping, resolver, transitive walk + stop rule, fail-closed, floor recalibration, `check:budget-poll` split, the 2 new declarations |

## Risks

**PR A rewrites the required status check.** This is the dominant risk and it
was accepted knowingly. Three things contain it:

1. **The fail-safe** degrades any `ci-scope.mjs` failure to *run everything*,
   never to *skip everything*.
2. **PR A validates itself.** `pull_request` runs use the workflow file from
   the PR's own merge ref, so the derived workflow is exercised on PR A
   before it can affect any other PR. The PR touches `scripts/` and
   `.github/`, so the hooks and scripts legs are in scope for its own run.
3. **Rollback is one revert** of a self-contained commit.

**Residual risk:** a step whose `if:` is *correct* but whose derived inputs
are *wrong* still skips silently. The bidirectional assertion proves wiring,
not input correctness; input correctness is what the completeness guard in
PR B covers, and only for the `scripts/tests` surface. Steps outside that
surface (`test`, `test:server`, `build`) keep hand-maintained inputs and are
out of scope here.

**Ordering risk:** if PR B lands first, the `check:budget-poll` STEP exists
with no CI home and the ← assertion — which PR A introduces — is not yet
present to catch it. Landing A first avoids the window entirely.

## Ship notes

_(unfilled — to be completed when both PRs merge)_
