---
status: active
shipped: null
owner: null
---

# Plan 70c — Restructure rebuilds the analysis cache instead of wiping it

> Status: active
> Key files: `server/src/routes/chapters-restructure.ts`, `server/src/routes/generation.ts`, `server/src/store/analysis-cache-rebuild.ts`, `server/src/store/analysis-cache.ts`
> URL surface: none — server-only behaviour change
> OpenAPI ops: unchanged (same `POST /api/books/{bookId}/chapters/{merge,split,reorder}` and `POST /api/books/{bookId}/generation`; no new operations, no shape changes)

## Benefit / Rationale

- **User:** After any chapter merge / split / reorder, clicking Generate (or Resume on a halted run) used to halt immediately with the banner **"Generation halted — No analysed sentences cached for this book. Re-run analysis first."** (screenshot `Screenshot 2026-05-19 195554.png`, The Floodmark book mid-flight: 70 chapters, 12 / 9,569 lines synthesised, 0 % progress). The user's only recovery path was to re-run Phase 1 analysis — burning Gemini quota, destroying any manual cast tweaks. Post-fix, the cache is kept in sync with the new structure so Resume just works; no re-analysis required.
- **Technical:** Closes a contract gap between two server endpoints that read the same on-disk artefact. `chapters-restructure.ts` was deleting `server/handoff/cache/{manuscriptId}.json` on every restructure ("the cache's outer chapter-id keying is now stale and would surface zombie entries"), but `generation.ts:259-266` reads that exact file as the source of truth for sentences-to-synthesise. The wipe satisfied the book-state GET reconciliation comment but silently broke generation. The fix: rebuild the cache from `manuscript-edits.json` (which restructure has already updated with the new sentence keys + remapped character assignments + text), preserving everything generation needs.
- **Architectural:** Plan 51 promised "No Phase 1 re-analysis, no analyzer quota cost" on restructure. Plan 70c is the code finally honouring that promise on the generation path — the manuscript-edits.json shape is already the authoritative post-edit sentence ledger and conforms to `SentenceOutput` exactly, so the cache is derivable rather than re-runnable.

## Architectural impact

- **New seams.**
  - `server/src/store/analysis-cache-rebuild.ts` — exports `rebuildCacheFromEdits(manuscriptId, editsPath)`. Reads manuscript-edits.json via the existing `readJson` helper, groups sentences by `chapterId`, sorts each chapter's sentences by `id`, and writes the result via `saveAnalysisCache`. Carries forward `chapterCast` / `castDurations` / `stage2Durations` / `stage1` / `failedChapterIds` from any prior cache (those are keyed by chapterId too but generation doesn't read them; the analyzer's observed-rate samples and Phase 0 roster aren't worth dropping on every structural edit).
  - Auto-heal path in `generation.ts:259-271`: when `loadAnalysisCache` returns an empty `chapters` map, attempt `rebuildCacheFromEdits` once before falling through to the original "Re-run analysis first" error. Recovers any book whose cache was wiped under the pre-fix code AND any future book whose cache file gets deleted out-of-band.
- **Invariants preserved.**
  - `AnalysisCache.chapters: Record<number, SentenceOutput[]>` — outer key still the new chapter id, inner sentences still id-ascending. `SentenceOutput` shape unchanged (`{id, chapterId, characterId, text, confidence?}`); manuscript-edits.json conforms to it exactly (only `confidence` is optional, and edited sentences correctly omit it — load-bearing because zod's `.strict()` would reject unknown keys).
  - Generation's "Re-run analysis first" error path stays as the fallthrough for the genuine never-analysed case (no prior cache + no manuscript-edits.json + no sentences anywhere). The error string is identical so any user docs / screenshots citing it remain valid.
  - Per-book restructure write-lock chain (`withBookLock`) still gates the rebuild — the rebuild happens INSIDE the lock, after the writes to state.json + manuscript-edits.json, so two concurrent merges can't interleave their cache writes.
- **Migration story.** Books with a wiped cache from the pre-fix code self-heal on the next Generate POST via the auto-heal path. No manual intervention; no schema migration; no CLI command.
- **Reversibility.** Pure server change. Two-file diff (new module + two route edits). Revert is a single git revert; behaviour falls back to the pre-fix wipe-and-halt contract.

## Invariants to preserve

1. `rebuildCacheFromEdits` is idempotent. Calling it twice in succession against the same manuscript-edits.json produces byte-identical cache content. Tested in `server/src/store/analysis-cache-rebuild.test.ts`.
2. When manuscript-edits.json is missing OR has zero sentences, `rebuildCacheFromEdits` calls `clearAnalysisCache` rather than writing an empty `chapters: {}` map. Generation's `Object.keys(analysis.chapters).length === 0` check is the trigger for the auto-heal AND the fallthrough error — leaving a stale empty cache would prevent both.
3. The auto-heal in `generation.ts` runs at most once per POST. The second emptiness check after the rebuild attempt is the cutoff — if rebuild produced no chapters (truly never-analysed book), the route returns the original error reason. No retry loop.
4. Restructure's cache rebuild runs AFTER state.json + manuscript-edits.json writes succeed, so a rebuild crash never leaves the cache pointing at a stale structure. Cited at `chapters-restructure.ts` end of `applyRestructure` (the same position where the old `clearAnalysisCache` ran).

## Test plan

### Automated coverage

- `server/src/store/analysis-cache-rebuild.test.ts` (new):
  - `groups manuscript-edits.json sentences by chapterId and sorts by sentence id` — drives the core transform.
  - `carries forward prior chapterCast / castDurations / stage1 / failedChapterIds` — proves Phase 0 metadata isn't dropped.
  - `clears the cache when manuscript-edits.json has zero sentences` — invariant 2.
  - `clears the cache when manuscript-edits.json is missing` — invariant 2, file-absent variant.
  - `is idempotent — calling twice produces the same cache contents` — invariant 1.
- `server/src/routes/chapters-restructure.test.ts`:
  - `rebuilds the analysis cache from manuscript-edits.json after a reorder (plan 70c)` — replaces the pre-fix `clears the analysis cache after any structural change` case. Asserts post-reorder cache exists, is keyed by new chapter ids, and carries the remapped sentence text.
  - `cache survives merge — merged chapter holds both sources concatenated (plan 70c)` — pins merge invariants on the rebuilt cache (sentences renumbered 1..N, characterId preserved per sentence).
  - `cache survives split — sentences partitioned at the split boundary (plan 70c)` — same for split.
- `server/src/routes/generation.test.ts`:
  - `rebuilds the cache from manuscript-edits.json when the cache is empty and proceeds` — auto-heal happy path; asserts no halt fires and chapter_complete fires for both chapters.
  - `still emits the original error when both cache AND manuscript-edits.json are empty` — fallthrough invariant 3.

### Manual acceptance walkthrough

1. With the dev server running and a book mid-generation (analysed + at least one chapter rendered), open the Restructure view and merge two adjacent chapters.
2. **Expected:** the merge response returns 200, the chapter list shrinks by one, and the analysis cache file `server/handoff/cache/{manuscriptId}.json` still exists on disk with a `chapters` map keyed against the new chapter ids.
3. Click Generate / Resume.
4. **Expected:** no red "Generation halted — No analysed sentences cached for this book" banner appears. Generation proceeds from the first unrendered chapter.
5. For the regression check on a never-analysed book: import a fresh manuscript, do not run analysis, click Generate.
6. **Expected:** the original banner still fires ("No analysed sentences cached for this book. Re-run analysis first.") — auto-heal does not paper over the genuine never-analysed case.

## Out of scope

- **chapterCast / castDurations id remapping.** Post-restructure these may be keyed by stale chapter ids (the rebuild carries them forward unchanged). Generation does not consume them, so the bug is dormant; the analyzer's observed-rate fallback handles a missing sample without trouble. If a future regression surfaces (e.g. the Phase 0 roster pill showing wrong-chapter cast), reopen here and use the merge route's `sentenceRemap` table to remap these maps in lockstep.
- **Frontend "Restore cache" affordance.** The auto-heal makes the bug invisible from the next Generate click; no banner work needed. If a future failure mode requires explicit user consent to rebuild (e.g. when the manuscript-edits.json content is suspect), reopen.
- **OpenAPI changes.** None required — `POST /generation` and `POST /chapters/{merge,split,reorder}` keep their existing shapes. The route bodies change behaviour, not contract.

## Ship notes

(to be filled on merge — SHA + PR number)
