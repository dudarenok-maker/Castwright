/* ConfirmCastView — verifies that a character carrying matchedFrom from
   the voice-match response renders the "Matched · N%" pill and lands in
   the "Reuse" decision tile by default. Pairs with
   docs/features/09-voice-match-pipeline.md. */

import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { ConfirmCastView } from './confirm-cast';
import type { Character, Voice } from '../lib/types';

const keefe: Character = {
  id: 'keefe',
  name: 'Keefe',
  role: 'sidekick',
  color: 'eliza',
  lines: 42,
  scenes: 7,
  attributes: ['playful', 'sarcastic'],
  voiceId: 'v_keefe',
  voiceState: 'reused',
  gender: 'male',
  ageRange: 'teen',
  matchedFrom: { bookTitle: 'Book One', confidence: 0.95 },
  matchFactors: [
    { id: 'name_exact', label: 'Name match', score: 1, detail: 'Keefe ≡ Keefe' },
  ],
};

const sophie: Character = {
  id: 'sophie',
  name: 'Sophie',
  role: 'protagonist',
  color: 'sophie',
  lines: 120,
  scenes: 15,
  attributes: ['brave'],
  voiceState: 'generated',
  gender: 'female',
  ageRange: 'teen',
};

const library: Voice[] = [
  {
    id:         'v_keefe',
    character:  'Keefe',
    bookTitle:  'Book One',
    bookId:     'book_one',
    attributes: ['playful', 'sarcastic'],
    gradient:   ['#3C194F', '#0F0E0D'],
    usedIn:     1,
    source:     'library',
    ttsVoice:   {
      provider:    'coqui',
      name:        'male-teen-playful',
      description: 'Light male teen voice with a sardonic edge',
    },
  },
];

function renderView() {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer },
  });
  return render(
    <Provider store={store}>
      <ConfirmCastView
        characters={[keefe, sophie]}
        library={library}
        title="Book Two"
        onConfirm={() => {}}
        onReanalyse={() => {}}
      />
    </Provider>,
  );
}

describe('ConfirmCastView — voice-match wiring', () => {
  it('renders a "Matched · N%" pill for characters carrying matchedFrom', () => {
    renderView();
    /* Pill text rounds confidence to whole percent. */
    expect(screen.getByText('Matched · 95%')).toBeInTheDocument();
  });

  it('shows the source book title in the matched character\'s Reuse tile', () => {
    renderView();
    expect(screen.getByText('From Book One')).toBeInTheDocument();
  });

  it('counts matched vs new in the header summary', () => {
    renderView();
    expect(screen.getByText('1 matched')).toBeInTheDocument();
    expect(screen.getByText('1 new')).toBeInTheDocument();
  });

  it('renders unmatched characters without a Matched pill', () => {
    renderView();
    /* Sophie's row should not show any Matched · % pill. */
    const sophieHeading = screen.getByRole('heading', { name: 'Sophie' });
    const sophieCard = sophieHeading.closest('article')!;
    expect(within(sophieCard).queryByText(/Matched · /)).toBeNull();
  });

  it('defaults the matched character\'s decision to Reuse (continuity message visible)', () => {
    renderView();
    /* The continuity footer renders only when decision === 'match' (the
       initial state for any character with matchedFrom — see view init). */
    expect(screen.getByText(/Continuity preserved/)).toBeInTheDocument();
  });
});
