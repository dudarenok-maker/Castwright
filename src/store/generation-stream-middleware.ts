/* Generation-stream middleware (plan 111 worker pool).
 *
 * Through plan 102 this middleware was the OPEN-SIDE decision-maker: a
 * `reconcile` step opened the SSE whenever `hasWork(chapters)` was true (the
 * "generating override"). Plan 111 makes the persisted workspace queue the
 * single source of truth — the queue dispatcher (`queue-dispatcher-middleware`)
 * is now the SOLE stream-opener, and the shared `StreamRunner` self-drives its
 * per-stream side-effects (snapshot refresh, rollup, completion events, idle
 * teardown) via each stream's own `onTick`. So the override is gone.
 *
 * What remains here:
 *   1. ENQUEUE-ON-WORK — the replacement for the override. When work appears
 *      for the viewed book WHILE IT IS ON THE GENERATE VIEW (the user clicked
 *      "Approve cast & start generating", or reopened a book that was already
 *      generating) and it isn't already in the queue, silently enqueue it so
 *      the dispatcher drains it. Gated by the Generate-view check (so a
 *      freshly-analysed book sitting at confirm/manuscript review does NOT
 *      auto-start), the queue-pause flag, and the reverse-local-analyzer guard
 *      (don't auto-start generation that would fight a live local analysis for
 *      the GPU).
 *   2. HALT — `chapters/requestStreamHalt` (local-analyzer confirm prompt)
 *      pauses each open book on the server and tears every stream down NOW.
 *   3. GENERATION PREVIEW — plan 286 (OD27/OD28/OD29, Task 24). On
 *      `chapters/previewChapterComplete` (dispatched by the runner for ANY
 *      book when a chapter was actually rendered with review), open the
 *      preview's recorded server entry (refetching once, with one retry) or
 *      a client-only stub, mark every completion finished so a closed or
 *      never-opened preview stays re-openable, and re-run the open path on
 *      arrival at the preview's book. See plan
 *      docs/features/286-revisions-client-cutover.md Task 24.
 *
 * Skipped under VITE_USE_MOCKS=true? — NO. The mock SSE depends on a long-lived
 * caller; the runner (opened by the dispatcher) is that caller. */

import type { Middleware } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { buildPreviewStub } from '../lib/build-preview-stub';
import { enqueueQueueEntries, type EnqueueInput } from './queue-thunks';
import type { AppDispatch } from './index';
import type { StreamRunner } from './generation-stream-runner';
import { previewChapterComplete, type ChaptersState } from './chapters-slice';
import type { CastState } from './cast-slice';
import { uiActions, type UiState, type PreviewRegenCtx } from './ui-slice';
import type { AnalysisState } from './analysis-slice';
import type { QueueState } from './queue-slice';
import { activeBookId, refetchActiveRevisions } from './revisions-thunks';
import { selectActivePending, type RevisionsState } from './revisions-slice';
import { notificationsActions } from './notifications-slice';

interface StreamableRootState {
  ui: UiState;
  chapters: ChaptersState;
  cast: CastState;
  /* The enqueue-on-work gate honours the same engine === 'local' rule the
     reverse-local-analyzer guard enforces: don't auto-start a generation that
     would compete with a live local analysis for the GPU. */
  analysis: AnalysisState;
  /* queue.paused = true means the user (or the local-analyzer halt) stopped
     the drain, so we must not auto-enqueue more work. */
  queue: QueueState;
  /* Plan 286 — the active-book cache the preview's refetch (and the OD30
     entry-lookup) reads. */
  revisions: RevisionsState;
  /* Plan 286 — book titles for the "Preview ready in ‹title›" toast. */
  library: { books: Array<{ bookId: string; title: string }> };
}

const PREVIEW_REFETCH_RETRY_MS = 1000; // OD23

/* Plan 286 (Task 24) — the only path that opens a preview; every early
   return leaves `completed` set, so the preview stays re-openable (OD28). */
async function openPreview(
  dispatch: AppDispatch,
  getState: () => StreamableRootState,
  p: { bookId: string; chapterId: number; completed: PreviewRegenCtx['completed'] },
): Promise<void> {
  const reviewOutcome = p.completed?.reviewOutcome;
  const stubFallback = p.completed?.stubFallback ?? false;
  const isThisPreview = (s: StreamableRootState) =>
    s.ui.previewRegen?.bookId === p.bookId && s.ui.previewRegen?.previewChapterId === p.chapterId;
  /* OD29 (Task 7) — 'none' (a first render: nothing to review) and 'failed'
     (preserved, but no entry recorded) have no server entry to look for: the
     stub is the legitimate player, so no refetch. Only 'recorded' (or an
     absent outcome) looks for the entry. */
  if (reviewOutcome !== 'none' && reviewOutcome !== 'failed') {
    let r = await dispatch(refetchActiveRevisions(p.bookId));
    if (r === 'failed') {
      await new Promise((res) => setTimeout(res, PREVIEW_REFETCH_RETRY_MS));
      r = await dispatch(refetchActiveRevisions(p.bookId));
    }
    /* OD28 — the user left the book during the refetch ('skipped', or 'ok'
       with the response not applied): leave the preview as it is; the next
       arrival re-opens it. Without this check an unapplied 'ok' would read
       the NEW book's empty cache below and drop the preview (OD29) wrongly. */
    if (r === 'skipped' || activeBookId(getState()) !== p.bookId) return;
    if (r === 'ok') {
      /* OD30 — matched by chapter alone, deliberately: any entry for the
         preview's chapter is the preview's player. */
      const entry = selectActivePending(getState()).find((e) => e.chapterId === p.chapterId);
      if (entry) {
        /* A1 (pass 4) — the refetch awaited: never replace a player the user
           opened meanwhile. `completed` stays set; the next arrival re-opens
           it. (The active book was re-checked just above.) */
        if (getState().ui.openRevision !== null) return;
        dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: entry.id, chapterId: entry.chapterId }));
        return;
      }
      if (isThisPreview(getState())) {
        /* OD29 — the server recorded an entry and no longer has it: resolved
           elsewhere (another tab, or a newer render dropped it). Never a stub:
           its Reject (restore-unrecorded) could put the preview take back over
           that newer render (finalize-chapter-write.ts ~:798). */
        dispatch(uiActions.setPreviewRegen(null));
        dispatch(notificationsActions.pushToast({ kind: 'info', message: 'This preview was resolved elsewhere', dedupeKey: 'preview-resolved-elsewhere' }));
      }
      return;
    }
    /* r === 'failed' twice (OD23). */
    if (!stubFallback) {
      console.warn('[preview] could not confirm the recorded take; it re-opens on the next visit to the book');
      return;
    }
  }
  const before = getState();
  /* A8 — only this book's chapter rows (the fire gate already waited for
     them; this guards the window after the refetch's await). */
  const chapter = before.chapters.currentBookId === p.bookId ? before.chapters.chapters.find((c) => c.id === p.chapterId) : undefined;
  const prev = chapter ? await api.getChapterAudioPrevious({ bookId: p.bookId, chapterId: p.chapterId, duration: chapter.duration }).catch(() => null) : null;
  const s = getState();
  const preview = s.ui.previewRegen;
  if (!preview || !isThisPreview(s)) return; // resolved or replaced meanwhile: nothing left to open
  /* A1 (pass 4) — the awaits above (refetch, retry, previous-audio GET) let
     the user open a player or move to another book. Opening now would
     replace that player, or (on another book) open a stub the watcher
     instantly hides, closing the player the user has open there. Keep the
     OD28 marker (`completed` stays set) and do not open: the next arrival
     at the preview's book re-opens it. */
  if (s.ui.openRevision !== null || activeBookId(s) !== p.bookId) return;
  const character = s.cast.characters.find((c) => c.id === preview.characterId);
  if (!chapter || !character) {
    /* OD28 — never strand it: `completed` stays set, so the next arrival
       retries once the chapters and cast are in. */
    console.warn('[preview] could not build the preview stub (chapter or character not loaded); it re-opens on the next visit to the book');
    return;
  }
  /* OD30 (pass 4) — ONE action sets the stub and opens it. Never
     setPreviewRegen(stub) + setOpenRevision: between those two dispatches the
     player watcher (Task 21) would drop the stub (rule 1, a cached entry for
     the chapter, no player open yet) and then hide the stub player (rule 2),
     so nothing would open. In one action the watcher sees the stub player
     open, and when the active cache already holds an entry for this chapter,
     rule 1 switches the player to that entry: an existing entry wins, for
     every reviewOutcome, and the preview stays in preview mode so Approve
     runs its fan-out (Task 22). */
  dispatch(uiActions.openPreviewStub(buildPreviewStub({ chapter, character, hasPreviousAudio: prev !== null })));
}

function bookIdFromState(s: StreamableRootState): string | null {
  const stage = s.ui.stage as { bookId?: string };
  return stage.bookId ?? null;
}

/* The SINGLE action that may auto-enqueue a book's queued chapters: the explicit
   "Approve cast & start generating" intent (`ui/requestStartGeneration`).
   Deliberately NOT openBook / hydrateFromUrl / hydrateFromBookState / changeView /
   confirmCast / setSnapshot — those all fire on a passive open or re-open, which
   used to re-add every freshly-seeded 'queued' chapter and silently restart
   generation ("opening a book auto-starts generation", plan 137). Generation
   start is now an explicit user action, never a side effect of navigation. NOT
   the regen actions either (those enqueue explicitly via their own callsites) and
   NOT applyGenerationTick (the runner self-drives ticks). See
   docs/features/archive/137-reopen-never-auto-enqueues.md. */
const ENQUEUE_TRIGGER_TYPES = new Set<string>(['ui/requestStartGeneration']);

export function generationStreamMiddleware(getRunner: () => StreamRunner): Middleware {
  return (store) => {
    const dispatch = store.dispatch as AppDispatch;

    /* The override replacement: when the viewed book has non-excluded
       queued/in_progress rows that aren't already represented in the queue,
       silently enqueue them so the dispatcher drains them. Deterministic ids
       (`autowork-<bookId>-<chapterId>`) + the not-already-queued pre-check keep
       it idempotent across repeated triggers. */
    const enqueueOnWork = (fallbackConfirmed: boolean): void => {
      const after = store.getState() as StreamableRootState;
      /* Defence-in-depth Generate-view gate: only the viewed book on the Generate
         view may enqueue. The `ui/requestStartGeneration` trigger already encodes
         explicit user intent (the only entry in ENQUEUE_TRIGGER_TYPES), so this
         guard is belt-and-braces — it keeps a stray dispatch from ever enqueuing
         off the Generate view. */
      const stage = after.ui.stage;
      if (stage.kind !== 'ready' || stage.view !== 'generate') return;
      const stageBookId = bookIdFromState(after);
      const { chapters, currentBookId } = after.chapters;
      if (!stageBookId || currentBookId !== stageBookId) return;
      if (after.queue?.paused) return;

      /* Reverse-local-analyzer guard: a live local analysis on this book needs
         the GPU; don't auto-start generation against it. */
      const analysisSnap = after.analysis?.activeStream ?? null;
      if (
        analysisSnap != null &&
        analysisSnap.engine === 'local' &&
        analysisSnap.bookId === stageBookId &&
        analysisSnap.state !== 'paused' &&
        analysisSnap.state !== 'halted'
      ) {
        return;
      }

      const queuedChapterIds = new Set(
        after.queue.entries
          .filter((e) => e.bookId === stageBookId && e.scope !== 'character')
          .map((e) => e.chapterId),
      );
      const fresh: EnqueueInput[] = chapters
        .filter(
          (c) =>
            !c.excluded &&
            /* "Not queued" hold — the user removed this chapter from the queue;
               the auto-work resume must not silently re-enqueue it. */
            !c.held &&
            (c.state === 'in_progress' || c.state === 'queued') &&
            !queuedChapterIds.has(c.id),
        )
        .map((c) => ({
          id: `autowork-${stageBookId}-${c.id}`,
          bookId: stageBookId,
          chapterId: c.id,
          scope: 'this' as const,
          ...(fallbackConfirmed ? { fallbackConfirmed: true } : {}),
        }));
      if (fresh.length === 0) return;
      void dispatch(enqueueQueueEntries(fresh, { silent: true })).catch(() => {
        /* Dup-id (409) / transient — the next trigger reconciles. */
      });
    };

    /* OD27/OD28 — closure state, one per store. The chapter id the fire
       check will act on once everything holds (armed on arrival at the
       preview's book, or on a completion seen while already there). */
    let armedFor: string | null = null;

    return (next) => (action) => {
      const activeBefore = activeBookId(store.getState() as StreamableRootState);
      const result = next(action);
      const a = action as { type?: string };
      const type = a?.type;

      const runner = getRunner();

      /* Hard "halt now" — the local-analyzer guard fires this when a local
         analysis needs the GPU the in-flight TTS runs are holding. Pause each
         open book on the server and tear every stream down. The accompanying
         setQueuePaused keeps the dispatcher from re-opening. */
      if (type === 'chapters/requestStreamHalt') {
        for (const bookId of runner.openBookIds()) {
          void api.pauseGeneration({ bookId });
        }
        runner.closeAll();
        return result;
      }

      /* Plan 286 (Task 24) — a chapter actually rendered with review
         completed, for ANY book. `mine` is "this is the preview's own
         chapter"; `onBook` is "the user is currently on that book". */
      if (previewChapterComplete.match(action)) {
        const { bookId, chapterId, reviewOutcome } = action.payload;
        const afterTick = store.getState() as StreamableRootState;
        const onBook = activeBookId(afterTick) === bookId;
        const preview = afterTick.ui.previewRegen;
        const mine = !!preview && preview.bookId === bookId && preview.previewChapterId === chapterId;
        /* Arm BEFORE the OD28 dispatch below: that dispatch re-enters this
           middleware, and the re-entry's own fire check (below) can open the
           preview in the same pass once chapters/openRevision allow it.
           Arming first means exactly one fire (see mutation 15). */
        if (onBook && mine) armedFor = bookId;
        if (mine) {
          /* OD28 — mark EVERY completion of this preview finished, on its
             book or elsewhere. `stubFallback` matters only for a 'recorded'
             completion whose refetch fails twice: true only when seen on its
             own book (OD23). */
          dispatch(uiActions.setPreviewRegen({ ...preview!, completed: { reviewOutcome, stubFallback: onBook } }));
        }
        if (!onBook) {
          const title = afterTick.library.books.find((b) => b.bookId === bookId)?.title ?? bookId;
          dispatch(notificationsActions.pushToast({ kind: 'info', message: `Preview ready in ${title}`, dedupeKey: `preview-ready-${bookId}` }));
        }
        /* `onBook && !mine` (e.g. after a reload, which drops previewRegen) —
           nothing to do: a recorded take reaches the Status popover with the
           next poll (OD12). */
      }

      if (type && ENQUEUE_TRIGGER_TYPES.has(type)) {
        const payload = (a as { payload?: { fallbackConfirmed?: boolean } }).payload;
        enqueueOnWork(!!payload?.fallbackConfirmed);
      }

      /* The fire check: re-open on arrival (OD27) and the deferred active
         open (OD28, A8). Runs after every action, not just
         previewChapterComplete — the arrival itself is what arms it. */
      const after = store.getState() as StreamableRootState;
      const activeAfter = activeBookId(after);
      const pv = after.ui.previewRegen;
      if (activeBefore !== activeAfter) armedFor = pv && pv.bookId === activeAfter ? activeAfter : null;
      if (
        armedFor !== null &&
        armedFor === activeAfter &&
        pv?.bookId === armedFor &&
        pv.completed !== undefined && // finished (OD27/OD28) — the ONLY completed test
        after.ui.openRevision === null && // never over a player the user has open
        after.chapters.currentBookId === armedFor // this book's chapter rows (A8)
      ) {
        armedFor = null; // once per arm; openPreview's own dispatches re-enter with it cleared
        void openPreview(dispatch, () => store.getState() as StreamableRootState, {
          bookId: pv.bookId,
          chapterId: pv.previewChapterId,
          completed: pv.completed,
        });
      }

      return result;
    };
  };
}
