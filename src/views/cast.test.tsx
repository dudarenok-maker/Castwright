/* CastView (ready-stage) — voice column presentation contract.

   Regression coverage for the inconsistency where a reused character's row
   dropped the prebuilt-voice profile line entirely, leaving the user with
   no visibility into which underlying TTS voice the character will speak
   with. After the fix, generated and reused rows share an identical
   "voice.character → TTS profile" header; the reused row only adds the
   match-source line stacked below. */

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { act, render, screen, within, fireEvent, waitFor } from '@testing-library/react';
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
    play: vi.fn(),
    stop: vi.fn(),
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
  matchedFrom: {
    bookTitle: 'Bonus Keefe Story',
    bookId: 'b_prev',
    characterId: 'narrator_prev',
    confidence: 0.92,
  },
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

function renderView(opts: { onOpenProfile?: (id: string | null) => void } = {}) {
  /* StaleAudioBanner (mounted inside CastView) reads s.cast.characters,
     so the test store needs the cast slice even though the cast list is
     passed as a prop. */
  const store = configureStore({ reducer: { ui: uiSlice.reducer, cast: castSlice.reducer } });
  return render(
    <Provider store={store}>
      <CastView
        characters={[narrator, sweeney]}
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
  /* Plan 81 wave 3 — the cast view renders BOTH the desktop 8-col grid
     AND the mobile card list (CSS hides whichever doesn't match the
     viewport). These tests scope themselves to the desktop grid via
     rowFor() so the assertions stay deterministic regardless of which
     surface jsdom is "showing." */
  it('shows the prebuilt voice profile line for a generated character', () => {
    renderView();
    /* The TtsVoiceLine renders the underlying actor/profile name + a
       hyphenated description. For Mr. Sweeney that's "Viktor Menelaos". */
    const row = rowFor('Mr. Sweeney');
    expect(within(row).getByText('Viktor Menelaos')).toBeInTheDocument();
  });

  it('shows the prebuilt voice profile line for a reused character — the match info does not replace it', () => {
    renderView();
    /* Regression: prior to the fix, the matched branch returned the
       "From … · N%" link in place of TtsVoiceLine, so the underlying
       voice profile name was invisible on reused rows. Both must
       coexist now. */
    const row = rowFor('Narrator');
    expect(within(row).getByText('Aaron Dreschner')).toBeInTheDocument();
    expect(within(row).getByText(/From Bonus Keefe Story · 92%/)).toBeInTheDocument();
  });

  it('keeps the match-source line scoped to the reused row only', () => {
    renderView();
    const row = rowFor('Mr. Sweeney');
    /* If the match-source line leaked into the generated row we'd see
       it inside the desktop row container here. */
    expect(within(row).queryByText(/From .* · \d+%/)).toBeNull();
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
    const row = rowFor('Mr. Sweeney');
    /* Swatch is the first <button> inside the row — the row's other
       buttons (match-source link, Play 12s pill) come after it. */
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('v_sweeney');
  });

  it('also opens the profile drawer on the same swatch click', async () => {
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const row = rowFor('Mr. Sweeney');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    /* The row's onClick is the click target for opening the drawer;
       the swatch click bubbles up so a single click does both things. */
    expect(onOpenProfile).toHaveBeenCalledWith('sweeney');
    /* Let the auto-load promise resolve so the row's loading→idle
       transition settles inside act, silencing the warning. */
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalled());
  });

  it('marks the swatch aria-busy while synth is in flight', async () => {
    /* Hold the helper in flight so the loading state is observable. */
    let resolveCall: ((v: { analyzerEvicted: boolean }) => void) | undefined;
    vi.mocked(playSampleWithAutoLoad).mockClear();
    vi.mocked(playSampleWithAutoLoad).mockImplementationOnce(
      () =>
        new Promise<{ analyzerEvicted: boolean }>((resolve) => {
          resolveCall = resolve;
        }),
    );
    renderView();
    const row = rowFor('Mr. Sweeney');
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
      const idle = row.querySelector(
        'button[aria-label^="Play sample"]',
      ) as HTMLButtonElement | null;
      expect(idle).toBeTruthy();
    });
  });
});

/* Plan 81 wave 3 — responsive layout coverage.

   The cast view collapses to a single-column card list under `md:` and
   tucks the voice library aside behind a bottom-sheet under `lg:`. The
   tests below pin the smallest viewport (phone, 375×667) so the
   following invariants survive future refactors:

   1. View renders without throwing at phone viewport.
   2. The "Library" pill is reachable + opens the bottom-sheet on tap.
   3. The card list (md:hidden block) is mounted alongside the desktop
      grid — both DOM trees coexist so tests + CSS media queries can
      pick the right one based on viewport. */

function setViewport(width: number, height: number) {
  /* jsdom's window dimensions are writable but matchMedia is a stub
     that always returns matches=false. We can't make CSS media queries
     resolve, but we CAN control the lazy initialiser inside CastView
     (showLibrary default reads window.innerWidth). Wrapping both
     in helpers so the dependency is explicit at the call sites. */
  Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    writable: true,
    configurable: true,
    value: height,
  });
}

describe('CastView responsive (phone 375x667)', () => {
  const originalInnerWidth = window.innerWidth;
  const originalInnerHeight = window.innerHeight;
  beforeEach(() => {
    setViewport(375, 667);
  });
  afterEach(() => {
    setViewport(originalInnerWidth, originalInnerHeight);
  });

  it('renders without throwing at phone viewport', () => {
    expect(() => renderView()).not.toThrow();
    /* Heading still mounts even though half the layout is hidden by
       Tailwind's md:hidden / hidden md:block; both DOM trees are in
       the document, only one visible per breakpoint. */
    expect(screen.getByText(/Voices generated from/)).toBeInTheDocument();
  });

  it('defaults the voice-library sheet to closed under lg', () => {
    renderView();
    /* The sheet wraps the panel in a role=dialog when open. At phone
       width with the default-closed behaviour, no dialog is mounted. */
    expect(screen.queryByRole('dialog', { name: /Voice library/ })).toBeNull();
  });

  it('opens the voice-library bottom-sheet when the Library pill is tapped', () => {
    renderView();
    /* The pill is labelled "Show voice library" when closed; the
     * visible text collapses to "Library" under sm. */
    const pill = screen.getByRole('button', { name: /voice library/i });
    fireEvent.click(pill);
    expect(screen.getByRole('dialog', { name: /Voice library/ })).toBeInTheDocument();
  });

  it('renders character entries in both the desktop grid AND the mobile card list', () => {
    renderView();
    /* Both subtrees mount — Tailwind's hidden/visible switch is purely
       CSS, so the React DOM has 2x rows for each character. The test
       asserts the multiplicity directly. */
    const sweeneyHits = screen.getAllByText('Mr. Sweeney');
    expect(sweeneyHits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('CastView responsive touch-target sizing', () => {
  it('floating selection pill buttons each meet the 44px touch target', () => {
    renderView();
    /* Open the floating pill by toggling one selection. */
    fireEvent.click(checkboxIn(rowFor('Narrator')));
    /* Compare + Regenerate + Clear are the three action buttons inside
       the floating pill — each carries min-h-[44px] so a thumb tap on a
       phone clears the WCAG 2.5.5 target-size threshold. */
    const compare = screen.getByRole('button', { name: /^Compare$/ });
    expect(compare.className).toMatch(/min-h-\[44px\]/);
    const regenerate = screen.getByRole('button', { name: /Regenerate/ });
    expect(regenerate.className).toMatch(/min-h-\[44px\]/);
    const clear = screen.getByRole('button', { name: /Clear selection/ });
    expect(clear.className).toMatch(/min-h-\[44px\]/);
  });
});

describe('CastView desktop drag-drop is intact', () => {
  /* Plan 81 wave 3 invariant: the cast.tsx onDragOver/onDragLeave/onDrop
     handlers on the desktop grid rows remain functional. Wave 4 will add
     tap-to-assign as a parallel path — this test pins that the drag-drop
     path was not removed in the responsive refactor. */

  it('a voice drag-and-drop onto a character row still rewrites the cast', () => {
    const store = configureStore({ reducer: { ui: uiSlice.reducer, cast: castSlice.reducer } });
    let castRef: Character[] = [narrator, sweeney];
    const setCharacters = vi.fn((next: Character[] | ((prev: Character[]) => Character[])) => {
      castRef = typeof next === 'function' ? next(castRef) : next;
    });
    render(
      <Provider store={store}>
        <CastView
          characters={castRef}
          setCharacters={setCharacters}
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
    /* Start a drag from the library voice card so the cast view's
       draggingVoiceId state is populated, then fire drop on the row.
       The library card displays the voice.character name (Narrator)
       inside a draggable div. */
    const libraryCard = screen
      .getAllByText('Narrator')
      .map((el) => el.closest('div[draggable]'))
      .find((n): n is HTMLElement => !!n);
    expect(libraryCard).toBeTruthy();
    act(() => {
      fireEvent.dragStart(libraryCard!, {
        dataTransfer: { effectAllowed: 'copy', setData: () => {} },
      });
    });
    const sweeneyRow = rowFor('Mr. Sweeney');
    act(() => {
      fireEvent.dragOver(sweeneyRow);
      fireEvent.drop(sweeneyRow);
    });
    expect(setCharacters).toHaveBeenCalled();
  });
});
