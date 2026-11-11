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

function renderDrawer(character: Character = CHARACTER, name?: string) {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  render(
    <Provider store={store}>
      <MatchDetailDrawer character={character} voice={VOICE} matchedCharacterName={name} onClose={() => {}} onConfirm={() => {}} onDecline={() => {}} />
    </Provider>,
  );
}

const withMatch = (m: Partial<NonNullable<Character['matchedFrom']>>, extra: object = {}) =>
  ({ ...CHARACTER, ...extra, matchedFrom: { ...CHARACTER.matchedFrom, ...m } }) as Character;

describe('MatchDetailDrawer — real match data only', () => {
  it('names the matched book, not the current one', () => {
    renderDrawer();
    expect(screen.getByText('Chain Book 1')).toBeTruthy();
    expect(screen.queryByText('Chain Book 3')).toBeNull();
  });

  it('shows no factors section when the row carries none (no fixture text)', () => {
    renderDrawer();
    expect(screen.queryByText(/Anders Vale/)).toBeNull();
    expect(screen.queryByText('Match factors')).toBeNull();
  });

  it("renders the row's real matchFactors", () => {
    renderDrawer(
      withMatch({}, { matchFactors: [{ id: 'name_exact', label: 'Name match', score: 1, detail: 'Same name' }] }),
    );
    expect(screen.getByText('Match factors')).toBeTruthy();
    expect(screen.getByText('Name match')).toBeTruthy();
  });

  it("names the matched book's character, or omits the name when it cannot be resolved", () => {
    renderDrawer(CHARACTER, 'Maerin');
    expect(screen.getByText('Maerin')).toBeTruthy();
  });

  it("does not show the current book's voice name when the matched name is unknown", () => {
    renderDrawer();
    const card = screen.getByText('From your library').parentElement as HTMLElement;
    expect(card.textContent).not.toContain('Maerin the reeve');
  });

  it('words the confidence from its value and invents none when absent', () => {
    renderDrawer(withMatch({ confidence: 0.35 }));
    expect(screen.getByText('35')).toBeTruthy();
    expect(screen.queryByText(/Strong match/)).toBeNull();
    expect(screen.getByText(/Weak match/)).toBeTruthy();
  });

  it('shows no confidence block when the link has none', () => {
    renderDrawer(withMatch({ confidence: undefined }));
    expect(screen.queryByText('Overall confidence')).toBeNull();
    expect(screen.queryByText('92')).toBeNull();
  });

  it('says strong for a high-confidence link', () => {
    renderDrawer();
    expect(screen.getByText(/Strong match/)).toBeTruthy();
  });
});
