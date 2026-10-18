/* Plan 55 — revision history modal coverage.
   Pairs with docs/features/archive/55-revision-history-timeline.md. */

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { revisionsSlice, revisionsActions } from '../store/revisions-slice';
import { uiSlice, uiActions } from '../store/ui-slice';
import { RevisionTimelineModal } from './revision-timeline-modal';
import type { Character, TimelineEntry } from '../lib/types';

function makeStore(timeline: Record<number, TimelineEntry[]>, cacheBook = 'b1', activeBook = 'b1') {
  const store = configureStore({ reducer: { revisions: revisionsSlice.reducer, ui: uiSlice.reducer } });
  store.dispatch(uiActions.openBook({ id: activeBook, status: 'complete' } as never));
  store.dispatch(revisionsActions.applyServerState({ bookId: cacheBook, fileId: '000000000000001-a', rev: 1, pending: [], dismissed: [], acceptedSelections: {}, timeline }));
  return store;
}

const halloran: Character = {
  id: 'halloran',
  name: 'Halloran',
  role: 'character',
  color: 'narrator',
};

describe('RevisionTimelineModal — plan 55', () => {
  it('renders the empty state when the chapter has no entries', () => {
    const store = makeStore({});
    render(
      <Provider store={store}>
        <RevisionTimelineModal
          chapterId={1}
          chapterTitle="Solway Bay"
          characters={[halloran]}
          onClose={() => undefined}
        />
      </Provider>,
    );
    expect(screen.getByTestId('revision-timeline-empty')).toBeInTheDocument();
  });

  it('renders entries reverse-chronologically (newest first)', () => {
    const store = makeStore({
      1: [
        {
          id: 'r-old',
          chapterId: 1,
          characterId: 'halloran',
          eventKind: 'accepted',
          timestamp: '2026-05-18T10:00:00.000Z',
          status: 'active',
        },
        {
          id: 'r-new',
          chapterId: 1,
          characterId: 'halloran',
          eventKind: 'rejected',
          timestamp: '2026-05-19T10:00:00.000Z',
          status: 'active',
        },
      ],
    });
    render(
      <Provider store={store}>
        <RevisionTimelineModal
          chapterId={1}
          chapterTitle="Solway Bay"
          characters={[halloran]}
          onClose={() => undefined}
        />
      </Provider>,
    );
    const list = screen.getByTestId('revision-timeline-list');
    const entries = list.querySelectorAll('[data-testid^="revision-timeline-entry-"]');
    expect(entries).toHaveLength(2);
    // First rendered entry = newest = r-new.
    expect(entries[0]).toHaveAttribute('data-testid', 'revision-timeline-entry-r-new');
    expect(entries[1]).toHaveAttribute('data-testid', 'revision-timeline-entry-r-old');
  });

  it('renders the character name when characterId is present', () => {
    const store = makeStore({
      1: [
        {
          id: 'r1',
          chapterId: 1,
          characterId: 'halloran',
          eventKind: 'accepted',
          timestamp: '2026-05-19T10:00:00.000Z',
          status: 'active',
        },
      ],
    });
    render(
      <Provider store={store}>
        <RevisionTimelineModal
          chapterId={1}
          chapterTitle="Solway Bay"
          characters={[halloran]}
          onClose={() => undefined}
        />
      </Provider>,
    );
    expect(screen.getByText(/Halloran/)).toBeInTheDocument();
    expect(screen.getByText(/Accepted revision/)).toBeInTheDocument();
  });

  it('cross-chapter view (chapterId=null) flattens entries from all chapters', () => {
    const store = makeStore({
      1: [
        {
          id: 'r1',
          chapterId: 1,
          eventKind: 'accepted',
          timestamp: '2026-05-19T10:00:00.000Z',
          status: 'active',
        },
      ],
      2: [
        {
          id: 'r2',
          chapterId: 2,
          eventKind: 'rejected',
          timestamp: '2026-05-19T11:00:00.000Z',
          status: 'active',
        },
      ],
    });
    render(
      <Provider store={store}>
        <RevisionTimelineModal
          chapterId={null}
          characters={[halloran]}
          onClose={() => undefined}
        />
      </Provider>,
    );
    const list = screen.getByTestId('revision-timeline-list');
    expect(list.querySelectorAll('[data-testid^="revision-timeline-entry-"]')).toHaveLength(2);
    expect(screen.getByText(/chapter 1/)).toBeInTheDocument();
    expect(screen.getByText(/chapter 2/)).toBeInTheDocument();
  });

  it('rolled-back-from entries render with the stale affordance', () => {
    const store = makeStore({
      1: [
        {
          id: 'r1',
          chapterId: 1,
          eventKind: 'accepted',
          timestamp: '2026-05-19T10:00:00.000Z',
          status: 'rolled-back-from',
        },
        {
          id: 'rb-1',
          chapterId: 1,
          eventKind: 'rolled-back',
          timestamp: '2026-05-19T11:00:00.000Z',
          status: 'active',
        },
      ],
    });
    render(
      <Provider store={store}>
        <RevisionTimelineModal
          chapterId={1}
          characters={[halloran]}
          onClose={() => undefined}
        />
      </Provider>,
    );
    const stale = screen.getByTestId('revision-timeline-entry-r1');
    expect(stale.className).toMatch(/line-through/);
  });

  it('clicking the close button invokes onClose', () => {
    const onClose = vi.fn();
    const store = makeStore({});
    render(
      <Provider store={store}>
        <RevisionTimelineModal
          chapterId={1}
          characters={[halloran]}
          onClose={onClose}
        />
      </Provider>,
    );
    fireEvent.click(screen.getByTestId('revision-timeline-close'));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('plan 286 — shows the empty state for a cached book that is not the active book', () => {
    const store = makeStore({ 3: [{ id: 't', chapterId: 3, eventKind: 'accepted', timestamp: '2026-01-01T00:00:00Z', status: 'active' }] }, 'X', 'Y');
    render(
      <Provider store={store}>
        <RevisionTimelineModal chapterId={null} chapterTitle={undefined} characters={[halloran]} onClose={() => undefined} />
      </Provider>,
    );
    expect(screen.getByTestId('revision-timeline-empty')).toBeInTheDocument();
  });
});
