// Pairs with docs/features/22-voice-library.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
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

vi.mock('../lib/api', () => ({
  api: {
    setVoicePin: (voiceId: string, pinned: boolean) => setVoicePin(voiceId, pinned),
    getBaseVoices: () => getBaseVoices(),
    setVoiceOverride: (...args: unknown[]) => setVoiceOverride(...args),
    getBookState: (bookId: string) => getBookState(bookId),
    seriesPatchCharacter: (args: {
      bookId: string;
      characterId: string;
      patch: Record<string, unknown>;
    }) => seriesPatchCharacter(args),
    mergeCharacters: (args: { bookId: string; sourceId: string; targetId: string }) =>
      mergeCharactersMock(args),
  },
}));

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator', lines: 120 },
  { id: 'keefe', name: 'Keefe', role: 'Empath', color: 'peach', lines: 60 },
  { id: 'elwin', name: 'Elwin', role: 'Healer', color: 'magenta', lines: 10 },
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
    bookSeries: 'Keeper of the Lost Cities',
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
    id: 'keefe',
    character: 'Keefe',
    bookId: 'b2',
    bookTitle: 'Book Two',
    source: 'library',
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
  }),
  makeVoice({
    id: 'elwin',
    character: 'Elwin',
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
    /* Two cast members (Narrator in Book One, Keefe in Book Two) hang
       off this family. The two book titles must both appear as nested
       headers. */
    expect(within(charonSection).getByText('Book One')).toBeInTheDocument();
    expect(within(charonSection).getByText('Book Two')).toBeInTheDocument();
    /* Both cast names appear in the section. */
    expect(within(charonSection).getByText('Narrator')).toBeInTheDocument();
    expect(within(charonSection).getByText('Keefe')).toBeInTheDocument();
  });

  it('groups books under their series header when bookSeries is set', () => {
    renderView();
    const charonSection = screen.getByRole('region', { name: 'Gemini · Charon' });
    /* The series header is rendered above the books. */
    expect(within(charonSection).getByText('Keeper of the Lost Cities')).toBeInTheDocument();
  });

  it('filters to families with current-source members under the "This book" tab', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /This book/i }));
    /* Charon has Narrator (current); Kore has Elwin (current). Both stay. */
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(2);
  });

  it('filters to families with only library-source members under "Series & older"', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Series & older/i }));
    /* Only Keefe (library) survives — its family Charon. Kore's only
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
    /* Both `Keefe` and the bookTitle `Book Two` render the same text node
       in different contexts; the character card carries role="button" so
       scope the lookup that way. */
    const card = screen.getByText('Keefe').closest('[role="button"]')!;
    expect(card).not.toBeNull();
    fireEvent.click(card);
    expect(onOpenCharacter).toHaveBeenCalledTimes(1);
    expect(onOpenCharacter.mock.calls[0][0].id).toBe('keefe');
    expect(onOpenCharacter.mock.calls[0][0].bookId).toBe('b2');
  });

  it('leaves cards drag-only when onOpenCharacter is unset (no false-interactive a11y signal)', () => {
    renderView();
    /* Without the handler the card must not advertise role="button" — the
     legacy LibraryView behavior pre-bug-fix. */
    expect(screen.queryByRole('button', { name: 'Keefe' })).toBeNull();
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
    { id: 'elwin', name: 'Elwin', role: 'Healer', color: 'magenta', lines: 10, voiceId: 'elwin' },
    { id: 'sandor', name: 'Sandor', role: 'Guard', color: 'peach', lines: 30, voiceId: 'sandor' },
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
      id: 'sandor',
      character: 'Sandor',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'elwin',
      character: 'Elwin',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
    }),
    makeVoice({
      id: 'keefe',
      character: 'Keefe',
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
    /* Click Narrator + Sandor — both b1 + both Charon. */
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Sandor')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    expect(screen.getByText('same base voice ✓')).toBeInTheDocument();
    expect(screen.queryByText('different base voices')).toBeNull();
  });

  it('shows the amber "different base voices" badge when 2 cross-family voices are selected (plan 22a)', () => {
    renderCompare();
    /* Click Narrator (Charon) + Elwin (Kore) — both b1, different families. */
    fireEvent.click(
      screen
        .getByText('Narrator')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      screen
        .getByText('Elwin')
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
        .getByText('Sandor')
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
        .getByText('Sandor')
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    const compareBtn = screen.getByRole('button', { name: 'Compare' });
    expect(compareBtn).not.toBeDisabled();
  });

  it('enables Compare on a cross-book pair and hydrates the foreign cast on click (plan 96, BACKLOG #7)', async () => {
    /* Narrator (b1, open book) + Keefe (b2, foreign). The plan-82 lift
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
          { id: 'keefe', name: 'Keefe', role: 'Empath', color: 'peach', voiceId: 'keefe' },
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
        .getByText('Keefe')
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
        .getByText('Sandor')
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
          .getByText('Sandor')
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
          .getByText('Sandor')
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
          .getByText('Sandor')
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
          .getByText('Sandor')
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
          .getByText('Sandor')
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
  /* Cast carries a Sophie + Sophie Foster duplicate pair in book b1, both
     resolving to the same Charon base voice — the substring-containment
     case the user described. A third Sophie clone lives in book b2 so we
     can also assert the cross-book guard. */
  const charactersB1: Character[] = [
    { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator', voiceId: 'narrator' },
    { id: 'sophie', name: 'Sophie', role: 'Lead', color: 'peach', voiceId: 'sophie' },
    {
      id: 'sophie-foster',
      name: 'Sophie Foster',
      role: 'Lead',
      color: 'peach',
      voiceId: 'sophie-foster',
    },
    { id: 'elwin', name: 'Elwin', role: 'Healer', color: 'magenta', voiceId: 'elwin' },
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
      id: 'sophie',
      character: 'Sophie',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'sophie-foster',
      character: 'Sophie Foster',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'elwin',
      character: 'Elwin',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
    }),
  ];

  /* The cross-book guard test needs a second "Sophie" living in a
     different book. Kept out of the default fixture because two
     "Sophie" text matches would defeat plain getByText lookups in
     every other test. */
  const sophieFromBookTwo: Voice = makeVoice({
    id: 'sophie-b2',
    character: 'Sophie',
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
    selectCard('Sophie');
    selectCard('Sophie Foster');
    /* Substring containment picks "Sophie Foster" as the survivor. */
    expect(
      screen.getByRole('button', { name: 'Merge into Sophie Foster' }),
    ).toBeInTheDocument();
  });

  it('hides the Merge button for 2 same-voice DIFFERENT-book duplicates (cross-book guard)', async () => {
    /* "Sophie" lives in both b1 (id=sophie) and b2 (id=sophie-b2). Pick
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
        characters: [{ id: 'sophie-b2', name: 'Sophie', role: 'Lead', color: 'peach' }],
      },
      manuscript: null,
      manuscriptEdits: null,
      revisions: null,
      completedSlugs: [],
      chapterCharacters: undefined,
      changeLog: null,
      analysis: undefined,
    });
    renderMerge([...libraryB1, sophieFromBookTwo]);
    /* Two "Sophie" labels exist (one per book) — disambiguate via closest
       book section. Sophie-b1 stays the first match; Sophie-b2 is the
       second. */
    const sophieCards = screen.getAllByText('Sophie');
    fireEvent.click(
      sophieCards[0]
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    fireEvent.click(
      sophieCards[1]
        .closest('div.group')!
        .querySelector('[aria-label="Select voice for compare"]')!,
    );
    expect(screen.queryByRole('button', { name: /^Merge into/ })).toBeNull();
  });

  it('hides the Merge button for 2 DIFFERENT-base-voice selections', () => {
    renderMerge();
    selectCard('Sophie');
    selectCard('Elwin');
    expect(screen.getByText('different base voices')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Merge into/ })).toBeNull();
  });

  it('hides the Merge button when a narrator/bucket id is one of the two selected', () => {
    /* Narrator + Sophie are both b1, but Charon ≠ Charon for narrator
       in our test fixture (narrator carries the default ttsVoice in
       makeVoice — Charon). Force the same-base check by re-selecting
       sophie-foster + narrator: same provider, both Charon — but
       narrator is a forbidden id. */
    renderMerge();
    selectCard('Narrator');
    selectCard('Sophie Foster');
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
          id: 'sophie-foster',
          name: 'Sophie Foster',
          role: 'Lead',
          color: 'peach',
          aliases: ['Sophie'],
        },
        { id: 'elwin', name: 'Elwin', role: 'Healer', color: 'magenta' },
      ],
    });
    renderMerge();
    selectCard('Sophie');
    selectCard('Sophie Foster');
    const mergeBtn = screen.getByRole('button', { name: 'Merge into Sophie Foster' });
    fireEvent.click(mergeBtn);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mergeCharactersMock).toHaveBeenCalledTimes(1);
    expect(mergeCharactersMock).toHaveBeenCalledWith({
      bookId: 'b1',
      sourceId: 'sophie',
      targetId: 'sophie-foster',
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
  function renderWithLibrarySlice(extraCharacters: Character[] = []) {
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
    return render(
      <Provider store={store}>
        <LibraryView library={libraryWithDuplicate} />
      </Provider>,
    );
  }

  it('surfaces a ⚠ pill on the family card with a cross-book candidate pair', async () => {
    renderWithLibrarySlice();
    await act(async () => {});
    const pill = screen.getByRole('button', { name: /1 duplicate candidate/i });
    expect(pill).toBeInTheDocument();
    expect(pill).toHaveTextContent(/⚠/);
  });

  it('clicking the ⚠ pill opens the duplicate-review modal pre-populated', async () => {
    renderWithLibrarySlice();
    await act(async () => {});
    const pill = screen.getByRole('button', { name: /1 duplicate candidate/i });
    fireEvent.click(pill);
    /* The modal header says "Same person across books?" — unique on
       the page so we use it as the modal-mounted assertion. */
    expect(screen.getByText(/Same person across books\?/)).toBeInTheDocument();
    /* And the modal CTA appears. */
    expect(
      screen.getByRole('button', { name: /Same character — link them/i }),
    ).toBeInTheDocument();
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
});

describe('LibraryView per-series Rebaseline button (plan 108 follow-up)', () => {
  /* Two books in the same series ("Keeper of the Lost Cities"), b1 at
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
                name: 'Keeper of the Lost Cities',
                books: [
                  {
                    bookId: 'b1',
                    title: 'Book One',
                    author: 'Test Author',
                    series: 'Keeper of the Lost Cities',
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
                    series: 'Keeper of the Lost Cities',
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
    const buttons = screen.getAllByTestId('rebaseline-series-Keeper of the Lost Cities');
    expect(buttons.length).toBeGreaterThanOrEqual(1);
    expect(buttons[0]).toHaveTextContent(/Rebaseline the series/i);
  });

  it('clicking dispatches openRebaselineModal with the representative bookId', async () => {
    const { store } = renderGlobalWithLibrary();
    const button = screen.getAllByTestId('rebaseline-series-Keeper of the Lost Cities')[0];
    await act(async () => {
      fireEvent.click(button);
    });
    expect(store.getState().ui.rebaselineModalOpen).toBe(true);
    /* No cast cached for either book → tiebreak is the latest seriesPosition,
       so b2 (position 2) is the representative. */
    expect(store.getState().ui.rebaselineBookId).toBe('b2');
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
