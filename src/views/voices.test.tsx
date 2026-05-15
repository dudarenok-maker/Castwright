// Pairs with docs/features/22-voice-library.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { castSlice } from '../store/cast-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { voicesSlice } from '../store/voices-slice';
import { LibraryView } from './voices';
import type { BaseVoice, Character, Sentence, Voice } from '../lib/types';

const setVoicePin = vi.fn((_voiceId: string, _pinned: boolean) => Promise.resolve());
const getBaseVoices = vi.fn<() => Promise<{ voices: BaseVoice[] }>>(() => Promise.resolve({ voices: [] }));
const setVoiceOverride = vi.fn();

vi.mock('../lib/api', () => ({
  api: {
    setVoicePin: (voiceId: string, pinned: boolean) => setVoicePin(voiceId, pinned),
    getBaseVoices: () => getBaseVoices(),
    setVoiceOverride: (...args: unknown[]) => setVoiceOverride(...args),
  },
}));

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator', lines: 120 },
  { id: 'keefe',    name: 'Keefe',    role: 'Empath',   color: 'peach',    lines: 60  },
  { id: 'elwin',    name: 'Elwin',    role: 'Healer',   color: 'magenta',  lines: 10  },
];

const sentences: Sentence[] = [];

function makeVoice(over: Partial<Voice> & Pick<Voice, 'id' | 'character' | 'bookId' | 'bookTitle' | 'source'>): Voice {
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
  makeVoice({ id: 'narrator', character: 'Narrator', bookId: 'b1', bookTitle: 'Book One',  source: 'current' }),
  makeVoice({ id: 'keefe',    character: 'Keefe',    bookId: 'b2', bookTitle: 'Book Two',  source: 'library',
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' } }),
  makeVoice({ id: 'elwin',    character: 'Elwin',    bookId: 'b1', bookTitle: 'Book One',  source: 'current',
    ttsVoice: { provider: 'gemini', name: 'Kore', description: 'Firm' } }),
];

function makeStore() {
  const store = configureStore({
    reducer: {
      ui:         uiSlice.reducer,
      cast:       castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      voices:     voicesSlice.reducer,
    },
  });
  store.dispatch(castSlice.actions.setCharacters(characters));
  store.dispatch(manuscriptSlice.actions.hydrateFromAnalysis({
    chapters: [], characters, sentences,
  } as never));
  return store;
}

function renderView(lib: Voice[] = library, onOpenCharacter?: (v: Voice) => void) {
  return render(
    <Provider store={makeStore()}>
      <LibraryView library={lib} onOpenCharacter={onOpenCharacter}/>
    </Provider>
  );
}

beforeEach(() => {
  setVoicePin.mockClear();
  getBaseVoices.mockClear();
  getBaseVoices.mockResolvedValue({ voices: [] });
  setVoiceOverride.mockClear();
});

describe('LibraryView voice-family grouping', () => {
  it('renders one section per voice family (e.g. Charon, Kore) — not per book', () => {
    renderView();
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(2);
    const labels = sections.map(s => s.getAttribute('aria-label'));
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
    await new Promise(resolve => setTimeout(resolve, 0));
    fireEvent.click(screen.getByRole('button', { name: /Base voices/i }));
    expect(screen.getByText('Asya Anara')).toBeInTheDocument();
    /* Charon appears in BOTH the family section and the base catalog; the
       Coqui section is what proves the catalog itself is rendering. */
    expect(screen.getByLabelText('Coqui')).toBeInTheDocument();
  });
});
