// Pairs with docs/features/16-generation-stream.md
// Covers the SSE-handle owner that replaced the in-view useEffect, so that
// generation continues across view navigation, pauses cleanly, and — per
// the v3 sticky-generation contract — survives openBook to a different
// book, goHome, and TTS-model switches.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { chaptersSlice } from './chapters-slice';
import { manuscriptSlice } from './manuscript-slice';
import { uiSlice } from './ui-slice';
import { changeLogSlice } from './change-log-slice';
import { castSlice } from './cast-slice';
import { revisionsSlice } from './revisions-slice';
import { analysisSlice, analysisActions, type AnalysisStreamSnapshot } from './analysis-slice';
import { generationStreamMiddleware } from './generation-stream-middleware';
import { createStreamRunner, type StreamRunner } from './generation-stream-runner';
import type { Chapter, GenerationTick, Character } from '../lib/types';

const streamGenerationMock = vi.fn();
const cancelMock = vi.fn();
const pauseGenerationMock = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return cancelMock;
    },
    pauseGeneration: (args: unknown) => {
      pauseGenerationMock(args);
      return Promise.resolve();
    },
  },
}));

function makeStore() {
  /* The runner needs the store (dispatch/getState), which only exists after
     configureStore returns — so the middleware gets a lazy accessor and we
     bind the runner right after. One runner per store keeps tests isolated. */
  let runner: StreamRunner | null = null;
  const getRunner = (): StreamRunner => runner!;
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      cast: castSlice.reducer,
      revisions: revisionsSlice.reducer,
      analysis: analysisSlice.reducer,
    },
    middleware: (gd) => gd().concat(generationStreamMiddleware(getRunner)),
  });
  runner = createStreamRunner(store);
  return store;
}

const ch = (id: number, overrides: Partial<Chapter> = {}): Chapter => ({
  id,
  title: `Chapter ${id}`,
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued' },
  ...overrides,
});

/* Helper: simulate what Layout's per-book hydration effect does — set the
   slice's chapters and tell the middleware which book they're for. The
   middleware's auto-open is gated on `currentBookId === stageBookId`, so
   tests have to mirror the production handshake. Order matters: claim the
   book FIRST so the middleware's reconcile after the setChapters dispatch
   sees a consistent (currentBookId, chapters) pair; otherwise the stale
   currentBookId would let reconcile close a still-relevant stream the
   moment the slice swaps to a different book's rows. */
function seedBook(store: ReturnType<typeof makeStore>, bookId: string, chapters: Chapter[]) {
  store.dispatch(chaptersSlice.actions.setCurrentBookId(bookId));
  store.dispatch(chaptersSlice.actions.setChapters(chapters));
}

describe('generationStreamMiddleware', () => {
  beforeEach(() => {
    streamGenerationMock.mockClear();
    cancelMock.mockClear();
    pauseGenerationMock.mockClear();
  });

  it('opens the SSE when a regenerate spec lands and a book is in scope', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'done', progress: 1 }), ch(2)]);
    /* Setting chapters with a queued one already triggers an open (work in
       scope) — clear the spy so the assertion below counts only the
       regenerate-driven open. */
    streamGenerationMock.mockClear();
    cancelMock.mockClear();

    store.dispatch(chaptersSlice.actions.regenerateChapter({ chapterId: 1, scope: 'this' }));

    /* The previous handle was cancelled (chapter switched into in_progress
       via the reducer; pendingRegen was set; reconcile dropped the old
       handle and opened a fresh one with the spec). */
    expect(cancelMock).toHaveBeenCalled();
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0][0] as {
      chapterIds?: number[];
      force?: boolean;
    };
    expect(args.chapterIds).toEqual([1]);
    expect(args.force).toBe(true);
  });

  it('opens the SSE with the full list when regenerateChapterIds dispatches mid-run', () => {
    /* Bulk-regen path (plan 35): the drift banner's "Regenerate all"
       button dispatches regenerateChapterIds with a non-contiguous list.
       Same middleware contract as per-chapter regen — close the live
       handle, open a fresh one with chapterIds + force=true. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [
      ch(1, { state: 'done', progress: 1, audioModelKey: 'coqui-xtts-v2' }),
      ch(2, { state: 'done', progress: 1, audioModelKey: 'coqui-xtts-v2' }),
      ch(3, { state: 'queued' }),
      ch(4, { state: 'done', progress: 1, audioModelKey: 'coqui-xtts-v2' }),
    ]);
    streamGenerationMock.mockClear();
    cancelMock.mockClear();

    store.dispatch(chaptersSlice.actions.regenerateChapterIds({ chapterIds: [1, 2, 4] }));

    expect(cancelMock).toHaveBeenCalled();
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const args = streamGenerationMock.mock.calls[0][0] as {
      chapterIds?: number[];
      force?: boolean;
    };
    expect(args.chapterIds).toEqual([1, 2, 4]);
    expect(args.force).toBe(true);
  });

  it('cancels the SSE on setPaused(true) and reopens on setPaused(false)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(chaptersSlice.actions.setPaused(true));
    expect(cancelMock).toHaveBeenCalledTimes(1);
    /* clearActiveStream fires on close, so the snapshot disappears. */
    expect(store.getState().chapters.activeStream).toBeNull();

    streamGenerationMock.mockClear();
    store.dispatch(chaptersSlice.actions.setPaused(false));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  it('reacts to ui/changeView without crashing or double-opening (auto-start trigger regression)', () => {
    /* changeView must be in TRIGGER_TYPES so the middleware re-evaluates
       when the user navigates to Generate. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(uiSlice.actions.changeView('cast'));
    expect(streamGenerationMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();

    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    streamGenerationMock.mockClear();
    cancelMock.mockClear();
    store.dispatch(uiSlice.actions.changeView('generate'));
    expect(streamGenerationMock).not.toHaveBeenCalled();
    expect(cancelMock).not.toHaveBeenCalled();
  });

  it('keeps the SSE alive across changeView (background generation while user navigates within the book)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(uiSlice.actions.changeView('cast'));
    expect(cancelMock).toHaveBeenCalledTimes(0);

    store.dispatch(uiSlice.actions.changeView('generate'));
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
  });

  /* ── v3 sticky-generation contract ─────────────────────────────────── */

  it('keeps the SSE alive across goHome — generation runs in the background while user browses Books', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(uiSlice.actions.goHome());
    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(store.getState().chapters.activeStream?.bookId).toBe('b1');
  });

  it('keeps the SSE alive across startNewBook (Upload screen) — the canonical "I want to import while gen runs" path', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    store.dispatch(uiSlice.actions.goHome());
    store.dispatch(uiSlice.actions.startNewBook());
    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(store.getState().chapters.activeStream?.bookId).toBe('b1');
  });

  it('keeps the SSE alive when the user opens a different book — and refuses to start a second stream for it', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect((streamGenerationMock.mock.calls[0][0] as { bookId?: string }).bookId).toBe('b1');

    /* Opening a different book swaps the URL stage but the middleware's
       handle is pinned to b1. Layout would normally hydrate b2's chapters
       and dispatch setCurrentBookId('b2'); we simulate that here. */
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'generating' }));
    seedBook(store, 'b2', [ch(7, { state: 'queued' })]);

    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    /* activeStream still describes the original generating book. */
    expect(store.getState().chapters.activeStream?.bookId).toBe('b1');
  });

  it('keeps the SSE alive when the TTS model is switched mid-run (new model applies to the NEXT run)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const originalKey = (streamGenerationMock.mock.calls[0][0] as { modelKey?: string }).modelKey;

    store.dispatch(uiSlice.actions.setTtsModelKey('gemini-2.5-flash'));

    expect(cancelMock).toHaveBeenCalledTimes(0);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    /* The live handle stays bound to the original model — the picker only
       affects the next generation start. */
    expect(originalKey).not.toBe('gemini-2.5-flash');
  });

  it('drops applyGenerationTick into the slice when the slice has drifted to a different book', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* User opens b2; Layout swaps the slice's chapters and currentBookId. */
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    seedBook(store, 'b2', [
      ch(7, { state: 'done', progress: 1, characters: { narrator: 'done' } }),
    ]);

    /* A tick arrives for the still-running b1 stream. The reducer's
       cross-book guard must refuse to mutate the b2 chapter. */
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'progress',
        chapterId: 7,
        progress: 0.02,
        characterId: 'narrator',
      } as GenerationTick),
    );
    const state = store.getState().chapters;
    expect(state.chapters[0].state).toBe('done');
    expect(state.chapters[0].progress).toBe(1);
  });

  it('cancels on idle once the queue drains and does not reopen for an idle tick', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.5 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* Complete the chapter, then deliver the idle tick. */
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_complete',
        chapterId: 1,
      } as GenerationTick),
    );
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));

    expect(cancelMock).toHaveBeenCalled();
    expect(store.getState().chapters.activeStream).toBeNull();

    streamGenerationMock.mockClear();
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));
    expect(streamGenerationMock).not.toHaveBeenCalled();
  });

  it('accumulates chapter_complete ticks into a single rollup event on run end', () => {
    /* Used to emit one chapter_complete log entry per tick — a 14-chapter run
       became 14 nearly-identical "Chapter N complete" lines in the audit
       feed. The middleware now defers per-chapter ticks until closeHandle,
       then writes one generation_run_complete that names every chapter. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [
      ch(1, { state: 'in_progress', progress: 0.5 }),
      ch(2, { state: 'queued' }),
      ch(3, { state: 'queued' }),
    ]);
    /* generation_started already landed at open time. Count types so the
       assertion is robust to that anchor. */
    const countByType = (t: string) =>
      store.getState().changeLog.events.filter((e) => e.type === t).length;
    const startedAtOpen = countByType('generation_started');

    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_complete',
        chapterId: 1,
      } as GenerationTick),
    );
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_complete',
        chapterId: 2,
      } as GenerationTick),
    );

    /* No per-chapter complete events written yet. */
    expect(countByType('chapter_complete')).toBe(0);
    expect(countByType('generation_run_complete')).toBe(0);

    /* Complete chapter 3 too, then drain — the queue going idle closes
       the handle and triggers the rollup flush. */
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_complete',
        chapterId: 3,
      } as GenerationTick),
    );
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));

    const events = store.getState().changeLog.events;
    expect(countByType('chapter_complete')).toBe(0);
    expect(countByType('generation_run_complete')).toBe(1);
    expect(countByType('generation_started')).toBe(startedAtOpen);
    expect(events[0].type).toBe('generation_run_complete');
    expect(events[0].actor).toBe('system');
    expect(events[0].title).toBe('Generated 3 chapters');
    expect(events[0].note).toContain('Chapters 1');
    expect(events[0].note).toContain('3');
  });

  it('still emits per-chapter chapter_failed events (failures stay individually actionable)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(4, { state: 'in_progress', progress: 0.5 })]);
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_failed',
        chapterId: 4,
        errorReason: 'Voice not found',
      } as GenerationTick),
    );
    const events = store.getState().changeLog.events;
    expect(events[0].type).toBe('chapter_failed');
    expect(events[0].chapterId).toBe(4);
    expect(events[0].note).toContain('Voice not found');
  });

  it('writes no rollup event when the run drains with zero chapter_complete ticks (empty run)', () => {
    /* Pause-before-any-chapter-finishes path — the generation_started anchor
       is enough; no synthetic "Generated 0 chapters" entry. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    const beforeRollup = store
      .getState()
      .changeLog.events.filter((e) => e.type === 'generation_run_complete').length;

    store.dispatch(chaptersSlice.actions.setPaused(true));

    const afterRollup = store
      .getState()
      .changeLog.events.filter((e) => e.type === 'generation_run_complete').length;
    expect(afterRollup).toBe(beforeRollup);
  });

  it('publishes an activeStream snapshot on open and clears it on close', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    expect(store.getState().chapters.activeStream).toBeNull();

    seedBook(store, 'b1', [
      ch(1, { state: 'done', progress: 1, characters: { narrator: 'done' } }),
      ch(2, { state: 'in_progress', progress: 0.5 }),
      ch(3, { state: 'queued' }),
    ]);
    const snap = store.getState().chapters.activeStream;
    expect(snap).not.toBeNull();
    expect(snap!.bookId).toBe('b1');
    expect(snap!.done).toBe(1);
    expect(snap!.total).toBe(3);
    expect(snap!.inProgress).toBe(1);

    /* Stop → snapshot cleared. */
    store.dispatch(chaptersSlice.actions.setPaused(true));
    expect(store.getState().chapters.activeStream).toBeNull();
  });

  it('enqueues a pending revision per (characterId, chapterId) on regenerateCharacter', () => {
    /* The diff-audio rollout (plan 20) leans on revisions.pending so the
       toolbar pending badge surfaces the in-flight regen immediately,
       without waiting for the 30s revisions poll cycle. The middleware
       fans out one enqueuePending dispatch per affected chapter. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1), ch(2), ch(3)]);
    store.dispatch(
      castSlice.actions.setCharacters([
        { id: 'halloran', name: 'Halloran', role: 'PoV', color: 'narrator' } as Character,
      ]),
    );

    store.dispatch(
      chaptersSlice.actions.regenerateCharacter({ characterId: 'halloran', chapterIds: [1, 3] }),
    );

    const pending = store.getState().revisions.pending;
    expect(pending).toHaveLength(2);
    expect(
      pending.map((r) => ({
        chapterId: r.chapterId,
        characterId: r.characterId,
        playable: r.playable,
      })),
    ).toEqual([
      { chapterId: 1, characterId: 'halloran', playable: false },
      { chapterId: 3, characterId: 'halloran', playable: false },
    ]);
  });

  it('fans out across (character × chapter) pairs on batchRegenerateCharacters', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1), ch(2)]);
    store.dispatch(
      castSlice.actions.setCharacters([
        { id: 'halloran', name: 'Halloran', role: 'PoV', color: 'narrator' } as Character,
        { id: 'mary', name: 'Mary', role: 'foil', color: 'magenta' } as Character,
      ]),
    );

    store.dispatch(
      chaptersSlice.actions.batchRegenerateCharacters({
        characterIds: ['halloran', 'mary'],
        chapterIds: [1, 2],
      }),
    );

    const pending = store.getState().revisions.pending;
    expect(pending).toHaveLength(4);
    /* Verify all four pairs are represented. */
    const pairs = pending.map((r) => `${r.characterId}:${r.chapterId}`).sort();
    expect(pairs).toEqual(['halloran:1', 'halloran:2', 'mary:1', 'mary:2']);
  });

  it('flips revision.playable=true when chapter_complete tick lands', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1), ch(2)]);
    store.dispatch(
      castSlice.actions.setCharacters([
        { id: 'halloran', name: 'Halloran', role: 'PoV', color: 'narrator' } as Character,
      ]),
    );
    store.dispatch(
      chaptersSlice.actions.regenerateCharacter({ characterId: 'halloran', chapterIds: [1, 2] }),
    );
    expect(store.getState().revisions.pending.every((r) => r.playable === false)).toBe(true);

    /* Simulate the SSE chapter_complete tick for chapter 1. */
    const tick: GenerationTick = {
      type: 'chapter_complete',
      chapterId: 1,
      characterId: 'halloran',
      progress: 1,
      currentLine: 0,
      totalLines: 0,
    } as unknown as GenerationTick;
    store.dispatch(chaptersSlice.actions.applyGenerationTick(tick));

    const pending = store.getState().revisions.pending;
    expect(pending.find((r) => r.chapterId === 1)?.playable).toBe(true);
    expect(pending.find((r) => r.chapterId === 2)?.playable).toBe(false);
  });

  it('counts only non-excluded chapters in the activeStream snapshot (top-bar pill regression)', () => {
    /* The top-bar GenerationPill renders `{done}/{total}` straight from
       this snapshot. Excluded chapters never queue or synthesise, so they
       must not inflate `total` — otherwise the pill freezes at e.g. 8/10
       and the user reads it as "still 2 to go" when the run has actually
       finished everything in scope. Mirrors `activeChapters` in
       src/views/generation.tsx. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));

    seedBook(store, 'b1', [
      ch(1, { state: 'done', progress: 1, characters: { narrator: 'done' } }),
      ch(2, { state: 'in_progress', progress: 0.5 }),
      ch(3, { state: 'queued', excluded: true }),
      ch(4, { state: 'queued', excluded: true }),
    ]);
    const snap = store.getState().chapters.activeStream;
    expect(snap).not.toBeNull();
    expect(snap!.total).toBe(2);
    expect(snap!.done).toBe(1);
    expect(snap!.inProgress).toBe(1);
  });

  it('tears down the handle when the only remaining queued chapters are excluded (stuck-pill regression)', () => {
    /* Bug: pill froze at "Generating · 70/70 · 100%" after a Kokoro run
       finished. Root cause: `hasWork()` in the middleware didn't filter
       out excluded chapters, so a pre-run exclude left a row in 'queued'
       state forever, reconcile's drain check never tripped, and the
       SSE handle (plus the global activeStream snapshot) stayed alive
       indefinitely. Mirrors the active-subset filter already used by
       snapshotFromChapters and the Generate view's counters. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [
      ch(1, { state: 'in_progress', progress: 0.5 }),
      ch(2, { state: 'queued', excluded: true }),
    ]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.activeStream).not.toBeNull();

    /* Complete the only non-excluded chapter. After the reducer flips it
       to 'done', reconcile should consider the queue drained (the
       excluded 'queued' row does not count). */
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_complete',
        chapterId: 1,
      } as GenerationTick),
    );

    expect(cancelMock).toHaveBeenCalled();
    expect(store.getState().chapters.activeStream).toBeNull();
  });

  it('closes the SSE on idle even when the slice has drifted to a different book', () => {
    /* Server emits its terminal `idle` tick to every attached subscriber
       once the target loop drains (server/src/routes/generation.ts).
       The middleware's reconcile-based close is gated on
       currentBookId === handle.bookId, so an idle tick that lands while
       the user is on a different book (or any global view) would leave
       the handle live and the global pill stuck at 100% until the user
       navigated back to the generating book. The middleware now closes
       on idle unconditionally as a cross-book end-of-stream signal. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.5 })]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);

    /* Simulate the user opening a different book mid-run — Layout's
       hydration effect flips currentBookId; the handle stays pinned
       to b1 per the sticky-generation contract. */
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b2'));
    expect(cancelMock).not.toHaveBeenCalled();
    expect(store.getState().chapters.activeStream?.bookId).toBe('b1');

    /* Final idle arrives for the still-streaming b1 job. The slice is
       on b2 so reconcile's cross-book guard would return early — only
       the explicit idle-tick close in the middleware tears the handle
       down here. */
    store.dispatch(chaptersSlice.actions.applyGenerationTick({ type: 'idle' } as GenerationTick));

    expect(cancelMock).toHaveBeenCalled();
    expect(store.getState().chapters.activeStream).toBeNull();
  });
});

describe('generationStreamMiddleware — reverse-local-analyzer guard (plan 32 D2 follow-up)', () => {
  /* The D2 reverse-guard hook only intercepts EXPLICIT TTS-start
     callsites (Resume button + the three regenerate modals). The
     implicit reconcile-driven open in this middleware bypassed it —
     so a cold-boot rehydration of a book with both `engine: 'local'`
     analysis AND queued chapters would auto-fire generation behind
     the user's back, fighting the analyzer for GPU. These specs pin
     the new middleware-level rule: refuse to open the handle on
     reconcile when a live local analysis sits on the same book; flip
     to paused instead so the user can choose when to resume.
     Mirrors src/hooks/use-reverse-local-analyzer-guard.tsx's
     engine === 'local' + bookId match rule. */

  const localAnalysisSnap = (
    bookId: string,
    state: AnalysisStreamSnapshot['state'] = 'running',
  ): AnalysisStreamSnapshot => ({
    bookId,
    manuscriptId: 'mns_x',
    phaseId: 0,
    phaseLabel: 'Detecting characters',
    phaseProgress: 0.1,
    remainingMs: null,
    lastTickAt: 1000,
    state,
    engine: 'local',
  });

  beforeEach(() => {
    streamGenerationMock.mockClear();
    cancelMock.mockClear();
    pauseGenerationMock.mockClear();
  });

  it('refuses to auto-open generation when a live local analysis is alive on the same book', () => {
    /* Cold-boot shape: open the book on the Generate route, seed an
       active local analysis on that book, then seed the chapter
       queue (the order Layout's hydration effect produces — book
       opens first, then per-book hydrate runs analysis-state +
       chapters in parallel). The middleware's reconcile fires
       after every TRIGGER_TYPES action; the analysis snapshot
       seeded before the chapter rows means the guard sees the
       live local run when the queue lands. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(analysisActions.setActiveStream(localAnalysisSnap('b1')));
    seedBook(store, 'b1', [ch(1, { state: 'queued' }), ch(2, { state: 'queued' })]);

    expect(streamGenerationMock).not.toHaveBeenCalled();
    expect(store.getState().chapters.paused).toBe(true);
  });

  it('does NOT gate when the analysis engine is gemini (cloud — no GPU contention)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(
      analysisActions.setActiveStream({
        ...localAnalysisSnap('b1'),
        engine: 'gemini',
      }),
    );
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);

    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.paused).toBe(false);
  });

  it('does NOT gate when the local analysis is already paused (user explicitly stopped it)', () => {
    /* A paused local analysis isn't competing for the GPU — respect
       the user's explicit stop and let generation open as usual. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(analysisActions.setActiveStream(localAnalysisSnap('b1', 'paused')));
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);

    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.paused).toBe(false);
  });

  it('does NOT gate when the local analysis is halted (terminal error state — no longer competing)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(analysisActions.setActiveStream(localAnalysisSnap('b1', 'halted')));
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);

    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.paused).toBe(false);
  });

  it('does NOT gate when the local analysis is on a DIFFERENT book (no GPU contention on this book)', () => {
    /* The reverse-guard rule is per-book: a local analysis running
       on book A shouldn't refuse generation on book B even though
       they technically share GPU. The hook scopes this way too —
       it reads the active stream's bookId and compares against the
       TTS-target bookId. */
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(analysisActions.setActiveStream(localAnalysisSnap('b_other')));
    seedBook(store, 'b1', [ch(1, { state: 'queued' })]);

    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    expect(store.getState().chapters.paused).toBe(false);
  });
});

/* Bug E — cross-book heartbeat + counter refresh. When the user navigates
   from the generating book to a different book, the per-chapter tick
   reducer's cross-book guard (chapters-slice.ts) drops the per-row
   mutation but the middleware must still refresh the activeStream
   snapshot's lastTickAt + counters from the tick payload. Without this
   the pill freezes at the open-time snapshot and the stall check flips
   to "Stalled" after 30 s even though the SSE is still ticking. */
describe('generationStreamMiddleware — Bug E cross-book heartbeat + counters', () => {
  beforeEach(() => {
    streamGenerationMock.mockClear();
    cancelMock.mockClear();
    pauseGenerationMock.mockClear();
  });

  it('refreshes activeStream counters AND lastTickAt from tick payload when slice is on a different book', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [
      ch(1, { state: 'in_progress', progress: 0.1 }),
      ch(2),
      ch(3),
    ]);
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const openTickAt = store.getState().chapters.activeStream?.lastTickAt;

    /* User navigates to a different book. Layout would dispatch
       setCurrentBookId('b2') + setChapters(b2's chapters). */
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'generating' }));
    seedBook(store, 'b2', [ch(7, { state: 'queued' })]);
    /* Hold the clock so the next dispatch's `Date.now()` is strictly
       greater than openTickAt — Vitest's default fake timers aren't
       active here, so use real time and just wait a millisecond. */
    const before = Date.now();

    /* The original generation SSE for b1 fires a progress tick carrying
       the server's run aggregates. The slice's cross-book guard drops the
       per-chapter mutation, but the middleware's cross-book branch
       should refresh activeStream from the payload. */
    const tick = {
      type: 'progress',
      chapterId: 33,
      characterId: null,
      progress: 0.5,
      currentLine: 100,
      totalLines: 200,
      runDone: 32,
      runTotal: 63,
      runInProgress: 1,
    } as unknown as GenerationTick;
    store.dispatch(chaptersSlice.actions.applyGenerationTick(tick));

    const snap = store.getState().chapters.activeStream;
    expect(snap?.bookId).toBe('b1'); /* still describes the generating book */
    expect(snap?.done).toBe(32);
    expect(snap?.total).toBe(63);
    expect(snap?.inProgress).toBe(1);
    expect(snap?.lastTickAt).not.toBeNull();
    expect(snap!.lastTickAt!).toBeGreaterThanOrEqual(before);
    if (openTickAt != null) {
      expect(snap!.lastTickAt!).toBeGreaterThanOrEqual(openTickAt);
    }
  });

  it('still bumps lastTickAt across cross-book navigation even when the tick payload omits run* fields (older server fallback)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [
      ch(1, { state: 'in_progress', progress: 0.1 }),
      ch(2),
    ]);
    const openSnap = store.getState().chapters.activeStream;
    expect(openSnap).not.toBeNull();
    const openDone = openSnap!.done;
    const openTotal = openSnap!.total;
    const openInProgress = openSnap!.inProgress;
    const openTickAt = openSnap!.lastTickAt;

    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'generating' }));
    seedBook(store, 'b2', [ch(7, { state: 'queued' })]);
    const before = Date.now();

    /* Older-server tick — no runDone/runTotal/runInProgress. */
    const tick = {
      type: 'progress',
      chapterId: 1,
      characterId: null,
      progress: 0.5,
      currentLine: 100,
      totalLines: 200,
    } as unknown as GenerationTick;
    store.dispatch(chaptersSlice.actions.applyGenerationTick(tick));

    const snap = store.getState().chapters.activeStream;
    /* Counters stay at their open-time values (the slice didn't have b1's
       rows to recompute, and the payload didn't carry server aggregates). */
    expect(snap?.done).toBe(openDone);
    expect(snap?.total).toBe(openTotal);
    expect(snap?.inProgress).toBe(openInProgress);
    /* But lastTickAt advanced — the pill won't go spuriously stalled. */
    expect(snap!.lastTickAt!).toBeGreaterThanOrEqual(before);
    if (openTickAt != null) {
      expect(snap!.lastTickAt!).toBeGreaterThanOrEqual(openTickAt);
    }
  });

  it('idle tick does NOT trigger the cross-book refresh (idle is queue-drain, not a heartbeat)', () => {
    const store = makeStore();
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    seedBook(store, 'b1', [ch(1, { state: 'in_progress', progress: 0.1 })]);
    store.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'generating' }));
    seedBook(store, 'b2', [ch(7, { state: 'queued' })]);

    const beforeIdle = store.getState().chapters.activeStream?.lastTickAt;
    /* Sleep a moment so a misfiring refresh would show a higher number. */
    const wallBefore = Date.now() + 1;
    while (Date.now() < wallBefore) {
      /* tight loop ~1ms — adequate without timers */
    }
    const idleTick = {
      type: 'idle',
      chapterId: 0,
      characterId: null,
      progress: 0,
      currentLine: 0,
      totalLines: 0,
    } as unknown as GenerationTick;
    store.dispatch(chaptersSlice.actions.applyGenerationTick(idleTick));

    const snap = store.getState().chapters.activeStream;
    /* Idle skipped both the slice mutation AND the cross-book refresh. */
    expect(snap?.lastTickAt).toBe(beforeIdle);
  });
});
