// Pairs with docs/features/archive/16-generation-stream.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { MemoryRouter, Outlet, Routes, Route } from 'react-router-dom';
import { chaptersSlice } from '../store/chapters-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { castSlice } from '../store/cast-slice';
import { librarySlice } from '../store/library-slice';
import { accountSlice } from '../store/account-slice';
import { queueSlice } from '../store/queue-slice';
import { GenerationView } from './generation';
import { useTtsLifecycle } from '../lib/use-tts-lifecycle';
import type { LayoutContext } from '../components/layout';
import type { Chapter, Character, Sentence } from '../lib/types';
import type { ComponentProps } from 'react';

/* After plan 30 G1, GenerationView reads its TTS pill state from a
   Layout-owned `useTtsLifecycle()` via outlet context. The test harness
   invokes the hook itself so existing assertions against `loadSidecar` /
   `unloadAnalyzer` / `getSidecarHealth` keep firing through the hook the
   way they did when the state lived inline on the view. */
function HostedGenerationView(props: ComponentProps<typeof GenerationView>) {
  return (
    <MemoryRouter>
      <Routes>
        <Route element={<HostedOutlet />}>
          <Route path="*" element={<UnwrappedGenerationView {...props} />} />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
/* Aliased so the JSX `<GenerationView>` swap in this file's test renders
   doesn't accidentally recurse on the host above. */
const UnwrappedGenerationView = GenerationView;
function HostedOutlet() {
  const ttsLifecycle = useTtsLifecycle();
  const ctx: LayoutContext = {
    showInfo: vi.fn(),
    showError: vi.fn(),
    pushToast: vi.fn(),
    ttsLifecycle,
    priorRoster: [],
    openFixCharacterAudio: vi.fn(),
  };
  return <Outlet context={ctx} />;
}

const streamGenerationMock = vi.fn();
const unloadAnalyzerSpy = vi.fn();
const loadSidecarSpy = vi.fn();
const unloadSidecarSpy = vi.fn();
const getOllamaHealthSpy = vi.fn();
const getSidecarHealthSpy = vi.fn();
const setChapterExcludedSpy = vi.fn();
const runAnalysisForChaptersSpy = vi.fn();

vi.mock('../lib/api', () => ({
  /* Never-resolving so the ChapterSegmentStrip useEffect doesn't flush a
     setError state update outside React's `act` after the test asserts. */
  api: {
    streamGeneration: (args: unknown) => {
      streamGenerationMock(args);
      return () => {};
    },
    getChapterAudio: () => new Promise(() => {}),
    /* Sidecar status pill polls this on mount. Resolve with a happy status
       so the pill renders the green variant without spamming console
       warnings during the test render. */
    getSidecarHealth: () => getSidecarHealthSpy(),
    /* useTtsLifecycle also polls /api/gpu/queue on the same tick.
       Stub to an empty queue so the "GPU busy · N waiting ·" pill prefix
       stays hidden in these tests. */
    getGpuQueueState: () => Promise.resolve({ depth: 0, inFlight: 0, max: 1 }),
    /* The Generate-screen Load TTS button checks analyzer health to decide
       whether to surface the auto-evict banner — wire a controllable stub
       so each test can simulate "analyzer loaded" vs "nothing to evict". */
    getOllamaHealth: () => getOllamaHealthSpy(),
    loadSidecar: () => loadSidecarSpy(),
    unloadSidecar: () => unloadSidecarSpy(),
    loadAnalyzer: () => Promise.resolve({ status: 'ready' }),
    unloadAnalyzer: () => {
      unloadAnalyzerSpy();
      return Promise.resolve({ status: 'unloaded' });
    },
    /* Drives the Include-in-book toggle. The handler always flips the
       flag first, then runs subset analysis on the un-exclude path. */
    setChapterExcluded: (bookId: string, chapterId: number, excluded: boolean) =>
      setChapterExcludedSpy(bookId, chapterId, excluded),
    runAnalysisForChapters: (
      manuscriptId: string,
      chapterIds: number[],
      opts?: Record<string, unknown>,
    ) => runAnalysisForChaptersSpy(manuscriptId, chapterIds, opts),
  },
  /* Stub class so `instanceof AnalysisError` checks in production code
     don't throw "Right-hand side of instanceof is not callable". */
  AnalysisError: class AnalysisError extends Error {
    code: string;
    detail?: string;
    constructor(message: string, code = 'unknown', detail?: string) {
      super(message);
      this.code = code;
      this.detail = detail;
    }
  },
}));

beforeEach(() => {
  unloadAnalyzerSpy.mockReset();
  loadSidecarSpy.mockReset();
  unloadSidecarSpy.mockReset();
  getOllamaHealthSpy.mockReset();
  getSidecarHealthSpy.mockReset();
  setChapterExcludedSpy.mockReset();
  runAnalysisForChaptersSpy.mockReset();
  getOllamaHealthSpy.mockResolvedValue({
    status: 'reachable',
    url: '(test)',
    models: [],
    resident: [],
    modelResident: false,
  });
  getSidecarHealthSpy.mockResolvedValue({ status: 'reachable', url: '(test)', modelLoaded: false });
  loadSidecarSpy.mockResolvedValue({ status: 'ready' });
  unloadSidecarSpy.mockResolvedValue({ status: 'idle' });
  /* Default: setChapterExcluded resolves trivially and
     runAnalysisForChapters never resolves so tests that don't exercise
     the include path don't spuriously dispatch the merge actions. Tests
     that need a real flow override these in the body. */
  setChapterExcludedSpy.mockResolvedValue({ id: 0, title: '', slug: '', excluded: false });
  runAnalysisForChaptersSpy.mockReturnValue(new Promise(() => {}));
});

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  { id: 'Marlow', name: 'Marlow', role: 'Empath', color: 'peach' },
];

const sentences: Sentence[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A long room.' }, // 3 words
  { id: 2, chapterId: 1, characterId: 'Marlow', text: 'Hello there friend!' }, // 3 words
  { id: 3, chapterId: 1, characterId: 'Marlow', text: 'How are you today on this fine evening?' }, // 8 words
  { id: 4, chapterId: 2, characterId: 'narrator', text: 'Elsewhere entirely.' }, // 2 words
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
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      cast: castSlice.reducer,
      library: librarySlice.reducer,
      queue: queueSlice.reducer,
      /* Account slice powers the engines-in-use selector that determines
         which engine pill(s) render in the Generate header. Defaults to
         the same Coqui modelKey the view receives so the existing button-
         routing assertions ("Load model (tts model)") still find the pill. */
      account: accountSlice.reducer,
    },
  });
  store.dispatch(accountSlice.actions.setDefaultTtsModelKey('coqui-xtts-v2'));
  store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
  store.dispatch(
    manuscriptSlice.actions.hydrateFromAnalysis({
      bookId: 'b1',
      characters,
      chapters: [chapter1, chapter2],
      sentences,
    } as any),
  );
  return store;
}

function renderView() {
  const store = makeStore();
  return render(
    <Provider store={store}>
      <HostedGenerationView
        chapters={[chapter1, chapter2]}
        characters={characters}
        paused
        title="the Coalfall Commission"
        bookId="b1"
        modelKey="coqui-xtts-v2"
        onRegenerate={() => {}}
        onRegenerateBook={() => {}}
        onRegenerateCharacterInChapter={() => {}}
        onPreview={() => {}}
      />
    </Provider>,
  );
}

describe('GenerationView — chapter & character metadata (regression for screenshot bug)', () => {
  beforeEach(() => {
    /* paused=true so the streamGeneration effect short-circuits */
  });

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
    expect(screen.getByText(/1 line · 3 words/)).toBeInTheDocument(); // narrator in ch 1
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
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([ch1Done, ch2Queued, ch3Excluded]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [ch1Done, ch2Queued, ch3Excluded],
        sentences: [...sentences, ...ch3Sentences],
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[ch1Done, ch2Queued, ch3Excluded]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
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

  it('shows "Verifying speech…" on a chapter in the ASR verifying phase', () => {
    const verifying: Chapter = {
      ...chapter1,
      state: 'in_progress',
      phase: 'verifying',
      progress: 0.99,
    };
    const ch2Queued: Chapter = { ...chapter2 };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([verifying, ch2Queued]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [verifying, ch2Queued],
        sentences,
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[verifying, ch2Queued]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    // Rendered in BOTH the row pill and the live caption.
    expect(screen.getAllByText('Verifying speech…')).toHaveLength(2);
    // The frozen synthesising caption must NOT show for the verifying row.
    expect(screen.queryByText(/Synthesising/)).not.toBeInTheDocument();
  });

  it('shows the recovering caption on a chapter in the recovering phase', () => {
    const recovering: Chapter = {
      ...chapter1,
      state: 'in_progress',
      phase: 'recovering',
      progress: 0.9,
    };
    const ch2Queued: Chapter = { ...chapter2 };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([recovering, ch2Queued]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [recovering, ch2Queued],
        sentences,
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[recovering, ch2Queued]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    expect(screen.getByText('Recovering — restarting TTS engine…')).toBeInTheDocument();
    // The frozen synthesising caption must NOT show for the recovering row.
    expect(screen.queryByText(/Synthesising/)).not.toBeInTheDocument();
  });

  it('suppresses the stale "Active:" line when a chapter is in the verifying phase', () => {
    const verifying: Chapter = {
      ...chapter1,
      state: 'in_progress',
      phase: 'verifying',
      progress: 0.99,
    };
    const ch2Queued: Chapter = { ...chapter2 };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([verifying, ch2Queued]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [verifying, ch2Queued],
        sentences,
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[verifying, ch2Queued]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    // Expand the verifying chapter row (its title is "Chapter 1").
    fireEvent.click(screen.getByText('Chapter 1'));
    expect(screen.queryByText(/Active:/)).not.toBeInTheDocument();
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
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([live]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [live],
        sentences,
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[live]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
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
    const stray = Array.from(card!.querySelectorAll('*')).filter(
      (el) => el.children.length === 0 && el.textContent === '0',
    );
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
    { id: 'Marlow', name: 'Marlow', role: 'Empath', color: 'peach' },
    { id: 'ro', name: 'Ro', role: 'Goblin', color: 'magenta' },
    { id: 'Oduvan', name: 'Oduvan', role: 'Physician', color: 'violet' },
  ];

  /* Day-One-shaped chapter: narrator dominates, the other three each speak
     once before line 13 AND have lines still to come after it — so at
     currentLine=13 Marlow/ro/Oduvan should each show fractional progress,
     not "Done". Pre-fix the slice would have marked all three "done" the
     moment the next speaker took over. */
  const dayOne: Sentence[] = [
    { id: 1, chapterId: 2, characterId: 'narrator', text: 'open' },
    { id: 2, chapterId: 2, characterId: 'narrator', text: 'b' },
    { id: 3, chapterId: 2, characterId: 'Marlow', text: 'k1' },
    { id: 4, chapterId: 2, characterId: 'narrator', text: 'c' },
    { id: 5, chapterId: 2, characterId: 'ro', text: 'r1' },
    { id: 6, chapterId: 2, characterId: 'narrator', text: 'd' },
    { id: 7, chapterId: 2, characterId: 'Oduvan', text: 'e1' },
    { id: 8, chapterId: 2, characterId: 'narrator', text: 'e' },
    { id: 9, chapterId: 2, characterId: 'narrator', text: 'f' },
    { id: 10, chapterId: 2, characterId: 'narrator', text: 'g' },
    { id: 11, chapterId: 2, characterId: 'narrator', text: 'h' },
    { id: 12, chapterId: 2, characterId: 'narrator', text: 'i' },
    { id: 13, chapterId: 2, characterId: 'narrator', text: 'j (current)' },
    /* Each non-narrator has at least one line still ahead of line 13 so
       they appear as partial progress, not "Done". */
    { id: 14, chapterId: 2, characterId: 'Marlow', text: 'k2' },
    { id: 15, chapterId: 2, characterId: 'Oduvan', text: 'e2' },
    { id: 16, chapterId: 2, characterId: 'ro', text: 'r2' },
    { id: 17, chapterId: 2, characterId: 'Marlow', text: 'k3' },
    { id: 18, chapterId: 2, characterId: 'Oduvan', text: 'e3' },
    { id: 19, chapterId: 2, characterId: 'Oduvan', text: 'e4' },
    { id: 20, chapterId: 2, characterId: 'narrator', text: 'closer' },
  ];

  function renderScenario(characterStatuses?: Chapter['characters']) {
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
      characters: characterStatuses ?? {
        narrator: 'in_progress',
        Marlow: 'queued',
        ro: 'queued',
        Oduvan: 'queued',
      },
    };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([liveChapter]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters: cast,
        chapters: [liveChapter],
        sentences: dayOne,
      } as any),
    );
    return render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[liveChapter]}
          characters={cast}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
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

  it('resets per-character rows when regenerating, ignoring stale "done" statuses', () => {
    /* Regenerate-of-a-rendered-chapter case: a hydrate re-seeded every cast
       member as 'done' from the on-disk audio, and applyGenerationTick has so
       far only un-done'd the live narrator. The rows must still derive from
       currentLine=13 + positions, not the stale 'done' — Marlow/ro/Oduvan show
       fractional progress, never a full-green "Done". */
    renderScenario({ narrator: 'in_progress', Marlow: 'done', ro: 'done', Oduvan: 'done' });
    fireEvent.click(screen.getByText('DAY ONE'));
    expect(screen.getByText('1/3 done')).toBeInTheDocument();
    expect(screen.getByText('1/2 done')).toBeInTheDocument();
    expect(screen.getByText('1/4 done')).toBeInTheDocument();
    /* No row may render the bare "Done" label while the chapter is mid-regen. */
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
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([live]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [live],
        sentences,
      } as any),
    );
    /* Drive a real progress tick so the slice writes lastTickAt = Date.now()
       at the anchored instant. Then advance the clock by 60s and render —
       the view computes `stalled = Date.now() - lastTickAt > 30_000`. */
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'progress',
        chapterId: 1,
        characterId: 'narrator',
        progress: 0.5,
        currentLine: 50,
        totalLines: 100,
      } as any),
    );
    vi.setSystemTime(new Date('2026-05-13T15:01:00Z'));

    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[live]}
          characters={characters}
          paused={false}
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    /* The stalled banner copy is the load-bearing assertion — it's what
       answers "is it failed miserably or doing something?". The body now sets
       the expectation that batched synthesis (plan 112) can run a while between
       updates, so the user doesn't read a long batch as a hang. */
    expect(screen.getByText(/Worker has gone quiet/)).toBeInTheDocument();
    expect(screen.getByText(/synthesising a batch of lines/)).toBeInTheDocument();
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
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
    /* Replace the default seed with a single system event so the assertion
       is unambiguous. */
    store.dispatch(
      changeLogSlice.actions.hydrateFromBookState([
        {
          id: 1,
          at: new Date().toISOString(),
          ts: 'Just now',
          date: 'today',
          type: 'chapter_complete',
          title: 'Chapter 1 complete',
          note: 'Finished synthesising "Chapter 1".',
          actor: 'system',
          chapterId: 1,
        },
      ]),
    );

    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[chapter1, chapter2]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
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
    const allDone2: Chapter = {
      ...chapter2,
      state: 'done',
      progress: 1,
      duration: '00:42',
      characters: { narrator: 'done', Marlow: 'done' },
    };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([allDone1, allDone2]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [allDone1, allDone2],
        sentences,
      } as any),
    );

    const onRegenerateBook = vi.fn();
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[allDone1, allDone2]}
          characters={characters}
          paused={false}
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
          onRegenerateBook={onRegenerateBook}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    /* The old per-book Pause/Resume TOGGLE (plan 102 moved queue-global pause
       to the queue modal) must stay gone — match the EXACT label so fe-17's
       separate "Resume generation" enqueue button doesn't trip this guard. */
    expect(screen.queryByRole('button', { name: /^(Pause|Resume)$/ })).not.toBeInTheDocument();
    const regen = screen.getByRole('button', { name: /^Regenerate$/ });
    fireEvent.click(regen);
    /* The view never picks a "current" chapter from a fully-drained queue — it
       delegates to the route, which opens the modal at chapter 1 with
       scope='forward'. The view's contract is to fire the book-level callback. */
    expect(onRegenerateBook).toHaveBeenCalledTimes(1);
  });

  it('renders the View queue CTA in the header while work is queued (plan 102)', () => {
    /* Wave 4a moved Pause/Resume out of the Generate view into the queue
       modal — what used to be the Pause/Resume slot is now occupied by a
       "View queue" button that opens the modal. The book-level Regenerate
       still shows up when allComplete is true (separate test above). */
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [chapter1, chapter2],
        sentences,
      } as any),
    );

    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[chapter1, chapter2]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );

    /* The old per-book Pause/Resume TOGGLE (plan 102 moved queue-global pause
       to the queue modal) must stay gone — match the EXACT label so fe-17's
       separate "Resume generation" enqueue button doesn't trip this guard. */
    expect(screen.queryByRole('button', { name: /^(Pause|Resume)$/ })).not.toBeInTheDocument();
    expect(screen.getByTestId('generation-view-queue')).toBeInTheDocument();
  });
});

/* Plan 102 Wave 4a — the "Reverse local-analyzer guard on Resume" suite
   that used to live here covered the per-view Resume button which is now
   in the queue modal. Wave 4b adds the equivalent guard test to the
   QueueModal pause/resume control where the affordance lives now. */

/* (plan 111 wave 3) The "regenerateChapter opens the SSE with a spec" path no
   longer lives in the middleware — regen now enqueues and the queue dispatcher
   is the sole stream-opener. That behaviour + the Pause/Resume no-replay
   regression are covered by queue-dispatcher-middleware.test.ts (same-book
   open, no double-claim, no-loop) and generation-stream-runner.test.ts. */

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

  it('calls unloadAnalyzer before loadSidecar when the analyzer was loaded', async () => {
    /* modelResident is the truth: pulled-but-not-resident shouldn't fire
       the banner. /api/ps says qwen3.5:4b is in VRAM right now. */
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: ['qwen3.5:4b'],
      modelResident: true,
    });

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    /* unloadAnalyzer must run before loadSidecar — otherwise both models
       briefly share VRAM and the GPU OOMs on a tight box. */
    await new Promise((r) => setTimeout(r, 0));
    expect(unloadAnalyzerSpy).toHaveBeenCalled();
    expect(loadSidecarSpy).toHaveBeenCalled();
    expect(unloadAnalyzerSpy.mock.invocationCallOrder[0]).toBeLessThan(
      loadSidecarSpy.mock.invocationCallOrder[0],
    );
    /* The "Analyzer unloaded to free VRAM" banner itself now renders globally
       under the top bar via <TtsNoticeBanner> (layout.tsx), not in this view —
       its render is covered by tts-notice-banner.test.tsx and the eviction
       state by use-tts-lifecycle.test.ts. */
  });

  it('does not surface the banner when the analyzer had no model loaded', async () => {
    /* Pulled-but-not-resident is the case that the OLD check (`models.length > 0`)
       got wrong — it fired the banner for a model that was never warmed.
       modelResident:false guards against that lie. */
    getOllamaHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      models: ['qwen3.5:4b'],
      expectedModel: 'qwen3.5:4b',
      modelPulled: true,
      resident: [],
      modelResident: false,
    });

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    await new Promise((r) => setTimeout(r, 0));
    expect(loadSidecarSpy).toHaveBeenCalled();
    expect(screen.queryByText(/Analyzer unloaded to free VRAM/i)).not.toBeInTheDocument();
  });

  it('calls unloadSidecar when the user clicks Stop', async () => {
    getSidecarHealthSpy.mockResolvedValue({
      status: 'reachable',
      url: '(test)',
      modelLoaded: true,
    });

    renderView();
    /* Pill state should be "ready" → button reads "Stop". */
    const stopBtn = await screen.findByRole('button', { name: /stop \(tts model\)/i });
    fireEvent.click(stopBtn);

    await new Promise((r) => setTimeout(r, 0));
    expect(unloadSidecarSpy).toHaveBeenCalledTimes(1);
  });

  /* Regression: a /load error (5xx {status:'error', error:'…'} — weights
     missing, DeepSpeed init crash, 90s timeout — or a fetch throw) used to be
     silently discarded; the pill flipped back to "Load model" with no signal.
     The fix surfaces the daemon's error string. The error STRING now renders
     in the GLOBAL <TtsNoticeBanner> (layout.tsx) — its render is pinned by
     tts-notice-banner.test.tsx and the loadErrorNotice STATE by
     use-tts-lifecycle.test.ts. From this view (rendered without the layout)
     we assert the click attempts the load and the pill doesn't WEDGE in
     "loading" — it reverts to the idle "Load model". */
  it('attempts the load and reverts the pill to idle when loadSidecar resolves with status:error', async () => {
    loadSidecarSpy.mockResolvedValue({
      status: 'error',
      error: 'Sidecar /load returned 500: weights missing',
    });

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    /* Pill must not wedge in "loading" — it returns to "Load model" once the
       error lands (by which point loadSidecar has resolved). */
    expect(await findLoadTtsButton()).toBeInTheDocument();
    expect(loadSidecarSpy).toHaveBeenCalled();
  });

  it('attempts the load and reverts the pill to idle when loadSidecar throws', async () => {
    loadSidecarSpy.mockRejectedValue(new Error('Failed to fetch'));

    renderView();
    const loadBtn = await findLoadTtsButton();
    fireEvent.click(loadBtn);

    expect(await findLoadTtsButton()).toBeInTheDocument();
    expect(loadSidecarSpy).toHaveBeenCalled();
  });
});

describe('GenerationView — engine drift detection (plan 35)', () => {
  /* When a chapter's recorded `audioModelKey` differs from the project's
     current `modelKey`, the row surfaces a drift caption and the view
     summarises across all chapters with a top-of-view banner. Drift is
     symmetric — switching engines exposes whichever side is now stale. */

  function renderWithChapters(chapters: Chapter[], modelKey: 'coqui-xtts-v2' | 'kokoro-v1'): void {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters(chapters));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters,
        sentences,
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={chapters}
          characters={characters}
          paused
          title="Drift Fixture"
          bookId="b1"
          modelKey={modelKey}          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  it('no banner and no row caption when every done chapter matches the active engine', () => {
    const ch1: Chapter = {
      ...chapter1,
      audioModelKey: 'kokoro-v1',
    };
    renderWithChapters([ch1, chapter2], 'kokoro-v1');
    /* Banner copy is unique to the drift surface — its absence here is
       the load-bearing assertion. */
    expect(screen.queryByText(/generated with a different engine/i)).toBeNull();
    expect(screen.queryByText(/Generated with .* · current engine is/i)).toBeNull();
  });

  it("surfaces a per-row drift caption when a done chapter's audioModelKey differs from the active engine", () => {
    const drifted: Chapter = {
      ...chapter1,
      audioModelKey: 'coqui-xtts-v2',
    };
    renderWithChapters([drifted, chapter2], 'kokoro-v1');
    expect(
      screen.getByText(/Generated with Coqui XTTS v2 · current engine is Kokoro v1/i),
    ).toBeTruthy();
  });

  it('top-of-view banner counts every drifted done chapter', () => {
    const drifted1: Chapter = { ...chapter1, audioModelKey: 'coqui-xtts-v2' };
    const drifted2: Chapter = {
      id: 3,
      title: 'Chapter 3',
      duration: '01:23',
      state: 'done',
      progress: 1,
      characters: { narrator: 'done' },
      audioModelKey: 'coqui-xtts-v2',
    };
    renderWithChapters([drifted1, drifted2, chapter2], 'kokoro-v1');
    /* Singular vs plural copy: assert the plural form fires for 2. */
    expect(screen.getByText(/2 chapters generated with a different engine/i)).toBeTruthy();
  });

  it('banner uses singular copy when only one chapter has drifted', () => {
    const drifted: Chapter = { ...chapter1, audioModelKey: 'coqui-xtts-v2' };
    renderWithChapters([drifted, chapter2], 'kokoro-v1');
    expect(screen.getByText(/1 chapter generated with a different engine/i)).toBeTruthy();
  });

  it('shows a per-engine voice-count caption (not a drift warning) for a mixed-engine chapter', () => {
    /* False-drift fix: a chapter whose voices span engines (narrator on
       Kokoro + dialogue on Qwen) is intentional, not drift. Show the
       breakdown instead of the amber "Generated with X" warning, even when
       its stamped audioModelKey differs from the active engine. */
    const mixed: Chapter = {
      ...chapter1,
      audioModelKey: 'kokoro-v1',
      audioEngines: { kokoro: 1, qwen: 6 },
    };
    renderWithChapters([mixed, chapter2], 'coqui-xtts-v2');
    expect(screen.getByText(/Kokoro \(1\), Qwen \(6\)/)).toBeTruthy();
    expect(screen.queryByText(/Generated with .* · current engine is/i)).toBeNull();
  });

  it('a mixed-engine chapter does not contribute to the top-of-view drift banner', () => {
    const mixed: Chapter = {
      ...chapter1,
      audioModelKey: 'kokoro-v1',
      audioEngines: { kokoro: 1, qwen: 6 },
    };
    renderWithChapters([mixed, chapter2], 'coqui-xtts-v2');
    expect(screen.queryByText(/generated with a different engine/i)).toBeNull();
  });

  it('chapters with no audioModelKey stamp (legacy / never-rendered) do not contribute drift signal', () => {
    /* Unstamped done chapter: silent. The opportunistic backfill runs
       on the server; until it lands we don't nag the user. */
    const unstamped: Chapter = { ...chapter1 /* no audioModelKey */ };
    renderWithChapters([unstamped, chapter2], 'kokoro-v1');
    expect(screen.queryByText(/generated with a different engine/i)).toBeNull();
  });

  it('excluded chapters do not contribute to drift even when their audioModelKey would mismatch', () => {
    /* Edge case: a previously-rendered chapter that the user later
       excluded shouldn't surface drift — the chapter is no longer in
       the active book, so its rendered engine is irrelevant. The
       counter computation filters on activeChapters first. */
    const excludedDrifted: Chapter = {
      ...chapter1,
      audioModelKey: 'coqui-xtts-v2',
      excluded: true,
    };
    renderWithChapters([excludedDrifted, chapter2], 'kokoro-v1');
    expect(screen.queryByText(/generated with a different engine/i)).toBeNull();
  });
});

describe('GenerationView — reassignment staleness caption (Bug 2)', () => {
  /* A done chapter whose sentence→speaker assignments were changed after it was
     rendered shows an amber "Sentences reassigned · regenerate to refresh"
     caption, derived from the change-log boundary_move time vs audioRenderedAt. */
  function renderWithReassign(chapters: Chapter[], reassignedChapterIds: number[]): void {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters(chapters));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters,
        sentences,
      } as any),
    );
    /* bumpBoundaryMove stamps `at` to "now", which is after the fixed past
       render time below — so these chapters read stale deterministically. */
    for (const id of reassignedChapterIds) {
      store.dispatch(changeLogSlice.actions.bumpBoundaryMove({ chapterId: id, count: 1 }));
    }
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={chapters}
          characters={characters}
          paused
          title="Reassign Fixture"
          bookId="b1"
          modelKey="kokoro-v1"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  const RENDERED_PAST = '2020-01-01T00:00:00Z';
  const doneStampable: Chapter = {
    ...chapter1,
    audioModelKey: 'kokoro-v1',
    audioRenderedAt: RENDERED_PAST,
  };

  it('shows the caption on a done chapter reassigned after it was rendered', () => {
    renderWithReassign([doneStampable, chapter2], [1]);
    expect(screen.getByText(/Sentences reassigned · regenerate to refresh/i)).toBeInTheDocument();
  });

  it('does NOT show the caption when the chapter was never reassigned', () => {
    renderWithReassign([doneStampable, chapter2], []);
    expect(screen.queryByText(/Sentences reassigned/i)).toBeNull();
  });

  it('does NOT show the caption for a queued (un-rendered) chapter even if reassigned', () => {
    /* chapter2 is queued — a reassignment there has nothing rendered to stale. */
    renderWithReassign([doneStampable, chapter2], [2]);
    expect(screen.queryByText(/Sentences reassigned/i)).toBeNull();
  });
});

describe('GenerationView — precise reassignment staleness via render map (#650)', () => {
  /* When the server ships a per-chapter render-time sentence→speaker map, the
     Generate view diffs it against the LIVE manuscript instead of using the
     time-based change-log heuristic — precise (a reassign-then-undo reads
     not-stale) and immediate. Chapter 1's fixture sentences are
     {1:narrator, 2:Marlow, 3:Marlow}. */
  function renderWithRenderMap(
    renderedSpeakersByChapter: Record<number, Record<number, string>>,
  ): void {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    /* hydrateFromBookState is the only setter for renderedSpeakersByChapter. */
    store.dispatch(
      chaptersSlice.actions.hydrateFromBookState({
        bookId: 'b1',
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-a' },
          { id: 2, title: 'Chapter 2', slug: '02-b' },
        ],
        completedSlugs: ['01-a'],
        characters,
        renderedSpeakersByChapter,
      } as any),
    );
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters: [chapter1, chapter2],
        sentences,
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[chapter1, chapter2]}
          characters={characters}
          paused
          title="Render Map Fixture"
          bookId="b1"
          modelKey="kokoro-v1"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  it('shows the caption when the live mapping differs from the render map', () => {
    /* Render had sentence 2 on narrator; the manuscript now has it on Marlow. */
    renderWithRenderMap({ 1: { 1: 'narrator', 2: 'narrator', 3: 'Marlow' } });
    expect(screen.getByText(/Sentences reassigned · regenerate to refresh/i)).toBeInTheDocument();
  });

  it('does NOT show the caption when the live mapping matches the render map (no false positive)', () => {
    /* Identical to the fixture sentences → not stale, even if the time-based
       heuristic would have flagged it. */
    renderWithRenderMap({ 1: { 1: 'narrator', 2: 'Marlow', 3: 'Marlow' } });
    expect(screen.queryByText(/Sentences reassigned/i)).toBeNull();
  });
});

describe('GenerationView — bulk Regenerate all drifted (plan 35 follow-up)', () => {
  /* The banner now carries a "Regenerate all" affordance that confirms
     once and dispatches regenerateChapterIds for every drifted chapter
     in one shot. This describe pins the confirm-dialog flow + dispatched
     payload + slice state transitions end-to-end. */

  function makeDriftStore(chapters: Chapter[]) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters(chapters));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters,
        sentences,
      } as any),
    );
    return store;
  }

  function renderDrift(store: ReturnType<typeof makeDriftStore>, chapters: Chapter[]) {
    return render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={chapters}
          characters={characters}
          paused
          title="Drift Fixture"
          bookId="b1"
          modelKey="kokoro-v1"          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  it('confirm dialog names the source engine, target engine, and enqueues one queue entry per drifted chapter (plan 102)', async () => {
    const drifted1: Chapter = { ...chapter1, audioModelKey: 'coqui-xtts-v2' };
    const drifted3: Chapter = {
      id: 3,
      title: 'Chapter 3',
      duration: '01:23',
      state: 'done',
      progress: 1,
      characters: { narrator: 'done' },
      audioModelKey: 'coqui-xtts-v2',
    };
    const store = makeDriftStore([drifted1, chapter2, drifted3]);
    renderDrift(store, [drifted1, chapter2, drifted3]);

    /* Plan 102 — drift bulk regen now POSTs /api/queue/enqueue (one
       entry per drifted chapter) instead of dispatching
       regenerateChapterIds. Stub fetch and assert the request body. */
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () =>
        Promise.resolve({
          entries: [
            {
              id: 'e1',
              bookId: 'b1',
              chapterId: 1,
              scope: 'this',
              status: 'queued',
              order: 0,
              addedAt: '2026-05-23T00:00:00Z',
            },
            {
              id: 'e2',
              bookId: 'b1',
              chapterId: 3,
              scope: 'this',
              status: 'queued',
              order: 1,
              addedAt: '2026-05-23T00:00:00Z',
            },
          ],
          paused: false,
        }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    /* Banner button opens the confirm dialog. */
    const bannerBtn = screen.getByRole('button', { name: /^Regenerate all$/ });
    fireEvent.click(bannerBtn);

    /* Title carries the count + target engine label; body carries the
       source engine label. The dialog also re-uses the "Existing audio
       remains available" copy from the per-chapter modal for continuity. */
    expect(screen.getByText(/Regenerate 2 chapters with Kokoro v1\?/)).toBeInTheDocument();
    expect(screen.getByText(/rendered with/i).textContent).toMatch(/Coqui XTTS v2/);
    expect(screen.getByText(/Existing audio remains available/i)).toBeInTheDocument();

    /* Confirm — the button label includes the count for plural cases. */
    fireEvent.click(screen.getByRole('button', { name: /Regenerate all 2/ }));

    /* The enqueue thunk fires /api/queue/enqueue with the drifted ids
       expanded to one queue entry each. Wait a microtask so the thunk's
       fetch lands before the assertion. */
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queue/enqueue',
      expect.objectContaining({
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/enqueue');
    const body = JSON.parse((call?.[1] as { body: string }).body) as {
      entries: { bookId: string; chapterId: number; scope: string }[];
    };
    expect(body.entries.map((e) => e.chapterId)).toEqual([1, 3]);
    expect(body.entries.every((e) => e.scope === 'this' && e.bookId === 'b1')).toBe(true);
    vi.unstubAllGlobals();
  });

  it('singular copy when only one chapter is drifted', () => {
    const drifted: Chapter = { ...chapter1, audioModelKey: 'coqui-xtts-v2' };
    const store = makeDriftStore([drifted, chapter2]);
    renderDrift(store, [drifted, chapter2]);

    fireEvent.click(screen.getByRole('button', { name: /^Regenerate all$/ }));
    /* "1 chapter" not "1 chapters"; confirm button singular too. */
    expect(screen.getByText(/Regenerate 1 chapter with Kokoro v1\?/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Regenerate 1 chapter/ })).toBeInTheDocument();
  });

  it('mid-run banner adds the "interrupt the current run" warning to the confirm body', () => {
    /* When any chapter is in_progress, the bulk-regen would interrupt
       the live SSE. Surface that to the user inside the confirm body
       instead of disabling the button. */
    const drifted: Chapter = { ...chapter1, audioModelKey: 'coqui-xtts-v2' };
    const live: Chapter = { ...chapter2, state: 'in_progress', progress: 0.4 };
    const store = makeDriftStore([drifted, live]);
    renderDrift(store, [drifted, live]);

    fireEvent.click(screen.getByRole('button', { name: /^Regenerate all$/ }));
    expect(screen.getByText(/interrupt the current run/i)).toBeInTheDocument();
  });

  it('Cancel closes the dialog without dispatching anything', () => {
    const drifted: Chapter = { ...chapter1, audioModelKey: 'coqui-xtts-v2' };
    const store = makeDriftStore([drifted, chapter2]);
    renderDrift(store, [drifted, chapter2]);

    fireEvent.click(screen.getByRole('button', { name: /^Regenerate all$/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));

    /* Dialog gone, no regenerate dispatched — no chapter row flipped to
       in_progress (the regen reducers' observable side-effect; the old
       pendingRegen / regenEpoch fields were removed in plan 102 Should #5). */
    expect(screen.queryByText(/Regenerate 1 chapter with Kokoro v1\?/)).not.toBeInTheDocument();
    expect(store.getState().chapters.chapters.every((c) => c.state !== 'in_progress')).toBe(true);
  });

  it('mixed source engines render side-by-side in the dialog body', () => {
    /* Accumulated drift: one Coqui-rendered + one Gemini-rendered chapter
       both differ from the active Kokoro engine. The body should name
       both source engines rather than awkwardly picking one. */
    const coquiDrift: Chapter = { ...chapter1, audioModelKey: 'coqui-xtts-v2' };
    const geminiDrift: Chapter = {
      id: 3,
      title: 'Chapter 3',
      duration: '01:23',
      state: 'done',
      progress: 1,
      characters: { narrator: 'done' },
      audioModelKey: 'gemini-2.5-flash',
    };
    const store = makeDriftStore([coquiDrift, chapter2, geminiDrift]);
    renderDrift(store, [coquiDrift, chapter2, geminiDrift]);

    fireEvent.click(screen.getByRole('button', { name: /^Regenerate all$/ }));
    const body = screen.getByText(/rendered across/i);
    expect(body.textContent).toMatch(/Coqui XTTS v2/);
    expect(body.textContent).toMatch(/Gemini/);
  });
});

describe('GenerationView — Include in book (subset re-analysis)', () => {
  /* Pre-fix the un-exclude path dispatched ONLY chaptersActions.mergeSubsetAnalysis,
     so the chapter's sentences never reached manuscript.sentences and audio
     generation had nothing to synthesise. The handler now triple-merges
     (cast + chapters + manuscript) on success, runs subset analysis
     unconditionally (no stale-cache heuristic), surfaces inline progress
     with phase + percentage, supports Cancel via AbortController, and
     gates local-analyzer-mid-generation behind the existing
     useLocalAnalyzerGuard modal. */

  const ch3Excluded: Chapter = {
    id: 3,
    title: 'Chapter 3',
    duration: '00:00',
    state: 'queued',
    progress: 0,
    excluded: true,
    characters: {},
  };

  /* Subset-analysis response shaped to mirror the live server payload:
     full re-folded cast + the chapter's freshly-attributed sentences +
     a chapters list reset to queued state. */
  const subsetResponse = {
    bookId: 'b1',
    manuscriptId: 'm1',
    title: 'the Coalfall Commission',
    phaseTimings: [],
    characters: [
      ...characters,
      { id: 'Wren', name: 'Wren', role: 'Protagonist', color: 'magenta' as const },
    ],
    chapters: [
      { ...chapter1, characters: {} },
      { ...chapter2, characters: {} },
      { ...ch3Excluded, excluded: undefined, characters: {} },
    ],
    sentences: [
      { id: 50, chapterId: 3, characterId: 'narrator', text: 'Chapter three begins.' },
      { id: 51, chapterId: 3, characterId: 'Wren', text: 'I have something to say.' },
    ],
    libraryMatches: [],
  };

  function makeIncludeStore({
    selectedModel,
    activeStream,
  }: {
    selectedModel?: string;
    activeStream?: { bookId: string; modelKey: string };
  } = {}) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters([chapter1, chapter2, ch3Excluded]));
    store.dispatch(chaptersSlice.actions.setCurrentBookId('b1'));
    /* Order matters: hydrateFromAnalysis FIRST while manuscriptId is
       still null so the slice takes the wholesale-replace branch and
       wipes the demo fixture (which seeds 14 chapter-3 sentences and
       would pollute our subset-merge assertions). uploadComplete
       second to set manuscriptId — the un-exclude handler bails out
       early when it's null, so we need a value before the click. */
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        manuscriptId: 'm1',
        title: 'the Coalfall Commission',
        characters,
        chapters: [chapter1, chapter2, ch3Excluded],
        sentences,
      } as any),
    );
    store.dispatch(
      manuscriptSlice.actions.uploadComplete({
        manuscriptId: 'm1',
        title: 'the Coalfall Commission',
        format: 'plaintext',
        wordCount: 0,
        byteSize: 0,
        uploadedAt: new Date().toISOString(),
        sourceText: '',
      }),
    );
    store.dispatch(castSlice.actions.setCharacters(characters));
    if (selectedModel) {
      store.dispatch(uiSlice.actions.setSelectedModel(selectedModel));
    }
    if (activeStream) {
      store.dispatch(
        chaptersSlice.actions.setActiveStream({
          bookId: activeStream.bookId,

          modelKey: activeStream.modelKey as any,
          done: 0,
          total: 2,
          inProgress: 1,
          lastTickAt: Date.now(),
        } as any),
      );
    }
    return store;
  }

  function renderInclude(store: ReturnType<typeof makeIncludeStore>) {
    return render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[chapter1, chapter2, ch3Excluded]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  it('Re-analyse on a done chapter confirms, then calls runAnalysisForChapters([id]) for that chapter only', async () => {
    const store = makeIncludeStore();
    runAnalysisForChaptersSpy.mockReturnValue(new Promise(() => {})); // keep it pending
    renderInclude(store);

    // Chapter 1 is done → its action row carries the Re-analyse button.
    fireEvent.click(screen.getByTestId('chapter-row-1-reanalyse'));
    // Confirm dialog appears; nothing fires until the user confirms.
    expect(runAnalysisForChaptersSpy).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole('button', { name: /Re-analyse chapter/i }));

    expect(runAnalysisForChaptersSpy).toHaveBeenCalledTimes(1);
    expect(runAnalysisForChaptersSpy).toHaveBeenCalledWith('m1', [1], expect.anything());
  });

  it('on success, merges sentences into the manuscript slice, characters into cast, and clears the row excluded flag', async () => {
    const store = makeIncludeStore();
    setChapterExcludedSpy.mockResolvedValue({
      id: 3,
      title: 'Chapter 3',
      slug: '03-chapter-3',
      excluded: false,
    });
    runAnalysisForChaptersSpy.mockResolvedValue(subsetResponse);

    renderInclude(store);
    const btn = await screen.findByRole('button', { name: /\+ Include in book/i });
    fireEvent.click(btn);

    /* Wait for the row to transition out of the excluded variant —
       the slice change is the load-bearing signal that the merge ran. */
    await screen.findByText('14 words · 3 lines · 2 speakers'); // chapter 1 still renders normally
    const state = store.getState();
    expect(state.chapters.chapters.find((c) => c.id === 3)?.excluded).toBeUndefined();
    /* Manuscript merge — pre-fix this stayed as the original 4 sentences. */
    const ch3Sentences = state.manuscript.sentences.filter((s) => s.chapterId === 3);
    expect(ch3Sentences).toHaveLength(2);
    expect(ch3Sentences.map((s) => s.characterId).sort()).toEqual(['narrator', 'Wren']);
    /* Cast merge — Wren is a newly-detected character. */
    expect(state.cast.characters.some((c) => c.id === 'Wren')).toBe(true);
    /* Chapter characters map populated for ch3 — the row will render
       Wren + narrator as queued speakers on the next paint. */
    const ch3 = state.chapters.chapters.find((c) => c.id === 3);
    expect(ch3?.characters).toMatchObject({ narrator: 'queued', Wren: 'queued' });
  });

  it('moves the subset bar off the floor on a heartbeat + shows live elapsed/throughput', async () => {
    const store = makeIncludeStore();
    setChapterExcludedSpy.mockResolvedValue({
      id: 3,
      title: 'Chapter 3',
      slug: '03-chapter-3',
      excluded: false,
    });
    /* Capture the opts to invoke onPhase/onHeartbeat synchronously after the
       click, and return a never-resolving promise so the row stays in the
       running variant for assertion. */
    let capturedOpts:
      | {
          onPhase?: (e: { phaseId: number; progress: number }) => void;
          onHeartbeat?: (e: {
            phaseId: number;
            receivedBytes: number;
            charsPerSec: number;
            elapsedMs: number;
            sinceLastChunkMs: number;
          }) => void;
        }
      | undefined;
    runAnalysisForChaptersSpy.mockImplementation((_id, _ids, opts) => {
      capturedOpts = opts;
      return new Promise(() => {});
    });

    renderInclude(store);
    fireEvent.click(await screen.findByRole('button', { name: /\+ Include in book/i }));
    await screen.findByRole('button', { name: /Cancel/i });

    /* For a single-chapter subset the server's coarse progress is ~2% the whole
       phase — the old bug. The row maps it and floors at 2% until a heartbeat. */
    capturedOpts?.onPhase?.({ phaseId: 0, progress: 0.02 });
    expect(
      await screen.findByText(/Re-analyzing — Detecting characters \(Phase 0a\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText('2%')).toBeInTheDocument();

    /* A streaming heartbeat moves the bar within the detect band and surfaces
       the live elapsed + throughput readout (8s @ 6s tau → ~30%). */
    capturedOpts?.onHeartbeat?.({
      phaseId: 0,
      receivedBytes: 2048,
      charsPerSec: 512,
      elapsedMs: 8000,
      sinceLastChunkMs: 500,
    });
    expect(await screen.findByText('30%')).toBeInTheDocument();
    expect(screen.getByText(/0:08/)).toBeInTheDocument();
    expect(screen.getByText(/512 chars\/s/)).toBeInTheDocument();
    expect(screen.queryByText('2%')).not.toBeInTheDocument();
  });

  it('Cancel aborts the underlying signal and reverts the row to the idle Include CTA', async () => {
    const store = makeIncludeStore();
    setChapterExcludedSpy.mockResolvedValue({
      id: 3,
      title: 'Chapter 3',
      slug: '03-chapter-3',
      excluded: false,
    });
    let capturedSignal: AbortSignal | undefined;
    runAnalysisForChaptersSpy.mockImplementation((_id, _ids, opts) => {
      capturedSignal = (opts as { signal?: AbortSignal })?.signal;
      return new Promise((_resolve, reject) => {
        capturedSignal?.addEventListener('abort', () => {
          const err: Error & { name: string } = new Error('aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });

    renderInclude(store);
    fireEvent.click(await screen.findByRole('button', { name: /\+ Include in book/i }));
    const cancelBtn = await screen.findByRole('button', { name: /Cancel/i });
    fireEvent.click(cancelBtn);

    expect(capturedSignal?.aborted).toBe(true);
    /* Row reverts to idle — Include CTA is back. */
    expect(await screen.findByRole('button', { name: /\+ Include in book/i })).toBeInTheDocument();
  });

  it('on error, surfaces the message inline with a Retry button that re-runs the subset call', async () => {
    const store = makeIncludeStore();
    setChapterExcludedSpy.mockResolvedValue({
      id: 3,
      title: 'Chapter 3',
      slug: '03-chapter-3',
      excluded: false,
    });
    runAnalysisForChaptersSpy.mockRejectedValueOnce(new Error('analyzer offline'));

    renderInclude(store);
    fireEvent.click(await screen.findByRole('button', { name: /\+ Include in book/i }));
    expect(await screen.findByText(/Re-analysis failed: analyzer offline/i)).toBeInTheDocument();

    /* Stub a successful second attempt and click Retry. */
    runAnalysisForChaptersSpy.mockResolvedValueOnce(subsetResponse);
    fireEvent.click(screen.getByRole('button', { name: /Retry/i }));
    /* runAnalysisForChapters should have been invoked TWICE — once on
       the failing click, once on Retry. */
    await screen.findByRole('button', { name: /\+ Include in book/i }).catch(() => {
      /* If the row already morphed into a non-excluded state, the
         Include CTA won't be findable — which is also a valid
         success signal. Either way the spy count is the assertion. */
    });
    expect(runAnalysisForChaptersSpy).toHaveBeenCalledTimes(2);
  });

  it('with a local analyzer selected and a generation stream alive, surfaces the pause-to-analyse modal before firing subset analysis', async () => {
    const store = makeIncludeStore({
      selectedModel: 'qwen3.5:4b',
      activeStream: { bookId: 'other-book', modelKey: 'coqui-xtts-v2' },
    });
    setChapterExcludedSpy.mockResolvedValue({
      id: 3,
      title: 'Chapter 3',
      slug: '03-chapter-3',
      excluded: false,
    });
    runAnalysisForChaptersSpy.mockResolvedValue(subsetResponse);

    renderInclude(store);
    fireEvent.click(await screen.findByRole('button', { name: /\+ Include in book/i }));
    /* Modal appears — subset analysis has NOT been called yet. */
    expect(await screen.findByText(/Pause audio generation to analyse\?/i)).toBeInTheDocument();
    expect(runAnalysisForChaptersSpy).not.toHaveBeenCalled();

    /* Confirm — should halt the active generation (haltActiveGeneration:
       requestStreamHalt + setQueuePaused, unit-tested in queue-thunks.test.ts)
       and only THEN kick off the subset analysis call. */
    fireEvent.click(screen.getByRole('button', { name: /Pause and analyse/i }));
    await screen.findByRole('button', { name: /Cancel/i }).catch(() => null);
    expect(runAnalysisForChaptersSpy).toHaveBeenCalledTimes(1);
  });

  it('with a remote analyzer selected, skips the modal and runs subset analysis immediately', async () => {
    const store = makeIncludeStore({
      selectedModel: 'gemini-2.5-flash',
      activeStream: { bookId: 'other-book', modelKey: 'coqui-xtts-v2' },
    });
    setChapterExcludedSpy.mockResolvedValue({
      id: 3,
      title: 'Chapter 3',
      slug: '03-chapter-3',
      excluded: false,
    });
    runAnalysisForChaptersSpy.mockResolvedValue(subsetResponse);

    renderInclude(store);
    fireEvent.click(await screen.findByRole('button', { name: /\+ Include in book/i }));
    await screen.findByRole('button', { name: /Cancel/i }).catch(() => null);

    /* No pause-modal in the DOM, and the analysis spy fired right away. */
    expect(screen.queryByText(/Pause audio generation to analyse\?/i)).toBeNull();
    expect(runAnalysisForChaptersSpy).toHaveBeenCalledTimes(1);
  });
});

/* Wave 3 — phone viewport contract for the Generation view: the page
   header action buttons (Pause / Resume / Regenerate) and each chapter
   row's collapsed grid both hit the ≥44px touch-target invariant from
   `docs/features/archive/81-mobile-tablet-support.md` while the responsive
   grid template at the top-level shrinks to single-column. Stat panel
   collapses 4-up → 2×2 below `sm:` so the four numbers don't compress
   to single digits at 375×667. */
describe('GenerationView — phone viewport (375×667, Wave 3)', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 375 });
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 667 });
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: /max-width:\s*640px/.test(query) || /max-width:\s*767px/.test(query),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });
  });

  it('header View queue button declares the ≥44px touch-target class (plan 102)', () => {
    /* Wave 4a moved Resume/Pause into the queue modal; the header slot
       now hosts the View queue CTA which must hit the same WCAG 2.5.5
       touch-target rule. */
    renderView();
    const viewQueue = screen.getByTestId('generation-view-queue');
    expect(viewQueue.className).toContain('min-h-[44px]');
  });

  it('stats panel uses 2-column grid on phone (collapses below sm:)', () => {
    renderView();
    /* "Completed" Stat lives inside the grid we just made responsive.
       Walk up to the grid container and assert the responsive class. */
    const completedLabel = screen.getByText(/Completed/i);
    const grid = completedLabel.closest('.grid');
    expect(grid).not.toBeNull();
    expect(grid!.className).toContain('grid-cols-2');
    expect(grid!.className).toContain('sm:grid-cols-4');
  });

  it('chapter row collapses to the mobile 5-column grid template', () => {
    renderView();
    /* The collapsed-row button is the chapter row's tap target. Its grid
       template carries the mobile-only 5-column shape (icon · CH · title ·
       badge · chevron) and the sm: 7-column override. */
    const ch1 = screen.getByText('Chapter 1');
    const row = ch1.closest('button');
    expect(row).not.toBeNull();
    expect(row!.className).toContain('grid-cols-[24px_44px_minmax(0,1fr)_auto_20px]');
    expect(row!.className).toContain('sm:grid-cols-[32px_52px');
    /* Touch-target invariant: the whole row is a tap target. */
    expect(row!.className).toContain('min-h-[44px]');
  });
});

describe('GenerationView — stuck-queued escape hatch + generated-time (side: stuck-queued)', () => {
  function makeViewStore(chapters: Chapter[]) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
        account: accountSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters(chapters));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters,
        sentences,
      } as any),
    );
    return store;
  }

  function renderWith(chapters: Chapter[]) {
    const store = makeViewStore(chapters);
    return render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={chapters}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  it('a queued row exposes "Generate this chapter" which enqueues just that chapter', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
      json: () => Promise.resolve({ entries: [], paused: false }),
    } as Response);
    vi.stubGlobal('fetch', fetchMock);

    renderWith([chapter1, chapter2]);
    /* Expand the queued chapter — the escape-hatch action lives in the
       expanded panel (the collapsed row stays visually clean). */
    fireEvent.click(screen.getByText('Chapter 2'));
    const btn = screen.getByRole('button', { name: /Generate chapter 2/i });
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    await Promise.resolve();
    await Promise.resolve();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/queue/enqueue',
      expect.objectContaining({ method: 'POST' }),
    );
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/enqueue');
    const body = JSON.parse((call?.[1] as { body: string }).body) as {
      entries: { bookId: string; chapterId: number; scope: string }[];
    };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({ bookId: 'b1', chapterId: 2, scope: 'this' });
    vi.unstubAllGlobals();
  });

  it('does NOT offer "Generate this chapter" on a done row', () => {
    renderWith([chapter1, chapter2]);
    fireEvent.click(screen.getByText('Chapter 1')); // done chapter
    expect(screen.queryByRole('button', { name: /Generate chapter 1/i })).toBeNull();
  });

  it('shows the audio-generated time on a done row with the absolute timestamp on hover', () => {
    const renderedAt = '2026-05-31T16:39:00.000Z';
    const done: Chapter = { ...chapter1, audioRenderedAt: renderedAt };
    renderWith([done, chapter2]);
    const label = screen.getByText(/^Generated /);
    expect(label).toBeInTheDocument();
    /* Tooltip carries the exact local date/time. */
    expect(label.getAttribute('title')).toBe(new Date(renderedAt).toLocaleString());
  });

  it('omits the generated-time line on a done row that predates audioRenderedAt', () => {
    /* chapter1 has no audioRenderedAt → no "Generated …" line (legacy audio). */
    renderWith([chapter1, chapter2]);
    expect(screen.queryByText(/^Generated /)).toBeNull();
  });
});

/* fe-17 — the explicit "Resume generation" button. Plan 137 made opening a
   book never auto-enqueue; this button is the deliberate one-click way to
   continue a book whose run was interrupted (queue drained server-side, some
   chapters still `queued`). It dispatches the same plan-137 pure-signal
   `requestStartGeneration` intent the "Approve cast & start generating" CTA
   uses, and is shown ONLY when there's queued work, nothing in flight, and
   no halting error. Pairs with docs/features/archive/137-reopen-never-auto-enqueues.md. */
describe('GenerationView — Resume generation button (fe-17)', () => {
  function makeResumeStore(chapters: Chapter[]) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
        account: accountSlice.reducer,
      },
    });
    store.dispatch(chaptersSlice.actions.setChapters(chapters));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        bookId: 'b1',
        characters,
        chapters,
        sentences,
      } as any),
    );
    return store;
  }

  function renderResume(chapters: Chapter[]) {
    const store = makeResumeStore(chapters);
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={chapters}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    return store;
  }

  const inProgressChapter2: Chapter = { ...chapter2, state: 'in_progress' };

  it('renders and dispatches requestStartGeneration when there is queued work and nothing in flight', () => {
    /* chapter1 done, chapter2 queued → queued > 0, inProgress = 0, no error.
       Spy on dispatch BEFORE render so the view's useDispatch captures the
       spy, not the original store method. */
    const store = makeResumeStore([chapter1, chapter2]);
    const dispatchSpy = vi.spyOn(store, 'dispatch');
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[chapter1, chapter2]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    const btn = screen.getByTestId('generation-view-resume');
    expect(btn).toBeInTheDocument();

    fireEvent.click(btn);
    expect(dispatchSpy).toHaveBeenCalledWith(uiSlice.actions.requestStartGeneration());
  });

  it('is hidden while a chapter is in progress (a run is live)', () => {
    renderResume([chapter1, inProgressChapter2]);
    expect(screen.queryByTestId('generation-view-resume')).toBeNull();
  });

  it('is hidden when generation is halted on a stream-level error', () => {
    const store = makeResumeStore([chapter1, chapter2]);
    /* Stream-level failure (no chapterId) sets chapters.lastError → "halted". */
    store.dispatch(
      chaptersSlice.actions.applyGenerationTick({
        type: 'chapter_failed',
        chapterId: null,
        errorReason: 'Sidecar unreachable.',
      } as any),
    );
    render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={[chapter1, chapter2]}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
    expect(screen.queryByTestId('generation-view-resume')).toBeNull();
  });

  it('is hidden when every chapter is done (no queued work)', () => {
    renderResume([chapter1, { ...chapter2, state: 'done', progress: 1 }]);
    expect(screen.queryByTestId('generation-view-resume')).toBeNull();
  });

  /* Bug 1 — a "Not queued" (held) chapter is queued under the hood but the user
     removed it from the queue. It must read "Not queued" (not "Queued"), and it
     must NOT count as queued work — so Resume stays hidden rather than offering
     to silently re-enqueue the chapter the user just deleted. */
  const heldChapter2: Chapter = { ...chapter2, held: true };

  it('renders a held chapter as "Not queued" rather than a "Queued" badge', () => {
    renderResume([chapter1, heldChapter2]);
    /* The held row shows the neutral "Not queued" pill. (A "Queued" summary
       stat still renders at the top — its value is now 0 because held chapters
       are excluded from the queued count — so we assert against the row's badge
       Pill specifically, not the stat label.) */
    const notQueued = screen.getByText('Not queued');
    expect(notQueued).toBeInTheDocument();
    const heldRow = notQueued.closest('.rounded-3xl');
    expect(heldRow).not.toBeNull();
    expect(within(heldRow as HTMLElement).queryByText('Queued')).toBeNull();
  });

  it('hides Resume generation when the only remaining work is held (not re-added)', () => {
    renderResume([chapter1, heldChapter2]);
    expect(screen.queryByTestId('generation-view-resume')).toBeNull();
  });
});

describe('GenerationView — srv-27 advisory QA badge', () => {
  function renderWithChapters(rows: Chapter[]) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        changeLog: changeLogSlice.reducer,
        cast: castSlice.reducer,
        library: librarySlice.reducer,
        queue: queueSlice.reducer,
        account: accountSlice.reducer,
      },
    });
    store.dispatch(accountSlice.actions.setDefaultTtsModelKey('coqui-xtts-v2'));
    store.dispatch(chaptersSlice.actions.setChapters(rows));
    return render(
      <Provider store={store}>
        <HostedGenerationView
          chapters={rows}
          characters={characters}
          paused
          title="the Coalfall Commission"
          bookId="b1"
          modelKey="coqui-xtts-v2"
          onRegenerate={() => {}}
          onRegenerateBook={() => {}}
          onRegenerateCharacterInChapter={() => {}}
          onPreview={() => {}}
        />
      </Provider>,
    );
  }

  it('renders a Suspect badge on a done chapter flagged suspect', () => {
    const suspect: Chapter = {
      ...chapter1,
      audioQa: {
        status: 'suspect',
        reasons: ['Suspiciously short — 10s rendered vs ~60s expected (possible truncation).'],
        measuredLufs: -16,
        truePeakDb: -1.5,
        durationSec: 10,
        expectedSec: 60,
        checkedAt: new Date().toISOString(),
      },
    };
    renderWithChapters([suspect]);
    const badge = screen.getByText('Suspect');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', expect.stringMatching(/short/i));
  });

  it('renders no Suspect badge when the QA verdict is ok', () => {
    const ok: Chapter = {
      ...chapter1,
      audioQa: {
        status: 'ok',
        reasons: [],
        measuredLufs: -16,
        truePeakDb: -1.5,
        durationSec: 62,
        expectedSec: 60,
        checkedAt: new Date().toISOString(),
      },
    };
    renderWithChapters([ok]);
    expect(screen.queryByText('Suspect')).toBeNull();
  });
});

describe('GenerationView — Wave 2 brand manifesto', () => {
  it('renders "Many voices, one machine." on the generation screen', () => {
    renderView();
    expect(screen.getByText('Many voices, one machine.')).toBeInTheDocument();
  });
});
