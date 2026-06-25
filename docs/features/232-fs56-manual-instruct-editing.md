---
status: active
shipped: null
owner: null
---

# 232 — fs-56: Manual per-line instruct editing UI

> Status: active
> Key files: `src/store/manuscript-slice.ts`, `src/store/persistence-middleware.ts`, `src/components/sentence-instruct-control.tsx`, `src/views/manuscript.tsx`
> URL surface: `#/books/<id>/manuscript`
> OpenAPI ops: none (frontend-only; the engine path shipped via fs-57)

## Benefit / Rationale

- **User:** An author can hand-write or refine the per-line free-text delivery direction ("instruct") on any manuscript line — narrator included — rather than accepting only whatever Stage-3 LLM proposed. The top rung of the resolver's `manual › analyzer › emotion-derived › neutral` precedence ladder (shipped in fs-57) is now reachable from the UI.
- **Technical:** No new schema, no server changes, no migration. The `instruct` field already exists on `Sentence` (fs-57). The "manual wins" invariant is entirely the fill-only semantics of the existing `applyDetectedInstruct` reducer; `setSentenceInstruct` is the manual write site that activates the top rung.
- **Architectural:** Mirrors the shipped fs-25 emotion-tag pattern exactly (manual write site + fill-only detect = "manual wins" without a provenance field). Locks in the deliberate single-field, no-provenance tradeoff. Expressive narration (every line) vs fs-25's dialogue-only scope.

## Architectural impact

- **New seams / extension points:** `manuscriptActions.setSentenceInstruct({chapterId, sentenceId, instruct})` is the manual write site; `'manuscript/setSentenceInstruct'` persist entry in `persistence-middleware.ts`; `SentenceInstructControl` component. `liveInstruct` boolean resolved once at the `Manuscript` top level via `selectLiveInstruct(bookId)` and threaded down as a plain prop (never called per-sentence — the 500-selector-per-render trap).
- **Invariants preserved:** Single `instruct` field; no provenance marker; change-log silent for instruct edits (same as emotion); audibility/staleness gate on per-book `liveInstruct` only; the per-character `is17b` model key is a server detail the client does not reconstruct.
- **Migration story:** None. `instruct` already serialises as part of each sentence in `manuscript-edits.json`. A blank value deletes the field; no empty-string tombstones accumulate.
- **Reversibility:** Frontend-only. Disabling the control leaves existing `instruct` values intact but unreachable from the UI; the resolver continues to consume them from the store.

## Invariants to preserve

1. **Single field, fill-only "manual wins"** — `applyDetectedInstruct` in `src/store/manuscript-slice.ts` is fill-only (`if (!sent.instruct && ann.instruct !== undefined)`). A hand-set `sent.instruct` survives a "Detect emotions" re-run because the guard skips a populated field. `setSentenceInstruct` is the manual write site; `applyDetectedInstruct` is the analyzer write site.
2. **Change-log silent for instruct edits** — `setSentenceInstruct` does NOT dispatch `changeLogActions`. The change-log tracks structure/attribution (boundary moves, character reassignments), not per-line delivery tags. Matches the `setSentenceEmotion` precedent.
3. **Audibility/staleness gate on `liveInstruct` ONLY** — the client never reconstructs the per-character `is17b` model key (a server detail). `!liveInstruct` means definitely silent → muted chip + caption; `liveInstruct === true` → conservatively mark stale-if-rendered (may over-flag on Qwen 0.6B, but never under-flags an audible change). Never assert a per-line "audible" verdict.
4. **Control ungated — every sentence including narrator** — `SentenceInstructControl` renders for every sentence in `manuscript.tsx` with no dialogue-only or tagged-only gate. fs-56 is expressive narration.
5. **Split/merge do not bleed a hand-set instruct** — relies on `#1100` (commit `ce88c662`), which nulls `instruct`/`vocalization` on split fragments and merge survivors. The guard tests in `manuscript-slice.test.ts` (Task 4) make this dependency explicit and fail loudly if the base regresses.
6. **`liveInstruct` resolved once, not per sentence** — `useAppSelector(selectLiveInstruct(bookId))` is called at the `Manuscript` top level; a plain boolean is threaded through `SegmentRowProps` to `SentenceInstructControl`. Calling the selector inside each row on a 500-sentence chapter is prohibited (500 selector invocations per render).

## Test plan

### Automated coverage

- Vitest unit (`src/store/manuscript-slice.test.ts`) — `setSentenceInstruct` sets / trims / clears (whitespace → `undefined`) / scoped by `(chapterId, sentenceId)` / no-op on unknown id.
- Vitest unit (`src/store/manuscript-slice.test.ts`) — fill-only protection: after a manual `setSentenceInstruct`, `applyDetectedInstruct` must NOT overwrite the hand-set value (locks "manual wins").
- Vitest unit (`src/store/manuscript-slice.test.ts`) — split guard: a hand-set instruct on a sentence does not bleed onto the second fragment after `splitSentence` (tail fragment `instruct === undefined`; head keeps the original).
- Vitest unit (`src/store/manuscript-slice.test.ts`) — merge guard: a hand-set instruct on the surviving sentence is cleared by `mergeSentences` (survivor's `instruct === undefined` post-merge).
- Vitest component (`src/components/sentence-instruct-control.test.tsx`) — empty chip exposes `aria-label="Set delivery direction for this line"`; set chip exposes `"Delivery direction: <text> — edit"`; opening pre-fills the textarea with the current/LLM instruct; focus lands on the textarea (a11y); Save dispatches the trimmed value; Clear dispatches `''`; Escape closes and returns focus to the chip; outside-click closes without dispatch; muted chip style + 1.7B caption show when `liveInstruct === false`.
- Playwright e2e (`e2e/manuscript-instruct-edit.spec.ts`) — golden path: open a line's instruct popover, type a direction, Save, chip shows the truncated preview, re-open confirms the value round-trips into the textarea. Crosses the redux↔manuscript-view seam.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`, `npm run dev`). Navigate to a book's manuscript view.

1. **Ungated chip on every line** — scroll through the manuscript. Verify a faint 🎬 icon reveals on row hover/focus for both narrator and dialogue lines (empty state is opacity-0/hover-reveal on desktop, faint on touch via `coarse-pointer:opacity-40`).
2. **Open and edit an LLM-proposed instruct** — find a line that Stage-3 proposed an `instruct` for (if any in the mock data). Click its chip. Verify the popover textarea pre-fills with the LLM suggestion. Edit it (e.g. "a sharp, startled whisper"), click Save. Verify the chip updates to show the first ~24 chars of the new text with an ellipsis.
3. **Persists across reload** — reload the page. Verify the chip still shows the hand-set instruct preview and re-opening the popover still shows the full text in the textarea (`manuscript-edits.json` round-trip).
4. **Re-detect does not overwrite** — run "Detect emotions" (if available in mock mode) or simulate an `applyDetectedInstruct` dispatch. Verify the hand-set instruct is unchanged (fill-only).
5. **Clear removes the field** — open the popover for the edited line, click Clear. Verify the chip reverts to the empty faint-icon state. A subsequent "Detect emotions" run may refill it (fill-only; named tradeoff, accepted).
6. **`liveInstruct` off — muted chip + caption** — toggle "Live expressive delivery" off for the book (Settings). Open any instruct chip. Verify the chip is rendered with muted/opacity-50 styling and the popover shows the caption "Delivery directions play on the Qwen 1.7B tier with Live expressive delivery on." Verify the textarea is still editable (the control stays enabled).
7. **`liveInstruct` on — staleness** — re-enable Live expressive delivery. Edit an instruct on a chapter that has already rendered audio. Verify an amber staleness banner ("re-render available" or equivalent) appears on that chapter's generate row (conservative: fires when `liveInstruct === true` regardless of the per-character model tier).
8. **Split/merge guard** — set an instruct on a sentence, then split it. Verify the head fragment keeps the instruct and the tail fragment has none. Merge two sentences where the survivor has an instruct; verify the merged survivor's instruct is cleared.

## Out of scope

- Any change to the synth path, the `resolveInstructForGroup` resolver, or the Stage-3 analysis pass — all shipped by fs-57 (plan 231).
- A "manual vs analyzer" provenance field — explicitly deferred as YAGNI for v1 (named tradeoff; would require a schema migration + UI complexity with no current requirement).
- A per-sentence "suppressed" tombstone to prevent re-detect from re-filling a cleared instruct — also deferred (the "clear → let model decide again" behaviour matches the emotion-backfill precedent; a tombstone is a follow-up if it proves annoying in practice).
- fs-58 `setSentenceText` staleness-on-text-edit — a separate pre-existing gap, filed as #1105.

## Links

- Design spec: `docs/superpowers/specs/2026-06-25-fs56-manual-instruct-editing-design.md`
- Implementation plan: `docs/superpowers/plans/2026-06-25-fs56-manual-instruct-editing.md`
- Issue: [#996](https://github.com/dudarenok-maker/Castwright/issues/996)
- Predecessor (engine path): plan 231 (`docs/features/231-fs57-vocalizations-instruct.md`)
- Split/merge base dependency: #1100 (commit `ce88c662`)

## Ship notes

(Filled in when status flips to `stable`. Append: shipped date, commit SHA, any behaviour delta vs. the original spec. Once filled, the plan becomes eligible for archive — move to `docs/features/archive/` in the same PR as the ship.)
