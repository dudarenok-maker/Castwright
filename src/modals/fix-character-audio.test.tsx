/* fs-26 — FixCharacterAudioModal filters to the rendered chapters the character
   appears in, and dispatches a splice/startBatch with the chosen mode + params.
   The actual per-chapter loop lives in splice-runner-middleware (covered in its
   own test); here we assert the modal's candidate filter + the dispatched
   batch, so no api mock / middleware is needed. */

import { describe, expect, it, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore, type Action } from '@reduxjs/toolkit';
import { FixCharacterAudioModal } from './fix-character-audio';
import { chaptersSlice } from '../store/chapters-slice';
import { uiSlice } from '../store/ui-slice';
import { spliceSlice, type SpliceBatchRequest } from '../store/splice-slice';
import type { Chapter } from '../lib/types';

const CHAPTERS: Chapter[] = [
  // Bronte speaks, rendered → candidate
  { id: 1, title: 'The Meadow', duration: '2:00', state: 'done', progress: 1, characters: { bronte: 'done', amy: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
  // Bronte speaks, rendered → candidate
  { id: 2, title: 'The River', duration: '3:00', state: 'done', progress: 1, characters: { bronte: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
  // Bronte speaks but NOT rendered → excluded
  { id: 3, title: 'Hidden Lake', duration: '00:00', state: 'queued', progress: 0, characters: { bronte: 'queued' }, phase: null },
  // Rendered but Bronte absent → excluded
  { id: 4, title: 'Alone', duration: '1:00', state: 'done', progress: 1, characters: { amy: 'done' }, phase: null, audioModelKey: 'kokoro-v1' },
] as Chapter[];

function makeStore(recorded: Action[]) {
  return configureStore({
    reducer: {
      chapters: chaptersSlice.reducer,
      ui: uiSlice.reducer,
      splice: spliceSlice.reducer,
    },
    preloadedState: {
      chapters: { ...chaptersSlice.getInitialState(), chapters: CHAPTERS },
    },
    middleware: (getDefault) =>
      getDefault().concat(
        () => (next: (a: unknown) => unknown) => (action: unknown) => {
          recorded.push(action as Action);
          return next(action);
        },
      ),
  });
}

describe('FixCharacterAudioModal', () => {
  afterEach(cleanup);

  function renderModal() {
    const recorded: Action[] = [];
    const store = makeStore(recorded);
    render(
      <Provider store={store}>
        <FixCharacterAudioModal characterId="bronte" characterName="Bronte Allred" bookId="bk1" onClose={() => {}} />
      </Provider>,
    );
    const lastStartBatch = () =>
      [...recorded].reverse().find((a) => a.type === 'splice/startBatch') as
        | { type: string; payload: SpliceBatchRequest }
        | undefined;
    return { store, lastStartBatch };
  }

  it('offers only rendered chapters the character appears in', () => {
    renderModal();
    // 2 candidates (ch1, ch2); ch3 unrendered + ch4 no-bronte excluded.
    expect(screen.getByRole('button', { name: /Apply to 2 chapters/i })).toBeTruthy();
    expect(screen.getByText(/The Meadow/)).toBeTruthy();
    expect(screen.getByText(/The River/)).toBeTruthy();
    expect(screen.queryByText(/Hidden Lake/)).toBeNull();
    expect(screen.queryByText(/Alone/)).toBeNull();
  });

  it('dispatches a remix batch with the chosen gain for the candidate chapters', () => {
    const { store, lastStartBatch } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: /Apply to 2 chapters/i }));
    const action = lastStartBatch();
    expect(action).toBeTruthy();
    expect(action!.payload).toMatchObject({
      bookId: 'bk1',
      characterId: 'bronte',
      mode: 'remix',
      gainDb: 3,
      chapterIds: [1, 2],
    });
    expect(action!.payload.modelKey).toBeUndefined();
    // the slice recorded a running batch → modal flips to working state
    const batch = Object.values(store.getState().splice.batches)[0];
    expect(batch).toMatchObject({ total: 2, status: 'running', mode: 'remix' });
    expect(screen.getByRole('button', { name: /Working…/i })).toBeTruthy();
  });

  it('switches to re-record mode and sends modelKey instead of gain', () => {
    const { lastStartBatch } = renderModal();
    fireEvent.click(screen.getByText('Re-record')); // the mode toggle <p>
    fireEvent.click(screen.getByRole('button', { name: /Re-record 2 chapters/i }));
    const action = lastStartBatch();
    expect(action!.payload).toMatchObject({ mode: 'rerecord', chapterIds: [1, 2] });
    expect(action!.payload.gainDb).toBeUndefined();
    expect(typeof action!.payload.modelKey).toBe('string');
  });
});
