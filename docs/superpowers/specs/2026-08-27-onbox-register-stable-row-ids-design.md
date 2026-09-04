---
status: draft
date: 2026-08-27
---

# On-box register: stable row IDs, and a publish check that can see a competing publish

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

1. **Blast radius.** It rewrites the ~210-225 citation occurrences above — the #2626
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
   unknown share of those citations are already wrong but still resolve. A
   positional old→new map rewrites each into a **permanently frozen** wrong ID,
   and stable IDs remove the only mechanism that would ever have exposed them.

## Design

### 1. Stable row IDs, with new rows allocated above all history

**A row ID is allocated once and never reused. Discharging deletes the row and
leaves a gap.**

- **Existing rows keep their IDs.** `A1`…`A37`, `B1`…`B2`, and so on are
  untouched. None of those citations moves.
- **Each group carries `<!-- next-id: A101 -->`** immediately after its
  `## Group A — …` heading. New rows are allocated from that value, which is
  bumped on each allocation.
- **The floor is `101` for every group**, which is provably above all history.
  Full git history of the register and its live view — every `### <Letter><N>`
  heading and `<span class="num">` ever added or removed — gives all-time
  high-waters of **`A`=48, `B`=5, `C`=4, `D`=3, `E`=11, `F`=1, `G`=2, `H`=2**
  (independently recomputed during the assumption-checker pass; figures agree).
  **Real rows top out at `A48`, but `A99` is occupied** — it is the *citation
  checker's own* sentinel for a definitely-nonexistent ID
  (`check-register-citations.mjs:733`, `:759`, `:785`, plus **65** occurrences in
  `scripts/tests/check-register-citations.test.mjs`; an earlier draft said
  sixteen, which was a fresh wrong number introduced in the sentence correcting a
  wrong number). It is not a register row and never was, but it occupies the
  `row <ID>` idiom.

  **The argument for `101` is about the sequence, not the maximum.** A floor of
  ~50 would clear every real row *today* and still be wrong: allocation counts
  upward, so a group seeded near 49 eventually **passes through** 99 and collides
  with the sentinel. `101` is chosen to sit above it permanently. Stated this way
  because the next person to re-derive this floor will re-derive it from this
  sentence, and "highest ID in the tree" is the wrong quantity to derive it from.
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
with the three that already carry none, and removes the ambiguity from the data.

**What 4a does not cover.** 4a scans the register markdown only. The live view's
`BLK` section is unreachable by *any* check — `parseGlanceTable` needs `^[A-Z]$`
and `parseLiveViewSections` filters on `gtag` — so the regression pin guards the
half of the surface where the collision was already visible, and the blind half
stays blind. That is why the fix has to land as **data on both sides** (see
Delivery) rather than being left to the guard.

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

**Resolution: advisory-warning 3-way comparison (#2837).** This spec's argument
against per-row comparison has been reconciled by PR #2837 (issue #2599), which
implements a 3-way comparison that reports *as an advisory warning* — never
blocking — when all three copies differ. This avoids the blocking failure on
multi-step publishes (the exact failure mode this section warned about) by
refusing to hard-block on ambiguous signals, while still surfacing the signal
visibly so an operator can investigate manually if the content looks wrong. The
approach trades hard guarantees for practical usability in the face of inherent
ambiguity.

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

**Rejected: a branch name as the identity.** The fifth design, and the second
killed by an assumption-checker pass. The counter's repair was to make the token
carry *who* as well as *how many* — `data-published-by="chore/ops-…"`. The axis
was right and the value was wrong, on three independent grounds:

1. **It is inherited by default.** `who` arrives on every fresh branch as
   whatever `main` last held — *the previous lane's name* — and updating it is a
   second manual action, separate from bumping the counter. When it goes stale
   the mechanism silently degenerates into the bare counter it was invented to
   replace, and fails in the **green** direction: a competing lane whose stale
   `who` happens to match yours reads as your own earlier publish.
2. **This repo mandates the mutation that breaks it.** CLAUDE.md requires an
   auto-generated worktree branch to be renamed to `<type>/<scope>-<slug>`
   immediately, and makes `integration/<date>` the default disposition for a
   round of parallel agent work. Publish, rename, re-publish → the token names a
   branch that no longer exists → a STOP that **cannot be cleared**, in a design
   whose own principle is that an unclearable STOP is a guard that gets bypassed.
3. **Detached HEAD collapses it.** `git rev-parse --abbrev-ref HEAD` prints the
   literal `HEAD`, so two unrelated lanes both publish as `HEAD` and each reads
   the other as itself.

**The design: a publish nonce, verified against git history.**

The token needs to answer *"did the state now live come out of my history?"* —
which is a question git can answer, and which no hand-maintained name can. The
counter stays, for ordering; identity moves to a short random nonce minted at
each bump:

```html
data-published-as="48" data-publish-id="k7f2a9"
```

The query is
`git log --oneline -s --full-history --diff-merges=first-parent -S 'data-publish-id="<nonce>"' <ref> -- <live view path>`,
and **every part of that command line is load-bearing.** Getting any of them
wrong flips the answer in the *permissive* direction for every STOP it gates —
three of the five green-direction defects this design produced in review lived
in these nine lines, where the JavaScript shows you nothing:

- **`--full-history`** — a pathspec'd `git log` prunes at a merge that is
  TREESAME to one parent for that path, so `false` can mean *pruned* rather than
  *absent*.
- **`--diff-merges=first-parent`** — `git log` computes **no diff at all** for a
  merge commit unless asked, so a nonce born in a **conflict resolution** reads
  as absent from the history that literally contains it. That is a routine state
  here: this repo mandates merge commits, the live view is the file lanes race,
  and the natural resolution *is* a re-stamp — so the surviving token exists in
  neither parent.
- **the `data-publish-id="…"` anchor** — `-S` is a **substring** search, so a
  bare nonce matches an abbreviated commit SHA quoted in the page's own
  changelog prose, spuriously reporting a rival's publish as yours. The parser
  constrains the nonce to `[A-Za-z0-9_-]{6,64}` so the anchor cannot be broken
  out of.
- **`-s`** — suppresses the patch body while leaving pickaxe *selection*
  untouched. Without it every lookup streams a full diff of a 250 KB file.

**Two refs, not one.** `inBaseline`/`workingInBaseline` ask the **baseline
commit**; `inMine`/`baselineInMine` ask `HEAD`. Never `--all`: the baseline
fetch means `--all` would see a rival's freshly-fetched commit and answer
"found" for a publish that is not in your history at all.

**The nonce is load-bearing; the counter cannot substitute for it.** Searching
history for the *counter* fails, because two lanes both bumping `47 → 48` each
find their own commit. Only a value unique per publish distinguishes them.

**FOUR history answers, not one.** The caller supplies each as `true | false |
null`, and `null` — the lookup itself failed — is never read as `false`:

| Lookup | Question |
|---|---|
| `inBaseline` | is the **published** nonce in the baseline commit's history? |
| `inMine` | is the **published** nonce in `HEAD`'s history? |
| `baselineInMine` | is **`origin/main`'s own** nonce in `HEAD`'s history — i.e. does my branch contain the live view that is currently on `main`? |
| `workingInBaseline` | is the **working** nonce already in the baseline's history — i.e. was it not freshly minted? (consulted only when `working.n > baseline.n`) |

Before publishing, `comparePublishTokens` evaluates these gates **in order**,
returning at the first that fires. Order is load-bearing wherever noted:

| # | Gate | Verdict |
|---|---|---|
| 1 | `baseline` / `published` / `working` unresolvable | its **own** named constant, matched by identity — three of them, because an operator does something different about each |
| 2 | any of the three tokens malformed | **STOP**, all malformed copies reported together rather than one at a time |
| 3 | baseline carries no token | **STOP** — a revert or deletion, never a first run (see the bootstrap note below) |
| 4 | working carries no token | **STOP** — restore it |
| 5 | published carries no token but the baseline does | **STOP** — the transition case: published from a branch predating the token, the wrong file published, or the page clobbered |
| 6 | `--live-page-behind-main` passed while the page is *not* behind | **STOP** — flag misuse is refused, not ignored (the `--discharging` unconsumed-name property) |
| 7 | `inBaseline` or `inMine` unresolvable | **STOP** — fail closed |
| 8 | `baselineInMine` unresolvable | **STOP** — fail closed, with its own message |
| 9 | `inBaseline && baselineInMine && !inMine` | **STOP** — the answers *contradict* each other, so a lookup is wired to the wrong ref or nonce. Every verdict below derives from these three, so one contradiction makes all of them untrustworthy |
| 10 | `inBaseline && published.n > baseline.n` | **STOP** — the live page's nonce is already in `main`'s history while its counter is ahead: a lane published **without minting**. This is the invariant that closes the class |
| 11 | `!baselineInMine` | **STOP — REBASE, do not bump.** My branch does not contain the live view currently on `main`. **Before the counters deliberately**, because the counters are the thing being lied to |
| 12 | `!inBaseline && !inMine`, nonces equal | **STOP** — your own publish, not yet committed; commit the bump and re-run |
| 13 | `!inBaseline && !inMine`, nonces differ | **STOP** — another lane published since your baseline |
| 14 | `working.n > baseline.n` and `workingInBaseline` unresolvable | **STOP** — fail closed |
| 15 | `working.n > baseline.n` and `workingInBaseline` | **STOP** — the working nonce was not freshly minted |
| 16 | `published.nonce === working.nonce && working.n > published.n` | **STOP** — the counter advanced while the nonce did not. Detectable with **no** history lookup, so it catches the un-minted case one commit earlier than gate 10, before either nonce is committed |
| 17 | `working.n < baseline.n` | **STOP — REBASE.** Your branch predates `main` |
| 18 | `working.n === baseline.n` | **STOP** — stamp it; an unbumped publish is untracked |
| 19 | `published.n < baseline.n` | **STOP** — the page is *behind* `main`. Clearable with the named flag, see below |
| 20 | `working.n <= published.n` | **STOP** — not ahead of your own last publish |
| 21 | otherwise | **OK** |

**Green requires `baselineInMine === true`.** That is the whole working-side
half of the design, and gate 11 is the only thing enforcing it. An earlier
draft had no such gate: every invariant governed the *published* nonce, and the
only relation between the working file and the baseline was a counter that the
stale lane increments itself — while gate 18's remedy *told it to*. Two lanes
branch at 47, both stamp to 48, B merges and publishes, A is told "the same as
`origin/main` — stamp it", obeys, and gets **green** over a page it never saw.
The rows are identical, so every other mechanical check is blind. That is the
2026-07-31/08-01 incident, reproduced by obeying the guard's own advice.

**Two orderings are load-bearing and are pinned by tests**, because a later
edit reordering them fails silently:

- **Gate 11 before gates 17-20.** Reversed, a stale lane is handed "stamp it"
  and walks itself to green, which is the failure above.
- **Gate 17 (`REBASE`) before gate 19 (`behind`).** Reversed, a lane that is
  both un-rebased and looking at a behind page is handed the mute flag.

**`working.n < baseline.n` and `working.n == baseline.n` are different failures
and get different advice.** An earlier draft collapsed both into "bump it", and
that was the more dangerous of the two Criticals this design has produced: with
`baseline 48` (a competing lane merged), `published 48` (their page) and
`working 48` (yours, branched at 47), no guard fired, the remedy said "bump", and
bumping to 49 turned the check **green** over an un-rebased file. The row-level
check does not backstop that — what is lost is the summary strip, the callouts
and the footer, which is precisely the class this token exists to protect. That
is #1931's original incident, reproduced by obeying the guard's own remedy.

The nonce closes it independently of the message split: an un-rebased branch
cannot find the competing lane's nonce in its own history, so the state stops
being "bump it" and becomes "another lane published". Both are implemented, and
the ancestry gates sit above the counter gates so the diagnosis is right even
when the counters happen to agree.

**The carrier is an attribute, not an HTML comment.** `checkLiveView`'s first
action is `stripHtmlComments(rawLiveViewHtml)` (`:641`), and that blanking is
load-bearing — its own header records that without it "a commented-out row was
counted as a real one." A comment token is invisible to the very function that
must read it. An attribute is immune by construction. **Whether the exact
two-attribute pair the parser matches survives the publish → fetch round trip is
settled empirically before any code depends on it** (implementation plan, Task 1)
— the probe must carry what the parser matches, not an approximation of it, or it
is the instrument-that-cannot-fail trap it was written to avoid.

What this buys over every rejected rule:

- **No normaliser.** An integer, compared numerically, and an opaque token,
  compared for equality and looked up in history. The
  rejected content designs all needed a normaliser over prose dense with
  `&ldquo;`, `&nbsp;`, inline `<code>` and `<a href>` — and none of the three
  ever defined one, which is its own warning.
- **No per-row parser, no keys.** The `<details class="item">` / `<span
  class="num">` scheme is not needed, and neither is the heading-text fallback
  for the `BLK` and `?` sections that had no IDs to key on.
- **Nothing hand-maintained is trusted.** The nonce is not compared to a value
  someone had to remember to update; it is looked up in history. That is what
  removes all three branch-name failures at once, rather than patching them.
  **This is only half true without the stamper, and the stamper is therefore
  part of the design, not tooling around it**: `scripts/stamp-publish-token.mjs`
  bumps the counter and mints a fresh id in one action, writes the genesis token
  too, and validates what it mints against the same rule the parser enforces —
  a stamper that wrote a token its own reader rejected would wedge the check
  permanently. Every remedy the comparator emits names that command, so no
  runbook line ever says "bump it by one". Bumping the counter *without*
  minting is the hand-maintenance failure with an extra step, and gates 10, 15
  and 16 exist because it is reachable three different ways.
- **It covers what per-row rules could not**: a dropped row, a wrong summary
  strip, the stale callouts, and publishing the `.md` by mistake — the failure
  the register records happening four times.

**The token line is a *merge* canary, not a publish-time one.** Two lanes that
both bump `47 → 48` conflict in git on that one line. That surfaces at merge —
and publishing runs *before* merge, so it is a second net under the ancestry
check, not a substitute for it. An earlier draft claimed it surfaced the race
"before either can publish", which is simply the wrong order of operations.

**No bootstrap case reached through a tokenless baseline — but the split that
guarantees it is NOT the one this document originally named.** The seeding task
was Track B's, and Track A shipped without it, so for a period `origin/main`
carried **no token at all** (`grep -c published-as` returned 0) while this
section still asserted the opposite. Shipping the comparator in that state would
have made its very first run return "origin/main carries none — this is a revert
or a deletion" — an unclearable STOP misdiagnosing its own cause, on a design
whose stated principle is that an unclearable STOP is a guard that gets
bypassed. The token is therefore seeded by **its own data-only PR** ahead of any
code that reads it (#2599, first PR), which is the same data-then-guard shape
the stable row IDs needed. Once that has merged, a branch for "baseline has no
token" is
**written as an explicit error, not as a pass** — reachable only through a revert,
a deleted token line, or PRs merging out of order, all of which are defects rather
than a first run. An earlier draft said the branch was "not written"; it is
written, it just never returns green.

**Nothing unresolvable is ever a pass.** `resolveBaselineText` returns
`{ text: null }` on a git failure, and `null` is not "a copy with no token" — it
is "no copy". Everywhere else in this file that distinction is load-bearing, with
its own exported constant matched by identity (`CANNOT_VERIFY_BASELINE_ERROR`,
`:529`) and its own CLI remedy branch. The token check uses the same vocabulary,
**with a distinct constant for each of the three — the baseline, the saved
published page, and the tracked working file** — they fail for different reasons
and the operator does something different about each. Two constants would force
two of those three onto one message.

**Stated boundary — two, and both are worth saying out loud.**

**First: the token proves provenance, not intent.** It shows the live page came
out of your history and that nobody else published since your baseline. It does
**not** prove the bytes you are about to publish are the bytes you intended: a
stale local build of your own file, correctly bumped and correctly nonced, still
publishes. That is what git review covers, and it goes in #2599's close comment
rather than being implied.

**Second: `baselineInMine` proves your branch HELD main's live view, not that
your working file still reflects it.** The lookup asks whether main's nonce
appears anywhere in `HEAD`'s history for that path, and it is **the rebase
alone that satisfies it** — measured in a real repository: before rebasing the
query selects 0 commits, after rebasing and *before any stamp* it selects 1.
So the staleness STOP is cleared by rebasing, which is exactly what its message
instructs. The cost of asking a history question rather than a content one is
that a revert, or a wholesale "take mine" conflict resolution *after* a clean
rebase, also satisfies it and goes green.

*(An earlier draft of this paragraph said the removal-match was "what lets a
correctly rebased lane clear the STOP after one stamp". That inverts the
causation. `-S` does match a removal — your own stamp removes main's nonce and
the query then selects 2 commits rather than 1 — but that second match is
**redundant**: the commit that ADDED main's nonce is already in your history
once you have rebased. The stamp answers a different gate, `w.n === b.n`. The
claim was written from the previous draft rather than from a probe, which is
the failure mode this document has recorded five times and is the reason the
correction is left visible here rather than quietly edited out.)*

That residue is adjudicated, not overlooked. Detecting it means comparing
*content* between the working file and the baseline — which is precisely the
question the three rejected per-row designs could not answer, for a reason that
has not changed: content comparison cannot separate "this branch edited the row"
from "this branch is stale". The token deliberately answers a different, decidable
question instead. What closes this last gap is git review of the diff, not a
richer comparator.

*(The previous draft carried a second boundary — that the publisher field was
"trusted, not proven", justified as detecting accident rather than forgery. That
was a rationalisation of an avoidable weakness, not a property of the problem.
Verifying identity against history costs one `git log -S` through the runner this
file already uses, and the boundary disappears.)*

**A stalemate needs an escape hatch, and the hatch needs its own guard.**
`published.n < baseline.n` is legitimately reachable — a PR can bump and merge
without publishing — and the operator cannot clear it by rebasing or re-reading.
It gets a named flag on the same footing as `--discharging` (which exists because
#2272 found the identical shape). **Like `--discharging`, passing it when the page
is not actually behind is an error, not a silent no-op** — that flag refuses an
unconsumed name precisely so it cannot "degenerate into a blanket mute"
(`:953-971`), and a flag that is inert-but-accepted in every other state is one
copied runbook line away from permanently disarming the check. The register's "If
it fails" tree gains a section for the whole class.

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

**There are TWO retro-applications, not one, and only the first was written
down.** The rule above is about `checkRegister` over the **register**. The
publish token creates a structurally identical one over the **live view**: the
comparator resolves `baseline` by reading `origin/main`'s copy of the HTML, and
its "baseline carries no token" branch is a hard error. So the *token* is
retro-applied to `origin/main` exactly as a *check tightening* is, through a
different function and a different file. Missing this is what produced the
bootstrap break described in design 2: the seeding task was moved to the second
track, the first shipped without it, and both this document and the plan went on
asserting that `origin/main` carried a token when it carried none. The general
form is worth stating once: **any new thing a checker requires of
`origin/main` — a check, a marker, a token — has to be on `main` before the
code that requires it, and "which PR seeds it" is part of the design, not
scheduling.**

**PR 1 — data only.** Adds the `next-id` markers, drops the Blocked-section row
IDs **in both the register and the live view**, introduces the `published-as`
token, fixes the Group F sentence, moves the one blocked-row citation to cite by
title, and repairs the stale callouts described below. All green under *today's*
checker: markers are inert, contiguity is untouched, the Blocked section is
unscanned on both sides. It publishes under the **old** comparator — design 2's
code ships in PR 2, which is why `origin/main` already carries a token by the
time anything reads one.

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
**six** `<div class="callout warn">` blocks narrating counts `65 → 69` and
describing `A44`/`A45`/`A46`/`E10` — verified in the file; an earlier draft said
four. **`A44`, `A45` and `A46` do not exist**; `E10` **does** (register `:3818`,
live view `:1324`), and its callout describes that very row, so that one is stale
only in its *count*, not its ID. An earlier draft asserted none of the four
existed and also named an `A41` that it claimed appeared nowhere — `A41` is at
live view `:1271`. Both were wrong. The register tops out
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
| **#2599** | Closed by design 2 — but **not** by the row-content diff the issue asked for. The issue's own option 2 named a decision as owed; the answer is that per-row content comparison cannot be made correct here. The close comment records **all six** rejected designs — three content rules, the bare counter, the branch name as identity, and a nonce with no freshness check — and why each failed, plus the one stated boundary (it proves the live page came out of your history and nobody else published, not that you published the bytes you meant to). |
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
- **a re-publish from the same branch is green** (`baseline 47`, `published 48`
  whose nonce IS in this branch's history, `working 49`) — **the assertion that
  kills a bare counter**, and the one the counter design's own test contradicted
  its own implementation over. It is a *separate* test from the first publish: in
  a re-publish `published != baseline`, so one assertion cannot cover both;
- **a competing publish with byte-identical counters is reported** — same numbers
  as the test above, nonce NOT in history. If these two ever agree, ancestry is
  being ignored and the design has silently reverted to a bare counter;
- **`working.n < baseline.n` is reported as NOT REBASED, not as "bump it"** — the
  regression test for the second Critical: `baseline 48`, `published 48` from a
  merged competing lane, `working 48`. Assert on the *message*, because the whole
  defect was that the right verdict carried the wrong remedy;
- `working.n == baseline.n` is reported as an unbumped publish — a different
  message from the one above;
- `published.n < baseline.n` is reported with its own message, and the escape
  hatch clears **only** that state;
- **the escape hatch is an error when the page is not behind** — the
  `--discharging` unconsumed-name property (`:953-971`), so it cannot become a
  blanket mute. The counter design's version of this test could not fail: the
  flag was never read on the path the test exercised;
- a `published` page with no token, against a `baseline` that has one, is
  reported — the wrong-file-published case the register records happening four
  times;
- **a tokenless baseline is an explicit error, never a pass** — the branch is
  written, and it returns an error rather than bootstrapping;
- **an unresolvable baseline and an unresolvable published page get DIFFERENT
  fail-closed constants** — `null` and "tokenless" must not collapse, and the two
  copies fail for different reasons with different operator actions;
- a non-integer counter, an empty nonce, and **two tokens in one file** are each
  an error rather than a skip or a first-match win;
- the second baseline read uses the **same** SHA as the first;
- **the ancestry lookup runs through `runGitCommand`**, not a raw `spawnSync` —
  that wrapper carries `scrubGitEnv()` (#2216) and the timeout, and bypassing it
  reopens the inherited-`GIT_DIR` hole it exists to close.

**Real-tree CLI tests must move.** `computeMaxRowNumber` and
`buildAheadBaselineText` — the latter consumed at four sites, `:2212`, `:2363`, `:2520`,
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
