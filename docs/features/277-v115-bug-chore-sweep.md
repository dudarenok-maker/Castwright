---
status: active
shipped: null
owner: null
---

# 277 — v1.15 bug & chore sweep: triage and round plan

> Status: active — **Round 1 SHIPPED 2026-08-01** (four lanes, 12 issues),
> **Round 2 SHIPPED 2026-08-05** (five lanes, 16 issues), **Round 3 RAN
> 2026-08-05** (design-first; four PRs, four issues closed, five items left
> needing design), **Round 4 DRAINED INCREMENTALLY 2026-08-11 → 2026-08-28**
> (17 of 53 tracked items closed since 08-25 alone; #898 phase 2 still not
> dispatched after three rounds; none of this sweep's own Group 8 on-box items
> were hit despite a parallel on-box acceptance campaign actively running
> waves 6–9 in the same window), and
> **Round 5 PLANNED 2026-08-28** (seven waves; 58 real open items after
> excluding live agent-instruction children). See "Round 1 outcome" through
> "Round 5 — the recut plan" below. Round 2's carries seven cases of a guard
> or test reporting green while checking nothing; Round 3's carries the
> finding that **four of ten issue premises did not survive verification**,
> and the cold-brief handoff that caught what self-review structurally cannot;
> Round 4's carries a **self-replicating "register mechanics" ticket family**
> (a fix's own closure orphaning the next ticket) and the finding that **6 of
> 8 newly-filed items read as diffs but are filed as decisions**.
> Key files: this document is a coordination record, not a feature plan. The
> per-item detail lives in each linked GitHub issue, which stays canonical.
> URL surface: none
> OpenAPI ops: none

## Benefit / Rationale

- **User:** v1.15 ships with the accumulated bug/chore debt cleared rather than
  carried, so the release is not a feature layer on top of 54 open defects.
- **Technical:** the triage below is the expensive part — deciding what is
  genuinely blocked, what is on-box gated, and what can be bundled into
  non-colliding parallel lanes. Re-deriving it costs a full session of `gh`
  queries and issue reads. This document is that derivation, persisted.
- **Architectural:** the lane grouping encodes the scope-discipline constraint
  (no two concurrent lanes touch the same file) for this specific queue. It is
  the input a future round needs in order to dispatch safely.

## Baseline

Taken on `main` @ `36d14584`, 2026-08-01. Repo at v1.14.0 cut;
`RELEASE_NOTES.md` accumulating v1.15.0.

**54 open items: 17 `bug` + 37 `type:chore`.** They partition as:

| Bucket | Count | Schedulable for v1.15? |
|---|---|---|
| Blocked (upstream / hardware / date-gated) | 11 | No |
| In flight under concurrent sessions | 6 | No — collision risk |
| On-box gated (needs GPU box + real books) | 7 | Code yes, acceptance no |
| Actionable — Round 1 | 13 | Yes |
| Actionable — Round 2 | 8 | Yes |
| Design-first — Round 3 (phase-1 pass each) | 9 | Ticket + plan, not a diff |

The arithmetic closes: 11 + 6 + 7 + 13 + 8 + 9 = 54.

## Excluded — genuinely blocked (11)

Not schedulable. Each is blocked on something outside this repo.

| # | Item | Blocked on |
|---|---|---|
| 1228 | side-23 transformers ≥5.3.0 (CVE-2026-4372) | qwen-tts upstream support |
| 893 | side-17 sidecar engine-dep major bump | torchaudio EOL @2.11 — tracking |
| 711 | ops-14 eslint 9→10 | upstream `@eslint/js` |
| 431 | srv-4 deprecation chains (jsdom · archiver · @google/genai) | upstream — tracking |
| 790 | ops-17 companion off KGP-applying plugins | Flutter / AGP 9 upstream |
| 1477 | ops-27 TypeScript 7.0 native compiler | "once ecosystem catches up" |
| 1335 | AMD GPU Phase 2 acceptance | ROCm hardware not owned |
| 822 | ops-16 Pinokio installer acceptance | needs a macOS box |
| 1001 | side-22 FlashAttention-2 from source | no cp312 / torch2.11 / cu128 wheel path |
| 1966 | ops-48 evaluate `@nanonets/graft` | issue says revisit after **2026-08-14** |
| 947 | ops-18 large-region visual diff | issue: "Out of scope until [a real regression is observed]" |

## Excluded — in flight under concurrent sessions (6)

Four other worktrees were live at triage time. **Do not dispatch into these.**

| # | Item | Worktree / PR |
|---|---|---|
| 2017 / 2038 | spacy missing → cloned Coqui 500s; Japanese SudachiPy | `wt-spacy-text-splitting` → PR #2039 |
| 2023 / 2040 | orphaned characterId → silent narrator substitution | `wt-orphaned-characterid-fallback` |
| 2000 / 1826 | cast.json + voice-library write locking | `wt-1981-cast-lock` |

Also live and unrelated to this queue: `wt-plan-276-clone-readiness`,
`feat+fs38-wave3c-fe`, `feat+server-fs59-cjk-w5`, `chore/fs38-followups-c`,
`docs/fs35-ship-notes`.

## Excluded — on-box gated (7)

The code can ship; acceptance cannot happen at PR time. Per the Before-shipping
checklist these convert to `docs/testing/onbox-acceptance-register.md` rows
rather than blocking a merge — but there is no point dispatching a coding agent
at them, because the deliverable is a measurement.

- **#2026** — XTTS Russian quality: neuter `-ее` mispronounced, leading dialogue
  em-dash gives no pause, rare language collapse. Reproduces on a stock
  catalogue voice, so it is engine-level, not clone-related.
- **#1998** — a cloned voice on XTTS loses most of its identity rendered in a
  language other than the source clip's (0.600 → 0.229).
- **#1084** + **#1527** — ASR content-QA thresholds never tuned or validated for
  non-English; `maxWer: 0.4` is an English-tuned cap.
- **#1685** — verify #1682 cloud request sizing on-box.
- **#1600** — fs-61 backfill designed voices + covers onto the zh/ja Coalfall
  placeholder samples (needs the Qwen VoiceDesign pipeline on a GPU box).
- **#1976** — **status check owed, not work.** Its admission-side reclaim may
  already have shipped; confirm before scheduling anything against it.

## Round 1 — four parallel lanes, 13 issues

Grouped so no two lanes touch the same file. All are code-complete at PR time,
all clear the incidental-findings fix-now shape, none need a design thread.

Ordering rationale: **#2028 and #2030 remove false-green and flake classes that
Rounds 2–3 would otherwise run headfirst into**, so they go first.

### Lane 1 · `chore/sidecar-golden-gate-fidelity`

**Status: shipped, PR #2045.** All three issues landed; independent Opus
review of the PR returned seven findings (six requiring follow-up commits on
the same branch, one — the `hasattr` narrowness objection — cleared on
inspection). Notably, the #2035 guard's first revision shipped as an
exact-equality refusal on `identity`/`loudness_dbfs`, which review found
refuses on every honest re-bless (those are raw stochastic measurements, not
quantised thresholds like `tolerances`) — replaced with a noise-tolerant
hybrid (echo-and-accept below an epsilon, refuse above it) before merge. See
the PR for the full finding-by-finding record.

Files: `server/tts-sidecar/tests/golden/compare.py`,
`test_golden_regression.py`, the golden baselines.

- **#2035** — `--bless` still silently re-records `loudness_dbfs` and `identity`,
  which are assertion *references* (±4 dB drift-window centres), not free
  measurements. Extends `bless_guard_thresholds` from #1995 rather than
  inventing a new mechanism.
  *Benefit (technical):* closes the last third of the #1995 / #2003 family.
- **#2005** — `normalize_words` collapses `'s` contractions, so `he's` == `he`.
  A regression that drops or adds `'s` scores 0 edits on a gate whose advertised
  purpose is single-word drift. Live on the current fixture (`Aldric's`).
  *Benefit (technical):* the content gate stops being blind to the exact drift
  class it exists to catch.
- **#2004** — the gate runs at tolerance 0 with `ASR_COMPUTE_TYPE` left ambient
  and no `faster-whisper` / `ctranslate2` version stamped, and no HF `revision=`
  pin on the `base` weights.
  *Benefit (technical):* a tolerance-0 gate that flakes for environment reasons
  gets disabled, which is strictly worse than no gate.

### Lane 2 · `fix/scripts-release-gate-retry`

**Status: shipped, PR #2049.** All three issues landed; independent review
returned two rounds of findings — nine in the first pass and a further ten in
the re-review — every one addressed with a follow-up commit on the same
branch (a Narrow, not Global, application of #2028's retry:0; a
`github-actions`/`agent` reporter-selection fix so the config no longer
silently overrides two of vitest's own auto-selected reporters; fixture
isolation so a killed wire test can't poison the suite it protects; and
doc-accuracy corrections). See the PR for the full finding-by-finding record.

Files: `scripts/release-notes-gate.mjs`, `scripts/bump-version.mjs`,
`server/vitest.config.ts`, `server/vitest.config.wire-fixtures.ts`,
`server/src/workspace/file-lock.test.ts`, `CONTRIBUTING.md`.

- **#2028** — `retry: 1` on the whole server suite re-runs against state the
  failed attempt already mutated, so **a genuine red-phase test can go green**.
  *Benefit (technical):* highest-leverage item in the queue — it silently
  invalidates the mutation-verification discipline every other lane relies on.
- **#2018** — the release-notes gate does not detect unresolved git conflict
  markers. Three landed inside `RELEASE_NOTES.md`'s v1.15.0 section with every
  gate green.
  *Benefit (user):* the published release body cannot ship `<<<<<<< HEAD`.
- **#2025** — the mojibake echo's ordering relative to its failure branch is
  untested; moving it leaves the suite at 81 pass / 0 fail while breaking the
  property. Plus a `CONTRIBUTING.md` overclaim for `RELEASE_NOTES.md`.
  *Benefit (technical):* pins "an armed marker is never silent" on the fail
  path, which is the half that currently has no wire-level test.

### Lane 3 · `chore/server-contract-and-cycle`

Files: `server/src/audio/build-synth-replacement.ts`,
`server/src/gpu/engine-device-state.ts`, `server/src/routes/sidecar-health.ts`,
`openapi.yaml`.

- **#2034** — `voiceSubstitutedFrom` is written unconditionally but typed
  optional, so a future caller that forgets it silently **wipes** a real
  substitution flag. Same omission class that produced #1888.
  *Benefit (architectural):* makes the next omission a type error rather than
  silent data loss.
- **#2013** — `madge` reports **16** cycles, not the 15 CLAUDE.md claims; an
  `import type` closes a cycle straight through an existing leaf gate.
  *Benefit (architectural):* restores the invariant the docs assert is held.
- **#1934** — six cast/single-design SSE endpoints are absent from
  `openapi.yaml`, including Wave 3c's `clonedSkips`, `character_skipped` and the
  409 `clone_protected`.
  *Benefit (architectural):* the bulk voice-design surface stops having
  hand-written frontend types with no mechanical drift guard.

### Lane 4 · `fix/sidecar-qwen-residuals`

Files: `server/tts-sidecar/main.py`, `server/tts-sidecar/tests/test_qwen3.py`.
**All three must share one lane — they are all in `main.py`.**

- **#2021** — five more in-lock cold Qwen loads survive #1975, three with no
  pre-ensure at all: `clone_voice`, `mint_variant`'s distil / audition / 1.7B
  forward, and `design_voice`'s DESIGN forward.
  *Benefit (user):* a Stop press is no longer held hostage by a cold weights
  pull taken inside the synth lock.
  **Correction (2026-08-01):** an earlier revision of this line said these
  sites were "on `synthesize_batch` (the main render path)" and cited #1975's
  RTF 5.83 → 1.36 measurement as the benefit. Both belong to **#1975**, not
  #2021 — these five are cast-review paths, and the delivering PR (#2064)
  correctly disclaims re-measuring that figure. Caught by the independent
  review of #2064.
- **#2022** — unguarded `self._base17` derefs bypass #1975's typed error with a
  bare `AttributeError`.
  *Benefit (user):* an out-of-memory condition reports as one, not as a stack
  trace.
- **#2030** — `test_qwen3` legacy-migration tests write to a shared source-tree
  directory instead of `tmp_path`; two concurrent pytest runs race on it.
  *Benefit (technical):* removes a flake class that fires precisely when two
  lanes run sidecar tests at once — i.e. during this round.

## Round 1 outcome (2026-08-01)

All four lanes shipped. **12 pre-existing issues closed across 5 PRs**, and
**14 filed** — 13 of which are still open (#2065 was filed and fixed inside
the same round).

**The open queue went 54 → 60**: 17 bugs + 37 chores at the start, 17 bugs +
43 chores at the end. It did not move sideways; it grew by six. That is the
headline finding of the round, not a footnote — see "What Round 1 changed
about the plan" below.

| PR | Closes | Lane |
|---|---|---|
| [#2045](https://github.com/dudarenok-maker/Castwright/pull/2045) | #2035, #2005, #2004 | 1 · golden gate |
| [#2049](https://github.com/dudarenok-maker/Castwright/pull/2049) | #2028, #2018, #2025 | 2 · release gate + retry |
| [#2048](https://github.com/dudarenok-maker/Castwright/pull/2048) | #2034, #2013, #1934 | 3 · server contract + cycle |
| [#2064](https://github.com/dudarenok-maker/Castwright/pull/2064) | #2021, #2022, #2030 | 4 · Qwen residuals |
| [#2066](https://github.com/dudarenok-maker/Castwright/pull/2066) | #2065 | fix-forward on #2045 |

### What the independent reviews caught

Every lane's first attempt had a defect a review found and I did not. Three
were in the *premise* rather than the code:

- **#2045** shipped a guard that refused **every honest re-bless**, because
  exact equality was applied to stochastic 4dp/2dp measurements. Since the
  escape flag is shared with `tolerances`, routine use of it silently
  re-authorises the `rtf_max` ceiling — reproducing #1995 one flag deep. Then
  its own fix round mislabelled a 0.13 forced move as "noise", needing #2066.
- **#2049** hand-rolled a retry-hazard reporter that **suppressed vitest's
  built-in `github-actions` reporter** — deleting inline PR annotations and the
  Flaky-Tests summary panel that already did the job better. Its release note
  then shipped claiming the fix had *not* been applied.
- **#2064** made `design_voice` raise on a lost race without disclosing that
  the race window **contains a full 0.6B cold load** and that `unload_design()`
  never consults `_design_in_flight` — filed as #2070.

### What Round 1 changed about the plan

**The filing rate is the problem.** 15 issues filed against 13 closed. Of those
15: one is this sweep's own tracking issue, one was self-inflicted and already
fixed (#2065), three were always-owed work that existed only as prose inside
the issues being closed (#2047, #2051, #2053), four are genuine pre-existing
defects that were simply invisible until someone looked (#2044, #2046, #2052,
#2063), and **three are design residue from one new mechanism** (#2060, #2061,
#2062 — all against the epsilon bless guard).

Two conclusions for Rounds 2 and 3:

1. **Decide the bless-guard design rather than carrying tickets against it.**
   The #2066 reviewer's diagnosis is better than the options originally weighed:
   the root cause is not the epsilon, it is the **shared flag**. One
   `GOLDEN_REBLESS_THRESHOLDS` arms `tolerances`, `identity` and
   `loudness_dbfs` together, which is what turned an over-tight guard into a
   re-opening of #1995. Splitting it (`GOLDEN_REBLESS_MEASUREMENTS` vs
   `GOLDEN_REBLESS_THRESHOLDS`) removes the blast radius entirely. #2035's own
   rationale for one flag — "the same kind of judgement call" — is the premise
   to reject.
2. **#2046 should go early in Round 2, not sit in the queue.** It is a
   deterministically red test on `main` that `retry: 1` hides. It cost time
   twice this round by looking like a regression it wasn't, and it blocks any
   future tightening of the retry — including #2063's frontend equivalent.

### Process notes worth keeping

- **The push is where lanes die.** All four stalled at the same place: a
  pre-commit or pre-push hook running the full server or sidecar suite, which
  exceeds a subagent's 600s foreground cap. Brief agents to commit and *report*;
  the coordinating thread should own the push, where a long run can be
  backgrounded.
- **`docs/release-notes-next.md` conflicts on every single merge**, because
  every PR appends to it. Five merges cost four hand-resolutions. Merging one
  at a time and re-resolving immediately before each is the only reliable
  order.
- **Never run git commands in a worktree an agent still holds.** Done twice
  this round; once a half-applied verification mutation was misread as damage,
  and once a mid-cleanup probe file was nearly deleted out from under its owner.

## Round 2 — SHIPPED 2026-08-05, five lanes, 16 issues

**The list below is the plan as written on 2026-08-01. What was actually
dispatched differs, and the differences are the useful part — see "Round 2 as
dispatched" and "Round 2 outcome" after it.** Two items moved before a single
lane was cut: **#2033** was pulled out (it needs `server/tts-sidecar/main.py`,
which Lane 2 held, *and* it changes the sidecar's batch response contract — a
design-first item, not a lane), and **#2104** was closed by another session's
PR #2112 while triage was still running. **#1931** turned out to be a duplicate
of #2079, already shipped on 2026-08-01 — see the outcome section.

### Round 2 as dispatched

| Lane | Branch | PR | Issues |
|---|---|---|---|
| 1 | `chore/sidecar-golden-flag-split` | [#2116](https://github.com/dudarenok-maker/Castwright/pull/2116) | #2060, #2061, #2062, #2069 |
| 2 | `fix/sidecar-main-residuals` | [#2124](https://github.com/dudarenok-maker/Castwright/pull/2124) | #2070, #2094, #2047, #2055, #2038 |
| 3 | `fix/server-correctness-singles` | [#2126](https://github.com/dudarenok-maker/Castwright/pull/2126) | #2011, #2052, #2088 |
| 4 | `chore/server-test-hygiene` | [#2122](https://github.com/dudarenok-maker/Castwright/pull/2122) | #2083, #2084, #2078, #2100 |
| 5 | `chore/ops-guard-singles` | [#2125](https://github.com/dudarenok-maker/Castwright/pull/2125) | #2036, #1931 |

Lane 3 was backfilled with #2052 and #2088 after #2033 came out. Lane 4 absorbed
six chapter-family files that review found still carrying #2083's shape. Merge
order was constrained, not first-ready-first-in: #2126 before #2122 (the
`Closes #2083` hand-off), and the three register-touching PRs serialised with
`npm run check:onbox-register` re-run after each.

### The original Round 2 list, for reference

- **#2046** — **SHIPPED.** `voices.test.ts`'s series-scope test was
  deterministically red under `--retry=0`; three describes performed
  workspace-wide override writes that legitimately reach the cross-series book
  but cleaned up only the two same-series ones. Diagnosed as **isolation, not a
  scope leak** — the received value's qwen slot held an earlier test's name
  rather than the one the failing test writes, which proves the production
  `seriesFilter` never touched that book. *Benefit (technical):* removes a red
  test from behind the retry mask and unblocks #2063 and any future tightening
  of `retry`. Its own lane — touches one test file, overlapping nothing.
- **#2011** — an ASR content-QA failure aborts the whole chapter render; the
  structurally identical embed pass 60 lines below is explicitly non-fatal.
  *Benefit (user):* a QA hiccup stops costing an entire chapter.
- **#2033** — `voiceSubstitutedFrom` is structurally absent on the **batched**
  Qwen path, which is the default one.
  *Benefit (user):* the #1888 diagnostic exists where renders actually happen.
  Shares files with #2011 → same lane.
- **#2014** — `ASR_COMPUTE_TYPE` and `ASR_CONCURRENCY` are env-only, not
  registry knobs. *Benefit (user):* reachable on a packaged install.*
- **#2012** — no mechanical guard that a registry knob has an Advanced-Settings
  row. **Needs one design call up front:** match on label, env var, or a
  machine-readable marker per row. *Benefit (technical):* stops the rule being
  enforced only by memory. Shares files with #2014 → same lane.
- **#2036** — the GPU-contention warning reads only the first GPU and samples
  once, on a dual-GPU box. *Benefit (technical):* it can currently miss the
  exact scenario it was written for (#1995's originating case).
- **#1931** — ops-47: the live HTML register is last-writer-wins; a correctly
  recorded row was silently erased. *Benefit (technical):* the acceptance
  register stops losing rows.
- **#1969** — reassigning a voice keeps scoring the character against the old
  voice's persisted audition centroid, producing false `severe` voice-mismatch
  flags. *Benefit (user):* re-cast without the integrity gate crying wolf.
- **#1691** — the stage-1 cloud TPM reservation is a fixed constant; books past
  roughly 130 accumulated cast entries drop chapters. *Benefit (user):* removes
  a silent cliff for large-ensemble books.

## Round 2 outcome (2026-08-05)

All five lanes merged; **16 issues closed**, every one verified `CLOSED` after
its merge rather than assumed. **Nothing shipped as a partial** — seven issues
were heading for `Refs` and each had its remaining work delivered instead
(#1931's publish-step mechanism, #2083's six extra files, #2078's second
symptom, #2094's attribution, #2038's dependency, #2070's and #2084's
disclosure items).

### Every lane's first attempt had a real defect, and three were in the premise

This is the round's headline, and it is a stronger version of Round 1's finding.
Not one lane's first attempt was clean, and the defects reviews found were not
the ones the implementers were uncertain about — they were in claims the
implementers were confident enough to write down:

- **Lane 3, HIGH severity.** #2011's non-fatal catch let a chapter ship its
  **original drift PCM stamped `verdict: ok`** on default settings. The verdict
  was written inside the round loop while the PCM committed only after all
  rounds; moving that commit inside the new `try` made the half-applied state
  observable. It also poisoned the downstream #1083 calibration-bleed check,
  which then compared against a transcript describing discarded audio. Strictly
  worse than the abort it replaced.
- **Lane 5, my own spec error.** The new `--against-published` gate compared
  both directions, so it fired on **every genuine publish** and told the
  operator to "update the live view's summary strip" — i.e. delete the rows they
  were about to publish. #1931's own data loss, printed as an instruction. The
  documented procedure also could not terminate. Fixed with a `direction:
  'extraOnly'` parameter.
- **Lane 4, a justification that did not reproduce.** The argument for touching
  production source (`epub.ts`) rested on an experiment showing 27/27 green
  without the change; review reproduced **both** arms and got identical
  failures, on an unrelated error. The real defect was in the assertion:
  `parseEpub` removes its `mkdtemp` dir in a `finally` **before returning**, so
  a post-hoc `readdirSync` can never see the named defect — only a *leaked* dir,
  a different two-part mutation. Fixed by spying `mkdtemp`; production change
  dropped entirely.
- **Lane 1, a regression the PR introduced.** The new forced-write echo printed
  `wrote {...}` *before* an all-or-nothing write that a later field's refusal
  aborted — newly reachable *because* of the flag split.
- **Lane 2, three defects in one threshold.** #2055's first attempt relabelled
  near-silence as drift one token above its tested case (including Whisper's
  2–4-token Russian hallucinations, invisible to the English-only pattern
  list); its fixed 0.85 bar could sit **below** the effective `maxWer`, so low
  confidence made the gate *stricter* and `maxWer: 1.0` stopped disabling it;
  and its length floor was on *heard* rather than *expected* tokens, so a
  two-word Russian line with two ordinary mishearings scored WER 1.0.

### Seven cases of green-checking-nothing

The dominant defect shape in this repo's tooling, and worth its own rule:

1. `if True:` — an unconditional skip in `_assert_against_baseline` — survived
   all 102 golden tests (`1 skipped, 109 passed` reads green).
2. `test:sidecar` reported `[pass] … (took 1.4s)` on a worktree with no venv,
   having run nothing.
3. Mutating `isDirectInvocation` to `return false` — turning
   `npm run test:golden-audio` into a silent exit 0 — left all 9 tests green.
4. The bless-guard test's slice anchor was depth-coupled: de-indent the block
   and blank its env, reintroducing the ambient-bless leak, and all 9 stayed
   green.
5. Two `--against-published` CLI tests asserted only `status === 0`, so deleting
   the entire CLI entry point left them green — one carrying a comment claiming
   it guarded exactly that.
6. The #2052 fail-closed test named `if (!health) return;` but the surrounding
   `try/catch` ate the resulting TypeError, so deleting that line left 9/9
   green.
7. **The sharpest one:** two new design-lock tests asserted on a module-level
   `Map.size` with no `{ retry: 0 }`, so attempt 1 failed and *leaked its
   mutation* and attempt 2 passed off that state. Reverting the fix gave
   **2 failed** at `--retry=0` and **8 passed** at the default — the gating
   config. Exactly the hazard #2028 shipped a fix for in Round 1.

**Proposed rule for Round 3:** a new guard ships with a demonstration, in the PR
body, that neutralising it turns something red. All seven would have been caught
at authoring time.

### Two false premises inherited from issues

- **#2088 claimed `withDesignLock` had "zero test coverage".** False —
  `design-lock.test.ts` has covered the primitive since `53a30df4`, and
  neutralising it reddens one of its three tests. The claim propagated into a PR
  body, a release note and a committed test comment before anyone checked. The
  accurate statement is that `qwen-voice.test.ts` had no coverage of it and the
  series-branch double-mint property was untested anywhere. [Corrected on the
  issue](https://github.com/dudarenok-maker/Castwright/issues/2088#issuecomment-5187432684).
- **#1931 was a duplicate of #2079**, whose `checkLiveView` shipped on
  2026-08-01 with 58 tests. Its brief was written from the issue without
  checking whether it had been fixed since it was filed. The lane verified the
  existing checker rather than rebuilding it, and delivered only the genuine
  residual. **In a sweep working weeks-old issues, "is this still true?" belongs
  in the brief, not in the implementer's discovery.**

### Process findings

- **A commit trailer beats a PR body.** #2083 was closed prematurely by
  `Closes #2083` in commit `baaed498`, even though PR #2126's body deliberately
  said `Refs`. Editing the body is not sufficient — **check the commit
  trailers** (`git log base..HEAD --format=%b | grep -iE '^(closes|fixes) #'`)
  before merging. Caught only because issue state is verified after every merge.
- **Agents stage and report; the coordinating thread owns commit *and* push.**
  Round 1's finding was that lanes die at the push; the "commit and report"
  brief simply moved the failure to the commit. Lanes 2, 3 and 4 each lost
  several turns to hooks that the coordinator cleared in one; Lane 2 spent 766k
  tokens partly on this.
- **The wedge is silent.** A pre-commit hook sat at exactly 0.00s CPU delta with
  zero children for 36 minutes while looking like a running suite. Detect it by
  sampling CPU twice and counting children — a blind wait never returns.
- **Local hooks caught three things agent self-verification missed**: a lint
  escape, an over-long commit subject, and a missing `config:sync` after a new
  registry knob. Agents run scoped checks and miss repo-wide invariants.
- **`docs/release-notes-next.md` conflicted on every merge again**, as in Round
  1. Always purely additive. A merge driver or an append-only format would
  remove a guaranteed hand-resolution per PR.
- **`pr-title-lint` does not re-run on a title edit** (`edited` was dropped in
  plan 103), so a fixed title stays red until a real push. It is not a required
  check, so it does not block — but three titles in this round exceeded the
  100-char limit, and nothing checks PR titles locally the way `commit-msg`
  checks commits.

## Round 3 — design-first

These fail the fix-now bar: each has more than one defensible answer. The
deliverable per item is a **phase-1 pass — ticket + plan doc**, not a diff.

- **#2033** — `voiceSubstitutedFrom` on the batched Qwen path. Pulled out of
  Round 2's Lane 3: it needs an interface change to `SynthesizeBatchOutput`
  **plus** the sidecar's batch response contract (the header is per-response, a
  batch is one response covering N items, so the wire shape needs a per-item
  answer), and it collides with any lane holding `main.py`.
- **#1996** — VRAM reclaim hook location. Sent back to design 2026-08-01 after
  review proved `/unload` is never issued at render completion and *is* issued
  mid-render at phase boundaries.
- **#2037** — **SHIPPED** in the interval (supervisor respawn when the exiting
  child still holds `:9000`), merged before Round 2 was dispatched.
- **#1984** — attribution collapse is invisible. A real book lost 103 of 144
  quoted sentences and sat that way for 17 days unnoticed.
- **#1393** — srv-58: `reconcileResidentQwenTiers` can evict a Qwen tier a
  concurrent book is mid-render on.
- **#1932** — side-18: consolidate the two Coqui VRAM eviction mechanisms, or
  document the split as deliberate and scope each in code.
- **#1808** — fs-38 Wave 3a deferred-minor sweep (tests / openapi / a11y —
  splittable into smaller lanes once scoped).
- **#1309** — ops-24: PROXY protocol for the LAN port-443 forwarder.
- **#898** — srv-41: pairing device-token TTL + scope. The issue states outright
  that a naive change would be wrong and it needs its own design.
- **#485** — side-13: import safety + provenance for untrusted voice artifacts
  (size M, gates fs-28 … fs-31).
- **#1950** — a sidecar pytest job in `verify.yml`. Sidecar-only PRs currently
  get **zero** CI coverage; this is why #1942's regression test never ran in
  cloud CI. Which runner, which weights, and how long are real questions.

## Round 3 outcome (2026-08-05)

Four PRs merged, **four issues closed** (#2033, #1808, #2144, and #898's design
phase), two filed (#2144, #2149), one item paused deliberately, and five left
untouched. The round's value was **not** in the diffs.

### Four of ten premises did not survive verification, and a fifth was solved elsewhere

The round opened with a read-only premise check across all ten issues before any
design started. It took about twenty minutes and it changed the round:

| # | Filed premise | What was actually true |
|---|---|---|
| #2033 | Qwen's batch path drops `voiceSubstitutedFrom` | **Not a defect.** Qwen never *sets* it — only `CoquiEngine` and `KokoroEngine` do — and batching is Qwen-only. Rescoped to a latent-gap guard. |
| #1808 | Wave-3a deferred-minor sweep outstanding | **9 of 10 already shipped**, most carrying `#1808` markers in their own test titles. Item g is unreachable dead code. |
| #898 | Device tokens need TTL **and** scope | **TTL shipped in `74fb2901`** — the day the issue was filed. Only the scope half was open. |
| #1393 | Needs an in-flight-render registry | **The registry already exists** (`inFlightByBook`). |
| #1950 | Needs a design decision on runner/weights | **Already designed elsewhere** — defect C of PR #2142's verify-scope unification, merged an hour earlier the same morning. |

Verified as holding, byte-for-byte: #1984 (all four claims), #1309, #1932, #1996
(though PR #2029 had already tried and reverted its proposed lever).

**The rule this earns:** a design-first round starts with a premise pass, not a
design pass. Two plan docs would have been written against defects that do not
exist. An issue's age is the signal — every stale premise here was on a ticket
filed 14+ days before, in a repo where 30+ PRs a week land next to it.

### `gh issue view --json body` silently excludes comments

The ten issues were batch-fetched with `--json number,title,state,labels,body`.
That **omits comments**, and in this repo comments are where scope gets
broadened and owner decisions land. #1393's 2026-07-06 comment carried a
standing decision — the keep-set must come from real render facts, **not**
`computeUsedQwenTiers(fullCast)` — which was invisible to the fetch and got
publicly contradicted the same day, after a spec had already been drafted
against the wrong scope. Use `--comments`, or add `comments` to the field list.
Of ten issues, only two carried comments; both changed the work materially.

### The dominant error shape: claims about absence, derived from a too-narrow grep

Across three independent spec authors and the coordinating thread, **every**
false statement this round was of one shape — an assertion about what is or
isn't there, presented as observation but actually inferred from a grep whose
pattern was never doubted:

- "There are zero `403:` entries" — the pattern was `^ *403:`; the file had
  `'403':`, quoted.
- "The only `on ApiException catch` is `:176`" — missed every untyped
  `catch (_)`.
- "`ChapterSegment.modelKey` is stamped, written at `synthesise-chapter.ts:2490`"
  — **the field does not exist**; `:2490` is a `provider.synthesize({…})`
  argument, discarded after the call.
- "The pytest pins that neither substituting engine can expose
  `synthesizeBatch`" — it pins the *Python* `synthesize_batch`; the Node method
  is unconditional on `SidecarTtsProvider` (`tts/sidecar.ts:322`).

The checks that *succeeded* were the other kind: re-deriving an allowlist from
scratch, standing up a real Express app to see what it does. **A claim about
what isn't there needs a command, not a reading** — and the command's pattern is
the thing to doubt. This is the same family as Round 2's green-checking-nothing
cases: a search that finds nothing and a guard that checks nothing both report
success by default.

### The cold-brief handoff found what no amount of self-review could

Both #1393 and #898 had two specs rejected by adversarial passes. #898 was
rescued by **briefing a fresh agent from the issue and its comments alone**,
with no access to the earlier drafts. That agent immediately found the one
defect every reviewer had missed: the triage comment named `pairing.ts:145` as a
mint site but never said it serves a **LAN browser running the full desktop
UI**. Scoping every device token to `companion` — the obvious reading — would
have 403'd the entire web app.

That class of error is *a fact the author knew and did not write down*. It is
invisible to the author specifically because they know it, so no amount of
re-reading finds it. **Keep the cold-brief handoff as a step, not an
experiment**: for anything whose deliverable is a brief, have someone read the
brief cold before trusting it. It is also the honest test of whether phase 1
produced a self-sufficient contract, which is the whole point of the
[Execution model](../../CLAUDE.md#execution-model-default-for-all-non-trivial-work)'s
design/implementation split.

### What shipped

| PR | Closes | What |
|---|---|---|
| [#2143](https://github.com/dudarenok-maker/Castwright/pull/2143) | #2033, #1808 | The latent-gap guard, both arms — no substituting engine has a *usable* `synthesize_batch` (AST-based, so a base-class stub is not a false positive), and `QwenEngine` never constructs a `SynthResult` with a non-`None` `substituted_from`. |
| [#2147](https://github.com/dudarenok-maker/Castwright/pull/2147) | — | #898's design of record. |
| [#2151](https://github.com/dudarenok-maker/Castwright/pull/2151) | — | #898's implementation plan: 10 tasks, 65 steps, 28 mutations, two PRs in a load-bearing order. |
| [#2150](https://github.com/dudarenok-maker/Castwright/pull/2150) | #2144 | The auth bypass below. |

**#2144 was found by an assumption-checker attacking #898's migration
argument** — not by anyone looking for it. `device-tokens.ts:60` read
`now > Date.parse(d.expiresAt)`, which is `false` for `NaN`, so a record with
`expiresAt: null`, `""`, or garbage **authenticated forever**; only the literal
`undefined` was caught. Its review then found a Before-shipping step-1 violation
the first revision missed: `docs/features/225` is `status: active` and its
invariant #2 stated the *vulnerable* predicate verbatim, so a future agent
"restoring the invariant" would have reopened the bypass **and it would have
read as conformance**. A stale invariant is worse than no invariant.

### #1393 was abandoned rather than attempted a fourth time

Three drafts, three rejections. Instead of a fourth revision the ticket now
carries the verified ground: there is **no per-segment tier stamp**, and
`inFlightByBook` cannot see splice or QA-repair renders (they register into
`chapter-job-coordination.ts:13`'s separate map). So the cross-book race is
reachable by a path no union over `inFlightByBook` can close — **#1393 is
bigger than filed**, and restarting it needs a fresh thread from the
`synthesiseChapter` publishing question, not another revision of a design its
own facts rule out.

### Still open from Round 3

#1984 (needs a product-surface brainstorm with the repo owner), #1996 (blocked
on on-box measurement), #1932, #1309, #485, #1393 (paused), and #898's phase 2 —
which is fully briefed and needs only execution. #1950's work merged with
someone else's PR and the issue is open only for want of a linkage.

## Round 4 — the drain plan (planned 2026-08-11)

Rounds 1–3 dispatched at whatever was actionable that morning. Round 4 is
scoped differently: the goal is **to take the queue as close to empty as it can
honestly go**, which means admitting up front that a fifth of it will never be
cleared by effort at all.

### Baseline, re-taken on `main` @ `f2b2e866` (2026-08-11)

**49 open items — 14 `bug` + 35 `type:chore`** (board total open: 102; the
balance is `type:feature`). Three rounds have closed ~31 items since the
2026-08-01 baseline of 54, and the queue has held roughly flat because new
findings replaced them at about the same rate.

The items are **not one pile**, and treating them as one is why the queue looks
immovable. They take four different actions:

| Disposition | Count | The action |
|---|---|---|
| Diff-shaped — dispatchable now | 20 | Lanes A–D + #898 phase 2 + bookkeeping |
| Design-first — phase-1 only | 8 | Ticket + plan doc, closes in Round 5 |
| On-box — the deliverable is a measurement | 6 | One GPU sitting |
| Blocked upstream / hardware | 10 | A disposition decision, not work |
| Gated — live worktree or paused wave | 5 | Not scheduled by this sweep |

20 + 8 + 6 + 10 + 5 = 49.

**Realistic end state: 49 → ~13**, of which most are the design-first set
awaiting Round 5 and the parked-blocked set.

### Two live worktrees — do not dispatch into these

`wt-1984-spec` (#1984, revision 7) and `wt-2128-audio-currency` (#2128), both
committed 2026-08-11. Four others — `feat+fs38-wave3c-fe`, `fs38-followups-c`,
`feat+fs-35-per-chapter-detect-emotions`, `feat+server-fs59-cjk-w5` — last moved
in July and belong to the paused fs-38 Wave 3.

### Round 0 — the premise pass, before any lane is briefed

**20 of the 49 were filed 14+ days ago.** Round 3 found 4 of 10 premises dead in
about twenty minutes, and two plan docs were nearly written against defects that
do not exist. The same trap is loaded here, and it is larger.

Scope: the ten stale non-blocked items — **#1826, #1691, #1393, #1309, #898,
#485, #1685, #1600, #1527, #1084** — plus a duplicate check on **#2056 vs
#2026** (both describe the Russian neuter `-ее` mispronunciation on XTTS; one is
probably redundant).

Two mechanics are non-negotiable, both from the Round 3 outcome above:

- Fetch with `--comments`. `gh issue view --json body` omits them, and comments
  are where scope gets broadened and owner decisions land.
- **A claim that something isn't there needs a command, not a reading** — and
  the command's pattern is the thing to doubt. Every false statement in Round 3
  was an absence inferred from a grep nobody questioned.

*Benefit (technical):* the cheapest step in the round and historically the
highest-yield. It closes items outright and stops lanes being briefed against
fiction.

**Three reclassifications already found by this pass, from the durable record:**

| # | Filed as | What is actually true |
|---|---|---|
| #2187 | Aligner under-aligns Russian dash dialogue | **The fix shipped** (`b2be5b7b`; book alignment 67.7% → 96.0%). **Superseded: the #2187 row ran 2026-08-12/13 and discharged.** Not code work. |
| #1976 | A finished render strands ~3.9 GB | **A bookkeeping shell.** Four of its five criteria shipped; it closes when #1996 does. Not independent work. |
| #2015 | analysis.ts's five writes replay a merge base | **Capture is solved** (PR #2185). **Superseded: the rebuild half was withdrawn and #2015 closed 2026-08-27** — eight designs died against it, the frequency measurement it was gated on proved unmakeable, and #2185's logged advisory is kept as the tripwire. Not code work. |

### Group 1 — bookkeeping closures (4, no code)

One docs PR. The cheapest reduction available in the whole plan.

- **#2057** — reconcile the onbox register's owed #2026 row and republish the
  HTML twin. **Unblocked since 2026-08-01**, when PR #2039 merged.
  *Benefit (technical):* the register is the merge gate for every on-box-gated
  PR; a stale row makes that gate lie.
- **#1976** — annotate as a shell that closes with #1996, so it stops being
  scheduled. *Benefit (technical):* it reads like a live independent bug on the
  board and is not one.
- **#2056** — resolve against #2026: duplicate, or split the upstream-blocked
  half cleanly. *Benefit (user):* one honest ticket for the XTTS Russian problem
  instead of two half-descriptions of it.
- **#2042** — this tracking issue; closes last, carrying the round's numbers.

Bundle the outstanding register-publish debts into the same PR.

### Group 2 — Lane A · server: `analysis.ts` + cast store (4, **sequential**)

All four touch the same files, so this is **one worktree run in order**, not
four parallel agents — invariant 1 below is the constraint, not a suggestion.

- **#2239** — move `clearNotLinkedEdgesForDroppedRejections` out of
  `analysis.ts` into `store/`.
  *Benefit (architectural):* `analysis.ts` is the file every cast-lock incident
  has run through; shrinking it is how the next one gets cheaper.
- **#2161** — `rejectedPairs.forgotSupersededTo` can dangle the same way
  `supersededBy` did before #2110.
  *Benefit (technical):* a known-shape defect with a shipped precedent to copy.
- **#2228** — srv-89: no test stands up either analyzer persist block; three
  wiring facts are source-scan-only.
  *Benefit (technical):* source-scan-only facts are exactly the
  green-checking-nothing class Round 2 catalogued seven times.
- **#2006** — the last open half of the three clone-consent TOCTOU gates.
  *Benefit (user):* consent validated in one scope and written in another is a
  real correctness hole on a privacy-sensitive path.

### Group 3 — Lane B · server: process, routes, voice scoring (5)

- **#2196** — an out-of-process book folder move leaves a stale record that
  resurrects the old directory.
  *Benefit (user):* data-loss-adjacent — the user's own filesystem action gets
  silently undone.
- **#1969** — reassigning a character's voice keeps scoring it against the old
  voice's persisted audition centroid.
  *Benefit (user):* voice-match scores are wrong after any reassignment, which
  is a routine action.
- **#2106** — `findListenerPid` has no timeout, so a slow refusal resets the
  respawn budget forever. Carries `needs-plan`; confirm it needs one rather than
  just a timeout.
  *Benefit (technical):* an unbounded respawn budget is an infinite-loop class,
  not a slowdown.
- **#1826** — serialize voice-library entry writes (per-uuid lock or `updatedAt`
  CAS). **Premise-check first** — the cast-lock sweep added a
  `voice-library-usage.ts` detector and may already cover this.
  *Benefit (technical):* the last unserialised writer in the family that sweep
  otherwise closed.
- **#1691** — make stage-1 cloud TPM reservation roster-aware (>130-char-cast
  ceiling). Stale (07-17); check against #1685 before dispatching.
  *Benefit (technical):* a large cast blows the reservation ceiling silently.

### Group 4 — Lane C · frontend + test hygiene (2)

- **#2230** — a 409 from the Listen-view book-meta editor is swallowed silently.
  *Benefit (user):* the edit vanishes with no error; the user retypes it and it
  vanishes again.
- **#2235** — flaky `export.test.ts` uncaught ENOENT in its staging dir,
  ~1-in-2 standalone on a contended box.
  *Benefit (technical):* a flake in the gate corrupts every red-phase
  verification downstream of it — Round 1 put this class first for this reason.

### Group 5 — Lane D · ops, config, CI (4)

- **#2194** — an existing `server/.env` keeps every knob locked after #2179,
  because upgrades never rewrite it.
  *Benefit (user):* every existing install silently ignores the new defaults —
  an upgrade that does nothing.
- **#1994** — Qwen has no golden duration baseline, so a speech-rate regression
  on the **default** engine is invisible.
  *Benefit (technical):* the golden tier covers the fallback engine and not the
  hot path.
- **#2243** — ops-56: decide whether `docs/superpowers/plans/**` is a record or
  live instructions, then finish the review-gate sweep.
  *Benefit (architectural):* stale docs read as conformance — the #2144 failure
  shape exactly.
- **#1966** — ops-48: evaluate `@nanonets/graft`. Date-gated to **2026-08-14**,
  so it lands naturally inside this round.
  *Benefit (technical):* retires a standing "revisit later" with a yes/no.

### Group 6 — #898 phase 2 (1, execute-only)

**The highest expected value single item in the plan, and it should not wait
behind the lanes.**

- **#898** — srv-41 pairing device-token scoping. Spec merged (#2147), plan
  merged (#2151: 10 tasks, 65 steps, 28 mutations, two PRs in a load-bearing
  order), handover brief posted. Phase 1 is complete; this needs a **fresh
  implementation thread briefed from the ticket and nothing else.**
  *Benefit (user):* the only fully-briefed security item in the queue, and its
  design phase already produced one live auth bypass (#2144) as a side effect.

### Group 7 — design-first: phase-1 only, no diffs (8)

Each has more than one defensible answer, so the deliverable is a ticket + plan
doc and closure happens in Round 5. Use the **cold-brief handoff** — a fresh
agent reads the brief with no access to the drafts. It is what rescued #898
after two rejected specs.

**Take the first four this round; defer the rest.** Eight concurrent phase-1
threads is more design than one round should carry.

- **#1996** — VRAM reclaim hook location. Attempt 1 (PR #2029) was killed by
  review; the traps are recorded — call
  `PlacementController._reclaim_stranded_cache`, not `_placement.reclaim`; tests
  must assert **ordering**, not that the hook was called; the idle watchdogs are
  the likely home. Closing this also closes #1976.
  *Benefit (user):* ~3.9 GB stranded after every render on an 8 GB card.
- ~~**#2015** — the cast.json **rebuild** half only.~~ **Withdrawn and closed
  2026-08-27.** The restart was not cheaper than it looked: attempts 5–8 died
  too, the last on a structural obstacle (three run-scoped passes co-own the
  fields any re-application would have to invert), and the frequency data the
  work was gated on proved unmeasurable. #2185's logged advisory stays as the
  tripwire. See the 2026-08-27 foreign-delta spec §14.
- **#1932** — side-18: consolidate the two Coqui VRAM eviction mechanisms, or
  document the split as deliberate and scope each in code. Premise verified as
  holding in Round 3.
  *Benefit (architectural):* two mechanisms for one job is how the next OOM gets
  misdiagnosed.
- **#2131** — decide whether an unresolvable `qa.asr.model` should fail early.
  *Benefit (user):* today a whole book renders before the QA gate discovers it
  cannot run.
- **#2059** — **SHIPPED PR #2688.** Doubled commas from dash-to-comma conversion
  collapse to a single comma (51 unit tests). The design was decided and shipped
  via PR #2688, closing #2059. *Benefit (user):* Russian dialogue text no longer
  carries doubled-comma artifacts.
- **#1309** — ops-24: the LAN port-443 forwarder collapses per-client identity,
  weakening rate limits. Verified byte-for-byte in Round 3.
  *Benefit (technical):* rate limits that cannot distinguish clients are not
  rate limits.
- **#485** — side-13: import safety + provenance for shared voice artifacts.
  Size M; gates fs-28 … fs-31.
  *Benefit (architectural):* it blocks four downstream features, so it is
  holding up more than itself.
- **#1393** — srv-58 Qwen tier eviction race. **Paused after three rejected
  designs** — its own verified facts (no per-segment tier stamp;
  `inFlightByBook` cannot see splice or QA-repair renders) rule out the shape it
  was filed as. Restarting it needs a fresh thread from the `synthesiseChapter`
  publishing question, not a fourth revision.
  *Benefit (technical):* real cross-book corruption risk — but restarting it
  wrongly has already cost three attempts.

### Group 8 — on-box: one GPU sitting clears 6

The deliverable is a **measurement**, not a diff. Dispatching a coding agent at
these accomplishes nothing. **Nothing else in this plan has this ratio.**

- **#2187** — discharge register row C2. Force `fresh: true`, and do **not**
  re-measure alignment — that is already done from cache. Then close.
  **Superseded: the #2187 row ran 2026-08-12/13 and discharged.** Group C
  renumbered afterwards, so today's `C2` is the unrelated #2253 dialogue-
  convention row — do not discharge it against this instruction.
- **#2026** — XTTS Russian quality on a stock catalogue voice (engine-level, not
  clone-related).
- **#1998** — cloned-voice identity loss across languages (0.600 → 0.229).
- **#1084** + **#1527** — ASR content-QA `maxWer` never tuned or validated for
  es/fr/de/ru; the 0.4 cap is English-tuned.
- **#1685** — verify #1682 cloud request sizing; calibrate the stage-2 local
  input fraction.

Plus #1996's confirmation measurement, once its design lands.

### Group 9 — blocked: a disposition decision, not work (10)

#1228 (transformers CVE, upstream), #893 (sidecar dep bump, torchaudio EOL
@2.11), #711 (eslint 9→10), #431 (jsdom · archiver · @google/genai), #790
(ops-17 KGP / AGP 9), #1477 (TypeScript 7.0), #1335 (AMD / ROCm hardware not
owned), #822 (Pinokio macOS box), #1001 (FlashAttention-2 wheels), #947 (ops-18,
deferred by its own issue text).

**No amount of effort clears these.** They wait on other people's releases or on
hardware that is not owned. They are a fifth of the queue and they distort every
triage pass that walks it.

- **Option A — park.** Add a `blocked` label plus a review date; exclude them
  from sweep counts.
- **Option B — collapse.** Close all ten into one standing "upstream watch"
  tracking issue that lists them.

**Recommended: A.** Closing loses the per-item context, and several already
carry `tracking`.

*Benefit (technical):* either way, the queue starts reflecting work that can
actually be done.

### Group 10 — gated, not scheduled (5)

- **#1984**, **#2128** — live worktrees as of 2026-08-11. #1984 is at revision 7
  with rounds 5/6/7 all failing their gates and **scope growth awaiting owner
  sign-off**. Neither is touched by this sweep.
- **#2068**, **#1600** — fs-38 Wave 3, which is **paused** with E-04
  failing and on-box at 16/60. They unpause with the wave or not at all.
  (#2054 closed by PR #3014.)

### Sequencing

1. **Round 0** premise pass — read-only, no branch.
2. **Group 1** bookkeeping — one docs PR.
3. **#898 phase 2** in its own thread, **in parallel with Lanes A–D** (four
   worktrees, file-disjoint; Lane A internally sequential).
4. **Group 7** phase-1 threads for #1996 / #1932 / #2131. (#2015's thread ran
   and ended in withdrawal — see its Group 7 entry above.)
5. **Group 8** at the next GPU sitting.
6. **Group 9** on the owner's call.

### Decisions this round needs from the repo owner

1. **Group 9** — park with a label, or collapse into one tracking issue?
2. **Group 8** — is a GPU sitting available? It is the best ratio in the plan.
3. **fs-38 Wave 3** — stays paused, or unpauses (adds 3 items and unblocks four
   stale worktrees)?
4. **#1984** — the scope growth is stalled on sign-off, independently of this
   sweep.

### Driving view

`docs/features/277-v115-bug-chore-sweep-board.html` is the hand-authored board
for this round — every one of the 49 items, grouped as above, filterable by
disposition and area, with per-item state kept in the reader's `localStorage` so
a redeploy never wipes progress. It is a **tracked file**, edited here and
republished from here; treat it the way the onbox register's live view is
treated, and never publish a rendering of this markdown over its URL.

Canonical URL:
<https://claude.ai/code/artifact/f3608d3e-0e02-4eaa-9af3-3322b9ce0bb3> — pass it
as `url` on every republish, or a second competing board is minted.

## Round 4 outcome (dispatched 2026-08-11 → 2026-08-28)

Unlike Rounds 1–3, Round 4 was never dispatched as a single sitting — the board
above was worked incrementally over roughly two and a half weeks, largely by
independent PR-review-gate passes surfacing and closing findings as they went
rather than by lane. **17 of the board's 53 tracked items closed** between the
08-25 board snapshot and this re-audit (08-28) alone, on top of whatever closed
between 08-11 and 08-25:

| # | Outcome |
|---|---|
| #2006, #1994, #2243, #2015 (see below), #2059, #2068, #1932, #2629, #2634, #2653, #2187, #2026, #2642, #2288, #2574 | Closed `COMPLETED` |
| #1976, #1996 | Closed `NOT_PLANNED` — consolidated into **#2656**, the successor that asks the one concrete question left ("is there a genuine leak on top of the resident-model floor, or does residency alone explain it") |
| #1932 | Closed via a **decomposed agent-instruction chain** (#2692 → #2691 → #2690 → #2689, each a self-contained step read by a cold agent) rather than one hand-run design thread — worth reusing as the template for #2656 and other Group-7 carryovers |

**#898 phase 2 did not ship.** Three rounds running it has been named "the
highest expected value single item in the plan," fully briefed since Round 3,
and it is still sitting untouched. That is a process failure, not a technical
one, and Round 5 treats it as the first thing to dispatch, unconditionally.

**None of this sweep's own Group 8 items got a sitting across all four
rounds — but on-box work itself did not stand still.** #1084, #1527, #1685,
#2583 are untouched; #2616 (a real on-box session, Group C / Ночной дозор)
never ran even though it was flagged ready. One of its two paired code bugs
(#2288) shipped without the session — the session's scope needs re-checking
against what actually still needs measuring before it is re-briefed, not
copied forward as-is. **Correction (found while auditing live worktrees for
this update):** a separate, parallel on-box acceptance campaign (tracked by
#2435, not this sweep's Group 8 list) ran waves 6 through 9 in this same
window — PRs #2679 (wave 6, rows A19/A20/A24/A26/A31–A33), #2693 (wave 8,
rows A34–A37), and #2658/#2664 (A46, for #2656) all merged 08-25 → 08-27.
None of those waves' rows overlap this sweep's own tracked Group 8 items,
which is why "zero sittings for these seven items" is accurate but "zero
on-box sittings" is not — say the narrower claim, not the broader one.

**8 new items were filed against work this round surfaced**, all from
PR-review-gate passes: #2682, #2700, #2708, #2721, #2742, #2747, #2750, #2752.
**A premise-check on all eight (required — see Round 3's rule, "an issue's age
is the signal," and this round's own G11 disclaimer that title-only items are
unverified) found that #2608, #2596, #2496, #2516, #2682 and #2747 are not
diff-shaped despite reading like small fixes** — every one of them is filed
with an explicit "decision owed" section and, in most cases, 2–3 pre-enumerated
options. Reading only the title/one-line summary here would have repeated
exactly the class of error Round 3 catalogued ("claims about absence from a
too-narrow grep," title-only triage) — see Round 5's Wave 2 below.

**A self-replicating "register mechanics" family emerged.** #2629 (citation
rot) shipped, and its own closure immediately orphaned **#2721** ("rehome the
wrongId-widening deferral that #2629's closure orphans") — a fix creating the
next ticket about itself, one level up from the citation-rot problem it fixed.
#2634/#2653 (duplicate row-ID bugs, confirmed the same defect filed twice)
closed together; #2599/#2603 remain open in the same family, and #2708 (decide
whether the register carries a changelog at all) is a fresh decision in it.
Four fixes to this mechanism have now spawned a fifth ticket about the fourth —
Round 5 treats this as needing a terminal decision (#2708 first), not another
mechanical patch, or it keeps reproducing.

**Net effect:** the open queue went from 67 (53 tracked + 14 untracked growth,
08-25) to **58 real trackable items** (60 raw open `bug`+`type:chore`, minus 2
live `agent-instructions` execution children per the standing exclusion) as of
08-28. That is real drain — but the composition inverted: Round 4 started
dominated by diff-shaped lane work (20 of 49) and ends dominated by
decision-owed and on-box work. There is very little left that a coding agent
can simply be pointed at without a decision made first.

## Round 5 — the recut plan (planned 2026-08-28)

Round 4's "lanes of independent diffs" shape is drained. What is left is
dominated by decisions and measurement, not code, so Round 5 is cut
differently: seven waves, ordered by how soon each can honestly start, not by
size.

**Baseline, re-taken on `main` @ `67d0e990` (2026-08-28), cross-checked against
every open PR and branch in the repo (not just issue titles) so nothing below
gets briefed into a live collision:**

| Wave | Disposition | Count | Items |
|---|---|---|---|
| 0 | Bookkeeping — ready, no code | 4 | #2056, #2042, #1966, #2435 |
| 1 | Execute-only — ready | 1 | #898 |
| 2 | Decision-owed singles — low/medium stakes, options pre-enumerated | 5 | #2608, #2496, #2516, #2682, #2747 |
| 2b | Decision-owed — Premium tier, blast radius | 1 | #2596 |
| 3 | Diff-shaped lane — one file, one lane | 2 | #2750, #2752 |
| 4 | Register mechanics — decide #2708 first, then lane | 4 | #2708, #2599, #2603, #2721 |
| 5 | On-box — one GPU sitting | 7 | #1084, #1527, #1685, #2583, #2616, #1998, #2700 |
| 6 | Design-first — real premise pass owed, none yet verified | 19 | see below |
| 7 | Blocked (10) + gated (5) — owner decision / do-not-touch | 15 | see below |

0 + 1 + 5 + 1 + 2 + 4 + 7 + 19 + 15 = 58.

### Live collisions checked and excluded

A full sweep of every open PR and every non-`main` remote branch, not just
issue state, found three items mid-flight right now that must **not** be
re-briefed:

| # | Live as | Note |
|---|---|---|
| #2367 | PR #2753 (open) | Analyzer GPU-split warning chain |
| #2582 | PR #2719 — **shipped since this table was first written** | CUDA→CPU fallback detection. See the correction in Wave 2/7: a later child (#2765, under #2759) was independently filed against it and is likely a duplicate. |
| #2641 | PR #2754 (open) | Sidecar owner-note port-keying |

All three were originally going to land in Wave 2/3/6 respectively based on
issue state alone — the PR check is what moved them to Wave 7 (gated) instead.
Two stale local-only branches (`docs/docs-2346-instruments`,
`fix/server-2687-external-files-floor-glob`) were also found with no PR and no
recent commits — dead, not live; #2346 stays in Wave 6 rather than being
treated as in-progress.

### Wave 0 — bookkeeping (ready, no code)

The cheapest reduction available, same shape as Round 4's Group 1.

- **#2056** — resolve against #2026, now that #2026 has shipped. Duplicate, or
  split the upstream-blocked half cleanly.
- **#2042** — this sweep's own tracking issue; update its numbers, do not
  close until Round 5 lands.
- **#1966** — ops-48 `@nanonets/graft` evaluation. **Date gate expired
  2026-08-14, now two weeks overdue.** A yes/no, not a design.
- **#2435** — on-box register campaign tracker; update to reflect Wave 4/5's
  disposition of its remaining rows.

### Wave 1 — #898 phase 2 (execute-only)

**Dispatch this first, unconditionally.** No further round should pass with
this sitting fully briefed. Spec (#2147) and plan (#2151: 10 tasks, 65 steps,
28 mutations, two PRs in a load-bearing order) are both merged; brief a fresh
implementation thread from the ticket and nothing else — do not fork this
session for it.

### Wave 2 — decision-owed singles (low/medium stakes)

**QUEUED — being decomposed and dispatched as this doc was written, 2026-08-28.**
Parent tracking issue **#2759** bundles this wave (plus #2582, already shipped
before the parent was filed — see the correction below — and #2700, a real
on-box run, into one branch/PR) as a 9-child Open Engine chain:

| Item | Child | Fix |
|---|---|---|
| #2608 | #2760 | Aligner right-boundary fix |
| #2496 | #2762 | Quarantine-health exclusion |
| #2516 | #2763 | SSE reconnect allowlist |
| #2747 | #2764 | `blankCommentsAndStrings` fail-loud |
| #2682 | #2766 | `asr.warm` allocator-peak fix |
| #2596 | #2767 | `resolve-release.js` — flagged for **high**-depth PR review |
| #2700 | #2768 | On-box acceptance run (not a diff — see Wave 5) |
| — | #2769 | Final `[claude][verify]` child, opens the PR on pass |

Decisions were made by the filer (documented on #2759) rather than deferred to
a same-day owner pick, since the queue could move immediately: #2608 →
search forward for a dash-prefixed occurrence and prefer it over a bare
mid-word hit; #2596 → hardcode the re-normalize step to
`server/tts-sidecar/requirements/*.txt`, not a generic `.gitattributes`-driven
mechanism (kept at high-depth review given the issue's own stated blast
radius); #2496 → exclude non-quarantined-but-gating rows from the report
entirely, updating the existing regression test. All lanes route to `[claude]`.
**Outcome not yet known** as of this writing — update this table when #2769
lands.

**Correction found while filing this table: #2765 (targeting #2582) is very
likely a duplicate.** #2582 closed via PR #2719 (merged) *before* #2759 was
filed — that PR already added CUDA-provider-fallback detection at
`server/tts-sidecar/main.py`, `server/src/routes/sidecar-health.ts`/`info.ts`,
and `src/components/device-panel.tsx`. #2765's brief describes building the
same detection again. Premise-check it against current `main` before it
executes, or pull it from the chain.

- **#2608** — dash-invariant needle search's fuzzy path: extend the anchor,
  skip the mid-word-hit short-circuit for fuzzy hits, or something else.
- **#2496** — quarantine-health: exclude "not quarantined — still gates" rows,
  relabel their bucket, or leave as-is (three options in the issue, with a
  named test that would need updating for option 1).
- **#2516** — should the SSE reconnect skip retrying a `chapter_failed` tick
  that carries a stable `errorCode`, and how broadly. **Explicitly marked
  "not urgent"** by its own filer — lowest priority in this wave.
- **#2682** — `asr.warm`'s footprint key: leave the 128MB seed as a permanent
  floor, switch measurement instruments, or document it as structurally
  unfalsifiable for this model class.
- **#2747** — `blankCommentsAndStrings()`'s regex-literal blind spot: real
  minimal JS tokenizer, accept-and-document, or a narrower structural
  mitigation that fails loud instead of silently blanking.

*Recommended handling:* since each already carries pre-weighed options, this
does not need a full brainstorming→writing-plans cycle — a same-day owner pick
per item, then a same-round implementation brief, is proportionate. #2516 can
slip to a later round without cost given its own "not urgent" tag.

### Wave 2b — #2596 (decision-owed, Premium tier)

**QUEUED as child #2767 of #2759** (see Wave 2's table) — folded into the same
branch/PR as the rest of the chain rather than run separately. Named
separately here because the issue itself invokes the model-routing table's
Premium tier ("irreversible/high-blast-radius decisions") — it touches the
Pinokio release/install path with real blast radius to a live user's box, and
the CLI half it would change is acceptance-tested only, with no unit safety
net. **Kept at `high` PR-review depth within #2759's PR** rather than folded
into a quick same-day pick, per #2759's own note — the adversarial-review
weight the issue asks for should still apply even though it shares a branch
with lower-stakes items.

### Wave 3 — diff-shaped lane, one file (in decomposition)

- **#2750** — `SpeakerEngine` never restores its device pin after a
  self-demotion (`server/tts-sidecar/main.py`).
- **#2752** — `design_voice()`'s 1.7B-Base evict guard is blind to an in-flight
  load, same file, different site (`:6472` vs `:7942–8093`).

Both are `server/tts-sidecar/main.py` — **one lane, not two**, per the Round-1
Lane-4 rule (files that overlap share a lane regardless of how unrelated the
defects look).

**In decomposition 2026-08-29.** Both decisions have been taken by the operator;
both issues are now board Status **In Progress** and carry `area:side` alongside
their standalone `bug` label. Child issue numbers are not yet assigned.

> **Do not brief either child from its issue body alone.** The chosen options
> have not been written back — both bodies still end with their original
> *Decision owed* line enumerating the alternatives, so a cold agent reading only
> the issue will re-open a settled question. This is the same shape as #2721,
> where a deferral outlived the decision that closed it. The options differ
> materially in code, not just in wording: for **#2750**, the teardown-gate fix
> also has to widen `maybe_free_idle`'s `!= "cuda"` gate (`main.py:8093`, the
> field the bug corrupts is the one teardown is gated on), the
> restore-at-demotion fix does not go near it, and the third option changes
> whether plan
> [264](264-vram-aware-gpu-placement.md)'s teardown contract (`:526-531`) applies
> to `SpeakerEngine` at all. For **#2752**, the two options put the wait on
> opposite sides — a wait-then-evict path inside `unload_base17()` mirroring
> `unload_design()`/#2070's "design wins" policy, versus refusing admission in
> `design_voice()` — which decides *which* operation blocks and for how long.

### Wave 4 — register mechanics (decide #2708 first, then lane)

**IN PROGRESS on a concurrent thread as of 2026-08-28 — outcome not yet
known.** Update this section once it lands rather than re-briefing into it.

- **#2708** — decide whether the on-box register carries a changelog at all.
  **Take this first** — it plausibly shapes what #2599/#2603/#2721 should even
  do, and going in without deciding it risks a sixth register ticket the way
  #2629's closure produced #2721.
- **#2599** — `--against-published` is blind to row content.
- **#2603** — no mechanical guard validates `A\d+`/`E\d+` citations against the
  register's actual headings.
- **#2721** — rehome the deferral #2629's closure orphaned.

### Wave 5 — on-box, one GPU sitting

The deliverable is a measurement, not a diff, same as every prior round's
Group 8 — except this time it needs to actually be scheduled.

- **#1084** + **#1527** — ASR content-QA `maxWer` calibration for es/fr/de/ru.
- **#1685** — verify #1682 cloud request sizing; calibrate stage-2 local input
  fraction.
- **#2583** — ops-67: add the missing register row for `ensureOrtMarker`
  owner==='plain'/'none'.
- **#2616** — the Ночной дозор Group-C session. **Re-scope before dispatch** —
  #2288 (one of its two paired code bugs) shipped without the session running;
  confirm what is actually still unmeasured before re-briefing it as-is.
- **#1998** — cloned-voice identity loss across languages (0.600 → 0.229).
- **#2700** — **QUEUED as child #2768 of #2759** (see Wave 2's table) — a real
  on-box run folded into the same chain, not skipped despite riding alongside
  diff-shaped work. Confirm a *successfully rebuilt* centroid scores
  correctly, not just that reassignment discards the stale one (the only
  prior on-box run hit `too-short` and never reached this case).

### Wave 6 — design-first: a real premise pass owed (19)

**None of these have had the Round-3-style verification pass.** Unlike
Round 4's Group 7 (which took a premise check before dispatch), most of this
wave is the "growth" bucket that has sat completely untouched, title-only,
across all four rounds. Run the premise pass — `--comments` included, per
Round 3's rule that `gh issue view --json body` silently drops the field where
scope changes land — before any phase-1 thread starts. Then take the first
4–6, defer the rest, per the standing rule.

- **Carryover from Round 4 Group 7 (6):** #2131, #1309, #485, #1393 (paused
  after three rejected designs — restart needs a fresh thread from the
  `synthesiseChapter` publishing question, not a fourth revision), #2639,
  #2656 (the #1976/#1996 successor).
- **Growth "standalone decisions" (10 — #2367 excluded, live PR #2753):**
  #2303, #2331, #2347, #2352, #2362, #2366, #2369, #2433, #2434, #2449. Every
  one of these is phrased "decide whether/what" and none has ever been
  triaged by a round.
- **Colon-rule / tag-clause chain (2):** #2346 — **correction: this is not
  untriaged.** Its design already shipped (PR #2426, merged 2026-08-18,
  "design and plan the #2346 tag-clause colon rule" — a full worktree of
  five design/plan commits). #2346 is waiting on an **implementation
  thread**, not a premise pass, the same shape as #898. (A separate, stale
  branch `docs/docs-2346-instruments`, last touched 08-20 with no PR, is
  unrelated leftover — not live, safe to ignore.) #2404 ("decision owed" per
  its own title) pairs with it and does still need triage.
- **#2742 (1):** Qwen duration golden gate's statistical power — single-draw
  assertion, needs a decision on how many draws is enough.

### Wave 7 — blocked + gated (15, owner decision / do-not-touch)

**Blocked (10, unchanged since Round 4):** #1228, #893, #711, #431, #790,
#1477, #1335, #822, #1001, #947. The Round 4 park-vs-collapse decision is now
**two rounds** unanswered — force it this round.

**Gated — live PR, do not re-brief (2):** #2367 (PR #2753), #2641 (PR #2754).

**Shipped since this wave was written (1, was gated):** #2582 — PR #2719
merged. Total open count in the summary table above (58) has not been
re-decremented pending #2765's disposition (see Wave 2) — if #2765 is closed
as duplicate rather than producing a second fix, #2582 drops out and the real
total is 57.

**Gated — paused wave, unchanged (1):** #1600 — fs-38 Wave 3 stays
paused pending its own unpause decision. (#2054 closed by PR #3014.)

### Sequencing

1. **Wave 1** (#898) and **Wave 0** (bookkeeping) in parallel — file-disjoint,
   no reason to sequence them behind anything.
2. **Wave 2** owner picks, same day if possible — then brief the
   implementations in the same round.
3. **Wave 4**, #2708 first, then the register lane.
4. **Wave 3** lane.
5. **Wave 5** at the next GPU sitting — this is the fourth round calling it
   the best ratio in the plan; do not let it slip a fifth time.
6. **Wave 6** premise pass first, phase-1 threads for the survivors after.
7. **Wave 2b** and **Wave 7**'s two owner decisions on their own schedule —
   not blocking anything else above.

### Decisions this round needs from the repo owner

1. **Wave 2's five picks** — each already has 2–3 options laid out in the
   issue; a same-day decision unblocks same-round implementation.
2. **Wave 2b (#2596)** — Premium-tier review before any implementation, given
   the stated blast radius.
3. **Wave 4 (#2708)** — changelog or not, before the rest of the register lane
   proceeds.
4. **Wave 7 blocked** — park with a label, or collapse into one tracking
   issue? (Carried, unanswered, from Round 4.)
5. **Wave 5** — is a GPU sitting available? Fourth round asking.
6. **fs-38 Wave 3** — stays paused, or unpauses (#1600)? (#2054 closed by PR #3014.)

## Invariants to preserve

1. **Lane files must not overlap.** The Round 1 grouping above is the constraint,
   not a suggestion — #2021 / #2022 / #2030 share `main.py` and must stay in one
   lane; #2011 / #2033 share `synthesise-chapter.ts` and must stay in one lane;
   #2014 / #2012 share `config/registry.ts`.
2. **Lane 1 must not contend for the GPU.** Its work is guard logic, not audio —
   run it with `CUDA_VISIBLE_DEVICES=` so it cannot queue behind Lane 4.
3. **The six in-flight items stay untouched** until their worktrees merge and
   tear down.
4. **Every lane is a fresh worktree + branch** per the Branching workflow, with
   `npx husky` run so hooks are not silently inert.

## Test plan

### Automated coverage

Per-item; each issue's own Acceptance section is the spec. The round-level bar
is unchanged from CLAUDE.md: every lane lands paired tests, and every bug fix
lands a regression test that is **mutation-verified** — the producer line
reverted, the test confirmed RED, the line restored. #2028 exists precisely
because `retry: 1` can defeat that verification, so Lane 2's fix is a
prerequisite for trusting the others' red phases.

### Manual acceptance walkthrough

Not applicable at the round level. Items with on-box acceptance are listed under
"Excluded — on-box gated" and are not in any lane.

## Out of scope

- The 11 blocked items, until their upstream unblocks.
- The 6 in-flight items, which belong to their own sessions.
- Feature work of any kind. This is a debt sweep.

## Ship notes

**Round 1 — shipped 2026-08-01.** Four lanes, 12 issues closed across PRs
[#2045](https://github.com/dudarenok-maker/Castwright/pull/2045),
[#2049](https://github.com/dudarenok-maker/Castwright/pull/2049),
[#2048](https://github.com/dudarenok-maker/Castwright/pull/2048),
[#2064](https://github.com/dudarenok-maker/Castwright/pull/2064) and
[#2066](https://github.com/dudarenok-maker/Castwright/pull/2066). 14 issues
filed; the open queue went 54 → 60.

**Round 2 — shipped 2026-08-05.** Five lanes, **16 issues closed** across PRs
[#2116](https://github.com/dudarenok-maker/Castwright/pull/2116),
[#2124](https://github.com/dudarenok-maker/Castwright/pull/2124),
[#2125](https://github.com/dudarenok-maker/Castwright/pull/2125),
[#2126](https://github.com/dudarenok-maker/Castwright/pull/2126) and
[#2122](https://github.com/dudarenok-maker/Castwright/pull/2122):

| Issue | Lane |
|---|---|
| #2060, #2061, #2062, #2069 | 1 · golden bless-guard flag split |
| #2070, #2094, #2047, #2055, #2038 | 2 · sidecar `main.py` |
| #2011, #2052, #2088 | 3 · server correctness singles |
| #2083, #2084, #2078, #2100 | 4 · test hygiene |
| #2036, #1931 | 5 · ops guards |

**Nothing shipped as a partial.** Seven issues were heading for `Refs` and each
had its remaining work delivered instead, at the repo owner's explicit
direction ("want these closed, not another follow-up run").

Round 2 filed **no new issues** — a change from Round 1, where 14 were filed
against 13 closed. Every finding was either fixed in the lane that surfaced it
or, where it was a false premise, corrected in place on the issue that carried
it.

The round's substantive findings are in "Round 2 outcome" above — in particular
the seven green-checking-nothing cases and the proposed rule that a new guard
must ship with a demonstration that neutralising it turns something red.

**Round 3 — ran 2026-08-05.** Design-first. Four PRs
[#2143](https://github.com/dudarenok-maker/Castwright/pull/2143),
[#2147](https://github.com/dudarenok-maker/Castwright/pull/2147),
[#2151](https://github.com/dudarenok-maker/Castwright/pull/2151) and
[#2150](https://github.com/dudarenok-maker/Castwright/pull/2150); **#2033,
#1808 and #2144 closed**, plus #898's entire design phase (spec, plan, handover
brief). #2144 and #2149 filed.

Unlike Rounds 1 and 2 this round's return was in **triage, not diffs**: four of
ten filed premises did not survive verification and a fifth was already solved
by a concurrent session. Two plan docs would otherwise have been written against
defects that do not exist. Full detail in "Round 3 outcome" above, including the
`gh issue view` comment-blindness trap and the cold-brief handoff.

**Round 4 — dispatched incrementally 2026-08-11 → 2026-08-28, not as a single
sitting.** Baseline re-taken at 49 open items (14 bug + 35 chore) on `main` @
`f2b2e866`. 17 of the board's 53 tracked items closed between 08-25 and 08-28
alone; #1976/#1996 consolidated into #2656; #1932 closed via a decomposed
agent-instruction chain (#2689–2692). **#898 phase 2 did not ship** despite
three rounds naming it the highest-value item in the plan. Zero on-box GPU
sittings happened across all four rounds. 8 new items were filed against
findings this round surfaced, of which a premise-check found 6 are
decision-owed rather than diff-shaped. Full detail in "Round 4 outcome" above.

**Round 5 — planned 2026-08-28.** Cut into seven waves by what unblocks each,
not by size — bookkeeping, #898 execute-only, decision-owed singles (split
into a Premium-tier item and five lower-stakes ones), a diff-shaped
one-file lane, register mechanics (one decision gating a three-item lane), an
on-box sitting (now 7 items), a design-first premise pass (19 items, none
verified yet), and blocked/gated (15). A full open-PR and open-branch sweep
(not just issue state) found three items — #2367, #2582, #2641 — mid-flight
right now and moved them to gated rather than re-briefing into a live
collision. Full plan, wave-by-wave, in "Round 5 — the recut plan" above.
Driving board: `docs/features/277-v115-bug-chore-sweep-board.html`.

**Still open from this sweep:** #1984, #1393 (paused after three rejected
designs), and everything catalogued in Round 5 above. #1950 shipped inside
another session's PR and stays open only for want of an issue linkage.
