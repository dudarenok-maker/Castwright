/* fs-38 Wave 1, Task 14 — #/voices page restructure shell.
   Covers the three-way segmented nav (My voices | In use | Catalogue),
   which always renders in full, and the My-voices empty-state CTA.
   The existing rollup (families/compare/merge/pin) test coverage lives in
   voices.test.tsx, unmodified by this task. */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { castSlice } from '../store/cast-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { uiSlice } from '../store/ui-slice';
import { voicesSlice } from '../store/voices-slice';
import { configSlice, type ConfigState } from '../store/config-slice';
import { voiceLibrarySlice } from '../store/voice-library-slice';
import { LibraryView } from './voices';
import type { BaseVoice, ConfigValues, Voice } from '../lib/types';

const getBaseVoices = vi.fn<() => Promise<{ voices: BaseVoice[] }>>(() =>
  Promise.resolve({ voices: [] }),
);
const listVoiceLibrary = vi.fn(() => Promise.resolve({ voices: [] }));

vi.mock('../lib/api', () => ({
  api: {
    getBaseVoices: () => getBaseVoices(),
    listVoiceLibrary: () => listVoiceLibrary(),
    setVoicePin: vi.fn(() => Promise.resolve()),
    setVoiceOverride: vi.fn(),
    getBookState: vi.fn(() => Promise.resolve(null)),
    getSeriesCast: () => Promise.resolve({ characters: [] }),
    seriesPatchCharacter: vi.fn(),
    mergeCharacters: vi.fn(),
    linkPriorCharacter: vi.fn(),
    notLinkedTo: vi.fn(),
    removeNotLinkedTo: vi.fn(),
  },
}));

const library: Voice[] = [
  {
    id: 'narrator',
    character: 'Narrator',
    bookId: 'b1',
    bookTitle: 'Book One',
    source: 'current',
    attributes: ['warm'],
    gradient: ['#3C194F', '#0F0E0D'],
    usedIn: 1,
    ttsVoice: { provider: 'gemini', name: 'Charon', description: 'Informative' },
  } as Voice,
];

/** Base config state matching ConfigState's shape; `values` overridden per-test. */
function makeConfigState(values: ConfigValues = {}): ConfigState {
  return {
    groups: [],
    descriptors: [],
    values,
    status: 'idle',
    error: null,
    hydrated: true,
    cudaEnvShadow: false,
  };
}

function makeStore(configValues: ConfigValues = {}) {
  return configureStore({
    reducer: {
      ui: uiSlice.reducer,
      cast: castSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      voices: voicesSlice.reducer,
      notifications: notificationsSlice.reducer,
      config: configSlice.reducer,
      voiceLibrary: voiceLibrarySlice.reducer,
    },
    preloadedState: {
      config: makeConfigState(configValues),
    },
  });
}

function renderView(configValues: ConfigValues = {}) {
  return render(
    <Provider store={makeStore(configValues)}>
      <LibraryView library={library} />
    </Provider>,
  );
}

describe('LibraryView restructure — three-way section nav (fs-38 Wave 1 Task 14)', () => {
  it('renders the segments in the locked order: My voices, In use, Catalogue', () => {
    renderView();
    const nav = screen.getByRole('group', { name: 'Voice library sections' });
    const buttons = within(nav).getAllByRole('button');
    expect(buttons.map((b) => b.textContent)).toEqual(['My voices', 'In use', 'Catalogue']);
  });

  it('defaults to the In-use section (existing rollup content) on mount', () => {
    renderView();
    /* "This book" / "Series & older" rollup tabs only render inside the
       In-use section — their presence proves it's the default. */
    expect(screen.getByRole('button', { name: /This book/i })).toBeInTheDocument();
  });

  it('shows the My-voices empty-state with a Create-voice CTA when selected', () => {
    renderView();
    fireEvent.click(screen.getByRole('button', { name: 'My voices' }));
    expect(screen.getByText('No voices in your library yet')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create voice' })).toBeInTheDocument();
  });

  /* The `voices.library.enabled` knob is gone (it hid the tab while leaving
     Cast-view entry points — profile-drawer assign/promote, the In-use
     card's "View in My voices" (#1833) — wired to routes that then 404'd).
     A user who flipped it off still carries `voices.library.enabled: false`
     in their persisted config overrides, so pin that the leftover value is
     inert rather than silently resurrecting the gate. */
  it('renders My voices even when a stale voices.library.enabled=false override is still persisted', () => {
    renderView({
      'voices.library.enabled': {
        key: 'voices.library.enabled',
        effective: false,
        source: 'override',
        locked: false,
        overridden: true,
      },
    });
    expect(screen.getByRole('button', { name: 'My voices' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'My voices' }));
    expect(screen.getByText('No voices in your library yet')).toBeInTheDocument();
  });
});
