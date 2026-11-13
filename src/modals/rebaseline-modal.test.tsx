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
import { persistenceMiddleware } from '../store/persistence-middleware';
import { RebaselineModalContainer } from './rebaseline-modal';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { voicesSlice } from '../store/voices-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { rebaselineSlice } from '../store/rebaseline-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { chaptersSlice } from '../store/chapters-slice';
import { accountSlice } from '../store/account-slice';
import { configSlice } from '../store/config-slice';
import { haltActiveGeneration } from '../store/queue-thunks';
import { seedSameCardPersona } from '../test/seed-same-card-persona';
import type { Character, Voice } from '../lib/types';

/* The guard's Confirm dispatches haltActiveGeneration; stub it to a plain action so the test asserts the call. */
vi.mock('../store/queue-thunks', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/queue-thunks')>()),
  haltActiveGeneration: vi.fn(() => ({ type: 'test/haltActiveGeneration' })),
}));

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
const setVoiceOverrideLinked = vi.fn(
  async (
    _bookId: string,
    characterId: string,
  ): Promise<{
    canonicalVoiceId: string;
    updated: Array<{ bookId: string; bookTitle: string; characterId: string }>;
    failed: Array<{ bookId: string; bookTitle: string; error: string }>;
  }> => ({
    canonicalVoiceId: `v_${characterId}`,
    updated: [],
    failed: [],
  }),
);
const getBookState = vi.fn(async (_bookId: string, _signal?: AbortSignal) => null as unknown);
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
    getBookState: (...args: unknown[]) => getBookState(...(args as [string, AbortSignal?])),
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
  {
    openBookId = 'book-1' as string | null,
    loadedBookId = openBookId,
    readOnly = false,
  }: { openBookId?: string | null; loadedBookId?: string | null; readOnly?: boolean } = {},
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
  const store = configureStore({
    middleware: (gDM) => (readOnly ? gDM().concat(persistenceMiddleware) : gDM()),
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      voices: voicesSlice.reducer,
      notifications: notificationsSlice.reducer,
      rebaseline: rebaselineSlice.reducer,
      chapters: chaptersSlice.reducer,
      account: accountSlice.reducer,
      config: configSlice.reducer,
      manuscript: manuscriptSlice.reducer,
    },
    preloadedState: {
      ui,
      cast: { characters },
      voices: { ...voicesSlice.getInitialState(), voices },
      /* The book the cast/manuscript slices HOLD — independent of the stage (the
         global #/voices page loads a book in memory with none on screen). */
      manuscript: { ...manuscriptSlice.getInitialState(), bookId: loadedBookId },
    },
  });
  /* Plan 291 (#4031) - a latched analysis era makes the book's cast read-only. */
  if (readOnly && openBookId) store.dispatch(castSlice.actions.latchAnalysisEra({ bookId: openBookId }));
  return store;
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
  setVoiceOverrideLinked.mockImplementation(async (_bookId: string, characterId: string) => ({
    canonicalVoiceId: `v_${characterId}`,
    updated: [],
    failed: [],
  }));
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
    const maerinRow = screen.getByLabelText('Rebaseline Maerin') as HTMLInputElement;
    expect(maerinRow.checked).toBe(true);
  });

  it('excludes a char-narrator id — the promoted-cast-row twin of "narrator" (#1895)', async () => {
    // Name deliberately does NOT literal-match "Narrator" — isolates the
    // id-based branch of isNarrator from its by-name fallback.
    const charNarratorCast = [
      char('char-narrator', 'The Storyteller', 500),
      char('maerin', 'Maerin', 80),
      char('marlow', 'Marlow', 60),
    ];
    const store = makeStore(charNarratorCast, VOICES);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitFor(() => {
      const sel = store.getState().rebaseline.selectedCharacterIds;
      expect(sel).toContain('maerin');
      expect(sel).not.toContain('char-narrator');
    });
    // The char-narrator row renders with the "Narrator" badge — proof this
    // modal's OWN isNarrator (used for row grouping, not the selection
    // above) also recognises the id via the shared constant, not just
    // principal-cast.ts's copy.
    const narratorRow = screen.getByTestId('rebaseline-row-char-narrator');
    expect(within(narratorRow).getByText('Narrator')).toBeInTheDocument();
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
    await waitFor(() => expect(getBookState).toHaveBeenCalledWith('book-2', expect.any(AbortSignal)));
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
      characters: [{ ...char('maerin-vell', 'Maerin Vell', 200), sourceBookId: 'book-2' } as Character],
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
          ...char('maerin-vell', 'Maerin Vell', 200),
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

describe('RebaselineModal — stale emotion variants (#4040)', () => {
  it('prunes the variants the server dropped after a base design, on rows sharing the voice key', async () => {
    /* maerin + marlow have no Qwen voice, so Propose designs them (a non-preview
       design that lands a fresh base rev). bystander + twin are NOT designed here,
       but share the redesigned voice key and carry variants minted from the old base. */
    const withAngry = (c: Character): Character =>
      ({
        ...c,
        ttsEngine: 'qwen',
        voiceUuid: 'shared',
        overrideTtsVoices: { qwen: { name: 'qwen-shared', variants: { angry: { name: 'qwen-shared__angry' } } } },
      }) as Character;
    /* maerin + marlow (designed here) share the voice key with bystander + twin. */
    const store = makeStore(
      [
        CHARACTERS[0],
        { ...CHARACTERS[1], voiceUuid: 'shared' } as Character,
        { ...CHARACTERS[2], voiceUuid: 'shared' } as Character,
        withAngry(CHARACTERS[3]),
        withAngry(char('twin', 'Twin', 1)),
      ],
      VOICES,
    );
    store.dispatch(
      manuscriptSlice.actions.uploadComplete({ manuscriptId: 'mns_b1', title: 't', format: 'md', wordCount: 1, sourceText: '' } as never),
    );
    /* The server's /state dropped the now-stale variants from both rows. */
    getBookState.mockResolvedValue({
      state: { manuscriptId: 'mns_b1' },
      cast: {
        characters: ['bystander', 'twin'].map((id) => ({
          id,
          overrideTtsVoices: { qwen: { name: 'qwen-shared' } },
        })),
      },
    });
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
      for (const id of ['bystander', 'twin']) {
        const c = store.getState().cast.characters.find((x) => x.id === id);
        expect(c?.overrideTtsVoices?.qwen?.variants).toBeUndefined();
      }
    });
    expect(designQwenVoice).toHaveBeenCalled();
    expect(store.getState().cast.characters.find((x) => x.id === 'twin')?.overrideTtsVoices?.qwen?.name).toBe(
      'qwen-shared',
    );
  });
});

describe('RebaselineModal — a series rebaseline of a non-loaded book leaves the loaded cast alone', () => {
  const run = async (targetBookId: string, openBookId: string) => {
    /* The target book's cast shares character ids with the loaded book (series
       books share ids) but carries no persona, so Propose generates one. */
    getBookState.mockResolvedValue({
      cast: { characters: [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 90)] },
    });
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId },
    );
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId={targetBookId} />
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
    await waitFor(() => expect(setVoiceOverrideLinked).toHaveBeenCalled());
    await waitFor(() => expect(store.getState().rebaseline.status).not.toBe('approving'));
    return store.getState().cast.characters.find((c) => c.id === 'marlow')!;
  };

  it('does not write the persona or the override into the loaded book (design + approve)', async () => {
    const marlow = await run('book-2', 'book-1');
    expect(generateVoiceStyle).toHaveBeenCalledWith('book-2', 'marlow');
    expect(marlow.voiceStyle).toBeUndefined();
    expect(marlow.ttsEngine).toBeUndefined();
    expect(marlow.overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('still updates the local cast when the rebaselined book IS the loaded one', async () => {
    const marlow = await run('book-1', 'book-1');
    expect(marlow.voiceStyle).toBeTruthy();
    expect(marlow.ttsEngine).toBe('qwen');
    expect(marlow.overrideTtsVoices?.qwen?.name).toBe('qwen-marlow');
  });
});

describe('RebaselineModal — the local mirror follows the LOADED book, not the stage', () => {
  const approve = async (store: ReturnType<typeof makeStore>, targetBookId: string) => {
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId={targetBookId} />
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
    await waitFor(() => expect(setVoiceOverrideLinked).toHaveBeenCalled());
    await waitFor(() => expect(store.getState().rebaseline.status).not.toBe('approving'));
    return store.getState().cast.characters.find((c) => c.id === 'marlow')!;
  };
  const targetCast = () =>
    getBookState.mockResolvedValue({
      cast: { characters: [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 90)] },
    });

  it('mirrors into the loaded book when no book is on screen (global #/voices)', async () => {
    targetCast();
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId: null, loadedBookId: 'book-2' },
    );
    const marlow = await approve(store, 'book-2');
    expect(marlow.ttsEngine).toBe('qwen');
    expect(marlow.overrideTtsVoices?.qwen?.name).toBe('qwen-marlow');
    expect(marlow.voiceStyle).toBeTruthy();
  });

  it('mirrors a linked update that lands in the loaded book when rebaselining another', async () => {
    targetCast();
    setVoiceOverrideLinked.mockImplementation(async (_b: string, characterId: string) => ({
      canonicalVoiceId: 'v_unified',
      updated: [
        { bookId: 'book-2', bookTitle: 'Book Two', characterId },
        { bookId: 'book-1', bookTitle: 'Book One', characterId },
      ],
      failed: [],
    }));
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId: null, loadedBookId: 'book-1' },
    );
    const marlow = await approve(store, 'book-2');
    expect(marlow.voiceId).toBe('v_unified');
    expect(marlow.ttsEngine).toBe('qwen');
    expect(marlow.overrideTtsVoices?.qwen?.name).toBe('qwen-marlow');
    /* The persona is the rebaselined book's own; a linked-in row only gets the voice. */
    expect(marlow.voiceStyle).toBeUndefined();
  });

  /* The server writes `{ ...slot, name }` (voice-override-linked.ts), so the slot's
     variants/libraryUuid/provenance survive; the mirror must not rebuild it as
     `{ name }` or the next whole-roster PUT deletes the takes on disk. */
  const SLOT_EXTRAS = {
    libraryUuid: 'lib-1',
    provenance: 'designed',
    variants: { angry: { name: 'qwen-old__angry' } },
  };

  it('keeps the slot extras on the home row of the loaded book', async () => {
    targetCast();
    const store = makeStore(
      [
        char('narrator', 'Narrator', 400),
        {
          ...char('marlow', 'Marlow', 60),
          overrideTtsVoices: { qwen: { name: 'qwen-old', ...SLOT_EXTRAS } },
        } as unknown as Character,
      ],
      VOICES,
      { openBookId: null, loadedBookId: 'book-2' },
    );
    const marlow = await approve(store, 'book-2');
    expect(marlow.overrideTtsVoices?.qwen?.name).toBe('qwen-marlow');
    expect(marlow.overrideTtsVoices?.qwen).toMatchObject(SLOT_EXTRAS);
  });

  it('keeps the slot extras (and other engines) on a linked row of the loaded book', async () => {
    targetCast();
    setVoiceOverrideLinked.mockImplementation(async () => ({
      canonicalVoiceId: 'v_unified',
      updated: [{ bookId: 'book-1', bookTitle: 'Book One', characterId: 'det-marlow' }],
      failed: [],
    }));
    const store = makeStore(
      [
        char('narrator', 'Narrator', 400),
        {
          ...char('det-marlow', 'Marlow', 60),
          overrideTtsVoices: {
            qwen: { name: 'qwen-old', ...SLOT_EXTRAS },
            kokoro: { name: 'af_heart' },
          },
        } as unknown as Character,
      ],
      VOICES,
      { openBookId: null, loadedBookId: 'book-1' },
    );
    await approve(store, 'book-2');
    const row = store.getState().cast.characters.find((c) => c.id === 'det-marlow')!;
    expect(row.overrideTtsVoices?.qwen?.name).toBe('qwen-marlow');
    expect(row.overrideTtsVoices?.qwen).toMatchObject(SLOT_EXTRAS);
    expect(row.overrideTtsVoices?.kokoro?.name).toBe('af_heart');
  });

  /* The loaded book is re-read at each write: a book switch while a server call is
     in flight must not land the old book's rebaseline on the new book's same-id row
     (series books share character ids). */
  const switchToBook3 = (store: ReturnType<typeof makeStore>) => {
    store.dispatch(manuscriptSlice.actions.resetForBook('book-3'));
    store.dispatch(castSlice.actions.setCharacters([char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)]));
  };

  it('mirrors the generated persona into the loaded book at design time when no book is on screen', async () => {
    targetCast();
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId: null, loadedBookId: 'book-2' },
    );
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-2" />
      </Provider>,
    );
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(screen.getByTestId('rebaseline-approve')).not.toBeDisabled());
    /* Before Approve: only designOne's own mirror can have set it. */
    expect(store.getState().cast.characters.find((c) => c.id === 'marlow')?.voiceStyle).toBe('persona for marlow');
  });

  it('mirrors onto the live row, so an edit landing during the series write survives', async () => {
    targetCast();
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId: null, loadedBookId: 'book-2' },
    );
    setVoiceOverrideLinked.mockImplementation(async (_b: string, characterId: string) => {
      const live = store.getState().cast.characters.find((c) => c.id === characterId)!;
      store.dispatch(castSlice.actions.updateCharacter({ ...live, attributes: ['edited-mid-approve'] }));
      return { canonicalVoiceId: `v_${characterId}`, updated: [], failed: [] };
    });
    const marlow = await approve(store, 'book-2');
    expect(marlow.attributes).toEqual(['edited-mid-approve']);
    expect(marlow.overrideTtsVoices?.qwen?.name).toBe('qwen-marlow');
  });

  it('does not write the approve mirror into a different book loaded mid-approve', async () => {
    targetCast();
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId: null, loadedBookId: 'book-1' },
    );
    setVoiceOverrideLinked.mockImplementation(async (_b: string, characterId: string) => {
      switchToBook3(store);
      return {
        canonicalVoiceId: 'v_unified',
        updated: [{ bookId: 'book-1', bookTitle: 'Book One', characterId }],
        failed: [],
      };
    });
    const marlow = await approve(store, 'book-1');
    expect(store.getState().manuscript.bookId).toBe('book-3');
    expect(marlow.voiceId).toBe('voice-marlow');
    expect(marlow.ttsEngine).toBeUndefined();
    expect(marlow.overrideTtsVoices?.qwen).toBeUndefined();
    expect(marlow.voiceStyle).toBeUndefined();
  });

  it('does not write a generated persona into a different book loaded mid-design', async () => {
    getBookState.mockResolvedValue({
      cast: { characters: [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 90)] },
    });
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId: null, loadedBookId: 'book-1' },
    );
    generateVoiceStyle.mockImplementation(async (_b: string, characterId: string) => {
      switchToBook3(store);
      return { voiceStyle: `persona for ${characterId}` };
    });
    const marlow = await approve(store, 'book-1');
    expect(generateVoiceStyle).toHaveBeenCalledWith('book-1', 'marlow');
    expect(store.getState().manuscript.bookId).toBe('book-3');
    expect(marlow.voiceStyle).toBeUndefined();
  });

  it('leaves the loaded book alone when no linked update reaches it', async () => {
    targetCast();
    setVoiceOverrideLinked.mockImplementation(async (_b: string, characterId: string) => ({
      canonicalVoiceId: 'v_unified',
      updated: [{ bookId: 'book-2', bookTitle: 'Book Two', characterId }],
      failed: [],
    }));
    const store = makeStore(
      [char('narrator', 'Narrator', 400), char('marlow', 'Marlow', 60)],
      VOICES,
      { openBookId: null, loadedBookId: 'book-1' },
    );
    const marlow = await approve(store, 'book-2');
    expect(marlow.voiceId).toBe('voice-marlow');
    expect(marlow.ttsEngine).toBeUndefined();
    expect(marlow.overrideTtsVoices?.qwen).toBeUndefined();
    expect(marlow.voiceStyle).toBeUndefined();
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
    const maerinRow = screen.getByTestId('rebaseline-proposal-maerin');
    const marlowRow = screen.getByTestId('rebaseline-proposal-marlow');
    expect(within(maerinRow).getByText(/Designing voice…/)).toBeInTheDocument();
    expect(within(marlowRow).getAllByText(/Queued…/).length).toBeGreaterThan(0);

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
          release = () => resolve({ voiceId: 'qwen-maerin-v2', previewUrl: 'blob:maerin2' });
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

describe('RebaselineModal — approve while the cast is read-only (plan 291, I1)', () => {
  it('mirrors the route result into the slice without a read-only toast', async () => {
    const store = makeStore(CHARACTERS, VOICES, { readOnly: true });
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
    const maerin = store.getState().cast.characters.find((c) => c.id === 'maerin')!;
    expect(maerin.overrideTtsVoices?.qwen?.name).toBe('qwen-maerin');
    expect(
      store.getState().notifications.toasts.filter((t) => /Re-analysis running/.test(t.message)),
    ).toEqual([]);
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
    const maerinCall = calls.find((c) => c[2].name === 'qwen-maerin');
    expect(maerinCall).toBeTruthy();
    expect(maerinCall![0]).toBe('book-1'); // home book (anchor = open book)
    expect(maerinCall![1]).toBe('maerin'); // character id
    expect(maerinCall![2]).toEqual({ engine: 'qwen', name: 'qwen-maerin' });
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

describe('RebaselineModal — approve honours a server refusal (fs-38 wave3c task4 CRITICAL-1)', () => {
  it('does not launder a cloned slot into redux when the linked write is refused (207)', async () => {
    /* Clara currently carries a CONSENTED CLONE on qwen but her active engine
       in this book is coqui — the "approved Qwen voice exists but wrong
       engine" reuse branch (runPropose) proposes reusing that exact cloned
       voiceId with NO re-design. The server refuses the linked write per-book
       (207, `failed` non-empty, no throw — `res.ok` is true for 207) because
       writing it would replace a cloned slot. Pre-fix, runApprove ignored
       `failed` and applied the optimistic update anyway, stripping
       libraryUuid/provenance and flipping ttsEngine to qwen — laundering a
       real person's voice into an anonymous stock one, in redux (which the
       persistence middleware then debounce-writes to cast.json). */
    const cloned = {
      ...char('clara', 'Clara', 90),
      ttsEngine: 'coqui',
      overrideTtsVoices: {
        qwen: { name: 'clone-voice-original', libraryUuid: 'lib-uuid-1', provenance: 'cloned' },
      },
    } as Character;
    const cast = [char('narrator', 'Narrator', 500), cloned];
    const voices = [voice('voice-clara', 'clara')];
    setVoiceOverrideLinked.mockImplementation(async (bookId: string, characterId: string) => {
      if (characterId === 'clara') {
        return {
          canonicalVoiceId: 'clara',
          updated: [],
          failed: [
            {
              bookId,
              bookTitle: 'Book One',
              error:
                'Character "Clara" has a consented cloned voice — series rebaseline refuses to remove or replace it. Reassign the character directly instead.',
            },
          ],
        };
      }
      return { canonicalVoiceId: `v_${characterId}`, updated: [], failed: [] };
    });
    const store = makeStore(cast, voices);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    // Ensure Clara is selected regardless of the principal-cast threshold math.
    if (!store.getState().rebaseline.selectedCharacterIds.includes('clara')) {
      fireEvent.click(screen.getByLabelText('Rebaseline Clara'));
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    // Reuse branch: no fresh design for the already-approved cloned voice.
    await waitFor(() => expect(store.getState().rebaseline.proposals.clara.status).toBe('ready'));
    expect(store.getState().rebaseline.proposals.clara.proposedVoiceId).toBe('clone-voice-original');
    expect(designQwenVoice).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    await waitFor(() => expect(setVoiceOverrideLinked).toHaveBeenCalledWith('book-1', 'clara', {
      engine: 'qwen',
      name: 'clone-voice-original',
    }));

    // THE FIX: the refusal must be honoured — the row reads failed, not applied.
    await waitFor(() => expect(store.getState().rebaseline.proposals.clara.status).toBe('failed'));

    // THE BUG THIS GUARDS: the cloned slot must reach redux UNCHANGED — no
    // laundered {name} replacement, no engine flip.
    const clara = store.getState().cast.characters.find((c) => c.id === 'clara')!;
    expect(clara.overrideTtsVoices?.qwen).toEqual({
      name: 'clone-voice-original',
      libraryUuid: 'lib-uuid-1',
      provenance: 'cloned',
    });
    expect(clara.ttsEngine).toBe('coqui');
    expect(store.getState().notifications.toasts.map((t) => t.message)).toContain(
      'Kept consented cloned voices unchanged in: Book One.',
    );
  });

  /* PR #4109 review pass 3: a 207 `failed` entry is not always a clone refusal (the name guard,
     lock contention, a missing cast), and the toast must not claim one that never happened. */
  it('a refusal that is not a clone refusal is not reported as a kept clone', async () => {
    const cast = [char('narrator', 'Narrator', 500), char('clara', 'Clara', 90)];
    setVoiceOverrideLinked.mockImplementation(async (bookId: string, characterId: string) => ({
      canonicalVoiceId: `v_${characterId}`,
      updated: [],
      failed:
        characterId === 'clara'
          ? [
              {
                bookId,
                bookTitle: 'Book One',
                error: `Character "Clara" — refusing to write "qwen-r0" as its qwen voice: it doesn't match this character's own consented voice.`,
              },
            ]
          : [],
    }));
    const store = makeStore(cast, [voice('voice-clara', 'clara')]);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    if (!store.getState().rebaseline.selectedCharacterIds.includes('clara')) {
      fireEvent.click(screen.getByLabelText('Rebaseline Clara'));
    }
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(store.getState().rebaseline.proposals.clara.status).toBe('ready'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-approve'));
    });
    await waitFor(() => expect(store.getState().rebaseline.proposals.clara.status).toBe('failed'));
    const messages = store.getState().notifications.toasts.map((t) => t.message);
    expect(messages.some((m) => /cloned/.test(m))).toBe(false);
    expect(messages).toContain("Couldn't update the voice in: Book One.");
  });
});

describe('RebaselineModal — sample-cache scope across books (bug #1411 follow-up)', () => {
  it("designs and auditions a sibling's voiceId-less character under ITS OWN book, not the anchor's", async () => {
    /* Wren is introduced in book-2 (sourceBookId), has NO voiceId, and doesn't
       collapse into any book-1 row (distinct id, no name/alias match) — this
       modal explicitly supports designing/auditioning such a sibling from the
       anchor's own Rebaseline pass. The design + audition calls fire with the
       anchor's bookId ('book-1') as the API's :bookId param (server-side
       propagation is unrelated to this fix), but the sample-cache SCOPE inside
       that call must be namespaced by Wren's OWN book ('book-2'), or an
       unrelated book-1 character sharing Wren's bare id would collide with
       her cached audition. */
    getSeriesCast.mockResolvedValue({
      characters: [
        { ...char('wren', 'Wren', 10), voiceId: undefined, sourceBookId: 'book-2' } as Character,
      ],
    });
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    // Ten lines is below the principal-cast threshold — select her explicitly.
    fireEvent.click(screen.getByLabelText('Rebaseline Wren'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(screen.getByTestId('rebaseline-proposal-wren')).toBeInTheDocument());

    expect(designQwenVoice).toHaveBeenCalledWith(
      'book-1',
      'wren',
      expect.objectContaining({ sampleVoiceId: 'char-book-2__wren' }),
    );

    fireEvent.click(screen.getByTestId('rebaseline-play-current-wren'));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalled());
    const lastCall = vi.mocked(playSampleWithAutoLoad).mock.calls.at(-1)![0];
    expect(lastCall.args.voiceId).toBe('char-book-2__wren');
  });
});

describe('RebaselineModal — audition resolves the character\'s own engine (#1839 review fix)', () => {
  it("auditions the CURRENT voice in the character's own overridden engine, not the session default", async () => {
    /* The ui slice's default session key (DEFAULT_TTS_MODEL) is kokoro-v1.
       Faye is overridden to coqui in THIS book, so playCurrent must resolve
       her audition to coqui-xtts-v2 — mirroring cast.tsx / profile-drawer.tsx
       — not the raw session key. Pre-fix, playCurrent passed ttsModelKey
       straight through and this would resolve to 'kokoro-v1'. */
    const overriddenChar = { ...char('faye', 'Faye', 5), ttsEngine: 'coqui' } as Character;
    const store = makeStore([...CHARACTERS, overriddenChar], VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    // Five lines is below the principal-cast threshold — select her explicitly.
    fireEvent.click(screen.getByLabelText('Rebaseline Faye'));
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    await waitFor(() => expect(screen.getByTestId('rebaseline-proposal-faye')).toBeInTheDocument());

    fireEvent.click(screen.getByTestId('rebaseline-play-current-faye'));
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalled());
    const lastCall = vi.mocked(playSampleWithAutoLoad).mock.calls.at(-1)![0];
    expect(lastCall.args.modelKey).toBe('coqui-xtts-v2');
  });
});

describe('RebaselineModal — design guard (#3084 W4)', () => {
  const TITLE = 'Pause audio generation to design voices?';

  it('Propose on a same-card endpoint persona engine with a render streaming asks once, before any design starts; Confirm halts then runs the batch', async () => {
    const store = makeStore(CHARACTERS, VOICES);
    seedSameCardPersona(store);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    fireEvent.click(screen.getByTestId('rebaseline-propose'));

    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(store.getState().rebaseline.status).toBe('setup');
    expect(designQwenVoice).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Pause and design' }));
    expect(haltActiveGeneration).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(designQwenVoice).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
  });

  it('Propose where every selected character already has a persona generates none, so it designs at once with no prompt', async () => {
    const withPersonas = [
      char('narrator', 'Narrator', 500),
      { ...char('maerin', 'Maerin', 80), voiceStyle: 'a hand-tuned persona' } as Character,
      { ...char('marlow', 'Marlow', 60), voiceStyle: 'another persona' } as Character,
      char('bystander', 'Bystander', 1),
    ];
    const store = makeStore(withPersonas, VOICES);
    seedSameCardPersona(store);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    await act(async () => {
      fireEvent.click(screen.getByTestId('rebaseline-propose'));
    });
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
    await waitFor(() => expect(designQwenVoice).toHaveBeenCalledTimes(2));
    expect(generateVoiceStyle).not.toHaveBeenCalled();
  });

  it('Propose with one selected character missing a persona still asks', async () => {
    const onePersonaMissing = [
      char('narrator', 'Narrator', 500),
      { ...char('maerin', 'Maerin', 80), voiceStyle: 'a hand-tuned persona' } as Character,
      char('marlow', 'Marlow', 60),
      char('bystander', 'Bystander', 1),
    ];
    const store = makeStore(onePersonaMissing, VOICES);
    seedSameCardPersona(store);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    fireEvent.click(screen.getByTestId('rebaseline-propose'));
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    expect(designQwenVoice).not.toHaveBeenCalled();
  });

  it('Wait leaves the modal in setup and designs nothing', async () => {
    const store = makeStore(CHARACTERS, VOICES);
    seedSameCardPersona(store);
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-1" />
      </Provider>,
    );
    await waitForReady();
    fireEvent.click(screen.getByTestId('rebaseline-propose'));
    /* The DESIGN dialog must be the one asking: with design mode off the guard falls back to the analysis
       dialog (also has a Wait button), and a Wait that only checks "nothing started" passes either way. */
    expect(screen.getByText(TITLE)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Wait' }));
    expect(screen.queryByText(TITLE)).not.toBeInTheDocument();
    expect(store.getState().rebaseline.status).toBe('setup');
    expect(designQwenVoice).not.toHaveBeenCalled();
    expect(haltActiveGeneration).not.toHaveBeenCalled();
  });
});

describe('RebaselineModal — the target-cast read is bounded and aborted (#3967)', () => {
  /* never settles on its own; rejects like fetch does when its signal aborts */
  const hung = (signal?: AbortSignal) =>
    new Promise<never>((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const advance = (ms: number) =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('(a) timeout: a read that never answers is aborted after 15 s and the error shows', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getBookState.mockImplementation(async (_id: string, signal?: AbortSignal) => hung(signal));
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-2" />
      </Provider>,
    );
    await waitFor(() => expect(getBookState).toHaveBeenCalled());
    const signal = getBookState.mock.calls[0][1] as AbortSignal;
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    await advance(15_500);
    expect(signal.aborted).toBe(true);
    expect(screen.getByText(/Could not load that series/)).toBeInTheDocument();
    err.mockRestore();
  });

  it('(b) unmount before 15 s aborts the read and logs nothing', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    getBookState.mockImplementation(async (_id: string, signal?: AbortSignal) => hung(signal));
    const store = makeStore(CHARACTERS, VOICES, { openBookId: 'book-1' });
    const view = render(
      <Provider store={store}>
        <RebaselineModalContainer bookId="book-2" />
      </Provider>,
    );
    await waitFor(() => expect(getBookState).toHaveBeenCalled());
    const signal = getBookState.mock.calls[0][1] as AbortSignal;
    await advance(5_000);
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
    view.unmount();
    await advance(20_000);
    expect(signal.aborted).toBe(true);
    expect(err).not.toHaveBeenCalled();
    err.mockRestore();
  });
});
