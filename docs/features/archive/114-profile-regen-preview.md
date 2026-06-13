---
status: stable
shipped: 2026-05-26
owner: null
---

# Profile-change regeneration with opt-in one-chapter A/B preview

> Status: stable
> Key files: `src/modals/character-regenerate.tsx`, `src/components/layout.tsx` (modal `onConfirm` + `RevisionDiffPlayer` accept/reject), `src/store/generation-stream-middleware.ts` (preview gate), `src/store/ui-slice.ts` (`previewRegen`), `src/views/revision-diff.tsx` (`mode`), `src/components/stale-audio-banner.tsx`, `src/lib/build-pending-revision.ts`
> URL surface: modal overlay + the full-screen A/B player; no URL component
> OpenAPI ops: indirect — `POST /api/books/:bookId/generation` (whole-chapter render), `DELETE`/`POST` `…/audio/previous{,/restore}` (accept/reject)

## Benefit / Rationale

Replaces the misleading "regenerate by profile / by character" surface. There is
**no per-character synthesis** — `server/src/routes/generation.ts` →
`synthesiseChapter` always re-renders the entire chapter and overwrites the
chapter MP3; the old `scope:'character'` flag never reached the server. So a
voice change can only be applied by re-rendering whole chapters.

- **User:** changing a character's voice offers a clear choice — regenerate every
  chapter that character speaks in now, OR preview the new voice on the first
  affected chapter (old vs new A/B) and only commit the rest after approving.
  Reject reverts that one chapter and lets you re-adjust — no wasted full-book
  re-render, no silent "nothing happened".
- **Technical:** one honest regeneration unit (the chapter). All regen enqueues
  use `scope:'this'`; the per-character queue scope, the `regenerateCharacter` /
  `batchRegenerateCharacters` reducers, and the cast-view batch modal are gone.
- **Architectural:** the existing revisions / A/B-diff / `.previous.*`
  accept-reject machinery (plan 20) is **repurposed** as the preview gate rather
  than deleted — the pending-revision stub is now created on the preview
  chapter's `chapter_complete`, not on every character regen.

## Architectural impact

- **New seam:** `ui.previewRegen` (`{ characterId, previewChapterId,
  remainingChapterIds, reason, note } | null`) — transient, never persisted
  (`src/store/index.ts` whitelist). Set when the user picks "Preview first";
  cleared on Approve / Reject.
- **Preview gate:** `generation-stream-middleware` observes
  `revisions/markRevisionPlayable`; when it matches `previewRegen.previewChapterId`
  it builds a **playable** stub (`buildPendingRevisionStub({ …, playable: true })`)
  and dispatches `setShowRevisionPlayer(true)`. Built fresh on completion so a
  mid-render revisions poll (`applyPoll` replaces `pending` wholesale) can't
  leave the gate without a revision to show.
- **Preserved invariants:** OpenAPI is the type source of truth — no
  `openapi.yaml` / `api-types.ts` change (the `Revision` shape is unchanged; the
  preview stub reuses it). No server change at all. RTK immer reducers untouched.
- **Tolerated-not-emitted:** `QueueScope = 'this' | 'character'`
  (`server/src/workspace/queue-io.ts`) keeps `'character'` so a pre-existing
  `.queue.json` row still validates on cold boot; the frontend only ever emits
  `'this'`, and the dispatcher maps any entry to a whole-chapter regen.
- **Reversibility:** removing `ui.previewRegen` + the middleware observer reverts
  to "every regen applies immediately"; the revisions subsystem is independent.

## Invariants to preserve

1. The CharacterRegenerateModal's affected set = chapters where
   `ch.characters[characterId]` exists and ≠ `'skipped'`, in reading order;
   `chapterIds[0]` is the preview sample (`src/modals/character-regenerate.tsx`).
2. `onConfirm({ …, preview })` — `preview:false` enqueues every affected chapter
   (`scope:'this'`) immediately + a change-log entry; `preview:true` sets
   `ui.previewRegen` and enqueues only `previewChapterId` (no change-log yet).
3. A plain chapter regen does **not** create a pending-revision stub — there is
   no accept gate except the opt-in preview (`generation-stream-middleware.ts`).
4. Preview **Approve** = `acceptChapterRevision` (delete `.previous`) + enqueue
   `remainingChapterIds` (`scope:'this'`) + one change-log entry covering the
   full set + clear `previewRegen`. **Reject** = `rejectChapterRevision`
   (restore `.previous`) + clear `previewRegen`, nothing else enqueued
   (`src/components/layout.tsx` `RevisionDiffPlayer` handlers).
5. The drift report's Regenerate / Auto-regen trigger an immediate whole-chapter
   regen (`scope:'this'`), not a per-character regen and not a preview.

## Test plan

### Automated coverage

- Vitest (`src/modals/character-regenerate.test.tsx`) — affected set excludes
  skipped/absent chapters; the two footer buttons fire `onConfirm` with the
  right `preview` flag; both disabled when the character speaks nowhere
  (invariants 1–2).
- Vitest (`src/store/generation-stream-middleware.test.ts`) —
  `markRevisionPlayable` for the previewed chapter builds a playable stub +
  opens the player; a completion outside a preview makes no stub and doesn't
  open the player (invariant 3 + the gate).
- Vitest (`src/components/stale-audio-banner.test.tsx`) — "Regenerate" opens the
  CharacterRegenerateModal + clears the banner, with no direct enqueue.
- Vitest (`src/views/cast.test.tsx`) — the selection pill no longer offers a
  Regenerate button (only Compare + Clear).
- Vitest (`src/store/chapters-slice.test.ts`) — the surviving
  `regenerateChapterIds` reducer keeps its head-flip / queue / excluded-skip
  coverage (the removed-reducer tests are gone).

### Not covered automatically

The full preview → Approve-fans-out / Reject-reverts click-through is **not**
e2e'd: mock mode does not hydrate chapters from the library payload, so
`RevisionDiffPlayer` returns null under mocks (the same gap documented in
`e2e/revision-diff.spec.ts`). The layout Approve/Reject handlers (invariant 4)
are therefore covered by the unit seams above + manual acceptance below; closing
the mock-chapters gap (to enable the A/B e2e) is the follow-up tracked in
`docs/BACKLOG.md`.

### Manual acceptance walkthrough

Run against the real backend (mock mode can't open the A/B player). Canonical
manuscript: `server/src/__fixtures__/the-coalfall-commission.md`.

1. Cast view, select 2 characters → floating pill shows **Compare + Clear only**.
2. Open a character's profile drawer, change the voice, Save → stale-audio banner
   → **Regenerate…** opens the modal listing the N chapters the character speaks
   in (CH X tagged "preview").
3. **Regenerate all N** → every affected chapter queues + applies immediately; no
   A/B player.
4. Re-trigger → **Preview CH X first** → only CH X renders; on completion the A/B
   player auto-opens (eyebrow "Voice preview · A/B").
5. **Approve — regenerate the rest** → CH X keeps the new take, the remaining
   chapters queue and apply with no further A/B.
6. Re-trigger → preview → **Reject & re-adjust** → CH X reverts to its previous
   audio; nothing else queues.
7. Drift report → **Regenerate** / **Auto-regen** re-render that chapter
   immediately (no preview); the inline Listen widget still works.

## Out of scope

- True per-character / per-segment splicing — not feasible without a chapter-audio
  rearchitecture (the chapter is one concatenated, re-encoded PCM stream).
- Multi-character bulk regen (the removed cast-view batch modal) — superseded by
  the single-character flow.
- A browser-level e2e for the preview gate — blocked by the mock-chapters
  hydration gap (see "Not covered automatically").

## Ship notes

Shipped 2026-05-26 on `feat/frontend-profile-regen-preview` via PR #257 (merge
commit `12f4152`). Replaces plan 11 (batch character regenerate, removed) and the
per-character half of plan 17; repurposes the plan 20 revisions A/B as the
preview gate (drift-triggered regen now applies immediately).
