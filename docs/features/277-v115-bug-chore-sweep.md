---
status: active
shipped: null
owner: null
---

# 277 — v1.15 bug & chore sweep: triage and round plan

> Status: active — **Round 1 SHIPPED 2026-08-01** (all four lanes merged);
> Rounds 2 and 3 outstanding. See "Round 1 outcome" below.
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

## Round 2 — five lanes, 9 issues (after Round 1 merges)

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

## Round 3 — design-first (9)

These fail the fix-now bar: each has more than one defensible answer. The
deliverable per item is a **phase-1 pass — ticket + plan doc**, not a diff.

- **#1996** — VRAM reclaim hook location. Sent back to design 2026-08-01 after
  review proved `/unload` is never issued at render completion and *is* issued
  mid-render at phase boundaries.
- **#2037** — the sidecar supervisor gives up permanently when the exiting child
  still holds `:9000`; TTS stays down until a manual server restart. Note the
  known hazard: `/sidecar/restart` is **not** a safe supervision check.
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

(Filled in when the sweep completes — per-round PR numbers and the final
open-queue count.)
