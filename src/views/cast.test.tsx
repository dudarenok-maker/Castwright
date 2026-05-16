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
import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { uiSlice } from '../store/ui-slice';
import { castSlice } from '../store/cast-slice';
import { CastView } from './cast';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {},
}));

vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    isPlaying: false,
    currentUrl: null,
    play:  vi.fn(),
    stop:  vi.fn(),
    pause: vi.fn(),
  }),
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

function renderView(opts: { onOpenProfile?: (id: string | null) => void } = {}) {
  /* StaleAudioBanner (mounted inside CastView) reads s.cast.characters,
     so the test store needs the cast slice even though the cast list is
     passed as a prop. */
  const store = configureStore({ reducer: { ui: uiSlice.reducer, cast: castSlice.reducer } });
  return render(
    <Provider store={store}>
      <CastView
        characters={[narrator, Marrow]}
        setCharacters={() => {}}
        library={library}
        title="The Northern Star"
        onOpenProfile={opts.onOpenProfile ?? (() => {})}
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
    fireEvent.click(checkboxIn(rowFor('Mr. Marrow')));
    const btn = screen.getByRole('button', { name: /^Compare$/ });
    expect(btn).not.toBeDisabled();
  });

  it('opens the compare modal when Compare is clicked with two rows selected', () => {
    renderView();
    fireEvent.click(checkboxIn(rowFor('Narrator')));
    fireEvent.click(checkboxIn(rowFor('Mr. Marrow')));
    fireEvent.click(screen.getByRole('button', { name: /^Compare$/ }));
    /* Modal heading mounts when the modal opens. */
    expect(screen.getByText('Compare cast members')).toBeInTheDocument();
  });
});

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

describe('CastView VoiceSwatch sample playback', () => {
  /* Regression: prior to the fix the gradient swatch on each cast row had
     no onSelect wired, so clicking it triggered no sample synth at all —
     only the "Play 12s" pill in the Sample column worked. The swatch's
     hover overlay implied a play affordance that did nothing. After the
     fix, clicking the swatch fires playSampleWithAutoLoad with the
     character's library voice and the row's click bubbles up to open
     the profile drawer in the same gesture (user-explicit double action). */

  it('routes a swatch click through the auto-load helper', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    renderView();
    const row = rowFor('Mr. Marrow');
    /* Swatch is the first <button> inside the row — the row's other
       buttons (match-source link, Play 12s pill) come after it. */
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('v_Marrow');
  });

  it('also opens the profile drawer on the same swatch click', async () => {
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const row = rowFor('Mr. Marrow');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    /* The row's onClick is the click target for opening the drawer;
       the swatch click bubbles up so a single click does both things. */
    expect(onOpenProfile).toHaveBeenCalledWith('Marrow');
    /* Let the auto-load promise resolve so the row's loading→idle
       transition settles inside act, silencing the warning. */
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalled());
  });

  it('marks the swatch aria-busy while synth is in flight', async () => {
    /* Hold the helper in flight so the loading state is observable. */
    let resolveCall: ((v: { analyzerEvicted: boolean }) => void) | undefined;
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockImplementationOnce(
      () => new Promise<{ analyzerEvicted: boolean }>((resolve) => { resolveCall = resolve; }),
    );
    renderView();
    const row = rowFor('Mr. Marrow');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    /* aria-busy / aria-label flip the moment rowState.loading is true. */
    await waitFor(() => {
      const busy = row.querySelector('button[aria-busy="true"]') as HTMLButtonElement | null;
      expect(busy).toBeTruthy();
      expect(busy?.getAttribute('aria-label')).toMatch(/^Generating sample/);
    });
    resolveCall?.({ analyzerEvicted: false });
    /* Wait for the row's loading state to clear so the post-resolution
       setState lands inside act. */
    await waitFor(() => {
      const idle = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement | null;
      expect(idle).toBeTruthy();
    });
  });
});
