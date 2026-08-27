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

3. **The allocation floor is `101` for every group**, verified against full git
   history of both files (all-time high-waters: `A`=48, `B`=5, `C`=4, `D`=3,
   `E`=11, `F`=1, `G`=2, `H`=2; highest ID cited anywhere in the tree is `A46`).
   Never lower it. If a fixture breaks against it, fix the fixture, not the floor.

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

## Deviation from the spec, decided here

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

to — matching the three sibling rows that already carry no `num` span:

```html
<summary><span class="iname">ops-36 golden-assembly on a second ffmpeg build</span>…
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
<p class="eyebrow" data-published-as="1">Publish token 1 — bump this by one in
  any change that publishes this page. It is how <code>--against-published</code>
  detects that another lane published between your baseline and now.</p>
```

For `comment`, the same value carried as `<!-- published-as: 1 -->` on its own
line, plus the explanatory `<p>` without the attribute.

Start at `1`: this is the bootstrap publish, and the value only has to be
monotonic, not historically meaningful.

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

- [ ] **Step 1: Delete all six `callout warn` blocks at `:200-267`**

These are the blocks beginning `<b>Last change:` and `<b>Prior change:` and
`<b>Before that:`. **Keep** the two evergreen callouts — `:174-180` ("Owed
acceptance never blocks a merge") and `:182-189` ("How this register goes
stale"). Neither carries a count or a row ID.

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
register (constraint 2) — use the file's existing fixture helper if one exists,
otherwise a local template string.

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
    if (invalidRowHeadingLetterSet.has(letter)) continue;
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
- Modify: `scripts/check-onbox-register.mjs:44-49`, `:171-183`, `:247`, `:577-579`,
  `:628-632`, `:811`, `:963-967`, `:1385-1389`

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
- Test: `scripts/tests/check-onbox-register.test.mjs`

**Interfaces:**
- Consumes: Task 1's `PUBLISH_TOKEN_CARRIER`, Task 4's token in the tracked HTML.
- Produces:
  - `parsePublishToken(rawHtml) -> { value: number } | { malformed: string } | null`
  - `comparePublishTokens({ working, published, baseline }) -> string[]`
  - `resolveBaselineText` additionally returns `sha`
  - `resolveBaselineLiveView(repoRoot, liveViewPath, sha, gitRunner) -> { text, failedStep }`
  - env seam `ONBOX_TEST_BASELINE_LIVE_VIEW_FILE`

**Three facts this task must not get wrong:**

1. `checkLiveView`'s **first** action is `stripHtmlComments(rawLiveViewHtml)`
   (`:641`), and that blanking is load-bearing (PR #2080 review round 2). If
   Task 1 chose the `comment` carrier, the token MUST be parsed from
   `rawLiveViewHtml` before that line, and Step 1 below has a dedicated test for
   it. If Task 1 chose `attribute`, this hazard does not apply — which is why
   `attribute` is preferred.
2. `--against-published` **never reads the tracked live-view HTML today**:
   `const liveViewHtml = read(LIVE_VIEW)` sits at `:1423`, *after* that mode's
   `return` at `:1420`. Reading it in `extraOnly` is new.
3. Both baselines must come from **one** commit. `resolveBaselineText` already
   freezes the SHA in a local (`:1069`) after deliberately reading `FETCH_HEAD`
   rather than `origin/main` (#2199 round 3 — a narrowed refspec can leave
   `origin/main` stale while the fetch exits 0). Return that SHA rather than
   re-resolving; a second `rev-parse` reopens the race the freeze closed.

- [ ] **Step 1: Write the failing tests**

```js
const TOKEN = (n) => `<p class="eyebrow" data-published-as="${n}">x</p>`; // Task 1's literal

test('token: ordinary publish — published == baseline, working ahead — is green', () => {
  assert.deepEqual(
    comparePublishTokens({ working: TOKEN(48), published: TOKEN(47), baseline: TOKEN(47) }),
    [],
  );
});

test('token: re-publishing from the same branch is green', () => {
  // The regression test that would have caught all three rejected content rules:
  // baseline 47, this branch already published 48, now publishing 49.
  assert.deepEqual(
    comparePublishTokens({ working: TOKEN(49), published: TOKEN(48), baseline: TOKEN(47) }),
    [],
  );
});

test('token: another lane published first is reported', () => {
  const errors = comparePublishTokens({
    working: TOKEN(48), published: TOKEN(52), baseline: TOKEN(47),
  });
  assert.ok(errors.some((e) => e.includes('published since your baseline')));
});

test('token: a tokenless published page against a tokened baseline is reported', () => {
  const errors = comparePublishTokens({
    working: TOKEN(48), published: '<p>no token here</p>', baseline: TOKEN(47),
  });
  assert.ok(errors.some((e) => e.includes('no publish token')));
});

test('token: an unbumped working file is reported', () => {
  const errors = comparePublishTokens({
    working: TOKEN(47), published: TOKEN(47), baseline: TOKEN(47),
  });
  assert.ok(errors.some((e) => e.includes('bump')));
});

test('token: bootstrap — baseline and published both tokenless — passes on working alone', () => {
  assert.deepEqual(
    comparePublishTokens({ working: TOKEN(1), published: '<p>x</p>', baseline: '<p>x</p>' }),
    [],
  );
});

test('token: bootstrap is unreachable once the baseline carries a token', () => {
  // Pins the bootstrap as self-limiting — it must not silently re-arm.
  const errors = comparePublishTokens({
    working: TOKEN(2), published: '<p>x</p>', baseline: TOKEN(1),
  });
  assert.ok(errors.length > 0, 'a tokenless page against a tokened baseline must not bootstrap');
});

test('token: a tokened published page against a tokenless baseline is reported', () => {
  const errors = comparePublishTokens({
    working: TOKEN(1), published: TOKEN(9), baseline: '<p>x</p>',
  });
  assert.ok(errors.length > 0);
});

test('token: a non-integer token is an error, not a skip', () => {
  const errors = comparePublishTokens({
    working: '<p data-published-as="abc">x</p>', published: TOKEN(1), baseline: TOKEN(1),
  });
  assert.ok(errors.some((e) => e.includes('not a bare integer')));
});

test('token: two tokens in one file is an error, not a first-match win', () => {
  const errors = comparePublishTokens({
    working: TOKEN(2) + TOKEN(3), published: TOKEN(1), baseline: TOKEN(1),
  });
  assert.ok(errors.some((e) => e.includes('more than once')));
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
  // Regression pin for the ordering hazard: checkLiveView blanks comments as its
  // FIRST action, so the token must be read off the raw html before that.
  const raw = '<!-- published-as: 5 -->\n<p>body</p>';
  assert.equal(parsePublishToken(raw).value, 5);
  assert.equal(parsePublishToken(stripHtmlComments(raw)), null);
});
```

- [ ] **Step 2: Run and confirm they fail**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

Expected: all fail with "comparePublishTokens is not defined" / "not exported".

- [ ] **Step 3: Implement the parser and the comparator**

```js
// The publish token. See docs/superpowers/specs/2026-08-27-onbox-register-
// stable-row-ids-design.md §2 for why content comparison was abandoned: three
// per-row rules were designed and all three failed, because `working != baseline`
// means "edited OR stale" and no amount of rule-shaping separates those without
// per-branch publish state. This compares a monotonic integer instead, which
// answers the only question that matters — did someone publish between my
// baseline and now — exactly.
const PUBLISH_TOKEN_REGEX = /data-published-as="([^"]*)"/g;

export function parsePublishToken(rawHtml) {
  if (typeof rawHtml !== 'string') return null;
  const matches = [...rawHtml.matchAll(PUBLISH_TOKEN_REGEX)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { malformed: `the publish token appears more than once (${matches.length} times)` };
  }
  const raw = matches[0][1];
  if (!/^\d+$/.test(raw)) {
    return { malformed: `the publish token "${raw}" is not a bare integer` };
  }
  return { value: Number(raw) };
}

export function comparePublishTokens({ working, published, baseline }) {
  const errors = [];
  const w = parsePublishToken(working);
  const p = parsePublishToken(published);
  const b = parsePublishToken(baseline);

  for (const [label, parsed] of [['tracked', w], ['published', p], ['origin/main', b]]) {
    if (parsed && parsed.malformed) {
      errors.push(`Publish token (${label}): ${parsed.malformed}. Fix it before publishing.`);
    }
  }
  if (errors.length > 0) return errors;

  // Bootstrap: the first change to carry a token publishes to a page that has
  // none. Written as an explicit case rather than a fallthrough so it cannot
  // silently re-arm once `origin/main` carries a token.
  if (!b && !p) {
    if (!w) {
      errors.push('Publish token: the tracked live view has none. Add one before publishing.');
    }
    return errors;
  }
  if (!w) {
    errors.push('Publish token: the tracked live view has none, but origin/main or the published page does. Do not publish until it is restored.');
    return errors;
  }
  if (!b && p) {
    errors.push('Publish token: a token-bearing page is already live but origin/main has none. Another lane published a token first — rebase and re-read the live page.');
    return errors;
  }
  if (!p) {
    errors.push('Publish token: the published page carries no publish token, but origin/main does. Either the wrong file was published to this URL, or the page was clobbered. Do not publish over it until you know which.');
    return errors;
  }
  if (p.value !== b.value) {
    errors.push(`Publish token: the live page is at ${p.value} but origin/main is at ${b.value} — someone published since your baseline. Rebase, re-read the live page, and re-run this check. Do not publish.`);
    return errors;
  }
  if (w.value <= b.value) {
    errors.push(`Publish token: the tracked live view is at ${w.value}, not ahead of origin/main's ${b.value}. Bump it — an unbumped publish is untracked and the next lane cannot tell it happened.`);
  }
  return errors;
}
```

*(If Task 1 chose the `comment` carrier, change `PUBLISH_TOKEN_REGEX` to
`/<!--\s*published-as:\s*([^\s-]*)\s*-->/g` and nothing else; the comparator is
carrier-agnostic by construction.)*

- [ ] **Step 4: Thread the second baseline through**

`resolveBaselineText` gains `sha` in its return (**additive** — the seven
existing tests assert on `text`/`failedStep` and keep passing). Add alongside it:

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
(`:1252-1267`), and its own comment warns that a CLI test deriving its verdict
from live git state is a latent bug. Add `ONBOX_TEST_BASELINE_LIVE_VIEW_FILE`
with the identical shape **and the identical unconditional banner print** — a
silent bypass here is the same guard-evaporates-on-substituted-input shape #2199
exists to fix. Without it, every hermetic `--against-published` test silently
reaches real git for the HTML half.

- [ ] **Step 6: Wire it into the `extraOnly` CLI block**

Read the tracked live view (new in this mode — see fact 2 above), resolve the
live-view baseline, run `comparePublishTokens`, and `report()` its errors
alongside the existing behind-row errors so one run surfaces both. Fold the
result into `publishedFailed`.

- [ ] **Step 7: Run the tests and confirm they pass**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

- [ ] **Step 8: Commit**

```bash
git add scripts/check-onbox-register.mjs scripts/tests/check-onbox-register.test.mjs
git commit -m "feat(scripts): detect a competing publish via a publish-token compare-and-swap"
```

---

### Task 11: Migrate the tests that encode contiguity

**Files:**
- Modify: `scripts/tests/check-onbox-register.test.mjs:166-190`, `:371`, `:668-681`,
  `:724-725`, `:761`, `:1225`, `:1289-1294`, `:2058-2071`, `:2102`

**Interfaces:**
- Consumes: Tasks 8-10.
- Produces: a green suite.

- [ ] **Step 1: Replace the two direct check-4 tests (`:166-190`)**

`'check 4: non-contiguous row numbers (a duplicate) are reported independently
of check 1'` asserts `'Group A row numbers are not contiguous from 1: found A1,
A1'`. The duplicate half is now 4a's job (`Row ID A1 appears more than once`);
the gap half (`found A1, A3`) must now **pass**. Task 8 already added the
passing gap test — delete these two rather than leaving a renamed shell.

- [ ] **Step 2: Update the six verbatim message assertions**

`:371`, `:668`, `:676`, `:724`, `:725`, `:761` all assert the `:247` string
verbatim. Update each to Task 9's new wording. **Do not soften them to
`includes('not a valid row number')`** — the verbatim assertion is what makes a
message reword visible, and this suite already relies on that property.

- [ ] **Step 3: Fix the assertion that goes vacuous (`:681`)**

`assert.ok(!errors.some((e) => e.includes('are not contiguous')))` can no longer
fail, since nothing emits that string. Re-point it at what it was actually
protecting: that a rejected sub-lettered heading suppresses the *other*
per-group checks for that letter, which is now 4b — assert no `is at or above`
or `has no "<!-- next-id:` error for that letter.

- [ ] **Step 4: Update the #2199 discharge-and-renumber scenario (`:1289-1294`)**

Its comment says "C3 renumbered to C1". Under stable IDs a discharge leaves a
gap: `C1` and `C2` are discharged, `C3` stays `C3`. Rewrite the fixture and the
comment. **This test's value is unchanged and must be preserved** — it pins that
a live-page row `origin/main` also lacks is a discharge, not a defect.

- [ ] **Step 5: Teach `computeMaxRowNumber` / `buildAheadBaselineText` the floor**

Five real-tree CLI tests (`:2209`, `:2333`, `:2360`, `:2517`, `:2600`) derive
`high-water + 1` as "an ID that does not exist yet" and append it to a baseline
that must pass `checkRegister`. Under 4b that ID must sit **strictly below**
`next-id`. With rows at `A1`…`A37` and the floor at `A101`, `high-water + 1`
already satisfies it — **but make the helper say so deliberately**, with a
comment and an assertion that the derived number is below the group's marker:

```js
// Must stay strictly below the group's next-id marker (check 4b). It does today
// by a wide margin, but assert it rather than relying on the margin: when this
// eventually breaks, the tempting repair is to loosen the fixture, and that is
// exactly how the allocation floor gets quietly weakened.
assert.ok(candidate < nextId, `fixture ID ${letter}${candidate} must be below next-id`);
```

The fixture register these helpers build must itself carry `next-id` markers, or
every one of the five tests fails on "has no allocation marker".

- [ ] **Step 6: Run the whole suite**

```bash
npm run test:hooks
```

Expected: all green.

- [ ] **Step 7: Commit**

```bash
git add scripts/tests/check-onbox-register.test.mjs
git commit -m "test(scripts): migrate register checker tests off the contiguity invariant"
```

---

### Task 12: Stand the citation checker up as a workflow

**Files:**
- Create: `.github/workflows/register-citations-check.yml`
- Modify: `scripts/tests/workflow-wiring.test.mjs`, `scripts/verify-cache.mjs:116`

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

- [ ] **Step 3: Update the two files that enumerate workflows**

`scripts/tests/workflow-wiring.test.mjs` and `verify-cache.mjs`'s
`.github/workflows/**` glob (`:116`). Run `npm run test:hooks` to find out which
assertions move — do not guess.

- [ ] **Step 4: Verify and commit**

```bash
npm run test:hooks
git add .github/workflows/register-citations-check.yml scripts/tests/workflow-wiring.test.mjs scripts/verify-cache.mjs
git commit -m "ci(scripts): run the register citation checker on every PR"
```

---

### Task 13: Sweep the renumbering invariant out of the prose

**Files** — the mechanically-generated inventory, all sites confirmed at HEAD:

| File | Lines | What it asserts |
|---|---|---|
| `docs/testing/onbox-acceptance-register.md` | `:110-111`, `:175`, `:187` | the `--against-published` / `--discharging` arithmetic, whose "how the IDs will be spelled" branch is entirely renumbering |
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

`:110-111`, `:175`, `:187`. Under stable IDs the `--discharging`
counter-instruction is deleted outright: the ID that vanishes **is** the row
discharged. The flag keeps working unchanged.

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

**One spec claim this plan corrects:** the spec says the token is an HTML
comment. `stripHtmlComments` at `:641` blanks comments as `checkLiveView`'s first
action, and the round trip through the artifact platform is unverified — so the
carrier is settled empirically in Task 1, with `data-published-as` as the
recommended default. See "Deviation from the spec, decided here".

**One spec figure this plan corrects:** the spec says *four* stale live-view
callouts describing `A41`/`A44`/`A45`/`A46`. There are **six**, at `:200-267`,
describing `A44`/`A45`/`A46` and `E10` across counts `65 → 69`. Task 5 uses the
verified figure.

**Type consistency:** `parseNextIdMarker`, `parseAllRowHeadings`,
`ALLOCATION_FLOOR`, `parsePublishToken`, `comparePublishTokens`,
`resolveBaselineLiveView` are each defined once (Tasks 8, 10) and referenced by
those exact names in Tasks 9, 11, 12. `resolveBaselineText`'s change is additive.

**Placeholder scan:** no TBD/TODO. The one deliberately-unresolved value is
`PUBLISH_TOKEN_CARRIER`, which has an explicit decision procedure, an explicit
default, and an explicit escalation path if neither carrier survives.
