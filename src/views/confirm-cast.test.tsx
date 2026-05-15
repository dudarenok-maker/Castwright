/* ConfirmCastView — verifies that a character carrying matchedFrom from
   the voice-match response renders the "Matched · N%" pill and lands in
   the "Reuse" decision tile by default. Pairs with
   docs/features/09-voice-match-pipeline.md. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { ConfirmCastView } from './confirm-cast';
import type { Character, Voice } from '../lib/types';

const Marlow: Character = {
  id: 'Marlow',
  name: 'Marlow',
  role: 'sidekick',
  color: 'eliza',
  lines: 42,
  scenes: 7,
  attributes: ['playful', 'sarcastic'],
  voiceId: 'v_Marlow',
  voiceState: 'reused',
  gender: 'male',
  ageRange: 'teen',
  matchedFrom: { bookTitle: 'Book One', confidence: 0.95 },
  matchFactors: [
    { id: 'name_exact', label: 'Name match', score: 1, detail: 'Marlow ≡ Marlow' },
  ],
};

const Wren: Character = {
  id: 'Wren',
  name: 'Wren',
  role: 'protagonist',
  color: 'Wren',
  lines: 120,
  scenes: 15,
  attributes: ['brave'],
  voiceState: 'generated',
  gender: 'female',
  ageRange: 'teen',
};

const library: Voice[] = [
  {
    id:         'v_Marlow',
    character:  'Marlow',
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

function renderView(overrides: { onOpenProfile?: (id: string) => void } = {}) {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer },
  });
  return render(
    <Provider store={store}>
      <ConfirmCastView
        characters={[Marlow, Wren]}
        library={library}
        title="Book Two"
        onOpenProfile={overrides.onOpenProfile ?? (() => {})}
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
    /* Wren's row should not show any Matched · % pill. */
    const WrenHeading = screen.getByRole('heading', { name: 'Wren' });
    const WrenCard = WrenHeading.closest('article')!;
    expect(within(WrenCard).queryByText(/Matched · /)).toBeNull();
  });

  it('defaults the matched character\'s decision to Reuse (continuity message visible)', () => {
    renderView();
    /* The continuity footer renders only when decision === 'match' (the
       initial state for any character with matchedFrom — see view init). */
    expect(screen.getByText(/Continuity preserved/)).toBeInTheDocument();
  });
});

describe('ConfirmCastView — card click opens profile drawer', () => {
  it('clicking an unmatched character card fires onOpenProfile with that character id', () => {
    /* Mirrors the ready-stage Cast view: clicking the row pops the
       ProfileDrawer. Without this the user can't fix gender/age inferences
       before confirming the cast. */
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const WrenHeading = screen.getByRole('heading', { name: 'Wren' });
    const WrenCard = WrenHeading.closest('article')!;
    fireEvent.click(WrenCard);
    expect(onOpenProfile).toHaveBeenCalledWith('Wren');
  });

  it('clicking a MATCHED character card also fires onOpenProfile — drawer opens for matched library reuses too', () => {
    /* Matched cards default to decision='match' and render the Reuse
       DecisionTile + the Continuity footer. Those branches own their own
       clicks (stopPropagation) so they don't open the drawer, but the
       card body itself (avatar, name, role, chips, TTS line) must still
       bubble up — otherwise the user can't inspect or correct the
       matched profile before confirming. */
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const MarlowHeading = screen.getByRole('heading', { name: 'Marlow' });
    fireEvent.click(MarlowHeading);
    expect(onOpenProfile).toHaveBeenCalledWith('Marlow');
  });

  it('clicking a DecisionTile does not bubble up to the card click', () => {
    /* The match/generate picker lives inside the card — its clicks must
       stay local so picking a tile doesn't also open the drawer. */
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const generateTile = screen.getByRole('button', { name: /Generate fresh/ });
    fireEvent.click(generateTile);
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('pressing Enter on a focused card opens the profile drawer', () => {
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const MarlowHeading = screen.getByRole('heading', { name: 'Marlow' });
    const MarlowCard = MarlowHeading.closest('article')!;
    fireEvent.keyDown(MarlowCard, { key: 'Enter' });
    expect(onOpenProfile).toHaveBeenCalledWith('Marlow');
  });
});
