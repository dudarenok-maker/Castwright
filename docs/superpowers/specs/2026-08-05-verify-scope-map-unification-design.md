---
status: draft
date: 2026-08-05
---

# Verify scope-map unification: one dependency map, one guard

Closes the design work behind **#2119** (ops-19) and **#2120** (ops-20).

> **Revision 3.** This spec has been through **two** rounds of the mandatory
> adversarial review gate. Round 1 found four Critical fail-open defects in
> revision 1 and one placebo mutation. Round 2, briefed to attack round 1's
> *fixes* rather than re-run it, found three more Criticals — including that
> the `ok` sentinel and the new sidecar job were both wired into a `needs:`
> list that does not contain them, so neither would have gated anything.
> §Review findings records both rounds. Every number below has been
> independently re-derived at least twice; every finding was verified against
> the tree before folding.

## Problem

"Which files does this verify step depend on?" is currently answered in
three places, and nothing checks them against each other:

| # | Representation | Consumer |
|---|---|---|
| 1 | `.github/workflows/verify.yml` bash regexes (`:142-176`) | cloud — **the required status check** |
| 2 | `scripts/verify-cache.mjs` `STEPS[].inputs` | local `[cached]`/`[run]` decision |
| 3 | The real module graph + runtime reads | reality |

#2119 is "**1 disagrees with 3**". `launch.mjs` matches no regex at all.
`server/tts-sidecar/scripts/install-qwen3.mjs` sets `sidecar=true`, which
gates only the ffmpeg install and the server TS suite — and a sidecar-only
diff runs **zero** tests there, because that step invokes `vitest --changed`
and no server TS is affected. `pinokio.js` sets `pinokio=true`, which runs
`test:pinokio` — a different suite from the `pinokio-entry.test.mjs` that
loads it. `eslint.config.mjs` sets only `frontend=true`, which does not gate
the Hooks step at all. In each case the required check reports green having
run no leg that covers the change.

#2120 is "**2 disagrees with 3, invisibly**". PR #2117's completeness guard
asserts "every producer a hooks test imports is a cache input", but scans
only test files for their own direct specifiers. It structurally cannot see
transitive edges (`pinokio-scripts/lib/menu.js`, reached via `pinokio.js`) or
runtime reads (`check-no-budget-poll.mjs` scanning `server/src/**/*.test.ts`).

Nobody checks **1 against 2** either. That gap is unowned by either issue and
is the shared cause: fixing the two symptoms independently leaves three maps
and guarantees a fourth instance.

### Further defects found while scoping

None of these appear in either issue. **D** is the most serious thing in this
document.

**A. The guard's resolution step fails open.** `verify-cache.test.mjs:538`
does `if (!existsSync(absProducer)) continue;` — a specifier that does not
resolve *as written* is silently dropped rather than reported. Latent today
(measured: 0 dropped), but it is the "absent reads as clean" shape.

**B. The anti-vacuity floor does not bound the failure it exists to catch.**
The guard asserts `producersScanned >= 30` (`verify-cache.test.mjs:555-558`);
the measured actual is **60 occurrences**. A regression dropping half the
extraction coverage still passes.

**C. `verify.yml` has no sidecar pytest leg at all.** The `sidecar` scope
gates only the ffmpeg install (`:297`) and the server TS suite (`:307`). A
sidecar-only PR runs zero `npm run test:sidecar` on the required check.

**D. `.github/workflows/verify.yml` is in NO step's scope.** Simulating all
nine matchers against the literal path `.github/workflows/verify.yml` yields
**zero matches**, and `.github/**` appears in no STEP's `globs`/`extraFiles`.
So a workflow-only PR runs **no leg at all**, in cloud *or* locally. This is
live today, independent of this work, and it is why revision 1's central
guard would have been decoration: a guard that reads `verify.yml` as evidence
cannot live in a step that never runs when `verify.yml` changes.

## Decisions taken

Six decisions were made explicitly; this spec implements them as stated.

1. **Unify at the cause**, not the two symptoms — one map, one guard.
2. **Split `check-no-budget-poll` into its own verify step** rather than
   widening `test:hooks`' inputs.
3. **Full per-step derivation** of `verify.yml`. *Flagged at design time as
   the highest-blast-radius option; chosen deliberately. §Risks states the
   containment, which revision 2 substantially strengthens.*
4. **Fix the missing sidecar leg (C) in this work** — reaffirmed after review
   showed the naive version would be vacuously green (see §Sidecar leg).
5. **Fold defect D into A1**, since the wiring assertions are worthless
   without it.
6. Everything else the review surfaced is folded rather than deferred, except
   where §Non-goals says otherwise.

## Goals

- A single-file PR touching `launch.mjs`,
  `server/tts-sidecar/scripts/install-qwen3.mjs`, `pinokio.js`,
  `eslint.config.mjs`, or `.github/workflows/verify.yml` runs the leg that
  covers it, on the required check.
- Editing `pinokio-scripts/lib/menu.js`, or adding a budgeted-poll loop to a
  `server/src` test, does not leave `test:hooks` reporting `[cached]`.
- `verify.yml` and `verify-cache.mjs` cannot disagree about a step's inputs,
  because only one of them defines them.
- Every verify-cache STEP is either wired to a CI step or *declared* unwired.
- **No path through the detector can produce a green required check having
  run nothing.**

## Non-goals

- Changing which tests exist, or what any suite asserts (**two** exceptions:
  the one-line `pytest.importorskip` fixes in `test_xtts_audio_io.py` and
  `test_speechbrain_disarm.py` that the sidecar leg requires).
- Re-tuning cache granularity beyond the `check:budget-poll` split.
- Dependency discovery for `server/`'s TS graph. This covers the
  `scripts/tests/*.test.mjs` surface only.
- Unifying *step membership*. `verify:fast:scoped` / `verify:fast:branch`
  hard-code step lists in `package.json` — a fourth list this work does not
  touch. Named in §Residual risk so it is not mistaken for covered.

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
        (local [cached]/[run])     (emits ONE json output + ok sentinel)
                 |                         |
        npm run verify                 verify.yml
        verify:fast:scoped             if: fromJSON(...).step_x || ...shared
        verify:fast:branch             (required status check)
```

### `scripts/ci-scope.mjs` (new)

Imports `STEPS`, reads the changed-file list, and emits **two** outputs:

- `scopes` — a single JSON object, `{"step_test_hooks":true,...}`, consumed
  as `fromJSON(needs.detect.outputs.scopes).step_test_hooks`.
- `ok` — the literal `true`, a sentinel (see below).

**Why one JSON output rather than one output per step.** GitHub requires
every consumed output to be re-declared in the `detect` job's static
`outputs:` map (`verify.yml:94-103`); there is no wildcard. Per-step outputs
would make that block a **third** artifact in the derivation chain, and a key
that `ci-scope.mjs` emits and an `if:` consumes but whose `outputs:` line is
missing or typo'd evaluates to the empty string — silently disabling a leg,
with both directions of the wiring assertion still passing. A single JSON
output makes that block one static line that cannot drift per-key, collapsing
the chain from three artifacts to two.

Two keys are **not** derived from STEPS and are declared explicitly in the
same module, because they have no cache step: `openapi` (gates the CI-only
"OpenAPI types up to date" drift check) and `shared` (the root-manifest
global escape hatch).

**`shared` must remain in every `if:`.** `stepTouchedByDiff` has a lockfile
branch for `server/package-lock.json` only — there is no root-lockfile path,
which is why `computeShared` exists as a separate global override consulted
at `verify-cache.mjs:775`. Measured: a root `package-lock.json` diff touches
**zero** steps; `package.json` touches only `test:pinokio`. So every
condition is `fromJSON(...).step_x || ...shared == 'true'`. Dropping the
`shared` disjunct would make a dependency bump run nothing.

**`workflow_dispatch` emits all-true.** `verify.yml:117-123` special-cases it
today because a dispatch has no PR base to diff. An empty changed-file list
is *not* an error, so the fail-safe below does not fire — without this,
the documented clean-room full-battery run becomes a green no-op, and it is
precisely the escape hatch reached for when scoping is already suspect.

#### Failing safe, on both sides

**Producer side.** On any internal error, `ci-scope.mjs` emits every step
true, warns on stderr, and exits 0. A crash degrades to "run the whole
battery", never "skip everything".

**Consumer side — the part revision 1 missed.** The producer-side fail-safe
shares a failure mode with the thing it guards: it writes the fallback to the
same `GITHUB_OUTPUT` handle. If that handle is unset or unwritable, or the
process exits 0 having written nothing, every output resolves to `''`, every
`if:` is false, every job's *steps* skip, **every job succeeds**, and the
aggregator reports green — it only fails on `failure`/`cancelled`/`skipped`
at the **job** level, and no job is skipped in that scenario.

So the aggregator job (`verify.yml:433`) asserts
`needs.detect.result == 'success' && needs.detect.outputs.ok == 'true'` and
fails otherwise. This is a *consumer-side* check on a different artifact from
the one it validates, which is what makes it independent. `fromJSON('')` also
raises rather than yielding falsy, so a blank `scopes` fails loudly — a
deliberate second line of defence, not the primary one.

> **`detect` must be added to the aggregator's `needs:` for this to work at
> all.** `verify.yml:435` is currently `needs: [lint-and-checks,
> frontend-tests, server-tests, e2e, e2e-visual, build]` — `detect` is *not*
> in it, and the `needs` context exposes only jobs listed there. Without the
> addition, `needs.detect.outputs.ok` is the empty string, `'' == 'true'` is
> false, and the sentinel fails on **every** PR. That is fail-closed and
> self-revealing, but the reflex under a permanently-red required check is to
> delete the sentinel — which silently restores the exact hole it exists to
> close. Adding `detect` is safe against the `contains(needs.*.result,
> 'skipped')` check at `:445`: `detect` carries no job-level `if:` and cannot
> skip.

**Blast radius the collapse creates.** A per-key typo previously disabled one
leg; a broken `scopes` disables all of them at once. That makes the sentinel
a *precondition* of the single-JSON design, not a belt-and-braces extra —
which is why it is specified here rather than filed under containment.

### The trap per-step derivation creates

GitHub evaluates an unknown output reference to the empty string, so a
fat-fingered `if:` silently disables a leg and the required check goes green.
**Derivation is strictly worse than the status quo unless this is closed in
the same change.** It is closed by a set of assertions over the parsed
workflow — two directions in revision 2, **four** after round 2:

| Direction | Assertion | Catches |
|---|---|---|
| **→** | every `fromJSON(...).X` in the YAML is a key `ci-scope.mjs` emits | typos, renamed/deleted steps |
| **←** | every emitted key is referenced by ≥1 `if:` | orphaned steps — defect **C**'s shape |
| **↑** | every **job** containing a derived `if:` appears in the aggregator's `needs:` | a leg that runs, goes red, and gates nothing |

**The ↑ direction is not optional.** `main`'s ruleset pins only the contexts
`'npm run verify'` and `'Verify PR body links a GitHub issue'`. A job absent
from the aggregator's `needs:` can fail without blocking merge — while the ←
direction still certifies its key as *wired* because an `if:` references it.
That is revision 1's sidecar defect reproduced one level up: a leg that
exists, is visible, is certified, and gates nothing. All three directions are
checkable from the same parsed YAML and belong in one test.

**No `KNOWN_UNWIRED` escape hatch.** Revision 2 claimed it would be non-empty
on day one; the mapping table below accounts for all 13 STEPS and marks none
unwired, so it would ship as an **empty, unexercised allowlist** — an
untested bypass is where the next "just add it to `KNOWN_UNWIRED`" quietly
reopens defect C. Unwiring a step therefore requires a code change to the
assertion itself, in a reviewed diff.

**These assertions only work because of the defect-D fix.** `.github/**` must
become an input to the step that runs them *and* match a scope that runs that
step. Without that, the guard cannot run on the PR that breaks it.

### The step↔CI mapping is N:M, not 1:1

Revision 1 assumed a clean 1:1 map. It is not:

| STEP | CI home | Note |
|---|---|---|
| `lint`, `typecheck`, `config:check`, `test:hooks`, `test:pinokio`, `test:scripts`, `build` | one step each | clean |
| `test:server` + `test:server-slow` | **one** step, one `if:` (`:306-318`) | two STEPS share a condition |
| `test:e2e` | **4-way matrix** (`:329`) | one STEP fans out |
| `test:e2e:visual` | one step | clean |
| `test` | frontend step (`:269-275`) runs `vitest --changed` **+** `test:a11y` | not `npm run test`; `test:a11y` has no STEP |
| `test:sidecar` | **a new JOB** (not a step) — see below | defect C |

`test:sidecar` is a **job**, not a step in an existing job, because it needs
its own Python/venv bootstrap. That distinction has opposite gating
consequences and must be stated: a step inside `lint-and-checks` inherits the
aggregator's gate for free; a new job does **not**, and must be added to the
aggregator's `needs:`. The ↑ assertion enforces this.

Seven further `if:`-bearing steps are **setup, not legs** (3× Install ffmpeg,
2× Cache Playwright, 2× Install Playwright) and derive from no STEP. Each
must derive from the **same key as the leg it supports** — if the Playwright
cache/install condition and the e2e run condition diverge, e2e runs without a
browser.

Revision 2 proposed listing these "explicitly rather than pattern-matched",
which is a hand-maintained correspondence between two conditions that must
agree, with nothing checking them — *the document's own thesis, reintroduced
at smaller scale*. Four such pairs live at `verify.yml:346/350/360/364` and
`:393/397/407/411`, each repeating the same disjunct by hand. Instead, each
setup step declares the leg it supports (`# supports: test:e2e`) and a
**fourth assertion** requires its condition to be string-identical to that
leg's.

### Completeness guard, hardened (#2120)

1. **Strip comments before extraction.** Load-bearing, not cosmetic:
   `verify-cache.mjs:107` contains a literal `require('../../pinokio.js')`
   inside a comment that resolves *outside the repo root*. Under fail-closed
   resolution (step 5) that is a false failure. Stripping also retires the
   rule at `verify-cache.test.mjs:498-500` ("do not spell out a literal
   example specifier in this comment") — the constraint disappears rather
   than being documented around.
2. **Resolution candidates**: exact → `.js`/`.mjs`/`.cjs` → **`.js` → `.ts`**
   (`diff-analysis-ab.mjs:248` imports `../server/src/handoff/schemas.js`;
   only the `.ts` exists) → `/index.{js,mjs}`.
3. **Transitive walk**, visited-set cycle guard. Bare specifiers are never
   followed, so `node_modules` is never entered.
4. **Stop rule: `git check-ignore`, not `git ls-files`.** Revision 1 said
   "untracked"; that is clone-state-dependent and wrong three ways. Measured:
   `server/dist/` is gitignored but **present on this box (1,812 files)** and
   **absent on a fresh CI clone**, and
   `repair-cast-id-drift.mjs:1203-1209` statically imports seven
   `../server/dist/**` specifiers. Under "untracked" those resolve locally
   and *fail to resolve* in CI — 7 unresolvable specifiers, i.e. **red on CI,
   green locally**. "Ignored" is a property of `.gitignore`, identical in
   both. It also fixes: a new producer added but not yet `git add`ed (would
   be silently exempt under "untracked", on exactly the commit introducing
   it), `core.ignorecase` differing Windows↔Linux, and submodule gitlinks.

   **Precise ordering** (revision 2's "classify first, resolve second" read
   as circular — you need a path to classify, and producing one is
   resolution). The two operations are different and the distinction is what
   makes it coherent: *path join* is pure string math; *module resolution* is
   extension-candidate probing plus `existsSync`. So:

   > compute each candidate path by **pure path math** (no filesystem) →
   > normalise to POSIX → ask `check-ignore` about **each candidate** →
   > discard ignored candidates → probe the survivors for existence →
   > unresolvable ⇒ fail.

   Classifying *each candidate* rather than once-then-resolving matters
   where a `.gitignore` pattern is file-specific rather than
   directory-prefixed, so classify-once could disagree with what resolution
   lands on. Verified: `git check-ignore server/dist/does/not/exist.js`
   returns 0 — it answers correctly for paths that do not exist, which is
   the property the rule needs.

   **Correction (plan review):** `check-ignore` is **index-aware**, not pure
   `.gitignore` matching. Measured: a file matching an ignore rule but
   force-added to the index reports exit 1 (*not* ignored); `--no-index`
   reports 0. This is kept deliberately — a tracked file is a real producer
   and belongs in the closure — but the simpler "property of `.gitignore`
   alone" framing is wrong and would mislead anyone later tempted to add
   `--no-index`. The `server/dist/**` conclusion is unaffected: never
   tracked, so ignored in a fresh clone and a built tree alike.

   **Exit codes are three-valued, and the contract is explicit** (measured in
   this repo): `0` = ignored, `1` = not ignored, **`128` = error** (e.g.
   `'../pinokio.js' is outside repository`). The 128 case is *not*
   hypothetical — it is triggered by precisely the comment-embedded specifier
   that stripping exists to remove, which makes comment-stripping a
   **precondition** of this rule rather than a peer of it. Treatment: `0` →
   skip, `1` → keep, **`128` or git-unavailable → fail closed** (report, do
   not skip). "Non-zero ⇒ skip" would fail *open*, classifying every
   candidate as ignored wherever git is absent — the "absent reads as clean"
   shape defect **A** is written against.

   **Batched via `--stdin`.** Measured on this box: 81 individual spawns =
   **3972 ms**; one `--stdin` batch = **60 ms** (66×). `test:hooks` runs in
   pre-commit via `verify:fast:scoped`, a path documented as sub-5s — a ~4s
   per-query regression would roughly double it on every commit touching
   `scripts/**`. Batch per BFS level.

   **Paths are POSIX-normalised before the query.** Verified: git normalises
   `server\dist\...` on Windows (returns 0), but on Linux that string is one
   literal filename, matches nothing, returns 1 → classified not-ignored →
   red on CI only. The existing guard already routes through
   `_internals.toPosix` (`verify-cache.test.mjs:544`); the hazard is
   invisible locally by construction.
5. **Unresolvable ⇒ fail**, not `continue` — closes defect **A**. Safe only
   because of steps 1 and 4.
6. **Floor recalibrated against the right metric** — closes defect **B**. The
   current counter measures *occurrences*; the hardened guard walks a closure
   and asserts on *unique files*. Different units; conflating them is how
   defect B arose. See §Measurements.

### `check:budget-poll` split (#2120b)

`check-no-budget-poll.mjs` moves out of `run-hooks-tests.mjs:24-28` into its
own npm script, its own `STEPS[]` entry (globs `server/src/**/*.test.ts`,
extraFiles the script), and its own CI step.

Verified real: `verify:fast:scoped` runs `--steps test:hooks,test,test:server
--scope-staged`, and `test:hooks`' globs (`verify-cache.mjs:56`) exclude
`server/src/**`. So on a server-only staged diff the guardrail that exists to
reject budgeted-poll loops never runs on the commit introducing one. The
split fixes that at ~1s instead of busting the ~25s hooks cache.

### Sidecar leg (defect C) — built properly

Revision 1 claimed the leg "reuses the existing venv-bootstrap path" and
"cannot become a new source of red". Both were false: there is **no** venv
bootstrap in `.github/` at all, and `run-tests.ps1:15` hardcodes
`.venv\Scripts\python.exe`, a Windows-only layout that can never exist on
`ubuntu-latest` — the runner would take the SKIP branch and exit 0 forever.
The ← assertion would then certify it as *wired*, converting a visible hole
into an invisible one. The spec framed that vacuity as a safety property.

The leg is nonetheless cheap, because the suite is designed to run without
the heavy ML stack — `requirements-dev.txt` says so explicitly, and it holds:

- `main.py` imports **no torch** at module level (numpy + fastapi only).
- Enumerating **every** module-scope non-stdlib import across all collected
  `test_*.py` files (`pytest.ini`: `testpaths = tests`, `python_files =
  test_*.py`) yields exactly **two** that are absent from
  `base.txt + requirements-dev.txt`: `torch`
  (`test_xtts_audio_io.py:15`) and **`speechbrain`**
  (`test_speechbrain_disarm.py:37`). Everything else resolves to
  `fastapi`/`numpy`/`pytest`, a local sidecar module, or a sibling test
  module.

`speechbrain` is the one revision 2 missed, because that revision grepped for
*torch specifically* rather than enumerating. It lives in
`requirements/speaker-qa.txt:6`, whose own comment says it is placed there
*"NOT base.txt … because speechbrain needs torch"*. Left alone it is a
**collection error, exit 2, leg red on every PR** — worse than revision 1's
green-forever, because the response to a permanently-red required check is to
disable it.

Revision 2 also mis-cited `requirements-dev.txt` as saying the suite runs
lean. It says the heavy deps and test deps *"stay independently
installable"* — a packaging claim, not a runtime one.

So it needs four things, and no GPU or torch:

1. A **cross-platform test entry point** — resolve `.venv/Scripts/python.exe`
   on Windows, `.venv/bin/python` on POSIX. `npm run test:sidecar`'s existing
   SKIP-on-missing-venv behaviour is retained for *local* use only.
2. **CI bootstrap**: `actions/setup-python`, venv, `pip install -r
   requirements/base.txt -r requirements-dev.txt`, with pip caching.
3. `test_xtts_audio_io.py:15` and `test_speechbrain_disarm.py:37` →
   `pytest.importorskip(...)`, matching the pattern those files already use
   (`test_xtts_audio_io.py:81,99,229`; `test_speaker_embed.py:21`). This is
   the "one exception" in §Non-goals, now **two**.
4. **A hard plan gate: actually run `pytest --collect-only` against a real
   `base.txt + requirements-dev.txt` venv** before the leg is declared cheap.
   Static import inspection is what missed `speechbrain`; it does not get a
   second chance to be the evidence.

**The leg must be able to fail, observed at the right place.** Acceptance
includes a mutation proving a deliberately broken sidecar test turns the
**`'npm run verify'` context** red — not the sidecar job's own status. A
mutator watching the job would see red and wrongly conclude the leg gates,
which is exactly the confusion the ↑ assertion exists to prevent.

## Measurements

Taken at `922cf129`, independently re-derived at `a9f84e10`. A plan step
re-measures rather than trusting these.

> **Read the units.** Three values land on 59–60 while measuring different
> things. Do not carry a number from one row into an assertion about another
> — that conflation *is* defect **B**.

| Quantity | Unit | Value |
|---|---|---|
| Hooks test files | files | 59 |
| **Metric A** — imports scanned by today's guard | *occurrences* | 60 |
| Today's floor (asserts on Metric A) | occurrences | 30 |
| Naive closure, no stop rule | unique files | 81 |
| — missing from `test:hooks` | unique files | 24 |
| — of those, gitignored `server/dist/**` | unique files | 22 |
| **Metric B** — closure with the stop rule | unique files | 59 |
| — genuinely missing | unique files | **2** |
| Specifiers silently dropped today (defect A) | specifiers | 0 (latent) |
| Unresolvable **pre-mitigation**, post-resolver | specifiers | 1 |
| Unresolvable **post** comment-stripping | specifiers | **0** |
| `server/dist` files present locally / on fresh clone | files | 1,812 / 0 |
| Unresolvable under "untracked" rule, CI-simulated | specifiers | 7 |
| Depth-1 closure (M6/M17 counterfactual) | unique files | 56–57 |
| `check-ignore` — 81 spawns vs one `--stdin` batch | ms | 3972 / 60 (66×) |
| Module-scope test imports absent from the lean venv | modules | 2 (`torch`, `speechbrain`) |

The two genuine additions are `pinokio-scripts/lib/menu.js` (the #2120(a)
instance) and `server/src/handoff/schemas.ts`.

**Metric B is 59–60 depending on predicate**, and the plan review measured
the upper end. The difference is real and explainable: `ls-files` ("tracked")
excludes a file that is untracked but *not* ignored, while `check-ignore`
("ignored") includes it — so the shipped predicate counts marginally more.
Immaterial against a floor of 50, but **do not assert an exact count**; the
load-bearing assertion is the *identity* of the missing files (exactly two),
which both measurements agree on.

**Floor rule.** The hardened guard asserts on **Metric B**. The floor catches
*extraction or resolution breakage*, whose signature is a collapse toward
zero — not a legitimate one- or two-file removal. Set it at **50** (~15%
headroom under 59). The assertion message states observed *and* expected, so
a genuine drop is diagnosable rather than merely red.

**Note for M9.** Post-hardening there is **no live unresolvable case** (the
count goes 1 → 0). M9 therefore needs a synthetic fixture; asserting against
the real tree would be vacuous.

## Testing

Every new guard ships with a **named mutation** that makes it go red.

| # | Mutation | Must go red with |
|---|---|---|
| M1 | rename an emitted key in `ci-scope.mjs` | → direction |
| M2 | add `fromJSON(...).step_nope` to `verify.yml` | → direction |
| M3 | unwire a step's CI home | ← direction (defect C's shape) |
| M4 | make the YAML parse return nothing | wiring anti-vacuity floor |
| M5 | drop `pinokio-scripts/lib/menu.js` from extraFiles | completeness guard, naming that path |
| M6 | **M5 held, walk limited to depth 1** | guard goes **GREEN** — see below |
| M7 | remove comment-stripping | false positive on `../../pinokio.js` |
| M8 | swap stop rule to "untracked", simulate fresh clone | 7 unresolvable `server/dist` specifiers |
| M9 | revert unresolvable→fail to `continue` | resolver unit test, synthetic fixture |
| M10 | throw inside `ci-scope.mjs` | fail-safe emits all-true, exit 0 |
| M11 | break the extraction regex so it matches nothing | Metric B floor, message citing observed vs expected |
| M12 | make `ci-scope.mjs` exit 0 writing nothing | **aggregator `ok` sentinel** |
| M13 | make a sidecar test fail on ubuntu | the **`'npm run verify'` context** turns red (not merely the sidecar job) |
| M14 | edit only `.github/workflows/verify.yml` | the wiring assertions actually run (defect D) |
| M15 | remove a job from the aggregator's `needs:` | **↑ direction** |
| M16 | diverge a setup step's `if:` from its leg's | **setup-binding assertion** |
| M17 | **delete the transitive walk, both declarations left in place** | walk fixture (see below) |
| M18 | make `check-ignore` return 128 / remove git | stop rule fails **closed**, not open |

**M6 is inverted from revision 1, which had it backwards.** Revision 1
claimed a depth-1 walk goes red on its own. It cannot: a depth-1 closure is a
*subset* of the full closure, the full closure has zero missing once the two
declarations land, so the subset also has zero missing. Measured: depth-1
closure = 56, clears the floor of 50, `missing = []` — **green**. That is the
"detector shipped alongside the declaration that satisfies it" placebo shape.
Recursion is load-bearing only in combination: **M5 under a full walk is RED;
M5 under depth-1 is GREEN.** The pair is the proof; neither half alone is.

**M17 exists because the M5-pair alone still leaves the walk unfalsifiable.**
Run the counterfactual: if PR B declared both files in `extraFiles` and
shipped **no walk at all**, the closure is depth-1 = 56, clears the floor of
50, `missing = []` → green. So after PR B merges, the walk could be deleted
at any time with the entire battery green. The placebo did not die in
revision 2; it moved from a named mutation to the guard's *steady state*.

The spec already applies the correct remedy elsewhere — §Measurements' note
for M9 reasons that a live case neutralised by the fix needs a **synthetic
fixture**. The identical reasoning applies here, and revision 2 failed to
apply it. M17 is therefore a unit test over a **temp fixture tree** in which
a depth-2 producer must be discovered, independent of the real repo's
declarations.

*(Rejected alternative: raising the floor to 57 would make the floor itself
catch walk deletion, since 56 < 57. Rejected because it buys detection by
removing all headroom — legitimately deleting two hooks tests would then go
red. Worth naming, because choosing 50 is choosing to make the floor blind to
the one regression it could otherwise catch cheaply.)*

### Acceptance

- **#2119** — table-driven over `launch.mjs`,
  `server/tts-sidecar/scripts/install-qwen3.mjs`, `pinokio.js`,
  `eslint.config.mjs`: each yields `step_test_hooks` true.
- **#2120** — the issue explicitly rejects `stepTouchedByDiff` as sufficient
  proof, because PR #2117 showed it and the real decision are different code
  paths. Tests drive the **real `[cached]`/`[run]` decision** through
  `selectStepFiles` + `composeInputHash` + `decide`.
- **Defect C** — a sidecar-only diff runs a sidecar leg that *can* fail (M13).
- **Defect D** — a `.github/workflows/`-only diff runs the wiring assertion.

New tests must be wired into `extraFiles` **and** into a scope that runs
them, or they are not gated.

## PR shape

**Three PRs, sequential.** Revision 2 had two; A was split because it
contained both a guard and that guard's own precondition — which is why its
Risks section had to concede self-validation circularity.

| PR | Closes | Contents | Touches scope computation? |
|---|---|---|---|
| **A1** | Refs #2119 | **defect D fix** (`.github/**` into `test:hooks`' inputs + a matching scope) and the **sidecar job** (with `importorskip` fixes + aggregator `needs:`) | **No** — purely additive |
| **A2** | Closes #2119 | `ci-scope.mjs`, `scopes`/`ok` outputs, `verify.yml` derivation, the **four** assertions (→ ← ↑ setup-binding) | **Yes** |
| **B** | Closes #2120 | comment-stripping, resolver, transitive walk + `check-ignore` stop rule, fail-closed, floor recalibration, walk fixture, `check:budget-poll` split, the 2 declarations | No |

**Why A1 first — it de-circularises A2.** With `.github/**` already in scope,
A2's wiring assertions genuinely run on A2's own PR. Revision 2 could only
*narrow* the circularity and fall back on "inspect PR A's run by hand"; A1
removes it for the defect-D case outright. A1 is also purely additive —
neither part changes how scope is *computed*, only what runs — so each half
is independently revertable.

**Why A2 before B**, in strength order: (1) B adds a `STEPS[]` entry that A2's
← assertion requires be wired; B-first opens a window where it is silently
unwired. (2) B's floor is calibrated against a Metric B that A2 does not
change. (3) Both touch `verify-cache.mjs`. Revision 1 gave only (3), the
weakest.

**Revert units now match risk units.** Under revision 2's shape, reverting A
after B landed would have reverted B's CI wiring with it, leaving B's step
unwired against restored bash regexes. A1/A2/B does not have that coupling.

## Risks

**A2 rewrites the required status check.** (A1 does not — it only adds.)
Containments:

1. **Producer fail-safe** — any thrown error degrades to run-everything.
2. **Consumer sentinel** — the aggregator fails if `ok != 'true'`, catching
   the wrote-nothing class the producer fail-safe cannot.
3. **A2 validates itself.** The GitHub semantics claim is correct:
   `pull_request` (unlike `pull_request_target`) runs the workflow from the
   PR's merge ref. **But it is circular against computed-false**: if
   `ci-scope.mjs` computes `step_test_hooks=false` incorrectly, the assertion
   never runs on the PR introducing it. The sentinel and the defect-D fix
   narrow this; **A1 removes it for the defect-D case outright**, which is
   the main reason the split exists. Residual mitigation: A2's own CI run is
   inspected by hand against an expected leg list before merge.
4. **Rollback is one revert.**

**The pinned check name is a hard constraint.** `main`'s ruleset 17654264
pins `required_status_checks` to the contexts `'npm run verify'` and
`'Verify PR body links a GitHub issue'`. `'npm run verify'` is the aggregator
job's `name:` (`verify.yml:434`). Therefore, **inviolably**:

- the aggregator job's `name:` must not change — renaming it detaches the
  gate, and every subsequent PR merges with no check at all;
- conditions stay at **step** level, never hoisted to **job** level. "Every
  `if:` reads a derived output" reads as licence to hoist; hoisting makes
  scoped-down PRs skip jobs, and the aggregator fails on `skipped`
  (`:445`) — turning the required check red on every PR;
- **every job carrying a derived `if:` is in the aggregator's `needs:`.**
  Revision 2 stopped at the first two and thought them sufficient; they are
  not. A job outside that list can run, fail, and not block merge, because
  the ruleset requires only the aggregator's context. This is the ↑
  assertion's whole reason for existing, and it is why the sidecar job —
  added to *fix* a gating hole — would otherwise have reproduced it.

Revision 1 mentioned none of these, despite `verify.yml:49-54` warning about
the pinned name in-file.

**Merge tripwire for in-flight PRs.** Once A lands, the ← direction makes any
future PR that adds a `STEPS[]` entry red until it also wires `verify.yml`.
Five PRs are open (#2116, #2118, #2122, #2124, #2125). This is intended
behaviour, but it is a repo-wide behaviour change and should be announced,
not discovered.

### Residual risk

- A step whose `if:` is correct but whose *inputs* are wrong still skips
  silently. The wiring assertion proves wiring, not input correctness; the
  completeness guard covers input correctness only for `scripts/tests`.
  `test`, `test:server`, `build` keep hand-maintained inputs.
- **A fourth list survives.** `verify:fast:scoped` / `verify:fast:branch`
  hard-code step *lists* in `package.json` (`verify:fast:branch` runs
  `test:sidecar` but not `test:pinokio` or `test:scripts`). "One map" covers
  step *inputs*, not step *membership*. Out of scope; recorded so it is not
  mistaken for solved.

## Review findings

Revision 1 went through the mandatory Premium-tier `assumption-checker` gate.
Findings folded, all independently verified against the tree before
acceptance:

| Finding | Severity | Disposition |
|---|---|---|
| Wiring assertion covered 2 of 3 artifacts (`outputs:` map) | Critical | single JSON output collapses the chain to 2 |
| `verify.yml` in no step's scope (defect D) | Critical | folded into PR A |
| Sidecar leg vacuously green on ubuntu | Critical | real leg: setup-python + venv + the `importorskip` fix |
| Fail-safe had no consumer-side check | Critical | `ok` sentinel asserted by the aggregator |
| `workflow_dispatch` unaddressed | Major | explicit all-true |
| Stop rule clone-state-dependent | Major | `check-ignore`, classify-before-resolve |
| M6 was a placebo | Major | inverted; M5-pair is the proof |
| Mapping assumed 1:1 | Major | N:M table; `KNOWN_UNWIRED` non-empty |
| `shared` dropped by per-step outputs | Major | `shared` disjunct mandatory |
| Pinned check name unmentioned | Major | hard constraint in §Risks |
| Self-validation circular | Significant | stated honestly + manual inspection |
| Unresolvable-count unit ambiguity | Minor | split pre/post rows; M9 needs a fixture |
| "`sidecar=true` runs pytest" contradicted defect C | — | corrected in §Problem |
| `:497` off-by-one citation | — | corrected to `:498-500` |

Claims that **survived** re-derivation: every measurement in revision 1's
table; that comment-stripping and the `.js`→`.ts` resolver are load-bearing;
that `launch.mjs`/`eslint.config.mjs`/`pinokio.js` are routed as described;
that `pull_request` uses the PR's own workflow file; and that the
`check:budget-poll` split fixes a real hole.

### Round 2 — attacking revision 2's fixes

Round 2 was briefed to attack the six fixes rather than re-run round 1. It
found three Criticals, all verified here before folding.

| Finding | Severity | Disposition |
|---|---|---|
| `detect` is **not** in the aggregator's `needs:` — the `ok` sentinel reads empty on every PR | Critical | add `detect`; assert `result == 'success'` too |
| A new sidecar **job** outside `needs:` runs, fails, and gates nothing — while ← certifies it wired | Critical | ↑ assertion; sidecar declared a job; M13 pinned to the `'npm run verify'` context |
| `speechbrain` is a module-scope import absent from the lean set → collection error, leg red forever | Critical | second `importorskip`; **plan gate: run real collection** |
| The walk is still unfalsifiable — deleting it leaves the battery green | Major | M17 synthetic fixture; floor-57 alternative named and rejected |
| Setup steps were a fourth unchecked map | Major | `# supports:` declaration + binding assertion |
| `check-ignore` exit codes are three-valued (`128` real) | Major | explicit contract, fail closed on 128 |
| Per-query `check-ignore` costs 3972 ms vs 60 ms batched (66×) | Major | `--stdin`, batched per BFS level |
| `KNOWN_UNWIRED` contradicted the mapping table; would ship unexercised | Major | **removed** |
| Windows path separators classify differently on Linux | Minor | POSIX-normalise before query |
| `fromJSON` typo hole is relocated, not closed | Minor | → assertion pins the syntax form; first `fromJSON` use in the repo |
| `:108-109` citation off by one | Minor | corrected to `:107` |

Fixes that **survived** round 2: the single-JSON collapse (the narrower claim
— that the third artifact disappears — holds); the `check-ignore` stop rule
against the circularity charge (path-join and module-resolution are genuinely
different operations, and `check-ignore` does answer for non-existent paths);
the M6 inversion; the N:M mapping table; and `main.py` being genuinely
torch-free at module scope.

## Ship notes

_(unfilled — to be completed when both PRs merge)_
