---
status: active
shipped: null
owner: null
---

# "Not queued" held chapter state (Bug 1)

> Status: active (landing on `fix/server-frontend-chapter-held-state`)
> Key files: `server/src/workspace/scan.ts`, `server/src/routes/book-state.ts`, `src/store/chapters-slice.ts`, `src/store/queue-thunks.ts`, `src/store/generation-stream-middleware.ts`, `src/views/generation.tsx`, `src/lib/api.ts`
> URL surface: `#/books/<id>/generate` (+ the global queue modal)
> OpenAPI ops: `POST /api/books/{bookId}/chapters/{chapterId}/held`

## Benefit / Rationale

- **User:** Deleting a chapter from the generation queue now sticks. The row flips
  to a neutral **"Not queued"** instead of stubbornly reading "Queued", and the
  "Resume generation" auto-work no longer silently re-adds the chapter you just
  removed. Re-queue it any time with the row's "Generate this chapter".
- **Technical:** Records the user's *intent* ("don't generate this") as a durable,
  per-chapter `held` flag, separate from the transient work queue. Closes the gap
  where `chapter.state` (durable render status) and `.queue.json` (work tickets)
  disagreed.
- **Architectural:** `held` rides alongside the 4-value `state` enum rather than
  becoming a 5th value, so the many `stateConfig[chapter.state]` consumers can't
  crash on an unmapped state. The "is this queued work" truth is now `state ===
  'queued' && !held` at every read site.

## Architectural impact

- **New seam:** per-chapter `held?: boolean` in `BookStateJson.chapters[]` (server
  `scan.ts` + frontend mirror `src/lib/types.ts`), an additive openapi `Chapter.held`
  field, a `POST .../chapters/:id/held` route (clones the exclude handler **minus**
  audio cleanup), and `api.setChapterHeld` (real + mock).
- **Source of truth:** server `state.json`. Optimistically mirrored in the chapters
  slice (`setChapterHeld` reducer) and re-hydrated on `hydrateFromBookState`. The
  mock (`mockSetChapterHeld`) persists into `MOCK_BOOK_STATES` so a mock-mode
  re-hydrate doesn't clobber the optimistic flag.
- **Migration:** none — absent `held` reads as not-held (legacy state.json loads
  cleanly). Re-analysis (full + subset, `analysis.ts`) carries `held` forward by id
  alongside `excluded` (it is NOT re-derivable from disk, unlike audio metadata).
  Reparse intentionally drops it (chapter ids change; matches `wipeBookShapeEvents`).
- **Reversibility:** delete the flag + the `&& !held` guards; behaviour reverts to
  the (buggy) sticky-Queued state.

## Invariants to preserve

- **Held is gated everywhere queued work is counted.** All of these read
  `state === 'queued' && !held`:
  - `generation.tsx` queued count (drives Resume + completion copy),
  - `generation-stream-middleware.ts` `enqueueOnWork` (auto-work skip),
  - `queue-slice.ts` `selectActiveGenerationView` rows.
- **Held never set on a `done` (or in_progress) chapter.** The queue-delete wiring in
  `cancelQueueEntry` only holds a `scope:'this'` entry of the **loaded book** whose
  chapter is `state === 'queued'` — so a regenerate ticket on a done chapter (audio
  stays) is never mislabeled.
- **Held keeps the book "incomplete."** Held rows stay in `activeChapters` (not
  `done`), so `allComplete` is naturally false while any chapter is held.

## Test plan

### Automated coverage

- Vitest (`src/store/chapters-slice.test.ts`) — `held` hydrates through
  `hydrateFromBookState`; `setChapterHeld(true)` resets transient state;
  `setChapterHeld(false)` clears it.
- Vitest (`src/store/queue-thunks.test.ts`) — `cancelQueueEntry` holds a queued
  this-scope chapter (+ persists via `api.setChapterHeld`); does NOT hold a done /
  character-scope / cross-book entry.
- Vitest (`src/store/generation-stream-middleware.test.ts`) — `enqueueOnWork` skips
  held chapters on `requestStartGeneration`.
- Vitest (`src/views/generation.test.tsx`) — held row renders "Not queued" (not a
  "Queued" badge); Resume hidden when the only remaining work is held.
- Vitest server (`server/src/routes/book-state.test.ts`) — held endpoint sets/clears,
  does NOT delete audio, `GET /state` round-trips `held`, 400/404 paths.
- Playwright (`e2e/queue-delete-not-queued.spec.ts`) — seed a paused queue entry →
  cancel in the modal → row reads "Not queued", `held=true` in the store → "Generate
  this chapter" clears the hold.

**Coverage gap (documented):** the re-analysis `held`-preservation is a 1-line mirror
of the proven `excluded` preservation; it is exercised by the manual walkthrough below
rather than a heavy full-route integration test.

### Manual acceptance walkthrough

1. Approve a manuscript → **Generate** view; every un-rendered chapter reads "Queued".
2. "Approve cast & start generating" → entries enqueue and drain.
3. Open the queue modal, **delete** a still-queued chapter → its row now reads
   **"Not queued"**; the "Queued" summary stat drops by one.
4. The "Resume generation" button does **not** re-add it; let the run finish — the
   book stays "not fully complete" (no all-complete header) while it's held.
5. Reload → the held chapter still reads "Not queued" (persisted).
6. Expand the held row → **Generate this chapter** → it re-queues and renders.
7. Re-analyse the book → the held chapter is still held afterwards.

## Out of scope

- Per-row "remove from run" on the Generation screen (the queue modal delete is the
  entry point for v1). Force-removing an in-flight entry does not set held.

## Ship notes

(Filled when merged to main.) Lands on `fix/server-frontend-chapter-held-state`.
Behaviour matches the spec; the one descope is the documented re-analysis-preservation
test gap (mirror of the `excluded` path). Live-GPU acceptance not required (frontend +
state.json only).
