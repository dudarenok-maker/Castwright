---
status: stable
shipped: 2026-05-15
owner: null
---

# 31 — Sticky generation across navigation

**Status:** stable

> **Update — plan 102 Should #5 (2026-05-23).** This plan's prose still
> describes the pre-queue stop contract built on `chapters.paused`. That field
> was removed: the SSE handle + lifecycle now live in a shared
> `generation-stream-runner` (plan 102 Should #6) and the open-side gate reads
> `queue.paused` instead of `chapters.paused`. The two stop signals split: the
> user-facing Pause lives in the queue modal (`queue.paused`, stops the drain
> at the next chapter boundary — in-flight finishes), while the local-analyzer
> guard's "halt NOW to free the GPU" path is a `haltActiveGeneration` thunk
> (dispatches `chapters/requestStreamHalt`, which the middleware observes to
> POST `/pause` + close the open handle immediately, plus `setQueuePaused(true)`).
> The reverse-local-analyzer guard is now a pure reconcile gate (it refuses to
> open rather than flipping a flag). Read the sections below with that
> substitution in mind.

Audio generation, once started, runs to completion (or to the user's
explicit Stop) regardless of where the user navigates. The previous
contract — see plan 16 for the pre-v3 history — closed the SSE handle
whenever the URL's `bookId` went null or switched to a different book,
so opening Books / Voices / Account / Upload visibly "bumped" the run.
The v3 contract pins the handle to the originally-generating book and
ignores every navigation that follows.

This plan also covers the **local-analyzer guard**: when a generation
stream is alive AND the user picks a local Ollama model for a new
import or re-analysis, a confirm prompt offers a clean
"pause-and-analyse?" choice (because XTTS and Ollama compete for the
same GPU). Gemini/Gemma engines pass through unguarded — they're
remote APIs and don't touch local VRAM.

## Invariants

1. **The SSE handle survives every navigation except an explicit Stop
   or queue drain.** `src/store/generation-stream-middleware.ts`'s
   `reconcile()` only closes the handle when:
   - `chapters.paused === true` (the universal "stop" signal — dispatched
     by the Generate-view Stop button and by the local-analyzer guard's
     Confirm), OR
   - the slice's `currentBookId` matches the handle's book AND the
     chapter queue has fully drained (`hasWork(chapters)` is false and
     `pendingRegen` is null).

   The handle does NOT close on:
   - `stage.bookId` going null (goHome, startNewBook, openVoices, etc.)
   - `stage.bookId` switching to a different book (`openBook(b2)`)
   - `ui.ttsModelKey` switching — the new model only takes effect on
     the NEXT generation start.

1a. **Browser reload also survives.** The server-side run is owned by a
`RunningJob` keyed on `bookId` in
`server/src/routes/generation.ts`. Each POST to `/generation`
attaches a `Subscriber` (`{ send, res }`) to the job's broadcast
set; `req.on('close')` unsubscribes ONLY (does NOT abort the
controller). When the browser reloads, the old SSE closes →
subscriber unsubscribes → the job keeps running. The post-reload
page POSTs again with no `chapterIds` → the new request attaches as
a fresh subscriber to the same job and receives the catch-up
`chapter_complete` replay for everything already on disk, then
live ticks from there.

Pause is no longer a side-effect of SSE close — it has its own
endpoint: `POST /api/books/:bookId/generation/pause`. The
middleware fires this via `api.pauseGeneration` on
`setPaused(true)` BEFORE closing the local handle, so the server
gets an explicit "stop" signal that the loop's AbortError catch
surfaces as a final `idle` tick to every subscriber.

Regenerate stays as displacement: a POST with `chapterIds + force`
aborts the existing job before starting a fresh one with the new
spec.

The catch-up `chapter_complete` replay skips any chapter in the
current run's scope (force-regen targets whose audio still exists on
disk because the synthesis loop hasn't overwritten it yet). Emitting
a "complete" tick for an in-scope chapter would race the live run and
snap the row back to "Done" before the first live progress tick
lands — exactly the failure mode that made the regen look like a
no-op pre-fix. Pinned by `generation.test.ts > catch-up replay skips
in-scope chapters so a force-regen does not snap back to "Done"`.

2. **The `chapters.activeStream` snapshot is the source of truth for
   the global header pill.** It is set on `openHandle`, refreshed on
   every non-idle `applyGenerationTick`, and cleared on `closeHandle`.
   The pill in `src/components/layout.tsx` reads from this snapshot
   only — never from `chapters.chapters` directly — so it keeps
   rendering the _generating_ book's progress even after the user has
   navigated into a different book and the slice has been rehydrated
   with that other book's rows.

3. **Cross-book tick guard.** `chapters/applyGenerationTick`
   short-circuits when `activeStream.bookId !== currentBookId` — the
   in-flight stream's progress payload must not clobber the chapter
   rows of a _different_ book the user has just opened. The middleware
   keeps the snapshot moving out-of-band; the per-chapter UI is
   refreshed only when the slice and the stream agree on which book
   they're describing.

4. **Layout maintains `currentBookId`.** Every code path that replaces
   `chapters.chapters` wholesale (`hydrateFromBookState` in
   `src/components/layout.tsx`, `hydrateFromAnalysis` in
   `src/routes/index.tsx`) MUST follow up with
   `chaptersActions.setCurrentBookId(bookId)` so the cross-book guard
   above has a truthful frame of reference.

5. **`useLocalAnalyzerGuard` wraps every local-analyzer trigger.**
   Current callsites: `src/views/upload.tsx` (file drop, sample, paste
   submit) and `src/routes/index.tsx`'s ConfirmRoute `onReanalyse`. The
   hook reads `ui.selectedModel`, resolves its engine via
   `MODEL_OPTIONS` in `src/lib/models.ts`, and either calls `proceed()`
   directly (engine !== 'local' OR activeStream === null) or opens a
   `ConfirmDialog` that on Confirm dispatches `setPaused(true)` then
   calls `proceed()`.

6. **Confirm dispatches `setPaused(true)`, NOT a separate stop signal.**
   This funnels every user-initiated stop (Generate-view button + guard
   prompt) through a single reducer path, so the middleware has exactly
   one close trigger to reason about.

7. **The guard's "stay paused" decision** — generation stays paused
   after the guard fires; the user must explicitly hit Resume in the
   Generate view to restart. No auto-resume on analysis completion.

## Acceptance

Use the canonical end-to-end manuscript
`server/src/__fixtures__/the-coalfall-commission.md` so the run lasts long
enough to actually navigate during synthesis. `npm run dev` + the local
analyzer + the TTS sidecar must all be up.

1. **Sticky across navigation.**
   - Open or finish analyzing the canonical book; confirm cast; land on
     Generate; click Start. Confirm the per-second pill says
     `Generating · 0/N · 0%`.
   - Navigate **Cast → Manuscript → Voices → Account → Books**, in any
     order, while ticks land. The header pill must keep ticking and
     clicking it returns to `/books/<id>/generate`. The SSE network
     stream in the Network tab must not be re-opened.

2. **Sticky across `openBook` to a different book.**
   - With generation still running on book A, click any _other_ book
     in the library.
   - URL becomes `/books/<otherId>/<view>` and the per-book hydration
     fires for that book. The header pill must continue showing book
     A's progress (frozen at the last tick the middleware saw before
     the slice drifted) and clicking it must navigate back to
     `/books/<bookA>/generate`. The Network tab still shows the
     original stream alive.

2b. **Cross-book title doesn't smear.**

- Open book A and start (or land mid-) analysing. The Analysing
  view's H1 says `Analysing <A>`; the top-bar breadcrumb says `A`.
- With analysis still running on book A, click the header
  generation pill (which is anchored to book B's still-streaming
  run).
- URL becomes `/books/<bookB>/generate`. The Generate view's H1
  must say `Generating <B>` (NOT `Generating <A>`) and the top-bar
  breadcrumb must say `B`. Pre-fix the manuscript slice short-
  circuited Layout's per-book hydrate, so book A's title leaked
  into book B's screen until the user manually re-opened B from
  the library.

2a. **Sticky across browser reload.**

- With generation running, hit F5 / Ctrl+R / browser reload.
- The previous SSE in the Network tab closes; the page re-mounts;
  a fresh POST `/generation` lands. On the server it attaches as a
  subscriber to the existing in-flight job (the run is keyed on
  bookId, not on the connection), receives the catch-up replay,
  and continues ticking live. The Generate view shows the
  completed chapter count tick up where it left off.
- Confirm via `server/logs/server.log` that the second POST does
  NOT trigger a fresh `synthesiseChapter` walk — just a subscribe
  - catch-up.

3. **Sticky across TTS model switch.**
   - Open Account; flip the TTS model picker to a different option.
   - The SSE stream is **not** torn down; the live run finishes on the
     original model. The new selection applies only to the next run
     you start.

4. **Local-analyzer guard — Qwen flow.**
   - With generation still running, click "Start new book" → Upload.
   - Confirm Analysis model is Qwen 3.5 4B (or any other local entry).
   - Drop the sample manuscript or click "Use sample manuscript".
   - The "Pause audio generation to analyse?" dialog appears.
   - Click **Wait** → no pause, the upload screen stays interactive,
     pill keeps ticking.
   - Drop the sample again. This time click **Pause and analyse**.
   - Pill disappears (snapshot cleared on stream close), audio
     generation pauses; the new import proceeds into confirm-metadata
     and then analysing.

5. **Local-analyzer guard — Gemini flow (no prompt).**
   - Restart generation on book A (open the book, hit Resume in
     Generate, confirm pill is alive again).
   - Open Upload; switch the Analysis model dropdown to a Gemini option.
   - Drop the sample manuscript. There must be **no** prompt; import
     proceeds straight to confirm-metadata and pill keeps ticking.

6. **Manual resume.**
   - After step 4's Pause-and-analyse, finish the new book's analysis,
     confirm its cast.
   - Open book A again. Generate view shows `Paused`. Click Resume —
     audio generation resumes from the chapter where it stopped, no
     duplicate work.

## Coverage

- `src/store/generation-stream-middleware.test.ts` — sticky reconcile,
  activeStream lifecycle, cross-book guard.
- `src/store/chapters-slice.test.ts` — `applyGenerationTick`
  cross-book early-return.
- `src/store/manuscript-slice.test.ts` — `bookId` anchoring (hydrate
  reducers stamp it, `reset` clears it). Pre-fix the slice carried
  title + manuscriptId across book switches with no way to detect
  staleness.
- `src/routes/index.test.tsx` — cross-book Generate H1 (regression
  for step 2b): rendering `/books/<B>/generate` with the manuscript
  slice still pinned to book A must surface B's title, not A's.
- `src/hooks/use-local-analyzer-guard.test.tsx` — engine routing
  (Gemini/local), modal open/close, Confirm dispatches setPaused.

## Related plans

- [16 — Generation stream](16-generation-stream.md) — the underlying SSE
  contract this plan amends. Plan 16 still describes the per-tick
  payload and chapter-state reducer paths; this plan only changes
  _when_ the handle is opened and closed.
- [04 — Analysing view & SSE progress](04-analysing-view-progress.md) —
  the local-analyzer trigger this guard wraps.
- [13 — TTS engine picker](13-tts-engine-picker.md) — model-switch
  no-longer-cancels-mid-run interaction lives here too.
