// Pairs with docs/features/archive/22-voice-library.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { castSlice } from '../store/cast-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { uiSlice } from '../store/ui-slice';
import { voicesSlice } from '../store/voices-slice';
import { librarySlice } from '../store/library-slice';
import { rebaselineSlice } from '../store/rebaseline-slice';
import { LibraryView } from './voices';
import type { BaseVoice, BookStateResponse, Character, Sentence, Voice } from '../lib/types';

const setVoicePin = vi.fn((_voiceId: string, _pinned: boolean) => Promise.resolve());
const getBaseVoices = vi.fn<() => Promise<{ voices: BaseVoice[] }>>(() =>
  Promise.resolve({ voices: [] }),
);
const setVoiceOverride = vi.fn();
const getBookState = vi.fn<(bookId: string) => Promise<BookStateResponse | null>>(() =>
  Promise.resolve(null),
);
const seriesPatchCharacter =
  vi.fn<
    (args: {
      bookId: string;
      characterId: string;
      patch: Record<string, unknown>;
    }) => Promise<{
      updated: Array<{ bookId: string; bookTitle: string; characterId: string }>;
      failed: Array<{ bookId: string; bookTitle: string; error: string }>;
    }>
  >();
const mergeCharactersMock =
  vi.fn<
    (args: { bookId: string; sourceId: string; targetId: string }) => Promise<{
      characters: Character[];
    }>
  >();
const linkPriorCharacterMock =
  vi.fn<
    (args: {
      bookId: string;
      sourceCharacterId: string;
      targetBookId: string;
      targetCharacterId: string;
    }) => Promise<{
      matchedFrom: { bookId: string; characterId: string; bookTitle: string; confidence: number };
      voiceId?: string;
    }>
  >();
const notLinkedToMock =
  vi.fn<
    (args: {
      bookId: string;
      characterId: string;
      otherBookId: string;
      otherCharacterId: string;
    }) => Promise<{
      pair: {
        a: { bookId: string; characterId: string };
        b: { bookId: string; characterId: string };
      };
    }>
  >();
const removeNotLinkedToMock =
  vi.fn<
    (args: {
      bookId: string;
      characterId: string;
      otherBookId: string;
      otherCharacterId: string;
    }) => Promise<{
      pair: {
        a: { bookId: string; characterId: string };
        b: { bookId: string; characterId: string };
      };
    }>
  >();

vi.mock('../lib/api', () => ({
  api: {
    setVoicePin: (voiceId: string, pinned: boolean) => setVoicePin(voiceId, pinned),
    getBaseVoices: () => getBaseVoices(),
    setVoiceOverride: (...args: unknown[]) => setVoiceOverride(...args),
    getBookState: (bookId: string) => getBookState(bookId),
    /* The rebaseline modal (mounted by this view) fetches the series cast on
       open; no series-mates in this test workspace. */
    getSeriesCast: (_bookId: string) => Promise.resolve({ characters: [] as Character[] }),
    seriesPatchCharacter: (args: {
      bookId: string;
      characterId: string;
      patch: Record<string, unknown>;
    }) => seriesPatchCharacter(args),
    mergeCharacters: (args: { bookId: string; sourceId: string; targetId: string }) =>
      mergeCharactersMock(args),
    linkPriorCharacter: (args: {
      bookId: string;
      sourceCharacterId: string;
      targetBookId: string;
      targetCharacterId: string;
    }) => linkPriorCharacterMock(args),
    notLinkedTo: (args: {
      bookId: string;
      characterId: string;
      otherBookId: string;
      otherCharacterId: string;
    }) => notLinkedToMock(args),
    removeNotLinkedTo: (args: {
      bookId: string;
      characterId: string;
      otherBookId: string;
      otherCharacterId: string;
    }) => removeNotLinkedToMock(args),
  },
}));

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator', lines: 120 },
  { id: 'marlow', name: 'Marlow', role: 'Empath', color: 'peach', lines: 60 },
  { id: 'oduvan', name: 'Oduvan', role: 'Healer', color: 'magenta', lines: 10 },
];

const sentences: Sentence[] = [];

function makeVoice(
  over: Partial<Voice> & Pick<Voice, 'id' | 'character' | 'bookId' | 'bookTitle' | 'source'>,
): Voice {
  return {
    attributes: ['warm'],
    gradient: ['#3C194F', '#0F0E0D'],
    usedIn: 1,
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    bookSeries: 'The Hollow Tide',
    ...over,
  } as Voice;
}

/* Library spans two cast members in two different books that both resolve
   to the Charon voice family, plus a third cast member resolving to Kore.
   Two families, with the Charon family carrying cast across multiple
   books — that's the cross-book voice-family invariant the user described. */
const library: Voice[] = [
  makeVoice({
    id: 'narrator',
    character: 'Narrator',
    bookId: 'b1',
    bookTitle: 'Book One',
    source: 'current',
  }),
  makeVoice({
    id: 'marlow',
    character: 'Marlow',
    bookId: 'b2',
    bookTitle: 'Book Two',
    source: 'library',
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
  }),
  makeVoice({
    id: 'oduvan',
    character: 'Oduvan',
    bookId: 'b1',
    bookTitle: 'Book One',
    source: 'current',
    ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
  }),
];

function makeStore() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      voices: voicesSlice.reducer,
      notifications: notificationsSlice.reducer,
    },
  });
  store.dispatch(castSlice.actions.setCharacters(characters));
  store.dispatch(
    manuscriptSlice.actions.hydrateFromAnalysis({
      chapters: [],
      characters,
      sentences,
    } as never),
  );
  return store;
}

function renderView(lib: Voice[] = library, onOpenCharacter?: (v: Voice) => void) {
  return render(
    <Provider store={makeStore()}>
      <LibraryView library={lib} onOpenCharacter={onOpenCharacter} />
    </Provider>,
  );
}

beforeEach(() => {
  setVoicePin.mockClear();
  getBaseVoices.mockClear();
  getBaseVoices.mockResolvedValue({ voices: [] });
  setVoiceOverride.mockClear();
  getBookState.mockReset();
  getBookState.mockResolvedValue(null);
  seriesPatchCharacter.mockReset();
  mergeCharactersMock.mockReset();
  linkPriorCharacterMock.mockReset();
  notLinkedToMock.mockReset();
  removeNotLinkedToMock.mockReset();
});

describe('LibraryView voice-family grouping', () => {
  it('renders one section per voice family (e.g. Charon, Kore) — not per book', () => {
    renderView();
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(2);
    const labels = sections.map((s) => s.getAttribute('aria-label'));
    expect(labels).toContain('Gemini · Charon');
    expect(labels).toContain('Gemini · Kore');
  });

  it('nests cast members from different books under the same family', () => {
    renderView();
    const charonSection = screen.getByRole('region', { name: 'Gemini · Charon' });
    /* Two cast members (Narrator in Book One, Marlow in Book Two) hang
       off this family. The two book titles must both appear as nested
       headers. */
    expect(within(charonSection).getByText('Book One')).toBeInTheDocument();
    expect(within(charonSection).getByText('Book Two')).toBeInTheDocument();
    /* Both cast names appear in the section. */
    expect(within(charonSection).getByText('Narrator')).toBeInTheDocument();
    expect(within(charonSection).getByText('Marlow')).toBeInTheDocument();
  });

  it('groups books under their series header when bookSeries is set', () => {
    renderView();
    const charonSection = screen.getByRole('region', { name: 'Gemini · Charon' });
    /* The series header is rendered above the books. */
    expect(within(charonSection).getByText('The Hollow Tide')).toBeInTheDocument();
  });

  it('filters to families with current-source members under the "This book" tab', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /This book/i }));
    /* Charon has Narrator (current); Kore has Oduvan (current). Both stay. */
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(2);
  });

  it('filters to families with only library-source members under "Series & older"', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Series & older/i }));
    /* Only Marlow (library) survives — its family Charon. Kore's only
       member is current-source, so Kore drops out. */
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(1);
    expect(sections[0]).toHaveAttribute('aria-label', 'Gemini · Charon');
  });
});

describe('LibraryView pin button', () => {
  it('renders an inline pin button per cast card and calls api.setVoicePin on click', () => {
    renderView();
    const pinButtons = screen.getAllByRole('button', { name: /Pin voice|Unpin voice/i });
    /* One per cast card: 3 total. */
    expect(pinButtons.length).toBe(3);
    fireEvent.click(pinButtons[0]);
    expect(setVoicePin).toHaveBeenCalledTimes(1);
    expect(setVoicePin).toHaveBeenCalledWith(expect.any(String), true);
  });
});

describe('LibraryView character-card click', () => {
  it('fires onOpenCharacter with the clicked voice so the host can open the profile drawer', () => {
    /* Regression for the voice library doc's step 7 — pre-fix, the
       per-character cards under each voice family were drag-only and the
       user had no way to reach the profile drawer from the Voices view.
       The host (route) decides whether to open the drawer in place or
       navigate to the source book; the view just hands back the voice. */
    const onOpenCharacter = vi.fn<(v: Voice) => void>();
    renderView(library, onOpenCharacter);
    /* Both `Marlow` and the bookTitle `Book Two` render the same text node
       in different contexts; the character card carries role="button" so
       scope the lookup that way. */
    const card = screen.getByText('Marlow').closest('[role="button"]')!;
    expect(card).not.toBeNull();
    fireEvent.click(card);
    expect(onOpenCharacter).toHaveBeenCalledTimes(1);
    expect(onOpenCharacter.mock.calls[0][0].id).toBe('marlow');
    expect(onOpenCharacter.mock.calls[0][0].bookId).toBe('b2');
  });

  it('leaves cards drag-only when onOpenCharacter is unset (no false-interactive a11y signal)', () => {
    renderView();
    /* Without the handler the card must not advertise role="button" — the
     legacy LibraryView behavior pre-bug-fix. */
    expect(screen.queryByRole('button', { name: 'Marlow' })).toBeNull();
  });
});

describe('LibraryView compare-two-voices affordance (plan 22a)', () => {
  /* All compare tests need a `ready` stage with a known bookId so the
     gating logic (currentBookId, cross-book guard, character resolution)
     has real values to read. The library used here has two voices in
     bookId='b1' sharing the Charon family + one in 'b1' on Kore + one in
     'b2' on Charon — covers same-family, different-family, and cross-book
     pairs. */
  const charactersB1: Character[] = [
    {
      id: 'narrator',
      name: 'Narrator',
      role: 'Narrator',
      color: 'narrator',
      lines: 120,
      voiceId: 'narrator',
    },
    { id: 'oduvan', name: 'Oduvan', role: 'Healer', color: 'magenta', lines: 10, voiceId: 'oduvan' },
    { id: 'garrow', name: 'Garrow', role: 'Guard', color: 'peach', lines: 30, voiceId: 'garrow' },
  ];

  const libraryB1: Voice[] = [
    makeVoice({
      id: 'narrator',
      character: 'Narrator',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
    }),
    makeVoice({
      id: 'garrow',
      character: 'Garrow',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'oduvan',
      character: 'Oduvan',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
    }),
    makeVoice({
      id: 'marlow',
      character: 'Marlow',
      bookId: 'b2',
      bookTitle: 'Book Two',
      source: 'library',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
  ];

  function makeReadyStore(stageBookId: string | null = 'b1') {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    store.dispatch(castSlice.actions.setCharacters(charactersB1));
    if (stageBookId !== null) {
      store.dispatch(uiSlice.actions.openBook({ id: stageBookId, status: 'cast_pending' }));
      store.dispatch(uiSlice.actions.confirmCast());
    } else {
      store.dispatch(uiSlice.actions.openVoices());
    }
    return store;
  }

  function renderCompare(lib: Voice[] = libraryB1, stageBookId: string | null = 'b1') {
    return render(
      <Provider store={makeReadyStore(stageBookId)}>
        <LibraryView library={lib} />
      </Provider>,
    );
  }

  it('shows no pill at 0 selections', () => {
    renderCompare();
    expect(screen.queryByText(/^Selected$/)).toBeNull();
  });

  it('shows the floating pill at exactly 1 selection (Compare disabled)', () => {
    renderCompare();
    const checkboxes = screen.getAllByLabelText('Select voice for compare');
    fireEvent.click(checkboxes[0]);
    expect(screen.getByText('Selected')).toBeInTheDocument();
    const compareBtn = screen.getByRole('button', { name: 'Compare' });
    expect(compareBtn).toBeDisabled();
    expect(compareBtn.getAttribute('title')).toBe('Select exactly 2 voices');
  });

  it('shows the green "same base voice ✓" badge when 2 same-family voices are selected (plan 22a)', () => {
    renderCompare();
    /* Click Narrator + Garrow — both b1 + both Charon. */
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Garrow')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    expect(screen.getByText('same base voice ✓')).toBeInTheDocument();
    expect(screen.queryByText('different base voices')).toBeNull();
  });

  it('shows the amber "different base voices" badge when 2 cross-family voices are selected (plan 22a)', () => {
    renderCompare();
    /* Click Narrator (Charon) + Oduvan (Kore) — both b1, different families. */
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Oduvan')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    expect(screen.getByText('different base voices')).toBeInTheDocument();
    expect(screen.queryByText('same base voice ✓')).toBeNull();
  });

  it('enables Compare at exactly 2 within-current-book selections (plan 22a)', () => {
    renderCompare();
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Garrow')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    const compareBtn = screen.getByRole('button', { name: 'Compare' });
    expect(compareBtn).not.toBeDisabled();
  });

  it('disables Compare at 3+ selections with "Select exactly 2 voices" (plan 22a)', () => {
    renderCompare();
    const checkboxes = screen.getAllByLabelText('Select voice for compare');
    fireEvent.click(checkboxes[0]);
    fireEvent.click(checkboxes[1]);
    fireEvent.click(checkboxes[2]);
    const compareBtn = screen.getByRole('button', { name: 'Compare' });
    expect(compareBtn).toBeDisabled();
    expect(compareBtn.getAttribute('title')).toBe('Select exactly 2 voices');
  });

  it('enables Compare on the global tab for a same-bookId pair (plan 60)', () => {
    /* `stageBookId=null` puts ui.stage on `{kind:'voices'}` — the global
       tab. Plan 60 promotes the Compare button to enabled for any pair
       that shares a non-null bookId; the on-demand fetch resolves the
       foreign cast when Compare is clicked. */
    renderCompare(libraryB1, null);
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Garrow')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    const compareBtn = screen.getByRole('button', { name: 'Compare' });
    expect(compareBtn).not.toBeDisabled();
  });

  it('enables Compare on a cross-book pair and hydrates the foreign cast on click (plan 96, BACKLOG #7)', async () => {
    /* Narrator (b1, open book) + Marlow (b2, foreign). The plan-82 lift
       drops the cross-book guard — the button is enabled immediately,
       and the click triggers an on-demand hydrate of book b2's cast. */
    getBookState.mockResolvedValueOnce({
      state: {
        bookId: 'b2',
        manuscriptId: '',
        title: 'Book Two',
        author: '',
        series: '',
        seriesPosition: null,
        isStandalone: false,
        manuscriptFile: '',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#000'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      cast: {
        characters: [
          { id: 'marlow', name: 'Marlow', role: 'Empath', color: 'peach', voiceId: 'marlow' },
        ],
      },
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: undefined,
      changeLog: null,
      analysis: undefined,
    });
    renderCompare();
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Marlow')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    const compareBtn = screen.getByRole('button', { name: 'Compare' });
    expect(compareBtn).not.toBeDisabled();
    fireEvent.click(compareBtn);
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(getBookState).toHaveBeenCalledWith('b2');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
    /* Propagation hint is shown on each side because the parent passes
       propagatesAcrossSeries=true from the Voices view. */
    expect(
      screen.getAllByText(/Saves propagate to every book in this series/).length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('opens the CompareCastModal with both linked characters when Compare is clicked (plan 22a)', () => {
    renderCompare();
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Garrow')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('clears selection when Clear is clicked (plan 22a)', () => {
    renderCompare();
    fireEvent.click(screen.getAllByLabelText('Select voice for compare')[0]);
    expect(screen.getByText('Selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(screen.queryByText(/^Selected$/)).toBeNull();
  });

  describe('global-tab same-book fetch path (plan 60)', () => {
    /* Helper: build a BookStateResponse with the given characters.
       Only the `cast` field is consulted by the global-compare flow;
       the rest is filler so the type satisfies. */
    function buildBookState(bookId: string, chars: Character[]): BookStateResponse {
      const now = new Date().toISOString();
      return {
        state: {
          bookId,
          manuscriptId: '',
          title: '',
          author: '',
          series: '',
          seriesPosition: null,
          isStandalone: false,
          manuscriptFile: '',
          castConfirmed: true,
          chapters: [],
          coverGradient: ['#000', '#000'],
          createdAt: now,
          updatedAt: now,
        },
        cast: { characters: chars },
        manuscript: null,
        manuscriptEdits: null,
        revisions: null,
        completedSlugs: [],
        chapterCharacters: undefined,
        changeLog: null,
        analysis: undefined,
      };
    }

    async function flush(): Promise<void> {
      /* Two microtask drains: one for the await on `api.getBookState`,
         one for the setState-driven re-render that follows. */
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    it('fetches foreign cast via api.getBookState and mounts the modal on Compare click', async () => {
      getBookState.mockResolvedValueOnce(buildBookState('b1', charactersB1));
      renderCompare(libraryB1, null);
      fireEvent.click(
        screen
          .getByText('Narrator')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(
        screen
          .getByText('Garrow')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
      await flush();
      expect(getBookState).toHaveBeenCalledTimes(1);
      expect(getBookState).toHaveBeenCalledWith('b1');
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });

    it('pushes a toast and retroactively disables Compare when the fetch fails', async () => {
      getBookState.mockRejectedValueOnce(new Error('network down'));
      renderCompare(libraryB1, null);
      fireEvent.click(
        screen
          .getByText('Narrator')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(
        screen
          .getByText('Garrow')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
      await flush();
      /* No modal mounted; Compare button re-asserts disabled with the
         documented tooltip; the toast surface gets the error. */
      expect(screen.queryByRole('dialog')).toBeNull();
      const compareBtn = screen.getByRole('button', { name: 'Compare' });
      expect(compareBtn).toBeDisabled();
      expect(compareBtn.getAttribute('title')).toBe('Could not load that book — try again later');
    });

    it('also disables Compare when the fetched book has no cast at all', async () => {
      getBookState.mockResolvedValueOnce(buildBookState('b1', []));
      renderCompare(libraryB1, null);
      fireEvent.click(
        screen
          .getByText('Narrator')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(
        screen
          .getByText('Garrow')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
      await flush();
      expect(screen.queryByRole('dialog')).toBeNull();
      expect(screen.getByRole('button', { name: 'Compare' })).toBeDisabled();
    });

    it('caches the foreign cast so re-opens skip the second fetch', async () => {
      getBookState.mockResolvedValue(buildBookState('b1', charactersB1));
      renderCompare(libraryB1, null);
      fireEvent.click(
        screen
          .getByText('Narrator')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(
        screen
          .getByText('Garrow')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
      await flush();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(getBookState).toHaveBeenCalledTimes(1);
      /* Close and re-open the modal — the same pair, same session.
         The component should consult the cache, not refetch. */
      fireEvent.keyDown(window, { key: 'Escape' });
      /* Falls back to clicking the modal Close button if Escape doesn't
         bubble; the modal's contract is opaque here. Either way, the
         best signal is unmounting via the Cancel/X — but for cache
         coverage we just hit Compare again whilst the modal is still
         up; React re-renders re-use the cached path. */
      fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
      await flush();
      /* Still only one fetch — the second Compare click reads
         `globalCastCache` and short-circuits the fetch path. */
      expect(getBookState).toHaveBeenCalledTimes(1);
    });
  });

  describe('series-propagating Save (plan 96)', () => {
    /* Toasts dispatched by the Save handler land in the notifications
       slice; the live <ToastStack> isn't mounted here, so assertions
       read store state directly. */
    function renderWithStoreExposed() {
      const store = makeReadyStore('b1');
      const view = render(
        <Provider store={store}>
          <LibraryView library={libraryB1} />
        </Provider>,
      );
      return { ...view, store };
    }

    async function flush(): Promise<void> {
      await act(async () => {
        await Promise.resolve();
      });
      await act(async () => {
        await Promise.resolve();
      });
    }

    function openModal() {
      fireEvent.click(
        screen
          .getByText('Narrator')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(
        screen
          .getByText('Garrow')
          .closest('div.group')!
          .querySelector('[aria-label="Select voice for compare"]')!,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
      /* Same-book pair → setCompareIds fires synchronously; modal
         mounts in the same render cycle. */
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    }

    it("calls api.seriesPatchCharacter with the edited side's patch on Save click", async () => {
      seriesPatchCharacter.mockResolvedValue({
        updated: [{ bookId: 'b1', bookTitle: 'Book One', characterId: 'narrator' }],
        failed: [],
      });
      renderWithStoreExposed();
      openModal();
      const sideA = screen.getByLabelText(/Side A: Narrator/);
      fireEvent.change(within(sideA).getByLabelText('Gender for Narrator'), {
        target: { value: 'female' },
      });
      fireEvent.click(within(sideA).getByRole('button', { name: 'Save' }));
      await flush();
      expect(seriesPatchCharacter).toHaveBeenCalledTimes(1);
      const call = seriesPatchCharacter.mock.calls[0][0];
      expect(call.bookId).toBe('b1');
      expect(call.characterId).toBe('narrator');
      expect(call.patch).toMatchObject({ gender: 'female' });
    });

    it('pushes a "Saved to N books in this series" toast when updated covers multiple books', async () => {
      seriesPatchCharacter.mockResolvedValue({
        updated: [
          { bookId: 'b1', bookTitle: 'Book One', characterId: 'narrator' },
          { bookId: 'b2', bookTitle: 'Book Two', characterId: 'narrator-b2' },
          { bookId: 'b3', bookTitle: 'Book Three', characterId: 'narrator-b3' },
        ],
        failed: [],
      });
      const { store } = renderWithStoreExposed();
      openModal();
      const sideA = screen.getByLabelText(/Side A: Narrator/);
      fireEvent.change(within(sideA).getByLabelText('Gender for Narrator'), {
        target: { value: 'female' },
      });
      fireEvent.click(within(sideA).getByRole('button', { name: 'Save' }));
      await flush();
      const toasts = store.getState().notifications.toasts;
      expect(toasts.some((t) => t.message === 'Saved to 3 books in this series.')).toBe(true);
    });

    it('pushes a per-failed-book error toast alongside the success toast on partial-success', async () => {
      seriesPatchCharacter.mockResolvedValue({
        updated: [{ bookId: 'b1', bookTitle: 'Book One', characterId: 'narrator' }],
        failed: [{ bookId: 'b2', bookTitle: 'Book Two', error: 'disk full' }],
      });
      const { store } = renderWithStoreExposed();
      openModal();
      const sideA = screen.getByLabelText(/Side A: Narrator/);
      fireEvent.change(within(sideA).getByLabelText('Gender for Narrator'), {
        target: { value: 'female' },
      });
      fireEvent.click(within(sideA).getByRole('button', { name: 'Save' }));
      await flush();
      const toasts = store.getState().notifications.toasts;
      expect(toasts.some((t) => t.kind === 'info' && t.message === 'Saved.')).toBe(true);
      expect(
        toasts.some(
          (t) => t.kind === 'error' && t.message === 'Could not save to: Book Two',
        ),
      ).toBe(true);
    });

    it('pushes a "Save failed" toast when the network call throws', async () => {
      seriesPatchCharacter.mockRejectedValue(new Error('network down'));
      const { store } = renderWithStoreExposed();
      openModal();
      const sideA = screen.getByLabelText(/Side A: Narrator/);
      fireEvent.change(within(sideA).getByLabelText('Gender for Narrator'), {
        target: { value: 'female' },
      });
      fireEvent.click(within(sideA).getByRole('button', { name: 'Save' }));
      await flush();
      const toasts = store.getState().notifications.toasts;
      expect(
        toasts.some((t) => t.kind === 'error' && t.message === 'Save failed — try again.'),
      ).toBe(true);
    });
  });
});

describe('LibraryView merge-cast-duplicates affordance (plan 98)', () => {
  /* Cast carries a Wren + Wren Sparrow duplicate pair in book b1, both
     resolving to the same Charon base voice — the substring-containment
     case the user described. A third Wren clone lives in book b2 so we
     can also assert the cross-book guard. */
  const charactersB1: Character[] = [
    { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator', voiceId: 'narrator' },
    { id: 'wren', name: 'Wren', role: 'Lead', color: 'peach', voiceId: 'wren' },
    {
      id: 'wren-sparrow',
      name: 'Wren Sparrow',
      role: 'Lead',
      color: 'peach',
      voiceId: 'wren-sparrow',
    },
    { id: 'oduvan', name: 'Oduvan', role: 'Healer', color: 'magenta', voiceId: 'oduvan' },
  ];

  const libraryB1: Voice[] = [
    makeVoice({
      id: 'narrator',
      character: 'Narrator',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
    }),
    makeVoice({
      id: 'wren',
      character: 'Wren',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'wren-sparrow',
      character: 'Wren Sparrow',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'oduvan',
      character: 'Oduvan',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
    }),
  ];

  /* The cross-book guard test needs a second "Wren" living in a
     different book. Kept out of the default fixture because two
     "Wren" text matches would defeat plain getByText lookups in
     every other test. */
  const wrenFromBookTwo: Voice = makeVoice({
    id: 'wren-b2',
    character: 'Wren',
    bookId: 'b2',
    bookTitle: 'Book Two',
    source: 'library',
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
  });

  function makeMergeStore(stageBookId: string = 'b1') {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    store.dispatch(castSlice.actions.setCharacters(charactersB1));
    store.dispatch(uiSlice.actions.openBook({ id: stageBookId, status: 'cast_pending' }));
    store.dispatch(uiSlice.actions.confirmCast());
    return store;
  }

  function renderMerge(lib: Voice[] = libraryB1) {
    return render(
      <Provider store={makeMergeStore()}>
        <LibraryView library={lib} />
      </Provider>,
    );
  }

  function selectCard(label: string) {
    fireEvent.click(
      screen
        .getByText(label)
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
  }

  it('shows a "Merge into <longer-name>" button when 2 same-voice same-book duplicates are selected', () => {
    renderMerge();
    selectCard('Wren');
    selectCard('Wren Sparrow');
    /* Substring containment picks "Wren Sparrow" as the survivor. */
    expect(
      screen.getByRole('button', { name: 'Merge into Wren Sparrow' }),
    ).toBeInTheDocument();
  });

  it('hides the Merge button for 2 same-voice DIFFERENT-book duplicates (cross-book guard)', async () => {
    /* "Wren" lives in both b1 (id=wren) and b2 (id=wren-b2). Pick
       the two same-name cards in different books — Compare stays
       enabled because plan-96 allows cross-book pairs, but Merge must
       be hidden because the server has no transport for it. */
    getBookState.mockResolvedValue({
      state: {
        bookId: 'b2',
        manuscriptId: '',
        title: '',
        author: '',
        series: '',
        seriesPosition: null,
        isStandalone: false,
        manuscriptFile: '',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#000'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      cast: {
        characters: [{ id: 'wren-b2', name: 'Wren', role: 'Lead', color: 'peach' }],
      },
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: undefined,
      changeLog: null,
      analysis: undefined,
    });
    renderMerge([...libraryB1, wrenFromBookTwo]);
    /* Two "Wren" labels exist (one per book) — disambiguate via closest
       book section. Wren-b1 stays the first match; Wren-b2 is the
       second. */
    const wrenCards = screen.getAllByText('Wren');
    fireEvent.click(
      wrenCards[0]
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      wrenCards[1]
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    expect(screen.queryByRole('button', { name: /^Merge into/ })).toBeNull();
  });

  it('hides the Merge button for 2 DIFFERENT-base-voice selections', () => {
    renderMerge();
    selectCard('Wren');
    selectCard('Oduvan');
    expect(screen.getByText('different base voices')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Merge into/ })).toBeNull();
  });

  it('hides the Merge button when a narrator/bucket id is one of the two selected', () => {
    /* Narrator + Wren are both b1, but Charon ≠ Charon for narrator
       in our test fixture (narrator carries the default ttsVoice in
       makeVoice — Charon). Force the same-base check by re-selecting
       wren-sparrow + narrator: same provider, both Charon — but
       narrator is a forbidden id. */
    renderMerge();
    selectCard('Narrator');
    selectCard('Wren Sparrow');
    /* Same base voice ✓ badge appears, but Merge is hidden because
       narrator is in UNMERGEABLE_IDS. Compare button stays present. */
    expect(screen.getByText('same base voice ✓')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Merge into/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Compare' })).toBeInTheDocument();
  });

  it('dispatches api.mergeCharacters with source=shorter-name, target=longer-name, then clears selection', async () => {
    mergeCharactersMock.mockResolvedValue({
      characters: [
        { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator' },
        {
          id: 'wren-sparrow',
          name: 'Wren Sparrow',
          role: 'Lead',
          color: 'peach',
          aliases: ['Wren'],
        },
        { id: 'oduvan', name: 'Oduvan', role: 'Healer', color: 'magenta' },
      ],
    });
    renderMerge();
    selectCard('Wren');
    selectCard('Wren Sparrow');
    const mergeBtn = screen.getByRole('button', { name: 'Merge into Wren Sparrow' });
    fireEvent.click(mergeBtn);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mergeCharactersMock).toHaveBeenCalledTimes(1);
    expect(mergeCharactersMock).toHaveBeenCalledWith({
      bookId: 'b1',
      sourceId: 'wren',
      targetId: 'wren-sparrow',
    });
    /* Pill collapses on success — Selected label is gone. */
    expect(screen.queryByText(/^Selected$/)).toBeNull();
  });
});

describe('LibraryView cross-book duplicate review (plan 101)', () => {
  /* Local library + characters for plan-100 tests. Two books in the same
     series, both contain an "Eliza"-ish character on the Kore voice; the
     duplicate-detection memo should flag the pair and surface the
     ⚠ pill on the Kore family card. */
  const elizaNs = makeVoice({
    id: 'v_eliza',
    character: 'Eliza Gray',
    bookId: 'b1',
    bookTitle: 'Book One',
    source: 'current',
    ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
  });
  const elizaSb = makeVoice({
    id: 'v_eliza_sb',
    character: 'Eliza',
    bookId: 'b2',
    bookTitle: 'Book Two',
    source: 'library',
    ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
  });
  const libraryWithDuplicate: Voice[] = [elizaNs, elizaSb];

  /* Plan 101 requires the library slice for series metadata, so this
     test suite uses a custom store that registers the slice. */
  function renderWithLibrarySlice(
    extraCharacters: Character[] = [],
    libraryOverride: Voice[] = libraryWithDuplicate,
  ) {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
        library: librarySlice.reducer,
      },
    });
    store.dispatch(castSlice.actions.setCharacters(extraCharacters));
    store.dispatch(
      librarySlice.actions.hydrate({
        authors: [
          {
            name: 'Test Author',
            series: [
              {
                name: 'Test Series',
                books: [
                  {
                    bookId: 'b1',
                    title: 'Book One',
                    author: 'Test Author',
                    series: 'Test Series',
                    seriesPosition: 1,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-01',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                  {
                    bookId: 'b2',
                    title: 'Book Two',
                    author: 'Test Author',
                    series: 'Test Series',
                    seriesPosition: 2,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-02',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    return {
      store,
      ...render(
        <Provider store={store}>
          <LibraryView library={libraryOverride} />
        </Provider>,
      ),
    };
  }

  /* Casts for the two duplicate books — each resolves its Eliza voice so
     `findCharacterForVoice` (voiceId/id match) lands a Character once the
     book hydrates. Mirrors the on-disk cast.json shape. */
  function elizaCasts(bookId: string): BookStateResponse | null {
    const chars: Record<string, Character[]> = {
      b1: [{ id: 'v_eliza', name: 'Eliza Gray', role: 'character', color: 'unset' } as Character],
      b2: [{ id: 'v_eliza_sb', name: 'Eliza', role: 'character', color: 'unset' } as Character],
    };
    if (!chars[bookId]) return null;
    return { cast: { characters: chars[bookId] } } as BookStateResponse;
  }

  it('surfaces a ⚠ pill on the family card with a cross-book candidate pair', async () => {
    renderWithLibrarySlice();
    await act(async () => {});
    const pill = screen.getByRole('button', { name: /1 duplicate candidate/i });
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/⚠/);
  });

  it('does NOT surface the pill when the winner voice already carries the alias, with no cast hydrated (reload regression)', async () => {
    /* The exact "duplicate pill reappears on reload" condition (plan 101 fix
       2026-05-26): fresh mount on the global tab, globalCastCache empty
       (getBookState left at its null default — never resolves a cast), but
       the library payload carries the persisted alias. Detection must read
       the Voice's own aliases and suppress. Before the fix the alias filter
       only ran against a hydrated Character, so the pair re-flagged on every
       load even though the link was on disk. */
    const elizaNsAliased = makeVoice({
      id: 'v_eliza',
      character: 'Eliza Gray',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
      aliases: ['Eliza'],
    });
    renderWithLibrarySlice([], [elizaNsAliased, elizaSb]);
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /duplicate candidate/i })).toBeNull();
  });

  it('clicking the ⚠ pill opens the modal and enables the link button once both casts hydrate', async () => {
    /* Regression for the "all buttons dead" bug: opening the modal must
       hydrate both foreign casts so the characters resolve and the
       link/variant buttons enable. Before the fix openDuplicateReview
       never hydrated, so the button stayed disabled forever. */
    getBookState.mockImplementation((bookId: string) => Promise.resolve(elizaCasts(bookId)));
    renderWithLibrarySlice();
    await act(async () => {});
    const pill = screen.getByRole('button', { name: /1 duplicate candidate/i });
    fireEvent.click(pill);
    /* The modal header says "Same person across books?" — unique on
       the page so we use it as the modal-mounted assertion. */
    expect(screen.getByText(/Same person across books\?/)).toBeInTheDocument();
    /* Both books hydrate on demand → the link button flips from its
       loading state to enabled. */
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Same character — link them/i })).toBeEnabled(),
    );
    expect(getBookState).toHaveBeenCalledWith('b1');
    expect(getBookState).toHaveBeenCalledWith('b2');
  });

  it('shows a hydration error and keeps the link button disabled when a cast fails to load', async () => {
    /* getBookState resolves null (the beforeEach default) → hydrateForeignCast
       throws "book state has no cast", marks the book failed, and toasts. The
       modal stays open in its failure state with the actions disabled. */
    const { store } = renderWithLibrarySlice();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /1 duplicate candidate/i }));
    await waitFor(() =>
      expect(screen.getByText(/try again later|load one book/i)).toBeInTheDocument(),
    );
    expect(screen.getByRole('button', { name: /Same character — link them/i })).toBeDisabled();
    expect(screen.getByRole('button', { name: /Different on purpose/i })).toBeDisabled();
    /* hydrateForeignCast surfaces the failure as a toast. */
    expect(store.getState().notifications.toasts.length).toBeGreaterThan(0);
  });

  it("selection pill swaps to 'Review duplicate ↗' button when the cross-book duplicate pair is hand-selected", async () => {
    renderWithLibrarySlice();
    await act(async () => {});
    /* Click both Eliza voice cards' radio circles. */
    const elizaGrayCard = screen.getByText('Eliza Gray').closest('div.group');
    const elizaCard = screen.getByText('Eliza').closest('div.group');
    expect(elizaGrayCard).toBeTruthy();
    expect(elizaCard).toBeTruthy();
    const grayCheckbox = within(elizaGrayCard as HTMLElement).getByLabelText(
      /Select voice for compare/i,
    );
    const elizaCheckbox = within(elizaCard as HTMLElement).getByLabelText(
      /Select voice for compare/i,
    );
    fireEvent.click(grayCheckbox);
    fireEvent.click(elizaCheckbox);
    /* The cross-book pair should show the Review-duplicate button. */
    expect(screen.getByRole('button', { name: /Review duplicate/i })).toBeInTheDocument();
    /* And NOT the same-book plan-99 Merge button. */
    expect(screen.queryByRole('button', { name: /Merge into/i })).toBeNull();
  });

  it('suppresses the pill when one side has the other in notLinkedTo (variant case)', async () => {
    /* Set ui.stage to ready/b1 so the redux cast resolves to the b1
       book — the memo only injects redux characters when currentBookId
       is set (real prod behaviour, matches `/voices` opened from inside
       a book). */
    const variantMarked: Character[] = [
      {
        id: 'v_eliza',
        name: 'Eliza Gray',
        role: 'character',
        color: 'unset',
        notLinkedTo: [{ bookId: 'b2', characterId: 'v_eliza_sb' }],
      } as Character,
    ];
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
        library: librarySlice.reducer,
      },
    });
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'complete' }));
    store.dispatch(castSlice.actions.setCharacters(variantMarked));
    store.dispatch(
      librarySlice.actions.hydrate({
        authors: [
          {
            name: 'Test Author',
            series: [
              {
                name: 'Test Series',
                books: [
                  {
                    bookId: 'b1',
                    title: 'Book One',
                    author: 'Test Author',
                    series: 'Test Series',
                    seriesPosition: 1,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-01',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                  {
                    bookId: 'b2',
                    title: 'Book Two',
                    author: 'Test Author',
                    series: 'Test Series',
                    seriesPosition: 2,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-02',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    render(
      <Provider store={store}>
        <LibraryView library={libraryWithDuplicate} />
      </Provider>,
    );
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /duplicate candidate/i })).toBeNull();
  });

  /* Core regression for the "merge fails silently then reappears" bug. On
     the GLOBAL view (no open book) both pair books are foreign, so the link
     winner's new alias must be reflected into `globalCastCache` — otherwise
     detection re-flags the pair the moment its memo re-runs. */
  it('suppresses the pill after linking when the winner is a foreign book (does not reappear)', async () => {
    getBookState.mockImplementation((bookId: string) => Promise.resolve(elizaCasts(bookId)));
    linkPriorCharacterMock.mockResolvedValue({
      matchedFrom: { bookId: 'b1', characterId: 'v_eliza', bookTitle: 'Book One', confidence: 1 },
      voiceId: 'v_eliza',
    });
    renderWithLibrarySlice();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /1 duplicate candidate/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Same character — link them/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Same character — link them/i }));
    /* Default survivor = "Eliza Gray" (b1); loser "Eliza" (b2). The link
       call fires, then the pill must vanish and STAY gone. */
    await waitFor(() => expect(linkPriorCharacterMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /duplicate candidate/i })).toBeNull(),
    );
    /* Re-settle a tick to prove it doesn't re-flag (the bug's tell). */
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /duplicate candidate/i })).toBeNull();
  });

  it('suppresses the pill after "Different on purpose" when both books are foreign', async () => {
    getBookState.mockImplementation((bookId: string) => Promise.resolve(elizaCasts(bookId)));
    notLinkedToMock.mockResolvedValue({
      pair: {
        a: { bookId: 'b1', characterId: 'v_eliza' },
        b: { bookId: 'b2', characterId: 'v_eliza_sb' },
      },
    });
    renderWithLibrarySlice();
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: /1 duplicate candidate/i }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Different on purpose/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Different on purpose/i }));
    await waitFor(() => expect(notLinkedToMock).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /duplicate candidate/i })).toBeNull(),
    );
    await act(async () => {});
    expect(screen.queryByRole('button', { name: /duplicate candidate/i })).toBeNull();
  });

  /* fe-9 — bulk per-series review. The series banner surfaces a "Review all
     duplicates in <Series>" button; opening it walks the queue one pair at a
     time. Here the queue has one pair, so linking it persists via the v1 route
     and closes the bulk modal. */
  it('opens a bulk review for the series and links the single queued pair', async () => {
    getBookState.mockImplementation((bookId: string) => Promise.resolve(elizaCasts(bookId)));
    linkPriorCharacterMock.mockResolvedValue({
      matchedFrom: { bookId: 'b1', characterId: 'v_eliza', bookTitle: 'Book One', confidence: 1 },
      voiceId: 'v_eliza',
    });
    renderWithLibrarySlice();
    await act(async () => {});
    /* The series banner button carries the series name + candidate count. */
    const bulkButton = screen.getByRole('button', {
      name: /Review all duplicates in Test Series/i,
    });
    expect(bulkButton).toHaveTextContent('(1)');
    fireEvent.click(bulkButton);
    /* Bulk modal mounts with the per-series progress strip (1 / 1) + the
       reused single-pair modal. */
    expect(screen.getByTestId('bulk-duplicate-review')).toBeInTheDocument();
    expect(screen.getByText('1 / 1')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /Same character — link them/i })).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', { name: /Same character — link them/i }));
    await waitFor(() => expect(linkPriorCharacterMock).toHaveBeenCalledTimes(1));
    /* Last pair resolved → bulk modal closes. */
    await waitFor(() =>
      expect(screen.queryByTestId('bulk-duplicate-review')).not.toBeInTheDocument(),
    );
  });

  it('skips the queued pair via the Skip control and closes when it is the last', async () => {
    getBookState.mockImplementation((bookId: string) => Promise.resolve(elizaCasts(bookId)));
    renderWithLibrarySlice();
    await act(async () => {});
    fireEvent.click(
      screen.getByRole('button', { name: /Review all duplicates in Test Series/i }),
    );
    expect(screen.getByTestId('bulk-duplicate-review')).toBeInTheDocument();
    /* Single-pair queue → the Skip control reads "Skip & finish". */
    fireEvent.click(screen.getByRole('button', { name: /Skip & finish/i }));
    await waitFor(() =>
      expect(screen.queryByTestId('bulk-duplicate-review')).not.toBeInTheDocument(),
    );
    expect(linkPriorCharacterMock).not.toHaveBeenCalled();
    expect(notLinkedToMock).not.toHaveBeenCalled();
  });

  /* fs-11 — "Show ignored duplicate suggestions" toggle + Unmark. The b1 Eliza
     carries the b2 Eliza in notLinkedTo (variant-marked), so the live
     duplicate candidate is suppressed but the Ignored section lists the pair.
     Unmark DELETEs the symmetric pair and re-surfaces the duplicate. */
  it('lists ignored pairs under the toggle and unmarks them, re-surfacing the candidate', async () => {
    removeNotLinkedToMock.mockResolvedValue({
      pair: {
        a: { bookId: 'b1', characterId: 'v_eliza' },
        b: { bookId: 'b2', characterId: 'v_eliza_sb' },
      },
    });
    /* Open book b1 so the variant-marked redux character drives suppression. */
    const variantMarked: Character[] = [
      {
        id: 'v_eliza',
        name: 'Eliza Gray',
        role: 'character',
        color: 'unset',
        notLinkedTo: [{ bookId: 'b2', characterId: 'v_eliza_sb' }],
      } as Character,
    ];
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
        library: librarySlice.reducer,
      },
    });
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'complete' }));
    store.dispatch(castSlice.actions.setCharacters(variantMarked));
    store.dispatch(
      librarySlice.actions.hydrate({
        authors: [
          {
            name: 'Test Author',
            series: [
              {
                name: 'Test Series',
                books: [
                  {
                    bookId: 'b1',
                    title: 'Book One',
                    author: 'Test Author',
                    series: 'Test Series',
                    seriesPosition: 1,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-01',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                  {
                    bookId: 'b2',
                    title: 'Book Two',
                    author: 'Test Author',
                    series: 'Test Series',
                    seriesPosition: 2,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-02',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    render(
      <Provider store={store}>
        <LibraryView library={libraryWithDuplicate} />
      </Provider>,
    );
    await act(async () => {});
    /* The live candidate pill is suppressed by the notLinkedTo. */
    expect(screen.queryByRole('button', { name: /duplicate candidate/i })).toBeNull();
    /* Toggle the Ignored section open → the pair is listed with an Unmark. */
    fireEvent.click(screen.getByTestId('toggle-ignored-duplicates'));
    const unmark = await screen.findByRole('button', { name: /^Unmark$/i });
    expect(unmark).toBeInTheDocument();
    fireEvent.click(unmark);
    await waitFor(() => expect(removeNotLinkedToMock).toHaveBeenCalledTimes(1));
    expect(removeNotLinkedToMock).toHaveBeenCalledWith({
      bookId: 'b1',
      characterId: 'v_eliza',
      otherBookId: 'b2',
      otherCharacterId: 'v_eliza_sb',
    });
    /* The redux removeNotLinked dispatched → the candidate pill re-surfaces. */
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /1 duplicate candidate/i })).toBeInTheDocument(),
    );
  });
});

describe('LibraryView per-series Rebaseline button (plan 108 follow-up)', () => {
  /* Two books in the same series ("The Hollow Tide"), b1 at
     seriesPosition 1 and b2 at 2, both carrying Charon-family voices. The
     per-series button surfaces on the series-group header; clicking it must
     dispatch openRebaselineModal with the series' representative book — here
     b2, since neither cast is cached so the latest-seriesPosition tiebreak
     decides. */
  function renderGlobalWithLibrary() {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
        library: librarySlice.reducer,
        rebaseline: rebaselineSlice.reducer,
      },
    });
    /* Global voices stage (no open book) so the book-scoped button stays
       hidden and only the per-series buttons can render. */
    store.dispatch(uiSlice.actions.openVoices());
    store.dispatch(
      librarySlice.actions.hydrate({
        authors: [
          {
            name: 'Test Author',
            series: [
              {
                name: 'The Hollow Tide',
                books: [
                  {
                    bookId: 'b1',
                    title: 'Book One',
                    author: 'Test Author',
                    series: 'The Hollow Tide',
                    seriesPosition: 1,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-01',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                  {
                    bookId: 'b2',
                    title: 'Book Two',
                    author: 'Test Author',
                    series: 'The Hollow Tide',
                    seriesPosition: 2,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-02',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    const view = render(
      <Provider store={store}>
        <LibraryView library={library} />
      </Provider>,
    );
    return { ...view, store };
  }

  it('renders a per-series Rebaseline button on the series-group header', () => {
    renderGlobalWithLibrary();
    /* The button repeats per family that carries the series; at least one
       must render with the series-scoped test id. */
    const buttons = screen.getAllByTestId('rebaseline-series-The Hollow Tide');
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons[0]).toHaveTextContent(/Rebaseline the series/i);
  });

  it('clicking dispatches openRebaselineModal with the representative bookId', async () => {
    const { store } = renderGlobalWithLibrary();
    const button = screen.getAllByTestId('rebaseline-series-The Hollow Tide')[0];
    await act(async () => {
      fireEvent.click(button);
    });
    expect(store.getState().ui.rebaselineModalOpen).toBe(true);
    /* No cast cached for either book → tiebreak is the latest seriesPosition,
       so b2 (position 2) is the representative. */
    expect(store.getState().ui.rebaselineBookId).toBe('b2');
  });
});

describe('LibraryView Qwen status sections (plan 117)', () => {
  /* Bespoke Qwen voices are 1:1 with characters, so the old voice-family
     grouping produced one degenerate section per voice. They now bucket by
     design status into exactly two sections, regardless of how many designed
     voices there are. A Gemini family co-exists in the same scroll. */
  const qwenLibrary: Voice[] = [
    makeVoice({
      id: 'g_charon',
      character: 'Halloran',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'q_none',
      character: 'Fenn',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'qwen', name: '', description: 'No voice designed yet' },
    }),
    makeVoice({
      id: 'q_designed',
      character: 'Marlow',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      overrideTtsVoices: { qwen: { name: 'qwen-marlow' } },
      ttsVoice: { provider: 'qwen', name: 'qwen-marlow', description: 'Designed voice' },
    }),
    makeVoice({
      id: 'q_sampled',
      character: 'Wren',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      overrideTtsVoices: { qwen: { name: 'qwen-wren' } },
      sampled: true,
      ttsVoice: { provider: 'qwen', name: 'qwen-wren', description: 'Designed voice' },
    }),
    makeVoice({
      id: 'q_generated',
      character: 'Oduvan',
      bookId: 'b2',
      bookTitle: 'Book Two',
      source: 'library',
      overrideTtsVoices: { qwen: { name: 'qwen-oduvan' } },
      generated: true,
      ttsVoice: { provider: 'qwen', name: 'qwen-oduvan', description: 'Designed voice' },
    }),
  ];

  function renderQwen() {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
        library: librarySlice.reducer,
        rebaseline: rebaselineSlice.reducer,
      },
    });
    store.dispatch(uiSlice.actions.openVoices());
    store.dispatch(
      librarySlice.actions.hydrate({
        authors: [
          {
            name: 'Test Author',
            series: [
              {
                name: 'The Hollow Tide',
                books: [
                  {
                    bookId: 'b1',
                    title: 'Book One',
                    author: 'Test Author',
                    series: 'The Hollow Tide',
                    seriesPosition: 1,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-01',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                  {
                    bookId: 'b2',
                    title: 'Book Two',
                    author: 'Test Author',
                    series: 'The Hollow Tide',
                    seriesPosition: 2,
                    isStandalone: false,
                    status: 'complete',
                    chapterCount: 0,
                    completedChapters: 0,
                    characterCount: 0,
                    voiceCount: 0,
                    lastWorkedOn: '2026-01-02',
                    coverGradient: ['#000', '#fff'],
                    tags: [],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    return render(
      <Provider store={store}>
        <LibraryView library={qwenLibrary} />
      </Provider>,
    );
  }

  it('renders exactly two Qwen status sections beside the preset family — not one per voice', () => {
    renderQwen();
    const labels = screen.getAllByRole('region').map((s) => s.getAttribute('aria-label'));
    expect(labels).toContain('Gemini · Charon');
    expect(labels).toContain('Qwen · Needs a voice');
    expect(labels).toContain('Qwen · Designed voices');
    /* Regression: two designed Qwen voices must NOT spawn two sections. */
    const qwenRegions = labels.filter((l) => l?.startsWith('Qwen · '));
    expect(qwenRegions).toHaveLength(2);
  });

  it('buckets an undesigned voice under "Needs a voice" and designed ones under "Designed voices"', () => {
    renderQwen();
    const needs = screen.getByRole('region', { name: 'Qwen · Needs a voice' });
    expect(within(needs).getByText('Fenn')).toBeInTheDocument();
    const designed = screen.getByRole('region', { name: 'Qwen · Designed voices' });
    expect(within(designed).getByText('Marlow')).toBeInTheDocument();
    expect(within(designed).getByText('Oduvan')).toBeInTheDocument();
  });

  it('badges a generated voice "Generated" and an unrendered designed voice "Designed"', () => {
    renderQwen();
    const designed = screen.getByRole('region', { name: 'Qwen · Designed voices' });
    expect(within(designed).getByText('Generated')).toBeInTheDocument();
    expect(within(designed).getByText('Designed')).toBeInTheDocument();
  });

  it('badges a sampled-but-unrendered designed voice "Sampled"', () => {
    renderQwen();
    const designed = screen.getByRole('region', { name: 'Qwen · Designed voices' });
    /* Wren is designed + auditioned (sampled) but no chapter has rendered. */
    expect(within(designed).getByText('Wren')).toBeInTheDocument();
    expect(within(designed).getByText('Sampled')).toBeInTheDocument();
  });

  it('omits the "Audition base voice" button from Qwen section headers', () => {
    renderQwen();
    const needs = screen.getByRole('region', { name: 'Qwen · Needs a voice' });
    const designed = screen.getByRole('region', { name: 'Qwen · Designed voices' });
    expect(within(needs).queryByRole('button', { name: /Audition base voice/i })).toBeNull();
    expect(within(designed).queryByRole('button', { name: /Audition base voice/i })).toBeNull();
  });

  it('shows the per-series Rebaseline button on a Qwen section', () => {
    renderQwen();
    const buttons = screen.getAllByTestId('rebaseline-series-The Hollow Tide');
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons[0]).toHaveTextContent(/Rebaseline the series/i);
  });

  it('does not show the "No voices yet" empty state for a Qwen-only library', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    render(
      <Provider store={store}>
        <LibraryView
          library={[
            makeVoice({
              id: 'q_only',
              character: 'Solo',
              bookId: 'b1',
              bookTitle: 'Book One',
              source: 'current',
              ttsVoice: { provider: 'qwen', name: '', description: 'No voice designed yet' },
            }),
          ]}
        />
      </Provider>,
    );
    expect(screen.queryByText('No voices yet')).toBeNull();
    expect(screen.getByRole('region', { name: 'Qwen · Needs a voice' })).toBeInTheDocument();
  });
});

describe('LibraryView Base voices tab', () => {
  it('shows the catalog from getBaseVoices when the user clicks the tab', async () => {
    getBaseVoices.mockResolvedValue({
      voices: [
        { engine: 'coqui', name: 'Asya Anara' },
        { engine: 'gemini', name: 'Charon' },
      ],
    });
    renderView();
    /* Catalog is fetched on mount; await the promise resolution before
       clicking through to the tab. */
    await new Promise((resolve) => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: /Base voices/i }));
    expect(screen.getByText('Asya Anara')).toBeInTheDocument();
    /* Charon appears in BOTH the family section and the base catalog; the
       Coqui section is what proves the catalog itself is rendering. */
    expect(screen.getByLabelText('Coqui')).toBeInTheDocument();
  });
});

describe('fe-34 — variant filter toggle', () => {
  const designedNeeds: Character = {
    id: 'fury', name: 'Fury', role: 'Rival', color: 'mentor', lines: 4, scenes: 1, attributes: [],
    ttsEngine: 'qwen', voiceId: 'qwen-fury',
    overrideTtsVoices: { qwen: { name: 'qwen-fury', variants: {} } },
  };
  const designedHas: Character = {
    id: 'calm', name: 'Calm', role: 'Sage', color: 'mentor', lines: 4, scenes: 1, attributes: [],
    ttsEngine: 'qwen', voiceId: 'qwen-calm',
    overrideTtsVoices: { qwen: { name: 'qwen-calm', variants: { angry: { name: 'qwen-calm-angry' } } } },
  };
  const toggleSentences: Sentence[] = [
    { id: 1, chapterId: 1, text: 'No!', characterId: 'fury', emotion: 'angry' },
    { id: 2, chapterId: 1, text: 'Peace.', characterId: 'calm', emotion: 'angry' },
  ];
  const qwenLib: Voice[] = [
    { id: 'qwen-fury', character: 'Fury', bookId: 'b1', bookTitle: 'Book One', attributes: [],
      usedIn: 1, source: 'current', gradient: ['#000', '#111'],
      ttsVoice: { provider: 'qwen', name: 'qwen-fury', description: '' } },
    { id: 'qwen-calm', character: 'Calm', bookId: 'b1', bookTitle: 'Book One', attributes: [],
      usedIn: 1, source: 'current', gradient: ['#000', '#111'],
      ttsVoice: { provider: 'qwen', name: 'qwen-calm', description: '' } },
  ];

  function renderToggleView() {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    /* Set ui.stage to ready with bookId='b1' so currentBookId resolves and the
       voices view reads cast + sentences from redux (not foreign-cast cache). */
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'cast_pending' }));
    store.dispatch(uiSlice.actions.confirmCast());
    /* Hydrate cast with the two Qwen characters used by the qwenLib voices. */
    store.dispatch(castSlice.actions.setCharacters([designedNeeds, designedHas]));
    /* Hydrate manuscript sentences so usedEmotionsByCharacter has data. */
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        chapters: [],
        characters: [designedNeeds, designedHas],
        sentences: toggleSentences,
      } as never),
    );
    return render(
      <Provider store={store}>
        <LibraryView library={qwenLib} />
      </Provider>,
    );
  }

  it('narrows the designed voices to needs-variants when "Needs variants" is selected', async () => {
    renderToggleView();
    await act(async () => {}); // flush the getBaseVoices mount effect
    expect(screen.getByText('Calm')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Needs variants/ }));
    expect(screen.getByText('Fury')).toBeInTheDocument();
    expect(screen.queryByText('Calm')).toBeNull();
  });

  it('narrows to has-variants when "Has variants" is selected', async () => {
    renderToggleView();
    await act(async () => {}); // flush the getBaseVoices mount effect
    fireEvent.click(screen.getByRole('button', { name: /^Has variants/ }));
    expect(screen.getByText('Calm')).toBeInTheDocument();
    expect(screen.queryByText('Fury')).toBeNull();
  });

  it('shows "No voices match this filter" (not the global empty state) when a filter excludes all', async () => {
    // Library with ONLY a fully-covered voice → "Needs variants" matches nothing.
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        voices: voicesSlice.reducer,
        notifications: notificationsSlice.reducer,
      },
    });
    store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'cast_pending' }));
    store.dispatch(uiSlice.actions.confirmCast());
    store.dispatch(castSlice.actions.setCharacters([designedHas]));
    store.dispatch(
      manuscriptSlice.actions.hydrateFromAnalysis({
        chapters: [],
        characters: [designedHas],
        sentences: [{ id: 2, chapterId: 1, text: 'Peace.', characterId: 'calm', emotion: 'angry' }],
      } as never),
    );
    render(
      <Provider store={store}>
        <LibraryView library={[qwenLib[1]]} />
      </Provider>,
    );
    await act(async () => {}); // flush the getBaseVoices mount effect
    fireEvent.click(screen.getByRole('button', { name: /^Needs variants/ }));
    expect(screen.getByText('No voices match this filter')).toBeInTheDocument();
    expect(screen.queryByText('No voices yet')).toBeNull();
    // The toggle stays reachable so the user can switch back (exact name avoids
    // matching the "All (N)" tab button).
    const variantGroup = screen.getByRole('group', { name: 'Filter by emotion variants' });
    expect(within(variantGroup).getByRole('button', { name: 'All' })).toBeInTheDocument();
  });

  it('shows a per-card "Needs" badge on a designed voice missing a variant', async () => {
    renderToggleView();
    await act(async () => {}); // flush the getBaseVoices mount effect
    // Default 'all' filter shows both designed cards. Only Fury (no variants,
    // speaks an "angry" quote) is missing one → exactly one Needs badge.
    const needs = screen.getAllByTestId('needs-variants-badge');
    expect(needs).toHaveLength(1);
    expect(needs[0]).toHaveTextContent('Needs · 1');
    // Calm is fully covered → carries the Variants badge, never a Needs badge.
    expect(screen.getByTestId('variants-badge')).toHaveTextContent('Variants');
  });
});

describe('fs-41/fs-50 seam 4b — language facet on the global #/voices view', () => {
  /* Test-local makeVoice that adds languageCode support on top of the
     module-level makeVoice without modifying it. */
  function makeLangVoice(
    over: Partial<Voice> & Pick<Voice, 'id' | 'character' | 'bookId' | 'bookTitle' | 'source'>,
  ): Voice {
    return makeVoice(over);
  }

  function renderLangView(lib: Voice[]) {
    return render(
      <Provider store={makeStore()}>
        <LibraryView library={lib} />
      </Provider>,
    );
  }

  it('shows no language facet when all voices lack a languageCode (English-only library)', async () => {
    /* Preset English voices carry no languageCode. The facet must not appear. */
    const lib: Voice[] = [
      makeLangVoice({ id: 'v_narrator', character: 'Narrator', bookId: 'b1', bookTitle: 'Book One', source: 'current' }),
      makeLangVoice({ id: 'v_marlow', character: 'Marlow', bookId: 'b1', bookTitle: 'Book One', source: 'current' }),
    ];
    renderLangView(lib);
    await act(async () => {});
    expect(screen.queryByRole('group', { name: 'Filter by language' })).toBeNull();
    /* Both voices visible — nothing filtered. */
    expect(screen.getByText('Narrator')).toBeInTheDocument();
    expect(screen.getByText('Marlow')).toBeInTheDocument();
  });

  it('shows the language facet when at least one voice has a non-English languageCode', async () => {
    const lib: Voice[] = [
      makeLangVoice({ id: 'v_ivan', character: 'Ivan', bookId: 'b1', bookTitle: 'Book One', source: 'current', languageCode: 'ru' }),
      makeLangVoice({ id: 'v_preset', character: 'Preset', bookId: 'b1', bookTitle: 'Book One', source: 'current' }),
    ];
    renderLangView(lib);
    await act(async () => {});
    expect(screen.getByRole('group', { name: 'Filter by language' })).toBeInTheDocument();
    /* "All" and "Russian" buttons present. */
    const group = screen.getByRole('group', { name: 'Filter by language' });
    expect(within(group).getByRole('button', { name: 'All' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Russian' })).toBeInTheDocument();
  });

  it('filters the voice list to the selected language when a facet is clicked', async () => {
    /* One Russian-designed voice + one preset (no languageCode = English). */
    const lib: Voice[] = [
      makeLangVoice({ id: 'v_ivan', character: 'Ivan', bookId: 'b1', bookTitle: 'Book One', source: 'current', languageCode: 'ru' }),
      makeLangVoice({ id: 'v_preset', character: 'Preset', bookId: 'b1', bookTitle: 'Book One', source: 'current' }),
    ];
    renderLangView(lib);
    await act(async () => {});
    /* Default "All": both voices present. */
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.getByText('Preset')).toBeInTheDocument();
    /* Click "Russian" → only Ivan stays. */
    fireEvent.click(screen.getByRole('button', { name: 'Russian' }));
    expect(screen.getByText('Ivan')).toBeInTheDocument();
    expect(screen.queryByText('Preset')).not.toBeInTheDocument();
  });

  it('restores all voices when "All" is clicked after a language selection', async () => {
    const lib: Voice[] = [
      makeLangVoice({ id: 'v_ivan', character: 'Ivan', bookId: 'b1', bookTitle: 'Book One', source: 'current', languageCode: 'ru' }),
      makeLangVoice({ id: 'v_preset', character: 'Preset', bookId: 'b1', bookTitle: 'Book One', source: 'current' }),
    ];
    renderLangView(lib);
    await act(async () => {});
    fireEvent.click(screen.getByRole('button', { name: 'Russian' }));
    expect(screen.queryByText('Preset')).not.toBeInTheDocument();
    const group = screen.getByRole('group', { name: 'Filter by language' });
    fireEvent.click(within(group).getByRole('button', { name: 'All' }));
    expect(screen.getByText('Preset')).toBeInTheDocument();
    expect(screen.getByText('Ivan')).toBeInTheDocument();
  });

  it('labels known language codes with their English word (Russian, Spanish, French, German)', async () => {
    const lib: Voice[] = [
      makeLangVoice({ id: 'v_ru', character: 'Ru', bookId: 'b1', bookTitle: 'B1', source: 'current', languageCode: 'ru' }),
      makeLangVoice({ id: 'v_es', character: 'Es', bookId: 'b1', bookTitle: 'B1', source: 'current', languageCode: 'es' }),
      makeLangVoice({ id: 'v_fr', character: 'Fr', bookId: 'b1', bookTitle: 'B1', source: 'current', languageCode: 'fr' }),
      makeLangVoice({ id: 'v_de', character: 'De', bookId: 'b1', bookTitle: 'B1', source: 'current', languageCode: 'de' }),
    ];
    renderLangView(lib);
    await act(async () => {});
    const group = screen.getByRole('group', { name: 'Filter by language' });
    expect(within(group).getByRole('button', { name: 'Russian' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'Spanish' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'French' })).toBeInTheDocument();
    expect(within(group).getByRole('button', { name: 'German' })).toBeInTheDocument();
  });

  it('falls back to the raw BCP-47 code when the language is not in the label map', async () => {
    const lib: Voice[] = [
      makeLangVoice({ id: 'v_ja', character: 'Tanaka', bookId: 'b1', bookTitle: 'B1', source: 'current', languageCode: 'ja' }),
    ];
    renderLangView(lib);
    await act(async () => {});
    const group = screen.getByRole('group', { name: 'Filter by language' });
    /* 'ja' is not in the label map → rendered as-is. */
    expect(within(group).getByRole('button', { name: 'ja' })).toBeInTheDocument();
  });
});
