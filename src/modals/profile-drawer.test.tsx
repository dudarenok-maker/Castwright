// Pairs with docs/features/10-profile-drawer.md

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { uiSlice } from '../store/ui-slice';
import { ProfileDrawer } from './profile-drawer';
import type { Character } from '../lib/types';

vi.mock('../lib/api', () => ({
  api: { getVoiceSample: vi.fn() },
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

function makeStore() {
  return configureStore({ reducer: { ui: uiSlice.reducer } });
}

function renderDrawer(character: Character) {
  return render(
    <Provider store={makeStore()}>
      <ProfileDrawer
        character={character}
        voice={undefined}
        onClose={() => {}}
        onSave={() => {}}
        onLock={() => {}}
      />
    </Provider>,
  );
}

const evidenceLongFirst = [
  { quote: 'A long-form excerpt that the analyzer marks as the voice-cloning sample.', note: 'long' },
  { quote: 'A medium-length quote for tonal context.', note: 'medium' },
  { quote: 'Short quip.', note: 'short' },
];

const baseChar: Character = {
  id: 'halloran',
  name: 'Captain Halloran',
  role: 'Captain',
  color: 'halloran',
  lines: 100,
  scenes: 5,
};

describe('ProfileDrawer evidence rendering', () => {
  it('renders the first 3 evidence quotes by default, in array order', () => {
    renderDrawer({ ...baseChar, evidence: evidenceLongFirst });

    /* All three quotes visible — no "Show more" needed. */
    expect(screen.getByText(evidenceLongFirst[0].quote)).toBeTruthy();
    expect(screen.getByText(evidenceLongFirst[1].quote)).toBeTruthy();
    expect(screen.getByText(evidenceLongFirst[2].quote)).toBeTruthy();

    /* The drawer trusts the server-provided order (longest-first); the
       UI does NOT re-sort. Verify by reading the rendered blockquote
       elements in DOM order. */
    const blockquotes = document.querySelectorAll('blockquote');
    const texts = Array.from(blockquotes).map(b => b.textContent);
    expect(texts).toEqual(evidenceLongFirst.map(e => e.quote));
  });

  it('hides quotes beyond the first 3 behind a "Show more" affordance', () => {
    const extras = [
      ...evidenceLongFirst,
      { quote: 'Fourth quote, only revealed after expand.', note: 'extra' },
    ];
    renderDrawer({ ...baseChar, evidence: extras });

    /* Fourth quote not in the DOM yet. */
    expect(screen.queryByText(extras[3].quote)).toBeNull();

    /* The toggle button shows the residual count. */
    const toggle = screen.getByRole('button', { name: /\+ Show 1 more/i });
    fireEvent.click(toggle);

    expect(screen.getByText(extras[3].quote)).toBeTruthy();
    expect(screen.getByRole('button', { name: /Show fewer/i })).toBeTruthy();
  });

  it('does not render the toggle when the character has exactly 3 quotes', () => {
    renderDrawer({ ...baseChar, evidence: evidenceLongFirst });
    expect(screen.queryByRole('button', { name: /Show \d+ more/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Show fewer/i })).toBeNull();
  });
});
