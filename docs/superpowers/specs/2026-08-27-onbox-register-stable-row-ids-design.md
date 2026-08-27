---
status: draft
date: 2026-08-27
---

# On-box register: stable row IDs, and a publish check that can see row content

Closes the design passes owed by
[#2599](https://github.com/dudarenok-maker/Castwright/issues/2599),
[#2603](https://github.com/dudarenok-maker/Castwright/issues/2603),
[#2629](https://github.com/dudarenok-maker/Castwright/issues/2629),
[#2634](https://github.com/dudarenok-maker/Castwright/issues/2634) and
[#2653](https://github.com/dudarenok-maker/Castwright/issues/2653).

> **Citation hygiene in this document.** This spec discusses row IDs as data,
> never as citations. It deliberately avoids the `register row <ID>` idiom that
> `check-register-citations.mjs` Check A recognises — an earlier draft of this
> file was itself the only source of fatal citation errors in the tree. IDs
> below appear bare and in backticks for that reason.

## Problem

Four of those five tickets describe one mechanism from four angles, and the
mechanism is not an accident — it is enforced by a check.

`scripts/check-onbox-register.mjs` check 4 (`:313-327`) fails the build unless
each group's row numbers are "contiguous from 1". Discharging a row therefore
cannot leave a gap: every later row in the group must shift down. The register
holds 60 owed rows across seven groups (`A`=37, `B`=2, `C`=4, `D`=3, `E`=10,
`G`=2, `H`=2) and discharges several per wave, so each wave rewrites a large
fraction of the ID space.

Row IDs are the register's public interface. They are cited from code comments,
run sheets, plan docs, `server/.env.example` and GitHub issue bodies. Every one
of those is a positional reference into a sequence the checker *requires* to be
rewritten on every discharge.

The observed damage:

- **#2629** — PR #2626's wave-5 campaign discharged three Group A rows and
  rotted 38 citations across 11 files. Two comments about the catastrophic-WER
  override cited `A37`, which by then named an unrelated ORT-marker row.
- **#2603** — PR #2578's review loop hit two `origin/main` renumberings inside
  one PR. Round 21 alone found 26 stale row-number occurrences in a single run
  sheet, a register-authored "recompute" note written entirely in
  pre-renumbering IDs, and a row whose own body cited itself.
- **#2634 / #2653** — the same finding filed twice, three weeks apart. `E6` and
  `E8` each name two rows, because the Blocked section borrows IDs from the
  Group E sequence that renumbers underneath it. `check-onbox-register.mjs`
  cannot see it: its duplicate detection covers group *letters*, never row IDs,
  and the Blocked section's `###` headings are not scanned at all.
- **#2599** — `--against-published`, the comparator the "Live view" procedure
  mandates immediately before every publish, compares only the owed total,
  per-group counts and row IDs. During PR #2578 round 18 the published artifact
  had been reverted by another session to a stale version of `A41`'s body; the
  comparator returned `OK` because the count and the ID still matched. The
  manual byte-diffs in rounds 13-18 did the real verification work.

**The rot is measurable in the tree today.** `npm run check:register-citations`
currently reports 16 citations to IDs that no longer exist — `A43`, `A45`, `B3`,
`F2`, `F3` — across `docs/features/INDEX.md`, four plan/spec documents and the
`cast-id-drift` run sheet. Each is downgraded to a non-fatal note because a
discharge annotation sits nearby. They are the visible residue of past waves.

**And it is live right now.** The `wt-onbox-wave9` lane holds uncommitted
register edits discharging `A8`/`A9` and renumbering every Group A row from `A9`
through `A37` — ~29 rows, `60 owed` → `58 owed`. That lane is doing nothing
wrong; it is following the rule the checker enforces.

## What this does not attempt

- **Generating the live view from the markdown.** The two are deliberately
  separate authored artifacts — the HTML condenses and rewrites each row's prose
  rather than mirroring it. Generation is a larger design; nothing here assumes
  or approaches it.
- **#2603's title-match check** and **self-reference detection**. See "Ticket
  disposition" — both are named honestly as not built.
- **A retired-ID ledger.** The design achieves never-reuse structurally instead;
  see design 1.

## Design

### 1. Stable row IDs, seeded above all history

**A row ID is allocated once and never reused. Discharging deletes the row and
leaves a gap.**

The naïve version of this — freeze in place, seed the next ID at each group's
current high-water — is **wrong, and the first draft of this spec got it wrong**.
Group A's live high-water is `A37`, but Group A has previously run well past it:
`A38`, `A43` and `A45` are all historically-used IDs that documents in this tree
still cite. Seeding at `A38` would re-issue an ID that
`docs/testing/onbox-sitting-plan.md:74` already uses to mean something else —
and would *degrade detection*, because that citation currently reports as a
nonexistent ID and would instead resolve silently to the wrong row. Freezing at
the wrong floor is worse than renumbering.

So: **one final re-key into a range no group has ever used, then frozen
forever.**

- Every group's rows are renumbered once, in their current order, starting at
  `101`: Group A becomes `A101`…`A137`, Group B `B101`…`B102`, and so on.
- Each group carries `<!-- next-id: A138 -->` immediately after its
  `## Group A — …` heading. Adding a row takes that value and bumps it.
- **Every ID below 101 is retired by construction** — one documented sentence,
  no ledger, no archaeology. The all-time high-water of any group is far below
  100 (Group A's is around `A48`), so the range is provably unused.
- Historical citations to `A43`, `A45`, `B3`, `F2`, `F3` **stay dangling** and
  keep reporting as nonexistent IDs. That is the point: they are wrong, and they
  remain visibly wrong rather than silently resolving to an unrelated row.

Check 4 (contiguity) is deleted. Two checks replace it:

- **4a — uniqueness.** Every `### <Letter><N>` heading in the whole file appears
  exactly once. This scans outside the `## Group` sections too, which is what
  would have caught the `E6`/`E8` collision. It changes scan scope only — the
  Blocked and Unconfirmed sections stay excluded from the owed total and the
  glance table exactly as today. (The Unconfirmed section is a bullet list, not
  `###` headings, so it contributes nothing; noted so the scope claim is
  accurate rather than aspirational.)
- **4b — allocation floor.** Every row ID in a group must be strictly below that
  group's `next-id`. A group with no marker is an error, not a skip.

The marker is an HTML comment: invisible in rendered markdown, and it needs no
glance-table column (`parseGlanceTable` requires exactly three cells). It is
authoring metadata, so the live view does not mirror it and `checkLiveView`
ignores it — `stripHtmlComments` already runs on the HTML side.

**Blocked-section rows lose their IDs entirely** (#2653's option 3, #2634's
option 3). This reverses an earlier draft that continued Group E's sequence into
the Blocked section. Two independent reasons that was wrong: `E11` is the
historical ID of what is now `E9` and is cited in several files, so it would
have been a reuse collision of exactly the kind design 1 exists to prevent; and
`parseRegisterRows`' own docstring (`check-register-citations.mjs:578-585`)
states that headings outside a `## Group <Letter>` section are **not collected**,
so a blocked row's ID was never resolvable by the citation checker anyway.
Dropping the IDs needs no parser widening, makes all five blocked rows
consistent with the three that already carry none, and removes the ambiguity at
source. The two citation sites that reference blocked rows move to citing by
title in the same diff.

### 2. `--against-published` sees row content (#2599)

An earlier draft proposed comparing the working `.html` against the saved
published `.html` and reporting a difference in **either** direction. **That is
wrong and the register already records why**, at `:277-284`:

> An early version of this check compared both directions symmetrically, which
> inverted the diagnosis (failed on every ordinary publish and told the operator
> to delete the rows they were about to ship) — fixed before this landed. A
> later version still fired on every legitimate row discharge…

Editing a row body and then publishing is the single most common thing this
register does. A symmetric content diff fires on all of it.

**The fix is a three-way comparison**, reusing the baseline machinery #2199
already built for exactly this shape of ambiguity. Three texts:

| | |
|---|---|
| `working` | the live-view `.html` in this branch |
| `published` | the saved copy of the page currently at the artifact URL |
| `baseline` | `origin/main`'s copy of the live-view `.html`, fetched fresh |

For each row present in all three, compare normalised body text:

- `published == baseline` → the live page simply has not received your edit yet.
  **Silent.** This is every ordinary publish.
- `published == working` → already up to date. **Silent.**
- `published != baseline` **and** `published != working` → the live page diverges
  from both the shipped state and your intended state. Something published or
  reverted it outside this branch. **Report**, naming the row and showing all
  three texts.

PR #2578's incident lands in the third case: `baseline` carried the merged fix,
`published` had been reverted to the pre-fix body, `working` had the fix. It is
reported. An ordinary publish lands in the first case and stays silent.

Mechanics:

- Rows are keyed by `<span class="num">` **within each `<details class="item">`
  block**. `parseLiveViewSections` collects `num` spans with a flat
  section-level regex and never associates one with a body, so this needs a new
  per-`<details>` parser rather than reuse of that function — an earlier draft
  claimed reuse and was wrong.
- The parser must cover the `BLK` and `?` sections, which `parseLiveViewSections`
  skips via its `gtag` filter. Without that, the content check would silently
  cover 60 of 67 rows. Since blocked rows lose their IDs under design 1, those
  sections are keyed by heading text instead.
- Normalise before comparing: decode entities, strip tags, collapse whitespace.
  Formatting-only differences are not findings.
- The summary strip rides the same three-way rule. A count-changing publish moves
  the strip in `working` but leaves `published == baseline`, so it stays silent;
  a strip that diverges from both is reported.
- Extraction failure is an error, never a skip — the rule the rest of
  `checkLiveView` already follows.

**Stated hole, not closed here.** A published page that *dropped a row entirely*
is still invisible: tracked-only rows are the normal pre-publish state and are
skipped by design in `extraOnly`, and "present in all three" skips them too.
Design 2 catches body-text divergence, which is the PR #2578 shape; a whole-row
revert remains uncovered. Closing it needs the same three-way rule applied to
row *presence*, which interacts with `--discharging` in ways this design has not
worked through. It is recorded here rather than implied to be covered.

### 3. Wire the citation checker (#2603)

`check-register-citations.mjs` shipped in #2630, and its own header (`:12-36`)
states the gap: `check:register-citations` is invoked from exactly one place —
its own CLI tests under `npm run test:hooks`, a step scope-gated to
`docs/testing/**`, the register, `CLAUDE.md` and `scripts/**`. Rot in
`docs/features/**`, `src/**`, `server/**` or `e2e/**` is caught only when some
in-scope file happens to change too. The header also rules out widening
`test:hooks`' inputs: the checker reads essentially every tracked file, so
declaring that would make the step un-cacheable for everyone.

A dedicated `.github/workflows/register-citations-check.yml`, **no path filter**
— the checker's inputs are the whole tree, so no path filter can be correct.

**It is added to `main`'s required status checks.** #2629's option 3 is "catches
rot at PR time", and the model this mirrors,
`.github/workflows/onbox-register-check.yml`, says in its own comment (`:5-8`)
that it is *not* required — which is exactly why it can afford a path filter. A
non-required always-run check is visible, not enforcing. The tree is green on
this checker today (16 annotated notes, zero fatal findings), so requiring it
does not block anything currently open. **This is a repository ruleset change
that cannot be made from a PR** — it is an explicit hand-off step, listed in the
implementation plan, not something the merge accomplishes on its own.

Adding a workflow also touches `scripts/tests/workflow-wiring.test.mjs` and
`verify-cache.mjs`'s `.github/workflows/**` glob; both move in the same diff.

### 4. The update mechanics

The register's own procedural prose is part of the deliverable. The
renumbering invariant is asserted in far more places than an earlier draft
claimed, and the implementation plan carries the full inventory rather than a
sample. It spans, at minimum:

- `check-onbox-register.mjs` — `formatRowList`'s contiguous-range collapse
  (`:171-183`); the `stripFences` residual-limitation comment, which is phrased
  *in terms of* check 4 (`:44-49`); operator-facing error strings at `:247` and
  `:811`; four further comment/error sites at `:577-579`, `:963-967`, `:1362`,
  `:1385-1389`, including the `--discharging` unconsumed-name error that
  instructs the operator to name the group's highest ID.
- `scripts/tests/check-onbox-register.test.mjs` — two direct check-4 tests, six
  verbatim assertions of the "numbered contiguously" string, one assertion that
  goes vacuous, the #2199 discharge-and-renumber scenario, and
  `buildAheadBaselineText`/`computeMaxRowNumber` (see "Testing").
- `check-register-citations.mjs` — its entire stated premise (`:1-10`,
  "…renumbers every later row"), plus `:40-52`, `:355-372`, `:392-417`,
  `:621-630`, `:1742-1747`.
- `docs/testing/onbox-acceptance-register.md` — "Live view" step 2's
  `--discharging` guidance, the ~45 lines of two-shape arithmetic at `:152-198`
  whose "how the IDs will be spelled" branch is entirely renumbering, `:212`,
  `:277-284`, the changelog at `:356-477`, and `:3015-3021`, `:3047-3049`.
- `CLAUDE.md:745` — Before-shipping step 3 states the wrinkle inline.
- Nine run sheets / sitting packs and five feature docs narrate the invariant.

Under stable IDs the `--discharging` counter-instruction ("the ID that vanishes
is the group's highest, not the row you conceptually removed") is simply
deleted: the ID that vanishes *is* the row that was discharged. The flag keeps
working.

**Incidental fix, same diff:** `:184-186` cites "Group F's sole row, F1" as "a
real, live example of exactly this shape". There is no Group F in the glance
table. The passage is being rewritten anyway.

## Delivery: two PRs, and the rule that forces it

`resolveBaselineGroups` (`check-onbox-register.mjs:501-516`) rejects the baseline
outright if `checkRegister(baselineText)` reports **anything** — and the baseline
is `origin/main`'s register, read through the *new* checker. So:

> **Any tightening of `checkRegister` is retro-applied to `origin/main`'s copy.
> A guard therefore cannot land in the same PR as the data it requires**, or
> `--against-published` fails with `CANNOT_VERIFY_BASELINE_ERROR` and the
> register's own runbook (`:210-220`) says that can only be fixed from `main`.

This is a general rule about this codebase, not a quirk of this change, and it
belongs in the checker's header comment.

The re-key cannot land under today's checker either — `A101`…`A137` is not
contiguous from 1. So the split is data-then-guard, with the data chosen so each
half is green under the checker in force at the time:

**PR 1 — data only.** Adds the `next-id` markers (seeded at their post-re-key
values, e.g. `A138`), drops the Blocked-section row IDs, fixes the Group F
sentence, moves the two blocked-row citations to cite by title. Every one of
these passes *today's* checker: markers are inert comments, contiguity is
untouched, and the Blocked section is unscanned. Publishes normally.

**PR 2 — the re-key and the guards.** Renumbers every group to `101`+, deletes
check 4, adds 4a/4b, adds design 2's three-way content check, adds the workflow,
and sweeps the prose inventory in design 4. Its baseline is PR 1's `main`, which
under the *new* checker passes: no duplicate IDs, markers present,
`A1`…`A37` all below `A138`, and no contiguity requirement left to fail.

## Sequencing against wave 9

Wave 9 merges first; this design assumes it. That lane's diff is written and
this one has a plan, a review gate and two publishes ahead of it. Wave 9 sweeps
its own ~29 rows of rot under the current rules, as any wave PR does today — and
is the last wave that ever pays that cost.

**No row number in this branch may be hardcoded from today's register.** Group
sizes, the re-key ranges and every `next-id` value are computed at rebase time
from the register as it then stands. The `101` floor is fixed; what maps into it
is not. Tests fixture their own registers rather than asserting against the real
file's numbering.

## Ticket disposition

| Issue | Outcome |
|---|---|
| **#2599** | Closed by design 2, with the whole-row-revert hole stated in the issue's close comment rather than left implied. |
| **#2603** | Closed by design 3 — **without** its title-match option and **without** self-reference detection. The latter is structurally impossible in the shipped checker: the register's own path is in `FROZEN_EXACT` (`check-register-citations.mjs:386`), so its body is never scanned. Both omissions go in the close comment. Its non-renumbering damage (the "five states vs eight states" drift) is untouched by this work; an earlier draft claimed its "entire why-this-matters is renumbering damage", which was not accurate. |
| **#2629** | Closed by design 1 + design 3. Not "option 2" — that is a per-row slug field, which this declines. Stable positional IDs are a fourth option; the close comment says so rather than claiming an option the issue did not offer. |
| **#2634** | Closed as a **duplicate of #2653**, honouring its "add a uniqueness check" instruction via 4a. |
| **#2653** | Closed by design 1 via its **option 3** (drop blocked IDs), plus the paired uniqueness check. |

## Testing

`scripts/tests/check-onbox-register.test.mjs`:

- a group with gaps (`A104, A106, A107`) passes — regression test for the deleted
  check 4, red before the change;
- a row ID duplicated across sections fails — the #2634/#2653 repro, red before;
- a row ID at or above its group's `next-id` fails;
- a group with **no** `next-id` marker fails, so a missing marker cannot silently
  disable 4b;
- the three-way content check: `published == baseline` with a differing `working`
  stays **green** (the ordinary-publish regression test — this is the assertion
  that would have caught the symmetric-comparison mistake);
- `published` differing from both `working` and `baseline` is reported — the
  #2599 repro, red before;
- a formatting-only difference (whitespace, entity encoding) stays green;
- a strip divergent from both is reported.

**Five existing real-tree CLI tests must move.** `computeMaxRowNumber`
(`:2058-2071`) and `buildAheadBaselineText` (`:2092-2101`), consumed at `:2209`,
`:2333`, `:2360`, `:2517`, `:2600`, each derive `high-water + 1` as "an ID that
does not exist yet" and append it to a baseline that must pass `checkRegister`.
Under 4b that synthesised ID must sit **below** `next-id`, not above the
high-water — otherwise all five flip to `CANNOT_VERIFY`. The re-key leaves a
wide unused band inside each group's range, so the helper picks from there. This
is named explicitly because the tempting repair — loosening the fixture — is how
the floor gets quietly weakened.

`scripts/tests/check-register-citations.test.mjs`: a citation to a gapped
(discharged) ID still follows Check A's annotated/unannotated split. Gaps are now
the normal state, so this pins that the shipped behaviour survives.

Real-tree verification: `npm run check:onbox-register` and
`npm run check:register-citations` both green (the latter meaning zero fatal
findings; the 16 pre-existing annotated notes are expected and unchanged).

## Shipping notes

- **No new on-box acceptance row.** This ships no behaviour only real hardware
  can prove. Both PRs move register surfaces and must publish per the standing
  procedure — PR 2's publish is the first exercise of design 2.
- **No release-notes entry.** CI/tooling and process only, no user- or
  operator-visible delta. Stated rather than silently skipped.
- **One manual hand-off:** adding `register-citations-check` to `main`'s required
  status checks is a ruleset change no PR can make.
