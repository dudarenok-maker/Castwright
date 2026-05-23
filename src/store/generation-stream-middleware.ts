/* Generation-stream middleware — drives the SSE handle so generation keeps
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

   v3 decoupled the stream from `stage.bookId` entirely. Once a handle opens
   for book X, it's pinned to book X and ignores every navigation that
   follows.

   v4 (current — plan 102 Should #6) moves the SSE handle + lifecycle into a
   shared `StreamRunner` (src/store/generation-stream-runner.ts) so the queue
   dispatcher can open a CROSS-BOOK stream through the same lifecycle. This
   middleware now owns only the OPEN-SIDE DECISION for same-book streams
   (reconcile + the reverse-local-analyzer guard) and the per-tick
   delegation to `runner.handleTick`. The ways a run stops are unchanged:
     - chapters/setPaused(true), from the local-analyzer confirm prompt (see
       src/hooks/use-local-analyzer-guard.tsx) when a local-engine import
       would compete with TTS for GPU.
     - the queue draining (final idle tick from the server → runner closes).

   To keep the global header pill alive while the user is on a different
   book, the runner publishes an out-of-band `chapters.activeStream`
   snapshot — done/total/inProgress/lastTickAt — that survives slice
   re-hydration. Reducers in chapters-slice ignore tick payloads when the
   slice has drifted to a different book (the cross-book guard at the top of
   applyGenerationTick).

   Side responsibility (still observed here, delegated to the runner): emit
   `generation_started` / `generation_run_complete` / `chapter_failed`
   change-log events; enqueue pending-revision stubs on character regens.

   Skipped under VITE_USE_MOCKS=true? — NO. The mock SSE depends on a long-
   lived caller; the whole point of this middleware is to BE that caller. */

import type { Middleware } from '@reduxjs/toolkit';
import { api } from '../lib/api';
import { chaptersActions } from './chapters-slice';
import { revisionsActions } from './revisions-slice';
import { buildPendingRevisionStub } from '../lib/build-pending-revision';
import type { StreamRunner } from './generation-stream-runner';
import type { ChaptersState } from './chapters-slice';
import type { CastState } from './cast-slice';
import type { UiState } from './ui-slice';
import type { AnalysisState } from './analysis-slice';
import type { Chapter, GenerationTick } from '../lib/types';

interface StreamableRootState {
  ui: UiState;
  chapters: ChaptersState;
  cast: CastState;
  /* Plan 32 D2 follow-up: the implicit reconcile-driven open below
     needs to honour the same engine === 'local' rule the reverse-
     local-analyzer guard hook enforces for EXPLICIT TTS-start
     callsites. Without analysis access here, a cold-boot rehydration
     of a book with both a live local analysis AND queued chapters
     would auto-start a generation behind the user's back. */
  analysis: AnalysisState;
}

function bookIdFromState(s: StreamableRootState): string | null {
  const stage = s.ui.stage as { bookId?: string };
  return stage.bookId ?? null;
}

function hasWork(chapters: Chapter[]): boolean {
  /* Excluded chapters are skipped by the server's target loop
     (server/src/routes/generation.ts) and the active-subset counters /
     snapshotFromChapters in the runner — so they must also be excluded
     here, or a pre-run exclude leaves a 'queued' row that keeps the SSE
     handle (and the global "Generating · N/N · 100%" pill) alive forever
     after the last real chapter finishes. */
  return chapters.some(
    (c) => !c.excluded && (c.state === 'in_progress' || c.state === 'queued'),
  );
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
  'chapters/regenerateChapterIds',
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

/* Regen actions need an explicit close *before* reconcile so the new spec
   gets a fresh stream — without this, the existing handle stays open and
   reconcile sees the runner already open and skips the open that would
   forward `chapterIds + force`. Only relevant when the user is acting on
   the same book the handle is streaming for — regen from a different book
   context would be a no-op for the existing stream anyway. */
const REGEN_TYPES = new Set<string>([
  'chapters/regenerateChapter',
  'chapters/regenerateChapterIds',
  'chapters/regenerateCharacter',
  'chapters/batchRegenerateCharacters',
]);

export function generationStreamMiddleware(getRunner: () => StreamRunner): Middleware {
  return (store) => {
    const dispatch = store.dispatch;

    const reconcile = () => {
      const runner = getRunner();
      const after = store.getState() as StreamableRootState;
      const stageBookId = bookIdFromState(after);
      const modelKey = after.ui.ttsModelKey;
      const { chapters, paused, pendingRegen, currentBookId } = after.chapters;

      /* Pause is the universal user-initiated stop. It is dispatched only
         from contexts that mean "stop the active stream": the
         local-analyzer confirm prompt (handles cross-book pause). Fire an
         explicit /pause to the server so the run stops server-side (closing
         the SSE alone is no longer enough — the server now treats SSE close
         as "unsubscribe this observer", which is what lets a browser reload
         survive without killing the run), then close our local handle. */
      if (runner.isOpen() && paused) {
        const pauseBookId = runner.getBookId();
        if (pauseBookId) void api.pauseGeneration({ bookId: pauseBookId });
        runner.close();
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
      if (runner.isOpen()) {
        /* Already streaming — nothing to do on the open side. The only
           remaining close trigger is the queue-drain check the slice runs
           itself on the final idle tick, which will leave hasWork(chapters)
           false on the next reconcile pass. */
        if (currentBookId === runner.getBookId()) {
          const shouldOpen = pendingRegen != null || hasWork(chapters);
          if (!shouldOpen) runner.close();
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

      /* Plan 32 D2 follow-up: REVERSE-LOCAL-ANALYZER GUARD (implicit
         path). The D2 hook gates EXPLICIT user-initiated TTS-start
         callsites (Resume button, Regenerate modal confirms). This
         block closes the parallel implicit seam: cold-boot rehydration
         of a book with both `analysis.activeStream.engine === 'local'`
         (an alive local analysis on the same book) AND a non-empty
         generation queue would otherwise auto-fire generation behind
         the user's back, competing for the same GPU.
         Rule mirrors the hook (use-reverse-local-analyzer-guard.tsx):
         - engine === 'local' — Gemini analyses don't compete for GPU,
           so the gate doesn't fire on them.
         - bookId matches — a local analysis on book A shouldn't block
           generation on unrelated book B.
         - state !== 'paused' / 'halted' — a user-paused or halted
           analysis is already not competing for GPU; respecting that
           matches the existing sticky-generation contract (the user
           explicitly stopped the analysis).
         Refusal mechanism: flip the slice to paused. The user reads
         the analysis pill, knows what's running, and resumes
         generation when ready. No new modal — we're not nagging on
         every navigation, we're refusing to act without consent. */
      /* Defensive read: a handful of legacy test harnesses build a
         store without the analysis slice. Production always has it
         (configured in src/store/index.ts). */
      const analysisSnap =
        (after as { analysis?: { activeStream?: typeof after.analysis.activeStream } }).analysis
          ?.activeStream ?? null;
      if (
        analysisSnap != null &&
        analysisSnap.engine === 'local' &&
        analysisSnap.bookId === stageBookId &&
        analysisSnap.state !== 'paused' &&
        analysisSnap.state !== 'halted'
      ) {
        dispatch(chaptersActions.setPaused(true));
        return;
      }

      runner.open(stageBookId, modelKey, pendingRegen, { consumePendingRegen: true });
    };

    return (next) => (action) => {
      const result = next(action);
      const a = action as { type?: string };
      const type = a?.type;
      if (!type || !TRIGGER_TYPES.has(type)) return result;

      const runner = getRunner();

      if (REGEN_TYPES.has(type) && runner.isOpen()) {
        const after = store.getState() as StreamableRootState;
        if (after.chapters.currentBookId === runner.getBookId()) runner.close();
      }

      /* Enqueue pending-revision stubs on regen dispatch. One per
         (characterId, chapterId) tuple — the slice's dedupe-by-id collapses
         restarts. The stub carries playable=false; chapter_complete flips
         it (handled in the runner's handleTick). Out-of-scope for
         chapter-only regens (regenerateChapter / regenerateChapterIds)
         since those don't carry a character to attribute the diff to. */
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

      /* Per-tick side-effects (snapshot refresh, rollup, completion / failure
         events, idle teardown) live in the shared runner so cross-book
         streams opened by the queue dispatcher get them too. We observe the
         action here (post-reducer) and delegate. */
      if (type === 'chapters/applyGenerationTick') {
        const ev = (a as { payload?: GenerationTick }).payload;
        runner.handleTick(ev);
      }

      reconcile();
      return result;
    };
  };
}
