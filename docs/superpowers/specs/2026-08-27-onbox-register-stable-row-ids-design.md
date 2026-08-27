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
**roughly 210-225 times across ~65 files** — the exact count depends on how the
idiom is matched, and two independent sweeps gave 212 and 226; the figure is
motivational, not load-bearing, and is deliberately given as a range rather than
a false precision in a document arguing that unre-derived numbers rot. It spans
code comments, run sheets, plan docs,
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
  high-waters of **`A`=48, `B`=5, `C`=4, `D`=3, `E`=11, `F`=1, `G`=2, `H`=2**
  (independently recomputed during the assumption-checker pass; figures agree).
  **The highest ID appearing anywhere in the tree is `A99`** — not `A46`, as an
  earlier draft claimed. `A99` is the *citation checker's own* sentinel for a
  definitely-nonexistent ID (`check-register-citations.mjs:733`, `:759`, `:785`,
  and sixteen occurrences in its tests). It is not a register row and never was,
  but it occupies the `row <ID>` idiom, so a floor derived from real rows alone
  would collide with the sibling checker's corpus. The floor clears it — by two,
  not by the ~50 the earlier figure implied. Stated precisely because the next
  person to re-derive this floor will re-derive it from this sentence.
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

### 2. `--against-published` detects a competing publish (#2599)

**Three per-row content rules were designed and all three failed.** They are
recorded here because each looked correct, and the reason they failed is
structural rather than a detail any fourth attempt would dodge.

**Symmetric comparison**
(report any difference between the working file and the published page) is what
the register already records failing, at `:277-284`: *"An early version of this
check compared both directions symmetrically, which inverted the diagnosis
(failed on every ordinary publish…)."* A **three-way rule** (silent when
`published` equals either `baseline` or `working`, report otherwise) fails on
the second publish from one branch — `baseline = X`, first publish sets
`published = Y`, review feedback edits `working = Z`, and `Y` equals neither.
Multi-publish-per-branch is this register's normal review cycle; PR #2578
published across rounds 13-21.

**Why a fourth rule was not attempted.** Each rule is a guess at *why* two texts
differ, and the information needed to answer that is not in the texts. The third
rule's failure makes it plain: `working != baseline` was read as "this branch
edited the row", but it actually means *edited **or** stale*, and those need
opposite treatment. Content comparison cannot separate them without per-branch
publish state, which no amount of rule-shaping supplies.

**So stop comparing content.** The thing worth detecting is not "these bodies
differ" — it is **"someone *else* published between my baseline and now"**, which
is the *cause* of every foreign divergence, including the ones no per-row rule
reached (a dropped row, a moved summary strip, and the stale callout blocks
described below).

**Rejected: a bare monotonic counter.** Recorded as the fourth failure, because
it was written, tested against itself, and killed by the assumption-checker pass
before any code existed — and because it fails for the *same* reason the third
content rule did, which is what makes it worth a paragraph rather than a
footnote.

The design was a single integer, bumped by any change that publishes, compared
across `working` (this branch's file), `published` (the saved live page) and
`baseline` (`origin/main`'s file), with `published != baseline` as the STOP.
That rule **fails on the second publish from one branch** — `baseline = 47`, this
branch publishes `48`, review feedback lands, and now `published(48) != baseline(47)`
reports a competing lane that does not exist. This register's normal review cycle
is multi-publish-per-branch; PR #2578 published across rounds 13-21. It is
verbatim the failure recorded three paragraphs above, reintroduced by a design
that claimed to have escaped the class.

The obvious repair does not work either. Admitting a same-branch re-publish means
accepting the interval `baseline ≤ published ≤ working` — and that interval is
exactly where a competing lane's publish lands. **A counter cannot distinguish my
earlier publish from yours**, because the two are the same number.

**The design: a publish token that carries who, not just how many.**

The spec was right that content comparison lacks per-branch publish state. What
the counter missed is that *we control the token*, so the state can be **put
there** rather than inferred:

```html
data-published-as="48" data-published-by="chore/ops-register-stable-row-ids"
```

Before publishing, `--against-published` compares both fields across the three
copies:

| State | Verdict |
|---|---|
| `published.n == baseline.n`, `working.n > baseline.n` | **OK** — nobody published since your baseline |
| `published.who == this branch`, `published.n >= baseline.n`, `working.n > published.n` | **OK** — your own earlier publish this review cycle |
| `published.who != this branch`, `published.n != baseline.n` | **STOP** — another lane published; rebase and re-read the live page |
| `published.n < baseline.n` | **STOP** — the live page is *behind* `main`: a bump merged without publishing, or a publish was reverted |
| `published` token absent, `baseline` present | **STOP** — the wrong file was published, or the page was clobbered |
| `working.n <= baseline.n` | **STOP** — bump the token; an unbumped publish is untracked |
| **either baseline unresolvable** | **STOP** — its own fail-closed error, matched by identity, never folded into any case above |

**The carrier is an attribute, not an HTML comment.** `checkLiveView`'s first
action is `stripHtmlComments(rawLiveViewHtml)` (`:641`), and that blanking is
load-bearing — its own header records that without it "a commented-out row was
counted as a real one." A comment token is invisible to the very function that
must read it. An attribute is immune by construction. Whether either carrier
survives the publish → fetch round trip is settled empirically before any code
depends on it (implementation plan, Task 1).

What this buys over every rejected rule:

- **No normaliser.** An integer and a branch name, compared as strings. The
  rejected content designs all needed a normaliser over prose dense with
  `&ldquo;`, `&nbsp;`, inline `<code>` and `<a href>` — and none of the three
  ever defined one, which is its own warning.
- **No per-row parser, no keys.** The `<details class="item">` / `<span
  class="num">` scheme is not needed, and neither is the heading-text fallback
  for the `BLK` and `?` sections that had no IDs to key on.
- **No intent guessing.** Editing, re-publishing, rebasing and reverting are all
  answered by the token's own two fields rather than inferred from prose.
- **It covers what per-row rules could not**: a dropped row, a wrong summary
  strip, the stale callouts, and publishing the `.md` by mistake — the failure
  the register records happening four times — all present as a changed, absent
  or foreign-owned token.

**The token line is also a merge canary.** Two lanes that both bump `47 → 48`
conflict in git on that one line, surfacing the race before either can publish.

**No bootstrap case.** An earlier draft carried one, for the first change to
publish to a tokenless page. It is unreachable by construction: PR 1 seeds the
token as *data*, and PR 2 ships the code that reads it, so by the time
`comparePublishTokens` runs at all, `origin/main` already carries a token. A
branch that can never be entered is a branch that can only ever be wrong — it is
not written, and a test pins that a tokenless page against a tokened baseline is
**reported**, not bootstrapped.

**A baseline that cannot be resolved is never a pass.** `resolveBaselineText`
returns `{ text: null }` on a git failure, and `null` is not "a baseline with no
token" — it is "no baseline". Everywhere else in this file that distinction is
already load-bearing: it has its own exported constant, matched by identity
(`CANNOT_VERIFY_BASELINE_ERROR`, `:529`), and its own CLI remedy branch. The
token check uses the same vocabulary. Collapsing the two is the
guard-evaporates-on-missing-input shape `resolveBaselineGroups`' own header
exists to fail closed against.

**Stated boundaries — two, not one.**

1. The token proves nobody *else* published since your baseline. It does **not**
   prove the bytes you are about to publish are the bytes you intended — a stale
   local build of your own file, correctly bumped, still publishes. That is what
   git review covers.
2. The `who` field is trusted, not proven. A lane that publishes under another
   branch's name defeats the check. Nothing here authenticates a publisher, and
   nothing should: this is a two-person-at-most repo and the failure being
   detected is *accident*, not *forgery*.

Both go in #2599's close comment rather than being implied.

**A stalemate needs an escape hatch.** `published.n < baseline.n` is legitimately
reachable — a PR can bump and merge without publishing — and the operator cannot
clear it by rebasing or re-reading. It gets a named flag on the same footing as
`--discharging` (which exists because #2272 found the identical shape), and a
section in the register's own "If it fails" tree. A guard with an unclearable
STOP is a guard that gets bypassed.

**Mechanics.**

- `--against-published` **never reads the tracked live-view HTML today**:
  `const liveViewHtml = read(LIVE_VIEW)` sits at `:1423`, *after* that mode's
  `return` at `:1420`. Reading it in `extraOnly` is new.
- **One fetch, one extra read.** `resolveBaselineText` already freezes the SHA
  in a local (`:1060-1075`) after deliberately reading `FETCH_HEAD` rather than
  `origin/main` (#2199 round 3 — a narrowed refspec can leave `origin/main`
  stale while the fetch still exits 0). The live-view baseline is a second
  `git show <that same sha>:<live view>`, so both baselines are from one commit.
  The SHA must be returned rather than kept local, and **seven existing tests
  pin `resolveBaselineText`'s call sequence** (`:1785`-`:1934`), at least two by
  recording the call list; they move in the same diff.
- `ONBOX_TEST_BASELINE_FILE` substitutes **only** the register baseline, and its
  own comment (`:1252-1267`) warns that a CLI test deriving its verdict from
  live git state is a latent bug. The second baseline needs its own equivalent
  seam, or every hermetic `--against-published` test silently reaches real git
  for the HTML half.
- A token that is present but not a bare integer is an error, not a skip.

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

**The workflow needs its own test, and neither file an earlier draft named
supplies one.** `verify-cache.mjs:116` is the literal glob `'.github/workflows/**'`
— a wildcard, so a new workflow file needs no edit there — and
`workflow-wiring.test.mjs` resolves exactly one path, `verify.yml` (`:22`), with
no workflow enumeration anywhere in it. Both were listed as "moving in the same
diff" on the assumption that they enumerate workflows. They do not, which would
have shipped a new CI workflow with **zero** automated coverage, against this
repo's own standing requirement that every PR improve it.

The coverage is a contract test over the workflow file itself: it exists, it
invokes `check-register-citations`, and it carries **no `paths:` filter**. That
last assertion is the one worth having — a path filter is the obvious-looking
"optimisation" a future reader will add, and it is precisely what makes this
checker useless, because its inputs are the whole tree.

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
IDs **in both the register and the live view**, introduces the `published-as`
token, fixes the Group F sentence, moves the one blocked-row citation to cite by
title, and repairs the stale callouts described below. All green under *today's*
checker: markers are inert, contiguity is untouched, the Blocked section is
unscanned on both sides. It publishes under design 2's bootstrap case.

**Both sides, or #2634/#2653 are only half closed.** Dropping the blocked IDs
from the markdown alone leaves `<span class="num">E8</span>` and `E6` in the live
view's `BLK` section, where *nothing mechanical looks* — `parseGlanceTable`
needs `^[A-Z]$` and `parseLiveViewSections` filters on `gtag`, so both sides skip
that section entirely. The two files would disagree, silently, in violation of
the live view's own footer rule ("update both, in the PR that changes either"),
and the collision the tickets are about would survive in the published artifact.
Verified: the `BLK` section carries exactly 5 `details.item` blocks, two bearing
those IDs.

**Incidental fix, same PR — real rot, found in passing.** The live view carries
four `<div class="callout warn">` blocks narrating counts `66 → 69` and
describing `A41`/`A44`/`A45`/`A46`. None of those exists; the register tops out
at `A37` with 60 owed. Wave 8 updated the strip, the rows and the footer and left
the callout stack behind, and `check:onbox-register` is green over it because
callouts are not parsed. This is the most drift-prone prose on the page and it
sat outside every rejected per-row design's scope — design 2's token covers the
*cause* of this class going forward, and the existing damage is repaired here per
CLAUDE.md's fix-don't-file rule.

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
| **#2599** | Closed by design 2 — but **not** by the row-content diff the issue asked for. The issue's own option 2 named a decision as owed; the answer is that per-row content comparison cannot be made correct here. The close comment records **all four** rejected rules — the three content rules and the bare counter — and why each failed, plus **both** stated boundaries (it proves nobody *else* published, not that you published what you meant to; and `who` is trusted, not authenticated). |
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
- **`published.n == baseline.n`, `working.n > baseline.n` is green** — the
  ordinary first publish;
- **a same-branch re-publish is green** (`baseline 47`, `published 48` owned by
  this branch, `working 49`) — **the assertion that kills a bare counter**, and
  the one the rejected design's own test contradicted its own implementation
  over. These are two separate tests: in a re-publish `published != baseline`, so
  one assertion cannot cover both cases;
- a `published` token owned by **another** branch, with `published.n != baseline.n`,
  is reported — the #2599 repro, red before;
- `published.n < baseline.n` is reported **with its own message and its escape
  hatch named** — the live-page-behind-`main` stalemate;
- a `published` page with no token, against a `baseline` that has one, is
  reported — the wrong-file-published case the register records happening four
  times. **This is also the test that pins the absence of a bootstrap branch**;
- `working.n <= baseline.n` is reported — an unbumped publish;
- **an unresolvable baseline is reported, not bootstrapped and not passed** —
  `null` and "tokenless" must not collapse, asserted by identity against the
  fail-closed constant;
- a non-integer counter, an empty `who`, and **two tokens in one file** are each
  an error rather than a skip or a first-match win;
- the second baseline read uses the **same** SHA as the first.

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

- **No new on-box acceptance row.** No behaviour here needs real hardware. PR 1
  moves register surfaces and seeds the token as data — the check that reads it
  does not exist yet, so PR 1 publishes under the *old* comparator. **PR 2's
  publish is the first real exercise of the token check**, and it runs against a
  `main` that already carries a token, which is precisely why there is no
  bootstrap branch to exercise. PR 2 publishes only if it touches the live view;
  if it does, it bumps the token like any other change.
- **No release-notes entry.** CI/tooling and process only, no user- or
  operator-visible delta. Stated rather than silently skipped.
