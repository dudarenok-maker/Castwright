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
 *   3. PROFILE-REGEN PREVIEW GATE — when the single preview chapter completes
 *      (markRevisionPlayable for the chapter the user is previewing), build the
 *      now-playable A/B stub and auto-open the diff player. See plan
 *      docs/features/archive/114-profile-regen-preview.md.
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
import { uiActions, type UiState } from './ui-slice';
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
    const enqueueOnWork = (): void => {
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

      /* Profile-change preview gate — when the single preview chapter's render
         completes (markRevisionPlayable for the chapter the user is
         previewing), build the now-playable A/B stub and auto-open the diff
         player. Built fresh on completion so a mid-render revisions poll
         (applyPoll replaces `pending` wholesale) can't leave the gate without
         a revision to show. Normal chapter regens never set previewRegen, so
         this no-ops for them. See docs/features/archive/114-profile-regen-preview.md. */
      if (type === 'revisions/markRevisionPlayable') {
        const payload = (a as { payload?: { chapterId: number } }).payload;
        if (payload) {
          const after = store.getState() as StreamableRootState;
          const preview = after.ui.previewRegen;
          if (preview && preview.previewChapterId === payload.chapterId) {
            const character = after.cast.characters.find((c) => c.id === preview.characterId);
            const chapter = after.chapters.chapters.find((c) => c.id === payload.chapterId);
            if (character && chapter) {
              dispatch(
                revisionsActions.enqueuePending(
                  buildPendingRevisionStub({ chapter, character, playable: true }),
                ),
              );
            }
            dispatch(uiActions.setShowRevisionPlayer(true));
          }
        }
      }

      if (ENQUEUE_TRIGGER_TYPES.has(type)) enqueueOnWork();

      return result;
    };
  };
}
