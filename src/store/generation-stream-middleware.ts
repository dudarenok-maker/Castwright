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
 *      for the viewed book (analysis lands, a book is reopened mid-run, the
 *      user navigates to Generate) and it isn't already in the queue, silently
 *      enqueue it so the dispatcher drains it. Gated by the queue-pause flag
 *      and the reverse-local-analyzer guard (don't auto-start generation that
 *      would fight a live local analysis for the GPU).
 *   2. HALT — `chapters/requestStreamHalt` (local-analyzer confirm prompt)
 *      pauses each open book on the server and tears every stream down NOW.
 *   3. PENDING-REVISION STUBS — on a character regen, enqueue the stub the
 *      diff player will flip to playable on chapter_complete.
 *
 * Skipped under VITE_USE_MOCKS=true? — NO. The mock SSE depends on a long-lived
 * caller; the runner (opened by the dispatcher) is that caller. */

import type { Middleware } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { revisionsActions } from './revisions-slice';
import { buildPendingRevisionStub } from '../lib/build-pending-revision';
import { enqueueQueueEntries, type EnqueueInput } from './queue-thunks';
import type { AppDispatch } from './index';
import type { StreamRunner } from './generation-stream-runner';
import type { ChaptersState } from './chapters-slice';
import type { CastState } from './cast-slice';
import type { UiState } from './ui-slice';
import type { AnalysisState } from './analysis-slice';
import type { QueueState } from './queue-slice';

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
}

function bookIdFromState(s: StreamableRootState): string | null {
  const stage = s.ui.stage as { bookId?: string };
  return stage.bookId ?? null;
}

/* Triggers that mean "work may have appeared for the viewed book" — analysis
   landed, the slice was seeded from disk / analysis, the user confirmed cast or
   navigated onto the Generate view. NOT the regen actions (those enqueue
   explicitly via their callsites) and NOT applyGenerationTick (the runner
   self-drives ticks). */
const ENQUEUE_TRIGGER_TYPES = new Set<string>([
  'chapters/setChapters',
  'chapters/hydrateFromAnalysis',
  'chapters/hydrateFromBookState',
  'chapters/setCurrentBookId',
  'queue/setSnapshot',
  'ui/openBook',
  'ui/hydrateFromUrl',
  'ui/confirmCast',
  'ui/changeView',
]);

export function generationStreamMiddleware(getRunner: () => StreamRunner): Middleware {
  return (store) => {
    const dispatch = store.dispatch as AppDispatch;

    /* The override replacement: when the viewed book has non-excluded
       queued/in_progress rows that aren't already represented in the queue,
       silently enqueue them so the dispatcher drains them. Deterministic ids
       (`autowork-<bookId>-<chapterId>`) + the not-already-queued pre-check keep
       it idempotent across repeated triggers. */
    const enqueueOnWork = (): void => {
      const after = store.getState() as StreamableRootState;
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
            (c.state === 'in_progress' || c.state === 'queued') &&
            !queuedChapterIds.has(c.id),
        )
        .map((c) => ({
          id: `autowork-${stageBookId}-${c.id}`,
          bookId: stageBookId,
          chapterId: c.id,
          scope: 'this' as const,
        }));
      if (fresh.length === 0) return;
      void dispatch(enqueueQueueEntries(fresh, { silent: true })).catch(() => {
        /* Dup-id (409) / transient — the next trigger reconciles. */
      });
    };

    return (next) => (action) => {
      const result = next(action);
      const a = action as { type?: string };
      const type = a?.type;
      if (!type) return result;

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

      /* Pending-revision stubs on a character regen. One per (characterId,
         chapterId); the stub is playable=false and chapter_complete (handled
         in the runner) flips it. */
      if (type === 'chapters/regenerateCharacter') {
        const payload = (a as { payload?: { characterId: string; chapterIds: number[] } }).payload;
        if (payload) {
          const after = store.getState() as StreamableRootState;
          const character = after.cast.characters.find((c) => c.id === payload.characterId);
          if (character) {
            for (const chapterId of payload.chapterIds) {
              const chapter = after.chapters.chapters.find((c) => c.id === chapterId);
              if (!chapter) continue;
              dispatch(
                revisionsActions.enqueuePending(buildPendingRevisionStub({ chapter, character })),
              );
            }
          }
        }
      } else if (type === 'chapters/batchRegenerateCharacters') {
        const payload = (a as { payload?: { characterIds: string[]; chapterIds: number[] } })
          .payload;
        if (payload) {
          const after = store.getState() as StreamableRootState;
          for (const characterId of payload.characterIds) {
            const character = after.cast.characters.find((c) => c.id === characterId);
            if (!character) continue;
            for (const chapterId of payload.chapterIds) {
              const chapter = after.chapters.chapters.find((c) => c.id === chapterId);
              if (!chapter) continue;
              dispatch(
                revisionsActions.enqueuePending(buildPendingRevisionStub({ chapter, character })),
              );
            }
          }
        }
      }

      if (ENQUEUE_TRIGGER_TYPES.has(type)) enqueueOnWork();

      return result;
    };
  };
}
