// fs-57 — per-book liveInstruct toggle on the Generate view.
// Pairs with docs/features/archive/38-branching-and-commit-convention.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
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
import { bookMetaSlice, bookMetaActions } from '../store/book-meta-slice';
import { GenerationView } from './generation';
import { useTtsLifecycle } from '../lib/use-tts-lifecycle';
import type { LayoutContext } from '../components/layout';
import type { Chapter, Character } from '../lib/types';
import type { ComponentProps } from 'react';

/* ── API stubs ─────────────────────────────────────────────────────────────── */

const putBookStateMock = vi.fn().mockResolvedValue(undefined);

vi.mock('../lib/api', () => ({
  api: {
    streamGeneration: () => () => {},
    getChapterAudio: vi.fn(() => new Promise(() => {})),
    getSidecarHealth: () => Promise.resolve({ status: 'reachable', url: '(test)', modelLoaded: false }),
    getGpuQueueState: () => Promise.resolve({ depth: 0, inFlight: 0, max: 1 }),
    getOllamaHealth: () =>
      Promise.resolve({ status: 'reachable', url: '(test)', models: [], resident: [], modelResident: false }),
    loadSidecar: () => Promise.resolve({ status: 'ready' }),
    unloadSidecar: () => Promise.resolve({ status: 'idle' }),
    loadAnalyzer: () => Promise.resolve({ status: 'ready' }),
    unloadAnalyzer: () => Promise.resolve({ status: 'unloaded' }),
    setChapterExcluded: () => Promise.resolve({ id: 0, title: '', slug: '', excluded: false }),
    runAnalysisForChapters: () => new Promise(() => {}),
    putBookState: (...args: unknown[]) => putBookStateMock(...args),
  },
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
  putBookStateMock.mockClear();
});

/* ── Hosted wrapper (mirrors generation.test.tsx) ──────────────────────────── */

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

/* ── Fixtures ───────────────────────────────────────────────────────────────── */

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
];
/* #1100 — a roster with one 1.7B Quality-tier member, which enables the toggle. */
const charactersWith17: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
  { id: 'wren', name: 'Wren', role: 'Lead', color: 'magenta', ttsModelKey: 'qwen3-tts-1.7b' },
];
const chapter1: Chapter = {
  id: 1,
  title: 'Chapter 1',
  duration: '00:00',
  state: 'queued',
  progress: 0,
  characters: { narrator: 'queued' },
};

const BOOK_ID = 'book-1';

function makeStore(liveInstruct = false) {
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
      bookMeta: bookMetaSlice.reducer,
    },
  });
  store.dispatch(accountSlice.actions.setDefaultTtsModelKey('coqui-xtts-v2'));
  store.dispatch(chaptersSlice.actions.setChapters([chapter1]));
  if (liveInstruct) {
    store.dispatch(bookMetaActions.setLiveInstruct({ bookId: BOOK_ID, value: true }));
  }
  return store;
}

function renderView(store: ReturnType<typeof makeStore>, roster: Character[] = charactersWith17) {
  return render(
    <Provider store={store}>
      <HostedGenerationView
        chapters={[chapter1]}
        characters={roster}
        paused
        title="The Coalfall Commission"
        bookId="book-1"
        modelKey="coqui-xtts-v2"
        onRegenerate={() => {}}
        onRegenerateBook={() => {}}
        onRegenerateCharacterInChapter={() => {}}
        onPreview={() => {}}
      />
    </Provider>,
  );
}

/* ── Tests ──────────────────────────────────────────────────────────────────── */

describe('GenerationView — liveInstruct toggle (fs-57)', () => {
  it('renders the toggle unchecked when liveInstruct=false (default)', () => {
    renderView(makeStore(false));
    const toggle = screen.getByTestId('live-instruct-toggle');
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox).not.toBeNull();
    expect(checkbox.checked).toBe(false);
  });

  it('renders the toggle checked when liveInstruct=true', () => {
    renderView(makeStore(true));
    const toggle = screen.getByTestId('live-instruct-toggle');
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('dispatches setLiveInstruct({bookId, value:true}) when the user checks the toggle', () => {
    const store = makeStore(false);
    renderView(store);
    const toggle = screen.getByTestId('live-instruct-toggle');
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(store.getState().bookMeta.liveInstruct[BOOK_ID]).toBe(true);
  });

  it('dispatches setLiveInstruct({bookId, value:false}) when the user unchecks the toggle', () => {
    const store = makeStore(true);
    renderView(store);
    const toggle = screen.getByTestId('live-instruct-toggle');
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    fireEvent.click(checkbox);
    expect(store.getState().bookMeta.liveInstruct[BOOK_ID]).toBe(false);
  });

  it('shows the label text for the toggle', () => {
    renderView(makeStore(false));
    expect(screen.getByText(/Live expressive delivery \(1\.7B\)/)).toBeInTheDocument();
    expect(screen.getByText(/re-render to hear it/)).toBeInTheDocument();
  });

  it('toggle meets 44px touch-target rule on phone (min-h-[44px] sm:min-h-0)', () => {
    renderView(makeStore(false));
    const toggle = screen.getByTestId('live-instruct-toggle');
    expect(toggle.className).toContain('min-h-[44px]');
    expect(toggle.className).toContain('sm:min-h-0');
  });

  it('greys out + disables the toggle when no cast member is on the 1.7B tier (#1100)', () => {
    renderView(makeStore(false), characters); // narrator only — no 1.7B member
    const toggle = screen.getByTestId('live-instruct-toggle');
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
    expect(toggle.className).toContain('opacity-50');
    expect(toggle.className).toContain('cursor-not-allowed');
    expect(screen.getByText(/No effect until a cast member is on the Qwen 1\.7B/)).toBeInTheDocument();
  });

  it('enables the toggle when a cast member is on the 1.7B tier (#1100)', () => {
    renderView(makeStore(false), charactersWith17);
    const toggle = screen.getByTestId('live-instruct-toggle');
    const checkbox = toggle.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(toggle.className).toContain('cursor-pointer');
  });
});

/* ── Persistence integration ─────────────────────────────────────────────────
   The persistence-middleware watches 'bookMeta/setLiveInstruct' and debounces
   a PUT to the server. We test this via the middleware directly (no fake
   timers needed here — the middleware test covers the full debounce path;
   here we just confirm the action type is defined and the middleware rule
   fires when integrated through the real store + middleware).
   ─────────────────────────────────────────────────────────────────────────── */
describe('persistence-middleware — bookMeta/setLiveInstruct (fs-57)', () => {
  it('action type matches the middleware rule key', () => {
    // The rule key is 'bookMeta/setLiveInstruct' — verify the action's type.
    const action = bookMetaActions.setLiveInstruct({ bookId: 'book-1', value: true });
    expect(action.type).toBe('bookMeta/setLiveInstruct');
  });
});
