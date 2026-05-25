/* Rebaseline modal (plan 108, Wave 5) — RTL tests.
 *   - default selection = the principal cast (≥80% of non-narrator lines;
 *     narrator excluded)
 *   - Propose renders one current-vs-proposed row per included character
 *   - Approve dispatches the series-scoped Qwen override for included rows
 *     (asserted via the mocked api.setVoiceOverride call shape)
 *   - per-character design failure is tolerated (row marked failed, others
 *     still proposed + approvable) */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { RebaselineModalContainer } from './rebaseline-modal';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { voicesSlice } from '../store/voices-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { rebaselineSlice } from '../store/rebaseline-slice';
import type { Character, Voice } from '../lib/types';

/* Mock the api surface the modal calls. designQwenVoice returns a derived
   voiceId per character; generateAllVoiceStyles returns an empty batch (the
   modal falls back to per-character generate); setVoiceOverride is the spy
   the approve test asserts on. */
const designQwenVoice = vi.fn(async (_bookId: string, characterId: string) => ({
  voiceId: `qwen-${characterId}`,
  previewUrl: `blob:${characterId}`,
}));
const generateVoiceStyle = vi.fn(async (_bookId: string, characterId: string) => ({
  voiceStyle: `persona for ${characterId}`,
}));
const generateAllVoiceStyles = vi.fn(async () => ({ voiceStyles: {}, failures: {} }));
const setVoiceOverride = vi.fn(async () => undefined);
const getBookState = vi.fn(async (_bookId: string) => null as unknown);

vi.mock('../lib/api', () => ({
  api: {
    designQwenVoice: (...args: unknown[]) => designQwenVoice(...(args as [string, string])),
    generateVoiceStyle: (...args: unknown[]) => generateVoiceStyle(...(args as [string, string])),
    generateAllVoiceStyles: () => generateAllVoiceStyles(),
    setVoiceOverride: (...args: unknown[]) => setVoiceOverride(...(args as [])),
    getBookState: (...args: unknown[]) => getBookState(...(args as [string])),
  },
}));

/* Audition uses the auto-load orchestrator + sample playback — stub both so
   no real audio / network is hit in jsdom. */
vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn(async () => ({ analyzerEvicted: false })),
}));
vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    currentUrl: null,
    isPlaying: false,
    play: vi.fn(async () => undefined),
    stop: vi.fn(),
    playUntilEnded: vi.fn(async () => ({ cancelled: false })),
  }),
}));

const char = (id: string, name: string, lines: number, role = 'role'): Character =>
  ({
    id,
    name,
    role,
    color: 'narrator',
    lines,
    attributes: [],
    voiceId: `voice-${id}`,
  }) as Character;

const voice = (id: string, characterId: string): Voice =>
  ({
    id,
    character: characterId,
    bookId: 'book-1',
    bookTitle: 'Book One',
    attributes: [],
    usedIn: 1,
    source: 'current',
    gradient: ['#000', '#fff'],
    ttsVoice: { provider: 'kokoro', name: 'af_heart', description: '' },
  }) as unknown as Voice;

/* `openBookId` sets the ui.stage to ready/<book> so the modal sees that book
   as the OPEN book. Pass 'book-1' (the default) for the open-book path (cast
   from redux, no fetch); pass a different id (or null) to exercise the
   foreign-book fetch path. */
function makeStore(
  characters: Character[],
  voices: Voice[],
  { openBookId = 'book-1' as string | null } = {},
) {
  const baseUi = { ...uiSlice.getInitialState(), rebaselineModalOpen: true };
  const ui =
    openBookId === null
      ? baseUi
      : {
          ...baseUi,
          stage: {
            kind: 'ready' as const,
            bookId: openBookId,
            view: 'cast' as const,
            currentChapterId: 1,
            openProfileId: null,
          },
        };
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      voices: voicesSlice.reducer,
      notifications: notificationsSlice.reducer,
      rebaseline: rebaselineSlice.reducer,
    },
    preloadedState: {
      ui,
      cast: { characters },
      voices: { ...voicesSlice.getInitialState(), voices },
    },
  });
}

/* Canonical cast: narrator dominates lines (excluded), Maerin + Marlow carry
   the bulk of dialogue, Bystander is a one-liner under the 80% threshold. */
const CHARACTERS = [
  char('narrator', 'Narrator', 500),
  char('Maerin', 'Maerin', 80),
  char('Marlow', 'Marlow', 60),
  char('bystander', 'Bystander', 1),
];
const VOICES = [voice('voice-Maerin', 'Maerin'), voice('voice-Marlow', 'Marlow')];

beforeEach(() => {
  designQwenVoice.mockClear();
  generateVoiceStyle.mockClear();
  generateAllVoiceStyles.mockClear();
  setVoiceOverride.mockClear();
  getBookState.mockClear();
  getBookState.mockResolvedValue(null);
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('RebaselineModal — default selection', () => {
  it('pre-selects the principal cast and excludes the narrator', () => {
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    const sel = store.getState().rebaseline.selectedCharacterIds;
    expect(sel).toContain('Maerin');
    expect(sel).toContain('Marlow');
    expect(sel).not.toContain('narrator');
    // The narrator row renders (toggleable on) but is unchecked by default.
    const narratorRow = screen.getByLabelText('Rebaseline Narrator') as HTMLInputElement;
    expect(narratorRow.checked).toBe(false);
    const MaerinRow = screen.getByLabelText('Rebaseline Maerin') as HTMLInputElement;
    expect(MaerinRow.checked).toBe(true);
  });

  it('renders nothing without a bookId (global voices tab)', () => {
    const store = makeStore(CHARACTERS, VOICES);
    const { container } = render(
      <Provider store={store}>
        <RebaselineModalContainer bookId={null} />
      </Provider>,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe('RebaselineModal — cast sourcing', () => {
  it('uses redux characters without fetching when the target IS the open book', async () => {
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    /* Open-book path: the principal cast seeds from redux and getBookState
       is never called. */
    await waitFor(() => {
      expect(store.getState().rebaseline.selectedCharacterIds).toContain('Maerin');
    });
    expect(getBookState).not.toHaveBeenCalled();
  });

  it('fetches the target series cast via api.getBookState when it is NOT the open book', async () => {
    /* A DIFFERENT series cast lives in book-2 — the modal must fetch it and
       seed the principal cast from it, not from the open book's redux cast
       (which would be book-1's). */
    getBookState.mockResolvedValue({
      cast: {
        characters: [
          char('narrator', 'Narrator', 400),
          char('Brann', 'Brann', 90),
          char('Hart', 'Hart', 70),
        ],
      },
    });
    /* Open book is book-1, but the modal targets book-2. */
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-2" />
      </Provider>,
    );
    await waitFor(() => expect(getBookState).toHaveBeenCalledWith('book-2'));
    /* The principal cast is seeded from book-2's fetched cast (Brann + Hart),
       NOT the open book's redux cast (Maerin + Marlow). */
    await waitFor(() => {
      const sel = store.getState().rebaseline.selectedCharacterIds;
      expect(sel).toContain('Brann');
      expect(sel).toContain('Hart');
      expect(sel).not.toContain('Maerin');
      expect(sel).not.toContain('narrator');
    });
    /* The fetched cast's rows render in the setup step. */
    expect(screen.getByLabelText('Rebaseline Brann')).toBeInTheDocument();
  });
});

describe('RebaselineModal — propose', () => {
  it('renders a current-vs-proposed row per selected character', async () => {
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rebaseline-proposal-Maerin')).toBeInTheDocument();
      expect(screen.getByTestId('rebaseline-proposal-Marlow')).toBeInTheDocument();
    });
    // Both a current + proposed audition button per row.
    expect(screen.getByTestId('rebaseline-play-current-Maerin')).toBeInTheDocument();
    expect(screen.getByTestId('rebaseline-play-proposed-Maerin')).toBeInTheDocument();
    // The design call fired once per selected character.
    expect(designQwenVoice).toHaveBeenCalledTimes(2);
    expect(store.getState().rebaseline.proposals.Maerin.proposedVoiceId).toBe('qwen-Maerin');
  });
});

describe('RebaselineModal — approve', () => {
  it('writes a series-scoped Qwen override for each included character', async () => {
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(screen.getByTestId('rebaseline-approve')).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    await waitFor(() => expect(setVoiceOverride).toHaveBeenCalledTimes(2));
    // Assert the call shape: keyed by the character's library voiceId,
    // engine qwen + designed voiceId, scope series + the anchor bookId.
    const calls = setVoiceOverride.mock.calls as unknown as Array<
      [string, { engine: string; name: string }, { scope: string; bookId: string }]
    >;
    const MaerinCall = calls.find((c) => c[1].name === 'qwen-Maerin');
    expect(MaerinCall).toBeTruthy();
    expect(MaerinCall![0]).toBe('voice-Maerin');
    expect(MaerinCall![1]).toEqual({ engine: 'qwen', name: 'qwen-Maerin' });
    expect(MaerinCall![2]).toEqual({ scope: 'series', bookId: 'book-1' });
    // The cast slice mirrors the engine + override.
    const Maerin = store.getState().cast.characters.find((c) => c.id === 'Maerin')!;
    expect(Maerin.ttsEngine).toBe('qwen');
    expect(Maerin.overrideTtsVoices?.qwen?.name).toBe('qwen-Maerin');
    // Success toast fired with the count.
    const toast = store
      .getState()
      .notifications.toasts.find((t) => t.message.includes('Rebaselined 2 characters'));
    expect(toast).toBeTruthy();
  });

  it('untickling a row excludes it from the approve write', async () => {
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(screen.getByTestId('rebaseline-include-Marlow')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-include-Marlow'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    await waitFor(() => expect(setVoiceOverride).toHaveBeenCalledTimes(1));
    const calls = setVoiceOverride.mock.calls as unknown as Array<[string, { name: string }]>;
    expect(calls[0][1].name).toBe('qwen-Maerin');
  });
});

describe('RebaselineModal — per-character failure', () => {
  it('marks a failed row and still proposes + approves the others', async () => {
    designQwenVoice.mockImplementation(async (_bookId: string, characterId: string) => {
      if (characterId === 'Marlow') throw new Error('sidecar down');
      return { voiceId: `qwen-${characterId}`, previewUrl: `blob:${characterId}` };
    });
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => {
      expect(store.getState().rebaseline.proposals.Marlow.status).toBe('failed');
      expect(store.getState().rebaseline.proposals.Maerin.status).toBe('ready');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    // Only the surviving row is written.
    await waitFor(() => expect(setVoiceOverride).toHaveBeenCalledTimes(1));
    const calls = setVoiceOverride.mock.calls as unknown as Array<[string, { name: string }]>;
    expect(calls[0][1].name).toBe('qwen-Maerin');
  });
});
