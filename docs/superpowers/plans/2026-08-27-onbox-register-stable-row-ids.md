# On-box register: stable row IDs + publish-token compare-and-swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the on-box acceptance register renumbering its row IDs on every discharge, and make `--against-published` able to detect that another lane published between your baseline and now.

**Architecture:** Row IDs become allocate-once/never-reuse: existing rows keep their IDs, each group gains a `next-id` allocation marker with a floor of `101`, the contiguity check that *forced* renumbering is deleted, and uniqueness + allocation-floor checks replace it. Separately, `--against-published` stops trying to diff row content (three rules were designed and all three failed — see the spec) and instead compares a monotonic publish token across three copies of the live view, which is an exact compare-and-swap. Delivered as **two PRs**, data before guards, because of the retro-application rule in "Global Constraints".

**Tech Stack:** Node 24 ESM (`scripts/*.mjs`), `node:test` + `node:assert` (`scripts/tests/*.test.mjs`, run via `npm run test:hooks`), GitHub Actions, hand-authored HTML.

**Spec:** [`docs/superpowers/specs/2026-08-27-onbox-register-stable-row-ids-design.md`](../specs/2026-08-27-onbox-register-stable-row-ids-design.md)

> **Citation hygiene in this document.** Like the spec, this plan discusses row
> IDs as *data*. It never uses the `row <ID>` idiom that
> `check-register-citations.mjs` Check A recognises, because IDs such as `A101`
> deliberately do not exist yet and a Check A match on them would be fatal. IDs
> appear bare and in backticks throughout. **Do not "fix" this by rewording an
> ID into prose** — an earlier draft of the spec was itself the only source of
> fatal citation errors in the tree.

---

## Global Constraints

Every task's requirements implicitly include this section.

1. **The retro-application rule.** `resolveBaselineGroups`
   (`scripts/check-onbox-register.mjs:501-516`) rejects the baseline outright if
   `checkRegister(baselineText)` reports **anything** — and the baseline is
   `origin/main`'s register read through the *new* checker. **Any tightening of
   `checkRegister` is therefore retro-applied to `origin/main`'s copy, so a
   guard cannot land in the same PR as the data it requires.** This is why PR 1
   ships data only and PR 2 ships guards. Violating it makes every
   `--against-published` run fail with `CANNOT_VERIFY_BASELINE_ERROR`, which the
   register's runbook (`docs/testing/onbox-acceptance-register.md:210-220`) says
   can only be fixed from `main`.

2. **No row number in either branch may be hardcoded from today's register.**
   Wave 9 (`wt-onbox-wave9`) merges first and renumbers Group A downward under
   the *current* rules. Every test fixtures its own register text; no test
   asserts against the real file's numbering. Group sizes are recomputed at
   rebase time. The `101` floor is safe regardless, because wave 9 only
   renumbers downward.

3. **The allocation floor is `101` for every group.** All-time high-waters from
   full git history of both files: `A`=48, `B`=5, `C`=4, `D`=3, `E`=11, `F`=1,
   `G`=2, `H`=2 (independently recomputed and confirmed). **The highest ID
   appearing anywhere in the tree is `A99`, not `A46`** — it is the citation
   checker's own sentinel for a definitely-nonexistent ID
   (`check-register-citations.mjs:733`, `:759`, `:785`, plus sixteen occurrences
   in its tests), and it occupies the `row <ID>` idiom. **The floor clears it by
   two, not by ~50.** Never lower it. If a fixture breaks against it, fix the
   fixture, not the floor.

4. **Existing row IDs are not renamed, re-keyed or renumbered by this work.**
   Roughly 210-225 `row <ID>` citations across ~65 files depend on them,
   including GitHub issue bodies no tool here can reach. The 16 known-dangling
   citations (`A38`, `A43`, `A45`, `B3`, `B4`, `F2`, `F3`) **stay dangling on
   purpose** — they are wrong, and they stay visibly wrong.

5. **Never hand-edit the published artifact, and never pad `--discharging`.**
   The register names padding as "the exact failure mode this check exists to
   catch" (`:155-170`).

6. **Commit convention** (`.husky/commit-msg` rejects violations):
   `<type>(<scope>): <subject>`. This work uses `chore(docs)`, `fix(docs)`,
   `chore(scripts)`, `test(scripts)`, `ci(scripts)`.

7. **Both branches are worktrees.** PR 1's already exists at
   `C:\Claude\Projects\wt-register-stable-row-ids` (branch
   `chore/ops-register-stable-row-ids`, hooks verified active). PR 2 gets its
   own via `node scripts/wt-new.mjs chore/scripts-register-stable-id-guards`.
   Never ride `main`; never bypass a hook with `--no-verify`.

---

## File Structure

| File | Responsibility | PR |
|---|---|---|
| `docs/testing/onbox-acceptance-register.md` | The register. Gains 7 `next-id` markers; Blocked headings lose their IDs; Group F sentence fixed; renumbering prose swept. | 1 (data), 2 (prose) |
| `docs/testing/onbox-acceptance-register-live-view.html` | The published twin. Gains the publish token; `BLK` section loses its two IDs; six stale changelog callouts collapse to one. | 1 |
| `scripts/check-onbox-register.mjs` | The checker. Loses check 4; gains 4a/4b and the publish-token compare-and-swap. | 2 |
| `scripts/tests/check-onbox-register.test.mjs` | Its tests. Check-4 tests replaced; fixture helpers taught the floor. | 2 |
| `scripts/check-register-citations.mjs` | Citation checker. Header premise corrected. | 2 |
| `.github/workflows/register-citations-check.yml` | **New.** Runs the citation checker on every PR, no path filter, **not** required. | 2 |
| `scripts/tests/workflow-wiring.test.mjs`, `scripts/verify-cache.mjs` | Know about every workflow file. | 2 |
| `CLAUDE.md`, `docs/features/269-ffmpeg-version-floor.md` | Prose that asserts the renumbering invariant / cites a blocked row. | 1 (269), 2 (CLAUDE.md) |

---

## Why the token carrier is settled empirically

> **Both points below are now folded into the spec** (§2, after the
> assumption-checker pass). Kept here because they are what Task 1 executes.

The spec specifies the publish token as an HTML comment:

```html
<!-- published-as: 47 -->
```

**That carrier is falsified by code the spec did not account for.**
`checkLiveView` blanks every HTML comment as its *first* action
(`scripts/check-onbox-register.mjs:641`, `stripHtmlComments` at `:354-361`), and
that blanking is load-bearing — its own header records that without it "a
commented-out row was counted as a real one, and commenting out a whole group
section … was invisible" (PR #2080 review round 2). A comment token is therefore
invisible to the very function that must read it, and would have to be parsed
off `rawLiveViewHtml` before stripping — a seam that is easy to get wrong once
and then silently vacuous forever, which is the exact shape of bug this checker
exists to catch.

There is a **second, larger** unknown the spec asserts rather than verifies: the
token must survive the round trip **tracked file → published artifact → locally
saved copy**. If the artifact platform strips comments, `published` is
permanently tokenless, and the check reads "wrong file published" on every run —
a guard that fails closed forever is as useless as one that passes vacuously.

**Task 1 settles this empirically before any code depends on it**, and the
recommended default if both carriers survive is a `data-published-as` attribute
on a real element rather than a comment, because it is immune to
`stripHtmlComments` by construction. Every downstream task references
`PUBLISH_TOKEN_CARRIER`, decided in Task 1 and recorded in the plan file itself.
The token's designed properties are carrier-independent: an integer compared as
a string (no normaliser), and a one-line git merge canary.

---

# PR 1 — Data

Branch `chore/ops-register-stable-row-ids`, worktree
`C:\Claude\Projects\wt-register-stable-row-ids`, already cut from `main`.

**Everything in PR 1 must be green under TODAY'S checker** (constraint 1). Verify
with `npm run check:onbox-register` after every task.

---

### Task 1: Settle the publish-token carrier

**Files:**
- Create: `<scratchpad>/token-carrier-probe.html` (throwaway, never committed)
- Modify: `docs/superpowers/plans/2026-08-27-onbox-register-stable-row-ids.md` (record the decision)

**Interfaces:**
- Consumes: nothing.
- Produces: `PUBLISH_TOKEN_CARRIER` — one of `attribute` or `comment` — and the
  exact literal string every later task greps for. Tasks 4, 10 and 11 depend on it.

**Why this is a task and not an assumption:** publishing is the only way to learn
what the artifact pipeline does to a comment. Reasoning about it is the
"instrument that could not fail" trap.

- [ ] **Step 1: Write the probe page**

Write `<scratchpad>/token-carrier-probe.html` carrying **both** candidate
carriers, so one publish answers both questions:

```html
<title>Token Carrier Probe</title>
<!-- published-as: 1 -->
<p data-published-as="1">Carrier probe. Both a comment token and an attribute
token are present in the source of this page.</p>
<p>If you can read this, the page published.</p>
```

- [ ] **Step 2: Publish it as a throwaway artifact**

Use the Artifact tool with this file path and **no `url`** — this deliberately
mints a NEW private artifact. It must not be published to the register's own
URL (`https://claude.ai/code/artifact/adf22b7b-12dd-49fe-874c-4a340585b26a`);
doing so would clobber the live register page.

- [ ] **Step 3: Read the published page back and inspect for both carriers**

Fetch the returned URL back to a local file (`WebFetch` on a `claude.ai/code/artifact`
URL saves raw HTML), then:

```bash
grep -c 'published-as: 1' <saved-copy>.html      # comment carrier survived?
grep -c 'data-published-as="1"' <saved-copy>.html # attribute carrier survived?
```

- [ ] **Step 4: Record the decision in this plan file**

Append to this task, verbatim, with the actual counts:

```
DECIDED <date>: comment carrier survived = <0|1>, attribute carrier survived = <0|1>.
PUBLISH_TOKEN_CARRIER = <attribute|comment>
Literal: <data-published-as="N" | <!-- published-as: N -->>
```

Decision rule, applied mechanically:
- attribute survives → **`attribute`** (preferred; immune to `stripHtmlComments`);
- attribute does not survive but comment does → **`comment`**, and Task 10 must
  parse from `rawLiveViewHtml` *before* `stripHtmlComments`, with its own test;
- **neither survives → STOP and escalate to the user.** Design 2 has no carrier
  and the spec needs reopening. Do not improvise a third carrier.

- [ ] **Step 5: Commit the decision**

```bash
git add docs/superpowers/plans/2026-08-27-onbox-register-stable-row-ids.md
git commit -m "docs(docs): record the publish-token carrier probe result"
```

---

### Task 2: Add `next-id` allocation markers to every group

**Files:**
- Modify: `docs/testing/onbox-acceptance-register.md` (7 group headings)

**Interfaces:**
- Consumes: nothing.
- Produces: the marker literal `<!-- next-id: <Letter>101 -->`, on its own line,
  immediately after each `## Group <Letter> — …` heading. Task 8's `4b` parses
  exactly this shape.

**Why it is inert today:** `checkRegister` calls `stripFences` but never
`stripHtmlComments`, so the marker survives into `splitSections`/`parseBodyGroups`
as ordinary text — where it matches neither `^## ` (`:80`) nor
`^### <Letter>\d` (`:154`). `parseGlanceTable` reads only the glance section and
needs exactly three cells, so no table column is owed. `checkLiveView` strips it
from the HTML side, and the live view does not mirror it.

- [ ] **Step 1: Confirm the group set at HEAD, do not assume it**

```bash
grep -n '^## Group ' docs/testing/onbox-acceptance-register.md
```

Expected today: `A B C D E G H` — seven sections, no `F`. If wave 9 changed
this, use what the command prints (constraint 2).

- [ ] **Step 2: Insert one marker per group**

For each letter the previous step printed, insert directly below its `## Group`
heading, with a blank line on each side:

```markdown
## Group A — The GPU box …

<!-- next-id: A101 -->

…existing intro prose…
```

The value is `<Letter>101` for **every** group (constraint 3) — not each group's
own high-water.

- [ ] **Step 3: Add the caveat comment to the first marker only**

Directly above Group A's marker, so a reader between PR 1 and PR 2 cannot walk
into the trap of allocating from a marker the current check would reject:

```markdown
<!-- Allocation marker (#2599/#2629). A row ID is allocated once and never
     reused: take this value for a new row, then bump it. DO NOT allocate from
     this yet — until the contiguity check is removed from
     scripts/check-onbox-register.mjs, an ID from this range fails the build.
     Until then, keep following the existing numbering. -->
```

- [ ] **Step 4: Verify today's checker is still green**

```bash
npm run check:onbox-register
```

Expected: `check:onbox-register: OK — … and … agree.`, exit 0. **A failure here
means the marker is not inert** — stop and re-read `parseBodyGroups`, do not
work around it by moving the marker somewhere unparsed.

- [ ] **Step 5: Commit**

```bash
git add docs/testing/onbox-acceptance-register.md
git commit -m "chore(docs): add per-group next-id allocation markers to the register"
```

---

### Task 3: Drop the Blocked section's row IDs, on both sides

**Files:**
- Modify: `docs/testing/onbox-acceptance-register.md:4251`, `:4285`
- Modify: `docs/testing/onbox-acceptance-register-live-view.html:1437`, `:1446`

**Interfaces:**
- Consumes: nothing.
- Produces: a Blocked section with no `<Letter><N>` IDs on either side. Task 8's
  `4a` whole-file uniqueness scan depends on this; without it, `4a` fails on
  merge day against real data.

**The bug being fixed (#2634 = #2653):** `E6` and `E8` each name **two** rows —
a live Group E row and a Blocked row — because the Blocked section borrowed IDs
from the Group E sequence that renumbers underneath it. Verified at HEAD:

| ID | Live Group E | Blocked |
|---|---|---|
| `E6` | register `### E6` / live view `:1258` (fe-57 venv-bootstrap) | register `:4285` / live view `:1446` (ops-35 ffmpeg floor) |
| `E8` | register `### E8` / live view `:1292` (Revoke loopback) | register `:4251` / live view `:1437` (ops-36 golden-assembly) |

Three of the five Blocked rows already carry no ID, so dropping these two makes
the section internally consistent rather than inventing a new convention.

- [ ] **Step 1: Drop the IDs from the register's two Blocked headings**

`:4251`, from:

```markdown
### E8 · ops-36 golden-assembly on a second ffmpeg build ([#1880](…), plan [272](…))
```

to:

```markdown
### ops-36 golden-assembly on a second ffmpeg build ([#1880](…), plan [272](…))
```

`:4285`, from:

```markdown
### E6 · ops-35 ffmpeg floor — below-floor + Re-check walkthrough ([#1877](…), plan [269](…))
```

to:

```markdown
### ops-35 ffmpeg floor — below-floor + Re-check walkthrough ([#1877](…), plan [269](…))
```

Leave the link targets and the bodies untouched.

- [ ] **Step 2: Drop the IDs from the live view's two `BLK` rows**

`:1437`, from:

```html
<summary><span class="num">E8</span><span class="iname">ops-36 golden-assembly on a second ffmpeg build</span>…
```

to — matching the three sibling rows, which **do** carry a `num` span holding an
em dash (verified at `:1430`). An earlier draft of this plan said they carry none;
that was wrong, and following it would have produced markup inconsistent with the
very siblings it cited:

```html
<summary><span class="num">—</span><span class="iname">ops-36 golden-assembly on a second ffmpeg build</span>…
```

Same shape at `:1446` for the ops-35 row.

**Both sides, or the tickets are only half closed.** Nothing mechanical looks at
the `BLK` section — `parseGlanceTable` needs `^[A-Z]$` and
`parseLiveViewSections` filters on `gtag` — so a markdown-only fix leaves the
collision alive in the *published artifact*, silently, in violation of the live
view's own footer rule ("update both, in the PR that changes either").

- [ ] **Step 3: Confirm no ID survives in either Blocked section**

```bash
grep -n 'class="num">E[68]<' docs/testing/onbox-acceptance-register-live-view.html
```

Expected: exactly **two** hits, both in the live Group E section (`:1258`,
`:1292`) — not four.

- [ ] **Step 4: Verify**

```bash
npm run check:onbox-register
```

Expected: exit 0, unchanged. The Blocked section is unscanned on both sides, so
the counts do not move.

- [ ] **Step 5: Commit**

```bash
git add docs/testing/onbox-acceptance-register.md docs/testing/onbox-acceptance-register-live-view.html
git commit -m "fix(docs): drop Blocked-section row IDs that collided with live Group E rows"
```

---

### Task 4: Add the publish token to the live view

**Files:**
- Modify: `docs/testing/onbox-acceptance-register-live-view.html`

**Interfaces:**
- Consumes: `PUBLISH_TOKEN_CARRIER` from Task 1.
- Produces: exactly one occurrence of the token literal in the tracked live-view
  HTML, with an integer value. Task 10's parser matches it; Task 10's tests use
  the same literal.

- [ ] **Step 1: Add the token near the top of the page body**

Immediately after the `<h1>On-box acceptance register</h1>` line, using the
carrier Task 1 chose. For `attribute`:

```html
<p class="eyebrow" data-published-as="1" data-published-by="chore/ops-register-stable-row-ids">
  Publish token 1 — bump the number by one in any change that publishes this page,
  and set <code>data-published-by</code> to your own branch. It is how
  <code>--against-published</code> tells <em>your</em> earlier publish this review
  cycle apart from <em>another lane's</em>.</p>
```

**Both fields, always.** A bare counter cannot distinguish your own round-two
publish from a competing lane's — both land on the same number. That is the
fourth rejected design in spec §2, and `data-published-by` is what closes it.

Start the counter at `1`. The value only has to be monotonic, not historically
meaningful.

For the `comment` carrier, the same two fields as
`<!-- published-as: 1 by chore/ops-register-stable-row-ids -->`, plus the
explanatory `<p>` without the attributes.

- [ ] **Step 2: Confirm exactly one occurrence**

```bash
grep -c 'published-as' docs/testing/onbox-acceptance-register-live-view.html
```

Expected: `1` for the attribute carrier (2 if the comment carrier's prose also
names it — in that case confirm only one is *machine-shaped*). **More than one
machine-shaped occurrence is a defect**: Task 10's parser will be written to
reject ambiguity rather than take the first match.

- [ ] **Step 3: Verify and commit**

```bash
npm run check:onbox-register
git add docs/testing/onbox-acceptance-register-live-view.html
git commit -m "chore(docs): add the publish token to the register live view"
```

---

### Task 5: Collapse the six stale changelog callouts

**Files:**
- Modify: `docs/testing/onbox-acceptance-register-live-view.html:200-267`

**Interfaces:**
- Consumes: nothing.
- Produces: one current-state callout in place of six historical ones.

**This is real rot, found in passing, and it is live on the published page
right now.** Six `<div class="callout warn">` blocks narrate a 69-row world
(`65 → 66`, `66 → 67`, `67 → 67`, `67 → 68`, `68 → 69`, `69 → 69`) and describe
`A44`/`A45`/`A46`. The summary strip immediately above them says **60 owed**,
and Group A holds 37 rows — so none of those IDs exists, and each now names an
unrelated row. Wave 8 updated the strip, the rows and the footer and left the
callout stack behind; `check:onbox-register` is green over it because callouts
are not parsed.

**The repair shape is already settled precedent, not a fresh decision.** The
last callout in the stack states the page's own policy — *"This page tracks the
current count, not how it got here — see this file's git log for the full
history"* (`:265-266`) — and the shipped "register tracks state, not history"
ruling collapsed the register's correction log to one line for the same reason.

- [ ] **Step 1: Delete the six changelog callouts at `:200-267`**

Identify them by their **opening text**, not by their CSS class: they are the six
blocks beginning `<b>Last change:`, `<b>Prior change:` (×4) and `<b>Before that:`.

**Do not grep for `callout warn` and delete every hit.** `:182-189` ("How this
register goes stale") is *also* a `callout warn` and must be **kept** — it is
evergreen and carries no count or row ID. So must `:174-180` ("Owed acceptance
never blocks a merge"), which is a plain `callout`. There are seven `callout warn`
blocks in the file; exactly six are being deleted.

- [ ] **Step 2: Insert one current-state callout in their place**

```html
  <div class="callout warn">
    <b>This page tracks the current state, not how it got here.</b> Row counts and
    row IDs above are current as of the footer's sync date. For what changed and
    when, read this file's git log — a running changelog here goes stale silently,
    because nothing mechanical checks callout prose against the rows.
  </div>
```

- [ ] **Step 3: Confirm no stale ID or count survives in the callouts**

```bash
grep -n 'A4[4-6]\|6[5-9] &rarr;\|6[5-9] →' docs/testing/onbox-acceptance-register-live-view.html
```

Expected: no hits.

- [ ] **Step 4: Verify and commit**

```bash
npm run check:onbox-register
git add docs/testing/onbox-acceptance-register-live-view.html
git commit -m "fix(docs): collapse six stale live-view changelog callouts to current state"
```

---

### Task 6: Fix the Group F sentence and the one blocked-row citation

**Files:**
- Modify: `docs/testing/onbox-acceptance-register.md:184-186`
- Modify: `docs/features/269-ffmpeg-version-floor.md:215`

**Interfaces:**
- Consumes: Task 3 (the blocked heading no longer carries `E6`).
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Fix the Group F sentence**

`:184-186` offers "Group F's sole row, F1" as "a real, live example of exactly
this shape". Group F was discharged; it is absent from the glance table and the
body. Replace the example with one that is currently true, or restate the shape
without naming a group. Read the surrounding paragraph first — the sentence is
teaching the `--discharging` arithmetic, so the replacement has to still teach it.

- [ ] **Step 2: Re-point the blocked-row citation — BY HAND, NOT BY GREP**

**This is the one-line hazard in PR 1.** Two textually identical citations exist:

| Line | Means | Action |
|---|---|---|
| `docs/features/269-ffmpeg-version-floor.md:215` | the **Blocked** ffmpeg row (which just lost its ID) | **must change** |
| `docs/features/270-openapi-setup-surface.md:166` | the **live** `E6` (venv-bootstrap, plan 270) | **must NOT change** |

Only the surrounding plan number disambiguates them, and **nothing mechanical
verifies either way** — `E6` exists regardless, so Check A stays silent, and a
features-doc prose citation is outside Check C's fatal surface. Open both lines,
read the surrounding sentence, change only the 269 one. Cite the blocked row by
its title ("the ops-35 ffmpeg-floor blocked row"), since it no longer has an ID.

- [ ] **Step 3: Verify both checkers**

```bash
npm run check:onbox-register
npm run check:register-citations
```

Expected: `check:onbox-register` exit 0. `check:register-citations` exit 0 with
the 16 pre-existing annotated notes **unchanged in count** — if that number
moved, you touched a citation you should not have.

- [ ] **Step 4: Commit**

```bash
git add docs/testing/onbox-acceptance-register.md docs/features/269-ffmpeg-version-floor.md
git commit -m "fix(docs): correct the discharged-Group-F example and the blocked ffmpeg row citation"
```

---

### Task 7: Verify, publish, and open PR 1

**Files:** none modified.

**Interfaces:**
- Consumes: Tasks 2-6.
- Produces: a merged `main` whose register passes the *new* checker, which is
  PR 2's baseline precondition (constraint 1).

- [ ] **Step 1: Run the branch-scoped battery**

```bash
npm run verify:fast:branch
```

- [ ] **Step 2: Save the currently-live page and run the mandated pre-publish check**

Fetch the page currently live at the register's recorded artifact URL to a local
file, then:

```bash
npm run check:onbox-register -- --against-published <saved-copy>.html
```

Expected: `OK — … is not behind …`. **If it disagrees, stop and read the
register's "Live view" section — do not pad `--discharging`** (constraint 5).
This run still uses the *old* comparator; the token check does not exist yet.

- [ ] **Step 3: Publish the live view to its existing URL**

Publish `docs/testing/onbox-acceptance-register-live-view.html` with the `url`
recorded in the register's header — never without it (that mints a second
register), and never publish the `.md` to that URL (that has happened four times).

- [ ] **Step 4: Open the PR**

Body must carry `Closes #2634` and `Closes #2653`, and `Refs #2599`, `Refs #2603`,
`Refs #2629` (PR 2 closes those three). Declare the incidental fixes explicitly:

```markdown
Also fixed, found in passing:
- six live-view changelog callouts describing rows that no longer exist (A44/A45/A46, counts 65→69) while the strip says 60 owed;
- the register's "Group F's sole row" example, which cites a discharged group;
- a features-doc citation to the Blocked ffmpeg row, which no longer has an ID.
```

**No on-box acceptance row and no release-notes entry** — stated explicitly in
the PR body rather than silently omitted. Nothing here needs real hardware, and
there is no user- or operator-visible delta.

- [ ] **Step 5: Run the mandatory `pr-review-gate` pass, fold findings, merge**

Depth `medium` (single-scope `fix`/`chore` mix touching data the checker reads).

---

# PR 2 — Guards

New worktree: `node scripts/wt-new.mjs chore/scripts-register-stable-id-guards`,
cut **after PR 1 merges**. Verify hooks (`ls -d .husky/_`) before the first commit.

---

### Task 8: Replace the contiguity check with uniqueness + allocation floor

**Files:**
- Modify: `scripts/check-onbox-register.mjs:313-327` (delete check 4), plus new helpers
- Test: `scripts/tests/check-onbox-register.test.mjs`

**Interfaces:**
- Consumes: Task 2's marker literal.
- Produces:
  - `parseNextIdMarker(sectionBody, letter) -> number | null`
  - `parseAllRowHeadings(strippedText) -> Array<{ id: string, letter: string, number: number }>`
  - `ALLOCATION_FLOOR = 101` (exported)
  - `checkRegister` no longer reports "not contiguous from 1"; it reports
    duplicate IDs and at-or-above-`next-id` IDs.

- [ ] **Step 1: Write the failing tests**

Add to `scripts/tests/check-onbox-register.test.mjs`. Each fixtures its own
register (constraint 2).

**There is no helper with the shape these tests need — write one first.** The
file's only builders are `buildRegister({tableA, tableB, total, bodyARows, bodyBRows})`
(`:43-86`) and `buildSingleGroupRegister(...)` (`:1240-1259`); neither takes a
`nextId` or an extra section, so `registerFixture` below is **new code this step
creates**, not an existing API. Give it the signature the tests use
(`{ glance, groups: [{letter, nextId, rows}], extraSections }`) and have it emit a
`<!-- next-id: … -->` line per group unless `nextId` is `null`. Also add the new
imports (`ALLOCATION_FLOOR`, and Task 10's exports when you get there) to the
import block at `:11-18`.

```js
test('4: a group with gaps passes — IDs are allocated once, never reused', () => {
  const text = registerFixture({
    glance: [['A', 2]],
    groups: [{ letter: 'A', nextId: 101, rows: [1, 7] }],
  });
  assert.deepEqual(checkRegister(text), []);
});

test('4a: the same row ID in two sections is reported', () => {
  // The #2634/#2653 repro: a Blocked-section heading reusing a live Group E ID.
  const text = registerFixture({
    glance: [['E', 1]],
    groups: [{ letter: 'E', nextId: 101, rows: [6] }],
    extraSections: ['## Blocked — hardware not available\n\n### E6 · a blocked thing\n'],
  });
  assert.ok(
    checkRegister(text).some((e) => e.includes('Row ID E6 appears more than once')),
    'a duplicate row ID across sections must be reported',
  );
});

test('4b: a row ID at or above its group next-id is reported', () => {
  const text = registerFixture({
    glance: [['A', 1]],
    groups: [{ letter: 'A', nextId: 101, rows: [101] }],
  });
  assert.ok(checkRegister(text).some((e) => e.includes('is at or above')));
});

test('4b: a group with no next-id marker is an error, not a skip', () => {
  const text = registerFixture({
    glance: [['A', 1]],
    groups: [{ letter: 'A', nextId: null, rows: [1] }],
  });
  assert.ok(
    checkRegister(text).some((e) => e.includes('has no "<!-- next-id:')),
    'a missing marker must not silently disable the allocation-floor check',
  );
});

test('4b: a next-id below the allocation floor is reported', () => {
  const text = registerFixture({
    glance: [['A', 1]],
    groups: [{ letter: 'A', nextId: 38, rows: [1] }],
  });
  assert.ok(checkRegister(text).some((e) => e.includes('below the allocation floor')));
});
```

- [ ] **Step 2: Run them and confirm they fail for the right reason**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

Expected: the gap test fails with "not contiguous from 1" (check 4 still live);
the other four fail because the messages do not exist yet. **Confirm the gap
test's failure text actually names contiguity** — a test that is red for an
unrelated reason proves nothing.

- [ ] **Step 3: Implement the helpers**

Insert above `checkRegister`:

```js
// The allocation floor. Every group's `next-id` must be at or above this, and
// every row ID strictly below its group's own `next-id`. 101 is provably above
// all history: full git log of the register and its live view gives all-time
// high-waters of A=48, B=5, C=4, D=3, E=11, F=1, G=2, H=2, and the highest ID
// cited anywhere in the tree is A46. Never lower it — if a fixture breaks
// against it, the fixture is what is wrong.
export const ALLOCATION_FLOOR = 101;

// Parses a group section's `<!-- next-id: <Letter><N> -->` allocation marker.
// Returns null when absent, which callers report as an error rather than
// treating as "no floor to enforce" — a missing marker silently disabling the
// check is the guard-evaporates-on-missing-input shape this file already
// fails closed against elsewhere.
export function parseNextIdMarker(sectionBody, letter) {
  const match = sectionBody.match(
    new RegExp(`^<!--\\s*next-id:\\s*${letter}(\\d+)\\s*-->\\s*\\r?$`, 'm'),
  );
  return match ? Number(match[1]) : null;
}

// Every `### <Letter><N>` row heading in the WHOLE document, including
// sections `parseBodyGroups` never visits (Blocked, and anything added later).
// Uniqueness is a document-wide property: #2634/#2653 were exactly a Blocked
// heading reusing a live Group E ID, which a group-scoped scan cannot see.
export function parseAllRowHeadings(strippedText) {
  const found = [];
  for (const match of strippedText.matchAll(/^### ([A-Z])(\d+)(?=\s|\r?$)/gm)) {
    found.push({ id: `${match[1]}${match[2]}`, letter: match[1], number: Number(match[2]) });
  }
  return found;
}
```

- [ ] **Step 4: Replace check 4 in `checkRegister`**

Delete `:313-327` entirely and put in its place:

```js
  // Check 4a: row IDs are unique across the WHOLE document, not just within a
  // group section. Replaces the old contiguity check, which required every
  // discharge to renumber the survivors and so rotted every citation into the
  // group (#2599/#2603/#2629/#2634/#2653).
  const seenRowIds = new Map();
  for (const { id } of parseAllRowHeadings(fenceStrippedText)) {
    seenRowIds.set(id, (seenRowIds.get(id) ?? 0) + 1);
  }
  for (const [id, count] of seenRowIds) {
    if (count > 1) {
      errors.push(
        `Row ID ${id} appears more than once (${count} headings). Row IDs are allocated once and never reused — give the newer row its group's next-id instead.`,
      );
    }
  }

  // Check 4b: every row ID sits strictly below its group's allocation marker,
  // and the marker is at or above the floor. Together these stop a new row
  // being given an ID that a discharged row already used.
  for (const section of sections) {
    const titleMatch = section.title.match(/^Group ([A-Z])\b/);
    if (!titleMatch) continue;
    const letter = titleMatch[1];
    // NOTE the suppression is deliberately NOT applied to the marker-presence
    // and floor checks below — only to the per-row comparison. `:222-228`
    // suppresses checks on a letter with an invalid row heading because its
    // count and contiguity were artifacts of that same rejected heading.
    // Whether a group carries an allocation marker is independent of every row
    // heading in it, so suppressing it here would let one `### A19b` anywhere
    // in Group A make Group A's MISSING marker unreportable — widening a
    // narrow suppression into a hole in the new check.
    const nextId = parseNextIdMarker(section.body, letter);
    if (nextId === null) {
      errors.push(
        `Group ${letter} has no "<!-- next-id: ${letter}N -->" allocation marker. Add one directly under the group heading — without it there is nothing to allocate new row IDs from.`,
      );
      continue;
    }
    if (nextId < ALLOCATION_FLOOR) {
      errors.push(
        `Group ${letter}'s next-id (${letter}${nextId}) is below the allocation floor ${letter}${ALLOCATION_FLOOR}. IDs below the floor have been used before; reusing one silently re-points every existing citation.`,
      );
    }
    if (invalidRowHeadingLetterSet.has(letter)) continue;
    for (const n of bodyGroups.get(letter) ?? []) {
      if (n >= nextId) {
        errors.push(
          `Group ${letter}: ${letter}${n} is at or above the group's next-id (${letter}${nextId}). Bump next-id past every allocated ID.`,
        );
      }
    }
  }
```

- [ ] **Step 5: Run the tests and confirm they pass**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

Expected: the five new tests PASS. Others will still fail — Task 11 migrates them.

- [ ] **Step 6: Commit**

```bash
git add scripts/check-onbox-register.mjs scripts/tests/check-onbox-register.test.mjs
git commit -m "feat(scripts): replace register row contiguity with uniqueness and an allocation floor"
```

---

### Task 9: Sweep the checker's own contiguity-shaped strings

**Files:**
- Modify: `scripts/check-onbox-register.mjs:44-49`, `:171-183`, `:247`, **`:481`**,
  `:577-579`, `:628-632`, `:811`, `:963-967`, **`:1362`**, `:1385-1389`

> **`:481` and `:1362` were dropped from an earlier draft of this list.** `:481`
> is `resolveBaselineGroups`' header, which enumerates *"a contiguity gap"* as a
> malformed-baseline shape that will no longer exist. `:1362` warns that *"an
> agent following it literally would add a duplicate and trip the contiguity
> check"* — the spec named it explicitly and the plan lost it. Neither is
> optional: both are operator- or agent-facing text asserting a deleted rule.

**Interfaces:**
- Consumes: Task 8.
- Produces: no behaviour change except `formatRowList`'s output shape.

Each of these asserts, in operator-facing text, an invariant Task 8 just deleted.
A message telling an operator to renumber is now actively wrong advice.

- [ ] **Step 1: `formatRowList` (`:171-183`)**

Its range collapse is gated on `contiguous from 1`, which under stable IDs is
now the *uncommon* case. Generalise to collapse any contiguous run
(`A1–A3, A7`), or drop the collapse entirely and always list. Update the header
comment, which currently says "a gap or duplicate is already named explicitly by
the contiguity check below" — that check is gone.

- [ ] **Step 2: `:247` — the sub-lettering rejection**

`"Rows are numbered contiguously (A1, A2, …)"` → state the real rule:
`"Row numbers are plain integers (A1, A2, …), allocated once from the group's next-id"`.
Six tests assert this string verbatim; Task 11 moves them.

- [ ] **Step 3: `:44-49` — the `stripFences` residual limitation**

It is phrased *in terms of* check 4 ("the contiguity check (4) only surfaces it
when the hidden row isn't the group's highest-numbered one"). Under 4a a
balanced-fence-hidden row is now invisible to *every* check, which is a
**widening** of the stated limitation. Say so plainly rather than deleting the
paragraph — a limitation that quietly grew is worse than one that is documented.

- [ ] **Step 4: `:628-632` — the `--discharging` renumbering wrinkle**

Delete the wrinkle. Under stable IDs the ID that vanishes **is** the row
discharged. Replace with: *"Name the ID of the row you discharged. Under stable
row IDs that is exactly the ID that disappears from the live page — IDs are
never reused, so nothing shifts."* Mirror the same deletion at `:963-967` and
`:1385-1389`.

- [ ] **Step 5: Add the retro-application rule to the file header**

It is a general fact about this codebase, not a quirk of this change, and it is
what forced the two-PR split:

```js
// Any tightening of `checkRegister` is retro-applied to `origin/main`'s copy of
// the register, because `resolveBaselineGroups` runs the CURRENT checker over
// the FETCHED baseline and rejects it outright on any error. A new rule
// therefore cannot land in the same PR as the data it requires: ship the data
// first, merge it, then ship the rule. Landing both at once makes every
// `--against-published` run fail with CANNOT_VERIFY_BASELINE_ERROR, which the
// register's runbook says can only be fixed from `main`.
```

- [ ] **Step 6: Verify and commit**

```bash
npm run check:onbox-register
git add scripts/check-onbox-register.mjs
git commit -m "chore(scripts): sweep contiguity-era guidance out of the register checker"
```

---

### Task 10: Publish-token compare-and-swap in `--against-published`

**Files:**
- Modify: `scripts/check-onbox-register.mjs` — `resolveBaselineText` (`:1060-1075`),
  `checkLiveView` (`:633+`), the CLI's `extraOnly` block (`:1268-1420`)
- Modify: `docs/testing/onbox-acceptance-register.md` — the "If it fails" tree
- Test: `scripts/tests/check-onbox-register.test.mjs`

**Interfaces:**
- Consumes: Task 1's `PUBLISH_TOKEN_CARRIER`, Task 4's two-field token.
- Produces:
  - `parsePublishToken(rawHtml) -> { n: number, who: string } | { malformed: string } | null`
  - `comparePublishTokens({ working, published, baseline, branch, allowBehind }) -> string[]`
  - `PUBLISH_TOKEN_BASELINE_ERROR` (exported constant, matched by identity)
  - `resolveBaselineText` additionally returns `sha`
  - `resolveBaselineLiveView(repoRoot, liveViewPath, sha, gitRunner) -> { text, failedStep }`
  - env seam `ONBOX_TEST_BASELINE_LIVE_VIEW_FILE`
  - CLI flag `--live-page-behind-main`

**Five facts this task must not get wrong:**

1. **A bare counter does not work.** It cannot distinguish your own round-two
   publish from a competing lane's — both occupy the interval
   `baseline ≤ published ≤ working`. This is the fourth rejected design in spec
   §2. **Both token fields are load-bearing**; an implementation that compares
   only `n` reintroduces the failure that killed it.
2. `checkLiveView`'s **first** action is `stripHtmlComments(rawLiveViewHtml)`
   (`:641`), and that blanking is load-bearing (PR #2080 review round 2). Under
   the `comment` carrier the token MUST be read off `rawLiveViewHtml` before that
   line. Under `attribute` the hazard does not exist — which is why it is preferred.
3. `--against-published` **never reads the tracked live-view HTML today**:
   `const liveViewHtml = read(LIVE_VIEW)` sits at `:1423`, *after* that mode's
   `return` at `:1420`. Reading it in `extraOnly` is new.
4. Both baselines must come from **one** commit. `resolveBaselineText` already
   freezes the SHA in a local (`:1069`, already `.trim()`ed) after deliberately
   reading `FETCH_HEAD` rather than `origin/main` (#2199 round 3). Return **that
   frozen string**; a second `rev-parse` reopens the race the freeze closed.
5. **`null` is not "tokenless".** A git failure on either baseline half must
   reach its own fail-closed error, never the same branch as a page that simply
   has no token. Collapsing them is the guard-evaporates-on-missing-input shape
   `resolveBaselineGroups`' own header (`:483-494`) exists to prevent.

- [ ] **Step 1: Write the failing tests**

```js
const BRANCH = 'chore/scripts-register-stable-id-guards';
const OTHER = 'chore/ops-onbox-wave9';
const T = (n, who) => `<p data-published-as="${n}" data-published-by="${who}">x</p>`;
const cmp = (o) => comparePublishTokens({ branch: BRANCH, ...o });

test('token: the ordinary first publish is green', () => {
  assert.deepEqual(cmp({ working: T(48, BRANCH), published: T(47, OTHER), baseline: T(47, OTHER) }), []);
});

test('token: a SAME-BRANCH re-publish is green', () => {
  // THE test that kills a bare counter. baseline 47, this branch already
  // published 48, review feedback lands, now publishing 49. Under a counter-only
  // rule `published(48) != baseline(47)` reports a competing lane that does not
  // exist — and this register's normal review cycle is multi-publish-per-branch
  // (PR #2578 published across rounds 13-21).
  assert.deepEqual(cmp({ working: T(49, BRANCH), published: T(48, BRANCH), baseline: T(47, OTHER) }), []);
});

test('token: ANOTHER lane publishing into the same interval is reported', () => {
  // Byte-identical counters to the test above; only `who` differs. If this
  // passes while the previous one also passes, the `who` field is being ignored.
  const errors = cmp({ working: T(49, BRANCH), published: T(48, OTHER), baseline: T(47, OTHER) });
  assert.ok(errors.some((e) => e.includes('published since your baseline')));
});

test('token: a live page BEHIND main is reported with its own message', () => {
  const errors = cmp({ working: T(49, BRANCH), published: T(46, OTHER), baseline: T(47, OTHER) });
  assert.ok(errors.some((e) => e.includes('behind')), 'must not reuse the competing-lane message');
});

test('token: --live-page-behind-main clears the stalemate, and ONLY that state', () => {
  assert.deepEqual(
    cmp({ working: T(49, BRANCH), published: T(46, OTHER), baseline: T(47, OTHER), allowBehind: true }),
    [],
  );
  // The flag must not become a blanket mute — same shape as --discharging's own
  // unconsumed-name guard.
  assert.ok(
    cmp({ working: T(49, BRANCH), published: T(48, OTHER), baseline: T(47, OTHER), allowBehind: true }).length > 0,
    '--live-page-behind-main must not suppress a genuine competing publish',
  );
});

test('token: a tokenless published page against a tokened baseline is reported', () => {
  // Also pins the ABSENCE of a bootstrap branch: this must never return [].
  const errors = cmp({ working: T(48, BRANCH), published: '<p>no token</p>', baseline: T(47, OTHER) });
  assert.ok(errors.some((e) => e.includes('no publish token')));
});

test('token: an unbumped working file is reported', () => {
  const errors = cmp({ working: T(47, BRANCH), published: T(47, OTHER), baseline: T(47, OTHER) });
  assert.ok(errors.some((e) => e.includes('bump')));
});

test('token: an UNRESOLVABLE baseline fails closed, and is not mistaken for tokenless', () => {
  // resolveBaselineText returns { text: null } on a git failure. null must reach
  // its own error by IDENTITY — never the tokenless path, and never green.
  const errors = cmp({ working: T(48, BRANCH), published: '<p>no token</p>', baseline: null });
  assert.deepEqual(errors, [PUBLISH_TOKEN_BASELINE_ERROR]);
});

test('token: a non-integer counter is an error, not a skip', () => {
  assert.ok(cmp({ working: `<p data-published-as="abc" data-published-by="${BRANCH}">x</p>`,
    published: T(1, OTHER), baseline: T(1, OTHER) }).some((e) => e.includes('not a bare integer')));
});

test('token: an empty publisher is an error, not a skip', () => {
  assert.ok(cmp({ working: T(2, ''), published: T(1, OTHER), baseline: T(1, OTHER) })
    .some((e) => e.includes('publisher')));
});

test('token: two tokens in one file is an error, not a first-match win', () => {
  assert.ok(cmp({ working: T(2, BRANCH) + T(3, BRANCH), published: T(1, OTHER), baseline: T(1, OTHER) })
    .some((e) => e.includes('more than once')));
});

test('resolveBaselineLiveView uses the SAME sha resolveBaselineText froze', () => {
  const calls = [];
  const runner = (args) => {
    calls.push(args.join(' '));
    if (args[0] === 'rev-parse') return { status: 0, stdout: 'deadbeef\n' };
    return { status: 0, stdout: 'x' };
  };
  const { sha } = resolveBaselineText('/repo', 'reg.md', runner);
  resolveBaselineLiveView('/repo', 'live.html', sha, runner);
  assert.equal(calls.filter((c) => c.startsWith('rev-parse')).length, 1,
    'the sha must be frozen once, not re-resolved');
  assert.ok(calls.some((c) => c === 'show deadbeef:live.html'));
});
```

If Task 1 chose the `comment` carrier, add:

```js
test('token: a comment-carried token survives stripHtmlComments ordering', () => {
  // Regression pin: checkLiveView blanks comments as its FIRST action, so the
  // token must be read off the raw html before that line.
  const raw = '<!-- published-as: 5 by some-branch -->\n<p>body</p>';
  assert.equal(parsePublishToken(raw).n, 5);
  assert.equal(parsePublishToken(stripHtmlComments(raw)), null);
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

Expected: all fail with "comparePublishTokens is not defined". **Confirm the
same-branch-re-publish test and the competing-lane test fail for *different*
reasons than each other once the code exists** — they differ only in `who`, so if
they ever agree, `who` is being ignored and the design has silently reverted to a
bare counter.

- [ ] **Step 3: Implement the parser and the comparator**

```js
// The publish token. See docs/superpowers/specs/2026-08-27-onbox-register-
// stable-row-ids-design.md §2: FOUR designs were rejected before this one —
// three per-row content rules, then a bare monotonic counter. The counter failed
// because a same-branch re-publish and a competing lane's publish occupy the
// same interval [baseline, working] and are the same number. `who` is what
// separates them. Compare BOTH fields or the failure returns.
const PUBLISH_TOKEN_REGEX = /data-published-as="([^"]*)"\s+data-published-by="([^"]*)"/g;

// Distinct from a page that merely has no token — a git failure is "no
// baseline", and everywhere else in this file that distinction is load-bearing
// and matched by identity (see CANNOT_VERIFY_BASELINE_ERROR, :529).
export const PUBLISH_TOKEN_BASELINE_ERROR =
  'Cannot verify the publish token: the origin/main baseline live view is ' +
  'unavailable or unreadable, so a competing publish cannot be told apart from ' +
  'an ordinary one. Do not publish until this passes.';

export function parsePublishToken(rawHtml) {
  if (typeof rawHtml !== 'string') return null;
  const matches = [...rawHtml.matchAll(PUBLISH_TOKEN_REGEX)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { malformed: `the publish token appears more than once (${matches.length} times)` };
  }
  const [, n, who] = matches[0];
  if (!/^\d+$/.test(n)) return { malformed: `the counter "${n}" is not a bare integer` };
  if (who.trim() === '') return { malformed: 'the publisher (data-published-by) is empty' };
  return { n: Number(n), who };
}

export function comparePublishTokens({ working, published, baseline, branch, allowBehind = false }) {
  const errors = [];

  // Fail closed on an unresolvable baseline BEFORE anything else, and by
  // identity. `null` here means "no baseline", not "a baseline with no token";
  // folding the two would let a git failure return green.
  if (baseline === null || baseline === undefined) return [PUBLISH_TOKEN_BASELINE_ERROR];
  if (published === null || published === undefined) return [PUBLISH_TOKEN_BASELINE_ERROR];

  const w = parsePublishToken(working);
  const p = parsePublishToken(published);
  const b = parsePublishToken(baseline);

  for (const [label, parsed] of [['tracked', w], ['published', p], ['origin/main', b]]) {
    if (parsed && parsed.malformed) {
      errors.push(`Publish token (${label}): ${parsed.malformed}. Fix it before publishing.`);
    }
  }
  if (errors.length > 0) return errors;

  // There is deliberately NO bootstrap branch. PR 1 seeds the token as data and
  // PR 2 ships this code, so origin/main always carries one by the time this
  // runs. A branch that cannot be entered can only ever be wrong.
  if (!b) {
    return ['Publish token: origin/main carries none. It should have been seeded before this check shipped — do not publish; investigate.'];
  }
  if (!w) {
    return ['Publish token: the tracked live view has none. Restore it before publishing.'];
  }
  if (!p) {
    return ['Publish token: the published page carries no publish token, but origin/main does. Either the wrong file was published to this URL, or the page was clobbered. Do not publish over it until you know which.'];
  }

  if (p.n < b.n) {
    if (!allowBehind) {
      errors.push(`Publish token: the live page is at ${p.n} but origin/main is at ${b.n} — the page is BEHIND main. A bump merged without publishing, or a publish was reverted. Re-publishing from here is correct, but confirm that first, then re-run with --live-page-behind-main.`);
    }
  } else if (p.n !== b.n && p.who !== branch) {
    errors.push(`Publish token: the live page is at ${p.n}, published by "${p.who}", but origin/main is at ${b.n} — someone else published since your baseline. Rebase, re-read the live page, and re-run. Do not publish.`);
  }
  if (errors.length > 0) return errors;

  const floor = p.who === branch ? Math.max(b.n, p.n) : b.n;
  if (w.n <= floor) {
    errors.push(`Publish token: the tracked live view is at ${w.n}, not ahead of ${floor}. Bump it — an unbumped publish is untracked and the next lane cannot tell it happened.`);
  }
  return errors;
}
```

*(Under the `comment` carrier, change `PUBLISH_TOKEN_REGEX` to
`/<!--\s*published-as:\s*(\S*)\s+by\s+(\S*)\s*-->/g` and nothing else; the
comparator is carrier-agnostic by construction.)*

- [ ] **Step 4: Thread the second baseline through**

`resolveBaselineText` gains `sha` in its return — returning the **frozen
`fetchedSha` string**, not raw stdout. **This is NOT additive: it breaks five
existing assertions** (`:1821`, `:1879`, `:1897`, `:1911`, `:1935` all use
`assert.deepEqual(result, { text, failedStep })`, which fails on an extra own
property under strict mode). The spec said these tests move in the same diff and
it was right. Task 11 Step 1 handles them.

```js
// The live view's baseline, read from the SAME frozen sha as the register's —
// not a second rev-parse, which would reopen the race #2199 round 5 closed.
export function resolveBaselineLiveView(repoRoot, liveViewPath, sha, gitRunner = runGitCommand) {
  if (!sha) return { text: null, failedStep: 'show' };
  const showResult = gitRunner(['show', `${sha}:${liveViewPath}`], repoRoot);
  if (showResult.error || showResult.status !== 0) return { text: null, failedStep: 'show' };
  return { text: showResult.stdout, failedStep: null };
}
```

- [ ] **Step 5: Add the second test seam**

`ONBOX_TEST_BASELINE_FILE` substitutes **only** the register baseline
(`:1252-1267`). Add `ONBOX_TEST_BASELINE_LIVE_VIEW_FILE` with the identical shape
**and the identical unconditional banner print** — a silent bypass here is the
same guard-evaporates-on-substituted-input shape #2199 exists to fix.

**Without this, roughly a dozen existing CLI tests break**: `ONBOX_TEST_BASELINE_FILE`
appears 24 times between `:1976` and `:2616`, and none of those tests sets the
new seam, so each would reach real git for the live-view half. Task 11 Step 4
migrates them.

- [ ] **Step 6: Wire it into the `extraOnly` CLI block**

Read the tracked live view (new in this mode — fact 3), resolve the live-view
baseline from the frozen SHA, pass the current branch
(`git rev-parse --abbrev-ref HEAD`) and `--live-page-behind-main`, run
`comparePublishTokens`, and `report()` its errors alongside the existing
behind-row errors so one run surfaces both. Fold into `publishedFailed`.

- [ ] **Step 7: Document the new failure class in the runbook**

The register's "If it fails" tree (`docs/testing/onbox-acceptance-register.md:129-220`)
gains a publish-token section: what each message means, that a competing publish
is cleared by rebasing, and that a behind-`main` page is cleared by
`--live-page-behind-main` **after confirming the cause**. A guard whose STOP has
no documented clearing procedure is a guard that gets bypassed — which is exactly
why `--discharging` exists (#2272).

- [ ] **Step 8: Run the tests and confirm they pass**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

- [ ] **Step 9: Commit**

```bash
git add scripts/check-onbox-register.mjs scripts/tests/check-onbox-register.test.mjs docs/testing/onbox-acceptance-register.md
git commit -m "feat(scripts): detect a competing publish via an identity-carrying publish token"
```

---

### Task 11: Migrate the existing test suite

**Files:**
- Modify: `scripts/tests/check-onbox-register.test.mjs` (2785 lines, 107 tests)

**Interfaces:**
- Consumes: Tasks 8-10.
- Produces: a green suite.

> **Do not work from a line list.** An earlier draft of this task carried nine
> line references and missed most of the breakage, because the damage runs
> through two *shared fixture builders* rather than through individual tests.
> **Step 1 is to run the suite and let the real failure list drive the work.**

- [ ] **Step 1: Get the actual failure list**

```bash
node --test scripts/tests/check-onbox-register.test.mjs 2>&1 | tee <scratchpad>/failures.txt
```

Expect on the order of **70+ failing tests**, not nine. The four clusters below
are known; treat anything else the run reports as equally in scope.

- [ ] **Step 2: Teach both fixture builders the allocation marker**

This is the bulk of the work and neither builder was in the earlier draft's list.

- **`buildRegister()` (`:43-86`), used 51 times** — emits `## Group A` and
  `## Group B` with no marker, so every call gains two check-4b errors. Hard
  equality assertions that break at once: `:89`, `:99`, `:382`, `:410`, `:440`,
  `:469`, `:723-726`.
- **`buildSingleGroupRegister()` (`:1240-1259`), used 17 times** — same defect,
  but worse: it supplies `baselineText` for every `extraOnly` test, so
  `resolveBaselineGroups` → `checkRegister` → non-empty → **every `#2199` and
  `#2272` scenario collapses to `CANNOT_VERIFY_BASELINE_ERROR`** instead of its
  intended verdict (`:1307`, `:1512`, `:1690` and the surrounding blocks).

Emit a `<!-- next-id: <Letter>101 -->` line per group by default, with an opt-out
parameter so Task 8's missing-marker test can still build a register without one.

- [ ] **Step 3: Fix the five `resolveBaselineText` assertions**

`:1821`, `:1879`, `:1897`, `:1911`, `:1935` are `assert.deepEqual(result, {...})`
and break on the new `sha` property. Add `sha` to each expectation (`null` on the
failure paths) rather than loosening to a property-by-property check — the whole
value of `deepEqual` here is that it catches an unintended extra field.

- [ ] **Step 4: Give every `ONBOX_TEST_BASELINE_FILE` test the live-view seam**

24 occurrences between `:1976` and `:2616`. Each must also set
`ONBOX_TEST_BASELINE_LIVE_VIEW_FILE` and supply a tokened live-view baseline, or
it (a) reaches real git — the exact hermeticity loss the seam exists to prevent —
and (b) fails on `w == b` → "bump it". A shared helper that sets both together is
better than 24 pairs, because the next test to be added will otherwise set only one.

- [ ] **Step 5: Replace the two direct check-4 tests (`:166-190`)**

The duplicate half is now 4a's job (`Row ID A1 appears more than once`); the gap
half (`found A1, A3`) must now **pass**, and Task 8 already added that test.
Delete these two rather than leaving renamed shells.

- [ ] **Step 6: Update the six verbatim message assertions**

`:371`, `:668`, `:676`, `:724`, `:725`, `:761` assert the `:247` string verbatim.
Update each to Task 9's new wording. **Do not soften them to
`includes('not a valid row number')`** — the verbatim assertion is what makes a
message reword visible.

- [ ] **Step 7: Fix the assertion that goes vacuous (`:681`)**

`assert.ok(!errors.some((e) => e.includes('are not contiguous')))` can no longer
fail. Re-point it at what it protected: that a rejected sub-lettered heading
suppresses the other per-group checks for that letter. **Assert on 4b's per-row
message only** — per Task 8, marker-presence and floor are deliberately *not*
suppressed, so asserting their absence would pin the hole this plan just closed.

- [ ] **Step 8: Update the #2199 discharge scenario (`:1225`, `:1289-1294`)**

Its comment says "C3 renumbered to C1". Under stable IDs a discharge leaves a
gap: `C1` and `C2` go, `C3` stays `C3`. Rewrite the fixture and both comments.
**Preserve what the test pins** — that a live-page row `origin/main` also lacks
is a discharge, not a defect.

- [ ] **Step 9: Teach `computeMaxRowNumber` / `buildAheadBaselineText` the floor**

Five real-tree CLI tests (`:2209`, `:2333`, `:2360`, `:2517`, `:2600`) derive
`high-water + 1` as "an ID that does not exist yet". Under 4b it must sit
**strictly below** `next-id`. It does today by a wide margin — assert it anyway:

```js
// When this eventually breaks, the tempting repair is to loosen the fixture,
// and that is exactly how the allocation floor gets quietly weakened.
assert.ok(candidate < nextId, `fixture ID ${letter}${candidate} must be below next-id`);
```

- [ ] **Step 10: Re-run until green**

```bash
npm run test:hooks
```

- [ ] **Step 11: Commit**

```bash
git add scripts/tests/check-onbox-register.test.mjs
git commit -m "test(scripts): migrate the register checker suite onto stable row IDs"
```

---

### Task 12: Stand the citation checker up as a workflow

**Files:**
- Create: `.github/workflows/register-citations-check.yml`
- Create: `scripts/tests/register-citations-workflow.test.mjs`

> **Neither file an earlier draft named actually needs editing, and that would
> have shipped a CI workflow with zero automated coverage.** `verify-cache.mjs:116`
> is the literal glob `'.github/workflows/**'` — a wildcard, so a new workflow
> file is already covered. `workflow-wiring.test.mjs` resolves exactly one path,
> `verify.yml` (`:22`), and contains no workflow enumeration at all. The plan
> inherited "both move in the same diff" from the spec and did not check it.
> Verified: both claims are false. The coverage below is what replaces them.

**Interfaces:**
- Consumes: nothing.
- Produces: an always-run, non-required PR check.

**Why no path filter:** `check-register-citations.mjs`'s own header (`:12-36`)
records that it is invoked from exactly one place — its own CLI tests under
`npm run test:hooks`, scope-gated to `docs/testing/**`, the register, `CLAUDE.md`
and `scripts/**` — so rot in `docs/features/**`, `src/**`, `server/**` or `e2e/**`
is caught only when an in-scope file happens to change too. The checker's inputs
are the **whole tree**, so no path filter can be correct. The header also rules
out widening `test:hooks`' inputs: it reads essentially every tracked file, which
would make the step un-cacheable.

- [ ] **Step 1: Write the workflow**

Model it on `.github/workflows/onbox-register-check.yml` — same runner, same Node
24, same explicit `timeout-minutes: 5`, same `permissions: contents: read` — but
**with the `paths:` block deleted**, and a comment saying why.

- [ ] **Step 2: NOT required — record why, in the workflow file itself**

```yaml
# Deliberately NOT in main's required status checks. This checker's verdict is a
# property of the WHOLE TREE, not of the PR under test: under stable row IDs a
# discharge permanently deletes an ID, so a wave PR that discharges a widely-cited
# row and misses one annotation would turn this red for EVERY open PR in the repo,
# on files none of them touched. Always-run and visible is the right first step;
# promoting it is a separate decision after a few waves — see the follow-up issue.
```

- [ ] **Step 3: Write the workflow's contract test**

Create `scripts/tests/register-citations-workflow.test.mjs` and wire it into
`npm run test:hooks` the way its siblings are.

```js
test('the citation-check workflow exists and runs the checker', () => {
  const yml = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(yml, /check-register-citations/);
});

test('the citation-check workflow has NO paths: filter', () => {
  // The assertion worth having. This checker reads essentially every tracked
  // file, so no path filter can be correct — a filter is the obvious-looking
  // "optimisation" a future reader adds, and it is exactly what makes the
  // workflow useless. Its sibling onbox-register-check.yml IS path-filtered,
  // which is what makes copying that file the likely mistake.
  const yml = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.ok(!/^\s*paths:/m.test(yml), 'a paths: filter defeats a whole-tree checker');
});

test('the citation-check workflow is not claimed as a required check', () => {
  const yml = readFileSync(WORKFLOW_PATH, 'utf8');
  assert.match(yml, /NOT in main's required status checks/i);
});
```

- [ ] **Step 3b: Confirm nothing else needs updating**

```bash
npm run test:hooks
```

Expected: green, with **no** edits to `workflow-wiring.test.mjs` or
`verify-cache.mjs`. If either does go red, that falsifies the note above — read
why before changing anything.

- [ ] **Step 4: Verify and commit**

```bash
npm run test:hooks
git add .github/workflows/register-citations-check.yml scripts/tests/register-citations-workflow.test.mjs package.json
git commit -m "ci(scripts): run the register citation checker on every PR"
```

---

### Task 13: Sweep the renumbering invariant out of the prose

**Files** — the mechanically-generated inventory, all sites confirmed at HEAD:

| File | Lines | What it asserts |
|---|---|---|
| `docs/testing/onbox-acceptance-register.md` | `:110-111`, `:175`, `:187` | the `--against-published` / `--discharging` arithmetic, whose "how the IDs will be spelled" branch is entirely renumbering |
| " | **`:212`** | "a contiguity gap" in the cannot-verify explanation — **named by the spec, dropped by an earlier draft of this plan** |
| " | **`:277-284`** | the symmetric-comparison incident, whose framing assumes positional IDs — same omission |
| " | `:3018` | "Row IDs are positional and renumber on discharge" |
| " | `:3047` | "The cloud row remains (renumbered **C1** …)" |
| " | `:365-366`, `:378`, `:410`, `:473` | **changelog — historical record, DO NOT rewrite** |
| `CLAUDE.md` | `:745` | "discharging a middle row renumbers the survivors, so the ID that vanishes is the group's highest" |
| `scripts/check-register-citations.mjs` | `:5`, `:44-45`, `:362`, `:367`, `:397`, `:407`, `:623`, `:1745` | its stated premise ("deletes it and renumbers every later row in that group") |
| `docs/features/247-dialogue-structure-attribution.md` | `:462` | "positional and contiguous, so they renumber as rows are discharged" |
| `docs/features/278-cast-character-identity.md` | `:594` | "Group B renumbered and today's `B2` is an unrelated #2246 row" — **historical, annotate only** |
| `docs/testing/cast-id-drift-onbox-acceptance.md` | `:14`, `:172` | **historical, annotate only** |
| `docs/testing/` run sheets | `ort-marker-*` (8), `onbox-sitting-plan` (7), `onbox-wave4-results/step-6b` (5), `onbox-wave5-results/*` (10), `onbox-sitting-qa-gate` (2), `onbox-acceptance-staleness-audit` (2), `fs38-wave3-*` (2), `night-watch-*` (1), `onbox-sitting-device-browser` (1), `onbox-wave4-linkage` (1) | mixed — apply the rule below per site |
| `docs/testing/onbox-acceptance-register-live-view.html` | `:1479` | footer: "Group A renumbered" |

**The rule that decides each site — apply it per occurrence, do not bulk-replace:**

- **A statement of the current rule** ("rows renumber contiguously", "the ID that
  vanishes is the group's highest") → **rewrite**. It is now false.
- **A historical record** ("Group A renumbered contiguously (old A35–A38 →
  A34–A37)", a changelog entry, a run sheet's account of what a past wave did)
  → **leave it**, and where it could be mistaken for current guidance, annotate:
  *"(under the pre-#2599 positional-ID rule; IDs are stable from <date>)"*. This
  is the repo's own "annotate, don't renumber" convention, and rewriting history
  here is the same class of error as renumbering a citation.

- [ ] **Step 1: Rewrite the register's own "Live view" procedure**

`:110-111`, `:175`, `:187`, `:212`, `:277-284`. Under stable IDs the
`--discharging` counter-instruction is deleted outright: the ID that vanishes
**is** the row discharged. The flag keeps working unchanged.

**Watch the enclosing structure, not just the sentence.** `:172-173` introduces
**two** shapes, and the renumbering bullet at `:174-183` is one of them —
deleting it collapses "Two shapes" to one, so the lead-in has to move too.
`:184-186`'s Group F example (Task 6) sits inside that same bullet, so the two
edits interact; do Task 6's fix first and re-read the paragraph before cutting.

This step also **adds** the publish-token failure class to the same "If it fails"
tree — Task 10 Step 7 owns the content; this step makes sure it lands in the
right place in a section this task is otherwise rewriting.

- [ ] **Step 2: Rewrite `:3018` and `:3047`**

`:3018` states the positional premise directly. `:3047` records that the cloud
row "was C3 before 2026-08-06 and is referenced under that ID in #1685" — keep
that (it is history and it is the live example of the one surface this design
cannot reach: **GitHub issue bodies are not in `git ls-files`, so no checker
sees them**; stable IDs stop *new* rot there, existing rot stays), and update
only the "renumbered C1 now that" clause's framing.

- [ ] **Step 3: Rewrite `CLAUDE.md:745`**

Delete the clause "and discharging a middle row renumbers the survivors, so the
ID that vanishes is the group's highest, not the row you conceptually removed"
and its `--discharging` mechanics reference. Keep everything else in that step
intact — it is a long sentence carrying several unrelated rules.

- [ ] **Step 4: Correct `check-register-citations.mjs`'s premise**

Its header opens with "deletes it and renumbers every later row in that group",
which is the whole reason the tool exists. Under stable IDs the rationale
changes but does **not** disappear: a discharged ID is now *permanently* gone, so
a citation to it is permanently dangling rather than silently re-pointed. Say
that — the tool is more useful under stable IDs, not less.

- [ ] **Step 5: Sweep the run sheets and the live-view footer**

Apply the current-rule/historical rule above to each site. The live-view footer
at `:1479` is historical ("Last synced … wave 8 … Group A renumbered") — leave
it; it will be replaced naturally at the next sync.

- [ ] **Step 6: Verify both checkers and the suite**

```bash
npm run check:onbox-register
npm run check:register-citations
npm run test:hooks
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "docs(docs): retire the register renumbering invariant from the prose"
```

---

### Task 14: Ship PR 2 and close the tickets

**Files:** none modified.

- [ ] **Step 1: Run the branch battery**

```bash
npm run verify:fast:branch
```

- [ ] **Step 2: If PR 2 touched the live view, bump the token and publish**

Only if the live view changed. Bump `data-published-as` by one, save the live
page, run `npm run check:onbox-register -- --against-published <saved-copy>.html`
— **this is the first real exercise of the token check** — then publish to the
recorded URL.

- [ ] **Step 3: Open the PR**

Body carries `Closes #2599`, `Closes #2603`, `Closes #2629`. Test plan cites the
new tests by name. No on-box row, no release-notes entry — stated explicitly.

- [ ] **Step 4: `pr-review-gate` pass at depth `high`**

Multi-scope (`scripts` + `docs` + `ci`) — the table says `high`.

- [ ] **Step 5: Merge, then write the close comments**

Each records what was **not** delivered, because all three issues asked for
something this design declined:

| Issue | The close comment must say |
|---|---|
| **#2599** | Closed by the publish token, **not** by the row-content diff the issue asked for. Record all three attempted content rules and why each failed, and the token's own boundary: it proves nobody else published since your baseline, **not** that the bytes you are publishing are the bytes you intended (a stale local build of your own file, correctly bumped, still publishes — that is what git review covers). |
| **#2603** | Closed by the workflow, **without** its title-match option and **without** self-reference detection. The latter is structurally impossible in the shipped checker: the register's own path is in `FROZEN_EXACT` (`:386`), so its body is never scanned. Its non-renumbering damage (the "five states vs eight states" drift) is untouched. |
| **#2629** | Closed by stable IDs + the workflow. **Not** its "option 2" (a per-row slug field), which this declines. Stable positional IDs are a fourth option the issue did not offer — say so rather than claiming one it did. |

- [ ] **Step 6: Close #2634 as a duplicate of #2653**

Both were the same finding filed three weeks apart. Its "add a uniqueness check"
instruction is honoured by 4a; say so in the close comment.

- [ ] **Step 7: File the follow-up issue**

Title: `ops-<n> — promote register-citations-check to a required status check`.
Labels `type:chore`, `area:ops`. Body states the decision that is owed: whether a
whole-tree checker should be able to redden every open PR, to be revisited after
a few waves under stable IDs. **A `type:chore` needs no `docs/BACKLOG.md` row**
(it lives on the board's "Bugs & Chores" view), so do not run `backlog:sync`.

- [ ] **Step 8: Update the spec's frontmatter**

`status: draft` → `status: stable`, and fill Ship notes with the two PR numbers
and merge SHAs.

---

## Self-review

**Spec coverage:**

| Spec section | Task(s) |
|---|---|
| §1 stable IDs, `next-id`, floor 101 | 2, 8 |
| §1 check 4 deleted, 4a/4b added | 8 |
| §1 Blocked rows lose IDs (both sides) | 3 |
| §1 residual limitation documented | 9 (step 3), 8 (helper comments) |
| §2 publish token + the six-state table | 10 |
| §2 mechanics (`:1420`/`:1423`, one SHA, second seam) | 10 (steps 4-6) |
| §3 workflow, not required | 12 |
| §4 update-mechanics prose inventory | 13 |
| §4 Group F incidental fix | 6 |
| Delivery: two PRs, retro-application rule | Global constraint 1; 9 (step 5) |
| PR 1's one-line citation hazard | 6 (step 2) |
| Live-view stale callouts | 5 |
| Sequencing against wave 9 | Global constraint 2 |
| Ticket disposition, incl. the new issue | 14 |
| Testing (all eleven bullets) | 8 (5 tests), 10 (11 tests), 11 (migration) |
| Shipping notes (no on-box row, no release notes) | 7 (step 4), 14 (step 3) |

## What the assumption-checker pass changed

The mandatory Premium-tier pass ran against the first draft of this plan and
found a Critical defect plus six lesser ones. All are folded in above; recorded
here so a reader knows which parts were *earned* rather than merely written.

| Finding | Disposition |
|---|---|
| **The bare counter is fatally wrong** — this plan's own test (`{49,48,47}` → `[]`) contradicted its own implementation (`p != b` → error), reproducing verbatim the multi-publish-per-branch failure that killed the third content rule. | **Spec §2 rewritten.** The counter is now the *fourth* recorded rejected design. The token carries `data-published-by`; `who` is what separates my round-two publish from your competing one. Task 10 rebuilt around it. |
| `resolveBaselineText` returning `sha` is **not** additive — `:1821`/`:1879`/`:1897`/`:1911`/`:1935` are `assert.deepEqual` on the whole object. **The spec said these move; the plan overrode it wrongly.** | Task 10 Step 4 now says so explicitly; Task 11 Step 3 fixes them. |
| Task 11 was under-scoped ~10×: `buildRegister` (51 uses) and `buildSingleGroupRegister` (17 uses) both break, the latter collapsing every `#2199`/`#2272` scenario to `CANNOT_VERIFY_BASELINE_ERROR`. | Task 11 rewritten to be **driven by a real test run**, not a line list. |
| A `null` baseline fell into the bootstrap branch and returned **green**. | `PUBLISH_TOKEN_BASELINE_ERROR`, checked first, matched by identity. |
| The bootstrap branch is unreachable — PR 1 seeds the token before PR 2 ships the reader. | **Deleted**, and a test pins that a tokenless page against a tokened baseline is *reported*. |
| Task 12 shipped a workflow with **zero** coverage — `verify-cache.mjs:116` is a glob, `workflow-wiring.test.mjs:22` resolves only `verify.yml`. | Task 12 now creates a contract test; the no-`paths:`-filter assertion is the one worth having. |
| 4b's suppression on `invalidRowHeadingLetterSet` made a *missing* marker unreportable. | Suppression narrowed to the per-row check only. |
| `:481`, `:1362` (Task 9) and `:212`, `:277-284` (Task 13) were dropped — the spec named two of them. | Restored. |
| A behind-`main` live page had a STOP with no clearing procedure. | `--live-page-behind-main`, plus a runbook section (Task 10 Step 7). |
| "Highest ID cited anywhere is `A46`" — false; `A99` is the citation checker's own sentinel. Floor clears by 2, not ~50. | Corrected in both documents. |
| Task 3 Step 2's "siblings carry no `num` span" — false; `:1430` is `<span class="num">—</span>`. | Corrected. |
| Task 5 Step 1 said "delete all six `callout warn` blocks" while keeping one that *is* a `callout warn`. | Re-anchored on opening text, with the trap called out. |
| Task 8's tests used a `registerFixture` helper that does not exist. | Step 1 now creates it. |

**Confirmed correct under the pass, and worth recording as such:** the
`parseAllRowHeadings` regex (all 60 group rows plus both Blocked collisions
matched; `### AMD GPU support Phase 2`, `### A19b`, `### A2.1`, `### Notes`
correctly rejected; CRLF handled); the `next-id` marker's inertness under today's
parsers; the all-time high-water figures; the two-PR ordering against the
retro-application rule; the six-callout count; the Group set `A B C D E G H`; the
`E6`/`E8` collision table; and `:1420`/`:1423`/`:1069`.

**One spec figure this plan corrected before the pass:** the spec said *four*
stale live-view callouts. There are **six**, at `:200-267`, describing
`A44`/`A45`/`A46`/`E10` across counts `65 → 69`. Task 5 uses the verified figure.

**One residual the pass named and the design now owns:** the token's `who` field
is *trusted, not authenticated*. A lane publishing under another branch's name
defeats the check. That is accident-detection, not forgery-detection, and it is
stated in spec §2 as the second boundary rather than left implied.

**Type consistency:** `parseNextIdMarker`, `parseAllRowHeadings`,
`ALLOCATION_FLOOR`, `parsePublishToken`, `comparePublishTokens`,
`resolveBaselineLiveView` are each defined once (Tasks 8, 10) and referenced by
those exact names in Tasks 9, 11, 12. `resolveBaselineText`'s change is additive.

**Placeholder scan:** no TBD/TODO. The one deliberately-unresolved value is
`PUBLISH_TOKEN_CARRIER`, which has an explicit decision procedure, an explicit
default, and an explicit escalation path if neither carrier survives.
