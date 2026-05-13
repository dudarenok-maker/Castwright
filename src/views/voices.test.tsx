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
import type { Character, Sentence, Voice } from '../lib/types';

const setVoicePin = vi.fn((_voiceId: string, _pinned: boolean) => Promise.resolve());

vi.mock('../lib/api', () => ({
  api: {
    setVoicePin: (voiceId: string, pinned: boolean) => setVoicePin(voiceId, pinned),
  },
}));

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'Narrator', color: 'narrator', lines: 120 },
  { id: 'Marlow',    name: 'Marlow',    role: 'Empath',   color: 'peach',    lines: 60  },
  { id: 'Oduvan',    name: 'Oduvan',    role: 'Healer',   color: 'magenta',  lines: 10  },
];

const sentences: Sentence[] = [];

function makeVoice(over: Partial<Voice> & Pick<Voice, 'id' | 'character' | 'bookId' | 'bookTitle' | 'source'>): Voice {
  return {
    attributes: ['warm'],
    gradient: ['#3C194F', '#0F0E0D'],
    usedIn: 1,
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
    ...over,
  } as Voice;
}

const library: Voice[] = [
  makeVoice({ id: 'narrator', character: 'Narrator', bookId: 'b1', bookTitle: 'the Coalfall Commission', source: 'current' }),
  makeVoice({ id: 'Marlow',    character: 'Marlow',    bookId: 'b1', bookTitle: 'the Coalfall Commission', source: 'current' }),
  makeVoice({ id: 'Oduvan',    character: 'Oduvan',    bookId: 'b1', bookTitle: 'the Coalfall Commission', source: 'current' }),
  makeVoice({ id: 'v_lib',    character: 'Pemberton', bookId: 'sb', bookTitle: 'Solway Bay',         source: 'library', usedIn: 2 }),
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

function renderView(lib: Voice[] = library) {
  return render(
    <Provider store={makeStore()}>
      <LibraryView library={lib}/>
    </Provider>
  );
}

beforeEach(() => {
  setVoicePin.mockClear();
});

describe('LibraryView grouping', () => {
  it('renders one section per distinct book, current-source first', () => {
    renderView();
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(2);
    /* aria-label === bookTitle; first section is the current book. */
    expect(sections[0]).toHaveAttribute('aria-label', 'the Coalfall Commission');
    expect(sections[1]).toHaveAttribute('aria-label', 'Solway Bay');
  });

  it('shows the book title once in the section header, not duplicated inside each card', () => {
    renderView();
    /* The current-book section renders 3 cards; if showBookTitle leaked, we'd
       see "the Coalfall Commission" four times. Section header counts once. */
    const matches = screen.getAllByText('the Coalfall Commission');
    expect(matches.length).toBe(1);
  });

  it('drops the redundant "Used in N book" footer', () => {
    renderView();
    expect(screen.queryByText(/Used in \d+ book/i)).toBeNull();
  });

  it('sorts voices within a section by line count desc', () => {
    renderView();
    const currentSection = screen.getByRole('region', { name: 'the Coalfall Commission' });
    const names = within(currentSection).getAllByText(/^(Narrator|Marlow|Oduvan)$/).map(n => n.textContent);
    /* Narrator (120) > Marlow (60) > Oduvan (10) */
    expect(names).toEqual(['Narrator', 'Marlow', 'Oduvan']);
  });

  it('filters by "This book" tab to current-source sections only', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /This book/i }));
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(1);
    expect(sections[0]).toHaveAttribute('aria-label', 'the Coalfall Commission');
  });

  it('filters by "Series & older" tab to library-source sections only', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: /Series & older/i }));
    const sections = screen.getAllByRole('region');
    expect(sections.length).toBe(1);
    expect(sections[0]).toHaveAttribute('aria-label', 'Solway Bay');
  });
});

describe('LibraryView pin button', () => {
  it('renders an inline pin button per card and calls api.setVoicePin on click', () => {
    renderView();
    const pinButtons = screen.getAllByRole('button', { name: /Pin voice|Unpin voice/i });
    /* One per voice card: 3 current + 1 library = 4. */
    expect(pinButtons.length).toBe(4);
    fireEvent.click(pinButtons[0]);
    expect(setVoicePin).toHaveBeenCalledTimes(1);
    expect(setVoicePin).toHaveBeenCalledWith(expect.any(String), true);
  });
});
