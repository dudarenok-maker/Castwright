// Pairs with docs/features/16-generation-stream.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { generationStreamMiddleware } from '../store/generation-stream-middleware';
import { GenerationView } from './generation';
import type { Chapter, Character, Sentence } from '../lib/types';

const streamGenerationMock = vi.fn();

vi.mock('../lib/api', () => ({
  /* Never-resolving so the ChapterSegmentStrip useEffect doesn't flush a
     setError state update outside React's `act` after the test asserts. */
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return () => {};
    },
    getChapterAudio:  () => new Promise(() => {}),
    /* Sidecar status pill polls this on mount. Resolve with a happy status
       so the pill renders the green variant without spamming console
       warnings during the test render. */
    getSidecarHealth: () => Promise.resolve({ status: 'reachable', url: '(test)' }),
  },
}));

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  { id: 'keefe',    name: 'Keefe',    role: 'Empath',   color: 'peach' },
];

const sentences: Sentence[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A long room.' },                    // 3 words
  { id: 2, chapterId: 1, characterId: 'keefe',    text: 'Hello there friend!' },             // 3 words
  { id: 3, chapterId: 1, characterId: 'keefe',    text: 'How are you today on this fine evening?' }, // 8 words
  { id: 4, chapterId: 2, characterId: 'narrator', text: 'Elsewhere entirely.' },             // 2 words
];

const chapter1: Chapter = {
  id: 1,
  title: 'Chapter 1',
  duration: '00:49',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done', keefe: 'done' },
};
const chapter2: Chapter = {
  id: 2,
  title: 'Chapter 2',
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued', keefe: 'queued' },
};

function makeStore() {
  const store = configureStore({
    reducer: {
      ui:         uiSlice.reducer,
      chapters:   chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog:  changeLogSlice.reducer,
    },
  });
  store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
  store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
    bookId: 'b1',
    characters,
    chapters: [chapter1, chapter2],
    sentences,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any));
  return store;
}

function renderView() {
  const store = makeStore();
  return render(
    <Provider store={store}>
      <GenerationView
        chapters={[chapter1, chapter2]}
        characters={characters}
        paused
        title="Bonus Keefe Story"
        bookId="b1"
        modelKey="coqui-xtts-v2"
        setPaused={() => {}}
        onRegenerate={() => {}}
        onRegenerateCharacterInChapter={() => {}}
        onPreview={() => {}}
      />
    </Provider>,
  );
}

describe('GenerationView — chapter & character metadata (regression for screenshot bug)', () => {
  beforeEach(() => { /* paused=true so the streamGeneration effect short-circuits */ });

  it('shows manuscript-derived word/line/speaker counts under each chapter title', () => {
    renderView();
    /* Chapter 1: 1 narrator sentence (3 words) + 2 keefe sentences (3 + 8 = 11 words)
       → 14 words, 3 lines, 2 speakers */
    expect(screen.getByText(/14 words · 3 lines · 2 speakers/)).toBeInTheDocument();
    /* Chapter 2: 1 narrator sentence (2 words) → 2 words, 1 line, 1 speaker */
    expect(screen.getByText(/2 words · 1 line · 1 speaker/)).toBeInTheDocument();
  });

  it('renders per-character line + word counts next to each character in the expanded chapter row', () => {
    renderView();
    /* The chapter row toggle is the first button containing "CH 01". */
    fireEvent.click(screen.getByText('Chapter 1'));
    expect(screen.getByText(/1 line · 3 words/)).toBeInTheDocument();   // narrator in ch 1
    expect(screen.getByText(/2 lines · 11 words/)).toBeInTheDocument(); // keefe in ch 1
  });

  it('reports overall progress including Done chapters with no totalLines (the 4 % bug)', () => {
    /* Chapter 1 done (progress 1, 3 sentences in the manuscript), Chapter 2
       queued (progress 0, 1 sentence). Weighted by manuscript sentence count:
       (1 * 3 + 0 * 1) / (3 + 1) = 75 %. Pre-fix it would have shown 0 %
       because both chapters lacked the SSE-supplied totalLines. */
    renderView();
    expect(screen.getByText('75%')).toBeInTheDocument();
  });
});

describe('GenerationView — early-tick render guards (regression)', () => {
  it('does not render a stray "0" in the expanded row when currentLine is 0 at the start of a run', () => {
    /* Regression: `chapter.currentLine && (...)` short-circuits with `0`,
       and React renders `0` as the literal text "0". When generation
       has just kicked off (in_progress, no useful currentLine yet),
       the expanded row briefly shows a stray "0" near the left edge. */
    const live: Chapter = {
      id: 1,
      title: 'Chapter 1',
      duration: '00:00',
      state: 'in_progress',
      progress: 0.01,
      currentLine: 0,
      totalLines: 200,
      characters: { narrator: 'in_progress', keefe: 'queued' },
    };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([live]));
    store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
      bookId: 'b1', characters, chapters: [live], sentences,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    render(
      <Provider store={store}>
        <GenerationView
          chapters={[live]}
          characters={characters}
          paused
          title="Bonus Keefe Story"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          setPaused={() => {}}
          onRegenerate={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByText('Chapter 1'));
    /* The leak is a bare `{0}` rendered as a direct child of the
       expanded chapter card (a sibling of the per-character rows).
       Scope the assertion to the chapter card so legitimate "0" Stat
       counters in the page header (Completed/Failed) don't trip it. */
    const card = screen.getByText('Chapter 1').closest('.rounded-3xl');
    expect(card).not.toBeNull();
    const stray = Array.from(card!.querySelectorAll('*'))
      .filter(el => el.children.length === 0 && el.textContent === '0');
    expect(stray).toHaveLength(0);
  });
});

describe('GenerationView — heartbeat / stalled state', () => {
  it('shows the amber Stalled pill and banner when no tick has landed within STALL_THRESHOLD_MS', () => {
    /* Anchor wall-clock at a known instant so the gap between
       `lastTickAt` (set by the tick reducer) and the view's `Date.now()` call
       is deterministic. Fake timers without a setSystemTime would freeze
       Date.now to the test-runner default, which is also fine — but
       setSystemTime makes the 60s leap explicit. */
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-13T15:00:00Z'));

    const live: Chapter = {
      id: 1,
      title: 'Chapter 1',
      duration: '00:00',
      state: 'in_progress',
      progress: 0.5,
      currentLine: 50,
      totalLines: 100,
      characters: { narrator: 'in_progress', keefe: 'queued' },
    };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([live]));
    store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
      bookId: 'b1', characters, chapters: [live], sentences,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    /* Drive a real progress tick so the slice writes lastTickAt = Date.now()
       at the anchored instant. Then advance the clock by 60s and render —
       the view computes `stalled = Date.now() - lastTickAt > 30_000`. */
    store.dispatch(chaptersSlice.actions.applyGenerationTick({
      type: 'progress', chapterId: 1, characterId: 'narrator',
      progress: 0.5, currentLine: 50, totalLines: 100,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    vi.setSystemTime(new Date('2026-05-13T15:01:00Z'));

    render(
      <Provider store={store}>
        <GenerationView
          chapters={[live]}
          characters={characters}
          paused={false}
          title="Bonus Keefe Story"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          setPaused={() => {}}
          onRegenerate={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    /* The stalled banner copy is the load-bearing assertion — it's what
       answers "is it failed miserably or doing something?". */
    expect(screen.getByText(/Worker has gone quiet/)).toBeInTheDocument();
    /* And the in-progress chapter row swaps its peach "Generating" pill for
       a warning "Stalled" pill. */
    expect(screen.getAllByText('Stalled').length).toBeGreaterThan(0);

    vi.useRealTimers();
  });
});

describe('GenerationView — activity sidebar', () => {
  it('renders generation-related change-log events in the sidebar', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
    /* Replace the default seed with a single system event so the assertion
       is unambiguous. */
    store.dispatch(changeLogSlice.actions.hydrateFromBookState([{
      id: 1,
      at: new Date().toISOString(),
      ts: 'Just now',
      date: 'today',
      type: 'chapter_complete',
      title: 'Chapter 1 complete',
      note: 'Finished synthesising "Chapter 1".',
      actor: 'system',
      chapterId: 1,
    }]));

    render(
      <Provider store={store}>
        <GenerationView
          chapters={[chapter1, chapter2]}
          characters={characters}
          paused
          title="Bonus Keefe Story"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          setPaused={() => {}}
          onRegenerate={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    expect(screen.getByText('Activity')).toBeInTheDocument();
    /* The event's title is rendered inside the sidebar row. */
    expect(screen.getByText('Chapter 1 complete')).toBeInTheDocument();
  });
});

describe('generationStreamMiddleware — Pause/Resume regenerate loop (regression)', () => {
  beforeEach(() => { streamGenerationMock.mockClear(); });

  it('opens the SSE on regenerateChapter and drains pendingRegen immediately', () => {
    /* The bug: pause aborts the SSE before the server's idle tick arrives,
       so pendingRegen sticks. Resume reopens the SSE with the same
       force:true spec and wipes the in-flight chapter — every Pause→Resume
       is a fresh force-regen of the original target set. The fix is to
       dispatch consumePendingRegen immediately after the middleware opens
       the SSE. This regression used to live in the Generate view's effect;
       it now lives in `generationStreamMiddleware`. */
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      middleware: (gd) => gd().concat(generationStreamMiddleware),
    });
    /* Middleware skips opens unless a book is in scope. */
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
    /* Setup may have opened a stream on the initial chapters; the assertion
       below cares only about the regenerate-driven reopen. */
    streamGenerationMock.mockClear();

    store.dispatch(chaptersSlice.actions.regenerateChapter({ chapterId: 1, scope: 'this' }));

    /* streamGeneration MUST have been called with the spec (otherwise we'd
       have broken the regenerate path entirely). */
    expect(streamGenerationMock).toHaveBeenCalledTimes(1);
    const callArgs = streamGenerationMock.mock.calls[0]?.[0] as { chapterIds?: unknown; force?: unknown };
    expect(callArgs?.chapterIds).toEqual([1]);
    expect(callArgs?.force).toBe(true);

    /* And after the open, the spec is drained so a later Resume can't replay it. */
    expect(store.getState().chapters.pendingRegen).toBe(null);
  });
});
