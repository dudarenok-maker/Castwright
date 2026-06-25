// Task 13b — fs-65 Phase 3: opt-out render-time hint on the cast/generate surface
// Pairs with: docs/superpowers/plans/2026-06-25-phase3-prosody-and-scriptreview-chunking.md § Task 13b

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { castDesignSlice } from '../store/cast-design-slice';
import { bookMetaSlice, bookMetaActions } from '../store/book-meta-slice';
import { CastView } from './cast';
import type { Character, Voice } from '../lib/types';

/* ── api mock ────────────────────────────────────────────────────────────── */

const putBookStateSpy = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    loadSidecar: vi.fn().mockResolvedValue({}),
    pauseCastDesign: vi.fn().mockResolvedValue(undefined),
    setCastTier: vi.fn().mockResolvedValue({ updated: 0 }),
    listMergeSuggestions: vi.fn().mockResolvedValue([]),
    putBookState: (...args: unknown[]) => putBookStateSpy(...args),
  },
}));

vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    isPlaying: false,
    currentUrl: null,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
  }),
}));

/* ── fixtures ────────────────────────────────────────────────────────────── */

const BOOK_ID = 'bk-hint-test';

/** A Qwen character pinned to the 1.7B tier. */
const char17b: Character = {
  id: 'wren',
  name: 'Wren',
  role: 'Protagonist',
  color: 'narrator',
  lines: 120,
  scenes: 5,
  attributes: ['determined'],
  ttsEngine: 'qwen',
  ttsModelKey: 'qwen3-tts-1.7b',
  overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
};

/** A Qwen character on the default 0.6B tier (no ttsModelKey). */
const char06b: Character = {
  id: 'marrow',
  name: 'Mr. Marrow',
  role: 'Teacher',
  color: 'mentor',
  lines: 30,
  scenes: 2,
  attributes: ['stern'],
  ttsEngine: 'qwen',
  overrideTtsVoices: { qwen: { name: 'qwen-marrow' } },
};

/** A non-Qwen (Kokoro) character — no 1.7B. */
const charKokoro: Character = {
  id: 'narrator',
  name: 'Narrator',
  role: 'Third-person observer',
  color: 'narrator',
  lines: 500,
  scenes: 15,
  attributes: ['calm'],
};

const emptyLibrary: Voice[] = [];

/* ── store helpers ───────────────────────────────────────────────────────── */

function makeStore(opts: {
  prosodyEnabled?: boolean;
  bookId?: string;
  storeCharacters?: Character[];
} = {}) {
  const { prosodyEnabled, bookId = BOOK_ID, storeCharacters = [char17b, char06b] } = opts;
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      castDesign: castDesignSlice.reducer,
      bookMeta: bookMetaSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId, view: 'cast' } as never,
      },
      cast: {
        ...castSlice.getInitialState(),
        characters: storeCharacters,
      },
    },
  });
  if (prosodyEnabled !== undefined) {
    store.dispatch(bookMetaActions.setProsodyEnabled({ bookId, value: prosodyEnabled }));
  }
  return store;
}

function renderCast(
  opts: {
    characters?: Character[];
    prosodyEnabled?: boolean;
    bookId?: string;
  } = {},
) {
  const { characters = [char17b, char06b], prosodyEnabled, bookId = BOOK_ID } = opts;
  // Sync store characters with the prop so storedTiers reflects the same cast.
  const store = makeStore({ prosodyEnabled, bookId, storeCharacters: characters });
  const result = render(
    <Provider store={store}>
      <CastView
        characters={characters}
        setCharacters={() => {}}
        library={emptyLibrary}
        title="The Coalfall Commission"
        onOpenProfile={() => {}}
        onShowMatchDetail={() => {}}
        driftEvents={[]}
        onShowDrift={() => {}}
      />
    </Provider>,
  );
  return { store, ...result };
}

beforeEach(() => {
  putBookStateSpy.mockReset().mockResolvedValue(undefined);
});

/* ── tests ───────────────────────────────────────────────────────────────── */

describe('CastView prosody opt-out hint (Task 13b / fs-65)', () => {
  it('renders the hint when prosodyEnabled===false AND a 1.7B cast member exists', () => {
    renderCast({ characters: [char17b, char06b], prosodyEnabled: false });
    expect(
      screen.getByText(/expressive directions are off for this book/i),
    ).toBeInTheDocument();
  });

  it('is absent when prosodyEnabled is undefined (eager default)', () => {
    renderCast({ characters: [char17b, char06b] }); // no prosodyEnabled override
    expect(
      screen.queryByText(/expressive directions are off/i),
    ).not.toBeInTheDocument();
  });

  it('is absent when prosodyEnabled is true', () => {
    renderCast({ characters: [char17b, char06b], prosodyEnabled: true });
    expect(
      screen.queryByText(/expressive directions are off/i),
    ).not.toBeInTheDocument();
  });

  it('is absent when prosodyEnabled===false but NO 1.7B cast member exists', () => {
    // char06b has no ttsModelKey (undefined), charKokoro has no Qwen engine
    renderCast({ characters: [char06b, charKokoro], prosodyEnabled: false });
    expect(
      screen.queryByText(/expressive directions are off/i),
    ).not.toBeInTheDocument();
  });

  it('is absent when only the non-Qwen (Kokoro) cast member is present', () => {
    renderCast({ characters: [charKokoro], prosodyEnabled: false });
    expect(
      screen.queryByText(/expressive directions are off/i),
    ).not.toBeInTheDocument();
  });

  it('[Turn on] dispatches setProsodyEnabled(true) and issues PUT with true', async () => {
    const { store } = renderCast({ characters: [char17b], prosodyEnabled: false });

    const turnOnBtn = screen.getByRole('button', { name: /turn on/i });
    fireEvent.click(turnOnBtn);

    // Redux store updated
    expect(store.getState().bookMeta.prosodyEnabled[BOOK_ID]).toBe(true);

    // Durable PUT issued
    await waitFor(() => {
      expect(putBookStateSpy).toHaveBeenCalledWith(BOOK_ID, {
        slice: 'state',
        patch: { prosodyEnabled: true },
      });
    });
  });

  it('[Turn on] makes the hint disappear (prosodyEnabled flips to true)', async () => {
    renderCast({ characters: [char17b], prosodyEnabled: false });

    expect(screen.getByText(/expressive directions are off/i)).toBeInTheDocument();

    const turnOnBtn = screen.getByRole('button', { name: /turn on/i });
    fireEvent.click(turnOnBtn);

    await waitFor(() => {
      expect(
        screen.queryByText(/expressive directions are off/i),
      ).not.toBeInTheDocument();
    });
  });

  it('the hint is dismissible without flipping the flag', async () => {
    renderCast({ characters: [char17b], prosodyEnabled: false });

    expect(screen.getByText(/expressive directions are off/i)).toBeInTheDocument();

    const dismissBtn = screen.getByRole('button', { name: /dismiss/i });
    fireEvent.click(dismissBtn);

    await waitFor(() => {
      expect(
        screen.queryByText(/expressive directions are off/i),
      ).not.toBeInTheDocument();
    });

    // Dismissing should NOT flip the prosodyEnabled flag or issue a PUT
    expect(putBookStateSpy).not.toHaveBeenCalled();
  });

  it('[Turn on] has a ≥44px touch target on phone', () => {
    renderCast({ characters: [char17b], prosodyEnabled: false });
    const turnOnBtn = screen.getByRole('button', { name: /turn on/i });
    expect(turnOnBtn.className).toMatch(/min-h-\[44px\]/);
  });
});
