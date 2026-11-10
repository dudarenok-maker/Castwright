/* F5 (A120 run 2): in the real app the drawer showed canned fixture factors
   and named the CURRENT book under "From your library". Real mode shows only
   real data: the matched book's title, and no invented factors. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { MatchDetailDrawer } from './match-detail';
import { uiSlice } from '../store/ui-slice';
import type { Character, Voice } from '../lib/types';

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({ isPlaying: false, currentUrl: null, play: vi.fn(), stop: vi.fn(), pause: vi.fn() }),
}));
vi.mock('../lib/play-sample-with-auto-load', () => ({
  playSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));

const CHARACTER = {
  id: 'narrator',
  name: 'Maerin the reeve',
  role: 'Reeve',
  color: 'narrator',
  voiceId: 'qwen-x',
  voiceState: 'reused',
  attributes: [],
  matchedFrom: { bookId: 'b1', bookTitle: 'Chain Book 1', characterId: 'm', confidence: 0.9 },
} as unknown as Character;
const VOICE = {
  id: 'qwen-x',
  name: 'x',
  character: 'Maerin the reeve',
  bookTitle: 'Chain Book 3',
  engine: 'qwen',
  attributes: [],
} as unknown as Voice;

function renderDrawer() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  render(
    <Provider store={store}>
      <MatchDetailDrawer character={CHARACTER} voice={VOICE} onClose={() => {}} onConfirm={() => {}} onDecline={() => {}} />
    </Provider>,
  );
}

describe('MatchDetailDrawer — real (non-mock) data only', () => {
  it('names the matched book, not the current one', () => {
    renderDrawer();
    expect(screen.getByText('Chain Book 1')).toBeTruthy();
    expect(screen.queryByText('Chain Book 3')).toBeNull();
  });

  it('shows no canned match factors', () => {
    renderDrawer();
    expect(screen.queryByText(/Anders Vale/)).toBeNull();
    expect(screen.queryByText('Match factors')).toBeNull();
  });
});
