---
status: draft
---

# On-box register: generated derived surfaces, reconciled row shells, and the end of the drift-detector family

**Issues:** closes [#2362](https://github.com/dudarenok-maker/Castwright/issues/2362),
[#2708](https://github.com/dudarenok-maker/Castwright/issues/2708),
[#2721](https://github.com/dudarenok-maker/Castwright/issues/2721); completes
[#2599](https://github.com/dudarenok-maker/Castwright/issues/2599) and
[#2603](https://github.com/dudarenok-maker/Castwright/issues/2603) via the held
tasks of the preceding plan.

**Predecessor:** [`2026-08-27-onbox-register-stable-row-ids-design.md`](2026-08-27-onbox-register-stable-row-ids-design.md).
That spec fixed row-ID *renumbering*. This one fixes the surface duplication that
renumbering was only one symptom of.

---

## Problem

### The family reproduces because the register has two hand-maintained copies of the same facts

Seven issues have now been filed about `docs/testing/onbox-acceptance-register.md`
and its published twin. Five are closed; each closure orphaned something:

- **#2629** (citation rot) shipped, and its closure orphaned **#2721**.
- **#2634** and **#2653** were the same duplicate-row-ID finding, filed three weeks
  apart by two different reviews.
- **#2599** was closed by declining the row-content diff it asked for — which
  leaves **#2362**, open since before it, as the surviving home for that question.
- **#2603** was closed without its title-match option and without self-reference
  detection.
- **#2708** is a fresh policy question about a changelog that exists twice.

The predecessor spec named the mechanism behind four of them: a checker that
*required* row IDs to be contiguous, so every discharge forced a renumber of
roughly 210–225 citations across ~65 files. That is fixed — IDs now allocate once,
above a floor of 101, and are never reused.

**But the family did not stop.** #2362, #2708 and #2721 all postdate or survive
that fix, because renumbering was a symptom of a deeper property: **the register's
facts exist twice, in two files, both maintained by hand.**

Every ticket in this family is a *detector* for drift between those two copies.
Detectors compose, and each new detector raises a fresh boundary question — what
counts as a citation, what is fatal, what is benign, what does "agreement" mean.
Each boundary question is itself a decision, and each decision becomes a ticket.
That is the replication engine, and no additional detector switches it off.

### The two incidents that define the class

**#2362 — the surfaces stated contradictory facts and CI was green.** PR #2359
corrected the same wrong sentence three times across two review passes. Pass 3
found `onbox-acceptance-register.md:3179` still saying the Coalfall family is
"five language editions" while its published twin at
`onbox-acceptance-register-live-view.html:1361` had already been corrected to
"seven". For one commit the tracked pair asserted **different facts in the same
clause**, and `npm run check:onbox-register` passed throughout.

**#2599 — a published page silently regressed and the mandated comparator said OK.**
During PR #2578 round 18 another session reverted the published artifact to a stale
version of a row's body. `check:onbox-register -- --against-published <page>`
returned `OK` because the row count and the row ID both still matched — only the
body text had regressed.

The register's own "Live view" section documents this honestly rather than
pretending otherwise:

> **A wording-only edit does not fail.** Rewording a row, recording a run result,
> changing a hardware note or a criteria link — the most common edit this register
> gets — changes nothing the check compares.

### What is duplicated today, measured

| Fact | Lives in `.md` | Lives in `.html` | Agree today? |
|---|---|---|---|
| Owed total | `:431` (`60 owed.`) | `:198` (`n owed` tile) | yes |
| Per-group counts | glance table `:417-430` | glance table + `gcount` spans | yes |
| Group set | 7 `## Group` headings | 7 `section.group` elements | yes |
| Blocked / Unconfirmed counts | glance table `:428-430` | strip tiles `:200`, `:202` | yes |
| Oldest debt | `:431-433` prose | `:203` (`06-01` tile) | yes |
| Row ID set | 65 `###` row headings | 67 `details.item` elements | yes |
| **Changelog** | `:435-678`, **14 entries** | 7 callouts | **NO** |

The changelog row is the live failure. The page admits it in its own text, at
`:265-269`:

> Waves 8/9/9b … are recorded only in the .md's changelog — this callout box was
> not kept current across those waves; the stat strip and row list above are
> current, but the entries below this one predate wave 7 and are historical only.

Six of these seven facts agree **because people keep checking them by hand**, and
one has already lost. Nothing about that arrangement is stable.

---

## The constraint that shapes everything: the live view is an editorial summary

It is tempting — and this spec's own first draft proposed it — to generate the live
view's row bodies from the markdown and be done. **That is not buildable**, and the
measurement is decisive:

| | register `.md` | live view `.html` |
|---|---|---|
| Total lines | **4,539** | **1,554** |
| Row A1's body | ~570 lines | a handful of summary blocks |

The HTML does not excerpt the markdown — it **rewrites** it. Compare E1's source
(`.md:3574-3633`, including a ~30-line escalation blockquote) with its rendering
(`.html:1287-1296`): sentences are shortened, reordered and reworded. The `.md`
says a tester who files "the pin doesn't work" *has found the documented behaviour,
not a defect*; the page says *Reporting the bundled Node version after the first
Update is the correct result, not a failure.* Same meaning, different prose,
deliberately.

Worse, **the HTML carries fields that exist nowhere in the markdown**:

- the per-row `risk` / `risk low` / `risk hot` one-line synopsis in each summary
  (A1's reads `20 of 60 run · ~40 owed · 3 retracted`) — a three-way severity
  encoding with no `.md` counterpart at all;
- the `iname` span, a shortened title with markdown links stripped (A14's `.md`
  heading carries three inline links; the page's reads `Real-book QA/badge
  agreement after the loudness measurement hoist (plan 274)`);
- the stat tile `Still owed in A1 (of 60) = 40` (`:201`), read from prose inside
  A1's own heading region, not from the glance table.

And **the markdown's rows have no schema.** `*Needs:*`, `*Criteria:*` and `*Cost:*`
recur often enough to look like a convention but are optional, interchangeable with
`*Hardware:*` or `**Hardware prerequisite:**`, and frequently collapsed onto one
line — A14 ends with both `*Needs:*` and `*Criteria:*` in a single sentence.
Longer rows invent their own narrative subheads — `**What genuinely remains:**`,
`**What to observe, concretely:**`, `**Still unverified:**`, `**Net:**` — per row,
as needed, and accrete append-only wave/step run-log blockquotes.

So generating row bodies has exactly two implementations, and both are wrong:

1. **Emit the markdown's prose.** The page triples in length and stops being the
   readable operator page it exists to be — A1 alone becomes 570 lines behind a
   disclosure widget.
2. **Write an abstractive summariser.** Not a build step.

**The prose is not the drift class.** #2362 was a *number* (five vs seven). #2599
was a row body regressing while its *ID and count* held. #2708 is a changelog of
*counts*. Every incident in this family is a **derived fact**, and derived facts
are exactly what a build step can own.

---

## Designs this spec rejects

Recorded because each looked right, and a future reader will otherwise re-propose
it.

**Rejected: generate the row bodies (#2362 option 3 as literally written).**
Falsified above by the 4,539-vs-1,554 line measurement and the three HTML-only
fields. #2362's option 3 says to generate the row bodies "both files share" from
one source — the premise that they *share* body text is false. They share facts,
not prose.

**Rejected: whole-page generation.** The `.html` becomes pure build output. This
does close the class completely, but it discards the style block (`:35-158`, 124
lines of light/dark theming), the `risk` synopses, the shortened titles, the glance
table's jump links and the disclosure-widget interaction — none of which exist in
the markdown. Re-adding them would mean inventing a row schema for a document whose
rows are demonstrably ad-hoc, which is a larger and riskier change than the drift
it prevents.

**Rejected: stop tracking the `.html` and generate it at publish time.** Nothing
can drift if nothing is stored. But the page leaves code review entirely, and all
four recorded wrong-file publishes (2026-07-31 → 08-01) plus the #1931 concurrency
incident were caught by a human looking at the tracked file.

**Rejected: a pre-commit hook that regenerates silently.** Silent rewrites during
commit are unreviewable, and this repo's hooks are scope-gated: `verify:fast:scoped`
skips out-of-scope legs and docs-only pushes skip `verify:fast:branch` entirely —
which is precisely this file's diff shape. The gate would be absent exactly when it
is needed.

**Rejected: a declared shared-facts block per row (#2362 option 2).** Each side
carries machine-readable key/value facts and the checker compares only those. Its
weakness is named in #2362's own body — it *only protects claims someone remembered
to declare, the same failure mode one level up* — and it adds a schema to 65 rows
to catch a class (in-prose numeric claims) that generating the *derived* figures
does not reach anyway. **Not rejected forever**: if a second "five vs seven"
incident occurs after this ships, this is the next move, and saying so here is
cheaper than rediscovering it.

---

## Design

### 1. The generator is a reconciler, not a renderer

`scripts/build-register-live-view.mjs`, run as `npm run register:build`.

**Inputs:** the register `.md` **and the current** live-view `.html`.
**Output:** the same `.html`, with derived regions rewritten and row shells
reconciled, and **every hand-authored byte preserved**.

Taking the current `.html` as an input is what makes an editorial page compatible
with a build step. A pure renderer would have to invent the prose it cannot derive;
a reconciler only ever touches what it can prove.

It is hand-rolled string manipulation, consistent with every other parser in
`scripts/`. This repo has **no** markdown or HTML library anywhere in that
directory — `check-onbox-register.mjs` already parses both files with regexes, and
`publish-token.mjs` already does targeted attribute rewriting on this exact file.
No new dependency is introduced.

### 2. Three fully generated regions

Each is delimited by a marker-comment pair the generator owns end to end. Content
between the markers is **replaced wholesale**; content outside them is never read
for output. The markers are HTML comments of the form `BEGIN GENERATED:<region>`
and `END GENERATED:<region>`, for regions `strip`, `glance` and `changelog`.

**`strip`** — the six stat tiles at `.html:197-204`, derived from the `.md`'s
glance table (`:417-430`) and owed line (`:431-433`): Owed, Groups, Blocked,
Unconfirmed, Still-owed-in-A1, Oldest debt.

**`glance`** — the glance table at `.html:345-351`, including its Blocked and
Unconfirmed rows and the in-page anchor links, derived from the `.md` table at
`:417-430`. Setup descriptions are copied from the markdown cells verbatim.

**`changelog`** — the callouts at `.html:206`, `:272`, `:286`, `:297`, `:307`,
`:322`, `:331`, derived from the `.md` blockquote at `:435-678`. **All fourteen
entries render**, most-recent first; the current seven-vs-fourteen split disappears
by construction. The general "How this register goes stale" callout at `.html:188`
is *not* a changelog entry and stays hand-authored, outside the markers.

This is what settles **#2708**: the choice between "keep and curate" and "drop and
point at git" dissolves, because the curated copy stops being a copy. One
hand-maintained changelog in the `.md`; a mirror that cannot go stale. Option 1's
stated requirement — *needs a mechanical check, or the staleness recurs* — is met
by generation rather than by yet another detector.

**The one tile that is not derivable.** `Still owed in A1 (of 60) = 40` is read
from prose inside A1's heading region. The `.md` gains one declared marker comment,
`stat:still-owed-in-a1 = 40`, adjacent to the figure it names, and the generator
reads that. A declared marker is chosen over dropping the tile because the tile is
genuinely useful (A1 is two-thirds of the whole register), and over prose
extraction because parsing a bolded figure out of a sentence is exactly the fragile
coupling this spec exists to remove.

### 3. Row shells are reconciled; bodies are never touched

For every `### <ID> · <title>` heading in the `.md`, a `details.item` element must
exist in the matching `section.group`, in the markdown's order. The generator:

- **inserts** a shell for an ID present in the `.md` and absent from the `.html`,
  carrying the `num` span and a placeholder body;
- **deletes** a shell whose ID has left the `.md` (a discharge);
- **reorders** shells to match the markdown's row order;
- **preserves verbatim**, for every surviving shell, its entire body div, its
  `iname` span and its `risk` span.

Heading grammar, from the real file: an anchored `###`, the ID, a middot separator,
the title, and an optional trailing bolded status tag. There are no multi-ID
headings. One non-row `###` heading must be excluded: `.md:51` ("The publish
token") sits inside the Live-view section. The **Blocked** section's rows
deliberately carry no IDs (stripped by the predecessor spec to end the E6/E8
collision), and the **Unconfirmed** section uses plain bullets rather than `###`
headings — both are matched positionally by section rather than by ID.

**A newly inserted shell leaves CI red until a human writes the body.** That is the
intended behaviour, not a defect: it converts "row added to the `.md`, forgotten in
the `.html`" — the #1931 class — from an invisible omission into a failing check
with an obvious remedy. The placeholder carries a distinct class the drift guard
reports by name.

### 4. Enforcement: regenerate and byte-compare

`npm run register:build -- --check` runs the reconciler into memory and compares
byte-for-byte against the committed `.html`. Any difference fails, printing which
region or row shell diverged.

This matches shapes the repo already uses for derived artifacts — `npm run
openapi:types` for `src/lib/api-types.ts`, `scripts/render-brand-pngs.mjs` for the
committed brand PNGs. The `.html` stays tracked, stays reviewable in the PR diff,
and stays directly publishable.

**Wiring:** `--check` is added as a second step to the existing
`.github/workflows/onbox-register-check.yml`, which is already path-filtered to the
register, the live view, the checker and itself. The filter gains
`scripts/build-register-live-view.mjs`. The workflow stays non-required, consistent
with its current status.

**Idempotence is a hard requirement and a tested one.** `build` followed by `build`
must be a no-op, and `build` followed by `--check` must pass. A reconciler that is
not idempotent silently rewrites hand-authored prose on its second run.

### 5. What retires from `check-onbox-register.mjs`

Once the derived regions are generated, `checkLiveView`'s `'both'` direction
compares outputs of the same generator against themselves. Those comparisons become
**structurally incapable of failing** — coverage in appearance only, which this
repo has explicit form on. They are deleted, not kept:

| Check | Lines | Disposition |
|---|---|---|
| Owed total, `.md` vs `.html` | `:792-805` | **delete** — generated |
| Glance per-group counts | `:852-856` | **delete** — generated |
| Section header counts | `:941-945` | **delete** — generated |
| Row-ID set, expected vs found | `:946-949` | **delete** for `'both'`; **retained** for `extraOnly` |
| `checkRegister` — the `.md`'s own arithmetic, 4a uniqueness, 4b allocation floor | — | **retained in full** — the `.md` is the source and is still hand-maintained |

**`--against-published` survives untouched.** It compares the working tree against
the **live published page**, which no generator can constrain — a competing lane's
publish is an external event. Its `extraOnly` direction, the `staleExtra` /
`origin/main` baseline filter (`:984-998`), `--discharging` (`:1269`) and the
publish-token ancestry check all remain, and remain the reason the four-step
publish runbook (`.md:127-178`) exists.

This is a substantial deletion across a 1,562-line script and its 3,004-line,
116-test suite. Tests asserting the deleted comparisons are deleted with them;
tests asserting `checkRegister`'s own checks and the `--against-published` path are
kept. `buildLiveView` (`:979`) and the multi-group fixture builders survive because
`extraOnly` still needs live-view fixtures.

### 6. `wrongId` becomes fatal for the discharge class (#2721)

Independent of generation, and small.

The issue's "rehome" premise is **already satisfied**, and its body is stale on two
points, both verified against `main`:

- All three cited sites already point at **#2721**, not at closed #2629 —
  `check-register-citations.mjs:37` and `:209-210`, and the register's allocation
  blockquote at `:501-503`, which explicitly records #2629 as shipped.
- The body says "the two live `unknownSubject` residuals". There are **six**,
  across three files: `onbox-sitting-cloning-identity.md:237` and `:308` (twice),
  `onbox-sitting-two-card-boot.md:86`, and `onbox-sitting-vram-contention.md:95`
  and `:248`.

So only the decision remains, and it is taken: **widen it.** Under allocate-once
IDs a discharged row's ID is retired permanently, so a citation to it is
unambiguously dangling rather than silently re-pointing at whatever inherited the
number. That makes the signal strictly stronger than when the deferral was written.

Three things ship together:

1. `wrongId` fires for the discharge class — a citation whose ID exists but whose
   original subject has left the register.
2. The six residuals are **cleared by correcting the citations**, not by widening
   an exemption. Each is a real stale reference in a sitting run sheet.
3. The three deferral sites are rewritten to state the shipped behaviour, so
   nothing points at a question that is now closed.

The subtlety recorded in #2721 holds and must be honoured: `buildLegitimateSubjectMap`
maps one subject to a **set** of IDs, so discharging one row of a multi-row subject
does not remove the subject. The widening keys on the subject leaving entirely, not
on one ID leaving.

### 7. The two held tasks from the predecessor plan

Unchanged by this spec, and still owed. They ride in the same delivery because they
touch the same files:

- **Task 10** — wire the publish-nonce ancestry comparator into
  `--against-published`. The data half shipped in PR #2740
  (`scripts/publish-token.mjs`, `scripts/stamp-publish-token.mjs`, the seeded token
  at `.html:168`, 53 tests). The comparator consumes **four** history answers and
  `nonceInHistory` takes **five** arguments — the predecessor plan's Task 10 text
  declares one and four respectively, and is corrected in place. Its embedded
  implementation was design 6, killed in review; the shipped module is the
  reference, not that code block.
- **Task 12** — stand `check-register-citations.mjs` up as its own workflow. It
  scans the whole tracked tree (3,493 files) but **no workflow references it**; its
  only trigger is `test:hooks`, itself diff-gated to `docs/testing/**`, `scripts/**`
  and `CLAUDE.md`. Rot in `src/**`, `server/**` or `docs/features/**` is caught only
  when an unrelated in-scope file happens to change in the same diff. This is what
  makes #2603's closure honest.

---

## What this does NOT cover

Stated plainly rather than left to be discovered by the next review round.

**Prose drift is not detected.** E1's rewritten body can diverge from its markdown
source and nothing will catch it. This is the deliberate price of keeping the live
view readable, and it is the residual #2362 identified. If a second "five vs seven"
incident occurs, the next move is the declared shared-facts block rejected above —
not another whole-page redesign.

**`iname` and `risk` are not validated.** A row's shortened title and severity
synopsis are hand-authored and may describe the row inaccurately. Generating them
is impossible (no `.md` source) and checking them is the title-match option #2603
was closed without.

**Self-reference is still undetectable.** The register and its live view are both
in `check-register-citations.mjs`'s `FROZEN_EXACT` (`:382-390`) by design, so a row
body citing its own ID is never scanned. Unchanged here.

**Publishing stays manual.** CI has no credentials to fetch the artifact, and a
network dependency inside a status check is its own failure mode. The four-step
runbook, the canonical artifact URL recorded in the register's header, and the
pinned favicon are untouched.

---

## Ticket disposition

| Issue | Outcome |
|---|---|
| **#2362** | Closed by designs 1–2 — via **option 3's intent**, not its letter. The close comment records that "generate the row bodies both files share" rests on a false premise (they share facts, not prose), that option 2 is deliberately deferred and under what trigger it returns, and that in-prose numeric drift remains uncovered. |
| **#2708** | Closed by design 2's `changelog` region. Neither stated option wins outright: "keep and curate" is honoured for the `.md`, "drop the duplicate" for the page, and option 1's demand for a mechanical check is met by generation. The 14-vs-7 divergence and the page's self-admitted staleness both disappear. |
| **#2721** | Closed by design 6. The close comment records that the rehome half was already done, that the residual count in the body was 2 and is actually 6, and which three sites were rewritten. |
| **#2599** | Closed by design 7's Task 10 — the ancestry comparator, **not** the row-content diff the issue asked for, which the predecessor spec declined with six recorded rejections. |
| **#2603** | Closed by design 7's Task 12 — without title matching and without self-reference detection, both named above. |
| *new* | "Promote `register-citations-check` to a required status check" — promised by the predecessor spec's own disposition table and **never filed**. Filed in this round, to be decided after a few waves under stable IDs. |

---

## Delivery

Three PRs. The split is forced by the rule the predecessor spec learned the hard
way — **anything a checker requires of `origin/main` must be on `main` before the
code that requires it.**

**PR 1 — data.** Insert the three marker pairs into the `.html` around their
current content, add the still-owed-in-A1 marker to the `.md`, and correct the six
stale citations. No generator, no checker change. `main` then carries markers the
generator can find and a citation corpus the widened `wrongId` will accept.

**PR 2 — the generator and the retirement.** `build-register-live-view.mjs`,
`npm run register:build` and `--check`, the workflow step, and the deletion of
`checkLiveView`'s `'both'`-direction comparisons plus their tests. Largest PR;
`refactor` scope, so `high` review depth.

**PR 3 — the held tasks and `wrongId`.** Task 10, Task 12, the `wrongId` widening
and the three deferral-site rewrites.

Each PR publishes the live view only if it changed it, and bumps the publish token
via `npm run stamp:publish-token` when it does.

---

## Testing

`scripts/tests/build-register-live-view.test.mjs`, fixturing its own register and
live-view text rather than the real files (following
`check-onbox-register.test.mjs`'s `buildRegister` / `buildLiveView` pattern at
`:45-79` and `:979`):

- a changed owed total rewrites only the `strip` region — **assert the
  hand-authored style block and every row body are byte-identical**, the property
  the whole reconciler rests on;
- **`build` then `build` is a no-op**, and `build` then `--check` passes —
  idempotence, red before;
- a row added to the `.md` inserts a shell **with the placeholder**, in the right
  section, in markdown order;
- a row removed from the `.md` deletes its shell **and nothing adjacent**;
- reordered `.md` rows reorder shells while every body follows its own ID;
- a surviving row's `iname`, `risk` class and body survive a regeneration that
  changes counts around it;
- the `.md:51` publish-token heading is **not** treated as a row — the
  false positive the heading grammar must exclude;
- Blocked rows (no IDs) and Unconfirmed bullets are placed positionally and are
  never matched by the ID path;
- a missing marker pair is an **explicit error**, never a silent skip that would
  let the region drift unnoticed;
- `--check` fails with the diverging region named, and exits non-zero.

`scripts/tests/check-onbox-register.test.mjs`: the tests for each deleted
comparison are deleted; every `--against-published`, `extraOnly`, baseline and
`--discharging` test is retained and must stay green, since that path is explicitly
out of scope for this change.

`scripts/tests/check-register-citations.test.mjs`: a citation whose subject has
left the register entirely is **fatal**, red before; a citation to one ID of a
still-present multi-row subject is **not** fatal — the #2721 subtlety, and the test
that stops the widening over-firing.

**Real-tree, on the final branch:** `npm run register:build -- --check` green,
`npm run check:onbox-register` green, and `npm run check:register-citations` green
with **zero** fatal findings and the six residuals gone.

**Mutation, required by acceptance:** break the generator's changelog region so it
emits 7 entries instead of 14, confirm `--check` goes red, and report the observed
output. A drift guard that cannot be shown failing is not a guard.

---

## Shipping notes

- **No on-box acceptance row.** Nothing here needs real hardware — build tooling
  and CI only. Stated rather than silently skipped.
- **No release-notes entry.** Process and tooling, no user- or operator-visible
  delta. Stated rather than silently skipped.
- **Line citations in this document are current as of `main` at the time of
  writing.** The predecessor plan's citations went ~100 lines stale when Track A
  moved everything in `check-onbox-register.mjs`; navigate by symbol name, and
  re-derive any line number before relying on it.
