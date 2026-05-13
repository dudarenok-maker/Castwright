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
        onRegenerateBook={() => {}}
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
          onRegenerateBook={() => {}}
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

describe('GenerationView — per-character progress is derived from the manuscript (false-Done regression)', () => {
  /* The bug: by line 13 of an 82-line chapter every cast member had spoken
     at least once, the slice flipped previously-active speakers to `done`,
     and the expanded chapter row showed three full-green "Done" bars while
     synthesis was still 16% through. Fix derives per-character "lines
     synthesised" from manuscript line positions + chapter.currentLine. */

  const cast: Character[] = [
    { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
    { id: 'keefe',    name: 'Keefe',    role: 'Empath',   color: 'peach' },
    { id: 'ro',       name: 'Ro',       role: 'Goblin',   color: 'magenta' },
    { id: 'elwin',    name: 'Elwin',    role: 'Physician', color: 'violet' },
  ];

  /* Day-One-shaped chapter: narrator dominates, the other three each speak
     once before line 13 AND have lines still to come after it — so at
     currentLine=13 keefe/ro/elwin should each show fractional progress,
     not "Done". Pre-fix the slice would have marked all three "done" the
     moment the next speaker took over. */
  const dayOne: Sentence[] = [
    { id: 1,  chapterId: 2, characterId: 'narrator', text: 'open' },
    { id: 2,  chapterId: 2, characterId: 'narrator', text: 'b' },
    { id: 3,  chapterId: 2, characterId: 'keefe',    text: 'k1' },
    { id: 4,  chapterId: 2, characterId: 'narrator', text: 'c' },
    { id: 5,  chapterId: 2, characterId: 'ro',       text: 'r1' },
    { id: 6,  chapterId: 2, characterId: 'narrator', text: 'd' },
    { id: 7,  chapterId: 2, characterId: 'elwin',    text: 'e1' },
    { id: 8,  chapterId: 2, characterId: 'narrator', text: 'e' },
    { id: 9,  chapterId: 2, characterId: 'narrator', text: 'f' },
    { id: 10, chapterId: 2, characterId: 'narrator', text: 'g' },
    { id: 11, chapterId: 2, characterId: 'narrator', text: 'h' },
    { id: 12, chapterId: 2, characterId: 'narrator', text: 'i' },
    { id: 13, chapterId: 2, characterId: 'narrator', text: 'j (current)' },
    /* Each non-narrator has at least one line still ahead of line 13 so
       they appear as partial progress, not "Done". */
    { id: 14, chapterId: 2, characterId: 'keefe',    text: 'k2' },
    { id: 15, chapterId: 2, characterId: 'elwin',    text: 'e2' },
    { id: 16, chapterId: 2, characterId: 'ro',       text: 'r2' },
    { id: 17, chapterId: 2, characterId: 'keefe',    text: 'k3' },
    { id: 18, chapterId: 2, characterId: 'elwin',    text: 'e3' },
    { id: 19, chapterId: 2, characterId: 'elwin',    text: 'e4' },
    { id: 20, chapterId: 2, characterId: 'narrator', text: 'closer' },
  ];

  function renderScenario() {
    const liveChapter: Chapter = {
      id: 2,
      title: 'DAY ONE',
      duration: '00:00',
      state: 'in_progress',
      progress: 13 / 20,
      currentLine: 13,
      totalLines: 20,
      /* Slice state mirrors what applyGenerationTick produces after the fix:
         narrator is the active speaker, everyone who's spoken before is
         back at 'queued'. Pre-fix they'd all have been 'done' here. */
      characters: {
        narrator: 'in_progress',
        keefe:    'queued',
        ro:       'queued',
        elwin:    'queued',
      },
    };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([liveChapter]));
    store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
      bookId: 'b1', characters: cast, chapters: [liveChapter], sentences: dayOne,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    return render(
      <Provider store={store}>
        <GenerationView
          chapters={[liveChapter]}
          characters={cast}
          paused
          title="Bonus Keefe Story"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          setPaused={() => {}}
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  it('shows the active speaker as Generating with their real X/Y count, not a full-green Done bar', () => {
    renderScenario();
    fireEvent.click(screen.getByText('DAY ONE'));
    /* Narrator owns 11 of 20 lines (positions 1, 2, 4, 6, 8, 9, 10, 11, 12,
       13, 20); at currentLine=13 they've sung 10 of those 11. The label
       should reflect that, not "Done". */
    expect(screen.getByText('10/11')).toBeInTheDocument();
  });

  it('shows partial progress for non-active speakers with lines still ahead, not a false "Done"', () => {
    renderScenario();
    fireEvent.click(screen.getByText('DAY ONE'));
    /* Keefe: positions [3, 14, 17] → 1 of 3 done by line 13. */
    expect(screen.getByText('1/3 done')).toBeInTheDocument();
    /* Ro: positions [5, 16] → 1 of 2 done. */
    expect(screen.getByText('1/2 done')).toBeInTheDocument();
    /* Elwin: positions [7, 15, 18, 19] → 1 of 4 done. */
    expect(screen.getByText('1/4 done')).toBeInTheDocument();
    /* The lie was the full-green "Done" bar for any of these three. */
    expect(screen.queryByText(/^Done$/)).not.toBeInTheDocument();
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
          onRegenerateBook={() => {}}
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
          onRegenerateBook={() => {}}
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

describe('GenerationView — header action once the run is complete', () => {
  /* Regression for "Resume" sticking around at 7/7 100 %. When every chapter
     is `done`, Pause/Resume has nothing to act on — the button flips to a
     Regenerate entry-point that opens the existing modal. */
  it('replaces Pause/Resume with a book-level Regenerate when every chapter is done', () => {
    const allDone1: Chapter = { ...chapter1 };
    const allDone2: Chapter = { ...chapter2, state: 'done', progress: 1, duration: '00:42', characters: { narrator: 'done', keefe: 'done' } };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([allDone1, allDone2]));
    store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
      bookId: 'b1', characters, chapters: [allDone1, allDone2], sentences,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));

    const onRegenerateBook = vi.fn();
    render(
      <Provider store={store}>
        <GenerationView
          chapters={[allDone1, allDone2]}
          characters={characters}
          paused={false}
          title="Bonus Keefe Story"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          setPaused={() => {}}
          onRegenerate={() => {}}
          onRegenerateBook={onRegenerateBook}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    expect(screen.queryByRole('button', { name: /Pause|Resume/ })).not.toBeInTheDocument();
    const regen = screen.getByRole('button', { name: /^Regenerate$/ });
    fireEvent.click(regen);
    /* The view never picks a "current" chapter from a fully-drained queue — it
       delegates to the route, which opens the modal at chapter 1 with
       scope='forward'. The view's contract is to fire the book-level callback. */
    expect(onRegenerateBook).toHaveBeenCalledTimes(1);
  });

  it('keeps Pause/Resume while any chapter is still queued or in progress', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
    store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
      bookId: 'b1', characters, chapters: [chapter1, chapter2], sentences,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));

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
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    expect(screen.getByRole('button', { name: /Resume/ })).toBeInTheDocument();
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
