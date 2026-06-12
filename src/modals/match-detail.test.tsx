/* Regression coverage for the match-detail drawer's z-index stacking
   contract. The drawer is opened from inside the profile drawer ("see why"
   link) and must paint ON TOP of the profile drawer. Both drawers used to
   share `z-50` and rely on DOM order — profile-drawer is rendered later in
   `src/components/layout.tsx`, so it won the stacking and match-detail
   opened underneath, invisible to the user.

   Asserting the literal z-index classes is brittler than a computed-style
   check, but jsdom doesn't apply Tailwind utilities so getBoundingClientRect
   / getComputedStyle can't catch the ordering. This unit closes the gap by
   pinning the contract: backdrop ≥ z-[60], aside ≥ z-[70]. */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MatchDetailDrawer } from './match-detail';
import { uiSlice } from '../store/ui-slice';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    isPlaying: false,
    currentUrl: null,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
  }),
}));

const TEST_CHARACTER: Character = {
  id: 'narrator',
  name: 'Narrator',
  role: 'Third-person observer',
  description: 'A test character.',
  color: 'narrator',
  voiceId: 'kokoro:af_alloy',
  voiceState: 'reused',
  lineCount: 100,
  sceneCount: 10,
  attributes: [],
  matchedFrom: {
    bookId: 'the Hollow Tide',
    bookTitle: 'The Hollow Tide',
    characterId: 'narrator',
    confidence: 0.92,
  },
} as unknown as Character;

const TEST_VOICE: Voice = {
  id: 'kokoro:af_alloy',
  name: 'af_alloy',
  character: 'Narrator',
  engine: 'kokoro',
  attributes: [],
} as unknown as Voice;

function renderDrawer() {
  const store = configureStore({
    reducer: { ui: uiSlice.reducer },
  });
  return render(
    <Provider store={store}>
      <MatchDetailDrawer
        character={TEST_CHARACTER}
        voice={TEST_VOICE}
        onClose={() => {}}
        onConfirm={() => {}}
        onDecline={() => {}}
      />
    </Provider>,
  );
}

describe('MatchDetailDrawer stacking contract', () => {
  it('backdrop carries a z-index ≥ 60 (above profile-drawer backdrop at z-40)', () => {
    const { container } = renderDrawer();
    const backdrop = container.querySelector('.fixed.inset-0');
    expect(backdrop).not.toBeNull();
    // Tailwind 4 emits z-60 (bare); v3 emitted z-[60]. Accept either form.
    expect(backdrop?.className).toMatch(/z-\[?(?:60|7\d|8\d|9\d)\]?/);
  });

  it('aside carries a z-index ≥ 70 (above profile-drawer aside at z-50)', () => {
    const { container } = renderDrawer();
    const aside = container.querySelector('aside');
    expect(aside).not.toBeNull();
    // Tailwind 4 emits z-70 (bare); v3 emitted z-[70]. Accept either form.
    expect(aside?.className).toMatch(/z-\[?(?:70|8\d|9\d)\]?/);
  });
});
