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
import { render, screen, within } from '@testing-library/react';
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
  matchedFrom: { bookTitle: 'the Coalfall Commission', bookId: 'b_prev', characterId: 'narrator_prev', confidence: 0.92 },
};

const Marrow: Character = {
  id: 'Marrow',
  name: 'Mr. Marrow',
  role: 'Teacher',
  color: 'mentor',
  lines: 5,
  scenes: 2,
  attributes: ['impatient'],
  voiceId: 'v_Marrow',
  voiceState: 'generated',
  gender: 'male',
  ageRange: 'adult',
};

const library: Voice[] = [
  {
    id: 'v_narrator_lib',
    character: 'Narrator',
    bookId: 'b_prev',
    bookTitle: 'the Coalfall Commission',
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
    id: 'v_Marrow',
    character: 'Mr. Marrow',
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
        characters={[narrator, Marrow]}
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

describe('CastView voice-column presentation', () => {
  it('shows the prebuilt voice profile line for a generated character', () => {
    renderView();
    /* The TtsVoiceLine renders the underlying actor/profile name + a
       hyphenated description. For Mr. Marrow that's "Viktor Menelaos". */
    expect(screen.getByText('Viktor Menelaos')).toBeInTheDocument();
  });

  it('shows the prebuilt voice profile line for a reused character — the match info does not replace it', () => {
    renderView();
    /* Regression: prior to the fix, the matched branch returned the
       "From … · N%" link in place of TtsVoiceLine, so the underlying
       voice profile name was invisible on reused rows. Both must
       coexist now. */
    expect(screen.getByText('Aaron Dreschner')).toBeInTheDocument();
    expect(screen.getByText(/From the Coalfall Commission · 92%/)).toBeInTheDocument();
  });

  it('keeps the match-source line scoped to the reused row only', () => {
    renderView();
    const MarrowCell = screen.getByText('Viktor Menelaos').closest('span')!;
    /* The match line lives in the same min-w-0 wrapper as the profile
       line; if it leaked into the generated row we'd see it here. */
    expect(within(MarrowCell).queryByText(/From .* · \d+%/)).toBeNull();
  });
});
