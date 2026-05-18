/* ConfirmCastView — verifies that a character carrying matchedFrom from
   the voice-match response renders the "Matched · N%" pill and lands in
   the "Reuse" decision tile by default. Pairs with
   docs/features/09-voice-match-pipeline.md. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
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
  matchedFrom: {
    bookTitle: 'Book One',
    bookId: 'book_one',
    characterId: 'Marlow_lib',
    confidence: 0.95,
  },
  matchFactors: [{ id: 'name_exact', label: 'Name match', score: 1, detail: 'Marlow ≡ Marlow' }],
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
    id: 'v_Marlow',
    character: 'Marlow',
    bookTitle: 'Book One',
    bookId: 'book_one',
    attributes: ['playful', 'sarcastic'],
    gradient: ['#3C194F', '#0F0E0D'],
    usedIn: 1,
    source: 'library',
    ttsVoice: {
      provider: 'coqui',
      name: 'male-teen-playful',
      description: 'Light male teen voice with a sardonic edge',
    },
  },
];

function renderView(
  overrides: {
    onOpenProfile?: (id: string) => void;
    onConfirm?: () => void;
    onOverrideLibrary?: (args: {
      sourceCharacterId: string;
      targetBookId: string;
      targetCharacterId: string;
    }) => Promise<void>;
  } = {},
) {
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
        onConfirm={overrides.onConfirm ?? (() => {})}
        onOverrideLibrary={overrides.onOverrideLibrary}
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

  it("shows the source book title in the matched character's Reuse tile", () => {
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

  it("defaults the matched character's decision to Reuse (continuity message visible)", () => {
    renderView();
    /* The continuity footer renders only when decision === 'match' (the
       initial state for any character with matchedFrom — see view init). */
    expect(screen.getByText(/Continuity preserved/)).toBeInTheDocument();
  });
});

describe('ConfirmCastView — library override toggle', () => {
  it('renders the override checkbox only when matchedFrom carries bookId+characterId AND onOverrideLibrary is provided', () => {
    /* Both conditions satisfied — checkbox visible. */
    const { rerender } = renderView({ onOverrideLibrary: vi.fn(async () => {}) });
    expect(
      screen.getByRole('checkbox', { name: /Sync profile with Book One/i }),
    ).toBeInTheDocument();

    /* Without the handler, no checkbox even when the data is rich enough. */
    rerender(
      <Provider store={configureStore({ reducer: { ui: uiSlice.reducer } })}>
        <ConfirmCastView
          characters={[Marlow, Wren]}
          library={library}
          title="Book Two"
          onOpenProfile={() => {}}
          onConfirm={() => {}}
          onReanalyse={() => {}}
        />
      </Provider>,
    );
    expect(screen.queryByRole('checkbox', { name: /Sync profile/i })).toBeNull();
  });

  it('omits the override checkbox when matchedFrom lacks the cross-book identifiers', () => {
    /* Older voice-match cache that predates fromBookId / fromCharacterId
       lands here. The checkbox should not render because we have no way
       to address the library record. */
    const oldShape: Character = {
      ...Marlow,
      matchedFrom: { bookTitle: 'Book One', confidence: 0.95 },
    };
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    render(
      <Provider store={store}>
        <ConfirmCastView
          characters={[oldShape, Wren]}
          library={library}
          title="Book Two"
          onOpenProfile={() => {}}
          onConfirm={() => {}}
          onOverrideLibrary={vi.fn(async () => {})}
          onReanalyse={() => {}}
        />
      </Provider>,
    );
    expect(screen.queryByRole('checkbox', { name: /Sync profile/i })).toBeNull();
  });

  it('defaults the checkbox to off; toggling on fires onOverrideLibrary with the matched ids when Confirm is clicked', async () => {
    const onOverrideLibrary = vi.fn(async () => {});
    const onConfirm = vi.fn();
    renderView({ onOverrideLibrary, onConfirm });

    const checkbox = screen.getByRole('checkbox', {
      name: /Sync profile with Book One/i,
    }) as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    fireEvent.click(checkbox);
    expect(checkbox.checked).toBe(true);

    const confirmBtn = screen.getByRole('button', { name: /Confirm cast and review manuscript/ });
    fireEvent.click(confirmBtn);

    /* handleConfirm awaits the override(s) before calling onConfirm; wait
       for the trailing onConfirm to fire so the assertions run after the
       full microtask chain settles. */
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    expect(onOverrideLibrary).toHaveBeenCalledWith({
      sourceCharacterId: 'Marlow',
      targetBookId: 'book_one',
      targetCharacterId: 'Marlow_lib',
    });
  });

  it('skips override calls when the checkbox is left off and still confirms', async () => {
    const onOverrideLibrary = vi.fn(async () => {});
    const onConfirm = vi.fn();
    renderView({ onOverrideLibrary, onConfirm });

    const confirmBtn = screen.getByRole('button', { name: /Confirm cast and review manuscript/ });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    expect(onOverrideLibrary).not.toHaveBeenCalled();
  });

  it('skips overrides for characters where the decision was switched to "Generate fresh"', async () => {
    const onOverrideLibrary = vi.fn(async () => {});
    const onConfirm = vi.fn();
    renderView({ onOverrideLibrary, onConfirm });

    /* Tick the override checkbox on, THEN flip the decision back to
       Generate fresh — the override is only meaningful when the decision
       is Reuse, so it must NOT fire. */
    fireEvent.click(screen.getByRole('checkbox', { name: /Sync profile with Book One/i }));
    fireEvent.click(screen.getByRole('button', { name: /Generate fresh/ }));

    fireEvent.click(screen.getByRole('button', { name: /Confirm cast and review manuscript/ }));
    await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));

    expect(onOverrideLibrary).not.toHaveBeenCalled();
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
       DecisionTile + the Continuity footer with the override checkbox.
       Those branches own their own clicks (stopPropagation) so they don't
       open the drawer, but the card body itself (avatar, name, role, chips,
       TTS line) must still bubble up — otherwise the user can't inspect
       or correct the matched profile before confirming. */
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const MarlowHeading = screen.getByRole('heading', { name: 'Marlow' });
    /* Click on the name node itself — the most natural target. */
    fireEvent.click(MarlowHeading);
    expect(onOpenProfile).toHaveBeenCalledWith('Marlow');
  });

  it('clicking the override checkbox on a matched card does NOT open the drawer', () => {
    /* The "Sync profile" toggle lives inside the matched card
       but is a separate intent — toggling it must stay local. */
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile, onOverrideLibrary: vi.fn(async () => {}) });
    const checkbox = screen.getByRole('checkbox', { name: /Sync profile with Book One/i });
    fireEvent.click(checkbox);
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('clicking a DecisionTile does not bubble up to the card click', () => {
    /* The match/generate picker lives inside the card — its clicks must
       stay local so picking a tile doesn't also open the drawer. */
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    /* "Generate fresh" tile lives on the matched character (Marlow) row. */
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
