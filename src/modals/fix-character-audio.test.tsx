/* fs-26 — FixCharacterAudioModal drives one splice per selected RENDERED
   chapter the character appears in, and surfaces a pending A/B revision per
   completed chapter. api.streamSplice is mocked so no backend is needed. */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { FixCharacterAudioModal } from './fix-character-audio';
import { chaptersSlice } from '../store/chapters-slice';
import { uiSlice } from '../store/ui-slice';
import { revisionsSlice } from '../store/revisions-slice';
import type { SpliceArgs, SpliceTick } from '../lib/api';

const { streamSpliceSpy } = vi.hoisted(() => ({ streamSpliceSpy: vi.fn() }));

vi.mock('../lib/api', () => ({ api: { streamSplice: streamSpliceSpy } }));

function makeStore() {
  return configureStore({
    reducer: {
      chapters: chaptersSlice.reducer,
      ui: uiSlice.reducer,
      revisions: revisionsSlice.reducer,
    },
    preloadedState: {
      chapters: {
        chapters: [
          // Castor speaks, rendered → candidate
          { id: 1, title: 'The Meadow', slug: 'c1', duration: '2:00', state: 'done', progress: 1, characters: { Castor: 'done', amy: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
          // Castor speaks, rendered → candidate
          { id: 2, title: 'The River', slug: 'c2', duration: '3:00', state: 'done', progress: 1, characters: { Castor: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
          // Castor speaks but NOT rendered → excluded
          { id: 3, title: 'Hidden Lake', slug: 'c3', duration: '00:00', state: 'queued', progress: 0, characters: { Castor: 'queued' }, phase: null },
          // Rendered but Castor absent → excluded
          { id: 4, title: 'Alone', slug: 'c4', duration: '1:00', state: 'done', progress: 1, characters: { amy: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
        ],
      } as never,
    } as never,
  });
}

describe('FixCharacterAudioModal', () => {
  beforeEach(() => {
    streamSpliceSpy.mockReset();
    streamSpliceSpy.mockImplementation(async (args: SpliceArgs) => {
      args.onTick({ type: 'splice_start', chapterId: args.chapterId, mode: args.mode, characterId: args.characterId });
      args.onTick({
        type: 'splice_complete',
        chapterId: args.chapterId,
        characterId: args.characterId,
        mode: args.mode,
        durationSec: 120,
        segmentCount: 1,
        hasPreviousAudio: true,
      } as SpliceTick);
    });
  });
  afterEach(cleanup);

  function renderModal() {
    const store = makeStore();
    render(
      <Provider store={store}>
        <FixCharacterAudioModal characterId="Castor" characterName="Castor Allred" bookId="bk1" onClose={() => {}} />
      </Provider>,
    );
    return store;
  }

  it('offers only rendered chapters the character appears in', () => {
    renderModal();
    // 2 candidates (ch1, ch2); ch3 unrendered + ch4 no-Castor excluded.
    // The primary button name encodes the count.
    expect(screen.getByRole('button', { name: /Apply to 2 chapters/i })).toBeTruthy();
    expect(screen.getByText(/The Meadow/)).toBeTruthy();
    expect(screen.getByText(/The River/)).toBeTruthy();
    expect(screen.queryByText(/Hidden Lake/)).toBeNull();
    expect(screen.queryByText(/Alone/)).toBeNull();
  });

  it('runs one remix splice per selected chapter and enqueues pending revisions', async () => {
    const store = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Apply to 2 chapters/i }));
    await waitFor(() => expect(streamSpliceSpy).toHaveBeenCalledTimes(2));
    // both calls are remix with the chosen gain
    expect(streamSpliceSpy.mock.calls.every(([a]) => a.mode === 'remix' && a.gainDb === 3)).toBe(true);
    // a pending revision per chapter, both flipped playable on completion
    await waitFor(() => {
      const pending = store.getState().revisions.pending;
      expect(pending).toHaveLength(2);
      expect(pending.every((r) => r.playable)).toBe(true);
    });
    expect(screen.getByTestId('fix-audio-summary').textContent).toMatch(/2 chapters updated/);
  });

  it('switches to re-record mode and sends modelKey instead of gain', async () => {
    renderModal();
    fireEvent.click(screen.getByText('Re-record')); // the mode toggle <p>
    fireEvent.click(screen.getByRole('button', { name: /Re-record 2 chapters/i }));
    await waitFor(() => expect(streamSpliceSpy).toHaveBeenCalledTimes(2));
    expect(streamSpliceSpy.mock.calls.every(([a]) => a.mode === 'rerecord' && a.gainDb === undefined && !!a.modelKey)).toBe(true);
  });
});
