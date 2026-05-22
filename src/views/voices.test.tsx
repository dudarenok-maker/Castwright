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
  },
}));

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator', lines: 120 },
  { id: 'Marlow', name: 'Marlow', role: 'Empath', color: 'peach', lines: 60 },
  { id: 'Oduvan', name: 'Oduvan', role: 'Healer', color: 'magenta', lines: 10 },
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
    id: 'Marlow',
    character: 'Marlow',
    bookId: 'b2',
    bookTitle: 'Book Two',
    source: 'library',
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
  }),
  makeVoice({
    id: 'Oduvan',
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
    expect(onOpenCharacter.mock.calls[0][0].id).toBe('Marlow');
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
    { id: 'Oduvan', name: 'Oduvan', role: 'Healer', color: 'magenta', lines: 10, voiceId: 'Oduvan' },
    { id: 'Garrow', name: 'Garrow', role: 'Guard', color: 'peach', lines: 30, voiceId: 'Garrow' },
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
      id: 'Garrow',
      character: 'Garrow',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    }),
    makeVoice({
      id: 'Oduvan',
      character: 'Oduvan',
      bookId: 'b1',
      bookTitle: 'Book One',
      source: 'current',
      ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' },
    }),
    makeVoice({
      id: 'Marlow',
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
          { id: 'Marlow', name: 'Marlow', role: 'Empath', color: 'peach', voiceId: 'Marlow' },
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
