import { describe, it, expect } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { manuscriptSlice } from '../store/manuscript-slice';
import { SentenceEmotionControl } from './sentence-emotion-control';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeStore(sentences: any[]) {
  return configureStore({
    reducer: { manuscript: manuscriptSlice.reducer },
    preloadedState: { manuscript: { ...manuscriptSlice.getInitialState(), sentences } },
  });
}

describe('fs-25 — SentenceEmotionControl', () => {
  it('renders a discoverable trigger and dispatches a chosen emotion to the store', () => {
    const store = makeStore([{ id: 2, chapterId: 1, characterId: 'sophie', text: 'Stop.' }]);
    render(
      <Provider store={store}>
        <SentenceEmotionControl chapterId={1} sentenceId={2} />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('emotion-chip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Angry' }));
    expect(store.getState().manuscript.sentences[0].emotion).toBe('angry');
  });

  it('shows the current emotion and clears it via Neutral', () => {
    const store = makeStore([
      { id: 2, chapterId: 1, characterId: 'sophie', text: 'Stop.', emotion: 'angry' },
    ]);
    render(
      <Provider store={store}>
        <SentenceEmotionControl chapterId={1} sentenceId={2} emotion="angry" />
      </Provider>,
    );
    // current emotion is surfaced on the trigger label.
    expect(screen.getByTestId('emotion-chip').getAttribute('aria-label')).toMatch(/angry/i);
    fireEvent.click(screen.getByTestId('emotion-chip'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Neutral' }));
    expect(store.getState().manuscript.sentences[0].emotion).toBeUndefined();
  });
});
