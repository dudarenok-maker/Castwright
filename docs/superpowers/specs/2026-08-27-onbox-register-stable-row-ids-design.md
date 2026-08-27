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

Four of the five tickets describe one mechanism from four angles, and the
mechanism is not an accident — it is enforced by a check.

`scripts/check-onbox-register.mjs` check 4 (`:313-327`) fails the build unless
each group's row numbers are "contiguous from 1". Discharging a row therefore
cannot leave a gap: every later row in the group must shift down. The register
holds 60 owed rows across seven groups (`A`=37, `B`=2, `C`=4, `D`=3, `E`=10,
`G`=2, `H`=2) and discharges several per wave.

Row IDs are the register's public interface. The `row <ID>` idiom alone occurs
**226 times across 66 files** — code comments, run sheets, plan docs,
`server/.env.example`, and GitHub issue bodies that no tool in this repo can
reach. Every one is a positional reference into a sequence the checker
*requires* to be rewritten on every discharge.

The observed damage:

- **#2629** — PR #2626's wave-5 campaign discharged three Group A rows and
  rotted 38 citations across 11 files. Two comments about the catastrophic-WER
  override cited `A37`, which by then named an unrelated ORT-marker row.
- **#2603** — PR #2578's review loop hit two `origin/main` renumberings inside
  one PR. Round 21 alone found 26 stale row-number occurrences in one run sheet
  and a row whose own body cited itself.
- **#2634 / #2653** — the same finding filed twice, three weeks apart. `E6` and
  `E8` each name two rows, because the Blocked section borrows IDs from the
  Group E sequence that renumbers underneath it. The checker cannot see it: its
  duplicate detection covers group *letters*, never row IDs, and the Blocked
  section's `###` headings are not scanned at all.
- **#2599** — `--against-published` compares only the owed total, per-group
  counts and row IDs. During PR #2578 round 18 the published artifact had been
  reverted by another session to a stale version of `A41`'s body; the comparator
  returned `OK` because the count and the ID still matched.

**The rot is measurable today.** `npm run check:register-citations` reports 16
citations to IDs that no longer exist — seven distinct IDs (`A38`, `A43`, `A45`,
`B3`, `B4`, `F2`, `F3`) across eight files, including `docs/features/INDEX.md`,
four plan/spec documents, and the `cast-id-drift`, `language-recurrence` and
`onbox-sitting-plan` run sheets. Each is downgraded to a non-fatal note because
a discharge annotation sits nearby. They are the visible residue of past waves.

**And it is live.** The `wt-onbox-wave9` lane holds uncommitted register edits
discharging `A8`/`A9` and renumbering every Group A row from `A9` through `A37`.
That lane is doing nothing wrong; it is following the rule the checker enforces.

## Two designs this spec rejected

Recorded because both looked right and both are traps, and a future reader
will otherwise re-propose them.

**Rejected: freeze in place, seed the next ID at each group's current
high-water.** Group A's live high-water is `A37`, but Group A has historically
run to `A48`. Seeding at `A38` re-issues an ID that `onbox-sitting-plan.md:74`
already uses to mean something else — and *degrades* detection, converting a
visible nonexistent-ID error into a silent wrong-row resolution.

**Rejected: re-key every group into a never-used range (`A101`…`A137`), then
freeze.** This closes reuse completely and is blocked three independent ways:

1. **Blast radius.** It rewrites the 226 citation occurrences above — the #2626
   incident at ~6× scale, in one commit, in the same PR that would stand the
   citation checker up as a workflow.
2. **It cannot be published.** In `extraOnly`, `extra = found − expected`
   (`:844-847`). At the re-key's publish, `found` is the live page's `A1`…`A37`
   and `expected` is `A101`…`A137`, so **all 60 rows report as BEHIND**, and the
   `origin/main` filter removes none because `main` still holds the old IDs. The
   only mechanical escape is `--discharging` naming all 60 — which the
   register's own runbook (`:155-170`) names as the cardinal sin: *"Padding
   `--discharging` until the check passes is the exact failure mode this check
   exists to catch."*
3. **It launders wrong citations.** The register states at `:3015-3021` that "a
   given ID has named several different rows over this group's life", so an
   unknown share of the 226 citations are already wrong but still resolve. A
   positional old→new map rewrites each into a **permanently frozen** wrong ID,
   and stable IDs remove the only mechanism that would ever have exposed them.

## Design

### 1. Stable row IDs, with new rows allocated above all history

**A row ID is allocated once and never reused. Discharging deletes the row and
leaves a gap.**

- **Existing rows keep their IDs.** `A1`…`A37`, `B1`…`B2`, and so on are
  untouched. None of the 226 citations moves.
- **Each group carries `<!-- next-id: A101 -->`** immediately after its
  `## Group A — …` heading. New rows are allocated from that value, which is
  bumped on each allocation.
- **The floor is `101` for every group**, which is provably above all history.
  Full git history of the register and its live view — every `### <Letter><N>`
  heading and `<span class="num">` ever added or removed — gives all-time
  high-waters of **`A`=48, `B`=5, `C`=4, `D`=3, `E`=11, `F`=1, `G`=2, `H`=2**.
  The highest ID cited anywhere in the tree is `A46`. Nothing approaches 100.
- Historical citations to `A38`, `A43`, `A45`, `B3`, `B4`, `F2`, `F3` **stay
  dangling** and keep reporting as nonexistent. That is the point: they are
  wrong, and they stay visibly wrong.

Check 4 (contiguity) is deleted. Two checks replace it:

- **4a — uniqueness.** Every `### <Letter><N>` heading in the whole file appears
  exactly once, scanning outside the `## Group` sections too. The Unconfirmed
  section is a bullet list, not `###` headings, so it contributes nothing —
  stated so the scope claim is accurate rather than aspirational. Blocked and
  Unconfirmed stay excluded from the owed total and the glance table exactly as
  today; this changes scan scope only.
- **4b — allocation floor.** Every row ID in a group must be strictly below that
  group's `next-id`. A group with no marker is an error, not a skip.

The marker is an HTML comment. Verified inert against every parser in the file:
`splitSections` matches `^## `, `parseBodyGroups` matches `^### <Letter>\d`,
`parseGlanceTable` reads only the glance section, and `stripFences` touches only
fences. It needs no glance-table column (`parseGlanceTable` requires exactly
three cells). The live view does not mirror it and `checkLiveView` ignores it.

**Blocked-section rows lose their IDs entirely** (#2653's option 3, #2634's
option 3). `parseRegisterRows`' own docstring (`check-register-citations.mjs:578-588`)
states that headings outside a `## Group <Letter>` section are **not collected**,
so a blocked row's ID was never resolvable by the citation checker anyway.
Dropping them needs no parser widening, makes all five blocked rows consistent
with the three that already carry none, and removes the ambiguity at source.

**Residual limitation.** 4b prevents allocation *forward* into a used ID and the
`101` floor prevents collision with the historical overflow. Neither stops an
author hand-typing a **discharged** `A1`…`A37` ID into a new row: it is below
`next-id`, and the original row is gone, so uniqueness has nothing to compare
against. Closing that needs a retired-ID ledger, which contradicts the shipped
ruling that the register tracks **state, not history**. Documented in the
checker header alongside its other envelope edges. It is strictly narrower than
the rejected designs' hole, which covered `A38`…`A48` from day one.

**What 4a is worth, honestly.** Once the Blocked-section IDs are dropped, the
`E6`/`E8` collision is gone as data, and design 1 removes the convention that
produced it. 4a is therefore a regression pin against reintroduction, not a
check that will find something on merge day. It is worth having; it is not
worth overselling.

### 2. `--against-published` sees row content (#2599)

Two rules were tried and rejected before this one. **Symmetric comparison**
(report any difference between the working file and the published page) is what
the register already records failing, at `:277-284`: *"An early version of this
check compared both directions symmetrically, which inverted the diagnosis
(failed on every ordinary publish…)."* A **three-way rule** (silent when
`published` equals either `baseline` or `working`, report otherwise) fails on
the second publish from one branch — `baseline = X`, first publish sets
`published = Y`, review feedback edits `working = Z`, and `Y` equals neither.
Multi-publish-per-branch is this register's normal review cycle; PR #2578
published across rounds 13-21.

**The rule that holds.** For each row, compare normalised body text across three
texts — `working` (this branch's live-view `.html`), `published` (the saved copy
of the live page), and `baseline` (`origin/main`'s live-view `.html`):

> **Report iff `working == baseline` and `published != baseline`.**

In words: *a row this branch does not touch has changed on the live page.* That
is unambiguously someone else's edit or a revert, and it is the only shape that
is unambiguous without keeping per-branch publish state.

- Every ordinary publish is silent: rows you edited have `working != baseline`,
  so they are never examined; rows nobody touched have `published == baseline`.
- Re-publishing from the same branch any number of times is silent, for the same
  reason.
- PR #2578's incident reports: the fix had merged, so `baseline` carried it and
  `working` matched it, while `published` had been reverted.

**Stated boundary, not closed here.** A row this branch *is* editing is not
covered while under edit — with `working != baseline`, a concurrent revert by
another session is indistinguishable from this branch's own earlier publish
without state design 2 does not have. Also uncovered: a published page that
dropped a **whole row**, which `extraOnly` skips by design and this rule skips
too. Both are recorded in #2599's close comment rather than implied to be
covered.

**Mechanics — this is not "reuse", and an earlier draft wrongly said it was.**

- `--against-published` **never reads the tracked live-view HTML today**:
  `const liveViewHtml = read(LIVE_VIEW)` sits at `:1423`, *after* that mode's
  `return` at `:1420`. The "working" side of the comparison does not exist in
  that code path.
- So `checkLiveView` gains two new inputs (`workingHtml`, `baselineHtml`), and
  the CLI layer gains a baseline-HTML read.
- **One fetch, two reads.** The existing baseline resolution deliberately reads
  `FETCH_HEAD`, not `origin/main` (`:1023-1040`, per #2199 round 3 — a narrowed
  refspec can leave `origin/main` stale while the fetch still exits 0). The
  live-view baseline is read from **the same `FETCH_HEAD`**, in the same
  invocation, so the register baseline and the HTML baseline cannot come from
  different commits. Two independent fetches would allow exactly that.
- `resolveBaselineGroups` gates the register baseline through `checkRegister`.
  There is no equivalent trust gate for an HTML baseline, so design 2 defines
  one: the baseline HTML must parse into rows at all, and fail closed —
  `CANNOT_VERIFY` — if it does not.
- Rows are keyed by `<span class="num">` **within each `<details class="item">`
  block**. `parseLiveViewSections` collects `num` spans with a flat
  section-level regex and never associates one with a body, so this needs a new
  per-`<details>` parser.
- The parser must cover the `BLK` and `?` sections, which `parseLiveViewSections`
  skips via its `gtag` filter; without that the check would silently cover 60 of
  the live view's 67 rows. Since blocked rows lose their IDs under design 1,
  those sections are keyed by **heading text** — which is prose and changes on a
  retitle, silently dropping the row from comparison. Named as a known
  fragility, confined to the five blocked rows and two unconfirmed entries.
- The summary strip follows the same rule and the same normalisation.
- Extraction failure is an error, never a skip.

### 3. Wire the citation checker (#2603)

`check-register-citations.mjs` shipped in #2630, and its own header (`:12-36`)
states the gap: `check:register-citations` is invoked from exactly one place —
its own CLI tests under `npm run test:hooks`, scope-gated to `docs/testing/**`,
the register, `CLAUDE.md` and `scripts/**`. Rot in `docs/features/**`, `src/**`,
`server/**` or `e2e/**` is caught only when some in-scope file happens to change
too. The header rules out widening `test:hooks`' inputs: the checker reads
essentially every tracked file, which would make the step un-cacheable.

A dedicated `.github/workflows/register-citations-check.yml`, **no path filter**
— the checker's inputs are the whole tree, so no path filter can be correct.

**It is NOT added to `main`'s required status checks.** An earlier draft said it
should be; that was wrong, for a reason specific to stable IDs. The checker's
verdict is a property of the **whole tree**, not of the PR under test. Under
stable IDs every discharge permanently deletes an ID, so a wave PR that
discharges a row cited from a dozen files and misses an annotation would turn
the check red **for every open PR in the repo**, on files none of them touched.
Today that same miss is silent — which is the rot, but it does not stop the
world. Always-run and visible is the right first step; promoting it to required
is a separate decision to take once the tree has lived under stable IDs for a
few waves, and it belongs in its own issue rather than being smuggled in here.

Adding a workflow also touches `scripts/tests/workflow-wiring.test.mjs` and
`verify-cache.mjs`'s `.github/workflows/**` glob (`:116`); both move in the same
diff.

### 4. The update mechanics

The register's own procedural prose is part of the deliverable. The renumbering
invariant is asserted in more places than a first draft assumed. The
implementation plan carries the full inventory, generated mechanically rather
than sampled; it spans at minimum:

- `check-onbox-register.mjs` — `formatRowList`'s contiguous-range collapse
  (`:171-183`); the `stripFences` residual-limitation comment, phrased *in terms
  of* check 4 (`:44-49`); operator-facing error strings at `:247` and `:811`;
  four further sites at `:577-579`, `:963-967`, `:1362`, `:1385-1389`, including
  the `--discharging` unconsumed-name error that instructs the operator to name
  the group's highest ID.
- `scripts/tests/check-onbox-register.test.mjs` — two direct check-4 tests, six
  verbatim "numbered contiguously" assertions, one assertion that goes vacuous,
  the #2199 discharge-and-renumber scenario, and `computeMaxRowNumber`
  (`:2058-2071`) / `buildAheadBaselineText` (`:2102`).
- `check-register-citations.mjs` — its stated premise (`:1-10`, "…renumbers every
  later row"), plus `:40-52`, `:355-372`, `:392-417`, `:621-630`, `:1742-1747`.
- `docs/testing/onbox-acceptance-register.md` — "Live view" step 2's
  `--discharging` guidance, the two-shape arithmetic at `:152-198` whose "how the
  IDs will be spelled" branch is entirely renumbering, `:212`, `:277-284`, the
  changelog at `:356-477`, `:3015-3021`, `:3047-3049`.
- `CLAUDE.md:745` — Before-shipping step 3 states the wrinkle inline.
- Nine run sheets / sitting packs and five feature docs narrate the invariant.

Under stable IDs the `--discharging` counter-instruction ("the ID that vanishes
is the group's highest, not the row you conceptually removed") is deleted: the
ID that vanishes *is* the row discharged. The flag keeps working.

**Incidental fix, same diff:** `:184-186` cites "Group F's sole row, F1" as "a
real, live example of exactly this shape". Group F was discharged; there is no
Group F in the glance table.

**Surface this design cannot reach:** GitHub issue bodies. `:3047-3049` records
a live instance — the Group C cloud row "was C3 before 2026-08-06 and is
referenced under that ID in #1685". Issue bodies are not in `git ls-files`, so
no checker sees them. Stable IDs stop *new* rot there; existing rot stays.

## Delivery: two PRs, and the rule that forces it

`resolveBaselineGroups` (`:501-516`) rejects the baseline outright if
`checkRegister(baselineText)` reports **anything** — and the baseline is
`origin/main`'s register, read through the *new* checker. So:

> **Any tightening of `checkRegister` is retro-applied to `origin/main`'s copy.
> A guard cannot land in the same PR as the data it requires**, or
> `--against-published` fails with `CANNOT_VERIFY_BASELINE_ERROR`, and the
> runbook (`:210-220`) says that can only be fixed from `main`.

This is a general rule about this codebase, not a quirk of this change, and it
belongs in the checker's header comment.

**PR 1 — data only.** Adds the `next-id` markers, drops the Blocked-section row
IDs, fixes the Group F sentence, and moves the one blocked-row citation to cite
by title. All green under *today's* checker: markers are inert, contiguity is
untouched, the Blocked section is unscanned. Publishes normally.

The marker's comment text carries its own caveat — *allocate from this value
only once the contiguity check is gone* — because between PR 1 and PR 2 the
marker names an ID today's check 4 would reject. That is a knob landing ahead of
its wiring; the caveat is what keeps it from being a trap if PR 2 slips.

**The one-line hazard in PR 1.** Two textually identical citations exist:
`docs/features/269-ffmpeg-version-floor.md:215` means the **blocked** ffmpeg row
and must change; `docs/features/270-openapi-setup-surface.md:166` means the
**live** `E6` (venv-bootstrap, plan 270) and must not. Only the surrounding plan
number disambiguates them, and **nothing mechanical verifies either way** — `E6`
exists regardless, so Check A stays silent and a features-doc prose citation is
outside Check C's fatal surface. Both lines are named here so the plan can call
for a human read rather than a grep-and-replace.

**PR 2 — the guards.** Deletes check 4, adds 4a/4b, adds design 2's rule and its
parser, adds the workflow, sweeps the design-4 inventory. Its baseline is PR 1's
`main`, which under the new checker passes: no duplicate IDs, markers present,
every ID below `A101`, no contiguity requirement left to fail.

## Sequencing against wave 9

Wave 9 merges first; this design assumes it. That lane's diff is written and
this one has a plan, a review gate and two publishes ahead of it. Wave 9 sweeps
its own rot under the current rules, as any wave PR does today — and is the last
wave that ever pays that cost.

**No row number in this branch may be hardcoded from today's register.** Group
sizes and any ID named in a test fixture are computed at rebase time. The `101`
floor is fixed and safe regardless of what wave 9 does, since it renumbers
downward. Tests fixture their own registers rather than asserting against the
real file's numbering.

## Ticket disposition

| Issue | Outcome |
|---|---|
| **#2599** | Closed by design 2. The close comment names both uncovered shapes: a row under edit by this branch, and a whole-row drop on the published page. |
| **#2603** | Closed by design 3 — **without** its title-match option and **without** self-reference detection. The latter is structurally impossible in the shipped checker: the register's own path is in `FROZEN_EXACT` (`:386`), so its body is never scanned. Its non-renumbering damage (the "five states vs eight states" drift) is untouched by this work. All three omissions go in the close comment. |
| **#2629** | Closed by design 1 + design 3. Not its "option 2" — that is a per-row slug field, which this declines. Stable positional IDs are a fourth option; the close comment says so rather than claiming an option the issue did not offer. |
| **#2634** | Closed as a **duplicate of #2653**, honouring its "add a uniqueness check" instruction via 4a. |
| **#2653** | Closed by design 1 via its **option 3** (drop blocked IDs), plus the paired uniqueness check. |
| *new* | An issue for "promote `register-citations-check` to a required status check", to be decided after a few waves under stable IDs. |

## Testing

`scripts/tests/check-onbox-register.test.mjs`:

- a group with gaps passes — regression test for the deleted check 4, red before;
- a row ID duplicated across sections fails — the #2634/#2653 repro, red before;
- a row ID at or above its group's `next-id` fails;
- a group with **no** `next-id` marker fails, so a missing marker cannot silently
  disable 4b;
- **`working != baseline` with any `published` stays green** — the
  ordinary-publish and the re-publish regression tests, and the assertions that
  would have caught both rejected rules;
- `working == baseline` with `published != baseline` is reported — the #2599
  repro, red before;
- a formatting-only difference stays green;
- a strip difference follows the same rule;
- an unparseable baseline HTML fails closed rather than passing vacuously.

**Five existing real-tree CLI tests must move.** `computeMaxRowNumber` and
`buildAheadBaselineText`, consumed at `:2209`, `:2333`, `:2360`, `:2517`,
`:2600`, each derive `high-water + 1` as "an ID that does not exist yet" and
append it to a baseline that must pass `checkRegister`. Under 4b that ID must
sit **below** `next-id`. With existing rows at `A1`…`A37` and the floor at
`A101`, `high-water + 1` = `A38` already satisfies that — but the helper must
say so deliberately rather than by luck, because the tempting repair when it
does break is to loosen the fixture, which is how the floor gets quietly
weakened.

`scripts/tests/check-register-citations.test.mjs`: a citation to a gapped
(discharged) ID still follows Check A's annotated/unannotated split.

Real-tree: `npm run check:onbox-register` and `npm run check:register-citations`
both green — the latter meaning zero fatal findings, with the 16 pre-existing
annotated notes expected and unchanged.

## Shipping notes

- **No new on-box acceptance row.** No behaviour here needs real hardware. Both
  PRs move register surfaces and publish per the standing procedure; PR 2's
  publish is the first real exercise of design 2 (real, not vacuous — the row
  IDs on both sides match).
- **No release-notes entry.** CI/tooling and process only, no user- or
  operator-visible delta. Stated rather than silently skipped.
