/* Rebaseline modal (plan 108, Wave 5) — RTL tests.
 *   - default selection = the principal cast (≥80% of non-narrator lines;
 *     narrator excluded)
 *   - Propose renders one current-vs-proposed row per included character
 *   - Approve dispatches the series-scoped Qwen override for included rows
 *     (asserted via the mocked api.setVoiceOverride call shape)
 *   - per-character design failure is tolerated (row marked failed, others
 *     still proposed + approvable) */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, waitFor, within } from '@testing-library/react';
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
   voiceId per character; generateVoiceStyle is the per-character persona
   generator (the modal generates a persona only for a character missing one);
   generateAllVoiceStyles is kept as a spy purely to assert the modal no longer
   batch-regenerates personas; setVoiceOverride is the spy the approve test
   asserts on. */
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
  /* Restore the default resolve so a prior test's bespoke implementation
     (e.g. the held-open or throwing variants) can't leak across the file. */
  designQwenVoice.mockImplementation(async (_bookId: string, characterId: string) => ({
    voiceId: `qwen-${characterId}`,
    previewUrl: `blob:${characterId}`,
  }));
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
    // Personas are generated per-character (these two lack one) — never via
    // the batch endpoint, which would rebuild every persona on the server.
    expect(generateAllVoiceStyles).not.toHaveBeenCalled();
  });

  it('reuses an existing persona and only generates the missing one', async () => {
    /* Maerin already carries a persona (e.g. from a prior session); Marlow does
       not. Re-proposing must NOT regenerate Maerin's — it reuses the string and
       only fills Marlow's gap. */
    const withPersona = [
      char('narrator', 'Narrator', 500),
      { ...char('Maerin', 'Maerin', 80), voiceStyle: 'an existing, hand-tuned persona' } as Character,
      char('Marlow', 'Marlow', 60),
      char('bystander', 'Bystander', 1),
    ];
    const store = makeStore(withPersona, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(store.getState().rebaseline.proposals.Marlow.status).toBe('ready'));
    // No batch regenerate; the per-character generator ran ONLY for Marlow.
    expect(generateAllVoiceStyles).not.toHaveBeenCalled();
    expect(generateVoiceStyle).toHaveBeenCalledTimes(1);
    expect(generateVoiceStyle).toHaveBeenCalledWith('book-1', 'Marlow');
    // Maerin's reused persona is carried through verbatim onto the proposal.
    expect(store.getState().rebaseline.proposals.Maerin.persona).toBe(
      'an existing, hand-tuned persona',
    );
  });
});

describe('RebaselineModal — design progress indicators', () => {
  it('shows queued + designing badges and a live progress count while voices design', async () => {
    /* Hold Maerin's design open so we can observe the mid-flight state: the
       sequential loop has Maerin 'designing' while Marlow waits as 'pending'.
       Without these indicators the queued rows render blank and the modal
       looks frozen (the bug this guards). */
    let releaseMaerin: () => void = () => {};
    designQwenVoice.mockImplementation((_bookId: string, characterId: string) =>
      characterId === 'Maerin'
        ? new Promise<{ voiceId: string; previewUrl: string }>((resolve) => {
            releaseMaerin = () => resolve({ voiceId: 'qwen-Maerin', previewUrl: 'blob:Maerin' });
          })
        : Promise.resolve({ voiceId: `qwen-${characterId}`, previewUrl: `blob:${characterId}` }),
    );
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    // Maerin is mid-design; Marlow is queued behind it.
    await waitFor(() => {
      expect(store.getState().rebaseline.proposals.Maerin.status).toBe('designing');
    });
    expect(store.getState().rebaseline.proposals.Marlow.status).toBe('pending');

    // The active row reads "Designing voice…"; the queued row reads "Queued…".
    const MaerinRow = screen.getByTestId('rebaseline-proposal-Maerin');
    const MarlowRow = screen.getByTestId('rebaseline-proposal-Marlow');
    expect(within(MaerinRow).getByText(/Designing voice…/)).toBeInTheDocument();
    expect(within(MarlowRow).getAllByText(/Queued…/).length).toBeGreaterThan(0);

    // Footer progress count is live and reads 0 settled of 2 selected.
    expect(screen.getByTestId('rebaseline-progress')).toHaveTextContent(
      'Designing voices… (0 of 2)',
    );

    // Releasing Maerin drains the run; the modal leaves the busy state.
    await act(async () => {
      releaseMaerin();
    });
    await waitFor(() => expect(store.getState().rebaseline.status).toBe('proposed'));
  });
});

describe('RebaselineModal — design order', () => {
  it('renders + designs top-to-bottom by line count, not alphabetically', async () => {
    /* aria sorts FIRST alphabetically but has FEWER lines than zane; both clear
       the 80% principal threshold, so both are selected. Top-to-bottom must be
       zane (most lines) → aria, NOT the alphabetical aria → zane. */
    const cast = [
      char('narrator', 'Narrator', 500),
      char('aria', 'Aria', 100),
      char('zane', 'Zane', 120),
    ];
    const voices = [voice('voice-aria', 'aria'), voice('voice-zane', 'zane')];
    const store = makeStore(cast, voices);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(store.getState().rebaseline.status).toBe('proposed'));
    // Rendered row order: line-count desc (zane above aria). The modal portals
    // into document.body, so query there rather than the render container.
    const ids = Array.from(
      document.body.querySelectorAll('[data-testid^="rebaseline-proposal-"]'),
    ).map((el) => el.getAttribute('data-testid'));
    expect(ids).toEqual(['rebaseline-proposal-zane', 'rebaseline-proposal-aria']);
    // Designed in the same top-to-bottom order.
    const designOrder = designQwenVoice.mock.calls.map((c) => c[1]);
    expect(designOrder).toEqual(['zane', 'aria']);
  });
});

describe('RebaselineModal — serial design queue', () => {
  it('Re-design joins the queue behind an in-flight design instead of firing concurrently', async () => {
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    // Let the initial propose settle so both rows are ready (2 design calls).
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(store.getState().rebaseline.status).toBe('proposed'));
    expect(designQwenVoice).toHaveBeenCalledTimes(2);

    // Hold the NEXT design (Maerin's re-design) open, then fire two re-designs
    // back-to-back. The second must QUEUE, not fire concurrently.
    let release: () => void = () => {};
    designQwenVoice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ voiceId: 'qwen-Maerin-v2', previewUrl: 'blob:Maerin2' });
        }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-redesign-Maerin'));
      fireEvent.click(screen.getByTestId('rebaseline-redesign-Marlow'));
    });
    // Maerin is designing (held); Marlow is queued behind it — only Maerin's
    // re-design call has fired (2 from propose + 1).
    await waitFor(() =>
      expect(store.getState().rebaseline.proposals.Maerin.status).toBe('designing'),
    );
    expect(store.getState().rebaseline.proposals.Marlow.status).toBe('pending');
    expect(designQwenVoice).toHaveBeenCalledTimes(3);

    // Releasing Maerin lets Marlow's re-design run next (serial drain).
    await act(async () => {
      release();
    });
    await waitFor(() => expect(designQwenVoice).toHaveBeenCalledTimes(4));
    expect(store.getState().rebaseline.proposals.Marlow.status).toBe('ready');
    expect(store.getState().rebaseline.proposals.Maerin.proposedVoiceId).toBe('qwen-Maerin-v2');
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
