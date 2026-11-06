---
status: draft
issue: 4031
refs: [3954, 4032, 4023]
---

# Re-analysis: one authoritative cast matcher (#4031)

## Intent

Re-analysing a book that already has a cast must **extend** that cast, never
break it. It catches what the first run missed (characters, lines, aliases).
It never loses, renames, merges or splits anything the user already has. When
the run is unsure, it adds and asks: the human decides.

Today, "fresh analyzer row X is prior cast row Y" is decided in several places
with different inputs, in different id spaces, at different times:

- `seedReuseGuardsFromPriorCast` (`server/src/store/merge-analysis-cast.ts`
  ~:596). Its output is cached (`analysis.ts` ~:5913-5956) and reused on
  resume (~:5178-5194).
- The Phase-1 prompt dedup (`analysis.ts` ~:2498-2502) and the post-stage-2
  dedup (`server/src/analyzer/roster-dedup.ts` ~:151-288). Both rename groups
  to `safeId(name)`, which can equal a prior id.
- `stripEstablishedAsciiRewrites` (`roster-dedup.ts` ~:117-147).
- `foldMinorCast` (`server/src/analyzer/fold-minor-cast.ts`).
- `remapFreshToPriorIds` (`server/src/store/remap-fresh-to-prior.ts`).
- mergeCore's by-id join and name fallback (`merge-analysis-cast.ts`
  ~:287-326, ~:396), and `applyRewriteToPriorCast`'s collision drop
  (~:512-567).

Every refusal added to one had to be mirrored by hand in the others. PR #4023
(#3954) found a new divergence in each of its five review passes. This design
ends that bug class **by construction**: identity is decided once, early, by
one function. Every later step works in the prior cast's id space.

## Rules (owner-decided, 2026-11-05/06)

1. **Existing characters are never lost.** Each keeps its id, display name,
   voice, series link, "not the same person" marks and history. This includes
   an unvoiced row, and one whose only data is a decline, that the fresh run
   does not mention.
2. **A different name becomes an alias.** The display name never changes
   automatically, on any join. The user flips it in the cast view.
3. **User merges hold.** A fresh row carrying a merged-away id follows
   `cast-id-history` to the surviving character. A run never re-creates a
   merged-away character, and never moves a user merge into `displaced`.
4. **"Not the same person" marks hold.** No join, dedup, heal, link or
   suggestion crosses a decline. A decline is a same-book "not the same
   person" record, or a cross-book link decline (`declinesLinkOf`).
5. **A run never merges or splits existing characters on its own.** The one
   exception is the **identical-name heal**: two prior rows with exactly equal
   display names (`normaliseNameKey`), no decline between them, and no open
   suggestion on either are merged, and the merge is recorded in history. This
   is today's `dedupePriorCastByName`, at run start, unchanged.
6. **A fresh row with exactly one clear candidate joins it.** Several fresh
   rows that each clearly point at the same character all join it (owner,
   2026-11-06; this reverses #3954's N2).
7. **A fresh row with more than one candidate is added as a new character,
   with merge suggestions to each candidate.** There is no guessing:
   mergeCore's "exactly one voiced, so that one" shortcut is dropped (owner,
   2026-11-06). Suggestions stay open across runs until answered. A dismissal
   is durable, so the pair is never suggested again.
8. **Start fresh keeps the user's decisions** (owner, 2026-11-06). Merges,
   declines, dismissals and series links survive it. Start fresh discards the
   analysis cache and the per-sentence edits, and re-runs the analyzer.
9. **A corrupt merge history does not block re-analysis** (owner, 2026-11-06).
   See *Degraded history*.
10. **Re-analysis of a cast book waits for the plan** (owner, 2026-11-06).
    When the book has a prior cast or a merge history, Phase 1 attributes
    nothing before Phase 0b, even in pipelined (per-phase model) mode. First
    analysis of a new book keeps today's pipelining.
11. **A row this run added and later drops is removed, unless the user edited
    it mid-run** (owner, 2026-11-06). Then it stays, as the user's.
12. **Untagged merge-history entries count as user merges** (owner,
    2026-11-06). New entries are tagged with who made them (see
    *Provenance*).
13. **A character the user deletes mid-run stays deleted** (owner,
    2026-11-06). Lines the run had matched to it go to the narrator and show in
    attribution review.

## Design

### Where the decision happens

The plan is made **once per run, at Phase 0b**, the point in both jobs where
the stage-1 roster first exists. That is before any dedup, the Phase-1 prompt,
attribution, snapshots or linking. It is then **applied to the stage-1
roster's ids**, so every later step speaks prior ids:

```
stage-1 roster (raw)
  -> run-start heal (unchanged)
  -> matchFreshToPrior            <- the only fresh<->prior decision
  -> apply plan: rows take prior / minted ids, prior names (rule 2),
     analyzer names become aliases
  -> plan-constrained dedup (prompt dedup and post-stage-2 dedup use it)
  -> linker on `new` rows only, with the plan's decline guards
  -> Phase 1 prompt, attribution, rolls, interim snapshots  (all in prior ids)
  -> persist: re-check against current cast + history, write
```

**Pipelined mode (rule 10).** Today, with per-phase models, Phase 1 dispatches
chapters against the raw rolling roster before Phase 0b (`select-analyzer.ts`
~:72-78, `analysis.ts` ~:4696, ~:5072-5108, ~:6509) and keeps those takes. On a
book with a prior cast or any merge history, Phase 1 is held until Phase 0b has
applied the plan, so no take ever exists in raw id space. A first analysis
(no prior, no history) has nothing to match and keeps today's pipelining.

**Run start, under the cast lock.** The identical-name heal and the stale-link
prune (`pruneStaleReuseLinks`, ~:4812) are **written to cast.json** and their
retirements recorded, before any snapshot. Today both mutate only the
in-memory prior (~:4811-4824), so a re-read would undo them. After a Re-parse,
the carryover (`readPriorCastForMerge`'s fallback) is materialised into
cast.json in the same step, so every later re-read has a file to read.

**Phase-0a snapshots add no rows.** The per-chapter snapshots that run before
the plan exists (~:5736 main, ~:8773 subset) only update the live view (SSE).
They write no new rows to cast.json, so no row with a raw id ever reaches disk.

**Applying the plan collapses same-target joins.** When several fresh rows
join one prior row (rule 6), they become one stage-1 row at application time,
before the cache write (~:5955), the Phase-0b snapshot or the cast-update SSE
reads the roster. Ids are unique from Phase 0b on.

**Narrator.** The fresh narrator row keeps the id `'narrator'` through Phase 1:
the stage-2 prompt and seven modules hard-code it (`analysis.ts` ~:2265,
`cross-examine.ts`, `escalation.ts`, `evidence.ts`, `recover-tagged-lines.ts`,
`fold-minor-cast.ts`, `roster-dedup.ts`, `third-party-front-matter-guard.ts`).
The plan's narrator join (`narrator` → `char-narrator`) is applied at persist
only, as `remapFreshToPriorIds` exempts it today.

The subset job (`runSubsetAnalyzerJob`) adopts the same order. Today it dedups
(~:9335) before it seeds (~:9412). It **reuses the cached plan** of the run
that produced its other chapters' sentences and plans only rows that plan does
not cover, so one analyzer row never gets two cast rows.

Rows created after Phase 0b (the fold's `unknown-*` buckets,
`fold-minor-cast.ts` ~:107-108) are planned by the **same function** at
persist, against the prior plus the rows already planned. The function is the
same and the inputs are disjoint, so these are not two matchers.

**Analysis cache.** The plan is stored in the cache next to the raw stage-1
roster, and a resume **reuses** it, because ids must stay stable across a stop.
`loadAnalysisCache` copies a fixed field list (`analysis-cache.ts` ~:218-232);
the plan field is added there, and the cache gains a **version**. A cache
without the current version is a cache miss: it holds seeded rows and
unplanned takes, and nothing in it is reused. `performCastMerge`'s cache
rewrite (`cast-merge.ts` ~:357-391) also re-targets the cached plan.

### `matchFreshToPrior`

```
matchFreshToPrior({ fresh, prior, history, openSuggestions, reservedIds })
  -> MatchPlan
```

- **`fresh`:** raw rows not yet planned (id, name, aliases).
- **`prior`:** the prior cast after the heal. Read through
  `readPriorCastForMerge`, which is cast.json, otherwise the carryover after a
  Re-parse.
- **`history`:** `cast-id-history`, status `ok`, `absent` or `degraded`.
- **`reservedIds`:** every id a `new` row must not take:
  - live prior ids;
  - `supersededBy` keys;
  - `displaced` keys;
  - every raw id in the run;
  - ids already minted.

It is pure, synchronous, total and deterministic. Each row gets exactly one
decision:

- **`join(priorId)`:** rules 3 and 6.
- **`new(id, suggest: priorId[], inheritedDeclines)`:** rule 7.
  `inheritedDeclines` is the union of the declines of every candidate. It is
  today's #3965/#4033 decline union, now a plan output, so a `new` row that
  might be X or Y never takes a link that either of them declined.

**It is the only code that compares a fresh row with a prior row for
identity.**

### Settlement

For each fresh row `r`:

1. **Candidates, by tier, highest first.**
   - **T1, by id.**
     - `r.id` is a live prior id.
     - Or `r.id` resolves through a **user or heal** entry of
       `history.supersededBy` to a live survivor, per rule 3. Such an id
       always joins its survivor, and no name conflict overrides it.
       Analyzer-join entries (see *Provenance*) are not T1: they exist so
       old cache references resolve, not as identity rules. Otherwise one
       past T3 guess would become permanent.
   - **T2, by display name.** `r.name` equals a prior row's display name by
     `normaliseNameKey`. Aliases are **not** matched, as on main today:
     matching them would turn one past join into a permanent rule.
   - **T3:** today's surname-tolerant tier, over display names.
2. **Exclusions.**
   - **Narrator.** A fresh narrator-id row (`NARRATOR_CHARACTER_IDS`) joins
     the prior narrator-id row by role. This covers the `narrator` /
     `char-narrator` flip. If the prior has two narrator-id rows, it joins
     the one with the same id. Narrator rows are never name candidates.
   - **Catch-all rows.** `unknown-male` / `unknown-female` are never T2 or T3
     candidates.
3. **Decide.** Use the highest tier that has any candidate.
   - **Exactly one candidate:** `join` it.
   - **More than one:** `new`, with suggestions to all of them. One
     exception, the **open-question row**: if exactly one candidate is a row
     an earlier run created as `new` whose open suggestions cover every other
     candidate, `join` that row instead, so repeat lines land on the open
     question. "Created as `new`" is recorded on the suggestion itself: each
     stored suggestion names its `newRow` (the row a run created) and its
     `candidate`, so a prior row never qualifies by accident.
   - **None:** `new`, with no suggestion.
   - **Id/name conflict:** T1 picks live X by id, but `r.name` T2-matches a
     different row Y and matches none of X's names or aliases. Treat it as two
     candidates: `new`, suggesting X and Y.
4. **No claim-once.** Two rows joining one character is rule 6.
5. **Minted ids.** A `new` row keeps its raw id unless that id is in
   `reservedIds`. If it is, the row gets `<raw>-n<k>` with the lowest free
   `k`. That shape is distinct from the analyzer's `<raw>-<n>`. No history
   lineage is recorded for minted ids; the cache and sentences already carry
   the minted id (see *Retirements*). With degraded history, minting uses a
   run-unique suffix instead (see *Degraded history*).

### Plan-constrained dedup

- One dedup implementation serves both the Phase-1 prompt roster and the
  post-stage-2 dedup, so they can no longer disagree.
- On planned rows, it may merge two rows only when:
  - they joined the same prior row (the survivor is the prior id); or
  - both are `new`, with no decline between their inherited declines or their
    candidates, and no conflicting `matchedFrom`.
- A refused group stays separate and becomes a fresh↔fresh suggestion.
- **The survivor is always a member's id, never `safeId(name)`.** It is chosen
  deterministically and without line counts, so both call sites agree: a
  prior id first, then a minted id, then the lowest raw id. The prompt call
  site passes no sentences (`analysis.ts` ~:2500), so today's "more lines
  wins" Tier-2a survivor (`roster-dedup.ts` ~:267-281) goes.
- `stripEstablishedAsciiRewrites` is deleted.
- `foldMinorCast` never folds a row that joined a prior character.

### Joined rows

- **Identity fields come from the prior row:** id, display name, voice and
  per-engine voices, design, series link (`matchedFrom`), declines, and user
  edits.
- **Analysis fields come from the fresh row:** lines, scenes, evidence and
  attributes.
- **The analyzer's name is added to `aliases`** when it differs (rule 2).
- **Every prior row is carried forward,** voiced or not, mentioned or not
  (rule 1). That replaces mergeCore's voiced-only carry-forward (~:483-486).

### Linker

`linkSeriesReuseAtAnalysis` stays at Phase 0b, after the plan, and stamps only
`new` rows. It honours each row's `inheritedDeclines`. Joined rows keep the
prior row's link and are not re-linked.

`seedReuseGuardsFromPriorCast` is deleted as a matcher. Its guard fields now
come from the plan.

### Interim snapshots and stopped runs

- Interim snapshots (`analysis.ts` ~:5736, ~:5997, ~:8773) write the
  plan-applied roster:
  - joined rows overlaid by the *Joined rows* rule;
  - `new` rows added with their final ids.
- No interim marker is needed. Ids are final from Phase 0b, so a user's mid-run
  edit to any row survives, and a stopped run that is never resumed leaves a
  valid cast that has only been extended.
- Every snapshot **re-reads cast.json and history under the cast lock** and
  overlays onto that, not onto the run-start snapshot. It uses the lock-free
  inner read, because `readPriorCastForMerge` takes the cast lock itself
  (`analysis.ts` ~:247) and nesting it would break lock rule 1.
  - A mid-run user merge or decline is never reverted.
  - A plan target the user merged away mid-run resolves through `supersededBy`
    to its survivor.
  - **A plan target the user deleted mid-run** (gone, and not superseded)
    stays deleted, per rule 13. Its rows are not re-added, and its lines go to
    the narrator.
  - A `new` row is added only once. After that the snapshot overlays it like
    any other row and never re-adds it, so a user delete sticks.
- **The run tracks what it added.** The job keeps, in memory, the ids it added
  and the content it last wrote for each. Rule 11 compares that content with
  cast.json at persist to tell whether the user edited a row the run added.
- **Per-chapter rolls** (`rollManuscriptEdits`, ~:6794) write plan-applied ids
  in every mode, which supersedes P4-3(b)'s raw-id rolls (#3954). Each roll
  re-reads `manuscript-edits.json` under the `book` lock and resolves its ids
  through current history first. It no longer rebuilds the file wholesale from
  memory, so `performCastMerge`'s edits remap (`cast-merge.ts` ~:217-241) is
  not reverted.
- **The job's per-chapter cache save** (~:6785) re-reads the cache and applies
  its own additions, so `performCastMerge`'s cache rewrite is not reverted
  either.

### Persist

Under the `cast` lock:

1. Re-read cast.json and the history.
2. Plan any rows created since Phase 0b.
3. Re-resolve every plan target through current `supersededBy`. That honours
   user merges made mid-run. A target the user deleted stays deleted, per
   rule 13.
4. Apply the plan and write cast.json. **The prior** is cast.json as
   re-read, minus the rows this run added that its final roster no longer
   holds: rows dropped by the fold, the strip or the evidence check. Rule 11
   keeps any of those the user edited. Every other row is carried forward
   (rule 1).
   - Without this step, every folded or stripped character would persist as
     a 0-line row next to the bucket that holds its lines, and would be
     unfoldable on the next run.
5. Write `manuscript-edits.json` under the `book` lock, nested. `cast` →
   `book` is an allowed order.
6. Write the suggestions.

Retirements are recorded after the cast lock is released.

Constraints:

- **Nothing slow runs under the lock.** `stripThirdPartyFrontMatter` /
  `classifyNonStory` (a model call), dedup and fold all run before step 1, on
  plan-applied ids. Steps 1–6 are in-process merges of already-decided data.
- **Suggestions are written after the attribution-drift gate.** A run refused
  for drift writes none.
- **Replacing `castBase.writeChecked`** (#2015) with the re-read under the lock
  is a chore in this work. So is updating `cast-lock.guard.test.ts`'s
  count-keyed allowlist of `analysis.ts` merge-base writes.

### Provenance (rule 12)

Each new `cast-id-history` `supersededBy` entry records who made it: `user`
(`performCastMerge`, suggestion accept), `heal`, or `analyzer` (a join
retirement). Existing entries carry no tag, and an untagged entry counts as
`user`. Only `user` and `heal` entries are T1 identity rules. All three kinds
feed `buildCastResolver`.

### Retirements

- **Joins:** record `raw → target`, tagged `analyzer`, when they differ and
  `raw` is neither live nor already a `supersededBy` key. This is for
  `buildCastResolver`. A raw id that is already superseded is left alone, so
  the user's merge is never repointed.
- **Minted `new` rows:** record nothing. Their raw id is live or reserved, and
  the cache stores the plan, so no consumer resolves a raw id to a minted row
  through history.
- **The heal:** keeps recording its retirements at run start, as today
  (~:4845-4863).

### Degraded history (owner rule 9)

When `cast-id-history` is `degraded` (present but unreadable), the run carries
on:

- T1 through `supersededBy` is unavailable. T1 by live id, T2 and T3 still
  apply. A merged-away name still usually T2-matches its survivor, because
  `performCastMerge` keeps the survivor's display name.
- `reservedIds` cannot include history keys, so **every `new` row gets a
  minted id with a run-unique suffix** (`<raw>-r<run token>`), not "lowest
  free `k`". Lowest free `k` could re-mint an earlier minted id that the user
  has since merged away. A merged-away id is therefore never re-created live.
  The worst case is a duplicate character, with a suggestion to merge it.
- Retirements are skipped and logged, as today.
- Dismissal records (below) cannot be read, so the run may re-suggest a
  dismissed pair. It never joins one.

### Suggestions

- **Store.** Suggestions are kept across runs, keyed by unordered pair, each
  naming its `newRow` and `candidate` (see *Settlement*). They are written
  under the cast lock by both the run and the dismiss route; today's
  `dismissSuggestion` is an unlocked load-filter-write
  (`store/cast-merge-suggestions.ts` ~:56-66). A run adds:
  - the plan's fresh↔prior pairs (the `new` row's final id against each
    candidate);
  - refused-dedup fresh↔fresh pairs.

  A run removes a pair only when it is resolved: a row is gone or merged, or
  the pair has been declined. Today's whole-file overwrite (`writeSuggestions`)
  goes.
- **Never suggested:** a declined pair, or one already merged.
- **Accept** still goes through `performCastMerge`, which records history. A
  merge of a dismissed pair drops that pair's dismissal record.
- **Dismiss** writes a durable, undirected **same-book "not the same person"
  record**. This is a new record, not a `rejectedPairs` entry: `rejectedPairs`
  means "orphaned id is not this live id" and feeds the resolver and the
  decision chips.
  - The dismiss route writes the record **and** both `notLinkedTo` edges
    synchronously, under the cast lock and then the `cast-id-history` lock.
  - `reconcileRejectEdges` treats the record as a backing source for the
    edge on **both** rows.
  - `performCastMerge` repoints the record when either row is merged into a
    third character. It also unions the source's `notLinkedTo` into the
    target, which today it does not (`cast-merge.ts` ~:171-199).
  - The record lives in **`cast-id-history`**, which survives a Re-parse
    (the carryover drops anything cast.json holds beyond voice fields). When
    the history is degraded, it cannot be read (see *Degraded history*).
- **The heal reads both.** The identical-name heal skips a pair that has an
  open suggestion or a dismissal record, as well as a `notLinkedTo` edge.
  Today it checks only `groupHasNotLinkedEdge` (`merge-analysis-cast.ts`
  ~:768-797).

### Start fresh

`fresh: true` changes in three ways:

- It no longer deletes cast.json, the carryover or the merge journal
  (`analysis.ts` ~:4888-4968).
- It no longer strips `notLinkedTo` or series links
  (`dropReuseContinuityKeepDesignedVoice`, ~:4788).
- It no longer clears suggestions.

It still skips the analysis cache, rotates `editEpoch`, and resets
`manuscript-edits.json` and `castConfirmed` as it does today. Its prior comes
from `readPriorCastForMerge`, as in any other run.

The kept merge journal's manual `affected` sentence refs
(`cast-merges.ts` ~:39-52) point at sentences Start fresh regenerates, and the
unlink-alias route intersects by them (`cast-aliases.ts` ~:383-418). So Start
fresh clears those refs and keeps the merges themselves. An unlink after Start
fresh then offers lines by alias match alone.

## Goals

- One function decides fresh↔prior identity, once per run. Every catalogued
  divergence becomes impossible by construction.
- Rules 1–13 hold in the main job, the subset job, a resumed run, and a stopped
  run that is never resumed.

## Non-goals

- The series linker's own cross-book matching. It now runs on `new` rows only.
- New UI. Accept, dismiss and the display-name flip already exist.
- The analyzer prompts and chapter splitting.

The Phase-1 prompt roster **does** change: it now lists prior ids, prior
display names, and the analyzer's names as aliases. That change is intended.

## Anti-goals (a failure even if tests pass)

- A second place comparing a fresh row with a prior row for identity.
- A run that renames, drops, merges (outside the heal) or splits an existing
  character.
- A dismissed suggestion coming back while the history is readable, or an open
  one silently vanishing.
- Lines landing on the wrong one of two same-name characters.

## Known limitation

If two characters really do share a name, have been told apart by the user,
and the analyzer drifts to a new raw id for that name, the run cannot know
which one is meant. It adds a third row, with suggestions. That is rule 7
working as intended. It recurs only when the analyzer's raw id is new; a raw
id equal to a prior id joins by T1.

## Acceptance

Route-level tests run through the real `runMainAnalyzerJob` **and**
`runSubsetAnalyzerJob`. Each asserts the final cast.json,
`manuscript-edits.json` **per-character line counts**, `cast-id-history` and
the suggestions store:

1. **#3954 original.** A single-candidate T3 join keeps the prior id; the voice
   key does not move.
2. **F3, P5-3/#4032 and the four #4033 residual rosters.** The rosters are
   `wren-a`+`wren-9` (either order), `wren-2`+`wren-7`, `wren-a`+`wren-b`, and
   `wren`+`wren-2`.
   - No row holds the declined link without its decline.
   - Neither twin is lost.
   - Each twin's lines stay on that twin. A row the plan made `new` holds its
     own lines.
3. **Degraded history.** The run completes. Every `new` row gets a minted id.
   No merged-away id is live. No retirements are written.
4. **N2 / P3-2.** `brann-weir` (merged into `old-weir`) and `ow2 "Old Weir"`
   both join `old-weir`. There is no new row and no `displaced` entry.
5. **P4-2 / P5-1.** Fresh "John Smith" joins `js`. Fresh "John" becomes `new`,
   with suggestions to `js` and `jd`.
6. **Voiced shortcut gone.** A T3 name with one voiced and one unvoiced
   candidate produces a suggestion, not a join.
7. **P5-2.** A joined row does not inherit another row's `matchedFrom` or
   `notLinkedTo`. A `new` row with candidates X and Y takes no link either of
   them declined.
8. **Rule 1.** An unvoiced prior row and a decline-only prior row that the
   fresh run omits are both still present, with their declines.
9. **Rule 2.** A by-id join and a name join both keep the prior display name,
   and each gains the analyzer's name as an alias.
10. **Rule 3.** A fresh row carrying a merged-away id lands on the survivor,
    even when its name matches another row. The merge is not moved to
    `displaced`.
11. **Rule 5 heal.** An identical-name split heals and records history. It
    does not heal when there is a decline, or an open suggestion.
12. **Rule 7 lifecycle.**
    - An open suggestion survives a second re-analysis.
    - A repeat ambiguous name joins the open-question row.
    - A dismissal survives a re-analysis (reconcile included), a Start fresh,
      and a later merge of one of the two into a third character.
    - The pair is not re-suggested.
13. **Mid-run user writes.** A merge and a dismissal made during a run survive
    the next interim snapshot and the persist.
14. **Stopped run.**
    - Stopped after snapshots and never resumed: the cast is only extended,
      and a user edit made on a new row survives.
    - Resumed: the same result as an uninterrupted run.
15. **Minted ids.** In the `wren`+`wren-2` roster with a forced `new`, the
    minted id is not any live, superseded, displaced or raw id, and the row's
    sentences carry it.
16. **Re-parse then re-analyse.** The carryover is written to cast.json at
    run start. Every carryover row, with its id, name, aliases and voice,
    survives, and so do its dismissal records.
17. **Pipelined re-analysis (rule 10).** With per-phase models set on a cast
    book, no Phase-1 take is attributed before Phase 0b. The twin rosters
    from acceptance 2 pass in pipelined mode too.
18. **Narrator.** On a book whose narrator row is `char-narrator`,
    re-analysis completes without `attribution_drift`, and prose lands on
    `char-narrator`.
19. **Run-added rows (rule 11).**
    - A character the fold drops and the user did not edit is gone after
      persist.
    - One the user gave a voice mid-run stays.
20. **Deleted mid-run (rule 13).** The character stays deleted, and its lines
    are on the narrator.
21. **Provenance (rule 12).**
    - An untagged and a `user` entry are T1.
    - An `analyzer` entry is not: a later ambiguous name gives a suggestion.
22. **Legacy cache.** A cache without the current version is a miss, and the
    resume re-runs from the analyzer.
23. **Mid-run merge, other files.** After a mid-run merge, the rolled
    `manuscript-edits.json` and the cache carry the survivor id.
24. **Drift-refused run.** It writes no suggestions.
25. **Unit tests.**
    - `matchFreshToPrior` is total and deterministic over every fixture above.
    - mergeCore contains no name comparison; it joins only by plan.
    - Both dedup call sites produce the same groups for the same planned
      roster.

**Reusable harness and fixtures** are on PR #4023's branch
(`fix/server-3954-keep-prior-id-on-name-join`):

- `server/src/routes/analysis.keep-prior-id.test.ts`: the
  phase0/phase1/mkBook/mkJob/run harness, `blipRemapRead`, and the pipelined
  flag.
- `analysis.same-book-gate.test.ts`: the twin and decline fixtures, and
  `abortAtFirstPhase1`.
- `analysis.persist-block-degraded-history.test.ts`.
- `cast-id-history.test.ts`.

**Re-derive every expectation from the rules above.** Several #4023
expectations encode choices these rules overturn, including N2, P5-1, P3-1 and
P4-3(b).

## Left to the builder

- The shape and module of `MatchPlan`, how the T3 code is reused, and the
  suggestions-store and dismissal record shapes, within the constraints above.
- Whether `remapFreshToPriorIds` is deleted or kept as a thin applier.
  `remapCjkHonorificIds` (~:7245) is attribution repair on plan-applied ids,
  not an identity decision about prior rows, so it stays.
- The task breakdown and how it is sliced into PRs. A suggested order:
  1. the matcher and its unit tests;
  2. Phase-0b application, plan-constrained dedup and the linker in both jobs;
  3. snapshots, rolls, resume and persist;
  4. the suggestions lifecycle, dismissal and Start fresh.

## Disposition of related work

- **#3954 / PR #4023:** delivered by acceptance 1. Close #4023 unmerged and
  port its harness and fixtures.
- **#4032:** closed by acceptance 2.
- **`reviewer-brief.md` entry 77:** widen it to "any fresh↔prior identity
  decision outside `matchFreshToPrior`".
