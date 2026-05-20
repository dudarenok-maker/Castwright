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

/* Plan 41 + Bug C — bulk-apply pill above the cast-card grid.
   The apply path flips both the Reuse decision AND the "Sync profile from
   library" override in one click; eligibility mirrors `canOverrideLibrary`
   per card. The clear-syncs path only unchecks the syncs (does not revert
   Reuse → Generate; that would be destructive when the user explicitly
   picked Reuse). The label reflects the unapplied count, where unapplied
   means "decision !== 'match' OR override is off". */
describe('ConfirmCastView — bulk apply pill', () => {
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
