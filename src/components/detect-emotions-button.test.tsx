import { describe, it, expect, vi, beforeEach } from 'vitest';
import { combineReducers, configureStore } from '@reduxjs/toolkit';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { manuscriptSlice } from '../store/manuscript-slice';
import { uiSlice } from '../store/ui-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { prosodySlice } from '../store/prosody-slice';
import { scriptReviewSlice, scriptReviewActions } from '../store/script-review-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { DetectEmotionsButton } from './detect-emotions-button';

const { detectEmotions, detectInstruct, putBookState } = vi.hoisted(() => ({
  detectEmotions: vi.fn(),
  detectInstruct: vi.fn(),
  putBookState: vi.fn(async () => ({})),
}));
vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return { ...actual, api: { detectEmotions, detectInstruct, putBookState } };
});

function makeStore() {
  const store = configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      ui: uiSlice.reducer,
      chapters: chaptersSlice.reducer,
      prosody: prosodySlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        bookId: 'b1',
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
  putBookState.mockClear();
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

    // the primary click alone now starts the (per-chapter) run
    fireEvent.click(screen.getByTestId('detect-emotions-button'));

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

  describe('#3435 — a run only lands in its own book', () => {
    /* The run outlives the book on screen. A root reducer wrapper stands in for
       the layout's navigation: it swaps the stage and the manuscript slice to
       book Y (the persistence middleware saves that slice into the book the
       stage names, so a write into it is a write into Y's files). */
    function makeSwitchableStore() {
      const combined = combineReducers({
        manuscript: manuscriptSlice.reducer,
        ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer,
        prosody: prosodySlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        notifications: notificationsSlice.reducer,
      });
      const yState = {
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          bookId: 'bY',
          manuscriptId: 'mY',
          sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'Y line' } as never],
        },
        stage: { kind: 'ready', bookId: 'bY', view: 'manuscript', currentChapterId: 1 } as never,
      };
      const rootReducer = (state: ReturnType<typeof combined> | undefined, action: any) => {
        if (action.type === 'test/switchToY') {
          const base = combined(state, { type: 'noop' });
          return { ...base, manuscript: yState.manuscript, ui: { ...base.ui, stage: yState.stage } };
        }
        return combined(state, action);
      };
      return configureStore({
        reducer: rootReducer as never,
        preloadedState: {
          manuscript: {
            ...manuscriptSlice.getInitialState(),
            bookId: 'bX',
            manuscriptId: 'mX',
            sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'X line' } as never],
          },
          ui: {
            ...uiSlice.getInitialState(),
            stage: { kind: 'ready', bookId: 'bX', view: 'manuscript', currentChapterId: 1 } as never,
          },
        } as never,
      }) as unknown as ReturnType<typeof makeStore>;
    }

    function deferredRun() {
      let resolveEmotions!: () => void;
      detectEmotions.mockImplementation((_id: string, opts?: any) => {
        if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
        return new Promise((resolve) => {
          resolveEmotions = () => {
            opts.onAnnotation({ chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'angry' }] });
            resolve({ annotatedChapters: 1, totalAnnotations: 1 });
          };
        });
      });
      detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
      return () => resolveEmotions();
    }

    it('drops annotations that resolve after the user moved to another book', async () => {
      const resolve = deferredRun();
      const store = makeSwitchableStore();
      render(<Provider store={store}><DetectEmotionsButton /></Provider>);
      fireEvent.click(screen.getByTestId('detect-emotions-button'));
      await waitFor(() => expect(detectEmotions).toHaveBeenCalled());

      store.dispatch({ type: 'test/switchToY' });
      resolve();

      await waitFor(() => expect(store.getState().prosody.activeStreams['bX']).toBeUndefined());
      expect(store.getState().manuscript.sentences[0].emotion).toBeUndefined();
      expect(store.getState().manuscript.sentences[0].text).toBe('Y line');
    });

    it('a run that skipped lines leaves its book un-marked, so it is re-run when next opened, and says so in a toast', async () => {
      const resolve = deferredRun();
      const store = makeSwitchableStore();
      const { unmount } = render(<Provider store={store}><DetectEmotionsButton /></Provider>);
      fireEvent.click(screen.getByTestId('detect-emotions-button'));
      await waitFor(() => expect(detectEmotions).toHaveBeenCalled());

      /* The user leaves the book: the Manuscript view (and this button) unmounts. */
      store.dispatch({ type: 'test/switchToY' });
      unmount();
      resolve();

      await waitFor(() => expect(store.getState().prosody.activeStreams['bX']).toBeUndefined());
      expect(putBookState).toHaveBeenCalledWith('bX', { slice: 'state', patch: { prosodyAnnotated: false } });
      expect(putBookState).not.toHaveBeenCalledWith('bY', expect.anything());
      const toasts = (store.getState() as unknown as { notifications: { toasts: Array<{ message: string }> } })
        .notifications.toasts;
      expect(toasts.map((t) => t.message).join(' ')).toMatch(/not saved/i);
    });

    it("does not run while the slices still hold another book (the stage's book has not loaded)", async () => {
      detectEmotions.mockImplementation((_id: string, opts?: any) => {
        if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
        opts.onAnnotation({ chapterId: 1, annotations: [{ sentenceId: 1, emotion: 'angry' }] });
        return Promise.resolve({ annotatedChapters: 1, totalAnnotations: 1 });
      });
      detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
      /* The stage names bX; bX's read is slow, so the Manuscript view shows
         book B's sentences. A click must not bind to B. */
      const store = configureStore({
        reducer: {
          manuscript: manuscriptSlice.reducer, ui: uiSlice.reducer,
          chapters: chaptersSlice.reducer, prosody: prosodySlice.reducer,
          scriptReview: scriptReviewSlice.reducer,
        },
        preloadedState: {
          manuscript: {
            ...manuscriptSlice.getInitialState(),
            bookId: 'bB',
            manuscriptId: 'mB',
            sentences: [{ id: 1, chapterId: 1, characterId: 'wren', text: 'B line' } as never],
          },
          ui: { ...uiSlice.getInitialState(), stage: { kind: 'ready', bookId: 'bX', view: 'manuscript', currentChapterId: 1 } as never },
        },
      });
      render(<Provider store={store}><DetectEmotionsButton /></Provider>);

      expect(screen.getByTestId('detect-emotions-button')).toBeDisabled();
      expect(screen.getByTestId('detect-emotions-menu-toggle')).toBeDisabled();
      fireEvent.click(screen.getByTestId('detect-emotions-button'));
      await new Promise((r) => setTimeout(r, 20));
      expect(detectEmotions).not.toHaveBeenCalled();
      expect(store.getState().manuscript.sentences[0].emotion).toBeUndefined();
    });

    it('the whole-book confirm does not run if the slices moved to another book while it was open', async () => {
      detectEmotions.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
      detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
      const store = makeSwitchableStore();
      render(<Provider store={store}><DetectEmotionsButton /></Provider>);
      fireEvent.click(screen.getByTestId('detect-emotions-menu-toggle'));
      fireEvent.click(screen.getByTestId('detect-emotions-wholebook'));
      /* Y's slices land while the stage still names X (a stand-in for the
         read of another book landing under the open popover). */
      store.dispatch(manuscriptSlice.actions.hydrateFromBookState({
        state: { bookId: 'bY', manuscriptId: 'mY', title: 'Y' } as never,
        sentences: null,
      }));
      fireEvent.click(screen.getByTestId('detect-emotions-confirm'));
      await new Promise((r) => setTimeout(r, 20));
      expect(detectEmotions).not.toHaveBeenCalled();
    });

    it('control: a run that skipped nothing does not touch the watermark or toast', async () => {
      const resolve = deferredRun();
      const store = makeSwitchableStore();
      render(<Provider store={store}><DetectEmotionsButton /></Provider>);
      fireEvent.click(screen.getByTestId('detect-emotions-button'));
      await waitFor(() => expect(detectEmotions).toHaveBeenCalled());
      resolve();

      await waitFor(() => expect(store.getState().manuscript.sentences[0].emotion).toBe('angry'));
      await waitFor(() => expect(store.getState().prosody.activeStreams['bX']).toBeUndefined());
      expect(putBookState).not.toHaveBeenCalled();
      const toasts = (store.getState() as unknown as { notifications: { toasts: unknown[] } }).notifications.toasts;
      expect(toasts).toEqual([]);
    });

    it('control: staying on the book applies the annotations', async () => {
      const resolve = deferredRun();
      const store = makeSwitchableStore();
      render(<Provider store={store}><DetectEmotionsButton /></Provider>);
      fireEvent.click(screen.getByTestId('detect-emotions-button'));
      await waitFor(() => expect(detectEmotions).toHaveBeenCalled());

      resolve();

      await waitFor(() => expect(store.getState().manuscript.sentences[0].emotion).toBe('angry'));
    });
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

    fireEvent.click(screen.getByTestId('detect-emotions-menu-toggle'));
    fireEvent.click(screen.getByTestId('detect-emotions-wholebook'));
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

    // Progress bar should appear; click Cancel
    await waitFor(() => screen.getByTestId('detect-emotions-progress'));
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));

    await waitFor(() => expect(emoteAborted).toBe(true));
    // The component returns to idle after the AbortError is caught
    await waitFor(() => screen.getByTestId('detect-emotions-button'));
    // Pass 2 must NOT run once pass 1 aborts — locks the sequential short-circuit.
    expect(detectInstruct).not.toHaveBeenCalled();
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

  it('disables Detect emotions while a review runs on the same book', () => {
    const store = makeStore(); // ui.stage.bookId === 'b1'
    store.dispatch(scriptReviewActions.setActive({ bookId: 'b1', progress: 0.05, label: 'Reviewing' }));
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );
    expect(screen.getByTestId('detect-emotions-button')).toBeDisabled();
  });

  it('clears the prosody stream in finally even when a pass throws', async () => {
    let streamWhileRunning: unknown;
    detectEmotions.mockImplementation((_id: string, opts?: any) => {
      /* tinyspy may probe with no args; the real call always passes opts. */
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      streamWhileRunning = store.getState().prosody.activeStreams['b1']; // setActive ran before the thunk awaited the API
      return Promise.reject(new Error('boom'));
    });
    detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 }); // safe if the thunk continues to pass 2
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('detect-emotions-button'));
    // cleared in finally despite the throw:
    await waitFor(() => expect(store.getState().prosody.activeStreams['b1']).toBeUndefined());
    // and it was set while running:
    expect(streamWhileRunning).toMatchObject({ label: 'Detecting emotions' });
  });

  it('renders chapter count + the two-pass-reconciled ETA once onProgress supplies detail', async () => {
    /* The button runs the REAL runProsodyPasses (Task 9) — only api.detectEmotions/
       detectInstruct are mocked here. Task 9's reconciliation combines pass 1's own
       estRemainingMs with a projection of pass 2's full duration while pass 1 is
       still running: combined = own-remaining + (elapsed-so-far + own-remaining).
       With own-remaining = 125_000ms and elapsed-so-far ~0 (synchronous mock call),
       combined ≈ 250_000ms → "~4m left", NOT the raw 125_000ms/"~2m left" a
       single-pass reading would suggest. */
    detectEmotions.mockImplementation((_bookId: string, opts?: any) => {
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      opts.onPhase({ progress: 0.25, chapterIndex: 3, totalChapters: 12, estRemainingMs: 125_000 });
      return new Promise(() => {}); // stays running so the chip is on screen to assert on
    });
    detectInstruct.mockResolvedValue({ annotatedChapters: 0, totalAnnotations: 0 });
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-button'));

    await waitFor(() =>
      expect(screen.getByTestId('detect-emotions-progress-detail').textContent).toBe(
        'Chapter 3 of 12 · ~4m left',
      ),
    );
    // The Redux entry (feeding the Status-popover) picks up the same reconciled fields.
    // Compare with a tolerance rather than exact equality — real (non-fake) elapsed
    // time contributes a few ms of jitter on top of the 250_000ms base, which the
    // rounded-to-minutes display text absorbs but a byte-exact ms check would not.
    const entry = store.getState().prosody.activeStreams['b1'];
    expect(entry).toMatchObject({ chapterIndex: 3, totalChapters: 12 });
    expect(entry?.estRemainingMs).toBeGreaterThanOrEqual(250_000);
    expect(entry?.estRemainingMs).toBeLessThan(251_000);
  });

  it('primary runs the current chapter only (forwards its chapterId to both passes)', async () => {
    const chapterIds: Array<number | undefined> = [];
    detectEmotions.mockImplementation((_id: string, opts?: any) => {
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      chapterIds.push(opts.chapterId);
      return Promise.resolve({ annotatedChapters: 1, totalAnnotations: 1 });
    });
    detectInstruct.mockImplementation((_id: string, opts?: any) => {
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      chapterIds.push(opts.chapterId);
      return Promise.resolve({ annotatedChapters: 1, totalAnnotations: 1 });
    });
    const store = makeStore(); // ui.stage.currentChapterId === 1, one sentence in ch1
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-button'));
    await waitFor(() => expect(screen.getByTestId('detect-emotions-done')).toBeTruthy());
    expect(chapterIds).toEqual([1, 1]);
    expect(screen.getByTestId('detect-emotions-done').textContent).toMatch(/in this chapter/i);
  });

  it('whole book (via the menu) runs with no chapterId', async () => {
    const chapterIds: Array<number | undefined> = [];
    detectEmotions.mockImplementation((_id: string, opts?: any) => {
      if (!opts) return Promise.resolve({ annotatedChapters: 0, totalAnnotations: 0 });
      chapterIds.push(opts.chapterId);
      return Promise.resolve({ annotatedChapters: 2, totalAnnotations: 2 });
    });
    detectInstruct.mockResolvedValue({ annotatedChapters: 2, totalAnnotations: 0 });
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-menu-toggle'));
    fireEvent.click(screen.getByTestId('detect-emotions-wholebook'));
    fireEvent.click(screen.getByTestId('detect-emotions-confirm'));
    await waitFor(() => expect(screen.getByTestId('detect-emotions-done')).toBeTruthy());
    expect(chapterIds[0]).toBeUndefined();
  });

  it('primary is disabled when the current chapter has no sentences', () => {
    const store = configureStore({
      reducer: {
        manuscript: manuscriptSlice.reducer, ui: uiSlice.reducer,
        chapters: chaptersSlice.reducer, prosody: prosodySlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
      },
      preloadedState: {
        manuscript: { ...manuscriptSlice.getInitialState(), bookId: 'b1', sentences: [
          { id: 1, chapterId: 1, characterId: 'wren', text: 'Get down!' } as never,
        ] },
        // current chapter 2 has NO sentences
        ui: { ...uiSlice.getInitialState(), stage: { kind: 'ready', bookId: 'b1', view: 'manuscript', currentChapterId: 2 } as never },
      },
    });
    render(<Provider store={store}><DetectEmotionsButton /></Provider>);
    expect((screen.getByTestId('detect-emotions-button') as HTMLButtonElement).disabled).toBe(true);
  });

  it('dismisses the ⌄ menu on Escape', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-menu-toggle'));
    expect(screen.getByTestId('detect-emotions-wholebook')).toBeInTheDocument();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('detect-emotions-wholebook')).toBeNull();
  });

  it('dismisses the ⌄ menu on an outside click', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <DetectEmotionsButton />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('detect-emotions-menu-toggle'));
    expect(screen.getByTestId('detect-emotions-wholebook')).toBeInTheDocument();

    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('detect-emotions-wholebook')).toBeNull();
  });
});
