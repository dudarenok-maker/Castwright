import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { manuscriptSlice } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { DetectEmotionsButton } from './detect-emotions-button';

const { detectEmotions } = vi.hoisted(() => ({ detectEmotions: vi.fn() }));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { detectEmotions } };
});

function makeStore() {
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        sentences: [
          { id: 1, chapterId: 1, characterId: 'wren', text: 'Get down!' } as never,
        ],
      },
      ui: {
        ...uiSlice.getInitialState(),
        stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId: 1 } as never,
      },
    },
  });
  return store;
}

beforeEach(() => detectEmotions.mockReset());

describe('fs-33 — DetectEmotionsButton', () => {
  it('confirms, runs the pass, and applies streamed annotations to the manuscript store', async () => {
    detectEmotions.mockImplementation((_bookId: string, opts?: any) => {
      /* tinyspy occasionally probes the implementation with no args; the real
         call from the component always passes the opts object. */
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      opts.onPhase({ progress: 0.5, label: 'ch1' });
      opts.onAnnotation({ chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'angry' }] });
      return Promise.resolve({ annotatedChapters: 1, totalAnnotations: 1 });
    });
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    // open the confirm popover, then confirm
    fireEvent.click(screen.getByTestId('detect-emotions-button'));
    fireEvent.click(screen.getByTestId('detect-emotions-confirm'));

    await waitFor(() =>
      expect(store.getState().manuscript.sentences[0].emotion).toBe('angry'),
    );
    expect(detectEmotions).toHaveBeenCalledWith('b1', expect.anything());
    await waitFor(() => expect(screen.getByTestId('detect-emotions-done')).toBeTruthy());
  });

  it('is disabled when there are no attributed sentences', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton disabled />
      </Provider>,
    );
    expect((screen.getByTestId('detect-emotions-button') as HTMLButtonElement).disabled).toBe(true);
  });
});
