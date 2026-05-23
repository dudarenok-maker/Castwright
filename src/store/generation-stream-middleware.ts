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
   delegation to `runner.handleTick`. The ways a run stops:
     - chapters/requestStreamHalt, from the local-analyzer confirm prompt (see
       src/hooks/use-local-analyzer-guard.tsx) when a local-engine analysis
       would compete with TTS for GPU — closes the handle immediately.
     - the queue draining (final idle tick from the server → runner closes).
     - queue.paused gating the open side (replaces the removed chapters.paused).

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
import { revisionsActions } from './revisions-slice';
import { buildPendingRevisionStub } from '../lib/build-pending-revision';
import type { StreamRunner, StreamSpec } from './generation-stream-runner';
import type { ChaptersState } from './chapters-slice';
import type { CastState } from './cast-slice';
import type { UiState } from './ui-slice';
import type { AnalysisState } from './analysis-slice';
import type { QueueState } from './queue-slice';
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
  /* Plan 102 Should #5 — the open-side gate now reads the queue-global
     pause flag (replacing the removed chapters.paused). queue.paused = true
     means the user (or the local-analyzer halt) stopped the drain, so
     reconcile must not auto-open a stream — including the cold-boot resume
     path. Optional-at-runtime read keeps legacy test stores (no queue slice)
     working. */
  queue: QueueState;
}

/** Resolve the regen spec (chapterIds + force) from a regenerate action,
    mirroring each reducer's target-selection so the SSE force-renders exactly
    the rows the reducer flipped. Returns null when nothing is in scope (e.g. a
    character-regen on a chapter where the character is skipped) — reconcile
    then falls back to the plain hasWork resume path. Replaces the removed
    chapters.pendingRegen field; the spec lives in middleware-local state and
    is handed straight to the runner. */
function specFromRegenAction(type: string, payload: unknown, chapters: Chapter[]): StreamSpec | null {
  let chapterIds: number[] = [];
  if (type === 'chapters/regenerateChapter') {
    const { chapterId, scope } = payload as { chapterId: number; scope: 'this' | 'forward' };
    chapterIds = chapters
      .filter((c) => c.id === chapterId || (scope === 'forward' && c.id > chapterId))
      .map((c) => c.id);
  } else if (type === 'chapters/regenerateChapterIds') {
    const { chapterIds: ids } = payload as { chapterIds: number[] };
    const set = new Set(ids);
    chapterIds = chapters.filter((c) => set.has(c.id) && !c.excluded).map((c) => c.id);
  } else if (type === 'chapters/regenerateCharacter') {
    const { characterId, chapterIds: ids } = payload as {
      characterId: string;
      chapterIds: number[];
    };
    const set = new Set(ids);
    chapterIds = chapters
      .filter(
        (c) => set.has(c.id) && c.characters[characterId] && c.characters[characterId] !== 'skipped',
      )
      .map((c) => c.id);
  } else if (type === 'chapters/batchRegenerateCharacters') {
    const { chapterIds: ids } = payload as { chapterIds: number[] };
    const set = new Set(ids);
    chapterIds = chapters.filter((c) => set.has(c.id)).map((c) => c.id);
  }
  return chapterIds.length ? { chapterIds, force: true } : null;
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
  'chapters/requestStreamHalt',
  'chapters/applyGenerationTick',
  'chapters/hydrateFromBookState',
  'chapters/setCurrentBookId',
  'queue/setSnapshot',
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

    /* The regen spec (chapterIds + force) for the next open. Set by the
       regen-action observer below (replacing the removed chapters.pendingRegen
       slice field), read + drained by reconcile when it opens. Middleware-
       local so the slice carries no generation-control state. */
    let pendingSpec: StreamSpec | null = null;

    const reconcile = () => {
      const runner = getRunner();
      const after = store.getState() as StreamableRootState;
      const stageBookId = bookIdFromState(after);
      const modelKey = after.ui.ttsModelKey;
      const { chapters, currentBookId } = after.chapters;
      /* Defensive read: legacy test stores omit the queue slice. */
      const queuePaused = (after as { queue?: QueueState }).queue?.paused ?? false;

      /* Sticky semantics: once a handle is open for book X, it stays open
         across goHome, openBook(otherBook), changeView, setTtsModelKey, and
         every other transition. The only close trigger on THIS side is queue
         drain (below — when the streaming book has no work left). The hard
         "halt now" path (local-analyzer guard) closes the handle directly via
         the requestStreamHalt observer, not here. Notably:
           - We do NOT close on stageBookId == null / != handle.bookId. The
             user may navigate away; the handle keeps streaming and the
             applyGenerationTick cross-book guard protects the other book's
             rows.
           - We do NOT close on modelKey change (takes effect next run).
           - We do NOT close on queue.paused — a queue pause stops the drain
             of the NEXT entry but lets the in-flight chapter finish (it
             closes naturally when hasWork goes false on the idle tick). */
      if (runner.isOpen()) {
        if (currentBookId === runner.getBookId()) {
          const shouldOpen = pendingSpec != null || hasWork(chapters);
          if (!shouldOpen) runner.close();
        }
        return;
      }

      /* No handle. Open only when the slice and the URL agree on which book
         we're on, there's work in scope, and the queue isn't globally paused.
         The queue.paused gate replaces the removed chapters.paused: a paused
         queue means "don't drain / don't auto-resume", which must also block
         the cold-boot reconnect path and any pending regen spec. */
      if (!stageBookId) return;
      if (currentBookId !== stageBookId) return;
      if (queuePaused) return;
      const shouldOpen = pendingSpec != null || hasWork(chapters);
      if (!shouldOpen) return;

      /* REVERSE-LOCAL-ANALYZER GUARD (plan 32 D2 → plan 102 pure gate).
         When a local analysis is alive on this same book, do NOT auto-open a
         generation stream — the two would fight for the GPU. This used to
         flip chapters.paused; with that field gone the refusal is simply
         "don't open this pass". Any pendingSpec stays put and opens once the
         analysis finishes and a later trigger re-runs reconcile.
         Rule mirrors use-reverse-local-analyzer-guard.tsx:
         - engine === 'local' — remote (Gemini) analyses don't compete for GPU.
         - bookId matches — a local analysis on book A shouldn't block book B.
         - state !== 'paused' / 'halted' — a stopped analysis isn't competing.
         Defensive read: legacy test harnesses omit the analysis slice. */
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
        return;
      }

      runner.open(stageBookId, modelKey, pendingSpec);
      pendingSpec = null;
    };

    return (next) => (action) => {
      const result = next(action);
      const a = action as { type?: string };
      const type = a?.type;
      if (!type || !TRIGGER_TYPES.has(type)) return result;

      const runner = getRunner();

      /* Hard "halt now" — the local-analyzer guard fires this when a local
         analysis is about to start and needs the GPU the in-flight TTS run is
         holding. Close the handle immediately (+ POST /pause so the server
         stops the run) and SKIP reconcile — the accompanying setQueuePaused
         keeps the dispatcher + reconcile from re-opening on the next pass. */
      if (type === 'chapters/requestStreamHalt') {
        if (runner.isOpen()) {
          const haltBookId = runner.getBookId();
          if (haltBookId) void api.pauseGeneration({ bookId: haltBookId });
          runner.close();
        }
        return result;
      }

      if (REGEN_TYPES.has(type)) {
        const after = store.getState() as StreamableRootState;
        /* Compute the regen spec from the action + post-reducer rows and stash
           it for reconcile to hand to the runner (replaces chapters.pendingRegen). */
        const payload = (a as { payload?: unknown }).payload;
        const spec = specFromRegenAction(type, payload, after.chapters.chapters);
        if (spec) pendingSpec = spec;
        /* Defensive close-and-reopen: if a same-book stream is somehow already
           open when a fresh regen lands, close it so reconcile reopens with
           the new spec. The queue dispatcher serialises drains (it won't fire
           a regen while activeStream is set), so this is belt-and-braces. */
        if (runner.isOpen() && after.chapters.currentBookId === runner.getBookId()) runner.close();
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
