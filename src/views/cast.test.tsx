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
import { castDesignSlice, castDesignActions } from '../store/cast-design-slice';
import { voicesSlice } from '../store/voices-slice';
import { CastView, compareCastRows } from './cast';
import { playSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import { api } from '../lib/api';
import type { Character, Voice, TtsModelKey, Sentence } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: {
    /* fe-16 — the cast view auto-loads Qwen on entry for non-English books. */
    loadSidecar: vi.fn().mockResolvedValue({}),
    pauseCastDesign: vi.fn().mockResolvedValue(undefined),
  },
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
    bookTitle: 'the Coalfall Commission',
    bookId: 'b_prev',
    characterId: 'narrator_prev',
    confidence: 0.92,
  },
};

const marrow: Character = {
  id: 'marrow',
  name: 'Mr. Marrow',
  role: 'Teacher',
  color: 'mentor',
  lines: 5,
  scenes: 2,
  attributes: ['impatient'],
  voiceId: 'v_marrow',
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
    /* A sibling-series voice available to reuse — so the panel surfaces it on
       its default "Series" tab (the cast view's whole reuse affordance). */
    inCurrentSeries: true,
    ttsVoice: {
      provider: 'coqui',
      name: 'Aaron Dreschner',
      description: 'Mid-aged narrator voice with a wry edge',
    },
  },
  {
    id: 'v_marrow',
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
  const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
  return render(
    <Provider store={store}>
      <CastView
        characters={[narrator, marrow]}
        setCharacters={() => {}}
        library={library}
        title="The Northern Star"
        onOpenProfile={opts.onOpenProfile ?? (() => {})}
        onShowMatchDetail={() => {}}        driftEvents={[]}
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
  /* Plan 81 wave 3 — the cast view renders BOTH the desktop 8-col grid
     AND the mobile card list (CSS hides whichever doesn't match the
     viewport). These tests scope themselves to the desktop grid via
     rowFor() so the assertions stay deterministic regardless of which
     surface jsdom is "showing." */
  it('shows the prebuilt voice profile line for a generated character', () => {
    renderView();
    /* The TtsVoiceLine renders the underlying actor/profile name + a
       hyphenated description. For Mr. Marrow that's "Viktor Menelaos". */
    const row = rowFor('Mr. Marrow');
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
    expect(within(row).getByText(/From the Coalfall Commission · 92%/)).toBeInTheDocument();
  });

  it('keeps the match-source line scoped to the reused row only', () => {
    renderView();
    const row = rowFor('Mr. Marrow');
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
    const row = rowFor('Mr. Marrow');
    /* Swatch is the first <button> inside the row — the row's other
       buttons (match-source link, Play 12s pill) come after it. */
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    expect(swatch).toBeTruthy();
    fireEvent.click(swatch);
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args.voiceId).toBe('v_marrow');
  });

  it('also opens the profile drawer on the same swatch click', async () => {
    const onOpenProfile = vi.fn();
    renderView({ onOpenProfile });
    const row = rowFor('Mr. Marrow');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    /* The row's onClick is the click target for opening the drawer;
       the swatch click bubbles up so a single click does both things. */
    expect(onOpenProfile).toHaveBeenCalledWith('marrow');
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
      const idle = row.querySelector(
        'button[aria-label^="Play sample"]',
      ) as HTMLButtonElement | null;
      expect(idle).toBeTruthy();
    });
  });
});

describe('CastView Qwen bespoke sample playback (plan 108 fix)', () => {
  /* Regression: a Qwen-pinned row used to sample with the project model key +
     a subject carrying no qwen override, so the server resolved engine=qwen
     with an empty voice name and the sidecar 400'd ("`voice` is required.").
     The sample must route to the Qwen model key and carry the designed
     voiceId, and gate cleanly when no voice has been designed. */
  function renderChars(characters: Character[]) {
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    return {
      store,
      ...render(
        <Provider store={store}>
          <CastView
            characters={characters}
            setCharacters={() => {}}
            library={library}
            title="The Northern Star"
            onOpenProfile={() => {}}
            onShowMatchDetail={() => {}}            driftEvents={[]}
            onShowDrift={() => {}}
          />
        </Provider>,
      ),
    };
  }

  const marrowQwen: Character = {
    ...marrow,
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-marrow' } },
  };

  it('routes a Qwen-pinned row through the Qwen model key + injects the designed voiceId', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    renderChars([marrowQwen]);
    const row = rowFor('Mr. Marrow');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const args = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args;
    expect(args.modelKey).toBe('qwen3-tts-0.6b');
    expect(args.voice.overrideTtsVoices?.qwen?.name).toBe('qwen-marrow');
  });

  it('shows an inline error (no API call) for a Qwen-pinned row with no designed voice', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    renderChars([{ ...marrow, ttsEngine: 'qwen', overrideTtsVoices: undefined }]);
    const row = rowFor('Mr. Marrow');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    await waitFor(() => expect(within(row).getByText(/No Qwen voice designed yet/)).toBeTruthy());
    expect(playSampleWithAutoLoad).not.toHaveBeenCalled();
  });

  it('keeps the project model key + injects no qwen override for a non-Qwen row', async () => {
    vi.mocked(playSampleWithAutoLoad).mockClear();
    const { store } = renderChars([marrow]);
    const row = rowFor('Mr. Marrow');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    await waitFor(() => expect(playSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const args = vi.mocked(playSampleWithAutoLoad).mock.calls[0][0].args;
    expect(args.modelKey).toBe(store.getState().ui.ttsModelKey);
    expect(args.voice.overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('surfaces the designed voiceId in the VOICE cell so the row is self-explanatory', () => {
    /* The id is what tells the user *which* designed voice is assigned —
       previously the row only read "Qwen · Designed voice", forcing a
       drawer open to find it. */
    renderChars([marrowQwen]);
    const row = rowFor('Mr. Marrow');
    expect(row.textContent).toContain('Qwen');
    expect(row.textContent).toContain('qwen-marrow');
    expect(row.textContent).toContain('Designed voice');
  });

  it('omits the voiceId segment for a Qwen row with no designed voice', () => {
    renderChars([{ ...marrow, ttsEngine: 'qwen', overrideTtsVoices: undefined }]);
    const row = rowFor('Mr. Marrow');
    expect(row.textContent).toContain('No voice designed yet');
    /* No designed id ⇒ no "qwen-…" segment (guards the `name &&` gate). */
    expect(row.textContent).not.toContain('qwen-');
  });
});

describe('CastView Qwen status pill (plan 117)', () => {
  /* The Status column resolves engine-aware pills: a Qwen row follows the
     design → generate lifecycle (Needs voice / Designed / Generated), driven
     by its designed voiceId + the matched library voice's `generated` flag —
     NOT the provenance `voiceState` enum (whose 'generated' default would
     otherwise show a false green pill for an undesigned Qwen character).
     Preset rows keep their `voiceState` pills. */
  function renderWithLibrary(characters: Character[], lib: Voice[]) {
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    return render(
      <Provider store={store}>
        <CastView
          characters={characters}
          setCharacters={() => {}}
          library={lib}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
  }

  const marrowQwen: Character = {
    ...marrow,
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-marrow' } },
  };

  it('shows "Needs voice" — not a green "Generated" — for a Qwen row with no designed voice', () => {
    renderWithLibrary([{ ...marrow, ttsEngine: 'qwen', overrideTtsVoices: undefined }], library);
    const row = rowFor('Mr. Marrow');
    expect(within(row).getByText('Needs voice')).toBeInTheDocument();
    expect(within(row).queryByText('Generated')).toBeNull();
  });

  it('shows "Designed" for a designed Qwen voice that has not rendered audio', () => {
    /* The matched library voice (v_marrow) carries no `generated` flag. */
    renderWithLibrary([marrowQwen], library);
    const row = rowFor('Mr. Marrow');
    expect(within(row).getByText('Designed')).toBeInTheDocument();
    expect(within(row).queryByText('Generated')).toBeNull();
  });

  it('shows "Generated" once the matched library voice is flagged generated', () => {
    const generatedLib = library.map((v) =>
      v.id === 'v_marrow' ? { ...v, generated: true } : v,
    );
    renderWithLibrary([marrowQwen], generatedLib);
    const row = rowFor('Mr. Marrow');
    expect(within(row).getByText('Generated')).toBeInTheDocument();
  });

  it('shows "Sampled" for a designed Qwen voice whose matched library voice has a cached audition', () => {
    const sampledLib = library.map((v) => (v.id === 'v_marrow' ? { ...v, sampled: true } : v));
    renderWithLibrary([marrowQwen], sampledLib);
    const row = rowFor('Mr. Marrow');
    expect(within(row).getByText('Sampled')).toBeInTheDocument();
    expect(within(row).queryByText('Designed')).toBeNull();
  });

  it('shows "Fallback (Kokoro)" when the character actually rendered in Kokoro (fe-16)', () => {
    /* A Qwen character with no designed voice that fell back to Kokoro at
       render time. The cast slice's renderedFallbackByCharacter map carries
       `'kokoro'` for its id; the Status pill reads it via the 4th arg. */
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
      preloadedState: {
        cast: {
          ...castSlice.getInitialState(),
          renderedFallbackByCharacter: { [marrow.id]: 'kokoro' },
        },
      },
    });
    render(
      <Provider store={store}>
        <CastView
          characters={[{ ...marrow, ttsEngine: 'qwen', overrideTtsVoices: undefined }]}
          setCharacters={() => {}}
          library={library}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    const row = rowFor('Mr. Marrow');
    expect(within(row).getByText('Fallback (Kokoro)')).toBeInTheDocument();
    /* The render-time fact outranks the design lifecycle — no "Needs voice". */
    expect(within(row).queryByText('Needs voice')).toBeNull();
  });

  it('clears the fallback pill once a voice is designed + regenerated (no fallback in the map)', () => {
    /* After designing the voice + regenerating, generation writes snapshots
       with no renderedFallbackEngine → the map no longer carries the id, so
       the design lifecycle pill ("Designed") shows again. */
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
      preloadedState: {
        cast: { ...castSlice.getInitialState(), renderedFallbackByCharacter: {} },
      },
    });
    render(
      <Provider store={store}>
        <CastView
          characters={[marrowQwen]}
          setCharacters={() => {}}
          library={library}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    const row = rowFor('Mr. Marrow');
    expect(within(row).getByText('Designed')).toBeInTheDocument();
    expect(within(row).queryByText('Fallback (Kokoro)')).toBeNull();
  });

  it('optimistically marks the matched voice sampled after a successful Qwen audition', async () => {
    /* The library only re-hydrates on book/stage/engine/genProgress change, so
       the cast view dispatches voicesActions.markSampled on a successful sample
       synth to flip the pill live. Assert the store mutation (the rendered pill
       reads the static `library` prop in this harness). */
    vi.mocked(playSampleWithAutoLoad).mockClear();
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        voices: voicesSlice.reducer,
        castDesign: castDesignSlice.reducer,
      },
      preloadedState: {
        voices: { ...voicesSlice.getInitialState(), loaded: true, voices: library },
      },
    });
    render(
      <Provider store={store}>
        <CastView
          characters={[marrowQwen]}
          setCharacters={() => {}}
          library={library}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    const row = rowFor('Mr. Marrow');
    const swatch = row.querySelector('button[aria-label^="Play sample"]') as HTMLButtonElement;
    fireEvent.click(swatch);
    await waitFor(() =>
      expect(store.getState().voices.voices.find((v) => v.id === 'v_marrow')?.sampled).toBe(true),
    );
  });

  it('renders the lifecycle pill and the Reused badge as separate, coexisting markers', () => {
    renderView();
    /* marrow: coqui, voiceState 'generated', no match → "Matched" pill only.
       narrator: coqui voice, voiceState 'reused' + matchedFrom → "Matched"
       lifecycle pill AND a Reused provenance badge (they no longer collapse
       into a single "Reused" pill). */
    const marrowRow = rowFor('Mr. Marrow');
    expect(within(marrowRow).getByText('Matched')).toBeInTheDocument();
    expect(within(marrowRow).queryByTestId('reused-badge')).toBeNull();

    const narratorRow = rowFor('Narrator');
    expect(within(narratorRow).getByText('Matched')).toBeInTheDocument();
    expect(within(narratorRow).getByTestId('reused-badge')).toBeInTheDocument();
  });

  it('shows "Generated · Reused" together for a reused Qwen voice', () => {
    /* The real-world case the badge split fixes: a character reused from a
       prior book whose matched library voice is a bespoke Qwen voice. The
       provenance lives on `matchedFrom`; the Qwen lifecycle on the matched
       voice (its `generated` flag) — both must render, where the old single
       pill showed only "Reused". */
    const reusedQwen: Character = { ...narrator, voiceId: 'v_qwen_narrator' };
    const qwenLib: Voice[] = [
      {
        id: 'v_qwen_narrator',
        character: 'Narrator',
        bookId: 'b_prev',
        bookTitle: 'the Coalfall Commission',
        attributes: ['descriptive'],
        gradient: ['#E5B69C', '#C77B5C'],
        usedIn: 2,
        source: 'library',
        generated: true,
        ttsVoice: { provider: 'qwen', name: 'qwen-narrator-abc', description: 'Designed voice' },
      },
    ];
    renderWithLibrary([reusedQwen], qwenLib);
    const row = rowFor('Narrator');
    expect(within(row).getByText('Generated')).toBeInTheDocument();
    expect(within(row).getByTestId('reused-badge')).toBeInTheDocument();
  });

  it('renders a Qwen row without throwing when the library is empty (defensive)', () => {
    renderWithLibrary([marrowQwen], []);
    const row = rowFor('Mr. Marrow');
    /* No matched voice ⇒ generated unknown ⇒ conservative "Designed". */
    expect(within(row).getByText('Designed')).toBeInTheDocument();
  });

  it('shows "Needs voice" for a DEFAULT-engine character on a Qwen project (not a stale "Matched")', () => {
    /* The Lady Thorne bug: a character with no per-character `ttsEngine`
       still synthesises via the project default (Qwen), so an undesigned one
       must read "Needs voice" — not the preset "Matched" pill its voiceState
       would otherwise produce. The Status column resolves the effective engine
       (c.ttsEngine ?? project engine), so flipping the project to Qwen flips
       the pill. */
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b'));
    /* marrow: voiceState 'generated', no ttsEngine, no qwen override; empty
       library ⇒ no matched voice. */
    render(
      <Provider store={store}>
        <CastView
          characters={[marrow]}
          setCharacters={() => {}}
          library={[]}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    const row = rowFor('Mr. Marrow');
    expect(within(row).getByText('Needs voice')).toBeInTheDocument();
    expect(within(row).queryByText('Matched')).toBeNull();
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
    const marrowHits = screen.getAllByText('Mr. Marrow');
    expect(marrowHits.length).toBeGreaterThanOrEqual(2);
  });
});

describe('CastView responsive touch-target sizing', () => {
  it('floating selection pill buttons each meet the 44px touch target', () => {
    renderView();
    /* Open the floating pill by toggling one selection. */
    fireEvent.click(checkboxIn(rowFor('Narrator')));
    /* Compare + Clear are the two action buttons inside the floating pill —
       each carries min-h-[44px] so a thumb tap on a phone clears the WCAG
       2.5.5 target-size threshold. */
    const compare = screen.getByRole('button', { name: /^Compare$/ });
    expect(compare.className).toMatch(/min-h-\[44px\]/);
    const clear = screen.getByRole('button', { name: /Clear selection/ });
    expect(clear.className).toMatch(/min-h-\[44px\]/);
  });

  it('no longer offers a batch Regenerate button in the selection pill (plan 114)', () => {
    renderView();
    fireEvent.click(checkboxIn(rowFor('Narrator')));
    /* Per-character / batch regen was removed — the pill only compares now.
       Regeneration happens per-chapter (drawer "Regenerate this character"
       → CharacterRegenerateModal). */
    expect(screen.queryByRole('button', { name: /Regenerate/ })).toBeNull();
  });
});

describe('CastView desktop drag-drop is intact', () => {
  /* Plan 81 wave 3 invariant: the cast.tsx onDragOver/onDragLeave/onDrop
     handlers on the desktop grid rows remain functional. Wave 4 will add
     tap-to-assign as a parallel path — this test pins that the drag-drop
     path was not removed in the responsive refactor. */

  it('a voice drag-and-drop onto a character row still rewrites the cast', () => {
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    let castRef: Character[] = [narrator, marrow];
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
          onShowMatchDetail={() => {}}          driftEvents={[]}
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
    const marrowRow = rowFor('Mr. Marrow');
    act(() => {
      fireEvent.dragOver(marrowRow);
      fireEvent.drop(marrowRow);
    });
    expect(setCharacters).toHaveBeenCalled();
  });
});

/* Plan 81 wave 4 — tap-to-assign is the touch-friendly parallel path
   to drag-and-drop. Tapping the "Assign" pill on a voice card captures
   that voice; tapping any character row applies it via the same
   `applyVoiceToCharacter` write path. Sticky banner at the top surfaces
   the in-flight state; Cancel button + "Assign" pill tap toggles
   exit the mode. Desktop drag-drop stays intact (tested above). */
describe('CastView wave-4 tap-to-assign', () => {
  it('starts in the no-assignment state (no banner visible)', () => {
    renderView();
    expect(screen.queryByTestId('tap-assign-banner')).toBeNull();
  });

  it('tapping a voice card "Assign" pill surfaces the sticky banner', () => {
    renderView();
    /* The library renders one Assign pill per voice card. Pick the
       Narrator voice card's pill. */
    const assignPills = screen.getAllByRole('button', {
      name: /^Assign Narrator to a character$/,
    });
    expect(assignPills.length).toBeGreaterThanOrEqual(1);
    fireEvent.click(assignPills[0]);
    const banner = screen.getByTestId('tap-assign-banner');
    expect(banner.textContent).toMatch(/Assigning/);
    expect(banner.textContent).toContain('Narrator');
  });

  it('tapping a character row in assignment mode applies the voice', () => {
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    let castRef: Character[] = [narrator, marrow];
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
          onShowMatchDetail={() => {}}          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    /* Enter assignment mode for the Narrator voice card. */
    const assignPills = screen.getAllByRole('button', {
      name: /^Assign Narrator to a character$/,
    });
    fireEvent.click(assignPills[0]);
    /* Tap Marrow's row — applyVoiceToCharacter fires through the same
       code path as handleDrop. setCharacters should be called. */
    fireEvent.click(rowFor('Mr. Marrow'));
    expect(setCharacters).toHaveBeenCalled();
    /* Banner clears after assignment. */
    expect(screen.queryByTestId('tap-assign-banner')).toBeNull();
  });

  it('Cancel button on the banner exits assignment mode without applying', () => {
    const setCharacters = vi.fn();
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    render(
      <Provider store={store}>
        <CastView
          characters={[narrator, marrow]}
          setCharacters={setCharacters}
          library={library}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    const assignPills = screen.getAllByRole('button', {
      name: /^Assign Narrator to a character$/,
    });
    fireEvent.click(assignPills[0]);
    expect(screen.getByTestId('tap-assign-banner')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Cancel$/ }));
    expect(screen.queryByTestId('tap-assign-banner')).toBeNull();
    expect(setCharacters).not.toHaveBeenCalled();
  });

  it('the Assign pill has a ≥44px touch target', () => {
    renderView();
    const assignPills = screen.getAllByRole('button', {
      name: /^Assign Narrator to a character$/,
    });
    expect(assignPills[0].className).toMatch(/min-h-\[44px\]/);
    expect(assignPills[0].className).toMatch(/min-w-\[44px\]/);
  });
});

describe('CastView drift pill — per-character entry to the Voice Drift Detector', () => {
  /* The per-row drift pill (amber badge next to the character name)
     must call onShowDrift WITH the character id, so the modal opens
     scoped to that one character. The top-banner button still calls
     onShowDrift with no argument — that one stays unscoped. */
  it('per-row drift pill click dispatches onShowDrift(characterId)', () => {
    const onShowDrift = vi.fn();
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    const driftedNarrator: Character = {
      ...narrator,
      id: 'narrator',
    };
    render(
      <Provider store={store}>
        <CastView
          characters={[driftedNarrator, marrow]}
          setCharacters={() => {}}
          library={library}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}          driftEvents={[
            {
              id: 'd1',
              bookId: 'b1',
              characterId: 'narrator',
              chapterId: 2,
              chapterTitle: 'Chapter 2',
              severity: 'severe',
              factor: 'voice',
              factorLabel: 'Voice',
              description: 'Voice changed.',
              autoQueueable: true,
              detected: '2026-01-01T00:00:00Z',
              suggestedAction: 'regenerate_chapter',
            } as unknown as never,
          ]}
          onShowDrift={onShowDrift}
        />
      </Provider>,
    );
    /* Pill is rendered twice in the DOM — once in the desktop table
       layout and once in the mobile card layout. Either click should
       fire the same handler with the same characterId. */
    const pills = screen.getAllByTitle(/1 chapter with voice drift/);
    expect(pills.length).toBeGreaterThan(0);
    fireEvent.click(pills[0]);
    expect(onShowDrift).toHaveBeenCalledTimes(1);
    expect(onShowDrift).toHaveBeenCalledWith('narrator');
  });
});

describe('compareCastRows — cast table ordering', () => {
  const mk = (over: Partial<Character> & { id: string }): Character =>
    ({ name: over.id, role: 'r', color: 'narrator', lines: 0, ...over }) as Character;

  it('sorts by line count descending', () => {
    const out = [mk({ id: 'a', lines: 5 }), mk({ id: 'b', lines: 100 }), mk({ id: 'c', lines: 42 })]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['b', 'c', 'a']);
  });

  it('pins unknown-male and unknown-female last regardless of line count', () => {
    const out = [
      mk({ id: 'unknown-male', name: 'Unknown male', lines: 9999 }),
      mk({ id: 'wren', name: 'Wren', lines: 10 }),
      mk({ id: 'unknown-female', name: 'Unknown female', lines: 8888 }),
      mk({ id: 'narrator', name: 'Narrator', lines: 5 }),
    ]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['wren', 'narrator', 'unknown-male', 'unknown-female']);
  });

  it('orders the two buckets between themselves by line count', () => {
    const out = [
      mk({ id: 'unknown-female', name: 'Unknown female', lines: 3 }),
      mk({ id: 'unknown-male', name: 'Unknown male', lines: 7 }),
    ]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['unknown-male', 'unknown-female']);
  });

  it('breaks line-count ties by name ascending', () => {
    const out = [mk({ id: 'z', name: 'Zed', lines: 10 }), mk({ id: 'a', name: 'Amy', lines: 10 })]
      .sort(compareCastRows)
      .map((c) => c.name);
    expect(out).toEqual(['Amy', 'Zed']);
  });

  it('treats a missing line count as zero', () => {
    const out = [mk({ id: 'has', name: 'Has', lines: 1 }), mk({ id: 'none', name: 'None' })]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['has', 'none']);
  });
});

describe('CastView row ordering — wired into render', () => {
  function renderCast(chars: Character[]) {
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    return render(
      <Provider store={store}>
        <CastView
          characters={chars}
          setCharacters={() => {}}
          library={[]}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
  }
  const mk = (id: string, name: string, lines: number): Character =>
    ({ id, name, role: 'r', color: 'narrator', lines }) as Character;

  it('renders desktop rows by line count desc with the unknown bucket last', () => {
    /* Input order deliberately != sorted order so the assertion proves the sort. */
    const { container } = renderCast([
      mk('zeta', 'Zeta', 5),
      mk('unknown-male', 'Unknown male', 9999),
      mk('alpha', 'Alpha', 500),
    ]);
    const rows = Array.from(
      container.querySelectorAll('div[class*="grid-cols-[40px"]'),
    ) as HTMLElement[];
    const order = rows
      .map((row) => {
        if (within(row).queryByText('Alpha')) return 'Alpha';
        if (within(row).queryByText('Zeta')) return 'Zeta';
        if (within(row).queryByText('Unknown male')) return 'Unknown male';
        return null; // header row shares the grid-cols class — ignore it
      })
      .filter((n): n is NonNullable<typeof n> => n !== null);
    expect(order).toEqual(['Alpha', 'Zeta', 'Unknown male']);
  });
});

describe('CastView status filter', () => {
  /* The chip row under the search box lets the user isolate cast members by
     voice-matching status (multi-select, OR) so a growing cast doesn't hide
     characters still on a default voice. Statuses are resolved the same way
     the row pills are (statusFilterKeys → resolveVoiceStatus), so a chip's
     count always equals its filtered row count. */

  /* Default project engine is kokoro (preset), so narrator + marrow both
     resolve to "Matched"; narrator additionally carries the Reused badge. */
  const ghost: Character = {
    id: 'ghost',
    name: 'Ghost',
    role: 'Apparition',
    color: 'mentor',
    lines: 3,
    scenes: 1,
    attributes: [],
    ttsEngine: 'qwen', // Qwen with no designed voice ⇒ "Needs voice"
  };
  const blank: Character = {
    id: 'blank',
    name: 'Blank',
    role: 'Extra',
    color: 'mentor',
    lines: 1,
    scenes: 1,
    attributes: [], // no voiceState, no voiceId ⇒ "Unset"
  };

  function renderFilterView() {
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    return render(
      <Provider store={store}>
        <CastView
          characters={[narrator, marrow, ghost, blank]}
          setCharacters={() => {}}
          library={library}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
  }

  const filterGroup = () => screen.getByRole('group', { name: 'Filter by voice status' });
  const chip = (label: RegExp) => within(filterGroup()).getByRole('button', { name: label });
  const isPresent = (name: string) => {
    try {
      rowFor(name);
      return true;
    } catch {
      return false;
    }
  };

  it('renders one chip per present status with its live count', () => {
    renderFilterView();
    expect(chip(/^Needs voice/).textContent).toContain('1');
    expect(chip(/^Matched/).textContent).toContain('2'); // narrator + marrow
    expect(chip(/^Unset/).textContent).toContain('1');
    expect(chip(/^Reused/).textContent).toContain('1'); // narrator only
  });

  it('filters to a single status when one chip is active', () => {
    renderFilterView();
    fireEvent.click(chip(/^Needs voice/));
    expect(isPresent('Ghost')).toBe(true);
    expect(isPresent('Narrator')).toBe(false);
    expect(isPresent('Mr. Marrow')).toBe(false);
    expect(isPresent('Blank')).toBe(false);
  });

  it('unions rows across statuses when multiple chips are active (OR)', () => {
    renderFilterView();
    fireEvent.click(chip(/^Needs voice/));
    fireEvent.click(chip(/^Matched/));
    expect(isPresent('Ghost')).toBe(true); // Needs voice
    expect(isPresent('Narrator')).toBe(true); // Matched
    expect(isPresent('Mr. Marrow')).toBe(true); // Matched
    expect(isPresent('Blank')).toBe(false); // Unset — excluded
  });

  it('isolates reused characters via the Reused chip', () => {
    renderFilterView();
    fireEvent.click(chip(/^Reused/));
    expect(isPresent('Narrator')).toBe(true);
    expect(isPresent('Ghost')).toBe(false);
    expect(isPresent('Mr. Marrow')).toBe(false);
    expect(isPresent('Blank')).toBe(false);
  });

  it('Clear resets to showing every character', () => {
    renderFilterView();
    fireEvent.click(chip(/^Needs voice/));
    expect(isPresent('Narrator')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    expect(isPresent('Ghost')).toBe(true);
    expect(isPresent('Narrator')).toBe(true);
    expect(isPresent('Mr. Marrow')).toBe(true);
    expect(isPresent('Blank')).toBe(true);
    /* Clear disappears once no filter is active. */
    expect(screen.queryByRole('button', { name: 'Clear' })).toBeNull();
  });

  // Designed Qwen voice, speaks an "angry" quote, but has NO angry variant ⇒ "Needs variants".
  const fury: Character = {
    id: 'fury',
    name: 'Fury',
    role: 'Rival',
    color: 'mentor',
    lines: 4,
    scenes: 1,
    attributes: [],
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-fury', variants: {} } },
  };
  // Designed Qwen voice WITH the matching variant ⇒ "Has variants", not "Needs variants".
  const calm: Character = {
    id: 'calm',
    name: 'Calm',
    role: 'Sage',
    color: 'mentor',
    lines: 4,
    scenes: 1,
    attributes: [],
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-calm', variants: { angry: { name: 'qwen-calm-angry' } } } },
  };
  const variantSentences: Sentence[] = [
    { id: 1, chapterId: 1, text: 'No!', characterId: 'fury', emotion: 'angry' },
    { id: 2, chapterId: 1, text: 'Peace.', characterId: 'calm', emotion: 'angry' },
  ];

  function renderVariantView() {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
    });
    return render(
      <Provider store={store}>
        <CastView
          characters={[fury, calm]}
          setCharacters={() => {}}
          library={library}
          sentences={variantSentences}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
  }

  it('renders the resurrected "Has variants" chip with its count', () => {
    renderVariantView();
    expect(chip(/^Has variants/).textContent).toContain('1'); // calm only
  });

  it('filters to has-variants rows when the "Has variants" chip is active', () => {
    renderVariantView();
    fireEvent.click(chip(/^Has variants/));
    expect(isPresent('Calm')).toBe(true);
    expect(isPresent('Fury')).toBe(false);
  });

  it('renders the "Needs variants" chip and filters to unmet-variant rows', () => {
    renderVariantView();
    expect(chip(/^Needs variants/).textContent).toContain('1'); // fury only
    fireEvent.click(chip(/^Needs variants/));
    expect(isPresent('Fury')).toBe(true);
    expect(isPresent('Calm')).toBe(false);
  });
});

describe('CastView — non-English Qwen banner + auto-load (fe-16)', () => {
  function renderWithLanguage(bookLanguage: string) {
    const store = configureStore({
    reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
  });
    return render(
      <Provider store={store}>
        <CastView
          characters={[narrator, marrow]}
          setCharacters={() => {}}
          library={library}
          title="Северный путь"
          bookLanguage={bookLanguage}
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.mocked(api.loadSidecar).mockClear();
  });

  it('hides the banner and never auto-loads Qwen for an English book', async () => {
    /* QwenStatusNotice (mounted in the cast view) independently probes
       /api/qwen/detect for its install nudge, so we don't assert on fetch
       itself — the auto-load is distinguished by api.loadSidecar NOT firing. */
    const fetchSpy = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ installed: true }) });
    vi.stubGlobal('fetch', fetchSpy);
    renderWithLanguage('en');
    expect(screen.queryByTestId('cast-qwen-language-banner')).toBeNull();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled()); // QwenStatusNotice probe settled
    expect(api.loadSidecar).not.toHaveBeenCalled();
  });

  it('shows the banner and auto-loads Qwen when installed for a non-English book', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ installed: true }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    renderWithLanguage('ru');
    expect(screen.getByTestId('cast-qwen-language-banner')).toBeInTheDocument();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalledWith('/api/qwen/detect'));
    await waitFor(() => expect(api.loadSidecar).toHaveBeenCalledWith({ engine: 'qwen' }));
  });

  it('shows the banner but does NOT load Qwen when it is not installed', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ installed: false }),
    });
    vi.stubGlobal('fetch', fetchSpy);
    renderWithLanguage('ru');
    expect(screen.getByTestId('cast-qwen-language-banner')).toBeInTheDocument();
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(api.loadSidecar).not.toHaveBeenCalled();
  });
});

describe('CastView — Design full cast button', () => {
  const qwenNeedsVoice: Character = {
    ...marrow,
    ttsEngine: 'qwen',
    overrideTtsVoices: undefined,
  };
  const qwenDesigned: Character = {
    ...marrow,
    ttsEngine: 'qwen',
    overrideTtsVoices: { qwen: { name: 'qwen-v_marrow' } },
  };

  type DesignActive = {
    kind: 'bulk' | 'single';
    bookId: string;
    total: number;
    done: number;
    skipped: number;
    currentName: string | null;
    state: 'running' | 'done' | 'halted';
    lastTickAt: number;
    failures: Array<{ characterId: string; name: string; error: string }>;
  };

  function setup(
    opts: {
      chars?: Character[];
      modelKey?: TtsModelKey;
      ready?: boolean;
      designActive?: DesignActive;
    } = {},
  ) {
    const actions: Array<{ type: string; payload?: unknown }> = [];
    const recorder =
      () => (next: (a: unknown) => unknown) => (action: unknown) => {
        actions.push(action as { type: string; payload?: unknown });
        return next(action);
      };
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        cast: castSlice.reducer,
        castDesign: castDesignSlice.reducer,
      },
      preloadedState: opts.designActive ? { castDesign: { active: opts.designActive } } : undefined,
      middleware: (g) => g().concat(recorder),
    });
    if (opts.modelKey) store.dispatch(uiSlice.actions.setTtsModelKey(opts.modelKey));
    if (opts.ready) store.dispatch(uiSlice.actions.openBook({ id: 'b1', status: 'complete' }));
    render(
      <Provider store={store}>
        <CastView
          characters={opts.chars ?? [qwenNeedsVoice]}
          setCharacters={() => {}}
          library={library}
          title="X"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    return { store, actions };
  }

  it('shows on a Qwen project with ≥1 needs-voice character', () => {
    setup({ modelKey: 'qwen3-tts-0.6b' });
    expect(screen.getByTestId('design-full-cast')).toBeInTheDocument();
  });

  it('shows for a Qwen cast even when the global model is Kokoro (book engine, not global, drives visibility)', () => {
    /* fe-38 final acceptance: a book with a Qwen-designed cast (Kokoro backup)
       is a Qwen book regardless of the user's global `ttsModelKey`. The button
       used to be gated on the global engine, so a fully-Qwen sample on a default
       Kokoro install hid it — the tour then had nothing to spotlight. */
    setup({ chars: [qwenNeedsVoice] }); // no modelKey ⇒ default Kokoro global
    expect(screen.getByTestId('design-full-cast')).toBeInTheDocument();
  });

  it('is hidden for a genuinely non-Qwen cast', () => {
    /* Base Marrow: no per-character engine + a Coqui library voice ⇒ not a
       Qwen book on the default Kokoro global, so the button stays hidden. */
    setup({ chars: [{ ...Marrow, ttsEngine: undefined, overrideTtsVoices: undefined }] });
    expect(screen.queryByTestId('design-full-cast')).toBeNull();
  });

  it('stays visible-but-disabled (with the tour anchor) when every character already has a voice', () => {
    /* fe-38 final acceptance: the button used to vanish once the roster was
       fully designed, leaving the guided tour's "Design the whole cast" step
       with nothing to spotlight. It now stays rendered, disabled, and carries
       the tour anchor — and, like visibility, this no longer depends on the
       global model being Qwen. */
    setup({ chars: [qwenDesigned] }); // default Kokoro global; cast is Qwen
    const btn = screen.getByTestId('design-full-cast');
    expect(btn).toBeDisabled();
    expect(btn.getAttribute('data-tour-id')).toBe('design-full-cast-btn');
  });

  it('click opens the scope picker (no immediate dispatch)', () => {
    const { actions } = setup({ modelKey: 'qwen3-tts-0.6b', ready: true });
    fireEvent.click(screen.getByTestId('design-full-cast'));
    /* Picker must be visible now */
    expect(screen.getByTestId('design-scope-picker')).toBeInTheDocument();
    /* No designAllRequested dispatched yet */
    expect(actions.find((x) => x.type === castDesignActions.designAllRequested.type)).toBeUndefined();
  });

  it('picking "bases" from the scope picker dispatches designAllRequested with scope:bases', () => {
    const { actions } = setup({ modelKey: 'qwen3-tts-0.6b', ready: true });
    fireEvent.click(screen.getByTestId('design-full-cast'));
    fireEvent.click(screen.getByTestId('scope-bases'));
    const a = actions.find((x) => x.type === castDesignActions.designAllRequested.type) as
      | { payload: { bookId: string; characterIds: string[]; modelKey: string; scope: string } }
      | undefined;
    expect(a?.payload.bookId).toBe('b1');
    expect(a?.payload.characterIds).toEqual(['marrow']);
    expect(a?.payload.modelKey).toMatch(/qwen/);
    expect(a?.payload.scope).toBe('bases');
    /* Picker closes after picking */
    expect(screen.queryByTestId('design-scope-picker')).toBeNull();
  });

  it('opens the scope picker and dispatches a variants-scope design', () => {
    /* wren: has a base voice + an in-use emotion missing a variant */
    const wren: Character = {
      id: 'wren',
      name: 'Wren',
      role: 'Hero',
      color: 'mentor',
      lines: 20,
      scenes: 5,
      attributes: [],
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-wren', variants: {} } },
    };
    const variantSents: Sentence[] = [
      { id: 10, chapterId: 1, text: 'No!', characterId: 'wren', emotion: 'angry' },
    ];
    const actions2: Array<{ type: string; payload?: unknown }> = [];
    const recorder2 =
      () => (next: (a: unknown) => unknown) => (action: unknown) => {
        actions2.push(action as { type: string; payload?: unknown });
        return next(action);
      };
    const store2 = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
      middleware: (g) => g().concat(recorder2),
    });
    store2.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b'));
    store2.dispatch(uiSlice.actions.openBook({ id: 'b2', status: 'complete' }));
    render(
      <Provider store={store2}>
        <CastView
          characters={[wren]}
          setCharacters={() => {}}
          library={library}
          sentences={variantSents}
          title="X"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('design-full-cast'));
    expect(screen.getByTestId('design-scope-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('scope-variants'));
    const a = actions2.find((x) => x.type === castDesignActions.designAllRequested.type) as
      | {
          payload: {
            bookId: string;
            characterIds: string[];
            modelKey: string;
            scope: string;
            variantTasks: Array<{ characterId: string; emotions: string[] }>;
          };
        }
      | undefined;
    expect(a?.payload.bookId).toBe('b2');
    expect(a?.payload.scope).toBe('variants');
    expect(a?.payload.characterIds).toEqual([]);
    expect(a?.payload.variantTasks).toEqual([{ characterId: 'wren', emotions: ['angry'] }]);
  });

  it('shows a Cancel control while a run for this book is active', () => {
    setup({
      modelKey: 'qwen3-tts-0.6b',
      ready: true,
      designActive: {
        kind: 'bulk',
        bookId: 'b1',
        total: 3,
        done: 1,
        skipped: 0,
        currentName: 'Mr. Marrow',
        state: 'running',
        lastTickAt: 1,
        failures: [],
      },
    });
    expect(screen.getByTestId('design-full-cast')).toHaveTextContent('Cancel design · 1/3');
  });

  it('picking "both" from the scope picker dispatches designAllRequested with scope:both, non-empty characterIds AND variantTasks', () => {
    /* needsVoice: Qwen character with no designed voice → lands in needsVoiceIds.
       withBase: Qwen character with a base voice + an in-use emotion without a
       variant → lands in variantTasks. Both lists are non-empty so the "both"
       scope path is fully exercised. */
    const needsVoice: Character = {
      id: 'needs-voice',
      name: 'Needs Voice',
      role: 'Extra',
      color: 'mentor',
      lines: 3,
      scenes: 1,
      attributes: [],
      ttsEngine: 'qwen',
      overrideTtsVoices: undefined,
    };
    const withBase: Character = {
      id: 'with-base',
      name: 'With Base',
      role: 'Hero',
      color: 'mentor',
      lines: 10,
      scenes: 3,
      attributes: [],
      ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-with-base', variants: {} } },
    };
    const bothSents: Sentence[] = [
      { id: 20, chapterId: 1, text: 'I am furious!', characterId: 'with-base', emotion: 'angry' },
    ];
    const actionsBoth: Array<{ type: string; payload?: unknown }> = [];
    const recorderBoth =
      () => (next: (a: unknown) => unknown) => (action: unknown) => {
        actionsBoth.push(action as { type: string; payload?: unknown });
        return next(action);
      };
    const storeBoth = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
      middleware: (g) => g().concat(recorderBoth),
    });
    storeBoth.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b'));
    storeBoth.dispatch(uiSlice.actions.openBook({ id: 'b3', status: 'complete' }));
    render(
      <Provider store={storeBoth}>
        <CastView
          characters={[needsVoice, withBase]}
          setCharacters={() => {}}
          library={library}
          sentences={bothSents}
          title="X"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('design-full-cast'));
    expect(screen.getByTestId('design-scope-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('scope-both'));
    const a = actionsBoth.find((x) => x.type === castDesignActions.designAllRequested.type) as
      | {
          payload: {
            bookId: string;
            characterIds: string[];
            modelKey: string;
            scope: string;
            variantTasks: Array<{ characterId: string; emotions: string[] }>;
          };
        }
      | undefined;
    expect(a?.payload.bookId).toBe('b3');
    expect(a?.payload.scope).toBe('both');
    /* Both lists non-empty: needsVoice in characterIds, withBase in variantTasks */
    expect(a?.payload.characterIds).toEqual(['needs-voice']);
    expect(a?.payload.variantTasks).toEqual([{ characterId: 'with-base', emotions: ['angry'] }]);
    /* Picker closes after picking */
    expect(screen.queryByTestId('design-scope-picker')).toBeNull();
  });

  it('counts a baseless emotion character in the picker total but EXCLUDES it from the variants-only dispatch', () => {
    /* withBase: qwen + base + 1 missing variant → "ready now".
       baseless: qwen + NO base + 2 in-use emotions → counted as demand (the
       picker total reflects the cast rows), but the variants-only scope can't
       act on it (no base) so it must be dropped from the dispatch and a loud
       warning shown — the user designs its base via "Both" first. */
    const withBase: Character = {
      id: 'with-base', name: 'With Base', role: 'Hero', color: 'mentor',
      lines: 10, scenes: 3, attributes: [], ttsEngine: 'qwen',
      overrideTtsVoices: { qwen: { name: 'qwen-with-base', variants: {} } },
    };
    const baseless: Character = {
      id: 'baseless', name: 'Baseless', role: 'Extra', color: 'mentor',
      lines: 4, scenes: 1, attributes: [], ttsEngine: 'qwen',
      overrideTtsVoices: undefined,
    };
    const sents: Sentence[] = [
      { id: 30, chapterId: 1, text: 'Rage!', characterId: 'with-base', emotion: 'angry' },
      { id: 31, chapterId: 1, text: 'Hush', characterId: 'baseless', emotion: 'whisper' },
      { id: 32, chapterId: 1, text: 'Yay!', characterId: 'baseless', emotion: 'excited' },
    ];
    const actions: Array<{ type: string; payload?: unknown }> = [];
    const recorder =
      () => (next: (a: unknown) => unknown) => (action: unknown) => {
        actions.push(action as { type: string; payload?: unknown });
        return next(action);
      };
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
      middleware: (g) => g().concat(recorder),
    });
    store.dispatch(uiSlice.actions.setTtsModelKey('qwen3-tts-0.6b'));
    store.dispatch(uiSlice.actions.openBook({ id: 'b4', status: 'complete' }));
    render(
      <Provider store={store}>
        <CastView
          characters={[withBase, baseless]}
          setCharacters={() => {}}
          library={library}
          sentences={sents}
          title="X"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('design-full-cast'));
    /* Picker total = 3 (1 ready + 2 blocked); Both = 1 base + 3 variants = 4. */
    expect(screen.getByTestId('scope-variants')).toHaveTextContent('3');
    expect(screen.getByTestId('variants-split')).toHaveTextContent('1 ready');
    expect(screen.getByTestId('variants-split')).toHaveTextContent('2 need a base');
    expect(screen.getByTestId('variants-base-warning')).toBeInTheDocument();
    expect(screen.getByTestId('scope-both')).toHaveTextContent('4 tasks');
    /* Variants-only dispatch carries ONLY the ready (has-base) task. */
    fireEvent.click(screen.getByTestId('scope-variants'));
    const a = actions.find((x) => x.type === castDesignActions.designAllRequested.type) as
      | { payload: { scope: string; characterIds: string[]; variantTasks: Array<{ characterId: string; emotions: string[] }> } }
      | undefined;
    expect(a?.payload.scope).toBe('variants');
    expect(a?.payload.characterIds).toEqual([]);
    expect(a?.payload.variantTasks).toEqual([{ characterId: 'with-base', emotions: ['angry'] }]);
  });
});

describe('CastView — variant glyph strip in the Status column', () => {
  /* fs-34 / Task 9 — the Status column shows a per-emotion glyph strip for
     Qwen rows instead of the legacy count badge + "N tags need a variant"
     text hint.  The strip renders inline below the lifecycle pill; the old
     VariantsBadge count and missing-variants-hint span must not appear. */

  const wren: Character = {
    id: 'wren',
    name: 'Wren',
    role: 'Hero',
    color: 'mentor',
    lines: 20,
    scenes: 5,
    attributes: [],
    ttsEngine: 'qwen',
    overrideTtsVoices: {
      qwen: { name: 'qwen-wren', variants: { angry: { name: 'qwen-wren-angry' } } },
    },
  };
  const wrenSentences: Sentence[] = [
    { id: 1, chapterId: 1, text: 'No!', characterId: 'wren', emotion: 'angry' },
    { id: 2, chapterId: 1, text: 'Amazing!', characterId: 'wren', emotion: 'excited' },
  ];

  function renderGlyphTest() {
    const store = configureStore({
      reducer: { ui: uiSlice.reducer, cast: castSlice.reducer, castDesign: castDesignSlice.reducer },
    });
    return render(
      <Provider store={store}>
        <CastView
          characters={[wren]}
          setCharacters={() => {}}
          library={library}
          sentences={wrenSentences}
          title="The Northern Star"
          onOpenProfile={() => {}}
          onShowMatchDetail={() => {}}
          driftEvents={[]}
          onShowDrift={() => {}}
        />
      </Provider>,
    );
  }

  it('cast row shows the variant glyph strip and not the legacy count badge', () => {
    renderGlyphTest();
    /* The view renders both a desktop grid row and a mobile card row — scope
       to the desktop grid row (same strategy used by other CastView tests). */
    const row = rowFor('Wren');
    /* angry is designed → state=designed; excited is in-use but not in variants → state=needed */
    expect(within(row).getByTestId('variant-glyph-angry')).toHaveAttribute('data-state', 'designed');
    expect(within(row).getByTestId('variant-glyph-excited')).toHaveAttribute('data-state', 'needed');
    expect(within(row).queryByTestId('variants-badge')).not.toBeInTheDocument();
    expect(within(row).queryByTestId('missing-variants-hint')).not.toBeInTheDocument();
  });
});
