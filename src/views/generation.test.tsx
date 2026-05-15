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
const unloadAnalyzerSpy = vi.fn();
const loadSidecarSpy = vi.fn();
const unloadSidecarSpy = vi.fn();
const getOllamaHealthSpy = vi.fn();
const getSidecarHealthSpy = vi.fn();

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
    getSidecarHealth: () => getSidecarHealthSpy(),
    /* The Generate-screen Load TTS button checks analyzer health to decide
       whether to surface the auto-evict banner — wire a controllable stub
       so each test can simulate "analyzer loaded" vs "nothing to evict". */
    getOllamaHealth:  () => getOllamaHealthSpy(),
    loadSidecar:      () => loadSidecarSpy(),
    unloadSidecar:    () => unloadSidecarSpy(),
    loadAnalyzer:     () => Promise.resolve({ status: 'ready' }),
    unloadAnalyzer:   () => { unloadAnalyzerSpy(); return Promise.resolve({ status: 'unloaded' }); },
  },
}));

beforeEach(() => {
  unloadAnalyzerSpy.mockReset();
  loadSidecarSpy.mockReset();
  unloadSidecarSpy.mockReset();
  getOllamaHealthSpy.mockReset();
  getSidecarHealthSpy.mockReset();
  getOllamaHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', models: [], resident: [], modelResident: false });
  getSidecarHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: false });
  loadSidecarSpy.mockResolvedValue({ status: 'ready' });
  unloadSidecarSpy.mockResolvedValue({ status: 'idle' });
});

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  { id: 'Marlow',    name: 'Marlow',    role: 'Empath',   color: 'peach' },
];

const sentences: Sentence[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A long room.' },                    // 3 words
  { id: 2, chapterId: 1, characterId: 'Marlow',    text: 'Hello there friend!' },             // 3 words
  { id: 3, chapterId: 1, characterId: 'Marlow',    text: 'How are you today on this fine evening?' }, // 8 words
  { id: 4, chapterId: 2, characterId: 'narrator', text: 'Elsewhere entirely.' },             // 2 words
];

const chapter1: Chapter = {
  id: 1,
  title: 'Chapter 1',
  duration: '00:49',
  state: 'done',
  progress: 1,
  characters: { narrator: 'done', Marlow: 'done' },
};
const chapter2: Chapter = {
  id: 2,
  title: 'Chapter 2',
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued', Marlow: 'queued' },
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
        title="the Coalfall Commission"
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
    /* Chapter 1: 1 narrator sentence (3 words) + 2 Marlow sentences (3 + 8 = 11 words)
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
    expect(screen.getByText(/2 lines · 11 words/)).toBeInTheDocument(); // Marlow in ch 1
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

describe('GenerationView — counters exclude ignored chapters (regression)', () => {
  /* Pre-fix the header counter and the "lines synthesised" sub-counter
     used `chapters.length` / iterated all chapters, so an excluded
     chapter inflated the denominator. An 8-of-10-done book with 2
     excluded chapters would have shown "8 of 10" forever and never
     reached the all-complete state visible in the header copy. */
  it('reports counters using only non-excluded chapters', () => {
    const ch1Done: Chapter = { ...chapter1 };
    const ch2Queued: Chapter = { ...chapter2 };
    const ch3Excluded: Chapter = {
      id: 3,
      title: 'Chapter 3',
      duration: '00:00',
      state: 'queued',
      progress: 0,
      excluded: true,
      characters: { narrator: 'queued' },
    };
    /* Chapter 3 contributes 2 manuscript sentences; pre-fix those lines
       would have leaked into the "lines synthesised" denominator. */
    const ch3Sentences: Sentence[] = [
      { id: 100, chapterId: 3, characterId: 'narrator', text: 'excluded one.' },
      { id: 101, chapterId: 3, characterId: 'narrator', text: 'excluded two.' },
    ];
    const store = configureStore({
      reducer: {
        ui:         uiSlice.reducer,
        chapters:   chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog:  changeLogSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([ch1Done, ch2Queued, ch3Excluded]));
    store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
      bookId: 'b1',
      characters,
      chapters: [ch1Done, ch2Queued, ch3Excluded],
      sentences: [...sentences, ...ch3Sentences],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any));
    render(
      <Provider store={store}>
        <GenerationView
          chapters={[ch1Done, ch2Queued, ch3Excluded]}
          characters={characters}
          paused
          title="the Coalfall Commission"
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

    /* 1 of the 2 active chapters is done. Pre-fix: "1 of 3". */
    expect(screen.getByText(/1 of 2 chapters complete/)).toBeInTheDocument();
    /* Manuscript-derived lines: ch1=3 sentences (done → all 3 sung),
       ch2=1 sentence (queued → 0 sung), ch3 excluded → not counted.
       Pre-fix denominator would have been 6 (3+1+2). The "done" number
       lives in its own <span>, so match the surrounding text only and
       inspect the paragraph for the complete readout. */
    const linesNode = screen.getByText(/of 4 lines synthesised/);
    expect(linesNode.textContent).toMatch(/3\s+of 4 lines synthesised/);
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
      characters: { narrator: 'in_progress', Marlow: 'queued' },
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
          title="the Coalfall Commission"
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
    { id: 'Marlow',    name: 'Marlow',    role: 'Empath',   color: 'peach' },
    { id: 'ro',       name: 'Ro',       role: 'Goblin',   color: 'magenta' },
    { id: 'Oduvan',    name: 'Oduvan',    role: 'Physician', color: 'violet' },
  ];

  /* Day-One-shaped chapter: narrator dominates, the other three each speak
     once before line 13 AND have lines still to come after it — so at
     currentLine=13 Marlow/ro/Oduvan should each show fractional progress,
     not "Done". Pre-fix the slice would have marked all three "done" the
     moment the next speaker took over. */
  const dayOne: Sentence[] = [
    { id: 1,  chapterId: 2, characterId: 'narrator', text: 'open' },
    { id: 2,  chapterId: 2, characterId: 'narrator', text: 'b' },
    { id: 3,  chapterId: 2, characterId: 'Marlow',    text: 'k1' },
    { id: 4,  chapterId: 2, characterId: 'narrator', text: 'c' },
    { id: 5,  chapterId: 2, characterId: 'ro',       text: 'r1' },
    { id: 6,  chapterId: 2, characterId: 'narrator', text: 'd' },
    { id: 7,  chapterId: 2, characterId: 'Oduvan',    text: 'e1' },
    { id: 8,  chapterId: 2, characterId: 'narrator', text: 'e' },
    { id: 9,  chapterId: 2, characterId: 'narrator', text: 'f' },
    { id: 10, chapterId: 2, characterId: 'narrator', text: 'g' },
    { id: 11, chapterId: 2, characterId: 'narrator', text: 'h' },
    { id: 12, chapterId: 2, characterId: 'narrator', text: 'i' },
    { id: 13, chapterId: 2, characterId: 'narrator', text: 'j (current)' },
    /* Each non-narrator has at least one line still ahead of line 13 so
       they appear as partial progress, not "Done". */
    { id: 14, chapterId: 2, characterId: 'Marlow',    text: 'k2' },
    { id: 15, chapterId: 2, characterId: 'Oduvan',    text: 'e2' },
    { id: 16, chapterId: 2, characterId: 'ro',       text: 'r2' },
    { id: 17, chapterId: 2, characterId: 'Marlow',    text: 'k3' },
    { id: 18, chapterId: 2, characterId: 'Oduvan',    text: 'e3' },
    { id: 19, chapterId: 2, characterId: 'Oduvan',    text: 'e4' },
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
        Marlow:    'queued',
        ro:       'queued',
        Oduvan:    'queued',
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
          title="the Coalfall Commission"
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
    /* Marlow: positions [3, 14, 17] → 1 of 3 done by line 13. */
    expect(screen.getByText('1/3 done')).toBeInTheDocument();
    /* Ro: positions [5, 16] → 1 of 2 done. */
    expect(screen.getByText('1/2 done')).toBeInTheDocument();
    /* Oduvan: positions [7, 15, 18, 19] → 1 of 4 done. */
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
      characters: { narrator: 'in_progress', Marlow: 'queued' },
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
          title="the Coalfall Commission"
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
          title="the Coalfall Commission"
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
    const allDone2: Chapter = { ...chapter2, state: 'done', progress: 1, duration: '00:42', characters: { narrator: 'done', Marlow: 'done' } };
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
          title="the Coalfall Commission"
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
          title="the Coalfall Commission"
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
    /* Middleware skips opens unless a book is in scope AND the chapters
       slice has claimed that book via setCurrentBookId (cross-book guard
       requires the pair to agree before reconcile opens or closes). */
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'generating' }));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
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

describe('GenerationView — TTS Load button auto-evicts the analyzer', () => {
  /* This is the headline UX guarantee of the button-driven model lifecycle:
     loading TTS frees VRAM from the analyzer first, with a banner so the
     user knows the swap happened. Without it, on an 8 GB GPU the analyzer
     (qwen3.5:4b ~3 GB) + XTTS (~3 GB) + headroom would OOM. */

  async function findLoadTtsButton() {
    /* Initial /api/sidecar/health probe runs on mount; once it resolves
       to modelLoaded:false the pill flips from "loading" to "idle" and
       the button label becomes "Load model". */
    return screen.findByRole('button', { name: /load model \(tts model\)/i });
  }

  it('calls unloadAnalyzer before loadSidecar and surfaces the eviction banner when the analyzer was loaded', async () => {
    /* modelResident is the truth: pulled-but-not-resident shouldn't fire
       the banner. /api/ps says qwen3.5:4b is in VRAM right now. */
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable', url: '(test)',
      models: ['qwen3.5:4b'], expectedModel: 'qwen3.5:4b', modelPulled: true,
      resident: ['qwen3.5:4b'], modelResident: true,
    });

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    /* unloadAnalyzer must run before loadSidecar — otherwise both models
       briefly share VRAM and the GPU OOMs on a tight box. */
    await new Promise(r => setTimeout(r, 0));
    expect(unloadAnalyzerSpy).toHaveBeenCalled();
    expect(loadSidecarSpy).toHaveBeenCalled();
    expect(unloadAnalyzerSpy.mock.invocationCallOrder[0])
      .toBeLessThan(loadSidecarSpy.mock.invocationCallOrder[0]);

    expect(await screen.findByText(/Analyzer unloaded to free VRAM/i)).toBeInTheDocument();
  });

  it('does not surface the banner when the analyzer had no model loaded', async () => {
    /* Pulled-but-not-resident is the case that the OLD check (`models.length > 0`)
       got wrong — it fired the banner for a model that was never warmed.
       modelResident:false guards against that lie. */
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable', url: '(test)',
      models: ['qwen3.5:4b'], expectedModel: 'qwen3.5:4b', modelPulled: true,
      resident: [], modelResident: false,
    });

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    await new Promise(r => setTimeout(r, 0));
    expect(loadSidecarSpy).toHaveBeenCalled();
    expect(screen.queryByText(/Analyzer unloaded to free VRAM/i)).not.toBeInTheDocument();
  });

  it('calls unloadSidecar when the user clicks Stop', async () => {
    getSidecarHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: true });

    renderView();
    /* Pill state should be "ready" → button reads "Stop". */
    const stopBtn = await screen.findByRole('button', { name: /stop \(tts model\)/i });
    fireEvent.click(stopBtn);

    await new Promise(r => setTimeout(r, 0));
    expect(unloadSidecarSpy).toHaveBeenCalledTimes(1);
  });

  /* Regression: before the fix, /api/sidecar/load returning a 5xx body
     with {status:'error', error:'…'} (e.g. weights missing, DeepSpeed init
     crash, 90s timeout) was silently discarded. The pill flipped back to
     "Load model" on the next /health probe and the user had no clue
     anything had failed. Surface the daemon's error string instead. */
  it('surfaces the error message when loadSidecar resolves with status:error', async () => {
    loadSidecarSpy.mockResolvedValue({
      status: 'error',
      error: 'Sidecar /load returned 500: weights missing',
    });

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Sidecar \/load returned 500: weights missing/i,
    );
  });

  it('surfaces a fetch failure when loadSidecar throws', async () => {
    loadSidecarSpy.mockRejectedValue(new Error('Failed to fetch'));

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn't reach the sidecar/i);
  });
});
