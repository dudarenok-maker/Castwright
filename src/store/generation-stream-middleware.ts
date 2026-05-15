/* Generation-stream middleware — owns the SSE handle so generation keeps
   running while the user navigates anywhere in the app, not just inside
   the generating book.

   v1 design opened the SSE in a useEffect inside GenerationView; unmount
   (navigate to Cast / Manuscript / Voices) cancelled the stream and the
   user came back to a frozen-looking screen.

   v2 (this file) moved the SSE into a Redux middleware that reacts to slice
   transitions instead of view lifetime, so generation survived intra-book
   navigation. But reconcile still closed the stream the moment
   `stage.bookId` went null (Books home, Upload, Voices, Account) or
   switched to a different book — so the user couldn't start a new import
   or open another book without "bumping" generation.

   v3 (current) decouples the stream from `stage.bookId` entirely. Once a
   handle opens for book X, it's pinned to book X and ignores every
   navigation that follows. The only ways to stop the run are:
     - chapters/setPaused(true), dispatched by the Generate-view Stop
       button or by the local-analyzer confirm prompt (see
       src/hooks/use-local-analyzer-guard.tsx) when a Qwen-backed import
       would compete with TTS for GPU.
     - the queue draining (final idle tick from the server).

   To keep the global header pill alive while the user is on a different
   book, the middleware publishes an out-of-band `chapters.activeStream`
   snapshot — done/total/inProgress/lastTickAt — that survives slice
   re-hydration. Reducers in chapters-slice ignore tick payloads when the
   slice has drifted to a different book (see the cross-book guard at the
   top of applyGenerationTick).

   Side responsibility: emit `generation_started` / `generation_run_complete` /
   `chapter_failed` change-log events from the same vantage point. The
   per-chapter `chapter_complete` ticks are accumulated on the handle and
   collapsed into a single rollup event on closeHandle — the activity feed
   used to drown in per-chapter audit rows on long runs.

   Skipped under VITE_USE_MOCKS=true? — NO. The mock SSE depends on a long-
   lived caller; the whole point of this middleware is to BE that caller. */

import type { Dispatch, Middleware } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import {
  buildGenerationStartedEvent,
  buildGenerationRunCompleteEvent,
  buildChapterFailedEvent,
} from '../lib/change-log';
import { chaptersActions } from './chapters-slice';
import { changeLogActions } from './change-log-slice';
import type { ActiveStreamSnapshot, ChaptersState } from './chapters-slice';
import type { UiState } from './ui-slice';
import type { Chapter, GenerationTick, TtsModelKey } from '../lib/types';

interface StreamableRootState {
  ui: UiState;
  chapters: ChaptersState;
}

function bookIdFromState(s: StreamableRootState): string | null {
  const stage = s.ui.stage as { bookId?: string };
  return stage.bookId ?? null;
}

function hasWork(chapters: Chapter[]): boolean {
  return chapters.some(c => c.state === 'in_progress' || c.state === 'queued');
}

function snapshotFromChapters(
  bookId: string,
  modelKey: TtsModelKey,
  state: ChaptersState,
): ActiveStreamSnapshot {
  /* Counters mirror the active-subset filter used in the Generate view
     (`activeChapters` in src/views/generation.tsx): excluded chapters
     never queue or synthesise, so they must not inflate `total` or
     stall the cross-book top-bar pill's done/total readout. */
  const active = state.chapters.filter(c => !c.excluded);
  return {
    bookId,
    modelKey,
    done: active.filter(c => c.state === 'done').length,
    total: active.length,
    inProgress: active.filter(c => c.state === 'in_progress').length,
    lastTickAt: state.lastTickAt,
    halted: state.lastError != null,
  };
}

/* The set of action types that *might* require us to open or close the SSE.
   Other actions still pass through untouched — we only reconcile on these.

   `chapters/setChapters` and `chapters/hydrateFromAnalysis` are in here
   because the chapters slice starts EMPTY; the moment chapters actually
   appear — either via setChapters from analysis, hydrateFromAnalysis
   landing, or hydrateFromBookState seeding from disk — is the moment work
   becomes scope-visible, so reconcile has to run then. */
const TRIGGER_TYPES = new Set<string>([
  'chapters/setChapters',
  'chapters/hydrateFromAnalysis',
  'chapters/regenerateChapter',
  'chapters/regenerateCharacter',
  'chapters/batchRegenerateCharacters',
  'chapters/setPaused',
  'chapters/applyGenerationTick',
  'chapters/hydrateFromBookState',
  'chapters/setCurrentBookId',
  'ui/openBook',
  'ui/goHome',
  'ui/hydrateFromUrl',
  'ui/confirmCast',
  /* changeView is the seam for "user just landed on Generate and there are
     queued chapters waiting." Without it, navigating Cast → Generate (or
     Manuscript → Generate post-confirmCast) doesn't trigger reconcile, so
     the SSE never opens and the page sits there with no auto-start. */
  'ui/changeView',
]);

interface OpenHandle {
  cancel: () => void;
  bookId: string;
  modelKey: TtsModelKey;
  /* Per-run rollup accumulator. Every chapter_complete tick pushes its
     chapterId here; on run end (closeHandle) we emit one
     generation_run_complete event with the full list. This is what keeps
     the activity feed from getting flooded — a 14-chapter run used to write
     14 chapter_complete entries; now it writes one rollup. */
  completedChapterIds: number[];
}

export const generationStreamMiddleware: Middleware = (store) => {
  let handle: OpenHandle | null = null;

  const dispatch = store.dispatch as Dispatch;

  const closeHandle = () => {
    if (!handle) return;
    /* Flush the per-run rollup before tearing down. Empty runs (pause before
       any chapter finished, queue drained immediately) write nothing — there
       was already a generation_started anchor for those. */
    if (handle.completedChapterIds.length > 0) {
      dispatch(changeLogActions.appendLogEvent(
        buildGenerationRunCompleteEvent({ chapterIds: handle.completedChapterIds }),
      ));
    }
    handle.cancel();
    handle = null;
    dispatch(chaptersActions.clearActiveStream());
  };

  const openHandle = (bookId: string, modelKey: TtsModelKey, spec: ChaptersState['pendingRegen']) => {
    /* Emit a system-level "generation started" event so the activity feed has
       a beat for the user's Regenerate click (or Resume). The chapterIds
       reflect either the regen spec or the broader queued/in-progress set
       the server will resume against. */
    const after = store.getState() as StreamableRootState;
    const ids = spec?.chapterIds && spec.chapterIds.length > 0
      ? spec.chapterIds
      : after.chapters.chapters
          .filter(c => c.state === 'in_progress' || c.state === 'queued')
          .map(c => c.id);
    dispatch(changeLogActions.appendLogEvent(buildGenerationStartedEvent({ chapterIds: ids })));

    /* Seed the cross-book snapshot from the slice's current rows — at open
       time the slice IS the generating book's data. Subsequent ticks will
       refresh it; once the user navigates into a different book the slice
       drifts but the snapshot freezes at whatever it was just before, so
       the pill keeps showing the last-known progress. */
    dispatch(chaptersActions.setActiveStream(
      snapshotFromChapters(bookId, modelKey, after.chapters),
    ));

    const cancel = api.streamGeneration({
      bookId,
      modelKey,
      chapterIds: spec?.chapterIds,
      force: spec?.force,
      /* The mock implementation reads live chapter state via this callback;
         the real fetch-based stream ignores it. Either way we close over the
         store, not over any view's props, so generation continues after the
         Generate view unmounts. */
      getChapters: () => (store.getState() as StreamableRootState).chapters.chapters,
      onTick: (ev: GenerationTick) => dispatch(chaptersActions.applyGenerationTick(ev)),
    });
    handle = { cancel, bookId, modelKey, completedChapterIds: [] };
    /* Drain the spec the instant the SSE owns it — same Pause→Resume rationale
       documented on the slice reducer: without this, an aborted SSE never
       delivers `idle` so `pendingRegen` would stick around forever and every
       Resume would re-force-regen the original target set. */
    if (spec) dispatch(chaptersActions.consumePendingRegen());
  };

  const reconcile = () => {
    const after = store.getState() as StreamableRootState;
    const stageBookId = bookIdFromState(after);
    const modelKey = after.ui.ttsModelKey;
    const { chapters, paused, pendingRegen, currentBookId } = after.chapters;

    /* Pause is the universal user-initiated stop. It is dispatched only
       from contexts that mean "stop the active stream": the Generate-view
       Stop button (current book is the streaming book), or the
       local-analyzer confirm prompt (handles cross-book pause). Either
       way: fire an explicit /pause to the server so the run stops
       server-side (closing the SSE alone is no longer enough — the server
       now treats SSE close as "unsubscribe this observer", which is what
       lets a browser reload survive without killing the run), then close
       our local handle. */
    if (handle && paused) {
      const pauseBookId = handle.bookId;
      void api.pauseGeneration({ bookId: pauseBookId });
      closeHandle();
      return;
    }

    /* Sticky semantics: once a handle is open for book X, it stays open
       across goHome, openBook(otherBook), changeView, setTtsModelKey, and
       every other transition. The only termination is pause (above) or
       queue drain (below, when shouldOpen = false). Notably:
         - We do NOT close on stageBookId == null. The user is allowed to
           navigate Books → Voices → Upload while the stream keeps running
           in the background.
         - We do NOT close on stageBookId != handle.bookId. The user is
           allowed to open another book; the slice gets repopulated but the
           handle keeps streaming for the original book, and the
           applyGenerationTick reducer's cross-book guard prevents the
           drift from clobbering the other book's rows.
         - We do NOT close on modelKey change. Switching the TTS model in
           Account settings or anywhere else takes effect on the NEXT
           generation start, not the live one. */

    /* Open-side reconcile only fires when the slice's currently-loaded
       book is the same as `stage.bookId`. If the user is on Books home or
       another book entirely, we never auto-open a stream for the absent
       book; opens happen when the user actually returns to the generating
       book's Generate view and the SSE finds work waiting. */
    if (handle) {
      /* Already streaming — nothing to do on the open side. The only
         remaining close trigger is the queue-drain check the slice runs
         itself on the final idle tick, which will leave hasWork(chapters)
         false on the next reconcile pass. */
      if (currentBookId === handle.bookId) {
        const shouldOpen = pendingRegen != null || hasWork(chapters);
        if (!shouldOpen) closeHandle();
      }
      return;
    }

    /* No handle. Open only when the slice and the URL agree on which book
       we're on, there's work in scope, and the user hasn't paused. */
    if (!stageBookId) return;
    if (currentBookId !== stageBookId) return;
    if (paused) return;
    const shouldOpen = pendingRegen != null || hasWork(chapters);
    if (!shouldOpen) return;
    openHandle(stageBookId, modelKey, pendingRegen);
  };

  /* Regen actions need an explicit close *before* reconcile so the new spec
     gets a fresh stream — without this, the existing handle stays open and
     reconcile sees `handle != null` and skips the openHandle that would
     forward `chapterIds + force`. Only relevant when the user is acting on
     the same book the handle is streaming for — regen from a different
     book context would be a no-op for the existing stream anyway. */
  const REGEN_TYPES = new Set<string>([
    'chapters/regenerateChapter',
    'chapters/regenerateCharacter',
    'chapters/batchRegenerateCharacters',
  ]);

  return (next) => (action) => {
    const result = next(action);
    const a = action as { type?: string };
    const type = a?.type;
    if (!type || !TRIGGER_TYPES.has(type)) return result;

    if (REGEN_TYPES.has(type) && handle) {
      const after = store.getState() as StreamableRootState;
      if (after.chapters.currentBookId === handle.bookId) closeHandle();
    }

    /* Emit per-tick log events using the post-reducer state — that's where
       the chapter has already flipped to done/failed. Also refresh the
       cross-book snapshot so the global header pill keeps moving even
       when the user is on a different book and the per-chapter reducer
       skipped its mutation. */
    if (type === 'chapters/applyGenerationTick' && handle) {
      const ev = (a as { payload?: GenerationTick }).payload;
      const after = store.getState() as StreamableRootState;
      const sliceMatchesHandle = after.chapters.currentBookId === handle.bookId;
      if (sliceMatchesHandle) {
        dispatch(chaptersActions.setActiveStream(
          snapshotFromChapters(handle.bookId, handle.modelKey, after.chapters),
        ));
      }
      if (ev && ev.type === 'chapter_complete' && ev.chapterId != null && sliceMatchesHandle) {
        /* Accumulate — do NOT dispatch a per-chapter event. The rollup goes
           out once on closeHandle (run drain / pause). De-dupe so a retry
           tick or re-emitted SSE message doesn't double-count. */
        if (!handle.completedChapterIds.includes(ev.chapterId)) {
          handle.completedChapterIds.push(ev.chapterId);
        }
      } else if (ev && ev.type === 'chapter_failed' && ev.chapterId != null && sliceMatchesHandle) {
        const ch = after.chapters.chapters.find(c => c.id === ev.chapterId);
        if (ch) {
          dispatch(changeLogActions.appendLogEvent(buildChapterFailedEvent({
            chapter: ch,
            errorReason: ev.errorReason ?? ch.errorReason ?? 'Synthesis failed.',
          })));
        }
      }
    }

    reconcile();
    return result;
  };
};
