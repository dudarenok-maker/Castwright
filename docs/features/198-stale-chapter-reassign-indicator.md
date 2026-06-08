---
status: active
shipped: null
owner: null
---

# "Needs regeneration" indicator after reassigning sentences (Bug 2)

> Status: active (landing on `fix/frontend-stale-chapter-reassign-indicator`)
> Key files: `src/lib/stale-chapters.ts`, `src/views/generation.tsx`, `src/modals/reattribute-lines.tsx`, `src/views/manuscript.tsx`
> URL surface: `#/books/<id>/generate`
> OpenAPI ops: none (frontend-only, derived from existing persisted state)

## Benefit / Rationale

- **User:** After you reassign which character speaks a sentence in an
  already-generated chapter, the Generation row now flags it with an amber
  **"⚠ Sentences reassigned · regenerate to refresh"** caption — so you know the
  audio is out of date and can regenerate it, instead of silently shipping stale
  audio.
- **Technical:** The indicator is **durable** (survives reload) without a new
  stored field — it's derived from two pieces of already-persisted state: the
  change-log `boundary_move` events (one per reassignment) and the chapter's
  `audioRenderedAt` render stamp.
- **Architectural:** Establishes the rule that **every** sentence-reassignment
  path must emit a `boundary_move` (the durable signal depends on it). Closed the
  one path that didn't (`reattribute-lines` modal).

## Architectural impact

- **New seam:** pure helpers `latestReassignAt` + `isChapterStaleFromReassign` in
  `src/lib/stale-chapters.ts`. A `stale` boolean is computed at the GenerationView
  level (it already selects `changeLog.events`) and passed to each `ChapterRow`.
- **Detection rule:** a `done` chapter is stale iff its most-recent `boundary_move`
  (newest-first scan of `changeLog.events`) is newer than `chapter.audioRenderedAt`.
- **Precedence:** the stale caption wins over the informational mixed-engine and
  engine-drift "done" captions — the user's own edit is the most actionable signal.
- **Reversibility:** delete the helper + the caption branch + the `stale` prop.

## Invariants to preserve

- **Every reassignment path emits a `boundary_move`.** Verified sites:
  `manuscript.tsx` drag (`commitBoundaryMove`), segment reassign (`reassignSegment`),
  per-sentence inspector (`onReassignSentence`), selection popover whole-sentence +
  split (`assignSelectionTo`), and the `reattribute-lines` modal (added here). A new
  reassignment path MUST emit one or it won't flag staleness.
- **Stale requires `state === 'done'` AND `audioRenderedAt`** — a queued/legacy
  chapter is never flagged.

## Test plan

### Automated coverage

- Vitest (`src/lib/stale-chapters.test.ts`) — `latestReassignAt` (newest-first,
  ignores non-boundary_move) and `isChapterStaleFromReassign` (stale after render,
  not-stale before render / non-done / no-stamp / no-reassignment).
- Vitest (`src/views/generation.test.tsx`) — the caption renders on a done chapter
  reassigned after render; hidden when never reassigned; hidden on a queued chapter.
- Vitest (`src/modals/reattribute-lines.test.tsx`) — the modal's reassign logs a
  `boundary_move` (the staleness precondition).

### Documented coverage gap (deliberate)

No Playwright e2e for the **cross-view** manuscript-reassign → generate-caption flow:
the mock fixtures don't currently offer a book that is BOTH `done` with an
`audioRenderedAt` stamp AND has reassignable manuscript sentences (`sb` is done but
has no manuscript; `cc` has a manuscript but its chapters are queued), and bending
either risks the existing `profile-regen-preview` / `revision-diff` specs. The logic
(`isChapterStaleFromReassign`), the render (the caption), and the emission
(every reassignment site) are covered by the unit/integration tests above; the only
un-e2e'd link is redux change-log persistence across a hash navigation, which is
inherent redux behavior. Follow-up: add the e2e once a done+manuscript fixture exists.

### Manual acceptance walkthrough

1. Generate a chapter (it becomes `done`, stamped `audioRenderedAt`).
2. Open the manuscript, reassign a sentence's speaker in that chapter.
3. Go to the Generate view → the chapter row shows
   **"⚠ Sentences reassigned · regenerate to refresh"**; the Regenerate-this-chapter
   control sits eye-level below.
4. Reload → the caption is still there (derived from persisted change-log +
   render stamp).
5. Regenerate the chapter → a fresh `audioRenderedAt` clears the caption.

## Out of scope

- **Precise per-sentence net-diff.** This v1 is time-based/optimistic: reassign-then-
  undo still reads stale until regenerated. The precise version (snapshot the
  per-sentence speaker map at render time, compare net mapping) is a filed follow-up.

## Ship notes

(Filled when merged to main.) Lands on `fix/frontend-stale-chapter-reassign-indicator`.
Frontend-only; no live-GPU acceptance required.
