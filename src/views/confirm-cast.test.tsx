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
  matchedFrom: {
    bookTitle: 'Book One',
    bookId: 'book_one',
    characterId: 'keefe_lib',
    confidence: 0.95,
  },
  matchFactors: [{ id: 'name_exact', label: 'Name match', score: 1, detail: 'Keefe ≡ Keefe' }],
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
    id: 'v_keefe',
    character: 'Keefe',
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
        characters={[keefe, sophie]}
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
    /* Sophie's row should not show any Matched · % pill. */
    const sophieHeading = screen.getByRole('heading', { name: 'Sophie' });
    const sophieCard = sophieHeading.closest('article')!;
    expect(within(sophieCard).queryByText(/Matched · /)).toBeNull();
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
          characters={[keefe, sophie]}
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
      ...keefe,
      matchedFrom: { bookTitle: 'Book One', confidence: 0.95 },
    };
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    render(
      <Provider store={store}>
        <ConfirmCastView
          characters={[oldShape, sophie]}
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
      sourceCharacterId: 'keefe',
      targetBookId: 'book_one',
      targetCharacterId: 'keefe_lib',
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
    const sophieHeading = screen.getByRole('heading', { name: 'Sophie' });
    const sophieCard = sophieHeading.closest('article')!;
    fireEvent.click(sophieCard);
    expect(onOpenProfile).toHaveBeenCalledWith('sophie');
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
    const keefeHeading = screen.getByRole('heading', { name: 'Keefe' });
    /* Click on the name node itself — the most natural target. */
    fireEvent.click(keefeHeading);
    expect(onOpenProfile).toHaveBeenCalledWith('keefe');
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
    /* "Generate fresh" tile lives on the matched character (keefe) row. */
    const generateTile = screen.getByRole('button', { name: /Generate fresh/ });
    fireEvent.click(generateTile);
    expect(onOpenProfile).not.toHaveBeenCalled();
  });

  it('pressing Enter on a focused card opens the profile drawer', () => {
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const keefeHeading = screen.getByRole('heading', { name: 'Keefe' });
    const keefeCard = keefeHeading.closest('article')!;
    fireEvent.keyDown(keefeCard, { key: 'Enter' });
    expect(onOpenProfile).toHaveBeenCalledWith('keefe');
  });
});

/* Plan 41 — bulk-sync pill above the cast-card grid.
   The pill toggles every eligible character's "Sync profile" checkbox in
   one click; eligibility mirrors `canOverrideLibrary` per card. The label
   reflects the target state (Sync N / Clear all), and N updates as the
   user unticks exceptions after a bulk tick. */
describe('ConfirmCastView — bulk sync pill', () => {
  /* Three matched characters with full library handles (bookId + characterId)
     and two unmatched characters. Mirrors what hydrateFromAnalysis +
     applyVoiceMatches feeds the view in mock mode after the plan 41
     fixture seed in src/data/characters.ts + match-factors.ts. */
  const makeMatched = (
    id: string,
    name: string,
    bookId: string,
    characterId: string,
  ): Character => ({
    id,
    name,
    role: 'cast member',
    color: 'eliza',
    lines: 50,
    scenes: 5,
    attributes: [],
    voiceId: `v_${id}`,
    voiceState: 'reused',
    matchedFrom: {
      bookTitle: 'Solway Bay',
      bookId,
      characterId,
      confidence: 0.9,
    },
  });
  const makeUnmatched = (id: string, name: string): Character => ({
    id,
    name,
    role: 'cast member',
    color: 'eliza',
    lines: 20,
    scenes: 3,
    attributes: [],
    voiceState: 'generated',
  });
  const matched3 = [
    makeMatched('alpha', 'Alpha', 'sb', 'alpha_sb'),
    makeMatched('beta', 'Beta', 'sb', 'beta_sb'),
    makeMatched('gamma', 'Gamma', 'sb', 'gamma_sb'),
  ];
  const unmatched2 = [makeUnmatched('delta', 'Delta'), makeUnmatched('epsilon', 'Epsilon')];

  function renderBulkView(characters: Character[], handler = vi.fn(async () => {})) {
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    return render(
      <Provider store={store}>
        <ConfirmCastView
          characters={characters}
          library={library}
          title="Book Two"
          onOpenProfile={() => {}}
          onConfirm={() => {}}
          onOverrideLibrary={handler}
          onReanalyse={() => {}}
        />
      </Provider>,
    );
  }

  it('renders the pill with the eligible-character count when at least one card carries the full library handle', () => {
    renderBulkView([...matched3, ...unmatched2]);
    expect(
      screen.getByRole('button', { name: 'Sync 3 profiles from library' }),
    ).toBeInTheDocument();
  });

  it('singularises the label when exactly one character is eligible', () => {
    renderBulkView([makeMatched('solo', 'Solo', 'sb', 'solo_sb'), ...unmatched2]);
    expect(screen.getByRole('button', { name: 'Sync 1 profile from library' })).toBeInTheDocument();
  });

  it('clicking the pill ticks every matched checkbox; unmatched characters are unaffected', () => {
    renderBulkView([...matched3, ...unmatched2]);
    const allCheckboxesBefore = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    expect(allCheckboxesBefore).toHaveLength(3);
    for (const cb of allCheckboxesBefore) expect((cb as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Sync 3 profiles from library/ }));

    const allCheckboxesAfter = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    for (const cb of allCheckboxesAfter) expect((cb as HTMLInputElement).checked).toBe(true);
    /* Unmatched cards still have no checkbox at all. */
    expect(screen.getAllByRole('checkbox', { name: /Sync profile/i })).toHaveLength(3);
  });

  it('clicking the pill again clears every previously-ticked checkbox (label inverts to Clear all syncs)', () => {
    renderBulkView([...matched3, ...unmatched2]);
    /* First click — tick all. */
    fireEvent.click(screen.getByRole('button', { name: /Sync 3 profiles from library/ }));
    expect(screen.getByRole('button', { name: 'Clear all syncs' })).toBeInTheDocument();

    /* Second click — clear all. */
    fireEvent.click(screen.getByRole('button', { name: /Clear all syncs/ }));
    for (const cb of screen.getAllByRole('checkbox', { name: /Sync profile/i })) {
      expect((cb as HTMLInputElement).checked).toBe(false);
    }
    /* Label is back to "Sync 3 …". */
    expect(
      screen.getByRole('button', { name: 'Sync 3 profiles from library' }),
    ).toBeInTheDocument();
  });

  it('after bulk-tick, per-card untick flips the label back to "Sync 1 profile from library"', () => {
    renderBulkView([...matched3, ...unmatched2]);
    fireEvent.click(screen.getByRole('button', { name: /Sync 3 profiles from library/ }));
    /* Untick the first matched character. */
    const checkboxes = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    fireEvent.click(checkboxes[0]);
    /* Plan 41 invariant 3 + 4: label N is the number of currently-unticked
       eligible characters when not all are ticked. After unticking one, N=1. */
    expect(screen.getByRole('button', { name: 'Sync 1 profile from library' })).toBeInTheDocument();
  });

  it('pill is absent when no character is eligible (no matchedFrom with bookId+characterId)', () => {
    renderBulkView([...unmatched2]);
    expect(screen.queryByRole('button', { name: /Sync .* from library/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Clear all syncs/ })).toBeNull();
  });

  it('pill is absent when onOverrideLibrary is not provided (mock environments)', () => {
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    render(
      <Provider store={store}>
        <ConfirmCastView
          characters={matched3}
          library={library}
          title="Book Two"
          onOpenProfile={() => {}}
          onConfirm={() => {}}
          onReanalyse={() => {}}
        />
      </Provider>,
    );
    expect(screen.queryByRole('button', { name: /Sync .* from library/ })).toBeNull();
  });
});
