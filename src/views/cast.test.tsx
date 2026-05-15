/* CastView (ready-stage) — voice column presentation contract.

   Regression coverage for the inconsistency where a reused character's row
   dropped the prebuilt-voice profile line entirely, leaving the user with
   no visibility into which underlying TTS voice the character will speak
   with. After the fix, generated and reused rows share an identical
   "voice.character → TTS profile" header; the reused row only adds the
   match-source line stacked below. */

import { describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { render, screen, within, fireEvent } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { CastView } from './cast';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {},
}));

const narrator: Character = {
  id: 'narrator',
  name: 'Narrator',
  role: 'Third-person observer',
  color: 'narrator',
  lines: 5396,
  scenes: 30,
  attributes: ['descriptive', 'pacing-focused'],
  voiceId: 'v_narrator_lib',
  voiceState: 'reused',
  gender: 'male',
  ageRange: 'adult',
  matchedFrom: { bookTitle: 'Bonus Keefe Story', bookId: 'b_prev', characterId: 'narrator_prev', confidence: 0.92 },
};

const sweeney: Character = {
  id: 'sweeney',
  name: 'Mr. Sweeney',
  role: 'Teacher',
  color: 'mentor',
  lines: 5,
  scenes: 2,
  attributes: ['impatient'],
  voiceId: 'v_sweeney',
  voiceState: 'generated',
  gender: 'male',
  ageRange: 'adult',
};

const library: Voice[] = [
  {
    id: 'v_narrator_lib',
    character: 'Narrator',
    bookId: 'b_prev',
    bookTitle: 'Bonus Keefe Story',
    attributes: ['descriptive'],
    gradient: ['#E5B69C', '#C77B5C'],
    usedIn: 2,
    source: 'library',
    ttsVoice: {
      provider: 'coqui',
      name: 'Aaron Dreschner',
      description: 'Mid-aged narrator voice with a wry edge',
    },
  },
  {
    id: 'v_sweeney',
    character: 'Mr. Sweeney',
    bookId: 'b_current',
    bookTitle: 'The Northern Star',
    attributes: ['impatient'],
    gradient: ['#A55A2A', '#3C194F'],
    usedIn: 1,
    source: 'current',
    ttsVoice: {
      provider: 'coqui',
      name: 'Viktor Menelaos',
      description: 'Mid-aged stern instructor',
    },
  },
];

function renderView() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  return render(
    <Provider store={store}>
      <CastView
        characters={[narrator, sweeney]}
        setCharacters={() => {}}
        library={library}
        title="The Northern Star"
        onOpenProfile={() => {}}
        onShowMatchDetail={() => {}}
        onBatchRegenerate={() => {}}
        driftEvents={[]}
        onShowDrift={() => {}}
      />
    </Provider>,
  );
}

function rowFor(name: string): HTMLElement {
  /* The cast table renders one row per character with a grid-cols layout.
     The character's name shows up in the second column wrapped in a
     <span class="font-semibold ...">. Match on that to skip the page
     header (which may also mention the name). */
  const labels = screen.getAllByText(name);
  for (const el of labels) {
    const row = el.closest('div[class*="grid-cols-[40px"]');
    if (row) return row as HTMLElement;
  }
  throw new Error(`No row found for character ${name}`);
}
function checkboxIn(row: HTMLElement): HTMLElement {
  /* The row's first <span> is the click target for the checkbox cell
     (cast.tsx:194). We click it directly to toggle selection. */
  return row.querySelector('span') as HTMLElement;
}

describe('CastView compare-button visibility', () => {
  it('does not show the floating action bar until a row is selected', () => {
    renderView();
    expect(screen.queryByRole('button', { name: /^Compare$/ })).toBeNull();
  });

  it('shows Compare disabled when one row is selected', () => {
    renderView();
    fireEvent.click(checkboxIn(rowFor('Narrator')));
    const btn = screen.getByRole('button', { name: /^Compare$/ });
    expect(btn).toBeDisabled();
  });

  it('enables Compare when exactly two rows are selected', () => {
    renderView();
    fireEvent.click(checkboxIn(rowFor('Narrator')));
    fireEvent.click(checkboxIn(rowFor('Mr. Sweeney')));
    const btn = screen.getByRole('button', { name: /^Compare$/ });
    expect(btn).not.toBeDisabled();
  });

  it('opens the compare modal when Compare is clicked with two rows selected', () => {
    renderView();
    fireEvent.click(checkboxIn(rowFor('Narrator')));
    fireEvent.click(checkboxIn(rowFor('Mr. Sweeney')));
    fireEvent.click(screen.getByRole('button', { name: /^Compare$/ }));
    /* Modal heading mounts when the modal opens. */
    expect(screen.getByText('Compare cast members')).toBeInTheDocument();
  });
});

describe('CastView voice-column presentation', () => {
  it('shows the prebuilt voice profile line for a generated character', () => {
    renderView();
    /* The TtsVoiceLine renders the underlying actor/profile name + a
       hyphenated description. For Mr. Sweeney that's "Viktor Menelaos". */
    expect(screen.getByText('Viktor Menelaos')).toBeInTheDocument();
  });

  it('shows the prebuilt voice profile line for a reused character — the match info does not replace it', () => {
    renderView();
    /* Regression: prior to the fix, the matched branch returned the
       "From … · N%" link in place of TtsVoiceLine, so the underlying
       voice profile name was invisible on reused rows. Both must
       coexist now. */
    expect(screen.getByText('Aaron Dreschner')).toBeInTheDocument();
    expect(screen.getByText(/From Bonus Keefe Story · 92%/)).toBeInTheDocument();
  });

  it('keeps the match-source line scoped to the reused row only', () => {
    renderView();
    const sweeneyCell = screen.getByText('Viktor Menelaos').closest('span')!;
    /* The match line lives in the same min-w-0 wrapper as the profile
       line; if it leaked into the generated row we'd see it here. */
    expect(within(sweeneyCell).queryByText(/From .* · \d+%/)).toBeNull();
  });
});
