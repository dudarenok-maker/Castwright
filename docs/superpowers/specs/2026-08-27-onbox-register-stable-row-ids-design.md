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

## Problem

Four of those five tickets describe one mechanism from four angles, and the
mechanism is not an accident — it is enforced by a check.

`scripts/check-onbox-register.mjs` check 4 (`:313-327`) fails the build unless
each group's row numbers are "contiguous from 1". Discharging a row therefore
cannot leave a gap: every later row in the group must shift down. The register
has ~60 owed rows across seven groups and discharges several per wave, so each
wave rewrites a large fraction of the ID space.

Row IDs are the register's public interface. `npm run check:register-citations`
counts 171 citations across 51 files — code comments, run sheets, plan docs,
`server/.env.example`, GitHub issue bodies. Every one of them is a positional
reference into a sequence that the checker requires to be rewritten on every
discharge.

The observed damage:

- **[#2629]** PR #2626's wave-5 campaign discharged three Group A rows and
  rotted **38 citations across 11 files**. Two comments about the
  catastrophic-WER override cited `A37`, which by then named an unrelated
  ORT-marker row — a reader following that citation lands on shipped behaviour
  with nothing in common with the comment they came from.
- **[#2603]** PR #2578's review loop hit two `origin/main` renumberings inside
  one PR. Round 21 alone found 26 stale row-number occurrences in a single run
  sheet, a register-authored "recompute" note written entirely in
  pre-renumbering IDs, and a row whose own body cited itself ("same procedure
  as A39" inside row A39).
- **[#2634] / [#2653]** — the same finding filed twice, three weeks apart.
  `E6` and `E8` each name two different rows, because the Blocked section
  borrows IDs from the Group E sequence that renumbers underneath it. A bare
  `E6` citation is ambiguous, and `check-onbox-register.mjs` cannot see it: its
  duplicate detection covers group *letters*, never row IDs, and the Blocked
  section's `###` headings are not scanned at all.

**This is live right now.** At the time of writing, the `wt-onbox-wave9` lane
holds uncommitted register edits discharging A8 and A9 and renumbering every
Group A row from A9 through A37 — ~29 rows, `60 owed` → `58 owed`. That is the
wave-5 incident repeating, three months on, in a lane that is doing nothing
wrong: it is following the rule the checker enforces. See "Sequencing" — that
wave is expected to merge first and to sweep its own rot, and to be the last one
that has to.

The fifth ticket is a distinct blind spot in the same file:

- **[#2599]** `--against-published`, the comparator the register's own "Live
  view" procedure mandates immediately before every publish, compares only the
  owed total, per-group counts and row IDs. It never diffs row *content*. During
  PR #2578 round 18 the published artifact had been reverted by another session
  to a stale version of row A41's body; the comparator returned `OK`, because
  the count and the ID both still matched. The manual byte-diffs in rounds 13-18
  were doing the real verification work. The mandated tool contributed nothing
  to catching the exact defect class the procedure exists for.

## What this does not attempt

Not in scope, stated so the omissions are choices rather than oversights:

- **Generating the live view from the markdown.** The two are deliberately
  separate authored artifacts — the HTML condenses and rewrites each row's
  prose rather than mirroring it (compare register `A34` against live `A34`).
  Generation is a different, larger design; nothing here assumes or approaches
  it.
- **#2603's title-match check** — "does the cited row's *title* match the citing
  context's description of it". #2603 names this as its strongest and hardest
  option. It is not built. See "Ticket disposition" for why closing #2603
  without it is the honest call.
- **A retired-ID ledger.** See "Residual limitation" below.

## Design

### 1. Stable row IDs (the mechanism fix)

**A row ID is allocated once and never reused. Discharging a row deletes it and
leaves a gap.**

Check 4 (contiguity) is deleted outright. Two checks replace it:

- **4a — uniqueness.** Every `### <Letter><N>` heading in the whole file
  appears exactly once. Unlike check 4, this scans the Blocked and Unconfirmed
  sections too, which is what makes it see the `E6`/`E8` collision. It stays out
  of the *arithmetic* — those sections remain excluded from the owed total and
  the glance table, exactly as today (the glance table marks their rows `—`).
  This is a scan-scope widening, not a tallying change.
- **4b — allocation floor.** Each group carries an HTML comment marker
  `<!-- next-id: A38 -->` immediately after its `## Group A — …` heading. Every
  row ID in that group must be strictly below the marker's number. Adding a row
  means taking `next-id` and bumping it.

The marker is an HTML comment so it is invisible in rendered markdown and needs
no glance-table column (`parseGlanceTable` requires exactly three cells; adding
a fourth would ripple through both parsers and the live view for no reader
benefit). It is authoring metadata, so the live view does not mirror it and
`checkLiveView` ignores it — `stripHtmlComments` already runs on the HTML side.

**Blocked-section IDs** continue the Group E sequence — blocked `E8` and `E6`
take the next two values above Group E's live high-water, which is `E10` today
and is recomputed at rebase time per "Sequencing" (giving `E11`/`E12` unless a
lane adds a Group E row first). #2634 rejected this
option because blocked rows would renumber whenever a live E row discharged —
stable IDs remove that objection permanently. One ID grammar (`[A-H]\d+`), both
checkers unchanged in shape, uniqueness enforcing it from here on. The three
blocked entries that carry no ID today (AMD GPU support Phase 2, ORT marker AMD
box, CPU-only `RAM_HEAVY_MODELS` clamp) stay unnumbered: nothing cites them, and
inventing IDs for them would put non-Group-E work in Group E's namespace.

### 2. `--against-published` sees row content (#2599)

The comparison axis is **tracked `.html` ↔ saved published `.html`** — not
markdown against HTML. This follows from the "what this does not attempt" note
above: the markdown and the live view are supposed to carry different prose, so
a text comparison between them would fire on every row, permanently. The two
HTML files are the *same* authored artifact, so a per-row text comparison
between them is exact.

Mechanics:

- Key rows by `<span class="num">` inside each `<details class="item">` block —
  the same anchor `parseLiveViewSections` already uses.
- Normalise each row body before comparing: decode entities, collapse
  whitespace runs, strip tags. Formatting-only differences are not findings.
- Compare only rows **present on both sides**. A row on one side only is
  already the business of the existing `#2199`/`#2272` baseline and
  `--discharging` logic, which is untouched.
- Report a difference in **either** direction. Both files are the same artifact,
  so disagreement means one of them is stale; which one is the operator's call,
  and the report names the row and shows both texts. This is the PR #2578
  revert exactly.
- The summary strip rides the same normalisation path for free, closing the
  register's own documented edge that "oldest debt, and the group/blocked/
  unconfirmed tallies" are an unchecked manual recompute.

Extraction failure is an error, never a skip — the same rule the rest of
`checkLiveView` already follows, and for the same reason: a regex that stops
matching after a markup change would turn the check into a vacuous pass, which
is the shape of bug it exists to catch.

### 3. Wire the citation checker (#2603)

`check-register-citations.mjs` shipped in #2630 and its own header (`:12-36`)
states the gap: `package.json`'s `check:register-citations` is invoked from
exactly one place, its own CLI tests under `npm run test:hooks`. That step is
scope-gated to `docs/testing/**`, the register, `CLAUDE.md` and `scripts/**`,
so rot in `docs/features/**`, `src/**`, `server/**` or `e2e/**` is caught only
when some in-scope file happens to change too. The header also rules out the
tempting fix — widening `test:hooks`' declared inputs would make the step
un-cacheable for everyone, because the checker's real-tree run reads
essentially every tracked file.

A dedicated `.github/workflows/register-citations-check.yml`, with **no path
filter**, mirroring the existing `onbox-register-check.yml`. Always-run is the
point: the checker's inputs are the whole tree, so no path filter can be
correct.

### 4. The update mechanics

`docs/testing/onbox-acceptance-register.md`'s own procedural prose is part of
the deliverable, not documentation of it. Three edits:

- **Row lifecycle** — a new statement of the rule: adding a row takes `next-id`
  and bumps it; discharging deletes the row and leaves the gap; IDs are never
  renumbered and never reused. This replaces the current "rows renumber
  contiguously" convention wherever it is asserted, including inside
  `check-onbox-register.mjs`'s own error strings and header comments.
- **"Live view" step 3** — describe the new content check and what it reports,
  alongside the existing one-directional row/count semantics.
- **The `--discharging` renumbering wrinkle** (`check-onbox-register.mjs`
  `:628-632`, and the register's "Live view" step 3) — "discharging a middle row
  renumbers the survivors, so the ID that vanishes is the group's highest, not
  the row you conceptually removed" is pure renumbering tax. Under stable IDs
  the ID that vanishes *is* the row that was discharged. The flag keeps working;
  its counter-intuitive instruction is deleted.

## Residual limitation

Check 4b prevents a *new* row colliding forward. It does not detect someone
re-typing a long-discharged low ID — `A12` when `next-id` is `A38` — because
nothing records that `A12` ever existed. Detecting that needs a retired-ID
ledger, which contradicts the shipped ruling that the register tracks **state,
not history** (the same ruling that collapsed the correction log to one line).

This is a deliberate narrowing, documented in the checker header the way that
file already documents its other envelope edges (the balanced-stray-fence hole,
the `extraOnly` never-merged-row hole). The failure requires an author to ignore
the documented "take `next-id`" step and type an old number by hand; the
uniqueness check still catches it whenever the original row is still present.
What it cannot catch is reuse of a genuinely discharged ID, and old citations
would then resolve to a real-but-wrong row.

## Ticket disposition

| Issue | Outcome |
|---|---|
| **#2599** | Closed by design 2. |
| **#2603** | Closed by design 3, **without** its title-match option. Its entire "why this matters" is renumbering damage, which design 1 removes at source; the wiring gap is the only part that survives the mechanism's deletion. Stated in the close comment rather than left as a phantom follow-up. |
| **#2629** | Closed by design 1 — its option 2/3 hybrid: the rot mechanism is deleted *and* option 3's checker is wired. Its option 1 (cite the issue number only) is not adopted; positional IDs become durable, so they no longer need replacing. |
| **#2634** | Closed as a **duplicate of #2653**. Same E6/E8 finding, filed twice. Its "add a uniqueness check, that part needs no decision" instruction is honoured by design 1's check 4a. |
| **#2653** | Closed by design 1 — its option 2 (renumber Blocked into a non-colliding sequence), made permanently safe by stable IDs, plus the paired uniqueness check it asks for. |

## Sequencing

**Wave 9 will almost certainly merge first, and this design assumes it does.**
That lane's diff is already written (discharging A8/A9, renumbering ~29 Group A
rows, `60 owed` → `58 owed`); this change still has an implementation plan, a
review gate and a publish ahead of it. Racing it would mean asking a
ready-to-merge lane to hold, and re-deriving its register edits, to save one
wave's sweep. Not worth it.

The consequence, and the constraint it puts on implementation:

- **Wave 9 rots ~29 rows' worth of citations, and its own PR sweeps them** under
  the current positional rules, with `npm run check:register-citations` — which
  is what a wave PR does today regardless. Nothing here changes that lane's
  obligations.
- **Wave 9 is the last wave that ever pays that cost.** The freeze takes effect
  from whatever numbering exists when this merges.
- **Therefore no row number in this branch may be hardcoded from today's
  register.** Every `next-id` marker value, and the blocked-row re-key target,
  is computed **at rebase time** from the register as it then stands — group
  high-water plus one. Today Group E's live high-water is `E10`, making the
  blocked rows `E11`/`E12`; wave 9's diff does not touch Group E, so that is
  likely to hold, but it is a value to recompute, never a constant to carry.
  The implementation plan states this as an explicit pre-merge step, and the
  tests fixture their own registers rather than asserting against the real
  file's numbering.

Rebasing onto a renumbered `main` is itself the last exercise of the mechanism
being deleted: if the rebase is painful, that is the argument for the change,
recorded rather than avoided.

## Testing

Paired automated tests, per the standing requirement.

`scripts/tests/check-onbox-register.test.mjs`:

- a group with gaps (`A4, A6, A7`) passes — the regression test for the deleted
  check 4, red before the change;
- a row ID duplicated **across sections** (live `E6` + blocked `E6`) fails —
  the #2634/#2653 repro, red before the change;
- a row ID at or above its group's `next-id` fails;
- a group with no `next-id` marker fails (a missing marker must not silently
  disable 4b);
- `--against-published` reports a row whose body text differs between the
  tracked and saved HTML while its ID and count match — the #2599 repro, red
  before the change;
- `--against-published` stays green on a formatting-only difference
  (whitespace, entity encoding);
- a summary-strip difference is reported.

`scripts/tests/check-register-citations.test.mjs`: a citation to a gapped
(discharged) ID still behaves per Check A's existing annotated/unannotated
split — gaps are now the normal state, so this pins that the shipped behaviour
survives.

Real-tree verification: `npm run check:onbox-register` and
`npm run check:register-citations` both green on the edited register.

## Shipping notes

- **No new on-box acceptance row.** This ships no behaviour only real hardware
  can prove. It does move all three register surfaces (the `.md`, the run sheets
  citing blocked `E6`/`E8`, and the live-view `.html`), so it must publish with
  `--against-published` per the standing procedure — which exercises design 2 on
  its own first run.
- **No release-notes entry.** CI/tooling and process only, with no user- or
  operator-visible delta. Stated explicitly rather than silently skipped, per
  the Before-shipping checklist.
- Every citation site pointing at blocked `E6`/`E8` moves in the same diff.
