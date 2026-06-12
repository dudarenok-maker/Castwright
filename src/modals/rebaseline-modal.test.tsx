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
const setVoiceOverrideLinked = vi.fn(async (_bookId: string, characterId: string) => ({
  canonicalVoiceId: `v_${characterId}`,
  updated: [],
  failed: [],
}));
const getBookState = vi.fn(async (_bookId: string) => null as unknown);
/* The whole-series aggregation fetch. Default: no series-mates (single-book
   workspace), so the modal works from the anchor cast alone — the pre-
   aggregation baseline. Individual tests override it to inject siblings. */
const getSeriesCast = vi.fn(async (_bookId: string) => ({ characters: [] as Character[] }));

vi.mock('../lib/api', () => ({
  api: {
    designQwenVoice: (...args: unknown[]) => designQwenVoice(...(args as [string, string])),
    generateVoiceStyle: (...args: unknown[]) => generateVoiceStyle(...(args as [string, string])),
    generateAllVoiceStyles: () => generateAllVoiceStyles(),
    setVoiceOverrideLinked: (...args: unknown[]) =>
      setVoiceOverrideLinked(...(args as [string, string])),
    getBookState: (...args: unknown[]) => getBookState(...(args as [string])),
    getSeriesCast: (...args: unknown[]) => getSeriesCast(...(args as [string])),
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
  char('maerin', 'Maerin', 80),
  char('marlow', 'Marlow', 60),
  char('bystander', 'Bystander', 1),
];
const VOICES = [voice('voice-maerin', 'maerin'), voice('voice-marlow', 'marlow')];

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
  setVoiceOverrideLinked.mockClear();
  getBookState.mockClear();
  getBookState.mockResolvedValue(null);
  getSeriesCast.mockClear();
  /* Restore the default (no series-mates) so a prior test's injected
     siblings can't leak across the file. */
  getSeriesCast.mockResolvedValue({ characters: [] });
});

/* Seeding the default selection now waits on the async series-cast
   aggregation, so the Propose button stays disabled until the principal
   cast resolves. Await this before clicking Propose. */
async function waitForReady(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('rebaseline-propose')).not.toBeDisabled());
}

afterEach(() => {
  vi.clearAllMocks();
});

describe('RebaselineModal — default selection', () => {
  it('pre-selects the principal cast and excludes the narrator', async () => {
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitFor(() => {
      const sel = store.getState().rebaseline.selectedCharacterIds;
      expect(sel).toContain('maerin');
      expect(sel).toContain('marlow');
      expect(sel).not.toContain('narrator');
    });
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
  it('uses redux characters for the anchor (no getBookState) when the target IS the open book', async () => {
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    /* Open-book path: the anchor cast comes from redux (getBookState is never
       called). The series aggregation still fetches its series-mates. */
    await waitFor(() => {
      expect(store.getState().rebaseline.selectedCharacterIds).toContain('maerin');
    });
    expect(getBookState).not.toHaveBeenCalled();
    expect(getSeriesCast).toHaveBeenCalledWith('book-1');
  });

  it('fetches the target series cast via api.getBookState when it is NOT the open book', async () => {
    /* A DIFFERENT series cast lives in book-2 — the modal must fetch it and
       seed the principal cast from it, not from the open book's redux cast
       (which would be book-1's). */
    getBookState.mockResolvedValue({
      cast: {
        characters: [
          char('narrator', 'Narrator', 400),
          char('brann', 'Brann', 90),
          char('hart', 'Hart', 70),
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
      expect(sel).toContain('brann');
      expect(sel).toContain('hart');
      expect(sel).not.toContain('maerin');
      expect(sel).not.toContain('narrator');
    });
    /* The fetched cast's rows render in the setup step. */
    expect(screen.getByLabelText('Rebaseline Brann')).toBeInTheDocument();
  });
});

describe('RebaselineModal — whole-series aggregation', () => {
  it('lists characters from other series books and pre-selects by SERIES-total lines', async () => {
    /* Open book (book-1) has Maerin(80) + Marlow(60). The series-cast fetch adds
       a recurring Maerin entry from a later volume (same voiceId → merges +
       sums lines to 380) and Pell(250), who never appears in book-1. With the
       aggregation, the principal cast is Maerin + Pell (covering ≥80% of the
       691 non-narrator series lines), and Marlow drops below the threshold —
       proving the default selection is series-wide, not one book's. */
    getSeriesCast.mockResolvedValue({
      characters: [
        { ...char('maerin-b2', 'Maerin', 300), voiceId: 'voice-maerin' } as Character,
        { ...char('pell', 'Pell', 250), voiceId: 'voice-pell' } as Character,
      ],
    });
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitFor(() => expect(getSeriesCast).toHaveBeenCalledWith('book-1'));
    /* Pell — who is in no book-1 cast — is now a selectable row. */
    await waitFor(() => expect(screen.getByLabelText('Rebaseline Pell')).toBeInTheDocument());
    await waitFor(() => {
      const sel = store.getState().rebaseline.selectedCharacterIds;
      expect(sel).toContain('maerin'); // anchor identity kept (not maerin-b2)
      expect(sel).toContain('pell');
      expect(sel).not.toContain('marlow'); // dropped below 80% once Pell's lines count
      expect(sel).not.toContain('narrator');
    });
  });

  it('collapses a divergent-id same-name sibling into ONE row (plan 122 name/alias)', async () => {
    /* Anchor book-1 has "Maerin" (id 'maerin'). A later volume detected her as
       "Maerin Vell" (different id, NO shared voiceId) — divergent write key.
       Name/alias collapse must fold her into the single anchor row, NOT render
       a second "Maerin Vell" row. */
    getSeriesCast.mockResolvedValue({
      characters: [{ ...char('maerin-Vell', 'Maerin Vell', 200), sourceBookId: 'book-2' } as Character],
    });
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitFor(() => expect(getSeriesCast).toHaveBeenCalledWith('book-1'));
    /* getByLabelText throws if there were two "Maerin" rows — single row proves
       the collapse; the divergent-id name never spawns its own row. */
    await waitFor(() => expect(screen.getByLabelText('Rebaseline Maerin')).toBeInTheDocument());
    expect(screen.queryByLabelText('Rebaseline Maerin Vell')).toBeNull();
  });

  it('keeps a notLinkedTo sibling as a SEPARATE row (auto-collapse escape hatch)', async () => {
    getSeriesCast.mockResolvedValue({
      characters: [
        {
          ...char('maerin-Vell', 'Maerin Vell', 200),
          sourceBookId: 'book-2',
          notLinkedTo: [{ bookId: 'book-1', characterId: 'maerin' }],
        } as Character,
      ],
    });
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitFor(() => expect(getSeriesCast).toHaveBeenCalledWith('book-1'));
    /* The user marked them intentionally different → both rows remain. */
    await waitFor(() => expect(screen.getByLabelText('Rebaseline Maerin Vell')).toBeInTheDocument());
    expect(screen.getByLabelText('Rebaseline Maerin')).toBeInTheDocument();
  });

  it('falls back to the anchor cast when the series-cast fetch fails', async () => {
    getSeriesCast.mockRejectedValue(new Error('scan blew up'));
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    /* Degrades gracefully: the modal still seeds from the open book's cast. */
    await waitFor(() => {
      const sel = store.getState().rebaseline.selectedCharacterIds;
      expect(sel).toContain('maerin');
      expect(sel).toContain('marlow');
    });
    expect(screen.getByTestId('rebaseline-propose')).not.toBeDisabled();
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
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => {
      expect(screen.getByTestId('rebaseline-proposal-maerin')).toBeInTheDocument();
      expect(screen.getByTestId('rebaseline-proposal-marlow')).toBeInTheDocument();
    });
    // Both a current + proposed audition button per row.
    expect(screen.getByTestId('rebaseline-play-current-maerin')).toBeInTheDocument();
    expect(screen.getByTestId('rebaseline-play-proposed-maerin')).toBeInTheDocument();
    // The design call fired once per selected character.
    expect(designQwenVoice).toHaveBeenCalledTimes(2);
    expect(store.getState().rebaseline.proposals.maerin.proposedVoiceId).toBe('qwen-maerin');
    // Personas are generated per-character (these two lack one) — never via
    // the batch endpoint, which would rebuild every persona on the server.
    expect(generateAllVoiceStyles).not.toHaveBeenCalled();
  });

  it('reuses an existing persona and only generates the missing one', async () => {
    /* maerin already carries a persona (e.g. from a prior session); marlow does
       not. Re-proposing must NOT regenerate maerin's — it reuses the string and
       only fills marlow's gap. */
    const withPersona = [
      char('narrator', 'Narrator', 500),
      { ...char('maerin', 'Maerin', 80), voiceStyle: 'an existing, hand-tuned persona' } as Character,
      char('marlow', 'Marlow', 60),
      char('bystander', 'Bystander', 1),
    ];
    const store = makeStore(withPersona, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(store.getState().rebaseline.proposals.marlow.status).toBe('ready'));
    // No batch regenerate; the per-character generator ran ONLY for marlow.
    expect(generateAllVoiceStyles).not.toHaveBeenCalled();
    expect(generateVoiceStyle).toHaveBeenCalledTimes(1);
    expect(generateVoiceStyle).toHaveBeenCalledWith('book-1', 'marlow');
    // maerin's reused persona is carried through verbatim onto the proposal.
    expect(store.getState().rebaseline.proposals.maerin.persona).toBe(
      'an existing, hand-tuned persona',
    );
  });
});

describe('RebaselineModal — design progress indicators', () => {
  it('shows queued + designing badges and a live progress count while voices design', async () => {
    /* Hold maerin's design open so we can observe the mid-flight state: the
       sequential loop has maerin 'designing' while marlow waits as 'pending'.
       Without these indicators the queued rows render blank and the modal
       looks frozen (the bug this guards). */
    let releaseMaerin: () => void = () => {};
    designQwenVoice.mockImplementation((_bookId: string, characterId: string) =>
      characterId === 'maerin'
        ? new Promise<{ voiceId: string; previewUrl: string }>((resolve) => {
            releaseMaerin = () => resolve({ voiceId: 'qwen-maerin', previewUrl: 'blob:maerin' });
          })
        : Promise.resolve({ voiceId: `qwen-${characterId}`, previewUrl: `blob:${characterId}` }),
    );
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    // maerin is mid-design; marlow is queued behind it.
    await waitFor(() => {
      expect(store.getState().rebaseline.proposals.maerin.status).toBe('designing');
    });
    expect(store.getState().rebaseline.proposals.marlow.status).toBe('pending');

    // The active row reads "Designing voice…"; the queued row reads "Queued…".
    const MaerinRow = screen.getByTestId('rebaseline-proposal-maerin');
    const MarlowRow = screen.getByTestId('rebaseline-proposal-marlow');
    expect(within(MaerinRow).getByText(/Designing voice…/)).toBeInTheDocument();
    expect(within(MarlowRow).getAllByText(/Queued…/).length).toBeGreaterThan(0);

    // Footer progress count is live and reads 0 settled of 2 selected.
    expect(screen.getByTestId('rebaseline-progress')).toHaveTextContent(
      'Designing voices… (0 of 2)',
    );

    // Releasing maerin drains the run; the modal leaves the busy state.
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
    await waitForReady();
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
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(store.getState().rebaseline.status).toBe('proposed'));
    expect(designQwenVoice).toHaveBeenCalledTimes(2);

    // Hold the NEXT design (maerin's re-design) open, then fire two re-designs
    // back-to-back. The second must QUEUE, not fire concurrently.
    let release: () => void = () => {};
    designQwenVoice.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ voiceId: 'qwen-maerin-v2', previewUrl: 'blob:Maerin2' });
        }),
    );
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-redesign-maerin'));
      fireEvent.click(screen.getByTestId('rebaseline-redesign-marlow'));
    });
    // maerin is designing (held); marlow is queued behind it — only maerin's
    // re-design call has fired (2 from propose + 1).
    await waitFor(() =>
      expect(store.getState().rebaseline.proposals.maerin.status).toBe('designing'),
    );
    expect(store.getState().rebaseline.proposals.marlow.status).toBe('pending');
    expect(designQwenVoice).toHaveBeenCalledTimes(3);

    // Releasing maerin lets marlow's re-design run next (serial drain).
    await act(async () => {
      release();
    });
    await waitFor(() => expect(designQwenVoice).toHaveBeenCalledTimes(4));
    expect(store.getState().rebaseline.proposals.marlow.status).toBe('ready');
    expect(store.getState().rebaseline.proposals.maerin.proposedVoiceId).toBe('qwen-maerin-v2');
  });
});

describe('RebaselineModal — reuse already-approved voices', () => {
  it('keeps a character already on Qwen, reuses one on the wrong engine, designs the rest', async () => {
    const cast = [
      char('narrator', 'Narrator', 500),
      // Already on its bespoke Qwen voice HERE → unchanged: no design, no write.
      {
        ...char('maerin', 'Maerin', 90),
        ttsEngine: 'qwen',
        overrideTtsVoices: { qwen: { name: 'qwen-maerin-approved' } },
      } as Character,
      // Has an approved Qwen voice (from another book) but the WRONG engine in
      // this book → reuse it, no re-design, but written on approve to fix it.
      {
        ...char('hart', 'Hart', 80),
        overrideTtsVoices: { qwen: { name: 'qwen-hart-approved' } },
      } as Character,
      // No Qwen voice → designed fresh.
      char('marlow', 'Marlow', 70),
    ];
    const voices = [
      voice('voice-maerin', 'maerin'),
      voice('voice-hart', 'hart'),
      voice('voice-marlow', 'marlow'),
    ];
    const store = makeStore(cast, voices);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(store.getState().rebaseline.status).toBe('proposed'));

    const props = store.getState().rebaseline.proposals;
    expect(props.maerin.status).toBe('unchanged');
    expect(props.maerin.proposedVoiceId).toBe('qwen-maerin-approved');
    expect(props.hart).toMatchObject({ status: 'ready', proposedVoiceId: 'qwen-hart-approved' });
    expect(props.marlow).toMatchObject({ status: 'ready', proposedVoiceId: 'qwen-marlow' });
    // ONLY the character without a Qwen voice was designed — the approved
    // voices are reused, never rebuilt.
    expect(designQwenVoice).toHaveBeenCalledTimes(1);
    expect(designQwenVoice).toHaveBeenCalledWith(
      'book-1',
      'marlow',
      expect.objectContaining({
        persona: expect.any(String),
        sampleVoiceId: expect.any(String),
        modelKey: 'qwen3-tts-0.6b',
      }),
    );
    // The unchanged row offers no include checkbox (nothing to do).
    expect(screen.queryByTestId('rebaseline-include-maerin')).toBeNull();

    // Approve writes Hart (reused) + Marlow (designed), NOT Maerin (unchanged).
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    await waitFor(() => expect(setVoiceOverrideLinked).toHaveBeenCalledTimes(2));
    const names = (
      setVoiceOverrideLinked.mock.calls as unknown as Array<[string, string, { name: string }]>
    ).map((c) => c[2].name);
    expect(names).toContain('qwen-hart-approved');
    expect(names).toContain('qwen-marlow');
    expect(names).not.toContain('qwen-maerin-approved');
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
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(screen.getByTestId('rebaseline-approve')).not.toBeDisabled());
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    await waitFor(() => expect(setVoiceOverrideLinked).toHaveBeenCalledTimes(2));
    // Assert the call shape: the name/alias-aware write is keyed by the rep's
    // HOME book + character id (plan 122 — the server rediscovers the group
    // and unifies voiceId), with the qwen engine + designed voiceId.
    const calls = setVoiceOverrideLinked.mock.calls as unknown as Array<
      [string, string, { engine: string; name: string }]
    >;
    const MaerinCall = calls.find((c) => c[2].name === 'qwen-maerin');
    expect(MaerinCall).toBeTruthy();
    expect(MaerinCall![0]).toBe('book-1'); // home book (anchor = open book)
    expect(MaerinCall![1]).toBe('maerin'); // character id
    expect(MaerinCall![2]).toEqual({ engine: 'qwen', name: 'qwen-maerin' });
    // The cast slice mirrors the engine + override.
    const maerin = store.getState().cast.characters.find((c) => c.id === 'maerin')!;
    expect(maerin.ttsEngine).toBe('qwen');
    expect(maerin.overrideTtsVoices?.qwen?.name).toBe('qwen-maerin');
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
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(screen.getByTestId('rebaseline-include-marlow')).toBeInTheDocument());
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-include-marlow'));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    await waitFor(() => expect(setVoiceOverrideLinked).toHaveBeenCalledTimes(1));
    const calls = setVoiceOverrideLinked.mock.calls as unknown as Array<
      [string, string, { name: string }]
    >;
    expect(calls[0][2].name).toBe('qwen-maerin');
  });
});

describe('RebaselineModal — per-character failure', () => {
  it('marks a failed row and still proposes + approves the others', async () => {
    designQwenVoice.mockImplementation(async (_bookId: string, characterId: string) => {
      if (characterId === 'marlow') throw new Error('sidecar down');
      return { voiceId: `qwen-${characterId}`, previewUrl: `blob:${characterId}` };
    });
    const store = makeStore(CHARACTERS, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => {
      expect(store.getState().rebaseline.proposals.marlow.status).toBe('failed');
      expect(store.getState().rebaseline.proposals.maerin.status).toBe('ready');
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    // Only the surviving row is written.
    await waitFor(() => expect(setVoiceOverrideLinked).toHaveBeenCalledTimes(1));
    const calls = setVoiceOverrideLinked.mock.calls as unknown as Array<
      [string, string, { name: string }]
    >;
    expect(calls[0][2].name).toBe('qwen-maerin');
  });
});
