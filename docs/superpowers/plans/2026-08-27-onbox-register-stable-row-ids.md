# On-box register: stable row IDs + publish-token compare-and-swap — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the on-box acceptance register renumbering its row IDs on every discharge, and make `--against-published` able to detect that another lane published between your baseline and now.

**Architecture:** Row IDs become allocate-once/never-reuse: existing rows keep their IDs, each group gains a `next-id` allocation marker with a floor of `101`, the contiguity check that *forced* renumbering is deleted, and uniqueness + allocation-floor checks replace it. Separately, `--against-published` stops trying to diff row content and instead carries a publish token — a counter for ordering, plus a **per-publish nonce whose presence in git history** decides whether the live page came out of your branch. Five designs were rejected on the way here (three content rules, a bare counter, and a branch name as identity); §2 of the spec records each and why it failed, and **none of them should be re-proposed**. Delivered as **two PRs**, data before guards, because of the retro-application rule in "Global Constraints".

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
   `G`=2, `H`=2 (independently recomputed and confirmed). Real rows top out at
   `A48`, but **`A99` is occupied** — the citation checker's own sentinel for a
   definitely-nonexistent ID (`check-register-citations.mjs:733`, `:759`, `:785`,
   plus **65** occurrences in its tests; an earlier draft said sixteen), and it
   uses the `row <ID>` idiom. **The argument is about the sequence, not the
   maximum:** allocation counts upward, so a floor near 50 would clear every real
   row today and still eventually pass through 99. Never lower it. If a fixture
   breaks against it, fix the fixture, not the floor.

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

**It must carry the exact pair the parser matches, not an approximation.**
`PUBLISH_TOKEN_REGEX` (Task 10) requires the two attributes **adjacent, in that
order, double-quoted, separated only by whitespace**. A probe carrying a single
attribute cannot detect the failure that actually matters — an artifact pipeline
that reorders attributes, interposes one, or rewrites quoting — and a probe that
misses it is the instrument-that-cannot-fail trap this task exists to avoid.

```html
<title>Token Carrier Probe</title>
<!-- published-as: 1 publish-id: k7f2a9 -->
<p data-published-as="1" data-publish-id="k7f2a9">Carrier probe. Both a comment
token and an attribute-pair token are present in the source of this page.</p>
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
# Match what the PARSER matches — the adjacent pair — not just one attribute.
grep -cE 'data-published-as="1"[[:space:]]+data-publish-id="k7f2a9"' <saved-copy>.html
grep -c 'published-as: 1 publish-id: k7f2a9' <saved-copy>.html
# Diagnostic when the pair check fails but the page clearly published:
grep -o 'data-publish[^>]*' <saved-copy>.html
```

The third command is the one that tells you *why*: if both attributes are present
but reordered or re-quoted, the carrier survives and the **regex** is what needs
changing — a different outcome from "the platform stripped it", and the two must
not be confused.

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
<p class="eyebrow" data-published-as="1" data-publish-id="q4m8xt">
  Publish token — in any change that publishes this page, bump the number by one
  <em>and</em> replace the id with a fresh random value. The number orders
  publishes; the id is what <code>--against-published</code> searches this file's
  git history for, to tell a publish that came out of your branch from one that
  did not.</p>
```

**Both fields, always, and the id must be NEW each time.** A bare counter cannot
distinguish your own round-two publish from a competing lane's — both land on the
same number (rejected design 4). A reused id defeats the ancestry lookup the same
way. Mint it however you like; six random alphanumerics is plenty.

**Do not restate the attribute pair anywhere else in this file.** The parser's
regex is unanchored, so a second literal occurrence — in the prose above, in a
callout, in the runbook — trips "appears more than once". The wording above
deliberately names the fields without spelling the pair.

Start the counter at `1`. For the `comment` carrier, the same two fields as
`<!-- published-as: 1 publish-id: q4m8xt -->`, plus the explanatory `<p>` without
the attributes.

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
// A99 is the citation checker's own nonexistent-ID sentinel, and allocation
// counts UPWARD, so a floor near 50 would eventually pass through it. Never
// lower this — if a fixture breaks
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

### Task 10: Publish-nonce ancestry check in `--against-published`

**Files:**
- Modify: `scripts/check-onbox-register.mjs` — `resolveBaselineText` (`:1060-1075`),
  `checkLiveView` (`:633+`), the CLI's `extraOnly` block (`:1268-1420`)
- Modify: `docs/testing/onbox-acceptance-register.md` — the "If it fails" tree
- Test: `scripts/tests/check-onbox-register.test.mjs`

**Interfaces:**
- Consumes: Task 1's `PUBLISH_TOKEN_CARRIER`, Task 4's two-field token.
- Produces:
  - `parsePublishToken(rawHtml) -> { n: number, nonce: string } | { malformed: string } | null`
  - `comparePublishTokens({ working, published, baseline, isAncestor, allowBehind }) -> string[]`
  - `PUBLISH_TOKEN_BASELINE_ERROR`, `PUBLISH_TOKEN_PUBLISHED_ERROR` (exported, matched by identity)
  - `nonceInHistory(repoRoot, liveViewPath, nonce, gitRunner) -> boolean | null`
  - `resolveBaselineText` additionally returns `sha`
  - `resolveBaselineLiveView(repoRoot, liveViewPath, sha, gitRunner) -> { text, failedStep }`
  - env seam `ONBOX_TEST_BASELINE_LIVE_VIEW_FILE`
  - CLI flag `--live-page-behind-main`

**Six facts this task must not get wrong:**

1. **Identity is a nonce looked up in git history, not a branch name.** Two
   earlier designs died here: a bare counter (cannot tell your re-publish from a
   competing lane's — same number), then a branch name (inherited by default,
   mutated by the rename CLAUDE.md mandates, degenerate under detached HEAD).
   **Never compare a publisher name.** `git log -S '<nonce>' -- <live view>`
   answers the real question, and the nonce must be per-publish random — the
   *counter* cannot be searched for, because two lanes both bumping `47 → 48`
   each find their own commit.
2. **`working.n < baseline.n` and `working.n == baseline.n` are different
   failures.** The first is "your branch predates `main` — rebase"; the second is
   "bump the counter". Collapsing them into "bump it" is the second Critical this
   design produced: bumping past a merged competing lane's counter turns the check
   green over an un-rebased file, and the row check does not backstop a changed
   summary strip, callout or footer.
3. `checkLiveView`'s **first** action is `stripHtmlComments(rawLiveViewHtml)`
   (`:641`), and that blanking is load-bearing (PR #2080 review round 2). Under
   the `comment` carrier the token MUST be read off `rawLiveViewHtml` before that
   line. Under `attribute` the hazard does not exist.
4. `--against-published` **never reads the tracked live-view HTML today**:
   `read(LIVE_VIEW)` sits at `:1423`, *after* that mode's `return` at `:1420`.
5. Both baselines must come from **one** commit — return the frozen `fetchedSha`
   string from `:1069`; a second `rev-parse` reopens the race #2199 round 5 closed.
6. **`null` is never "tokenless".** An unresolvable *baseline* and an unresolvable
   *published page* get **two different** fail-closed constants: one is
   `origin/main`, the other is the operator's local save, and the operator does
   different things about them.

- [ ] **Step 1: Write the failing tests**

```js
const T = (n, nonce) => `<p data-published-as="${n}" data-publish-id="${nonce}">x</p>`;
// isAncestor models the git lookup: true = this nonce is in HEAD's history.
const cmp = (o) => comparePublishTokens({ isAncestor: true, ...o });

test('token: the ordinary first publish is green', () => {
  assert.deepEqual(cmp({ working: T(48, 'aaa'), published: T(47, 'zzz'), baseline: T(47, 'zzz') }), []);
});

test('token: a re-publish from the same branch is green', () => {
  // THE test that kills a bare counter: baseline 47, this branch already
  // published 48, now publishing 49. Multi-publish-per-branch is this register's
  // normal review cycle (PR #2578 published across rounds 13-21).
  assert.deepEqual(cmp({ working: T(49, 'bbb'), published: T(48, 'aaa'), baseline: T(47, 'zzz') }), []);
});

test('token: a competing publish with IDENTICAL counters is reported', () => {
  // Byte-identical numbers to the test above; only ancestry differs. If these two
  // ever agree, the nonce is being ignored and this is a bare counter again.
  const errors = cmp({ working: T(49, 'bbb'), published: T(48, 'ccc'), baseline: T(47, 'zzz'), isAncestor: false });
  assert.ok(errors.some((e) => e.includes('another lane published')));
});

test('token: an UN-REBASED branch is told to rebase, NOT to bump', () => {
  // The second Critical. baseline 48 (lane Z merged), published 48 (Z's page),
  // working 48 (branched at 47). The old advice was "bump it" -- and bumping to
  // 49 turned the check GREEN over an un-rebased file, silently discarding Z's
  // summary strip, callouts and footer. Assert on the MESSAGE: the verdict was
  // never the bug, the remedy was.
  const errors = cmp({ working: T(48, 'bbb'), published: T(48, 'zzz'), baseline: T(49, 'zzz') });
  assert.ok(errors.some((e) => e.includes('rebase')), 'must say rebase');
  assert.ok(!errors.some((e) => e.includes('Bump')), 'must NOT say bump');
});

test('token: an unbumped working file is told to bump', () => {
  const errors = cmp({ working: T(47, 'zzz'), published: T(47, 'zzz'), baseline: T(47, 'zzz') });
  assert.ok(errors.some((e) => e.includes('Bump')));
});

test('token: a live page BEHIND main is reported with its own message', () => {
  const errors = cmp({ working: T(49, 'bbb'), published: T(46, 'yyy'), baseline: T(47, 'zzz') });
  assert.ok(errors.some((e) => e.includes('behind')), 'must not reuse the competing-lane message');
});

test('token: --live-page-behind-main clears ONLY the behind state', () => {
  assert.deepEqual(
    cmp({ working: T(49, 'bbb'), published: T(46, 'yyy'), baseline: T(47, 'zzz'), allowBehind: true }),
    [],
  );
});

test('token: --live-page-behind-main is an ERROR when the page is not behind', () => {
  // The blanket-mute guard, mirroring --discharging's unconsumed-name refusal
  // (:953-971). The counter design's version of this test could not fail: with
  // published > baseline the flag was never read on that path, so the assertion
  // passed by construction whatever the flag did.
  const errors = cmp({ working: T(49, 'bbb'), published: T(48, 'zzz'), baseline: T(48, 'zzz'), allowBehind: true });
  assert.ok(errors.some((e) => e.includes('--live-page-behind-main')),
    'passing the flag in a state it cannot apply to must be refused, not ignored');
});

test('token: a tokenless published page against a tokened baseline is reported', () => {
  const errors = cmp({ working: T(48, 'bbb'), published: '<p>no token</p>', baseline: T(47, 'zzz') });
  assert.ok(errors.some((e) => e.includes('no publish token')));
});

test('token: a tokenless BASELINE is an explicit error, never a pass', () => {
  const errors = cmp({ working: T(48, 'bbb'), published: T(47, 'zzz'), baseline: '<p>no token</p>' });
  assert.ok(errors.length > 0, 'the branch is written, and it does not return green');
});

test('token: baseline and published unresolvable get DIFFERENT constants', () => {
  assert.deepEqual(cmp({ working: T(48, 'b'), published: T(47, 'z'), baseline: null }),
    [PUBLISH_TOKEN_BASELINE_ERROR]);
  assert.deepEqual(cmp({ working: T(48, 'b'), published: null, baseline: T(47, 'z') }),
    [PUBLISH_TOKEN_PUBLISHED_ERROR]);
  assert.notEqual(PUBLISH_TOKEN_BASELINE_ERROR, PUBLISH_TOKEN_PUBLISHED_ERROR);
});

test('token: an unresolvable ancestry lookup fails closed', () => {
  // nonceInHistory returns null when git itself failed. null is not "false".
  const errors = cmp({ working: T(49, 'b'), published: T(48, 'a'), baseline: T(47, 'z'), isAncestor: null });
  assert.ok(errors.length > 0, 'a failed lookup must not read as "in history"');
});

test('token: a non-integer counter, an empty nonce, and two tokens are each errors', () => {
  const bad = (w) => cmp({ working: w, published: T(1, 'z'), baseline: T(1, 'z') });
  assert.ok(bad(`<p data-published-as="abc" data-publish-id="a">x</p>`).some((e) => e.includes('not a bare integer')));
  assert.ok(bad(T(2, '')).some((e) => e.includes('nonce')));
  assert.ok(bad(T(2, 'a') + T(3, 'b')).some((e) => e.includes('more than once')));
});

test('nonceInHistory routes through runGitCommand, not a raw spawn', () => {
  // scrubGitEnv() (#2216) and the timeout live in that wrapper; bypassing it
  // reopens the inherited-GIT_DIR hole its comment exists to close.
  const calls = [];
  const runner = (args) => { calls.push(args.join(' ')); return { status: 0, stdout: 'commit abc\n' }; };
  assert.equal(nonceInHistory('/repo', 'live.html', 'k7f2a9', runner), true);
  assert.ok(calls.some((c) => c.includes('log') && c.includes('k7f2a9') && c.includes('live.html')));
});

test('nonceInHistory returns null on a git failure, not false', () => {
  const runner = () => ({ status: 128, stdout: '', error: new Error('boom') });
  assert.equal(nonceInHistory('/repo', 'live.html', 'k7f2a9', runner), null);
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

If Task 1 chose the `comment` carrier, add the `stripHtmlComments`-ordering pin
from Task 1's decision note.

- [ ] **Step 2: Run and confirm they fail**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

**Confirm the re-publish test and the competing-publish test fail for different
reasons once the code exists.** They differ only in `isAncestor`; if they ever
agree, ancestry is being ignored.

- [ ] **Step 3: Implement the parser, the lookup and the comparator**

```js
// The publish token. See the design spec §2: FIVE designs were rejected before
// this one -- three per-row content rules, a bare monotonic counter, and a
// branch name as identity. The counter failed because a same-branch re-publish
// and a competing publish occupy the same interval and are the same number. The
// branch name failed because it is inherited by default, mutated by the rename
// CLAUDE.md mandates, and degenerate under detached HEAD. Identity is therefore
// a per-publish nonce LOOKED UP in git history, never a name compared as a
// string. Do not "simplify" this back to comparing a publisher.
const PUBLISH_TOKEN_REGEX = /data-published-as="([^"]*)"\s+data-publish-id="([^"]*)"/g;

export const PUBLISH_TOKEN_BASELINE_ERROR =
  'Cannot verify the publish token: origin/main\'s live view is unavailable or ' +
  'unreadable. Do not publish until this passes.';

// Deliberately distinct from the baseline constant. This one is the operator's
// own locally-saved copy of the live page, and the remedy is "re-save it", not
// "fix git". Both are matched by identity, so they must not share a value.
export const PUBLISH_TOKEN_PUBLISHED_ERROR =
  'Cannot verify the publish token: the saved copy of the published page could ' +
  'not be read. Re-save it from the artifact URL and re-run.';

export function parsePublishToken(rawHtml) {
  if (typeof rawHtml !== 'string') return null;
  const matches = [...rawHtml.matchAll(PUBLISH_TOKEN_REGEX)];
  if (matches.length === 0) return null;
  if (matches.length > 1) {
    return { malformed: `the publish token appears more than once (${matches.length} times)` };
  }
  const [, n, nonce] = matches[0];
  if (!/^\d+$/.test(n)) return { malformed: `the counter "${n}" is not a bare integer` };
  if (nonce.trim() === '') return { malformed: 'the nonce (data-publish-id) is empty' };
  return { n: Number(n), nonce };
}

// true = this nonce appears somewhere in HEAD's history for that path (your own
// publish, or one already merged into your baseline). false = it does not.
// null = the lookup itself failed, which is NOT the same as false and must not
// be read as one.
export function nonceInHistory(repoRoot, liveViewPath, nonce, gitRunner = runGitCommand) {
  const result = gitRunner(['log', '--oneline', '-S', nonce, '--', liveViewPath], repoRoot);
  if (result.error || result.status !== 0) return null;
  return result.stdout.trim() !== '';
}

export function comparePublishTokens({ working, published, baseline, isAncestor, allowBehind = false }) {
  // Fail closed FIRST, by identity, and with the two copies distinguished.
  if (baseline === null || baseline === undefined) return [PUBLISH_TOKEN_BASELINE_ERROR];
  if (published === null || published === undefined) return [PUBLISH_TOKEN_PUBLISHED_ERROR];

  const w = parsePublishToken(working);
  const p = parsePublishToken(published);
  const b = parsePublishToken(baseline);

  const errors = [];
  for (const [label, parsed] of [['tracked', w], ['published', p], ['origin/main', b]]) {
    if (parsed && parsed.malformed) {
      errors.push(`Publish token (${label}): ${parsed.malformed}. Fix it before publishing.`);
    }
  }
  if (errors.length > 0) return errors;

  // Written, and never green. PR 1 seeds the token before PR 2 ships this code,
  // so a tokenless baseline means a revert, a deleted line, or PRs merged out of
  // order -- all defects, none a first run.
  if (!b) return ['Publish token: origin/main carries none. It was seeded before this check shipped, so this is a revert or a deletion — do not publish; investigate.'];
  if (!w) return ['Publish token: the tracked live view has none. Restore it before publishing.'];
  if (!p) return ['Publish token: the published page carries no publish token, but origin/main does. Either the wrong file was published to this URL, or the page was clobbered. Do not publish over it until you know which.'];

  // Ancestry decides identity, and runs BEFORE any counter comparison so the
  // diagnosis is right even when the numbers happen to agree.
  if (isAncestor === null || isAncestor === undefined) {
    return ['Publish token: could not search history for the published page\'s nonce. Do not publish until this passes.'];
  }
  if (!isAncestor) {
    return [`Publish token: the live page's nonce "${p.nonce}" is not in this branch's history — another lane published since your baseline. Rebase, re-read the live page, and re-run. Do not publish.`];
  }

  // The escape hatch refuses when it cannot apply, mirroring --discharging's
  // unconsumed-name refusal (:953-971): a flag that is inert-but-accepted in
  // every other state is one copied runbook line away from a blanket mute.
  const behind = p.n < b.n;
  if (allowBehind && !behind) {
    return [`Publish token: --live-page-behind-main was passed, but the live page (${p.n}) is not behind origin/main (${b.n}). Remove the flag.`];
  }
  if (behind && !allowBehind) {
    return [`Publish token: the live page is at ${p.n} but origin/main is at ${b.n} — the page is BEHIND main. A bump merged without publishing, or a publish was reverted. Confirm which, then re-run with --live-page-behind-main.`];
  }

  // These two are DIFFERENT failures with opposite remedies. Collapsing them
  // into "bump it" is what turned an un-rebased publish green over a competing
  // lane's page.
  if (w.n < b.n) {
    errors.push(`Publish token: the tracked live view is at ${w.n} but origin/main is at ${b.n} — your branch predates main. REBASE; do not bump. Publishing from here would overwrite whatever landed in between.`);
  } else if (w.n === b.n) {
    errors.push(`Publish token: the tracked live view is at ${w.n}, the same as origin/main. Bump the counter and mint a new nonce — an unbumped publish is untracked.`);
  } else if (p.nonce !== b.nonce && w.n <= p.n) {
    errors.push(`Publish token: the tracked live view is at ${w.n}, not ahead of your own last publish (${p.n}). Bump the counter and mint a new nonce.`);
  }
  return errors;
}
```

*(Under the `comment` carrier, change `PUBLISH_TOKEN_REGEX` only; everything else
is carrier-agnostic.)*

**Do not document the token by example in the live view itself.** The regex is
unanchored, so a literal attribute pair inside Task 5's replacement callout or
Task 10 Step 7's runbook prose would trip "appears more than once". Describe the
fields in words, or break the pair across markup.

- [ ] **Step 4: Thread the second baseline through**

`resolveBaselineText` gains `sha`, returning the **frozen `fetchedSha` string**.
**This is NOT additive: it breaks five existing assertions** (`:1821`, `:1879`,
`:1897`, `:1911`, `:1935` are `assert.deepEqual(result, { text, failedStep })`,
which fails on an extra own property). The spec said these move in the same diff
and it was right; Task 11 Step 3 handles them.

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

- [ ] **Step 5: Add the second test seam, and give the override path a SHA**

Add `ONBOX_TEST_BASELINE_LIVE_VIEW_FILE` mirroring `ONBOX_TEST_BASELINE_FILE`
(`:1252-1267`), **including its unconditional banner print** — a silent bypass is
the same guard-evaporates-on-substituted-input shape #2199 exists to fix.

**The override path currently produces no SHA.** The CLI's override branch
(`:1291-1306`) builds `baseline` directly and never calls `resolveBaselineText`,
so there is nothing to hand `resolveBaselineLiveView`, and `if (!sha)` would fail
every overridden test closed. Decide explicitly how the override supplies its
live-view baseline — read it straight from the new env var, bypassing
`resolveBaselineLiveView` entirely — and say so here rather than leaving the
implementer to discover it.

- [ ] **Step 6: Wire it into the `extraOnly` CLI block**

Read the tracked live view (new in this mode — fact 4), resolve the live-view
baseline from the frozen SHA, call `nonceInHistory` **through `runGitCommand`**
for the published page's nonce, pass `--live-page-behind-main`, and `report()`
the result alongside the existing behind-row errors so one run surfaces both.
Fold into `publishedFailed`.

- [ ] **Step 7: Document the new failure class in the runbook**

The register's "If it fails" tree (`docs/testing/onbox-acceptance-register.md:129-220`)
gains a publish-token section covering every message: competing publish (rebase),
not-rebased (rebase, do **not** bump), unbumped (bump and re-nonce), behind-main
(confirm, then the flag), and the two fail-closed constants. A guard whose STOP
has no documented clearing procedure is a guard that gets bypassed — which is why
`--discharging` exists (#2272).

- [ ] **Step 8: Run the tests and confirm they pass**

```bash
node --test scripts/tests/check-onbox-register.test.mjs
```

- [ ] **Step 9: Commit**

```bash
git add scripts/check-onbox-register.mjs scripts/tests/check-onbox-register.test.mjs docs/testing/onbox-acceptance-register.md
git commit -m "feat(scripts): detect a competing publish via a git-verified publish nonce"
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

- **`buildRegister()` (`:43-86`), ~49 call sites** — emits `## Group A` and
  `## Group B` with no marker, so every call gains two check-4b errors. Hard
  equality assertions that break at once: `:89`, `:99`, `:410`, `:440`, `:469`,
  `:723-726`. (`:382` is listed in some drafts but could not be confirmed as a
  bare `deepEqual` — check it, don't assume it.)
- **`buildSingleGroupRegister()` (`:1240-1259`), ~16 call sites** — same defect,
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
`ONBOX_TEST_BASELINE_LIVE_VIEW_FILE` and supply a tokened live-view baseline.

**Expect `PUBLISH_TOKEN_BASELINE_ERROR`, not a git call.** An earlier draft said
these tests would "reach real git" — wrong about the mechanism. The override
branch (`:1291-1306`) never calls `resolveBaselineText`, so no SHA exists, and
Task 10 Step 5's decision is what these tests actually exercise. The migration is
needed either way; the diagnosis in the failure output will not match the earlier
draft's prediction, so trust the run.

A shared helper that sets both env vars together beats 24 pairs — the next test
added will otherwise set only one.

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

Only if the live view changed. **Bump `data-published-as` by one AND mint a fresh
`data-publish-id`** — both, every time. An earlier draft of this step said only
"bump the counter", which is exactly the omission that killed the branch-name
design: a token whose identity half is stale reduces the check to the bare
counter it replaced.

Then save the live page, run
`npm run check:onbox-register -- --against-published <saved-copy>.html` —
**this is the first real exercise of the token check** — and publish to the
recorded URL.

Note the ancestry lookup only finds a nonce that is **committed**. Commit the
bump before running the check, or your own token reads as foreign.

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

## What the assumption-checker passes changed

**Two passes have run. Each killed a design.** Pass 1 killed the bare counter;
pass 2 killed the branch name that replaced it, plus a second Critical of its
own. The mechanism now shipping — a nonce verified against git history — is the
sixth design, and the first that no pass has yet falsified. A third pass is
running against it; **do not treat this section as final until that lands.**

### Pass 2

| Finding | Disposition |
|---|---|
| **Branch name as identity is dead** — inherited by default (so its resting state is the previous lane's name, failing **green**), broken by the branch rename CLAUDE.md *mandates* and by `integration/<date>` branches (failing with an **unclearable** STOP), and degenerate under detached HEAD. | **Replaced by a per-publish nonce looked up via `git log -S`.** Identity is verified against history instead of trusted. Spec §2 rewritten; Task 10 rebuilt. |
| **Critical: an un-rebased branch was told to "bump it", and bumping turned the check GREEN over a competing lane's page.** `baseline 48`, `published 48`, `working 48` → no guard fired → bump to 49 → pass. The row check does not backstop a changed summary strip, callout or footer — the exact class the token exists to protect. #1931's incident, reproduced by obeying the remedy. | `working.n < baseline.n` now says **rebase**, `== baseline.n` says **bump**, and the ancestry check runs first so the diagnosis is right even when counters agree. Test asserts on the *message*. |
| `--live-page-behind-main` was a silent no-op in every other state — one copied runbook line from a blanket mute. `--discharging` refuses an unconsumed name for exactly this reason (`:953-971`). | The flag is now an **error** when the page is not behind. |
| The test claiming to prove that flag was not a blanket mute **could not fail** — with `p.n > b.n` the flag was never read on that path. | Replaced with a test that exercises the state the flag actually governs. |
| Task 1's probe carried one attribute; the parser requires an adjacent, ordered, quoted **pair**. The task written to avoid the instrument-that-cannot-fail trap *was* one. | Probe carries the real pair, plus a diagnostic that separates "platform stripped it" from "regex needs changing". |
| `published === null` returned the *baseline's* error constant — wrong identity, and both are matched by identity. | Two distinct constants. |
| "No bootstrap branch is written" — the plan wrote one, untested. | Branch is written, returns an **error**, and is tested. Spec prose corrected. |
| "Sixteen occurrences of `A99`" — **65**. A fresh wrong number, introduced in the sentence correcting a wrong number. | Corrected. |
| `A46` → `A99` claimed "corrected in both documents" — **it was not corrected in plan `:726`**, the code comment destined to ship into the checker. The summary table was itself false. | Corrected, and the floor's justification rewritten: the argument is about the *sequence* passing through 99, not the maximum. |
| Spec `:425` still said PR 1 "publishes under design 2's bootstrap case", contradicting §2 four sections above. | Corrected. |
| Spec gave citations as "roughly 210-225" then cited "the 226 citations" three times — in the paragraph arguing that unre-derived numbers rot. | Corrected. |
| Merge canary claimed to surface the race "before either can publish" — publishing runs *before* merge. | Reframed as a second net, not a substitute. |
| 4a "removes the ambiguity at source" — it scans the markdown only; the live view's `BLK` section is unreachable by any check. | Scope stated honestly; the fix lands as data on both sides. |
| Task 11 call counts (51/17) included definitions and prose; `buildAheadBaselineText` consumed at 4 of the 5 cited lines. | Corrected to ~49/~16, `:382` flagged as unconfirmed. |
| Task 11's stated reason for migrating the `ONBOX_TEST_BASELINE_FILE` tests was wrong about the mechanism — they fail closed, they do not reach git. | Corrected, with the override path's missing SHA made an explicit decision in Task 10 Step 5. |
| Branch resolution was specified as a raw shell call, bypassing `runGitCommand`'s `scrubGitEnv()` (#2216) and timeout. | The ancestry lookup routes through `runGitCommand`, with a test pinning it. |
| Documenting the token by example inside the live view would trip "appears more than once" (the regex is unanchored). | Warned in Tasks 4 and 10. |

### Pass 1

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
