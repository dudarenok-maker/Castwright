/* ConfirmCastView — verifies that a character carrying matchedFrom from
   the voice-match response renders the "Matched · N%" pill and lands in
   the "Reuse" decision tile by default. Pairs with
   docs/features/archive/09-voice-match-pipeline.md. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { ConfirmCastView } from './confirm-cast';
import type { Character, Voice } from '../lib/types';

const marlow: Character = {
  id: 'marlow',
  name: 'Marlow',
  role: 'sidekick',
  color: 'eliza',
  lines: 42,
  scenes: 7,
  attributes: ['playful', 'sarcastic'],
  voiceId: 'v_marlow',
  voiceState: 'reused',
  gender: 'male',
  ageRange: 'teen',
  matchedFrom: {
    bookTitle: 'Book One',
    bookId: 'book_one',
    characterId: 'marlow_lib',
    confidence: 0.95,
  },
  matchFactors: [{ id: 'name_exact', label: 'Name match', score: 1, detail: 'Marlow ≡ Marlow' }],
};

const wren: Character = {
  id: 'wren',
  name: 'Wren',
  role: 'protagonist',
  color: 'wren',
  lines: 120,
  scenes: 15,
  attributes: ['brave'],
  voiceState: 'generated',
  gender: 'female',
  ageRange: 'teen',
};

const library: Voice[] = [
  {
    id: 'v_marlow',
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
        characters={[marlow, wren]}
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
          characters={[marlow, wren]}
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

  it('discloses that the matched book will surface drift events after the merge', () => {
    /* The reassurance "Voices and already-generated chapter audio don't
       change" is true but incomplete — the merge mutates the matched
       book's attributes/gender/ageRange, which the drift detector then
       surfaces as drift events on that book. The disclosure copy must
       carry this consequence so users see it before ticking. */
    renderView({ onOverrideLibrary: vi.fn(async () => {}) });
    expect(screen.getByText(/will surface drift events/i)).toBeInTheDocument();
  });

  it('omits the override checkbox when matchedFrom lacks the cross-book identifiers', () => {
    /* Older voice-match cache that predates fromBookId / fromCharacterId
       lands here. The checkbox should not render because we have no way
       to address the library record. */
    const oldShape: Character = {
      ...marlow,
      matchedFrom: { bookTitle: 'Book One', confidence: 0.95 },
    };
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    render(
      <Provider store={store}>
        <ConfirmCastView
          characters={[oldShape, wren]}
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
      sourceCharacterId: 'marlow',
      targetBookId: 'book_one',
      targetCharacterId: 'marlow_lib',
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
    expect(onOpenProfile).toHaveBeenCalledWith('wren');
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
    expect(onOpenProfile).toHaveBeenCalledWith('marlow');
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
    /* "Generate fresh" tile lives on the matched character (marlow) row. */
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
    expect(onOpenProfile).toHaveBeenCalledWith('marlow');
  });
});

/* Plan 41 + Bug C + Bug D — bulk-apply pill above the cast-card grid.
   The apply path flips the Reuse decision for every eligible row AND
   ticks the "Sync profile from library" override only for low-confidence
   matches (< SYNC_AUTO_THRESHOLD = 0.9). High-confidence matches keep
   the sync checkbox as a deliberate per-card opt-in. Eligibility mirrors
   `canOverrideLibrary` per card. The clear-syncs path unchecks every
   eligible override (including any high-confidence rows the user
   manually ticked) without reverting Reuse → Generate (that would be
   destructive when the user explicitly picked Reuse). The label reflects
   the unapplied count, where unapplied means "decision !== 'match' OR
   (low-conf row AND override is off)". */
describe('ConfirmCastView — bulk apply pill', () => {
  /* Three matched characters with full library handles (bookId + characterId)
     and two unmatched characters. Mirrors what hydrateFromAnalysis +
     applyVoiceMatches feeds the view in mock mode after the plan 41
     fixture seed in src/data/characters.ts + match-factors.ts. Default
     confidence 0.85 sits below SYNC_AUTO_THRESHOLD so the existing
     "Apply all → every sync ticks" assertions hold; tests that want to
     exercise the high-confidence (≥ 0.9) path pass confidence explicitly. */
  const makeMatched = (
    id: string,
    name: string,
    bookId: string,
    characterId: string,
    confidence = 0.85,
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
      confidence,
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
    /* All three matched cards start with decision='match' but override=false,
       so all three are "unapplied". */
    expect(screen.getByRole('button', { name: 'Apply all 3 matches' })).toBeInTheDocument();
  });

  it('singularises the label when exactly one character is unapplied', () => {
    renderBulkView([makeMatched('solo', 'Solo', 'sb', 'solo_sb'), ...unmatched2]);
    expect(screen.getByRole('button', { name: 'Apply all 1 match' })).toBeInTheDocument();
  });

  it('clicking the pill ticks every matched checkbox; unmatched characters are unaffected', () => {
    renderBulkView([...matched3, ...unmatched2]);
    const allCheckboxesBefore = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    expect(allCheckboxesBefore).toHaveLength(3);
    for (const cb of allCheckboxesBefore) expect((cb as HTMLInputElement).checked).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: /Apply all 3 matches/ }));

    const allCheckboxesAfter = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    for (const cb of allCheckboxesAfter) expect((cb as HTMLInputElement).checked).toBe(true);
    /* Unmatched cards still have no checkbox at all. */
    expect(screen.getAllByRole('checkbox', { name: /Sync profile/i })).toHaveLength(3);
  });

  /* Bug C regression: when a matched card's decision is "Generate fresh",
     the per-card sync checkbox doesn't render at all (gated on
     `decision === 'match'`). The apply-all pill must ALSO flip the decision
     back to Reuse so the user gets visible effect across every matched card
     in one click. */
  it('flips Reuse decision on cards previously toggled to Generate, then ticks their sync override', () => {
    renderBulkView([...matched3, ...unmatched2]);
    /* Pre-condition: only the matched cards expose decision tiles; flip
       Alpha to "Generate fresh". Alpha now has decision='generate' and the
       continuity footer + sync checkbox vanish from that card. */
    const generateTiles = screen.getAllByRole('button', { name: /Generate fresh/ });
    fireEvent.click(generateTiles[0]);
    /* Only 2 sync checkboxes left now (beta + gamma), since alpha's
       continuity footer is gone with decision='generate'. */
    expect(screen.getAllByRole('checkbox', { name: /Sync profile/i })).toHaveLength(2);
    /* Unapplied count: alpha is unapplied (decision !== match), beta and
       gamma are unapplied (override !== true). N=3. */
    expect(screen.getByRole('button', { name: 'Apply all 3 matches' })).toBeInTheDocument();

    /* Apply all. */
    fireEvent.click(screen.getByRole('button', { name: /Apply all 3 matches/ }));

    /* All three matched cards now have decision='match' (continuity footer
       back) AND override=true. */
    const checkboxes = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    expect(checkboxes).toHaveLength(3);
    for (const cb of checkboxes) expect((cb as HTMLInputElement).checked).toBe(true);
    /* Pill flips to "Clear all syncs". */
    expect(screen.getByRole('button', { name: 'Clear all syncs' })).toBeInTheDocument();
  });

  it('clicking Clear all syncs unchecks every override but leaves Reuse decisions intact', () => {
    renderBulkView([...matched3, ...unmatched2]);
    /* First click — apply all. */
    fireEvent.click(screen.getByRole('button', { name: /Apply all 3 matches/ }));
    expect(screen.getByRole('button', { name: 'Clear all syncs' })).toBeInTheDocument();

    /* Second click — clear syncs only. */
    fireEvent.click(screen.getByRole('button', { name: /Clear all syncs/ }));
    /* All three sync checkboxes are unchecked. */
    const checkboxes = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    expect(checkboxes).toHaveLength(3);
    for (const cb of checkboxes) expect((cb as HTMLInputElement).checked).toBe(false);
    /* Continuity footer still renders on all three (decisions stayed at
       'match'), proving Clear-all-syncs did NOT revert the decision. */
    expect(screen.getAllByText(/Continuity preserved/)).toHaveLength(3);
    /* Label is back to "Apply all 3 matches". */
    expect(screen.getByRole('button', { name: 'Apply all 3 matches' })).toBeInTheDocument();
  });

  it('after bulk-apply, per-card untick flips the label back to "Apply all 1 match"', () => {
    renderBulkView([...matched3, ...unmatched2]);
    fireEvent.click(screen.getByRole('button', { name: /Apply all 3 matches/ }));
    /* Untick the first matched character's sync. Decision stays 'match'. */
    const checkboxes = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    fireEvent.click(checkboxes[0]);
    /* Unapplied count is now 1 (alpha lost its override). */
    expect(screen.getByRole('button', { name: 'Apply all 1 match' })).toBeInTheDocument();
  });

  it('pill is absent when no character is eligible (no matchedFrom with bookId+characterId)', () => {
    renderBulkView([...unmatched2]);
    expect(screen.queryByRole('button', { name: /Apply all .* match/ })).toBeNull();
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
    expect(screen.queryByRole('button', { name: /Apply all .* match/ })).toBeNull();
  });

  /* Bug D — confidence-gated auto-tick. The Sync checkbox auto-ticks only
     when match confidence is < 0.9; high-confidence matches still flip the
     Reuse decision but their sync stays a per-card opt-in. */
  it('Bug D: Apply All ticks the low-conf row\'s sync but leaves the high-conf row\'s sync untouched', () => {
    const lowConf = makeMatched('low', 'LowConf', 'sb', 'low_sb', 0.85);
    const highConf = makeMatched('high', 'HighConf', 'sb', 'high_sb', 0.95);
    renderBulkView([lowConf, highConf]);

    const checkboxesBefore = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    expect(checkboxesBefore).toHaveLength(2);
    for (const cb of checkboxesBefore) expect((cb as HTMLInputElement).checked).toBe(false);

    /* At first render, the high-conf row is already "applied" by the new
       count semantics (decision='match' from the useState initialiser
       and shouldAutoSync=false skips the override requirement). Only the
       low-conf row needs an override tick. N=1. */
    fireEvent.click(screen.getByRole('button', { name: /Apply all 1 match/ }));

    /* Match cards by their character name so we don't rely on render order. */
    const lowRow = screen.getByRole('heading', { name: 'LowConf' }).closest('article')!;
    const highRow = screen.getByRole('heading', { name: 'HighConf' }).closest('article')!;
    const lowSync = within(lowRow).getByRole('checkbox', { name: /Sync profile/i });
    const highSync = within(highRow).getByRole('checkbox', { name: /Sync profile/i });
    expect((lowSync as HTMLInputElement).checked).toBe(true);
    expect((highSync as HTMLInputElement).checked).toBe(false);

    /* After Apply All, both rows count as applied (low via decision+override,
       high via decision alone), so the pill flips to "Clear all syncs". */
    expect(screen.getByRole('button', { name: 'Clear all syncs' })).toBeInTheDocument();
  });

  it('Bug D: a cast of only high-conf matches reaches "Clear all syncs" with zero sync checkboxes ticked', () => {
    const highOnly = [
      makeMatched('h1', 'H1', 'sb', 'h1_sb', 0.93),
      makeMatched('h2', 'H2', 'sb', 'h2_sb', 0.97),
    ];
    renderBulkView(highOnly);
    /* N=2 (both rows start with decision='match' already, but in the bulk
       sense they're still "unapplied" because neither has been Apply-All'd
       through the pill yet — the post-click state must read as fully
       applied so the pill flips). Actually all matched cards start with
       decision='match' by default per the useState initialiser, so
       isApplied is already true for both high-conf rows. The pill flips
       to "Clear all syncs" on first render — no click needed. */
    expect(screen.getByRole('button', { name: 'Clear all syncs' })).toBeInTheDocument();
    const checkboxes = screen.getAllByRole('checkbox', { name: /Sync profile/i });
    expect(checkboxes).toHaveLength(2);
    for (const cb of checkboxes) expect((cb as HTMLInputElement).checked).toBe(false);
  });

  it('Bug D: Apply All preserves a manually-pre-ticked sync on a high-conf row (does not force-clear)', () => {
    const lowConf = makeMatched('low', 'LowConf', 'sb', 'low_sb', 0.85);
    const highConf = makeMatched('high', 'HighConf', 'sb', 'high_sb', 0.95);
    renderBulkView([lowConf, highConf]);

    /* Manually tick the high-conf row's sync BEFORE clicking Apply All. */
    const highRowBefore = screen.getByRole('heading', { name: 'HighConf' }).closest('article')!;
    fireEvent.click(within(highRowBefore).getByRole('checkbox', { name: /Sync profile/i }));

    /* Pill still says "Apply all 1 match" — the low-conf row is the only
       remaining unapplied one (high-conf became applied via the manual
       tick, but more importantly it's applied as soon as its decision is
       Reuse regardless of override). */
    fireEvent.click(screen.getByRole('button', { name: /Apply all 1 match/ }));

    /* After Apply All, both rows' syncs are ticked — low because the
       bulk auto-ticked it, high because the manual tick was preserved. */
    const lowRow = screen.getByRole('heading', { name: 'LowConf' }).closest('article')!;
    const highRow = screen.getByRole('heading', { name: 'HighConf' }).closest('article')!;
    expect(
      (within(lowRow).getByRole('checkbox', { name: /Sync profile/i }) as HTMLInputElement).checked,
    ).toBe(true);
    expect(
      (within(highRow).getByRole('checkbox', { name: /Sync profile/i }) as HTMLInputElement).checked,
    ).toBe(true);
  });

  it('Bug D: Clear all syncs sweeps both auto-ticked and manually-ticked overrides off every eligible row', () => {
    const lowConf = makeMatched('low', 'LowConf', 'sb', 'low_sb', 0.85);
    const highConf = makeMatched('high', 'HighConf', 'sb', 'high_sb', 0.95);
    renderBulkView([lowConf, highConf]);

    /* Manually tick high-conf, then click Apply All (which auto-ticks low). */
    const highRowSetup = screen.getByRole('heading', { name: 'HighConf' }).closest('article')!;
    fireEvent.click(within(highRowSetup).getByRole('checkbox', { name: /Sync profile/i }));
    fireEvent.click(screen.getByRole('button', { name: /Apply all 1 match/ }));
    /* Both syncs now on. */
    expect(screen.getByRole('button', { name: 'Clear all syncs' })).toBeInTheDocument();

    /* Clear all syncs. */
    fireEvent.click(screen.getByRole('button', { name: /Clear all syncs/ }));

    const lowRow = screen.getByRole('heading', { name: 'LowConf' }).closest('article')!;
    const highRow = screen.getByRole('heading', { name: 'HighConf' }).closest('article')!;
    expect(
      (within(lowRow).getByRole('checkbox', { name: /Sync profile/i }) as HTMLInputElement).checked,
    ).toBe(false);
    expect(
      (within(highRow).getByRole('checkbox', { name: /Sync profile/i }) as HTMLInputElement).checked,
    ).toBe(false);
    /* Continuity footers still render for both (decisions stayed at Reuse). */
    expect(screen.getAllByText(/Continuity preserved/)).toHaveLength(2);
    /* Pill: low-conf row lost its override so it's unapplied again (N=1);
       high-conf row is still applied via decision alone. */
    expect(screen.getByRole('button', { name: 'Apply all 1 match' })).toBeInTheDocument();
  });
});

/* Plan 81 wave 3 — phone (375 px) + tablet (834 px) responsive layout.
   jsdom doesn't actually apply CSS so we can't measure pixel widths; what
   we can pin is the responsive class contract — the decision-tile panel
   must declare BOTH a fluid mobile width (`w-full`) AND the desktop
   `sm:w-[340px]` fallback, AND span both grid columns on phone so it
   stacks below the avatar+info row instead of overflowing a 375 px
   viewport. The grid row template itself must drop the third
   (decision-tile) column on phone (`grid-cols-[auto_1fr] sm:grid-cols-[auto_1fr_auto]`).
   The accompanying Playwright spec (Wave 5) is the layout authority;
   these checks lock the class contract so an accidental revert
   (e.g. someone re-adds `w-[340px]` without the `w-full sm:` prefix)
   breaks here in pre-commit instead of slipping to e2e. */
describe('ConfirmCastView — mobile + tablet layout (plan 81 wave 3)', () => {
  it('decision-tile panel for a matched character is fluid on phone and 340 px on tablet+', () => {
    renderView();
    /* The matched-character panel hosts both DecisionTiles in a grid. */
    const reuseTile = screen.getByText('From Book One').closest('button')!;
    const panel = reuseTile.parentElement!;
    expect(panel.className).toMatch(/\bw-full\b/);
    expect(panel.className).toMatch(/(^|\s)sm:w-\[340px\](\s|$)/);
    /* Spans both grid columns on phone, returns to single column on tablet+. */
    expect(panel.className).toMatch(/\bcol-span-2\b/);
    expect(panel.className).toMatch(/\bsm:col-span-1\b/);
  });

  it('decision-tile panel for an unmatched character is fluid on phone and 340 px on tablet+', () => {
    renderView();
    /* Wren has no matchedFrom — the single readonly Generated tile is wrapped
       in a panel div whose responsive shape mirrors the matched case. */
    const generatedTile = screen.getByText('Generated').closest('button')!;
    const panel = generatedTile.parentElement!;
    expect(panel.className).toMatch(/\bw-full\b/);
    expect(panel.className).toMatch(/(^|\s)sm:w-\[340px\](\s|$)/);
    expect(panel.className).toMatch(/\bcol-span-2\b/);
    expect(panel.className).toMatch(/\bsm:col-span-1\b/);
  });

  it('card grid drops the decision-tile column on phone and restores it on tablet+', () => {
    renderView();
    /* The avatar+info+tiles grid lives one level inside the article. */
    const article = screen.getByRole('heading', { name: 'Wren' }).closest('article')!;
    const grid = article.querySelector('.grid')!;
    expect(grid.className).toMatch(/grid-cols-\[auto_1fr\]/);
    expect(grid.className).toMatch(/sm:grid-cols-\[auto_1fr_auto\]/);
  });

  it('every DecisionTile button declares a ≥44 px minimum tap target (WCAG 2.5.5)', () => {
    renderView();
    const tiles = screen.getAllByRole('button').filter((b) => b.className.includes('rounded-2xl'));
    /* Two tiles for Marlow (match + generate) + one readonly tile for Wren. */
    expect(tiles.length).toBeGreaterThanOrEqual(3);
    for (const tile of tiles) {
      expect(tile.className).toMatch(/(^|\s)min-h-\[44px\](\s|$)/);
    }
  });

  it('confirm-action row stacks on phone (flex-col-reverse) and goes side-by-side on tablet+', () => {
    renderView();
    /* The "Confirm cast and review manuscript" PrimaryButton lives in
       the row alongside the Re-analyse link. */
    const confirmBtn = screen.getByRole('button', { name: /Confirm cast and review manuscript/ });
    const actionRow = confirmBtn.parentElement!;
    expect(actionRow.className).toMatch(/flex-col-reverse/);
    expect(actionRow.className).toMatch(/sm:flex-row/);
  });
});

/* Plan 93 — character-list virtualisation threshold. Below 40 rows the
   flat-render path stays for short casts (where windowing is overhead);
   above it, useWindowVirtualizer takes over. jsdom can't measure layout
   so we only pin the gate's two paths via the `confirm-cast-virtual-container`
   testid; the actual windowed render is covered by manuscript's e2e
   pattern (`window.__store__` injection) — list-virt's e2e equivalent
   is in the existing responsive coverage spec. */
describe('ConfirmCastView — virtualisation threshold (plan 93)', () => {
  function manyCharacters(n: number): Character[] {
    return Array.from({ length: n }, (_, i) => ({
      id: `c${i + 1}`,
      name: `Char ${i + 1}`,
      role: 'Lead',
      color: 'slot-4',
      lines: 10,
      scenes: 2,
      attributes: ['warm'],
      voiceState: 'generated',
      gender: 'female',
      ageRange: 'adult',
    }));
  }

  function renderWithCount(n: number) {
    const store = configureStore({ reducer: { ui: uiSlice.reducer } });
    return render(
      <Provider store={store}>
        <ConfirmCastView
          characters={manyCharacters(n)}
          library={[]}
          title="Big Cast Book"
          onOpenProfile={() => {}}
          onConfirm={() => {}}
          onReanalyse={() => {}}
        />
      </Provider>,
    );
  }

  it('renders the flat character list below the 40-row threshold', () => {
    renderWithCount(20);
    expect(screen.queryByTestId('confirm-cast-virtual-container')).toBeNull();
    /* Sanity — sample row mounted. */
    expect(screen.getByRole('heading', { name: 'Char 1' })).toBeInTheDocument();
  });

  it('switches to the virtualised container at or above the threshold', () => {
    renderWithCount(60);
    expect(screen.getByTestId('confirm-cast-virtual-container')).toBeInTheDocument();
  });
});
