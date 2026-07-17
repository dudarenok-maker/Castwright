import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { BulkReassignUndoBanner } from './bulk-reassign-undo-banner';
import { manuscriptSlice } from '../store/manuscript-slice';
import { changeLogSlice } from '../store/change-log-slice';
import { uiSlice } from '../store/ui-slice';

/* `inBook` controls whether the ui.stage carries a bookId — the same source
   persistence-middleware uses to decide whether a write can flush. `true`
   preloads a 'ready' stage (an in-book stage); `false` preloads the
   book-less 'books' (library) stage. */
function makeStore(withSlot: boolean, inBook: boolean) {
  return configureStore({
    reducer: {
      manuscript: manuscriptSlice.reducer,
      changeLog: changeLogSlice.reducer,
      ui: uiSlice.reducer,
    },
    preloadedState: {
      manuscript: {
        ...manuscriptSlice.getInitialState(),
        sentences: [{ chapterId: 1, id: 1, text: 'x', characterId: 'narrator' }] as never,
        lastBulkReassign: withSlot
          ? { moves: [{ chapterId: 1, sentenceId: 1, prevCharacterId: 'egor' }], targetLabel: 'Narrator' }
          : null,
      },
      ui: {
        ...uiSlice.getInitialState(),
        stage: inBook
          ? { kind: 'ready' as const, bookId: 'book-1', view: 'cast' as const, currentChapterId: 3, openProfileId: null }
          : { kind: 'books' as const },
      },
    },
  });
}

describe('BulkReassignUndoBanner', () => {
  it('renders nothing when the slot is empty', () => {
    const store = makeStore(false, true);
    const { container } = render(<Provider store={store}><BulkReassignUndoBanner /></Provider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when the slot is set but no book is in scope (library stage)', () => {
    // Regression for the #1676(c) review blocker: navigating from a book
    // back to the library does NOT clear lastBulkReassign, and Undo would
    // silently revert redux without persistence-middleware being able to
    // flush (it short-circuits with no bookId) — this must stay hidden.
    const store = makeStore(true, false);
    const { container } = render(<Provider store={store}><BulkReassignUndoBanner /></Provider>);
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the count + target and reverts on Undo, appending a revert event', () => {
    const store = makeStore(true, true);
    render(<Provider store={store}><BulkReassignUndoBanner /></Provider>);
    expect(screen.getByText(/1 line.*Narrator/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /undo/i }));
    const s = store.getState();
    expect(s.manuscript.sentences[0].characterId).toBe('egor');
    expect(s.manuscript.lastBulkReassign).toBeNull();
    expect(s.changeLog.events.some((e) => /revert/i.test(e.note ?? ''))).toBe(true);
    const revertEvent = s.changeLog.events.find((e) => /revert/i.test(e.note ?? ''));
    expect(revertEvent?.title).toBe('Reverted bulk line reassignment');
    expect(revertEvent?.title).not.toMatch(/-1/);
    expect(revertEvent?.title).not.toMatch(/Chapter/);
  });
});
