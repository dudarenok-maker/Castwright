---
status: stable
shipped: 2026-05-18
owner: null
---

# Chapter restructure panel (merge / split / reorder)

> Status: stable
> Key files: `server/src/workspace/restructure.ts`, `server/src/routes/chapters-restructure.ts`, `server/src/audio/rewrite-chapter-slugs.ts`, `src/components/restructure-chapters-panel.tsx`, `src/views/restructure.tsx`
> URL surface: `#/books/<id>/restructure`
> OpenAPI ops: `POST /api/books/{bookId}/chapters/merge`, `POST .../chapters/split`, `POST .../chapters/reorder`

## Benefit / Rationale

- **User:** the manuscript parser at `server/src/parsers/text.ts` over-splits some books — `* * *` separators, single-line breaks, or sparse heading conventions can yield dozens of one-line "chapters." Before this plan the only options were re-export the source manuscript with manual heading cleanup and re-upload (which loses cast attribution + voice assignment work) or generate audio per fragment and live with the result. The restructure panel lets the user fix structure post-import without losing any analyzer work.
- **Technical:** chapter structure becomes editable in place. State.json + manuscript-edits.json + the in-memory `ManuscriptRecord.chapterHints` are mutated atomically; the audio directory is rewritten via a two-pass rename so renumbered-only chapters keep their generated audio.
- **Architectural:** locks "chapter id is positional, sentences are pure data keyed by `(chapterId, id)`" via three explicit pure transforms in `server/src/workspace/restructure.ts`. Sentences carry text + characterId; restructure only rewrites pointers. No Phase 1 re-analysis, no analyzer quota cost.

## Architectural impact

- **New seams**:
  - `server/src/workspace/restructure.ts` — pure transforms (`applyMerge`, `applySplit`, `applyReorder`, `computeBodySplitIndex`). Reusable by future affordances such as auto-merge of single-line chapters during a parser fix-up.
  - `server/src/audio/rewrite-chapter-slugs.ts` — generic audio op applier (delete / rename + segments.json metadata rewrite + two-pass collision-safe rename). The pre-plan-51 chapter-exclude path at `server/src/routes/book-state.ts:779-792` inlines its own audio cleanup; the helper is shaped to absorb that as a follow-up cleanup.
  - `manuscriptActions.applyChapterRestructure` reducer in `src/store/manuscript-slice.ts` — applies a `sentenceRemap` table so the slice can be updated without re-fetching the full sentence list.
  - View extension: `View` union in `src/lib/types.ts:498` gains `'restructure'`. Router (`src/lib/router.ts:37-43`) and `uiSlice.changeView` (`:151-154`) are already generic over view values.
- **Invariants preserved**:
  - Chapter id is positional (1..N in narrative order). Cited at `server/src/store/manuscripts.ts:14-17` (`ChapterHint.id` doc) and `src/store/chapters-slice.ts:217-237` (hydrate assumption).
  - Sentence id restarts at 1 per chapter; sentences keyed by `(chapterId, id)` tuple. Cited at `src/store/manuscript-slice.ts:93-95`.
  - Chapter audio slug format `${pad2(id)}-${slug(title)}` shared with `server/src/routes/analysis.ts:2655`, `:3372`, `server/src/routes/book-state.ts:586`, `server/src/routes/import.ts:225`.
  - State.json + manuscript-edits.json reconciliation filter at `server/src/routes/book-state.ts:166-185` self-heals partial three-write state on next GET.
- **Migration story**: none required. Existing books load unchanged; the new endpoints are additive. The audio slug format is unchanged. No schema bump.
- **Reversibility**: structural changes are persisted to state.json (with the rotating-backup policy from plan 27), so a fresh `.bak.1` snapshot is available immediately. Audio deletes can be re-generated through normal generation; renames are reversible by re-running an inverse reorder.

## Invariants to preserve

1. `Chapter` ids in `BookStateJson.chapters[]` are exactly `[1..N]` in narrative order after any structural op. Enforced by `buildNewStateChapters` in `server/src/workspace/restructure.ts`.
2. `ChapterHint[]` in the in-memory `ManuscriptRecord` always agrees with `state.json` chapters by id + title after a restructure handler returns. Enforced by `record.chapterHints = result.hints` in `server/src/routes/chapters-restructure.ts`.
3. `manuscript-edits.json` sentences carry `chapterId` matching one of the surviving chapter ids in `state.json`. Crash-safe via the reconciliation filter at `server/src/routes/book-state.ts:166-185`.
4. For renumbered-only chapters, `audioModelKey` + `audioRenderedAt` survive the operation; their slug-named files on disk are renamed (not deleted). For content-changed chapters those fields are cleared and the files are deleted.
5. `.segments.json` files' embedded `chapterId` + `chapterTitle` fields always match the on-disk slug's owner chapter after a rename. Enforced by `rewriteChapterSlugs`.

## Test plan

### Automated coverage

- Vitest server (pure transforms): `server/src/workspace/restructure.test.ts` — 16 cases covering merge contiguity validation + body concat + sentence renumber + audio op shape, split clean-match + fuzzy-locator + paragraph-bisection fallback + sentence partition, reorder permutation validation + bodies preserved + sentence remap.
- Vitest server (audio helper): `server/src/audio/rewrite-chapter-slugs.test.ts` — 8 cases covering single-slug rename + metadata rewrite, 3-chapter rotation (two-pass via temp avoids clobber), delete op, mixed batch ordering, ENOENT tolerance, segments.json field preservation.
- Vitest server (route): `server/src/routes/chapters-restructure.test.ts` — 17 cases covering each route end-to-end against a tempdir workspace (state.json + manuscript-edits.json + analysis cache + audio dir invariants), 400 / 404 validation, three-write internal consistency.
- Vitest frontend (slice): `src/store/manuscript-slice.test.ts` — 3 new cases for `applyChapterRestructure` covering reorder, merge, and orphan-drop shapes.
- Vitest frontend (panel): `src/components/restructure-chapters-panel.test.tsx` — 9 cases covering row rendering + excerpts, contiguity gate on Merge, sentence-split expansion + confirm-then-fire, busy state.
- E2E: pending — see backlog. The view itself is exercised through the unit + slice tests; an end-to-end Playwright spec is a follow-up.

### Manual acceptance walkthrough

Run in mock mode unless noted: `VITE_USE_MOCKS=true npm run dev`.

1. Cold boot at `#/books/<id>/listen` → ListenView loads, expected URL hash matches, chapters list visible.
2. Click "Restructure chapters" button in the listen header → URL becomes `#/books/<id>/restructure`. The panel renders one row per chapter with title + sentence count + first + last sentence excerpts.
3. Tick checkboxes for chapters 2 and 3 → "Merge selected (2)" button enables. Confirm dialog warns: "Merge 2 chapters … Audio for the merged chapter will be deleted; … Chapters below will be renumbered; their audio is preserved."
4. Apply → request fires to `POST /api/books/<id>/chapters/merge`; chapter count drops by 1 in the panel; manuscript-edits.json on disk has the merged chapter's sentences renumbered to 1..N+M with characterIds intact.
5. Navigate back to listen view → the merged chapter shows the inherited first title and combined first/last excerpts. The chapter that was 4+ is now 3+ with its audio still playing (slug renamed in place).
6. Drag a chapter row to a new position via keyboard: Tab to the drag handle (with `aria-label="Reorder chapter <title>"`), press Space, arrow up/down to move, Enter to drop. "Apply reorder" button enables; confirm; order persists across a refresh.
7. Click "Split here…" on a multi-sentence chapter → the row expands to show per-sentence rows. Click "Split after" on sentence N. Confirm; chapter count goes up by 1. Both halves' audio is deleted; chapters below are renumbered with their audio renamed.

Against the real backend, the same walkthrough works on the canonical `server/src/__fixtures__/the-coalfall-commission.md` book the user uploaded that motivated this plan.

## Out of scope

- **Confirm-cast entry point** — the BACKLOG entry mentioned re-accessing the panel from confirm-cast (post-analysis, pre-generation). v1 ships the listen-view entry only; the confirm-cast entry is a follow-up because the cleanest mount there is a modal that operates against the same panel component, and the analyze-then-restructure → re-confirm flow needs its own UX pass.
- **Phase 1 re-analysis after structural edits** — explicitly out. The plan's design decision is pure remap: sentences keep their text + characterId + voice assignment. Users who specifically want fresh analyzer attribution can run the existing "Re-analyse" path from cast confirm.
- **Mid-sentence split** — the panel only supports splitting AT a sentence boundary (after sentence N). Mid-sentence text splits would either duplicate, drop, or text-split a sentence; the cost / value tradeoff was rejected.
- **E2E Playwright coverage** — pending. The component-level tests cover the panel; the route-level tests cover the server. The browser-level golden path is a backlog follow-up.
- **Optimistic UI** — the panel waits for the server response before mutating the slice. Optimistic UI would buy ~200ms perceived snappiness against a meaningful risk of drift if validation rejects.

## Ship notes

- **Shipped:** 2026-05-18 via PR #23 (merge commit `024af60`), feature commit `6ad7af0`, visual-baseline refresh `19e6fe8`.
- **Delta vs spec:**
  - Confirm-cast modal entry deferred to a follow-up — single entry point shipped: listen-view header button (`src/views/listen.tsx`). Restructuring still works pre-generation; the user just navigates listen → restructure → back rather than confirm → modal → confirm.
  - Per-book write lock implemented as a `Map<bookId, Promise<void>>` chain in `server/src/routes/chapters-restructure.ts:54-74`.
  - The split-locator paragraph-bisection fallback logs via `console.warn`; the test in `server/src/workspace/restructure.test.ts` asserts the structural shape via `vi.spyOn(console, 'warn')`.
- **Test footprint:** 53 new tests (16 pure-transform + 8 audio-helper + 17 route end-to-end + 3 reducer + 9 panel component), all green in `npm run verify`. Visual baselines for the listen view (light + dark) re-captured in commit `19e6fe8` to account for the new header button.
