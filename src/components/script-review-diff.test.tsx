import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { uiSlice } from '../store/ui-slice';
import { manuscriptSlice } from '../store/manuscript-slice';
import { scriptReviewSlice, scriptReviewActions, opKey } from '../store/script-review-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { ScriptReviewDiff } from './script-review-diff';

function makeStore() {
  const store = configureStore({
    reducer: {
      ui: uiSlice.reducer,
      manuscript: manuscriptSlice.reducer,
      scriptReview: scriptReviewSlice.reducer,
      changeLog: changeLogSlice.reducer,
    },
    preloadedState: {
      ui: {
        ...uiSlice.getInitialState(),
        stage: {
          kind: 'ready',
          bookId: 'book-A',
          view: 'manuscript',
          currentChapterId: 1,
          openProfileId: null,
        } as never,
      },
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        sentences: [
          { id: 1, chapterId: 1, text: '<em>Hello world</em>', characterId: 'narr' },
          { id: 2, chapterId: 1, text: 'She laughed.', characterId: 'narr' },
        ] as never,
      },
    },
  });

  // Seed the review bucket with two ops: one strip_tag and one fix_emotion
  store.dispatch(
    scriptReviewActions.setReview({
      bookId: 'book-A',
      ops: [
        {
          id: 1,
          op: 'strip_tag',
          newText: 'Hello world',
          rationale: 'remove tag',
          chapterId: 1,
        },
        {
          id: 2,
          op: 'fix_emotion',
          emotion: 'excited',
          rationale: 'energy up',
          chapterId: 1,
        },
      ],
      unappliable: [],
    }),
  );

  return store;
}

describe('fs-58 — ScriptReviewDiff', () => {
  it('returns null when there is no active review', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    const { container } = render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(container.firstChild).toBeNull();
  });

  it('shows an explicit empty state (not a blank body) when there are zero suggestions', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
    });
    /* A review that produced no ops still opens the modal (the bucket exists).
       Before the fix this rendered a blank body; now it must show a clear
       "No suggestions found" empty state. */
    store.dispatch(scriptReviewActions.setReview({ bookId: 'book-A', ops: [], unappliable: [] }));
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.getByText('Script review suggestions')).toBeTruthy();
    expect(screen.getByTestId('script-review-empty')).toBeInTheDocument();
    expect(screen.getByText('No suggestions found')).toBeInTheDocument();
  });

  it('applies selected ops and skips deselected ops on Apply', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    // Verify the modal is rendered with both ops shown
    expect(screen.getByText('Script review suggestions')).toBeTruthy();

    // Toggle op 2 (fix_emotion) OFF by clicking its checkbox
    const op2key = opKey(1, 2, 'fix_emotion');
    const checkbox = screen.getByTestId(`op-toggle-${op2key}`);
    fireEvent.click(checkbox);

    // Verify op2 is now deselected
    expect((checkbox as HTMLInputElement).checked).toBe(false);

    // Click Apply
    fireEvent.click(screen.getByTestId('apply-button'));

    // clearReview should have fired → bucket is gone
    expect(store.getState().scriptReview.byBook['book-A']).toBeUndefined();

    // strip_tag (op 1) WAS selected → sentence id=1 text updated
    const sentences = store.getState().manuscript.sentences;
    const sent1 = sentences.find((s) => s.chapterId === 1 && s.id === 1);
    expect(sent1?.text).toBe('Hello world');

    // fix_emotion (op 2) was DESELECTED → sentence id=2 emotion NOT set to excited
    const sent2 = sentences.find((s) => s.chapterId === 1 && s.id === 2);
    expect(sent2?.emotion).not.toBe('excited');

    // bumpBoundaryMove should have fired (op 1 applied → boundary_move event)
    const events = store.getState().changeLog.events;
    const boundaryEvent = events.find((e) => e.type === 'boundary_move');
    expect(boundaryEvent).toBeTruthy();
    expect(events[0]?.type).toBe('boundary_move');
  });

  it('dismisses all without applying on Dismiss all', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('dismiss-button'));

    // clearReview fired → no bucket
    expect(store.getState().scriptReview.byBook['book-A']).toBeUndefined();

    // No sentence changes applied
    const sentences = store.getState().manuscript.sentences;
    const sent1 = sentences.find((s) => s.chapterId === 1 && s.id === 1);
    expect(sent1?.text).toBe('<em>Hello world</em>');
  });

  it('close button dispatches clearReview', () => {
    const store = makeStore();
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );

    fireEvent.click(screen.getByTestId('close-button'));
    expect(store.getState().scriptReview.byBook['book-A']).toBeUndefined();
  });

  it('renders the unappliable notice when bucket.unappliable is non-empty', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: { ...manuscriptSlice.getInitialState() },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [{ id: 1, op: 'fix_emotion', emotion: 'angry', rationale: 'r', chapterId: 1 }],
        unappliable: [
          {
            op: { id: 99, op: 'strip_tag', anchor: 'x', newText: 'x', rationale: 'r', chapterId: 1 },
            reason: 'anchor not found',
          },
        ],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    const notice = screen.getByTestId('unappliable-notice');
    expect(notice).toBeTruthy();
    expect(notice.textContent).toContain("1 suggestion couldn't be applied");
  });

  it('does not render the unappliable notice when bucket.unappliable is empty', () => {
    const store = makeStore(); // makeStore seeds unappliable: []
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.queryByTestId('unappliable-notice')).toBeNull();
  });

  it('renders a reattribute row (not a silent blank) (fs-58 Unit B)', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [
            { id: 10, chapterId: 1, text: 'She said something.', characterId: 'narr' },
          ] as never,
        },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [
          {
            id: 10,
            op: 'reattribute',
            characterId: 'ferra',
            rationale: 'wrong speaker',
            chapterId: 1,
          },
        ],
        unappliable: [],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.getByText(/ferra/i)).toBeInTheDocument();
  });

  it('renders a flag_nonstory row struck (fs-58 Unit B)', () => {
    const store = configureStore({
      reducer: {
        ui: uiSlice.reducer,
        manuscript: manuscriptSlice.reducer,
        scriptReview: scriptReviewSlice.reducer,
        changeLog: changeLogSlice.reducer,
      },
      preloadedState: {
        ui: {
          ...uiSlice.getInitialState(),
          stage: {
            kind: 'ready',
            bookId: 'book-A',
            view: 'manuscript',
            currentChapterId: 1,
            openProfileId: null,
          } as never,
        },
        manuscript: {
          ...manuscriptSlice.getInitialState(),
          sentences: [
            { id: 42, chapterId: 1, text: 'p. 42', characterId: 'narr' },
          ] as never,
        },
      },
    });
    store.dispatch(
      scriptReviewActions.setReview({
        bookId: 'book-A',
        ops: [
          {
            id: 42,
            op: 'flag_nonstory',
            rationale: 'page number artifact',
            chapterId: 1,
          },
        ],
        unappliable: [],
      }),
    );
    render(
      <Provider store={store}>
        <ScriptReviewDiff bookId="book-A" />
      </Provider>,
    );
    expect(screen.getByText('p. 42')).toHaveClass('line-through');
  });
});
