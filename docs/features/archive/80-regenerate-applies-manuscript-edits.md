---
status: stable
shipped: 2026-05-20
owner: null
---

# Regenerate applies manuscript-edits overlay before synth

> Status: stable
> Key files: `server/src/routes/generation.ts`, `server/src/store/analysis-cache-rebuild.ts`, `server/src/routes/generation.test.ts`
> URL surface: indirect — `POST /api/books/{bookId}/generation` (SSE stream); user-facing trigger is the per-chapter **Regenerate this chapter** button in `src/components/listen/listen-player-region.tsx:238` and the equivalent affordance in `src/views/generation.tsx`.
> OpenAPI ops: `POST /api/books/{bookId}/generation`

## Benefit / Rationale

- **User:** speaker-reassignment edits the user makes in the manuscript view now actually reach the TTS engine on regenerate. Pre-fix, reassigning "ELLIE speaks line 3" in the manuscript editor and clicking Regenerate produced audio with the analyzer's original speaker for line 3 — the edit was visible everywhere except in the audio. The whole point of the manuscript view (plan 12) is to catch misattributions before spending TTS quota; this fix makes that workflow actually work end-to-end.
- **Technical:** removes the silent disagreement between two on-disk truths. The route now treats `manuscript-edits.json` as the canonical post-analysis sentence list (which it already is for display via `book-state.ts:140-236` and for cache-rebuild via plan 70c) instead of partially trusting it (display) and partially ignoring it (synth).
- **Architectural:** one source of truth at the read site. The synth loop reads from `analysis.chapters` exactly as before; the difference is that the cache is now refreshed from edits before the read. No new code path, no parallel overlay, no in-memory merge — one disk read + the already-tested `rebuildCacheFromEdits` helper.

## Architectural impact

- **No new seams.** Reuses `rebuildCacheFromEdits` (`server/src/store/analysis-cache-rebuild.ts`) which already existed and was already tested (5-case suite in `analysis-cache-rebuild.test.ts`). The helper preserves `chapterCast` / `castDurations` / `stage1` / `failedChapterIds` and is idempotent — safe to run unconditionally before every generate.
- **Subsumes the plan-70c auto-heal.** The old `if (analysis.chapters empty) rebuild` block (`generation.ts:276-288` pre-fix) covered a strict subset of the new condition: "cache empty AND edits exist." Post-fix the rebuild runs whenever edits exist, so the merge/split/reorder case plan 70c was named for is still covered. The plan-70c tests (`generation.test.ts:489-536`) continue to pass unchanged.
- **No API change.** Request shape, response stream shape, and SSE tick vocabulary are byte-identical to v1.4.x. Frontend needs no update.
- **Migration story:** none. The first generate after this lands rebuilds the cache from existing on-disk `manuscript-edits.json`, which for any post-edit book contains the edited speakers already. Books that never had an edit have an absent or empty `manuscript-edits.json`, so the rebuild branch is skipped and behaviour matches v1.4.x exactly.
- **Reversibility:** revert is a clean per-file diff on `generation.ts`. No data migrations to undo.

## Invariants to preserve

1. `POST /api/books/:bookId/generation` must reflect the user's latest manuscript-view edits in the audio it renders. Enforced by `server/src/routes/generation.ts:275-298` (the rebuild-before-load block) and asserted by `generation.test.ts` "passes the EDITED characterId to synth, not the cached one (regen-after-reassign)".
2. Split-offspring sentences (manuscript-view sentence-split offspring whose id is `>` the analyzer's max) must also reach synth on regenerate. Enforced by the same block; asserted by `generation.test.ts` "includes split-offspring sentences (ids above the cache max) in synth input".
3. Books that have never been edited must not have their analysis cache mutated by the regenerate path. The rebuild is gated on `hasEdits` (`Array.isArray(editsSnapshot?.sentences) && editsSnapshot.sentences.length > 0`). Asserted by `generation.test.ts` "leaves the cache untouched when manuscript-edits.json is absent (rebuild skipped)".
4. The plan-70c "never-analysed" error path (`"No analysed sentences cached for this book. Re-run analysis first."`) still fires when both cache and edits are empty. Asserted by the pre-existing `generation.test.ts:521-536`.

## Test plan

### Automated coverage

- Vitest server (`server/src/routes/generation.test.ts`) — three new cases in `describe('POST /api/books/:bookId/generation — plan 80 edits override cache')` capture `synthesiseChapter`'s `sentences` argument and assert it carries the EDITED `characterId` / new sentence ids, not the cached ones.
- Vitest server (`server/src/store/analysis-cache-rebuild.test.ts`) — pre-existing 5-case suite for the helper this fix promotes; unchanged.
- Vitest server (`server/src/routes/generation.test.ts:459-537`) — pre-existing plan-70c auto-heal cases continue to pass; this fix subsumes that codepath without breaking it.

### Manual acceptance walkthrough

Run against the canonical `the Coalfall Commission.txt` manuscript per CLAUDE.md's "Canonical end-to-end manuscript" rule.

1. `npm start`, open the book, analyse + confirm cast, generate one short chapter (≤ 20 sentences so the loop is fast).
2. Open the manuscript view for that chapter. Reassign 3–5 sentences from their current speaker to a different cast member with an audibly distinct voice. The save indicator should settle (autosave debounce flushes) or click off the chapter to force the plan-79 haze autosave.
3. Navigate to the Listen view → click **Regenerate this chapter**.
4. When the regenerate completes, scrub the new audio over the 3–5 reassigned sentences. **Expected:** the voice on those sentences is the new assigned voice, not the original. Pre-fix the voice would have been the original analyzer-assigned one regardless of the edit.
5. The before/after audio renders should be audibly different at exactly the edited positions and identical elsewhere.
6. The Listen view chapter card's voice swatches should reflect any new speakers the chapter gained from the reassignments.

## Out of scope

- The autosave-debounce race (user edits in tab A, hits regenerate in tab B before the debounced PUT flushes). Pre-existing concern, separate fix if it bites.
- A user-visible "stale edits detected, rebuilding cache" advisory toast. The rebuild is fast (single JSON read + write) and silent; the Generate UX doesn't pause for it. Re-evaluate only if user reports confusion.
- Sharing the reconciliation logic in `server/src/routes/book-state.ts:140-236` (GET hydrate path) with the regenerate path. Tempting (DRY), but the two paths have different filtering needs — book-state filters orphans for display, generation doesn't need to because the rebuild handles structural edits via the canonical post-edit sentence list. Keeping them separate avoids coupling unrelated concerns.

## Ship notes

Shipped 2026-05-20 on branch `fix/server-generation-applies-manuscript-edits`. Single fix commit on the branch; subsumes the plan-70c auto-heal block without breaking its tests; three new regression cases in `generation.test.ts` capture the synthesised sentences argument to assert the edits actually reach the TTS layer.
