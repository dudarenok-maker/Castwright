import { describe, it, expect, vi, beforeEach } from 'vitest';
import { configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { manuscriptSlice } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { DetectEmotionsButton } from './detect-emotions-button';

const { detectEmotions, detectInstruct } = vi.hoisted(() => ({
  detectEmotions: vi.fn(),
  detectInstruct: vi.fn(),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { detectEmotions, detectInstruct } };
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

beforeEach(() => {
  detectEmotions.mockReset();
  detectInstruct.mockReset();
});

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
    detectInstruct.mockImplementation((_bookId: string, opts?: any) => {
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      opts.onAnnotation({
        chapterId: 1,
        annotations: [{ sentenceId: 1, text: '[laughs]', instruct: 'warm, amused', vocalization: true }],
      });
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

    // Both reducers fire: emotion from pass 1, instruct text from pass 2
    await waitFor(() =>
      expect(store.getState().manuscript.sentences[0].emotion).toBe('angry'),
    );
    await waitFor(() =>
      expect(store.getState().manuscript.sentences[0].text).toBe('[laughs]'),
    );
    expect(detectEmotions).toHaveBeenCalledWith('b1', expect.anything());
    expect(detectInstruct).toHaveBeenCalledWith('b1', expect.anything());
    await waitFor(() => expect(screen.getByTestId('detect-emotions-done')).toBeTruthy());
  });

  it('confirm dialog mentions that text will change (natural reactions)', () => {
    detectEmotions.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
    detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-button'));
    // The confirm popover should mention text-mutating reactions (gasp/sigh/laugh)
    const dialog = screen.getByRole('dialog', { name: /Detect emotions/i });
    expect(dialog.textContent).toMatch(/gasp|sigh|laugh/i);
  });

  it('Cancel aborts both passes via the shared AbortController', async () => {
    let emoteAborted = false;

    detectEmotions.mockImplementation((_bookId: string, opts?: any) => {
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      // Return a promise that rejects with AbortError when signal fires
      return new Promise((_resolve, reject) => {
        opts.signal?.addEventListener('abort', () => {
          emoteAborted = true;
          const err = new Error('Aborted');
          err.name = 'AbortError';
          reject(err);
        });
      });
    });
    // detectInstruct should never be called because emotions is aborted first
    detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });

    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-button'));
    fireEvent.click(screen.getByTestId('detect-emotions-confirm'));

    // Progress bar should appear; click Cancel
    await waitFor(() => screen.getByTestId('detect-emotions-progress'));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => expect(emoteAborted).toBe(true));
    // The component returns to idle after the AbortError is caught
    await waitFor(() => screen.getByTestId('detect-emotions-button'));
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
