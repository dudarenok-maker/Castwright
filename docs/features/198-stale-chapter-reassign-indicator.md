---
status: active
shipped: null
owner: null
---

# "Needs regeneration" indicator after reassigning sentences (Bug 2)

> Status: active (landing on `fix/frontend-stale-chapter-reassign-indicator`)
> Key files: `src/lib/stale-chapters.ts`, `src/views/generation.tsx`, `src/modals/reassign-lines.tsx`, `src/views/manuscript.tsx`
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
  one path that didn't (`reassign-lines` modal).

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
  split (`assignSelectionTo`), and the `reassign-lines` modal (added here). A new
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
- Vitest (`src/modals/reassign-lines.test.tsx`) — the modal's reassign logs a
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

## Precise per-sentence diff (#650 — supersedes the time-based v1)

The time-based heuristic above has one false positive: a reassign-then-undo still
reads stale until regenerated. The precise follow-up (#650) removes it without losing
immediacy:

- **Server** (`segments-io.ts` `collectRenderedSpeakerMaps` → book-state GET
  `renderedSpeakersByChapter`): recovers the render-time `sentenceId → characterId`
  map per rendered chapter from each chapter's `segments.json` (`segments[].sentenceIds`
  + `characterId` — already persisted, no new render-time snapshot needed).
- **Frontend** (`isChapterReassignedSinceRender`): the Generate view diffs that map
  against the **live** manuscript. The diff is asymmetric (iterate the rendered ids):
  a rendered sentence whose current speaker differs (reassign) or that's now gone
  (split/merge/delete) ⇒ stale; a current sentence never in the render map can't trip
  a false positive. **Immediate** (recomputed from the live manuscript slice, no
  refetch — important because navigating manuscript→generate does NOT re-GET, see
  `layout.tsx:671`) AND **precise** (reassign-then-undo ⇒ maps match ⇒ not stale).
- **Fallback:** the row uses the precise diff when the server shipped a render map for
  the chapter, else the time-based heuristic — so older servers / mocks still flag
  staleness with no regression.

## Precise per-sentence TEXT diff (#1105 — the text sibling of #650)

The #650 diff compares `characterId` only, so it misses a **text edit** of an
already-rendered sentence (Script Review `strip_tag`, a future manual editor, or a
direct `manuscript-edits.json` / MCP edit). Synth is keyed on sentence text, so an
edited line's audio is stale on **every** engine — yet, before #1105, the only
text-staleness signal was the transient `boundary_move` the strip_tag UI happened to
log, invisible to any edit path that touches the JSON directly. #1105 makes text
staleness **derivable from the persisted JSON**, mirroring #650:

- **Server (render time)** (`synthesise-chapter.ts`): each segment is stamped with a
  `textHash` — `textHashForStale(group.text)`, a djb2-base36 hash of the RAW sentence
  text — into `segments.json`. New renders only; pre-#1105 renders carry no hash.
- **Server (book-state GET)** (`segments-io.ts` `collectRenderedTextHashesByChapter`
  → `renderedTextByChapter`): inverts each chapter's segments into a
  `sentenceId → textHash` map. A chapter with no stamped hashes (pre-#1105 render) is
  omitted, so the client reads it as "can't tell" rather than "all edited".
- **Frontend** (`isChapterTextEditedSinceRender`): the Generate view hashes the live
  raw `sent.text` and diffs it against the render-time hash — same asymmetric,
  reload-surviving, false-positive-free shape as #650 (edit-then-revert ⇒ hashes
  match ⇒ not stale). Added as a third clause to the Generate-row OR-gate.
- **Cross-package hash contract:** `textHashForStale` is defined byte-identically in
  `src/lib/stale-chapters.ts` and `server/src/audio/segments-io.ts`; a shared vector
  (`'"Stop," she said.'` → `2rq6ja`) is pinned in BOTH test files so a drift on either
  side fails loudly. Hash the RAW text on both sides (the server stamps `group.text`
  pre-normalisation; the client hashes live `sent.text`) so normalisation can't desync.
- **Why not the stale-audio banner:** the `setStaleAudio` banner (emotion/instruct
  edits) is session-only, character-keyed (wrong semantics for a text change), and
  invisible to a direct-JSON edit — so it can't be the source of truth for text
  staleness. The derived diff is.

Coverage: `isChapterTextEditedSinceRender` + `textHashForStale` units
(`stale-chapters.test.ts`); `collectRenderedTextHashesByChapter` + the hash vector
(`segments-io.test.ts`); the GET field (`book-state.test.ts`); the Generate-row badge
on a text edit with speakers unchanged (`generation.test.tsx`).

## Inline audio-tag false positive (fix — strip tags before hashing both sides)

The #1105 text diff assumed "the server stamps the RAW group text and the client
hashes the RAW `sent.text`, so they can't desync." That was false for any sentence
carrying an inline audio tag (`[emphatic]`, `[shouting]`, … — the closed `AUDIO_TAGS`
vocabulary). The synth path strips those tags before synthesis (`text-normalize.ts`
`stripAudioTags` / `emotion-from-tags.ts`), so the render stamps the hash over the
**spoken** text (`[emphatic] Ende.` → `Ende.`), while the manuscript deliberately
keeps the tag for display. The two hashes never match → the chapter reads permanently
`⚠ Sentences reassigned · regenerate to refresh`, and **regenerating cannot clear it**
(the next render re-strips and re-stamps the stripped hash while the manuscript keeps
the tag).

**Fix:** strip audio tags on BOTH sides before hashing, so the compared text is the
spoken text the audio was actually keyed on.
- Server: `synthesise-chapter.ts` stamps `textHashForStale(stripAudioTags(group.text))`
  (idempotent — `group.text` is usually already stripped upstream; this pins the
  contract for an un-migrated book whose analysis cache still holds the tag).
- Frontend: `isChapterTextEditedSinceRender` hashes `stripAudioTags(liveText)`, via a
  new `src/lib/audio-tags.ts` mirror of the server `AUDIO_TAGS` + `stripAudioTags`
  (the mirror the server `parsers/audio-tags.ts` header already referenced).
- **Cross-package strip contract:** the two `stripAudioTags` implementations are pinned
  by a shared vector (`'She said [emphatic] hello.'` → `'She said hello.'`) in
  `src/lib/audio-tags.test.ts` AND `server/src/tts/text-normalize.test.ts`, mirroring
  the existing `textHashForStale` vector, so a drift on either side fails loudly.
- A tag-only difference now reads NOT stale; a REAL edit to the spoken words of a
  tagged sentence still reads stale.

Fixes the false positive on existing renders with no re-render needed (the frontend
diff recomputes from the live manuscript). Covered by
`src/lib/stale-chapters.test.ts` (regression: tag-only → not stale; spoken-word edit
→ stale), `src/lib/audio-tags.test.ts`, and the server strip vector.

## Out of scope

- The `setStaleAudio` banner is intentionally NOT fired on text edits (see above).
- Backfilling text hashes onto books rendered before #1105 — they fall back to the
  time-based `boundary_move` heuristic until their next render (decision: new renders
  only, no migration).
- The shared "Sentences reassigned" caption still labels a text/exclude/instruct edit
  as "reassigned" (it covers the whole 5-clause OR-gate). That wording is a separate,
  pre-existing cosmetic issue, tracked apart from this correctness fix.

## Ship notes

Bug-2 time-based indicator shipped on `fix/frontend-stale-chapter-reassign-indicator`
(PR #651, merged 2026-06-08). The precise per-sentence diff (#650) shipped on
`feat/server-precise-reassign-stale` (2026-06-08). Frontend + a GET-only server field;
no live-GPU acceptance required.
