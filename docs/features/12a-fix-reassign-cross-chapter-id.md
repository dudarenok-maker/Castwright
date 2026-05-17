---
status: stable
shipped: 2026-05-18
owner: null
---

# Fix — sentence reassignment scoped by (chapterId, id)

> Status: stable (shipped 2026-05-18)
> Cross-links: [12 — Manuscript view](12-manuscript-view.md) — this plan patches invariant 4 and the **Key files** line of plan 12 to reflect the chapterId-scoping contract.
> Key files: `src/store/manuscript-slice.ts` (`setSentenceCharacter`, `setSentencesCharacter`, `splitSentence`), `src/views/manuscript.tsx` (`commitBoundaryMove`, `reassignSegment`, `assignSelectionTo`, inline `onReassignSentence`, `SegmentInspector` prop), `src/store/manuscript-slice.test.ts`, `src/views/manuscript.test.tsx`
> URL surface: `#/books/:bookId/manuscript?chapter=N` — fix is invisible at the URL layer; the bug surfaced as "clicks do nothing" in chapters whose sentence ids collide with chapter 1's.
> OpenAPI ops: none — the on-the-wire `PUT /api/books/:bookId/state` payload (a full sentences array) doesn't change. Only in-memory action payloads change.

## Benefit / Rationale

- **User:** clicking a character chip in the Manuscript inspector now actually reassigns the sentence the user clicked, on any chapter — not just chapter 1. Before the fix, reassigning a sentence in chapter 2+ silently mutated chapter 1's same-id sentence and the visible chapter didn't update. Surfaced by the user as "clicks don't do anything".
- **Technical:** the three sentence-targeting reducers now match the same `(chapterId, id)` keying the hydrate merge already used (`src/store/manuscript-slice.ts:86-88`). One internal contract, three reducers, four callsites.
- **Architectural:** locks the keying invariant for any future sentence-targeting reducer. Anyone adding `markSentenceAsTagged` or similar will inherit the right contract by example.

## Why this regressed

Plan 12's invariants documented the *public* shape of reassignment (action name, PUT payload) but never the *internal* keying. The hydrate merge picked up `(chapterId, id)` keying when the "whole book under the last chapter" bug forced the issue, but the reassign reducers were written earlier against the single-chapter fixture (`src/data/sentences.ts`, all chapter 3) and never re-examined. Unit tests in `manuscript-slice.test.ts` for `setSentenceCharacter` / `setSentencesCharacter` only used chapter-1 sentences, so the collision was invisible to the suite. There was no existing jsdom integration or e2e for the reassign flow, so the prop-wiring seam was uncovered too.

## Architectural impact

- **Action payload signature change** (in-process only — does not cross the OpenAPI boundary). Three reducers gain a required `chapterId: number`:
  - `setSentenceCharacter({ chapterId, sentenceId, characterId })`
  - `setSentencesCharacter({ chapterId, sentenceIds, characterId })`
  - `splitSentence({ chapterId, sentenceId, offsets, characterIds })`
- **Callsites in `src/views/manuscript.tsx` (4)** all already have the chapterId in scope:
  - `commitBoundaryMove` — segments are built per current chapter; passes `currentChapterId`.
  - `reassignSegment` — segment is single-chapter; passes `seg.sentences[0].chapterId`.
  - `assignSelectionTo` — also fixed the standalone `sentences.find(s => s.id === selection.sentenceId)` to scope by `currentChapterId`; passes `currentChapterId` to the reducer.
  - Inline `onReassignSentence` — `SegmentInspector` prop widened to `(chapterId, sentenceId, newCharId) => void` so the inspector forwards `s.chapterId`.
- **`SegmentInspector` prop signature change** is local to `src/views/manuscript.tsx` — no other consumers.
- **Invariants preserved (00, 24, 25, 26):** the discriminated-union `ui.stage`, the OpenAPI types, `Sentence` shape, design tokens, and the RTK Immer mutation pattern are all untouched.
- **PUT payload (`src/lib/types.ts:131-134`) is unaffected** — the slice still ships its full `sentences[]` to disk and the server still merges. Only the in-memory reducer scoping changes.
- **Migration story:** none — no on-disk format change, no env flag, no fixture migration.
- **Reversibility:** straightforward `git revert` — the change is a contained signature widen across one slice, one view, two test files.

## Invariants to preserve

1. **Reassignment reducers scope by `(chapterId, id)`, not `id` alone.** Enforced in `src/store/manuscript-slice.ts` — `setSentenceCharacter`, `setSentencesCharacter`, and `splitSentence` find sentences using both fields. Mirrors the `${x.chapterId}:${x.id}` keying that `hydrateFromAnalysis` (`src/store/manuscript-slice.ts:86-88`) already uses.
2. **Callers always pass the chapterId of the sentence(s) being mutated.** In `src/views/manuscript.tsx`, the chapterId either comes from `currentChapterId` (selection / boundary drag) or from `seg.sentences[0].chapterId` (segment inspector, since segments are built per chapter at `src/views/manuscript.tsx:80-90`).
3. **`SegmentInspector.onReassignSentence` prop signature is `(chapterId: number, sentenceId: number, newCharId: string) => void`** — the inspector forwards `s.chapterId` from the per-sentence reassign callback so the parent does not need to look the chapterId up again.
4. **No on-the-wire shape change.** The `PUT /api/books/:bookId/state` body remains `{ slice: 'manuscript', patch: { sentences: Sentence[] } }`. Each `Sentence` already carries `chapterId`, so the server side needs no updates.

## Test plan

### Automated coverage

- **Vitest unit (`src/store/manuscript-slice.test.ts`)** — three new regression specs added next to the existing reducer specs, mirroring the hydrate-merge "keeps per-chapter sentence ids distinct" pattern:
  - `setSentenceCharacter scopes by chapterId — chapter 2 reassignment leaves chapter 1 untouched`
  - `setSentencesCharacter scopes by chapterId — chapter 2 batch leaves chapter 1 untouched`
  - `splitSentence scopes by chapterId — chapter 2 split leaves chapter 1 untouched`
  
  Each one fails against the pre-fix reducer (matching by `id` alone returns the wrong chapter's sentence) and passes after the chapterId scoping lands. The existing `splitSentence` describe also gained `chapterId: 1` in every payload — behaviour they assert is unchanged.

- **Vitest jsdom integration (`src/views/manuscript.test.tsx`)** — new spec `ManuscriptView — cross-chapter reassign isolation` renders the full view with two chapters sharing sentence id=1, opens the SegmentInspector on chapter 2, clicks the Eliza chip in "Reassign whole segment to", and asserts via `store.getState().manuscript.sentences` that chapter 2's sentence is reassigned and chapter 1's same-id sentence is untouched. Pins the prop wiring (`SegmentInspector.onReassignSentence(chapterId, sentenceId, newCharId)`) end-to-end through real React + real redux.

- **No Playwright e2e** — the bug is a logic bug in the reducer + a one-line prop wiring change. It does not touch router, layout, focus, or hashchange seams (the cases CLAUDE.md cites jsdom as unreliable for). A Playwright spec would require either fixture surgery on the single-chapter `initialSentences` or a programmatic store-population shim; neither pays for itself given the slice unit tests already pin the reducer contract three ways and the jsdom integration test pins the prop wiring. If a future fixture refresh lands multi-chapter sentences as the default mock, file a backlog item to add `e2e/manuscript-reassign.spec.ts`.

### Manual acceptance walkthrough

Run `VITE_USE_MOCKS=true`, navigate to `#/books/<id>/manuscript`.

1. **Pick a multi-chapter book** → sidebar shows ≥ 2 chapters.
2. **Click chapter 2** in the sidebar → URL becomes `…?chapter=2`; sentences for chapter 2 render.
3. **Click any paragraph** → SegmentInspector opens on the right.
4. **In "Per-sentence reassign", expand the first sentence and click a different character chip** → the sentence's left-border colour updates immediately.
5. **Click chapter 1** in the sidebar → URL becomes `…?chapter=1`; chapter 1's same-id sentence still shows its original colour. **This is the regression check.** Before the fix, chapter 1's sentence would have stolen the reassignment.
6. **In "Reassign whole segment to" on chapter 2, click a different character** → all sentences in that segment recolour. Switch to chapter 1 → its same-id sentences are unaffected.
7. **Selection-popover path:** in chapter 2, highlight a few characters inside a sentence and assign to a different character via the popover. Chapter 1's same-id sentence is unaffected; chapter 2's sentence splits as expected.
8. **Boundary drag:** drag a paragraph boundary in chapter 2. Chapter 1 is untouched.
9. **Real mode** (`npm run dev` + `cd server && npm run dev`): repeat steps 4 and 5. Reload — the reassignment persists in chapter 2 and chapter 1 is still untouched.

## Out of scope

- **On-disk format migration.** `manuscript-edits.json` already stores `Sentence[]` with `chapterId` per entry, so no migration is needed.
- **Backfilling other under-tested reducers** in this slice. Scope strictly to the three reducers the bug touches.
- **Playwright e2e for the manuscript reassign flow.** See Automated coverage above for the trade-off.

## Ship notes

- **Shipped:** 2026-05-18.
- **Fix commit:** `c2af1ad` — `fix(frontend): scope sentence reassignment by chapterId`.
- **Merge commit:** `6010a60` — Merge pull request #1 from `fix/frontend-reassign-cross-chapter-id` into `main` (merge commit, not squash, per the branch-history convention).
- **Regression coverage that pins the fix:**
  - `src/store/manuscript-slice.test.ts` — three new specs: `setSentenceCharacter scopes by chapterId — chapter 2 reassignment leaves chapter 1 untouched`, `setSentencesCharacter scopes by chapterId — chapter 2 batch leaves chapter 1 untouched`, `splitSentence scopes by chapterId — chapter 2 split leaves chapter 1 untouched`.
  - `src/views/manuscript.test.tsx` — new spec `ManuscriptView — cross-chapter reassign isolation` (jsdom integration through real React + real redux).
- **Behaviour delta vs. the original spec:** none — the spec is the fix.
- **Plan 12 patch:** invariant 4 + Key files line + cross-link to this plan landed in the same commit.
- **Archive policy:** this sibling fix plan retires alongside plan 12 if/when plan 12 ever archives.
