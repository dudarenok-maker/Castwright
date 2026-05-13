/* Generation-stream middleware — owns the SSE handle so generation keeps
   running while the user navigates away from the Generate screen.

   The previous design opened the SSE in a useEffect inside GenerationView,
   which meant unmount (navigate to Cast / Manuscript / Voices) cancelled the
   stream — and because `mockStreamGeneration`'s state machine IS the stream
   (no separate worker), the user came back to a frozen-looking screen.

   This middleware reacts to slice transitions instead of view lifetime. It
   opens the SSE whenever:
     - a regenerate reducer set `pendingRegen` (regenEpoch bumped), OR
     - the slice has any chapter in `in_progress` / `queued` and we're not
       holding an open handle and we're not paused.

   It closes the SSE on Pause, on the idle tick that settles the queue, on
   book switch, and on store teardown.

   Side responsibility: emit `generation_started` / `chapter_complete` /
   `chapter_failed` change-log events from the same vantage point. Reducers
   can't dispatch and the view doesn't see all ticks once we strip its
   useEffect, so this is the only place that can.

   Skipped under VITE_USE_MOCKS=true? — NO. The mock SSE depends on a long-
   lived caller; the whole point of this middleware is to BE that caller. */

import type { Dispatch, Middleware } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import {
  buildGenerationStartedEvent,
  buildChapterCompleteEvent,
  buildChapterFailedEvent,
} from '../lib/change-log';
import { chaptersActions } from './chapters-slice';
import { changeLogActions } from './change-log-slice';
import type { ChaptersState } from './chapters-slice';
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

/* The set of action types that *might* require us to open or close the SSE.
   Other actions still pass through untouched — we only reconcile on these.

   `chapters/setChapters` and `chapters/hydrateFromAnalysis` are in here
   because the chapters slice now starts EMPTY (was: fixture seed, which made
   reconcile-on-openBook spuriously "see" work). Now the moment chapters
   actually appear — either via setChapters from analysis, hydrateFromAnalysis
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
  'ui/openBook',
  'ui/goHome',
  'ui/hydrateFromUrl',
  'ui/confirmCast',
]);

interface OpenHandle {
  cancel: () => void;
  bookId: string;
  modelKey: TtsModelKey;
}

export const generationStreamMiddleware: Middleware = (store) => {
  let handle: OpenHandle | null = null;

  const closeHandle = () => {
    if (!handle) return;
    handle.cancel();
    handle = null;
  };

  const dispatch = store.dispatch as Dispatch;

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
    handle = { cancel, bookId, modelKey };
    /* Drain the spec the instant the SSE owns it — same Pause→Resume rationale
       documented on the slice reducer: without this, an aborted SSE never
       delivers `idle` so `pendingRegen` would stick around forever and every
       Resume would re-force-regen the original target set. */
    if (spec) dispatch(chaptersActions.consumePendingRegen());
  };

  const reconcile = () => {
    const after = store.getState() as StreamableRootState;
    const bookId = bookIdFromState(after);
    const modelKey = after.ui.ttsModelKey;
    const { chapters, paused, pendingRegen } = after.chapters;

    /* No book in scope — nothing can be running. Close any straggler. */
    if (!bookId) { closeHandle(); return; }

    /* Pause means stop. */
    if (paused) { closeHandle(); return; }

    /* Book switched out from under us — drop the old stream. The slice's
       hydrateFromBookState will repopulate chapters from disk; if the new
       book has queued work, the next reconcile pass opens a fresh handle. */
    if (handle && handle.bookId !== bookId) closeHandle();

    /* Model switched mid-run — the live handle is using stale config. Drop
       and reopen so the user's TTS engine choice takes effect. */
    if (handle && handle.modelKey !== modelKey) closeHandle();

    /* Queue fully drained — close any open handle (mock + real both rely on
       a closed handle to settle resources, and the next reconcile won't
       reopen because shouldOpen will stay false). */
    const shouldOpen = pendingRegen != null || hasWork(chapters);
    if (!shouldOpen) { closeHandle(); return; }

    /* Open when there's work to do (or a pending regen spec to forward) and
       we don't already have a handle. */
    if (!handle) openHandle(bookId, modelKey, pendingRegen);
  };

  /* Regen actions need an explicit close *before* reconcile so the new spec
     gets a fresh stream — without this, the existing handle stays open and
     reconcile sees `handle != null` and skips the openHandle that would
     forward `chapterIds + force`. */
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

    if (REGEN_TYPES.has(type)) closeHandle();

    /* Emit per-tick log events using the post-reducer state — that's where
       the chapter has already flipped to done/failed. */
    if (type === 'chapters/applyGenerationTick') {
      const ev = (a as { payload?: GenerationTick }).payload;
      const after = store.getState() as StreamableRootState;
      if (ev && ev.type === 'chapter_complete' && ev.chapterId != null) {
        const ch = after.chapters.chapters.find(c => c.id === ev.chapterId);
        if (ch) dispatch(changeLogActions.appendLogEvent(buildChapterCompleteEvent({ chapter: ch })));
      } else if (ev && ev.type === 'chapter_failed' && ev.chapterId != null) {
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
