---
status: active
shipped: null
owner: null
---

# `voices_pending` book stage

> Status: active
> Key files: `server/src/workspace/scan.ts`, `src/store/ui-slice.ts`, `src/components/library/library-status-ui.tsx`, `src/components/library/library-grid.tsx`, `src/views/book-library.tsx`, `src/mocks/library.ts`
> URL surface: `#/books/<id>/cast` (a reopened `voices_pending` book lands here)
> OpenAPI ops: `GET /api/library` (the `status` enum gains `voices_pending`)

Design: [docs/superpowers/specs/2026-07-12-voices-pending-stage-design.md](../superpowers/specs/2026-07-12-voices-pending-stage-design.md).
Plan: [docs/superpowers/plans/2026-07-12-voices-pending-stage.md](../superpowers/plans/2026-07-12-voices-pending-stage.md).

## Benefit / Rationale

- **User:** a book whose cast you've confirmed but haven't started narrating now reopens on the **Cast** view (where voice design lives) instead of jumping to the **Generate** tab, and shows a **"Cast ready"** badge in the library. Voice design is no longer skippable by reopening from the library.
- **Technical:** the new status is **derived from disk** (`castConfirmed && !generationStarted && not-complete`, where `generationStarted = completedChapters > 0 || any chapter failed`) — no new `state.json` field, no migration, no server-side replication of the client's `resolveVoiceStatus`.
- **Architectural:** splits the overloaded `generating` status (which previously meant both "cast confirmed" and "actively rendering") into a pre-generation staging state, so client routing can distinguish them.

## Architectural impact

- **New seam:** `LibraryBookStatus` gains `voices_pending` in three hand-synced places — `server/src/workspace/scan.ts`, `src/lib/types.ts`, and generated `src/lib/api-types.ts` (from `openapi.yaml` via `npm run openapi:types`). The `STATUS_UI` map (`Record<LibraryBookStatus, StatusMeta>`) forces the client badge entry at compile time.
- **Invariants preserved:** the `scan.ts` status ladder still resolves every prior status identically — the new branch adds `!generationStarted` and shares the `completedChapters < chapterCount` guard, so anything it rejects the next (`generating`) branch catches, and complete/excluded-only books stay on the `complete` path. `openBook` (`ui-slice.ts`) routing is unchanged for existing statuses; `voices_pending` falls through the `else` to the `cast` view.
- **Migration story:** none. Purely derived — a book that was `generating` with 0 rendered chapters and 0 failures now reports `voices_pending` on the next scan; the reverse (once a chapter renders or fails) flips it back to `generating`.
- **Reversibility:** delete the `voices_pending` branch in `scan.ts` and the status reverts to `generating` for those books; the client would then never receive the value (defensive fallback keeps the grid safe regardless).

## Invariants to preserve

1. `server/src/workspace/scan.ts` status ladder order: the `voices_pending` branch sits **between** `cast_pending` and `generating`, both guarded by `state.castConfirmed && completedChapters < chapterCount`; `voices_pending` additionally requires `!generationStarted`.
2. `generationStarted` (scan.ts) = `completedChapters > 0 || activeChapters.some(c => c.generationState === 'failed')`. Do not add a persisted flag.
3. `isConfirmed` (scan.ts) includes `voices_pending` alongside `generating`/`complete` — a `voices_pending` book **is** a confirmed cast, so series-memory counting must not drop it.
4. `openBook` (`src/store/ui-slice.ts`) routes `voices_pending` → `{ kind: 'ready', view: 'cast' }` (via the `else`/`'cast'` fall-through).
5. `STATUS_UI.voices_pending` (`src/components/library/library-status-ui.tsx`) = `{ color: 'library', label: 'Cast ready', icon: <IconCheckCircle/> }`.
6. `IN_PROGRESS_STATUSES` (`src/views/book-library.tsx`) includes `voices_pending` (counts under "In progress").
7. `layout.tsx` `bgBookIds` background-revisions poll **excludes** `voices_pending` (alongside `cast_pending`/`analysing`/`not_analysed`/`unreadable`/`orphaned`) — a `voices_pending` book has zero rendered audio, so there is nothing to drift-poll.
8. **Positive-vs-negative-list rule:** `status === 'generating'` positive-list checks are the hazard when splitting a status off `generating`; negative-list checks (`status !== …`) are safe. The one negative-list filter that needed the new value added is `layout.tsx` `bgBookIds` (invariant 7) — a `voices_pending` book (0 audio) should not be polled, whereas it slipped through as `generating` before.

## Test plan

### Automated coverage

- Vitest server (`server/src/workspace/scan.test.ts`) — `castConfirmed + 0 rendered + 0 failed → voices_pending`; `+1 rendered → generating`; `0 rendered + a failed chapter → generating`; `all rendered → complete`.
- Vitest unit (`src/store/ui-slice.test.ts`) — `openBook({status:'voices_pending'})` → `ready` stage on `cast` view.
- Vitest unit (`src/components/library/library-status-ui.test.ts`) — the `ALL_STATUSES` round-trip covers `voices_pending` (non-empty label + icon + valid colour).
- Vitest unit (`src/views/book-library.test.tsx`) — a `voices_pending` book counts under the `in_progress` filter.
- Playwright e2e (`e2e/cast-first-landing-and-voice-gate.spec.ts`) — opening the `voices_pending` mock book ("The Tidewatcher", `tw`) from the library lands on `#/books/tw/cast` and shows the "Cast ready" badge.

### Manual acceptance walkthrough

Run in mock mode (`VITE_USE_MOCKS=true`).

1. **Cold boot at `#/`** → library cards; "The Tidewatcher" card shows a **"Cast ready"** badge and no progress bar.
2. **Click "The Tidewatcher"** → URL `#/books/tw/cast`, stage `{ kind: 'ready', view: 'cast' }` — the Cast (voice design) view, NOT Generate.
3. **Against a real backend:** confirm a cast, do NOT start generating, return to the library → card reads "Cast ready", reopen → lands on Cast. Then generate one chapter → card reads "Generating", reopen → lands on Generate.

## Out of scope

- Making voice design mandatory — the fe-46 voice-readiness gate ("Proceed anyway → generic fallback") is unchanged; `voices_pending` is a routing/landing decision, not a hard gate.
- The transient first-chapter window (0 rendered / 0 failed while the first chapter is mid-render briefly reports `voices_pending`) is accepted, not closed — see the design doc's Detection section.

## Known limitations (accepted)

Both follow from deriving `generationStarted` from disk artifacts with no
positive in-progress signal. Accepted 2026-07-12 over adding a durable
`generationStartedAt` flag (simplicity-first; see the design doc's Detection
section):

1. **Transient first-chapter window (self-healing).** While the first chapter
   is mid-render (0 rendered, 0 failed), a cold library scan briefly reports
   `voices_pending`, so a reopen in that window lands on Cast rather than
   Generate and the card shows "Cast ready" instead of a progress bar. It
   heals on the next completed-or-failed chapter.
2. **Hard-crash-before-any-artifact (does NOT self-heal).** If the process is
   killed at the OS level (OOM-kill, power loss, `kill`) during the first
   chapter — before any audio lands **and** before the durable
   `generationState: 'failed'` marker is written by the generation route's
   `catch` — the book stays `voices_pending` indefinitely: "Cast ready" badge,
   reopens to Cast. It is still recoverable (start generation again from the
   Cast view), but the badge/routing do not reflect the interrupted attempt.
   Only OS-level kills escape the failure marker (every handled failure writes
   it → `generating`), so the case is rare. Closing it would require the
   durable-flag approach; revisit if it proves to bite in practice.

## Ship notes

(Filled in when status flips to `stable`.)
