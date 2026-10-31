---
status: active
shipped: null
owner: null
---

# Parse-fallback chapter hints: check the pairing against saved sentences (#3837)

> Status: active; implementation in progress on `feat/server-3837-hints-proof`. The design follows the owner decisions on #3837 through round 8 (2026-10-31): round 5 narrowed the scope to **check only, never persist**; round 6 set the restructure seam to **sentences plus titles** and kept **Start fresh** on count/id only; round 7 accepted the one remaining durable-miss class; round 8 added the **stale-evidence marker** after re-parse and limited **exclude/include** hints writes to a count-changing prune; the implementation decisions after checker round 5 (2026-10-31) extend the marker to a restructure's analysis-cache rebuild and to a bundle overwrite. The rule was calibrated read-only on every analysed book in the operator's workspace (see "Calibration"). This revision answers the fourth `assumption-checker` pass and the round-5 targeted checker, and was approved by the owner on 2026-10-31 (plan PR #3922).
> Key files: `server/src/workspace/hints-proof.ts` (new, pure), `server/src/workspace/hints-proof-io.ts` (new, the edits read), `server/src/routes/analysis.ts` (`hintsOutOfSyncRefusal`, about line 3982; call sites about lines 4066 and 7887; the main persist's edits write, about line 7305), `server/src/routes/chapters-restructure.ts` (`applyRestructure` / `applyRestructureClaimed`), `server/src/routes/book-state.ts` (`applyReparse`, about line 1623), `server/src/workspace/restructure.ts` (`parseTitlesPairWithState`, `assertHintsPairWithState`), `server/src/workspace/scan.ts` (`BookStateJson`), `server/src/store/manuscripts.ts` (`hydrateFromDisk`, `hintsFromParse`, the `hintsSource` / `parseTitles` docs about lines 66–78), `server/src/parsers/audio-tags.ts` (`AUDIO_TAGS`), `openapi.yaml`.
> URL surface: indirect. The routes are `#/books/<id>/...` restructure actions, Start analysis and re-parse / replace-manuscript.
> OpenAPI ops: no shape change. The descriptions of the analysis-start and restructure 409s are rewritten (Task 6), and `src/lib/api-types.ts` is regenerated. `hints_out_of_sync` stays a pre-stream 409 only; it is never sent as an SSE event.
> Calibration harness (scratch, not committed, read-only): `C:\Users\dudar\AppData\Local\Temp\claude\C--Claude-Projects-Audiobook-Generator\169e493a-2d88-46fe-bb7e-6c1a62e48b55\scratchpad\calib\round6.ts` (run `server/node_modules/.bin/tsx round6.ts - x`; `SWAP=a,b` and `SHIFT=i:k` are positive controls). Supporting probes in the same folder: `r5-reparse-marker.ts` (the re-parse loop, with and without the marker), `r5-m3m4.ts` (the M3 and M4 unit fixtures) and `r7-fixtures.ts` (the M21, M5 and 24-character floor-pin fixtures; output `out-r7-fixtures.txt`).
> Refs: #3879 (re-grouping split drift, pre-#3703 user splits and persisting a proved pairing, all withdrawn from this plan by round 5).

## Problem in one paragraph

Some books have no valid `manuscript-hints.json`: books restructured before #3703, and books never restructured. Their chapter hints come from a fresh parse (`hintsSource: 'parse'`, `store/manuscripts.ts` `hydrateFromDisk`), and a parse says nothing about which state chapter a body belongs to. Today two rules guard them:

- Analysis start (#3829) checks the count and ids only. A same-count reorder made before #3703 is analysed on the wrong bodies (the `KNOWN GAP (#3837)` test).
- Merge, split, reorder, rename and refresh-titles (#3791) also compare titles by position (`parseTitlesPairWithState`). A title that drifted under a parser change (entity decoding, subtitle merge) is refused even though the pairing is fine, and the only exit is a re-parse, which discards the analysis, cast and audio.

Titles cannot tell parser drift from a reorder. Four title-rule variants were tried and broken on PR #3835. For chapters that have them, this plan uses the evidence the owner chose instead: the book's saved sentences. The check runs live on every call and writes nothing.

## Owner decisions (fixed, from #3837; not re-opened here)

Implementation decisions after checker round 5 (2026-10-31, on #3837). Both extend round 8 decision 1 ("stale evidence is ignored") to producers the earlier passes missed; neither is a new behaviour choice:

1. **A restructure on a marker-set book clears the analysis cache instead of rebuilding it.** `chapters-restructure.ts` (about line 531) rebuilds the cache from `manuscript-edits.json` (`rebuildCacheFromEdits`, `mode: 'replace'`), and exclude reaches it too (about line 698). On a marker-set book those edits are keyed to the old chapters. A later non-fresh main run replays them as current takes (`analysis.ts` about lines 6170–6181, `hasCurrentTake` in `store/analysis-cache.ts` about line 167), then clears the marker over stale evidence. This is also a **pre-existing `main` defect**: after a re-parse that changes the chapter list, a restructure re-seeds stale takes.
2. **A bundle overwrite that keeps a local `manuscript-edits.json` stamps the marker** (a third producer), because a portable bundle never carries edits (`export/build-portable-book.ts` about lines 349–354), while an overwrite leaves files the bundle lacks in place (`import/scan-import-folder.ts` about lines 15–19 and 449–454).

Round 8 (2026-10-31):

1. **Stale evidence after re-parse or replace-manuscript is ignored.** Both keep `manuscript-edits.json` keyed to the old chapter ids (`applyReparse`, `book-state.ts`: the preserved-edit count about lines 1662–1667, the change-log note "ids will be reconciled against the next analysis run" about lines 1760–1776, the new chapter list about line 1830, and the hints-file removal about line 1878). Without a guard, the check would refuse the re-parsed book again and its own "Re-parse" remedy would loop: `r5-reparse-marker.ts` shows the re-parsed Unlocked refused at 78 chapters and Keeper of the Lost Cities #1 at 1. Both operations now stamp state with a marker meaning "saved sentences predate this chapter structure", and the next analysis persist clears it. While the marker is set the book has no evidence, so today's count/id and title rules apply, and re-parse stays a working exit.
2. **Exclude/include writes hints only when the operation changes the chapter count** (the prune that renumbers), which is the case today's write exists for. A plain toggle writes nothing, so a reorder the check caught is never laundered into `persisted`. This keeps archived plan 51 invariant 2 for toggles. `chapters-restructure.test.ts` (about line 532) is reconciled.
- Implementation choice: the shipped rule **counts every saved sentence**, duplicates included, as the calibrated `round6.ts` does, for `E`, `own`, `alt` and the block walk.

Round 7 (2026-10-31): **the owner accepts the one remaining durable-miss class.** A restructure on a title-drifted analysed book can persist a pre-#3703 boundary shift of 2 or fewer evidence sentences (blind spot 1) through the restructure's own #3703 hints write, where `main` would refuse the restructure. The trade unblocks title-drifted analysed books for restructure. No workspace book has title drift today, so the unblock is proved on fixtures only.

Round 6 (2026-10-30):

1. **Restructure seam: sentences plus titles.** In the five refusing restructure operations, a chapter that has evidence is checked by the sentence rule, and an evidence-less chapter must pass today's positional title check. Title-drifted *analysed* chapters are unblocked. A paused book whose unanalysed tail has drifted titles stays restructure-refused, as on `main`. **Analysis start** keeps round 5: evidence-less chapters pass on count/id.
2. **Start fresh keeps `main`'s count/id check only**, so a book the check wrongly refuses can still be re-analysed without a destructive re-parse.
- Implementation choices: an impure `'parse'` record fails open exactly as on `main` (no re-hydrate); audio `[tag]`s are stripped anywhere on both sides; `alt` counts only sentences absent from the chapter's own piece.

Round 5 (scope): **check only, never persist**; orphan sentences are ignored (plan 70a keeps working); never-analysed books keep exactly today's rules. Folding, re-grouping, the contents guard and persisting a check move to #3879.

Still standing from earlier rounds: evidence is the saved sentences (round 1); a chapter's own pairing must score **≥40%** of its evidence AND beat its best alternative by **≥4×** (round 2); the evidence floor is **24 normalised characters**, the aligner's `ANCHOR_MIN_LEN` (round 3); the sentence normaliser strips the model's re-split quote marks (round 2); the displaced check refuses **≥3** of a chapter's evidence sentences found only in one other chapter's content, ordered by match position in the parse (rounds 3 and 4).

## Benefit / Rationale

- **User:** An analysed book whose chapter titles drifted under a parser change is **no longer refused** by merge, split, reorder, rename or refresh-titles, as long as the drift is on chapters that carry analysis evidence. Today its only exit is a re-parse. This is proved on fixtures: none of the 23 same-count analysed books in today's workspace has a drifted title, so none is blocked on `main` today. The benefit applies to the next parser change.
- **User:** A same-count reorder made before #3703 is **caught at analysis start and at restructure** when the moved chapters carry evidence. So are the PR #3835 swaps, and a boundary shift that moved 3 or more evidence sentences into one neighbour. Today analysis starts on such a book and rebuilds it from the wrong bodies. All 23 healthy books pass, and every evidence-chapter swap control is refused.
- **User:** **Every refusal keeps a working exit.** Start fresh (count/id only) re-analyses a book the check refuses at analysis start, and a re-parse stamps the stale-evidence marker so the re-parsed book is judged by today's rules instead of by sentences keyed to its old chapters.
- **Technical:** **The check itself makes nothing permanent.** It writes nothing, so a wrong answer lasts one call. The one write that does persist is a restructure's own #3703 write, unchanged from `main`, and an exclude/include toggle no longer writes at all. "Accepted blind spots" says exactly which misses a restructure can make durable.
- **Architectural:** Evidence-based pairing has one home, `workspace/hints-proof.ts`, a pure module. With no evidence (never analysed, all short sentences, or the marker set) it reduces to `main`'s rule at each seam, so there is no separate "never-analysed" branch to keep in step.

## Architectural impact

### One formula per seam

For a `'parse'` record that passes count/id, is pure, and has positional ids (below), each state chapter at index `i` is paired with parse piece `i` and judged by one rule:

| Position | Analysis start (main and subset; not Start fresh) | Restructure (merge, split, reorder, rename, refresh-titles; exclude/include on a prune) |
| --- | --- | --- |
| chapter has evidence | sentence rule (40% / 4×) + block check | sentence rule (40% / 4×) + block check |
| chapter has no evidence | passes (count/id only) | today's positional title check (`titleOverridden`, a `null` parse title, or an equal title) |

**There is no separate "not-analysed" mapping.** A book with no evidence anywhere has every position in the second row. At analysis start that is count/id only, `main`'s rule. At restructure it is `parseTitlesPairWithState` over every position, `main`'s rule again. The pure module still reports `evidenceChapters: 0` so the seams can log it.

### Pairing by index, and why that equals the transforms' pairing by id

The check pairs by **index**: state chapter `i` with parse piece `i`. The transforms pair by **id**: they sort the hints by id (`sortById`) and look each state chapter up by id. Reorder, for example, finds each hint by its old id and re-issues ids `1..N` in the requested order (`workspace/restructure.ts` about lines 1453–1457). Analysis keys its chapters by hint id too. The two pairings coincide exactly when `state.chapters[i].id === i + 1` and `record.chapterHints[i].id === i + 1`. Archived plan 51 invariant 1 guarantees the first after every structural operation (`buildNewStateChapters`), and import, re-parse and every parse produce `1..N` in order.

So the seam **asserts positional ids** as part of the "can the check run" gate. A book whose ids are a permutation of `1..n` out of order (count/id still passes, because that compares sets) violates invariant 1. No API path produces one. It falls back to `main`'s rule, like an impure record, rather than running a check whose pairing would differ from the one the transform is about to use.

### Order of checks at both seams

For a record with `hintsSource: 'parse'`:

1. **Count/id** (today's `assertHintsPairWithState` without `parseTitles`). On failure, each seam does exactly what it does today, and nothing below runs. This covers split drift (`m > n`, e.g. Unlocked), pre-#3703 user splits (`m < n`, e.g. Keeper of the Lost Cities #1) and pre-#3703 merges.
2. **Can the check run?** All of these must hold; otherwise the seam uses `main`'s rule on the in-memory record (count/id at start; count/id plus `record.parseTitles` at restructure), with no sentence check and **no re-hydrate**:
   - **purity:** `record.parseTitles !== undefined`, `record.chapterHints.length === record.parseTitles.length`, and `record.chapterHints.every((h, i) => h.parseIndex === i)`. A restructure that could not persist its result (`bodiesCurrent` false; `analysis.restructure-restart.test.ts` "a manuscript edited on disk after hydrate …", about line 246) leaves transformed hints in memory while `hintsSource` stays `'parse'`. The third checker pass (A1) showed that re-hydrating there swaps a fresh 4-chapter parse in against a 3-chapter state after count/id has passed, reopening the #3829 corruption. `book-state.refresh-titles.test.ts` (about lines 444–458, a `putManuscript` record with no `parseIndex`) keeps exercising an impure record and stays green unchanged.
   - **positional ids:** `state.chapters[i].id === i + 1` and `record.chapterHints[i].id === i + 1` for every `i` (above).
   - **edits readable:** `readEditsForHintsCheck` answered `ok` or `absent` (below). `corrupt` and `unreadable` fall back to `main`'s rule.
   - **no stale-evidence marker:** `state.sentencesPredateChapters !== true` (below). With the marker set, the seam uses `main`'s rule. That is the same verdict the check would reach with no evidence, without running it.
3. **Run `checkParseHintsPairing`** with that seam's evidence-less rule.

### The stale-evidence marker (round 8, decision 1)

- **Field:** `BookStateJson.sentencesPredateChapters?: true` in `server/src/workspace/scan.ts`. It means "the saved sentences in `manuscript-edits.json` are keyed to a chapter structure older than `state.chapters`". It is an additive optional field, so `CURRENT_STATE_SCHEMA` does not bump (archived plan 27, rename-vs-add policy). It is never written as `false`: `true` or absent. It is server-only (not in `openapi.yaml`, not on the PUT `/state` whitelist), like `editEpoch`. The PUT `/state` merge spreads the locked fresh read (`...state`), so a client save cannot drop it.
- **Who sets it** (three producers):
  1. `applyReparse` (`routes/book-state.ts`), the shared core of re-parse and replace-manuscript. It goes inside its existing `updateStateJsonLocked` mutation, the one that already rebuilds `chapters` and rotates `editEpoch` (about lines 1830–1855). It is set when `preservedEditCount > 0`, the count `applyReparse` already reads before the destructive arms; with no saved sentences there is nothing stale to mark. **Lock rules:** no new lock. The mutation already runs under `book-op` (the handlers hold it across the whole commit, #3711) → `book` (`withLocatedBook`) → the `state-json` leaf.
  2. **The bundle overwrite** (`import/scan-import-folder.ts` `commitOverwrite`). A portable bundle never carries `manuscript-edits.json`, and an overwrite leaves a file the bundle lacks in place, so a local edits file ends up beside the bundle's new chapter list. Before `writeStagedState(bookId, baseTitle, manuscriptId)` (about line 476), `commitOverwrite` reads the target's edits with `readEditsForHintsCheck(targetDir)`. It passes a flag so `writeStagedState` adds `sentencesPredateChapters: true` to the staged state only when **both** hold (owner round 10): (a) the edits result is `ok` with ≥1 sentence, or `corrupt` / `unreadable` (unknown content is treated as stale, the conservative reading); and (b) the bundle's chapter list (ids and titles, in order) differs from the target's **current** `state.json` chapter list, or the target's live `state.json` already carries the marker. The current state is the `live` read `commitOverwrite` already makes under the same hold; an absent or unreadable target state counts as "differs". `absent` or `ok` with no sentences stamps nothing, and a same-chapters restore leaves the marker absent, so generation, QA repair and splice overlay the saved corrections as `main` does. `writeStagedState` never carries a marker the bundle's own `state.json` holds: only this rule decides. The rename path and a fresh folder have no local edits and never stamp. The predicate is `swapLeavesStaleEvidence` (`workspace/stale-evidence.ts`), shared with the backup restore. The chapters compared are the target's `state.json` as read at the top of `commitOverwrite` (`live`), under `book-op` and the path claim. That excludes every writer that changes the chapter list, but not the GET `/state` title refresh (`refreshChapterTitles`, `book` → `state-json`, no `book-op`), which can still rewrite chapter **titles** between that read and the promotion. That narrow, title-only race is accepted by ruling: at worst it mis-stamps (or misses) the marker, and a mis-stamp lasts until the next main analysis run clears it. **Lock rules:** no new lock. The read runs inside `commitOverwrite`'s existing hold: `book-op` for the existing book id (taken before the claim, with the busy refusal) → `book-path-claim`. Every edits writer either takes `book` or `book-op`, or runs as a long job, which the busy refusal excludes. The stamped state then lands through the existing promotion under `state-json(target)`. A target with no `bookId` (`commitOverwrite(targetDir, null)`) has no `book-op` to take, exactly as today; its read is unlocked, like the rest of that path.
  3. **A backup restore** (`workspace/auto-backup.ts` `restoreBackup`, route `routes/backup.ts`; owner round 10). A restore swaps `state.json` for a snapshot and leaves `manuscript-edits.json` in place, so it applies the same rule as the overwrite, comparing the **snapshot's** chapter list with the book's current `state.json` chapter list (plus the current marker), against the local edits. The snapshot's own marker is never carried: it is stripped, then stamped per the rule. **Lock rules:** no new lock. The route holds `book-op`; `restoreBackup` reads the edits under `withLocatedBook`'s `book` lock, and reads the current state (`readStateJsonWithRecovery`, unreadable counting as "differs") inside the existing `state-json` leaf lock, right before its `writeStateJsonAtomic`.
- **Who clears it:** the **main** analysis persist only, in the same persist block that wrote `manuscript-edits.json` from `reconciled.sentences` (`analysis.ts` about line 7305). The marker is deleted inside that block's existing `state.json` write (the `updateStateAtDir` mutation under `book` → `state-json`). That write is reached only after the edits write in the same `try` succeeded, and is skipped on `attribution_drift` (which then leaves the marker, conservatively, set). A main run re-analyses every chapter after a re-parse, because re-parse wipes the analysis cache, so its sentences are all keyed to the current chapters.
  - **Not cleared by the subset persist** (`analysis.ts` about line 9496). A subset run rewrites some chapters' sentences and may leave the others keyed to the old structure. Leaving the marker set keeps those books on `main`'s rule until a main run, which is the conservative outcome.
  - **Not cleared by any other edits writer** (cast merge, script review, generation, QA repair, splice). None of them re-keys sentences to chapters.
  - **Not cleared by a restructure.** Its result state spreads the old state, so the marker survives, and its sentence remap applies to whatever ids the sentences carry.
- **Readers:** the two seams, through the "can the check run?" gate, and the analysis-cache refresh below.
- **The analysis cache while the marker is set** (implementation decision after checker round 5, item 1). One helper in `store/analysis-cache-rebuild.ts` replaces the direct `rebuildCacheFromEdits` calls at its four callers:

  ```ts
  /** Rebuild the cache from manuscript-edits.json unless those edits predate the chapter list. */
  export async function refreshCacheFromEdits(
    state: Pick<BookStateJson, 'manuscriptId' | 'sentencesPredateChapters'>,
    editsPath: string,
    opts: RebuildCacheOptions,
  ): Promise<'rebuilt' | 'cleared' | 'skipped'>;
  ```

  - **Marker set, `mode: 'replace'`** (the restructure, `chapters-restructure.ts` about line 531, reached by every op including exclude through about line 698): `clearAnalysisCache(manuscriptId)` instead of the rebuild → `'cleared'`. The restructure's ids are renumbered, so the old keys are no use anyway. It is called with the result state, which spreads the marker forward. It runs where the rebuild runs today: inside `applyRestructureClaimed`, after the leaf, still under `book-op` → restructure gate → `book`. `clearAnalysisCache` removes the file through the same per-path queue as `saveAnalysisCache` (#3427), so it lands after any save issued before it. The restructure gate and the busy refusal already exclude a running or draining analysis, so no in-flight run saves behind it.
  - **Marker set, overlay mode** (`generation.ts` about line 1099, `chapter-qa-repair.ts` about line 421, `chapter-splice.ts` about line 275): leave the cache untouched → `'skipped'`. Those callers keep chapter ids, so the cache holds nothing they would renumber, and only the edits are stale. Not re-seeding is enough, and it keeps any takes a partial run wrote under the current structure. Re-parse sets `castConfirmed: false` and removes audio, so these three are not normally reachable on a marker-set book. They take the same helper so no producer can re-seed stale takes.
  - **No marker:** the existing `rebuildCacheFromEdits` call, unchanged → `'rebuilt'`.
  - **Interaction with `hasCurrentTake`:** after a clear, `loadAnalysisCache` answers an empty cache (no `stage1`, no `chapters` keys). So `hasCurrentTake` is false for every chapter, the replay loop (`analysis.ts` about lines 6170–6181) replays nothing, and `analysisCompleteFor` is false. The next main run re-runs stage 1 and attributes every non-excluded chapter before its persist clears the marker. The cost: takes a paused main run wrote after the re-parse, before the restructure, are re-done. That is the conservative outcome. Generation on such a book halts with today's "No analysed sentences cached" until it is analysed, which is correct while the marker says the sentences are stale.
  - This also fixes the **pre-existing `main` defect** above; the PR body declares it under "Also fixed, found in passing".
- **Start fresh** deletes the edits file (the fresh-run `rm`) and its persist clears the marker like any main persist.

### The edits read (`workspace/hints-proof-io.ts`, new)

`analysis.edits-routing.guard.test.ts` pins every `manuscriptEditsJsonPath(` site in `analysis.ts` to the ordered write queue, so `analysis.ts` must not read the file itself. Both seams call:

```ts
export type EditsForCheck =
  | { kind: 'absent' }                                  // ENOENT
  | { kind: 'corrupt'; error: SyntaxError }             // JSON.parse failed (after the BOM strip)
  | { kind: 'unreadable'; error: unknown }              // any other read error
  | { kind: 'ok'; value: unknown; sha256: string };     // parsed JSON + sha of the bytes read
export async function readEditsForHintsCheck(bookDir: string): Promise<EditsForCheck>;
export function sentencesOf(value: unknown): Array<{ chapterId: number; text?: unknown; vocalization?: boolean }>;
```

The reader strips a leading UTF-8 BOM before `JSON.parse`, exactly as `readJson` does (`workspace/state-io.ts` about lines 184–188). Windows editors and PowerShell 5.1 write one, and `readJson` (today's restructure read) accepts such a file. `sentencesOf` returns `[]` for anything without a `sentences` array.

**Per-seam behaviour, so neither seam answers worse than `main`:**

| Result | Analysis start (`main` does not read edits) | Restructure, pre-leaf (new read) | Restructure, inside the leaf (today's read, replaced) |
| --- | --- | --- | --- |
| `absent` | check with no sentences = `main`'s rule → proceed if count/id passed | check with no sentences = `main`'s rule | `null`, as `readJson` gives today |
| `corrupt` | `main`'s rule (proceed if count/id passed) | `main`'s rule; **never throws here** | rethrow the carried `SyntaxError`, exactly what `readJson` throws today |
| `unreadable` | `main`'s rule (proceed), with a `console.warn` | `main`'s rule; **never throws here** | rethrow the carried error, as today |
| `ok` | run the check | run the check | the parsed value |

The pre-leaf read never throws, so the check adds no new failure: where `main` answers 200, so does this seam; where `main`'s own leaf read fails, this one fails identically.

### Seam 1: analysis start, main and subset (`routes/analysis.ts`)

`hintsOutOfSyncRefusal` (about line 3982) becomes `parseHintsStartCheck(manuscriptId, record, { fresh })` at both call sites (main about line 4066, subset about line 7887). It is **one lock-free, write-free span before the stream opens**: the same place and lock posture as #3829's check today. It reads the book through `peekBook` (lock-free) and gates a long job, exactly as today's `readStateJsonWithRecovery` read does. It is not CLAUDE.md's two-span pattern: there is no second, locked span, and "No second span after registration" explains why none is needed.

| Step | Outcome |
| --- | --- |
| `record.hintsSource !== 'parse'` | `proceed / not-parse` |
| no `record.bookDir` (with or without a `bookId`) | `proceed / not-on-disk`, `main`'s `!record.bookDir` return |
| a `record.bookDir` but no `record.bookId` (a legacy `state.json` with no `bookId`) | read `state.json` from `record.bookDir` with `readStateJsonWithRecovery`, exactly as today; a read failure or `null` → `proceed / state-unreadable` |
| both: `peekBook(record.bookId, record.bookDir)` returns `null` (book gone or moved out; the `BOOK_GONE` case) | `proceed / book-gone`; the route's later `runBookJob` answers `BOOK_GONE` as today |
| `peekBook` throws `BookStateUnreadableError` | `proceed / state-unreadable` (today's fail-open) |
| `state.manuscriptId !== manuscriptId` | `proceed / foreign-state` (today's fail-open) |
| count/id fails | `refuse / count-id` (today's refusal, verbatim) |
| **Start fresh** (`fresh: true`, main only) | `proceed / fresh`: no sentence check (round 6) |
| the check cannot run (impure, ids not positional, edits `corrupt` / `unreadable`, marker set) | `proceed / main-rule`, logging which |
| check pairs (including `evidenceChapters: 0`) | `proceed / checked` |
| check refuses | `refuse / score` or `refuse / displaced-block` |

```ts
type StartHintsVerdict =
  | { kind: 'proceed';
      why: 'not-parse' | 'not-on-disk' | 'book-gone' | 'state-unreadable' | 'foreign-state'
         | 'fresh' | 'main-rule' | 'checked' }
  | { kind: 'refuse'; why: 'count-id' | 'score' | 'displaced-block' };
```

`refuse` answers the existing `{ error, code: 'hints_out_of_sync' }` 409 built from `new HintsOutOfSyncError()`. The `why` goes only on the existing `[analysis] refused hints_out_of_sync` log line. A thrown error that is not `HintsOutOfSyncError` propagates as today's rethrow does. The check adds no `requestFailureMessage*` call site.

**No second span after registration.** The window between the pre-stream check and the job token can only change the pairing through these writers:

- a restructure persists its hints (the leased record is then `persisted`) or skips its write (the record is then impure, which takes `main`'s rule by design);
- re-parse and replace-manuscript put a record with no `hintsSource` (nothing to check), and stamp the marker;
- a rename's scan heal re-puts the **same** record object;
- a bundle overwrite with the **same** `manuscriptId` whose new content is a mispaired parse book, landing within milliseconds of an in-flight Start. This is the only real case left.

That last case analyses on the mispaired parse, as `main` does today, and nothing from the check is persisted. A second span would cost a new SSE refusal path: `openapi.yaml` (about lines 912–920) promises `hints_out_of_sync` never arrives as SSE, and the client refusal lists (`src/views/analysing.tsx` about line 810, `src/store/analysis-stream-middleware.ts` about line 358) would need a new entry and tests. It would also need an `await` placed before #3004's synchronous check-then-register window. The pre-stream 409 already reaches the client through `api.ts`'s existing mapping (`src/lib/api-analysis-stream-errors.test.ts`). **No client change.**

### Seam 2: restructure (`routes/chapters-restructure.ts`)

`applyRestructure` already runs inside `withBookOp` → restructure gate → `withBookLock`, and `applyRestructureClaimed` opens `withStateJsonLock` (the 10-second leaf) around the fresh read → transform → write. **The check never runs inside the leaf (A6).** It runs under `book`, before `withStateJsonLock`:

1. `record = await getOrHydrateManuscript(manuscriptId)` (unchanged).
2. **New, under `book`, before the leaf**, when `record.hintsSource === 'parse'`:
   - read `state.json` with `readBookStateOrThrow(bookDir)` (the recovering read; `state-json-read.guard.test.ts` stays green). `null` → do nothing here; the leaf's own read answers 404, as today. `BookStateUnreadableError` propagates; the route answers its curated message, as today.
   - count/id fails, or the check cannot run (gate step 2) → `pairing = { mode: 'main' }`.
   - otherwise run `checkParseHintsPairing` with the title rule at evidence-less positions → `pairing = { mode: 'checked', paired, chapterIds, manuscriptId, editsKind, editsSha }`.
3. **Inside `withStateJsonLock` (unchanged position).**
   - In `checked` mode, the fresh `state.json` must have the same `manuscriptId`, the same chapter **id sequence** and no marker, and the edits read must give the same `kind` and (for `ok`) the same bytes sha. The leaf's existing `readJson(editsPath)` becomes `readEditsForHintsCheck`, with the table above's leaf semantics, so there is no extra read. On a mismatch the leaf answers 409 `hints_out_of_sync`, writes nothing and logs `[chapters-restructure] pairing inputs changed under the book lock`. This is expected to be unreachable. Every writer of the chapter list or the edits either takes `book`, or is reached only through `book-op`, which this route holds. The bundle overwrite (`scan-import-folder.ts`) is the `book-op`-only one: it takes `state-json` alone, never `book`. Long jobs are refused up front. It is a fail-closed backstop that keeps "the check's inputs are the transform's inputs" exact.
   - **The refusal flag**, `hintsMispaired`: `main` mode → today's `parseTitlesPairWithState(state, record.parseTitles)`, verbatim; `checked` mode → `!paired`; `persisted` record → `false`, as today.
   - **`parseTitles` handed to the transform:** `main` mode → `record.parseTitles` (today); `checked` mode → `undefined` (the check already applied the title rule where round 6 wants it). The transforms' own `assertHintsPairWithState` still runs count/id.
   - **Refusal:** `refuseWhenMispaired` becomes `true` for merge, split and reorder as well as rename and refresh-titles. In `checked` mode the transform no longer title-checks, so the early refusal must cover all five. In `main` mode the early refusal and the transform's own title assert reach the same verdict on the same inputs, so behaviour is unchanged.
   - **Exclude / include (round 8, decision 2):** never refused on a toggle. After the transform, compare `result.state.chapters.length` with the pre-transform count:
     - **same count (a toggle):** write **no** hints file, for every record source. A toggle changes no id or uuid, so a persisted entry still validates and a parse book stays a parse book. Nothing is laundered into `persisted`.
     - **count changed (the prune that drops a chapter with no sentences and an empty body and renumbers, `pruneEmptyChaptersInResult`):** a `persisted` record writes as today. **A record with no `hintsSource`** writes as today too. That is the in-session record a re-parse, replace-manuscript, import or sample builds alongside `state.json` from one parse (`book-state.ts` about lines 1887–1903 for re-parse), so its bodies are the chapters' own and there is nothing to check. A `parse` record writes only when the book pairs. "Pairs" includes count/id (owner round 9, Task 4 fix round 1): the record's ids must pair with state's **before the transform**, and then the book must be `paired` in `checked` mode, or `!hintsMispaired` (the title rule) in `main` mode. **Otherwise the operation answers 409 `hints_out_of_sync` and writes nothing** (Q1). A toggle on such a book still succeeds and writes no hints. The prune decides which chapter has "an empty body" from the hint bodies. On a book whose bodies are not paired with its chapters, it can drop the wrong chapter and renumber the rest. `main` writes that result (`state.json`, edits, audio). It writes no hints file when the result's hints and chapters differ in number, and the book is then refused on count at later seams. But the prune keeps only the hints whose ids survive, so a count/id-failing book (split drift with more parse pieces than chapters, or a parse whose surplus pieces are dropped with the pruned one) can come out with equal counts: `main` then writes a hints file whose bodies are not the chapters', and after a restart the book hydrates `persisted` and passes count/id at every later seam. Refusing writes nothing.

The `excluded` / `titleSynthesized` completion of earlier revisions stays moot: the transform receives `record.chapterHints` as built by `hintsFromParse`. The `isLikelyFrontMatterTitle` default in `hintsFromParse` still reads the parse title, unchanged.

### What is written, and what is not

- The check writes nothing at either seam.
- `applyReparse`, the bundle overwrite and a backup restore write one more state field (the marker), inside their existing state writes. The main analysis persist deletes it, inside its existing locked state write. While the marker is set, a restructure removes the analysis cache instead of rebuilding it, and the overlay rebuilds leave it alone (`refreshCacheFromEdits`).
- **A restructure that the check lets through still writes its own result**, through the existing `hintsWritten` branch, as `main` does for any parse-fallback book that passes its title check. Because evidence-less positions keep the title check (round 6), it persists only what `main`'s title rule would also accept at evidence-less positions. At evidence positions it can persist a pairing the title rule would refuse. That is the title-drift unblock, and the durable miss the owner accepted in round 7.
- An exclude/include toggle writes no hints file. A prune writes only on a paired or persisted book.

### Cost

The check runs once per Start and once per restructure call, **including every rename and every exclude/include toggle**, with no cache, because state, edits and record can change between calls. The 8-gram index is the cost:

- a transient heap of about **61–82 MB** on the largest workspace books;
- **157–268 ms of synchronous time** for the index alone.

The whole check measured **0.3–0.75 s** on the largest books (Stellarlune, Neverseen, Ночной дозор), on a loaded box. So a rename or an exclude click on such a book can take up to about 0.75 s longer under the `book` lock.

**It does not yield.** Each seam is one user action, and a restructure already holds `book` across synchronous parses of the same size. Chunking the index build would put `await`s into a lock span for a sub-second gain. If a much larger book appears, moving the check to a worker thread is the change to make; it is not part of this plan.

### Migration and reversibility

No schema bump, no file or API shape change. To revert:

- delete `hints-proof.ts` and `hints-proof-io.ts`;
- restore `hintsOutOfSyncRefusal`, the restructure's title-only `hintsMispaired` and exclude's write rule;
- revert the OpenAPI descriptions.

A `sentencesPredateChapters` field left in a `state.json` by this version is ignored by the reverted code (an unknown optional field).

## The check (`workspace/hints-proof.ts`, pure, no I/O, no lock)

All score arithmetic is integer. Every tie-break is by index, so the check is deterministic.

### API

```ts
export interface PairingInput {
  /** state.chapters in order; the caller has asserted ids 1..n in order. */
  stateChapters: ReadonlyArray<{ id: number; title: string; titleOverridden?: boolean }>;
  /** manuscript-edits.json sentences, any order (sentencesOf(value)). */
  sentences: ReadonlyArray<{ chapterId: number; text?: unknown; vocalization?: boolean }>;
  /** The record's pure-parse pieces in order: title = record.parseTitles[j] (null where the parser
      made it up), body = record.chapterHints[j].body. Same length as stateChapters (count/id passed);
      a length mismatch throws (a programming error). */
  parse: ReadonlyArray<{ title: string | null; body: string }>;
  /** What an evidence-less position needs: nothing (analysis start) or today's title check (restructure). */
  evidenceLess: 'count-id' | 'title';
}

export type PairingResult =
  | { paired: true; evidenceChapters: number }
  | { paired: false; evidenceChapters: number; reason: 'score'; chapterId: number; own: number; alt: number; evidence: number }
  | { paired: false; evidenceChapters: number; reason: 'displaced-block'; chapterId: number; intoChapterId: number }
  | { paired: false; evidenceChapters: number; reason: 'title'; chapterId: number };

export function checkParseHintsPairing(input: PairingInput): PairingResult;
export function normaliseForProof(s: string): string;
export function normaliseSentenceForProof(s: string): string;
export const PROOF_OWN_MIN_NUM = 2, PROOF_OWN_MIN_DEN = 5;   // 40%
export const PROOF_MARGIN = 4;
export const PROOF_EVIDENCE_MIN_LEN = 24;
export const DISPLACED_BLOCK_LEN = 3;
```

The `title` rule is `parseTitlesPairWithState`'s per-position test: `titleOverridden === true || parseTitle == null || state.title === parseTitle`. Extract it in `workspace/restructure.ts` as `titlePairsAt(chapter, parseTitle)`, with `parseTitlesPairWithState` calling it, and import it here so the two can never drift. `hints-proof.ts` also imports `AUDIO_TAGS` from `parsers/audio-tags.ts`, a leaf module, and nothing from `store/`, `routes/` or `analyzer/`. Declare `PROOF_EVIDENCE_MIN_LEN` locally, with a comment citing `analyzer/dialogue-structure/aligner.ts` `ANCHOR_MIN_LEN`.

### Normalisation

- **`normaliseForProof(s)`** (content side, and the first step of the sentence side), in this order:
  1. decode HTML entities: numeric `&#…;` / `&#x…;`, plus the named set `rsquo lsquo ldquo rdquo mdash ndash hellip amp nbsp apos quot lt gt`;
  2. Unicode NFC;
  3. fold `‘’‚‛‹›′` → `'`, `“”„‟«»″` → `"`, `‐‑‒–—―−` → `-`, and `…` → `...`;
  4. `ё` → `е`, `Ё` → `Е`;
  5. lower-case;
  6. remove every audio tag **anywhere**, with the whitespace that follows it: `/\[(emphatic|shouting|whispers|laughs|sighs|excited|hesitant)\]\s*/g`, built from `AUDIO_TAGS`;
  7. collapse every whitespace run (including NBSP) to one space, and trim.
- **`normaliseSentenceForProof(s)`**: `normaliseForProof(s)`, then strip a leading and a trailing run of whitespace, `"`, `'` and `` ` ``.

`He said, "[excited] Go!"` and `He said, "Go!"` both normalise to `he said, "go!"`. Only the analyzer's own tag vocabulary is removed. Manuscript text in brackets survives: Unlocked carries real lines such as `[FILE INACCESSIBLE]` and `[AND NOW…]`.

`util/text-match.ts` `normaliseForMatch` is a subset of this (no entities, NFC, ё, extra dashes or tags). Do **not** change its behaviour: the evidence verifier depends on it.

**Candidate content** for parse piece `j` is `normaliseForProof((title ?? '') + '\n' + body)`. The title is included because subtitle-merge drift (parser version 2) moves a subtitle line between a title and its body, and an older analysis may hold that line as a sentence.

### Evidence (A5, A9)

- A saved sentence **counts** when `vocalization !== true`, its `chapterId` is a state chapter id, and `normaliseSentenceForProof(String(text ?? ''))` is non-empty. Vocalizations are text the analyzer wrote, not manuscript text. `excludeFromSynthesis` sentences are manuscript residue, so they count.
- **Orphans** (a `chapterId` not in state) are ignored: neither evidence nor alternatives. The calibration found 0 orphans on all 25 analysed books.
- Chapter `i`'s **evidence** is its counted sentences whose normalised length is at least 24. **Each saved sentence is one item, duplicates included**: a line saved three times is three items (round 8 implementation choice, as calibrated). Shorter sentences ("Yes.", "okay,") are not used at all.
- `E_i` is the number of chapter `i`'s evidence items. A chapter with `E_i = 0` is **evidence-less**: excluded front matter, the unanalysed tail of a paused book, a chapter whose sentences are all short, or any chapter of a book with the marker set.
- **File order is not used anywhere (A5).** `splitSentence` gives later pieces a book-wide `maxId + 1` id, and they are re-sorted to the chapter's end. Scoring is containment, and the block walk orders by match position in the parse.

### Occurrence index

Concatenate the candidate contents with a `U+0001` separator. Index every 8-character window that contains no separator in a `Map<string, number[]>` of offsets. Each evidence item (always ≥ 8 characters) looks up its first 8 characters, then verifies each candidate with `startsWith`. Occurrence lists are memoised per distinct normalised text, so duplicates cost one lookup. Each offset maps to its piece by binary search over piece start offsets.

### Per-chapter rule (positional; same count is guaranteed by count/id)

For each evidence chapter `i`, over its evidence **items**:

- `inOwn(x)` = item `x` has an occurrence in piece `i`;
- `own` = the number of items with `inOwn`;
- `alt` = the largest, over pieces `j ≠ i`, of the number of items **without `inOwn`** that have an occurrence in piece `j` (round 6: an item also in the own piece never counts against it); 0 when `m = 1`;
- **pass** when `own * PROOF_OWN_MIN_DEN >= E_i * PROOF_OWN_MIN_NUM` (≥40%) **and** `own >= PROOF_MARGIN * alt`.
- The first failing chapter in state order → `reason: 'score'`.

For each evidence-less chapter `i`, when `evidenceLess === 'title'`: `titlePairsAt(state[i], parse[i].title)` must hold, else `reason: 'title'`.

### Block-displacement check

For each evidence chapter `i` that passed the rule, in state order:

1. For each evidence **item** that occurs somewhere:
   - if it occurs in piece `i`, its **position** is its first own-piece occurrence's offset in the concatenation, and it is **own**;
   - otherwise its position is its first occurrence, and its **target** is the piece holding its occurrences, or `none` when they fall in more than one piece.
2. Sort by position. Ties are broken by own items first, then by normalised text. File order is never consulted, which keeps A5 true. Two items share a position only when they are the same text (a duplicate) or one is a prefix of the other at the same offset; duplicates are identical items, so their relative order cannot change the walk. Items found nowhere are left out: they neither extend nor reset a streak.
3. Walk the sorted list. An own item resets the streak. A displaced item extends the streak when its target equals the streak's target and is not `none`; otherwise it starts a new streak of 1, so a `none` item breaks a streak.
4. A streak of `DISPLACED_BLOCK_LEN` (3) → `reason: 'displaced-block'`.

**What the ordering means in practice.** Own items sit in piece `i`'s offset range, and items displaced into piece `k` sit in piece `k`'s range. So items displaced into one piece are adjacent unless a `none`-target item's first occurrence falls between them. The check therefore reads "3 of chapter `i`'s evidence items found only in the same one other chapter's content, with no `none` item between them". It does not depend on how the analysis ordered them. Isolated common phrases and a recap chapter's quotations target different pieces or `none` (calibration: Юный дрессировщик has 4 isolated displaced items and 0 blocks).

Because duplicates are separate items, one line saved three times that the parse holds only in another chapter forms a block of 3 and refuses (`r4-mut.ts`: "dup ×3 displaced"). No healthy book trips it, and the calibration counted the same way.

### Expected outcome per known shape

| Shape | Analysis start | Restructure (5 refusing ops) |
| --- | --- | --- |
| Never-restructured analysed book, titles drifted on evidence chapters | starts (as today) | **proceeds** (today: refused by the title rule) |
| Paused or partly analysed book, title drift only in its unanalysed tail | starts (as today) | refused by the title check at those positions (as today; round 6) |
| Same-count reorder before #3703 that moved ≥1 evidence chapter (sentences remapped with it) | **refused** (`score`) (today: starts) | refused (`score`) |
| PR #3835 epigraph swap / lead section swapped with "Chapter 2", either swapped chapter with evidence | **refused** (`score`) | refused |
| Renamed "Chapter N" heading on an evidence chapter | starts | **proceeds** |
| Merge-then-split before #3703 that moved ≥3 evidence items into one neighbour, uninterrupted, score still passing | **refused** (`displaced-block`) | refused |
| Boundary shift of ≤2 evidence items plus any short ones, or a longer shift interrupted by `none` items | starts | proceeds (blind spot 1) |
| Reorder that permutes only evidence-less chapters | starts | proceeds only if their titles still pair positionally (blind spot 2) |
| Never-analysed book (no evidence) | `main`'s rule: count/id | `main`'s rule: count/id + title |
| Re-parsed or replaced manuscript, edits kept (marker set) | `main`'s rule: count/id → **starts** (without the marker: refused, the loop) | `main`'s rule: count/id + title → proceeds; **clears** the analysis cache instead of rebuilding it from the old-keyed edits (today: rebuilds, re-seeding stale takes) |
| Bundle overwrite onto a book with a local `manuscript-edits.json` | marker set → `main`'s rule → starts | marker set → `main`'s rule |
| Parser split drift, `m > n` (Unlocked, 82 vs 167) | refused by count/id (as today; #3879) | refused by count/id |
| Pre-#3703 user split, `m < n` (Keeper of the Lost Cities #1, 59 vs 57) | refused by count/id (as today; #3879) | refused by count/id |
| Pre-#3703 merge | refused by count/id (as today) | refused by count/id |
| Impure record, ids out of order, or edits corrupt / unreadable | `main`'s rule | `main`'s rule |
| Orphan sentences (plan 70a) | ignored | ignored; orphan recovery runs as today |
| Analysed chapter rewritten past 40% / 4× (heavy script-review edits) | **refused**; **Start fresh** still starts | refused; re-parse sets the marker, then proceeds |
| Exclude/include toggle on any book | — | proceeds; **writes no hints file** (today: writes when titles pair) |
| Exclude/include that prunes, record with no `hintsSource` (in-session after re-parse / replace / import) | — | proceeds and writes hints, as today |
| Exclude/include that prunes, on a paired or persisted book | — | proceeds and writes hints, as today |
| Exclude/include that prunes, on an unpaired parse book, including one whose count/id fails | — | **409**, nothing written (today: writes state, and on a count/id failure can write a hints file and make the book `persisted`) (Q1) |
| `state.json` unreadable, foreign `manuscriptId`, or book gone at start | starts (fail-open, as today) | today's 404 / curated unreadable answer |

### Accepted blind spots (stated honestly)

1. **A boundary shift the block walk cannot see:**
   - up to 2 evidence items displaced into one neighbour, plus any number of short sentences;
   - or more, when every run of 3 displaced items is interrupted, by parse position, by a `none`-target item (one whose occurrences fall in more than one other piece, such as a common line also present elsewhere).

   A merge-then-split before #3703 that moved a few lines across a chapter boundary is not detected in either case. The Everblaze positive control shows how much this matters in practice: moving the last 3 long paragraphs of chapter 21 into chapter 22 displaced only 2 evidence items, because the model splits dialogue into short pieces, and the check passed. The same shift on Ночной дозор (long narrative paragraphs) was refused. This is the durable-miss class the owner accepted in round 7 for title-drifted books.
2. **A reorder among evidence-less chapters.** At analysis start it is not detected. At restructure it is detected only when their titles disagree positionally, exactly as on `main`. The Coalfall Commission control is the live case: its two evidence-less, excluded front-matter chapters share the title "The Coalfall Commission", so swapping them is invisible to every rule, `main`'s included.
3. **A reorder of a never-analysed book's app-titled chapters**, including a re-parsed book under the marker. This is today's title rule's documented blind spot, unchanged.

**Consequence.**

- At **analysis start**, a miss lets one analysis run on a mispaired parse, exactly as `main` does today, and nothing records the pairing as trusted.
- At **restructure**, a miss lets one restructure run, and its own #3703 write makes the pairing durable. Compared with `main`, the only new durable-miss class is blind spot 1 on a title-drifted analysed book (round 7, accepted). Everywhere else `main` would have accepted and persisted the same pairing.
- A false **refusal** is never permanent. Start fresh re-analyses without a sentence check, and a re-parse sets the marker, so the book is judged by today's rules until its next main analysis.

## Invariants to preserve

- Lock order `design` → `library-voice` → `book-op` → `book-path-claim` → `cast` → `book` → `state-json` (CLAUDE.md):
  - analysis start takes no lock for the check;
  - restructure adds no lock: the check runs inside its existing `book` hold, before `state-json`;
  - the marker is set and cleared inside existing writes: re-parse and the analysis persist under `book` → `state-json`; the bundle overwrite under `book-op` → `book-path-claim`, promoted under `state-json(target)`;
  - the cache clear on a marker-set restructure runs where today's rebuild runs (under `book-op` → gate → `book`, after the leaf), on the same per-path queue as cache saves.

  `workspace/book-op-lock.guard.test.ts`, `workspace/state-json-lock.guard.test.ts`, `workspace/state-lock.guard.test.ts` and `workspace/state-json-read.guard.test.ts` stay green.
- `routes/analysis.edits-routing.guard.test.ts` stays green: `analysis.ts` gains no `manuscriptEditsJsonPath(` site.
- The check never runs inside `withStateJsonLock` (A6).
- The check writes nothing: no new caller of `writeManuscriptHints`, `writeStateJsonAtomic` or any edits writer.
- Books with no evidence, books with the marker set, count/id failures, impure records, ids out of order, corrupt or unreadable edits, and Start fresh: behaviour identical to `main` at both seams. The one exception is the exclude/include write rule (round 8, decision 2).
- `hints_out_of_sync` is a pre-stream 409 only, never an SSE event. Its body is the existing `HintsOutOfSyncError` one; the reason is only logged.
- `util/text-match.ts` `normaliseForMatch` output is unchanged.
- `workspace/hints-proof.ts` imports only `parsers/audio-tags.ts` and `workspace/restructure.ts`'s title predicate. `npm run check:cycles` reports no new cycle.
- Plan 70a orphan recovery (`chapters-restructure.test.ts`, "plan 70a — orphan recovery (Part F)", about lines 858–946) keeps passing unchanged.
- Archived plan 51 invariant 1 (ids `1..N` in narrative order) is relied on, and asserted at the seam.

## Test plan

### Automated coverage

All new and changed tests are server Vitest. Run every analysis-route test with `OLLAMA_URL=http://127.0.0.1:1` (the repo's standing guard against live-Ollama leaks). `chapters-restructure.test.ts` is in `server/vitest.config.slow.ts`'s `SLOW_FILES`: run it from `server/` with `npx vitest run -c vitest.config.slow.ts src/routes/chapters-restructure.test.ts`. The default config excludes it.

**The 14-file seam set.** These server test files seed `manuscript-edits.json` and drive Start analysis or a restructure route (third checker pass; confirmed by grep for an edits write plus an analysis-start or restructure request):

1. `server/src/routes/analysis.restructure-restart.test.ts`
2. `server/src/routes/analysis.test.ts`
3. `server/src/routes/analysis.title-flags.test.ts`
4. `server/src/routes/analysis.title-source.test.ts`
5. `server/src/routes/book-op.quick-routes.test.ts`
6. `server/src/routes/book-state.fs-error-bodies.test.ts`
7. `server/src/routes/book-state.refresh-titles.origin-lifecycle.test.ts`
8. `server/src/routes/book-state.reparse-lock.test.ts`
9. `server/src/routes/book-state.reparse.manuscript-hints.test.ts`
10. `server/src/routes/book-state.revision-precondition.test.ts`
11. `server/src/routes/chapters-restructure-exclude.busy.test.ts`
12. `server/src/routes/chapters-restructure.manuscript-hints.test.ts`
13. `server/src/routes/chapters-restructure.test.ts` (slow config)
14. `server/src/routes/selection-error-coding.test.ts`

Static audit of what each seeds:

- **Short sentences only** (no evidence → `main`'s rule; unchanged by the check): 5–9, 11, 12, 14, and `chapters-restructure.test.ts`'s default fixture.
- **Distinct per-chapter lines already in the body** (`lineFor(name)`; pair): 1.
- **Records with no `hintsSource`** (`putManuscript` fixtures; the check never runs): 2.
- **One identical `LINE` in every chapter and every section:** 3 and 4. Under the absent-from-own `alt` these pair (`own = 1, alt = 0`), so they are unchanged by the check. File 3 still needs distinct lines so its reorder test can refuse.
- **24+-character sentences that are not in their manuscript:** two `chapters-restructure.test.ts` fixtures (below), which the restructure check would refuse.
- **The re-parse files (8, 9)** will see the new marker in `state.json` when they seed edits. They must not assert byte-exact `state.json` after a re-parse. Task 2 confirms this and adjusts any that do.

**Every task's acceptance runs this whole set** (with the slow config for file 13). There is no "re-run later" step: a task is not done while any of the 14 is red.

**`server/src/workspace/hints-proof.test.ts` (new).** Hand-built fixtures, not real books. Each line names the mutation it catches (see "Mutations"):

- **normalisation:** named and numeric entities, NFC, curly quotes, guillemets, the dash set, the ellipsis, ё/е, case, whitespace runs.
  - Tags: `[excited] x`, `"[excited] x"`, `He said, "[excited] Go!"`, a tag mid-sentence, and the same tag on the content side all normalise without it.
  - `[FILE INACCESSIBLE] x` keeps its brackets.
  - `normaliseForMatch` output is unchanged on the same inputs.
- **rule boundaries (M1, M2):** `E = 10`: `own = 4, alt = 0` pairs and `own = 3, alt = 0` does not; `own = 8, alt = 2` pairs, `own = 6, alt = 2` does not, `own = 9, alt = 2` pairs.
- **`alt` counts only items absent from the own piece (M13):** a chapter whose 5 evidence items all also appear verbatim in the next chapter (a recap) pairs.
- **every saved sentence counts (M21):**
  - the edits hold a refrain saved 8 times plus 2 other evidence sentences, all in the own piece, and the chapter pairs. Counting distinct texts for `own` against raw `E` refuses it, as `r4-mut.ts` "refrain ×8" shows.
  - **12 own items** plus a line saved 3 times that the parse holds only in the next chapter is refused **`displaced-block`**. With 12 own items the score passes (`E = 15, own = 12, alt = 3`), so the block walk is what refuses. With fewer own items (7 or 11) the score refuses first, and the fixture would not pin the block reason (`r6-m21-m5.ts`). Distinct-text counting (the mutant) pairs it. Both verdicts are measured in `r7-fixtures.ts`.
- **evidence floor, M3:** the fixture is in `r5-m3m4.ts`. Each of 3 chapters has 4 unique 30+-character sentences in its own piece. Chapter 1's edits also hold three 20–23-character lines (`'The lamp flickered out.'`, `'Nobody answered at all.'`, `'Rain hit the window.'`) that the parse holds only in piece 2. Floor 24: pairs. Floor 20 (the mutant): refused `score` (`E = 7, own = 4, alt = 3`). Measured by the probe.
- **evidence floor, M4:** a same-count reorder whose only evidence sentences are 25–26 characters (`'The bells rang out twice.'`, `'A grey gull stole the bun.'`, `'The ferry left without us.'`, each mid-body after `'It began.'`), checked with `evidenceLess: 'count-id'`. Floor 24: refused `score`. Floor 28 (the mutant): no evidence → pairs. Measured by the probe. With `evidenceLess: 'title'` the title rule could mask the mutant, so the test pins `'count-id'`.
- **floor pin, exactly 24 (M29):** a same-count swap whose only evidence lines are exactly 24 normalised characters (`'The bells rang out at 9.'`, `'A gull stole a bun at 7.'`, `'The ferry left us at 10.'`, each mid-body after `'It began.'`), under `'count-id'`. `>= 24` (shipped): refused `score`. `> 24`, `>= 25` and `>= 26` (the mutants): no evidence → pairs. All four verdicts are measured in `r7-fixtures.ts`. This pins `>=` against `>`, which the M3 and M4 fixtures cannot.
- **tags (M5):**
  - a chapter whose evidence is 4 sentences carrying a mid-sentence tag plus 1 plain sentence pairs; without the strip, own is 1 of 5 and it is refused.
  - **12 own plain items** plus 3 tagged sentences that the parse holds only in the next piece are refused **`displaced-block`**. The score passes, so the block is the reason. Without the strip (the mutant) the 3 are found nowhere and the chapter pairs. Measured in `r7-fixtures.ts`. The earlier 5-item version was refused on score, not block (`r6-m21-m5.ts`).
  - a content-side tag in the manuscript body does not break a match.
- **model re-splitting (M6):** a quotation re-split into pieces, each re-wrapped in its own quote marks, pairs.
- **vocalizations (M7):** 6 vocalization sentences of 24+ characters not in the manuscript, plus 2 real ones, pair.
- **orphans (M8):** sentences with a `chapterId` not in state, including some whose text is in another chapter's content, pair.
- **A5:** a chapter whose split-sentence pieces sit at the end of file order still pairs.
- **block check (M9, M10):**
  - exactly 3 evidence items displaced into one neighbour, score still passing, are refused; 2 pair;
  - 3 displaced into 3 different pieces pair;
  - a `none`-target item sorting between displaced items breaks the streak (blind spot 1), and an item found nowhere neither breaks nor extends it;
  - **file order ≠ parse order:** the edits list the chapter's sentences as D1, O1, D2, O2, D3, while by parse position the three D's are consecutive. This is refused.
- **evidence-less positions (M11, M12):**
  - a paused book (evidence in chapter 1 only) whose chapters 2–3 have drifted titles pairs with `evidenceLess: 'count-id'` and is refused `title` with `'title'`;
  - a book with no evidence and one disagreeing title is refused `title` under `'title'` and pairs under `'count-id'`.
- **title in candidate content (M14):** a chapter whose only evidence sentence is a subtitle line the parse now holds in its title pairs.
- **refusals:** a same-count reorder of two evidence chapters; the PR #3835 epigraph swap; the lead section swapped with "Chapter 2". A renamed "Chapter N" heading on an evidence chapter pairs.
- **length mismatch** throws.
- **runtime:** a synthetic 90-chapter, 10,000-sentence fixture checks in under 2 s in Vitest.

**`server/src/workspace/hints-proof-io.test.ts` (new):**

- `absent`;
- `ok` (with the sha of the bytes);
- `ok` for a file with a UTF-8 BOM (M22);
- `corrupt` carrying the `SyntaxError`;
- `unreadable` (a directory at the edits path gives `EISDIR`);
- `sentencesOf` on non-array shapes.

**Fixture preparation (Task 2; green on today's code).** Every fixture that writes analysis evidence gets distinct per-chapter text that also appears in that chapter's body, **mid-body**:

- **The neutral first line** under each heading must not be a subtitle. `parsers/text.ts` `findSubtitle` (about lines 265–278) merges the first non-blank line after a heading into the title when it is short, is not a chapter heading, does not end in `.` or `!`, and looks like a title. So the neutral line is a short full sentence ending in `.`, for example `'It began.'`.
- **The evidence line goes after it.**
- **No edits file is deleted**, and no sentence is shortened below 24 characters.

Changes:

- `server/src/routes/analysis.title-flags.test.ts`:
  - `LINE` becomes `lineFor(n)`, a distinct ≥24-character sentence per chapter position that keeps the shared stage-1 evidence quote (`'"The plan is set." Silence followed by rain.'`, `'… by snow.'`, `'… by wind.'`, `'… by fog.'`).
  - Each manuscript puts `It began.` then `lineFor(k)` under its k-th section.
  - `seedBook` writes `lineFor(i + 1)` for state position `i`, unless a test passes `sentencesFor?: (stateIndex: number) => string | string[]`.
  - `phase1Selection().runStage2Chapter` returns `lineFor(chapterId)`.
- `server/src/routes/chapters-restructure.test.ts`: two refresh-titles fixtures seed 24+-character sentences that are not in their manuscript:
  - `promotes first-sentence candidate when title is generic …` (about line 1622): 'Registry File For Wren Sparrow', '"Hello," she said softly.' (24 after the quote strip) and the long sentence;
  - `skips chapters with titleOverridden=true (plan 78)` (about line 1791): 'Tempting Candidate For Chapter One/Two/Three'.

  Each chapter's sentence text goes mid-body in its section of that test's manuscript. `preserves user-customized chapter titles …` (about line 1689) and the single-chapter `a re-derived title the parser itself made up stays flagged` need nothing.
- `book-state.reparse-lock.test.ts` and `book-state.reparse.manuscript-hints.test.ts`: if either compares `state.json` after a re-parse byte-for-byte or with `toEqual` on the whole object, it is narrowed to the fields it is about, or made to expect the marker. Changes made in Task 2 must stay green on today's code, so any marker expectation lands in Task 3 with the marker itself.

**Restructure tests (Task 4): `server/src/routes/chapters-restructure.hints-proof.test.ts` (new).** Its own analysed fixture (distinct ≥24-character sentences per chapter, mid-body in the manuscript and in the edits) is run through merge, split, reorder, rename, refresh-titles, exclude and include:

- title drift on evidence chapters: the five refusing ops answer 200 and write their hints file as today.
- title drift on an evidence-less chapter (a paused book's tail): the five refusing ops answer 409 (round 6).
- a same-count reorder with remapped sentences: the five refusing ops answer 409, and every file is byte-identical (the `snapshotDisk` pattern from `chapters-restructure.test.ts`).
- **exclude/include toggle writes no hints file (M20a):** on a paired book, on an unpaired book, and on a `persisted` book (whose existing file stays byte-identical).
- **prune (M20b):**
  - an exclude whose prune drops an empty chapter, on a paired book: 200, the hints file is written, and a restart hydrates `persisted`;
  - the same prune on an unpaired book: 409 and every file byte-identical;
  - the same prune on a book with no evidence whose titles pair: 200 and written, as `main` does;
  - the same prune in `main` mode (stale-evidence marker set) on a title-mispaired book: 409 and every file byte-identical;
  - a prune on a parse book whose count/id fails (3 state chapters against a 4-piece parse, m > n; and m < n): 409 and every file byte-identical. A toggle on the m > n book answers 200 and writes no hints.
- a book with no evidence and a title mismatch: merge answers 409 (M12 at the restructure seam).
- orphans: the analysed fixture plus 24+-character orphan sentences (`chapterId: 99`). Merge answers 200, and the orphans are recovered onto a surviving chapter.
- the gate (M19): an impure record, ids out of order (`state.chapters` ids `[2, 1, 3]` with matching parse count), a BOM'd edits file (checked as `ok`) and a corrupt edits file all take `main`'s path. The corrupt file answers exactly what `main` answers for the same book, which the test pins by running the same op with the check stubbed off.
- **A6 (M15):** `vi.mock('../workspace/file-lock.js')` wraps `withStateJsonLock` to set a module flag while its callback runs. A spy on `checkParseHintsPairing` records the flag, and the test asserts it was `false` at every call.
- **Leaf re-check (M16):** the spy, after delegating to the real function, (a) rewrites `state.json` with the chapter id sequence changed to `[1, 3, 2]` (same titles), and in a second case (b) appends one sentence to `manuscript-edits.json` (bytes change). Both expect 409 and no hints file.

**`server/src/routes/chapters-restructure.test.ts` (Task 4):** `exclude still succeeds but writes no hints file, so the mispairing is not made persisted` (about line 532) stays green: a toggle now never writes. Its title and comment are reworded to the new reason ("a toggle never writes a hints file"), and its trailing merge-still-refused assertion is kept.

**Analysis-start tests (Task 5): `server/src/routes/analysis.title-flags.test.ts`** (main + subset via the existing `describe.each`):

- `KNOWN GAP (#3837) …` is **renamed** "a same-count reorder from before #3703 is refused on an analysed book". Sentences are remapped as the reorder left them. It asserts 409 `hints_out_of_sync`, a byte-identical `state.json` and no `manuscript-hints.json`.
- Start fresh (main only): the same reordered book with `{ fresh: true }` is not refused with `hints_out_of_sync` (M18).
- a book whose sentences are all under 24 characters, reordered, still starts (no evidence → `main`'s rule).
- a paused book (evidence in chapter 1 only) with drifted titles in chapters 2–3 starts (M11 at the start seam).
- the PR #3835 epigraph swap and the lead + "Chapter 2" swap answer 409; a renamed "Chapter N" answers 200; a 3-item merge-then-split boundary shift answers 409.
- fail-open: a `state.json` whose `manuscriptId` changed after hydrate, an edits path that is a directory (`EISDIR`), and a record with a `bookId` but no `bookDir` are not refused with `hints_out_of_sync`.
- unchanged and still green: `does not refuse a never-restructured book whose state title is an older parser form`, `does not refuse a restructured book whose persisted hints pair …`, `answers 409 hints_out_of_sync … byte-identical` (count/id), and the `#3628` cases.

**`server/src/routes/analysis.restructure-restart.test.ts` (Task 5, A1 regression):** after the `a manuscript edited on disk after hydrate …` merge (which skips its hints write), **without** `removeManuscript`, POST Start. Assert it is not refused with `hints_out_of_sync`, and that `getManuscript(manuscriptId)` is the same record object with 3 chapter hints (M19: a re-hydrate on impure would swap in 4).

**Marker tests: `server/src/routes/book-state.reparse.stale-evidence.test.ts` (new; Task 3 for set and clear, Task 5 for the start-seam case).** One fixture: an analysed book merged before #3703 (state 3 chapters, manuscript 4 headings, no hints file, distinct evidence keyed to the old 3 ids). On `main` today, Start and merge are refused by count/id, and the remedy is re-parse.

- **set (M23):** `PUT /reparse` → `state.sentencesPredateChapters === true`, and the edits file is unchanged. Same for replace-manuscript. A re-parse of a book with no saved sentences does not set it.
- **re-parse then restart, then Start:** `removeManuscript` (a restart) → POST Start answers 200, as `main` does after a re-parse (M24: ignoring the marker gives the 409 loop, because the old-keyed evidence fails the score).
- **re-parse then restart, then restructure:** merge answers 200 and writes its hints file, as `main` does (title rule over parse-equal titles).
- **clear (M25), Task 3:** a main analysis run (stubbed analyzer, as `analysis.title-flags.test.ts` does) clears the marker. A subset run leaves it set. An `attribution_drift` main run (state write skipped) leaves it set. **Task 5 adds** the assertion that, after the main run has cleared it, a hand-made reorder of two analysed chapters is refused at Start. That needs the start seam, so it is listed among Task 5's flips.
- **bundle overwrite (M27), Task 3:** in `server/src/import/scan-import-folder.overwrite-marker.test.ts` (new), per the round-10 rule:
  - an overwrite import onto a book whose folder holds a `manuscript-edits.json` with sentences (or a corrupt one) lands `sentencesPredateChapters: true` when the target's chapter list differs from the bundle's (a title, an id or the count), and the local edits file is untouched;
  - a **same-chapters** overwrite onto a book with sentences stamps nothing; one onto a target that is already marked keeps the marker;
  - an overwrite onto a book with no edits file stamps nothing; nor does one with an empty `sentences` array (both with differing chapters), a rename import, or an import into a fresh folder;
  - a marker the bundle's own `state.json` carries is never carried (fresh, rename, and overwrite onto empty edits);
- **backup restore (M27), Task 3:** in `server/src/workspace/auto-backup.stale-evidence.test.ts` (new): the same rule against the snapshot's chapter list — same chapters with sentences → absent; a title, an id or the count differing → marker; corrupt edits with differing chapters → marker; current state already marked → marker; a snapshot carrying the marker onto the same chapters → absent; absent or empty edits → absent.
- **the shared predicate, Task 3:** `server/src/workspace/stale-evidence.test.ts` (new) covers every arm of `swapLeavesStaleEvidence` and `chaptersMatchForEvidence`: edits absent / empty / ok / corrupt / unreadable × chapters same / differing by id / by title / by count × current marked or not × current state absent or unreadable (`null`, which counts as differing).
  - after the stamped overwrite and a restart, Start is not refused with `hints_out_of_sync` (asserted in Task 5, through the start seam).
- **cache refresh helper (M28), Task 3:** `server/src/store/analysis-cache-rebuild.test.ts` (extend):
  - marker set + `replace` removes the cache file;
  - marker set + overlay leaves a seeded cache byte-identical;
  - no marker rebuilds exactly as today, in both modes;
  - route level, one per overlay caller: `generation.test.ts` (slow config), `chapter-qa-repair.test.ts` and `chapter-splice.test.ts` — a marker-set book leaves the analysis cache file byte-unchanged, a marker-free book overlays the edits.
- **re-parse → exclude → Start → restart → Start #2 (M26), Task 5**, in this file:
  - re-parse (marker set) → exclude a chapter (a toggle) → assert the analysis cache file is absent;
  - Start #1 (stubbed analyzer counting `runStage2Chapter` calls) → assert it attributed **every** non-excluded chapter (no "cached, skipping") and cleared the marker;
  - a restart (re-parse left a record with no `hintsSource`, which the seam never checks) → Start #2 → assert it is **not** refused with `hints_out_of_sync`.
  - With the rebuild instead of the clear (the mutant), Start #1 replays the old-keyed takes as cached, persists them, and clears the marker over stale evidence; after the restart, Start #2 is then refused on score.
- **survives the client:** a `PUT /state` slice save from a stale client copy keeps the marker.
- `r5-reparse-marker.ts` shows the real-book version: without the marker the re-parsed Unlocked is refused at 78 chapters and Keeper #1 at 1. With the marker both proceed at Start and at restructure, beyond count/id, which they now pass.

**`server/src/parsers/version.guard.test.ts` (new, Task 6) — the book-state GET tripwire (M17).** The GET's `refreshChapterTitles` stays out of scope: it pairs a no-hints book by position whenever `chapterTitleParserVersion` is stale, so a bump to `CHAPTER_TITLE_PARSER_VERSION` would re-title a pre-#3703 reordered analysed book by position. The guard:

- **copies** the shared opaque-range tokenizer **byte-for-byte between its `BEGIN` / `END` sentinels** (`workspace/state-json-read.guard.test.ts` about lines 74–240). It does not import it: the sentinel comment there explains that out-of-tree census harnesses load each copy from its own file's module scope.
- adds the sanctioned **drift test** comparing its copy with `cast-lock.guard.test.ts`'s, exactly as `state-json-read.guard.test.ts` does about lines 352–367. The guard lives in `server/src/parsers/`, so the sibling's path is `join(__dirname, '..', 'workspace', 'cast-lock.guard.test.ts')`, not the same-directory `join(__dirname, 'cast-lock.guard.test.ts')` the workspace guards use. The drift test first asserts that file exists, so a wrong path fails loudly rather than comparing against nothing.
- **is selectable by scoped CI** (#3085 / #3059 convention). It reads `routes/book-state.ts` at runtime, so it has no module-graph edge to it, and `vitest --changed` would never select it on a `book-state.ts` diff. Add:
  - `server/src/parsers/version.guard-targets.ts`, exporting `PARSER_VERSION_GUARD_SCAN_GLOB = 'server/src/routes/book-state.ts'` with the same doc shape as `tts/engine-language-coverage.guard-targets.ts`;
  - that constant to `server/vitest.config.ts`'s `forceRerunTriggers`, with a comment block like the engine-language-coverage one;
  - a coverage case in `server/src/force-rerun-triggers.test.ts` importing the constant, so the trigger and the guard cannot drift and the test passes at all three checkout shapes. `parsers/version.ts` itself is imported by the guard, so it needs no entry.
- reads `routes/book-state.ts`, masks every opaque range (comments, strings, templates, regex literals), and asserts:

  ```ts
  expect(CHAPTER_TITLE_PARSER_VERSION === 2 || codeOnly.includes('checkParseHintsPairing(')).toBe(true);
  ```

- self-tests: a source where the call appears only in a comment, and one where it appears only in a string, both fail the pin; a real call passes. The failure message points to #3837 and this plan.

**`server/src/workspace/restructure.hints-pairing.test.ts`:** unchanged, plus a case for the extracted `titlePairsAt` predicate.

No Playwright spec and no frontend test: there is no UI, client or SSE change. The pre-stream 409 is already mapped by `api.ts` and pinned by `src/lib/api-analysis-stream-errors.test.ts`.

### Mutations (each one turns a named test red)

| # | Mutation | Red test |
| --- | --- | --- |
| M1 | 40% floor → 30% | `E=10, own=3, alt=0` is refused |
| M2 | margin 4 → 3 (and 4 → 5) | `own=6, alt=2` is refused; `own=8, alt=2` pairs |
| M3 | evidence floor 24 → 20 | the displaced 20–23-char fixture pairs (`r5-m3m4.ts`: floor 20 refuses) |
| M4 | evidence floor 24 → 28 | the 25–26-char reorder under `'count-id'` is refused (`r5-m3m4.ts`: floor 28 pairs) |
| M5 | drop the tag strip (either side) | tagged chapter pairs; tagged moved block is refused; content-side tag matches |
| M6 | drop the quote strip | re-split quotation pairs |
| M7 | count vocalizations as evidence | vocalization-heavy chapter pairs |
| M8 | refuse on orphans, or count them as evidence | orphan fixtures pair (unit and restructure route) |
| M9 | block length 3 → 4 (and 3 → 2) | exactly-3 block is refused; 2-item shift pairs |
| M10 | order the block walk by file order | the D1, O1, D2, O2, D3 fixture is refused |
| M11 | title-check evidence-less positions at analysis start | paused book with tail title drift starts (unit and route) |
| M12 | skip the title check at evidence-less positions at restructure | no-evidence merge 409; the `#3791` `seedPreReorderedBook` tests |
| M13 | count own-piece items in `alt` | recap-chapter fixture pairs |
| M14 | drop the title from candidate content | subtitle-line evidence fixture pairs |
| M15 | run the check inside `withStateJsonLock` | the A6 flag spy |
| M16 | drop the leaf identity re-check | id-sequence and edits-bytes spies expect 409 |
| M17 | bump `CHAPTER_TITLE_PARSER_VERSION`, or leave the call only in a comment or string | `version.guard.test.ts` |
| M18 | run the sentence check on Start fresh (or skip it on the subset start) | Start-fresh test; the subset leg of the renamed reorder test |
| M19 | re-hydrate an impure record, or drop the positional-id assertion | restart-restructure A1 regression; ids-out-of-order gate test |
| M20a | an exclude/include toggle writes hints (as `main` does when titles pair) | toggle-writes-nothing tests |
| M20b | a prune on an unpaired parse book writes (as `main` does) instead of refusing | prune-unpaired 409 test |
| M20b-a | drop `parseCountIdFails \|\|` from the prune refusal | the m > n and m < n prune tests |
| M20b-b | restrict the prune refusal to `pairing?.mode === 'checked'` | the main-mode title-mispaired prune test |
| M20c | drop `&& !parseCountIdFails` from `hintsWritten` (#3953) | the `[1,2,4]` rename and refresh-titles tests (500) |
| M21 | count distinct texts instead of every saved sentence | refrain ×8 pairs; dup ×3 displaced is refused |
| M22 | drop the BOM strip in `readEditsForHintsCheck` | BOM'd file reads `ok` |
| M23 | `applyReparse` does not set the marker | `sentencesPredateChapters === true` after re-parse and replace |
| M24 | the seams ignore the marker | re-parse → restart → Start answers 200 |
| M25 | clear the marker on the subset persist (or never clear it) | subset leaves it set; main clears it (Task 3); a later reorder is refused (Task 5) |
| M26 | a restructure on a marker-set book rebuilds the cache instead of clearing it | re-parse → exclude → Start → restart → Start #2: Start #2 refused, Start #1 skipped chapters as cached |
| M27 | the overwrite / restore does not stamp the marker, stamps on same chapters, ignores the current marker, or carries the bundle's / snapshot's own marker; or `swapLeavesStaleEvidence` treats an absent / unreadable current state as matching | overwrite-marker test ("an overwrite onto a book with saved sentences and %s lands the marker; the edits file is untouched", an `it.each` over "a retitled chapter" / "a renumbered chapter"; "a same-chapters overwrite … stamps nothing", "… already-marked book … keeps the marker", "a marker carried in the bundle's own state.json is stripped"); `auto-backup.stale-evidence.test.ts` ("chapters differing in …: marker", "same chapters + saved sentences: no marker", "… already marked …: marker", "a snapshot carrying the marker …"); `stale-evidence.test.ts` ("… current state null -> true") |
| M28 | the overlay callers re-seed (or clear) the cache on a marker-set book, or a caller drops the marker from the state it passes | cache refresh helper test; the route-level tests in `chapter-qa-repair.test.ts` and `chapter-splice.test.ts` ("on a marker-set book, leaves the analysis cache file byte-unchanged") and `generation.test.ts` ("on a marker-set book, leaves a seeded cache byte-unchanged") |
| M29 | evidence floor `>= 24` → `> 24`, `>= 25` or `>= 26` | the exactly-24-character swap pairs |

The task-reviewer re-applies at least one mutation itself (an implementer's own mutant is not proof).

### Manual acceptance walkthrough (real backend, `npm run dev`)

1. Copy an analysed workspace book that has no `manuscript-hints.json` (for example Bonus Keefe Story) into a scratch workspace.
2. Start analysis: it starts.
3. Edit an analysed chapter's title in `state.json` to an older parser form (append `&rsquo;`). Merge two chapters: 200.
4. On a fresh copy, swap two analysed chapters' entries in `state.json` (titles and uuids), and remap their sentences' `chapterId` in `manuscript-edits.json` to match. Restart.
   - Start analysis: 409 with the re-parse message, `state.json` unchanged.
   - Start fresh: it starts.
   - Merge: 409, every file unchanged.
5. On that same swapped copy, re-parse from the Library menu. `state.json` carries `"sentencesPredateChapters": true`. Restart. Start analysis starts; merge answers 200.
6. Confirm Unlocked (82 vs 167) and Keeper of the Lost Cities #1 (59 vs 57) still answer 409 by count/id, and that after a re-parse of a scratch copy each starts.

## Implementation tasks (subagent-driven; one implementer per task, test-first)

Implementation cuts `feat/server-3837-hints-proof` off the latest `main` with `node scripts/wt-new.mjs feat/server-3837-hints-proof`. Each task writes its tests first, shows them red for the right reason, implements, then goes green. Run analysis-route tests with `OLLAMA_URL=http://127.0.0.1:1`.

**Every task's acceptance includes the 14-file seam set**, run from `server/`:

```
OLLAMA_URL=http://127.0.0.1:1 npx vitest run src/routes/analysis.restructure-restart.test.ts src/routes/analysis.test.ts src/routes/analysis.title-flags.test.ts src/routes/analysis.title-source.test.ts src/routes/book-op.quick-routes.test.ts src/routes/book-state.fs-error-bodies.test.ts src/routes/book-state.refresh-titles.origin-lifecycle.test.ts src/routes/book-state.reparse-lock.test.ts src/routes/book-state.reparse.manuscript-hints.test.ts src/routes/book-state.revision-precondition.test.ts src/routes/chapters-restructure-exclude.busy.test.ts src/routes/chapters-restructure.manuscript-hints.test.ts src/routes/selection-error-coding.test.ts
npx vitest run -c vitest.config.slow.ts src/routes/chapters-restructure.test.ts
```

Each task must leave all 14 green. The order makes that possible: the fixtures change first (Task 2, no behaviour change), then each behaviour lands with the tests and fixture adjustments it needs.

1. **Pure check module and edits read.**
   - Create `server/src/workspace/hints-proof.ts`, `server/src/workspace/hints-proof-io.ts` and their tests. Extract `titlePairsAt` in `server/src/workspace/restructure.ts`, with `parseTitlesPairWithState` calling it.
   - `round6.ts` (path in the header) is the reference for the scoring, the index and the block walk, counting every saved sentence.
   - Acceptance: `npx vitest run src/workspace/hints-proof.test.ts src/workspace/hints-proof-io.test.ts src/workspace/restructure.hints-pairing.test.ts` is green. M1–M10, M13, M14, M21, M22 and M29 each turn a named test red when applied. `npm run check:cycles` and `npm run typecheck` (repo root) are clean. The 14-file set is green.
2. **Fixture preparation (no behaviour change).**
   - The `analysis.title-flags.test.ts` changes (`lineFor`, the `It began.` first line, `seedBook`, the stage-2 stub) and the two `chapters-restructure.test.ts` refresh-titles fixtures (about lines 1622 and 1791).
   - Narrow any whole-object `state.json` comparison after a re-parse in `book-state.reparse-lock.test.ts` / `book-state.reparse.manuscript-hints.test.ts`.
   - Acceptance: the 14-file set is green on today's seams.
3. **Stale-evidence marker.**
   - Add `sentencesPredateChapters?: true` to `BookStateJson` (`workspace/scan.ts`, with a plan-27 additive-field comment).
   - Set it in `applyReparse`'s state mutation when `preservedEditCount > 0`. Delete it in the main analysis persist's state write that follows the edits write (`analysis.ts` about line 7305).
   - Stamp it in the bundle overwrite (`import/scan-import-folder.ts` `commitOverwrite` → `writeStagedState`), as specified under "Who sets it".
   - Add `refreshCacheFromEdits` to `store/analysis-cache-rebuild.ts` and route its four callers through it: `chapters-restructure.ts` (about line 531, `replace`, called with the result state), `generation.ts` (about line 1099), `chapter-qa-repair.ts` (about line 421) and `chapter-splice.ts` (about line 275), the last three in overlay mode with their existing `excludedChapterIds`.
   - Tests:
     - the set, clear, subset, `attribution_drift` and PUT-survival cases of `book-state.reparse.stale-evidence.test.ts`. The Start and restructure cases are written here but asserted against today's seams: Start after re-parse answers 200 already on `main` (count/id passes), which pins the baseline. M25's reorder-refused assertion waits for Task 5;
     - `import/scan-import-folder.overwrite-marker.test.ts` (new, M27);
     - the `analysis-cache-rebuild.test.ts` helper cases (M28).
   - Acceptance: those files green, plus `npx vitest run src/store/analysis-cache-rebuild.test.ts src/routes/chapter-qa-repair.test.ts src/routes/chapter-splice.test.ts`, `npx vitest run -c vitest.config.slow.ts src/routes/generation.test.ts` (it is in `SLOW_FILES`, so the default config skips it) and the existing `scan-import-folder` tests green (no marker, so no behaviour change). M23, M25 (clear), M27 and M28 red when applied. The 14-file set green.
4. **Restructure seam.**
   - Edit `server/src/routes/chapters-restructure.ts` as specified: the pre-leaf gate and check under `book`, `readEditsForHintsCheck` in the leaf with the leaf semantics, the leaf re-check, the `hintsMispaired` / `parseTitles` mapping, `refuseWhenMispaired = true` for merge, split and reorder, and the exclude/include toggle and prune rule.
   - Rewrite the doc comments of `parseTitlesPairWithState` / `assertHintsPairWithState` (`workspace/restructure.ts`), the `hintsMispaired` comment block in `applyRestructureClaimed`, and the `hintsSource` / `parseTitles` docs in `store/manuscripts.ts` (about lines 66–78; "Merge, split and reorder title-check a `parse` record" is now false). These are comments the change makes false, so they are owed.
   - Reword the about-line-532 exclude test.
   - Tests: `chapters-restructure.hints-proof.test.ts` (new).
   - Acceptance: that file green; `npx vitest run src/routes/book-state.refresh-titles.test.ts` green, unmodified except that its two "#3828 pass 1" exclude-only tests now seed their `manuscript-hints.json` directly (a toggle no longer writes one, round 8 decision 2); the `book-op-lock`, `state-json-lock`, `state-lock` and `state-json-read` guards green; M12, M15, M16, M19 (ids), M20a and M20b red when applied; the 14-file set green with the plan 70a and `#3791` blocks unmodified.
5. **Analysis-start seam.**
   - Edit `server/src/routes/analysis.ts`: replace `hintsOutOfSyncRefusal` with `parseHintsStartCheck` at both call sites, passing `fresh: requestedFresh` on the main route. Rewrite its doc comment: its "design owed in #3837" sentence becomes false.
   - Tests (Task 5's flips and additions):
     - the `analysis.title-flags.test.ts` Task 5 changes (the renamed reorder test and the new cases);
     - the `analysis.restructure-restart.test.ts` A1 regression;
     - in `book-state.reparse.stale-evidence.test.ts`: the Start-after-re-parse case now runs through the new seam; **M25's** "after the main run clears the marker, a hand-made reorder is refused at Start"; and **M26**, re-parse → exclude → Start → restart → Start #2;
     - in `scan-import-folder.overwrite-marker.test.ts`: the stamped overwrite → restart → Start not refused.
   - Acceptance: those files plus `src/routes/analysis.edits-routing.guard.test.ts` green; M11, M18, M19 (impure), M24, M25 (reorder) and M26 red when applied; the 14-file set green.
6. **Contract, tripwire and the full suites.**
   - `openapi.yaml`:
     - rewrite the `hints_out_of_sync` text of the analysis-start 409s (main, about lines 912–920; subset, about line 1004). It also covers a same-count book whose saved sentences do not pair with its chapters; Start fresh checks count and ids only; keep "never arrives as an SSE event".
     - rewrite the restructure 409 descriptions (about lines 1135, 1179, 1220, 1254 and 1324, and the `RestructureConflictError` schema description about line 5259). The refusal is: the hints do not pair with state.json — a different chapter count or ids; or, for hints from a fresh parse, a chapter whose saved sentences do not match its position, or a chapter with no analysed sentences whose title disagrees with its position. An exclude/include that would drop an empty chapter on such a book is refused the same way.
   - Run `npm run openapi:types` and commit the regenerated `src/lib/api-types.ts`.
   - Add `server/src/parsers/version.guard.test.ts` (M17), `server/src/parsers/version.guard-targets.ts`, its `forceRerunTriggers` entry in `server/vitest.config.ts`, and its coverage case in `server/src/force-rerun-triggers.test.ts`. Acceptance includes `npx vitest run src/parsers/version.guard.test.ts src/force-rerun-triggers.test.ts`.
   - Run `cd server && OLLAMA_URL=http://127.0.0.1:1 npm run test` and `npm run test:server-slow` (repo root).
   - Acceptance: both suites green, `npm run typecheck` green, `npm run verify:fast:branch` green.
7. **Real-book acceptance, in the PR.**
   - Run the shipped `checkParseHintsPairing` read-only over every analysed book in `C:\AudiobookWorkspace\books`, in both `evidenceLess` modes. Use a scratch script outside the repo, modelled on `round6.ts`, that imports the real module. Paste the per-book table into this plan's Ship notes.
   - Acceptance:
     - every same-count book pairs in both modes;
     - Unlocked and Keeper #1 are refused by count/id;
     - the `SWAP` controls on Everblaze, Bonus Keefe, Stellarlune and Ночной дозор and the `SHIFT=3:3` control on Ночной дозор are refused;
     - the post-re-parse simulation (`r5-reparse-marker.ts` with the real module, marker set) proceeds for Unlocked and Keeper #1.
   - If this cannot be run inside the PR, add an on-box acceptance row instead (see "Before-shipping items").
8. **Docs.**
   - (a) Release notes: an entry in `docs/release-notes-next.md` (technical, PR-refed), and a brand-voice line in the in-progress section of `RELEASE_NOTES.md`. For example: an analysed book whose chapter titles changed under a parser update can be edited again without a re-parse, and a book whose chapters were reordered long ago is caught before re-analysis.
   - (b) A `docs/features/INDEX.md` entry for plan 290.
   - (c) Archived plan 51 (`docs/features/archive/51-restructure-chapters.md`), invariant 2: rewrite the "what pair means" passage for `parse` records (the sentence check for chapters with evidence, the title check for chapters without, at restructure). Replace "exclude only sets a flag, so it still succeeds, but writes no hints file there" with the round-8 rule: a toggle never writes; a prune writes on a paired or persisted book and is refused otherwise.
   - (d) CLAUDE.md chore: the "`git grep requestFailureMessage` … enumerates all seventy-eight call sites" sentence. Recounted at implementation (call lines, not imports): 78, with the per-file split already in CLAUDE.md; the sentence is current and was left unchanged. No CLAUDE.md edit is owed. This plan adds no call site.

## Before-shipping items

- **Regression plan:** this file. Flip it to `active` on implementation start, and to `stable` with Ship notes on merge.
- **Paired tests:** as listed. No e2e: no UI, client or SSE change.
- **OpenAPI and generated types:** Task 6, in the same PR.
- **Archived plan 51 invariant 2** (Task 8c) and the `store/manuscripts.ts` docs (Task 4), in the same PR.
- **On-box acceptance:** discharged in the PR by Task 7 (read-only, needs the operator's workspace, no GPU). If Task 7 cannot run in the PR, a row is owed on all three surfaces:
  - **prerequisite:** a workspace with analysed parse-fallback books;
  - **observe:** each same-count book pairs under the shipped check; Unlocked and Keeper #1 are refused by count/id and start after a re-parse of a scratch copy; a hand-made reorder copy is refused at Start analysis with `state.json` unchanged, and Start fresh still starts;
  - **criteria:** the manual walkthrough above;
  - **surfaces:** `docs/testing/onbox-acceptance-register.md`, the live view `docs/testing/onbox-acceptance-register-live-view.html` (`npm run register:build`, `npm run check:onbox-register`, then publish to the register's recorded URL after `--against-published`), and a run sheet if one is created.
- **INDEX.md:** a new entry under the server/workspace area.
- **Release notes:** both documents (Task 8a). User-visible delta: title-drifted analysed books are no longer refused at restructure, same-count reorders are refused at analysis start, and a re-parsed book is no longer judged by its old sentences.
- **CLAUDE.md:** none owed: the `requestFailureMessage` enumeration was recounted (Task 8d) and is current.
- **Issue:** the PR body says `Closes #3837` and `Refs #3879`. Under "Also fixed, found in passing" it lists:
  - the **pre-existing `main` defect** that a restructure after a re-parse re-seeds the analysis cache from old-keyed edits, which a later run replays as current takes (fixed by `refreshCacheFromEdits`, M26 / M28);
  - every test fixture changed to fix a stale fixture rather than for the feature;
  - the **pre-existing `main` defect** (#3953) that a rename or refresh-titles on a parse book with the parse's chapter count but non-positional state ids answered 500 (`manuscript-hints: no hint for chapter id N`) instead of skipping the hints write;
  - the **pre-existing `main` defect** that an exclude/include prune on a parse-fallback book whose count/id fails can come out with equal hint and chapter counts and write `manuscript-hints.json`, laundering the mispaired bodies into `persisted` (refused 409 now, owner round 9).
- **Review gate:** `pr-review-gate`, depth `high` (multi-scope: routes, workspace, contract).
- **Verify:** `npm run verify:fast:branch` by hand; cloud `verify.yml` is the required gate.

## Out of scope

- Persisting a pairing from the check, re-grouping split drift, and pre-#3703 user splits (#3879).
- Checking from `GET /api/books/:bookId/state` (`refreshChapterTitles`); guarded by the M17 tripwire instead.
- Bumping `CHAPTER_TITLE_PARSER_VERSION`.
- A second, post-registration check at analysis start, and any SSE form of `hints_out_of_sync`.
- Re-keying preserved edits after a re-parse (the marker only stops the check from reading them).
- Checking never-analysed books by any evidence other than titles.

## Calibration

Run read-only on 2026-10-30 against every analysed book in `C:\AudiobookWorkspace\books`: 25 folders, none with a `manuscript-hints.json`. The harness is `round6.ts`, which counts every saved sentence, as round 8 now specifies. So the rule did not change in rounds 7 and 8, and the run stands. The marker affects only re-parsed books, and none in the workspace has been re-parsed: `r5-reparse-marker.ts` simulates that case below.

The rules: today's count/id check first; then, for same-count books, the positional 40% / 4× rule; the 24-character floor; tags stripped anywhere on both sides; quotes stripped on the sentence side; `alt` counting only items absent from the own piece; orphans ignored; the block walk ordered by parse position. Evidence-less positions are reported under both seams' rules. The parser is the worktree's at 95c91586. Check time excludes parsing (the seams reuse the record's parse bodies). Times are single wall-clock runs on a shared, loaded box.

| Book | n / m | Evidence chapters | Worst own | Worst `alt` (margin) | Displaced (isolated / blocks) | Evidence-less title mismatches | Start | Restructure | Check ms (parse ms) |
|---|---|---|---|---|---|---|---|---|---|
| A21 Clone Readiness Gate QA (throwaway) | 1/1 | 1/1 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 1 (12) |
| A21 Clone Readiness Gate QA v2 (throwaway) | 1/1 | 1/1 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 0 (3) |
| Der Auftrag von Coalfall | 3/3 | 2/3 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 4 (31) |
| El Encargo de Coalfall | 3/3 | 2/3 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 3 (16) |
| La Commande de Coalfall | 3/3 | 2/3 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 5 (14) |
| The Coalfall Commission | 4/4 | 2/4 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 3 (18) |
| Заказ Коалфолла | 3/3 | 2/3 | 97.9% | 0 (∞) | 0 / 0 | 0 | pass | pass | 3 (16) |
| コールフォールの依頼 | 3/3 | 2/3 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 2 (6) |
| 煤落的委托 | 3/3 | 2/3 | 94.4% | 0 (∞) | 0 / 0 | 0 | pass | pass | 2 (2) |
| A16 Row Test - Delo o Koalfolle | 2/2 | 2/2 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 1 (1) |
| QA2937 Coalfall RU Throwaway | 2/2 | 2/2 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 1 (1) |
| Playing with Fire | 51/51 | 42/51 | 97.1% | 0 (∞) | 0 / 0 | 0 | pass | pass | 160 (94) |
| Scepter of the Ancients | 40/40 | 31/40 | 98.6% | 0 (∞) | 0 / 0 | 0 | pass | pass | 166 (82) |
| The Lost Art of World Domination | 7/7 | 1/7 | 99.5% | 0 (∞) | 0 / 0 | 0 | pass | pass | 4 (9) |
| Bonus Keefe Story | 7/7 | 7/7 | 100% | 0 (∞) | 0 / 0 | 0 | pass | pass | 2 (2) |
| Everblaze | 77/77 | 70/77 | 86.7% | 0 (∞) | 0 / 0 | 0 | pass | pass | 411 (145) |
| Exile | 70/70 | 63/70 | 92.3% | 0 (∞) | 0 / 0 | 0 | pass | pass | 320 (136) |
| Neverseen | 88/88 | 79/88 | 77.3% | 0 (∞) | 0 / 0 | 0 | pass | pass | 501 (185) |
| Stellarlune | 57/57 | 51/57 | 64.0% | 0 (∞) | 0 / 0 | 0 | pass | pass | 750 (274) |
| Unraveled | 53/53 | 44/53 | 98.9% | 0 (∞) | 0 / 0 | 0 | pass | pass | 275 (142) |
| Юный дрессировщик | 15/15 | 12/15 | 96.4% | 2 (94×) | 4 / 0 | 0 | pass | pass | 137 (75) |
| Ночной дозор (C2C3 run 2) | 9/9 | 9/9 | 88.7% | 0 (∞) | 0 / 0 | 0 | pass | pass | 409 (162) |
| Ночной дозор | 9/9 | 9/9 | 92.2% | 0 (∞) | 0 / 0 | 0 | pass | pass | 584 (160) |
| Keeper of the Lost Cities #1 | 59/57 | — | — | — | — | — | refused by count/id | refused by count/id | — (132) |
| Unlocked | 82/167 | — | — | — | — | — | refused by count/id (count and ids) | refused by count/id | — (459) |

Positive controls (in memory; state and edits untouched, the parse altered):

| Control | Result |
| --- | --- |
| Everblaze, parse pieces 10 ↔ 11 swapped | refused (`score`: own 0 of 134 and 0 of 130; 2 blocks) |
| Bonus Keefe Story, pieces 3 ↔ 4 swapped | refused (`score`: own 0 of 28 and 0 of 9) |
| Stellarlune, pieces 20 ↔ 21 swapped | refused (`score`: own 0 of 151 and 1 of 185) |
| Ночной дозор (C2C3 run 2), pieces 4 ↔ 5 swapped | refused (`score`: own 1 of 1,118) |
| Ночной дозор (C2C3 run 2), last 3 long paragraphs of piece 3 moved into piece 4 | refused (`displaced-block`, 12 displaced) |
| Everblaze, last 3 long paragraphs of piece 20 moved into piece 21 | **passes** (2 evidence items displaced; the moved dialogue is mostly sub-24 pieces): blind spot 1 |
| The Coalfall Commission, pieces 0 ↔ 1 swapped | **passes**: both are evidence-less excluded front matter with the same title, so the swap is identical under every rule, `main`'s included: blind spot 2 |

Re-parse simulation (`r5-reparse-marker.ts`, read-only; state replaced in memory by the fresh parse, edits kept as `applyReparse` keeps them):

| Book | Without the marker | With the marker (round 8) |
| --- | --- | --- |
| Unlocked (re-parsed to 167 chapters; 10,198 sentences kept) | Start and restructure **refused** (`score` at 78 chapters: the loop) | count/id passes, no evidence seen, titles equal the parse → **Start and restructure proceed** |
| Keeper of the Lost Cities #1 (re-parsed to 57; 10,475 kept) | Start and restructure **refused** (`score` at 1 chapter) | **Start and restructure proceed** |

Unit-fixture probe (`r5-m3m4.ts`): M3's displaced 20–23-character lines pair at floor 24 and are refused at floor 20 (`E = 7, own = 4, alt = 3`). M4's 25–26-character reorder is refused at floor 24 and pairs at floor 28 (no evidence, `'count-id'`).

Findings:

- **No healthy book is near the line.** The worst own score is 64.0% (Stellarlune ch 29) against the 40% floor. Under the absent-from-own `alt`, 22 of 23 books have `alt = 0` everywhere; the only non-zero `alt` is 2 (Юный дрессировщик ch 14, own 188: 94×). Every evidence-chapter swap control is refused.
- **No workspace book is title-drifted today.** Every position of every same-count book agrees with `main`'s title rule, so the restructure-side title check at evidence-less positions costs nothing on these books, and the title-drift unblock is proved on fixtures.
- **Without the marker, the re-parse remedy loops** (both books refused after their own remedy). With it, both proceed. That is round 8, decision 1.
- **Corrections carried forward.** Keeper of the Lost Cities #1's round-4 harness result was `no-alignment`; it never reaches the check, because count/id refuses it. The round-4 claim that Unlocked's 164 pieces "agree with their owning chapter" was circular and is dropped.
- **Runtime.** The largest check took 0.75 s (Stellarlune) on a loaded box, and 0.33–0.45 s on earlier runs; the index alone is 157–268 ms synchronous with a 61–82 MB transient heap ("Cost").

## Open questions

None. The last one, what an exclude/include prune does on an unpaired parse book, is decided in round 9 (2026-10-31): **refuse** with the 409 `hints_out_of_sync` and change nothing on disk, as this plan specifies.

## Ship notes

(Filled in when status flips to `stable`.)

### Task 7 real-book acceptance (2026-10-31)

Run read-only against `C:\AudiobookWorkspace\books` (25 analysed books) on branch HEAD `582e4907` with the shipped `checkParseHintsPairing` (`server/src/workspace/hints-proof.ts`) and `sentencesOf` (`hints-proof-io.ts`); no workspace file was modified (mtime and size of every `state.json` / `manuscript-edits.json` unchanged across the run). Command: `server/node_modules/.bin/tsx <scratch>/calib/task7-acceptance.ts` (scratch script outside the repo). The count/id step runs first, as the seams do; same-count books then run in both `evidenceLess` modes. Check ms excludes parsing; the slowest check was 442 ms (Stellarlune) on a loaded box.

| Book | n / m | `count-id` mode | `title` mode | Check ms |
|---|---|---|---|---|
| A21 Clone Readiness Gate QA (throwaway) | 1/1 | pair(ev=1) | pair(ev=1) | 1 |
| A21 Clone Readiness Gate QA v2 (throwaway) | 1/1 | pair(ev=1) | pair(ev=1) | 0 |
| Der Auftrag von Coalfall | 3/3 | pair(ev=2) | pair(ev=2) | 4 |
| El Encargo de Coalfall | 3/3 | pair(ev=2) | pair(ev=2) | 3 |
| La Commande de Coalfall | 3/3 | pair(ev=2) | pair(ev=2) | 3 |
| The Coalfall Commission | 4/4 | pair(ev=2) | pair(ev=2) | 2 |
| Заказ Коалфолла | 3/3 | pair(ev=2) | pair(ev=2) | 3 |
| コールフォールの依頼 | 3/3 | pair(ev=2) | pair(ev=2) | 1 |
| 煤落的委托 | 3/3 | pair(ev=2) | pair(ev=2) | 16 |
| A16 Row Test - Delo o Koalfolle | 2/2 | pair(ev=2) | pair(ev=2) | 1 |
| Playing with Fire | 51/51 | pair(ev=42) | pair(ev=42) | 98 |
| Scepter of the Ancients | 40/40 | pair(ev=31) | pair(ev=31) | 153 |
| The Lost Art of World Domination | 7/7 | pair(ev=1) | pair(ev=1) | 3 |
| QA2937 Coalfall RU Throwaway | 2/2 | pair(ev=2) | pair(ev=2) | 1 |
| Bonus Keefe Story | 7/7 | pair(ev=7) | pair(ev=7) | 2 |
| Everblaze | 77/77 | pair(ev=70) | pair(ev=70) | 293 |
| Exile | 70/70 | pair(ev=63) | pair(ev=63) | 346 |
| Keeper of the Lost Cities | 59/57 | refused by count/id | refused by count/id | - |
| Neverseen | 88/88 | pair(ev=79) | pair(ev=79) | 399 |
| Stellarlune | 57/57 | pair(ev=51) | pair(ev=51) | 442 |
| Unlocked | 82/167 | refused by count/id | refused by count/id | - |
| Unraveled | 53/53 | pair(ev=44) | pair(ev=44) | 195 |
| Юный дрессировщик | 15/15 | pair(ev=12) | pair(ev=12) | 89 |
| Ночной дозор (C2C3 run 2) | 9/9 | pair(ev=9) | pair(ev=9) | 351 |
| Ночной дозор | 9/9 | pair(ev=9) | pair(ev=9) | 364 |

Positive controls (in memory; identical in both modes):

| Control | Result |
|---|---|
| Everblaze, pieces 10 and 11 swapped | refused (`score`: chapter 11, own 0 of 134) |
| Bonus Keefe Story, pieces 3 and 4 swapped | refused (`score`: chapter 4, own 0 of 28) |
| Stellarlune, pieces 20 and 21 swapped | refused (`score`: chapter 21, own 0 of 151) |
| Ночной дозор (C2C3 run 2), pieces 4 and 5 swapped | refused (`score`: chapter 5, own 1 of 1118) |
| Ночной дозор, pieces 4 and 5 swapped | refused (`score`: chapter 5, own 1 of 1114) |
| Ночной дозор (C2C3 run 2), SHIFT 3:3 | refused (`displaced-block`: chapter 4 into chapter 5) |
| Ночной дозор, SHIFT 3:3 | refused (`displaced-block`: chapter 4 into chapter 5) |

Post-re-parse marker simulation (state replaced by the fresh parse, ids 1..m, no evidence seen as the marker implies): Unlocked (167 chapters) and Keeper of the Lost Cities #1 (57) both pair in both modes, so start and restructure proceed.

Acceptance: every same-count book pairs in both modes (pass); Unlocked and Keeper #1 refused by count/id (pass); all controls refused (pass); marker simulation proceeds for both (pass).
