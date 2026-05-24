/* Plan 102 — QueueModal RTL tests. Asserts:
 *   - opens/closes via ui-slice state
 *   - renders entries grouped by book with book-title resolution
 *   - in-flight entry has no reorder/cancel buttons (pinned + non-droppable)
 *   - Move-up / Move-down buttons dispatch reorder thunk with correct order
 *   - Cancel button dispatches cancel thunk
 *   - Pause toggle dispatches setPaused thunk with the inverted flag
 *   - On open, loadQueue() is dispatched (cross-tab freshness) */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { QueueModal } from './queue-modal';
import { queueSlice, type QueueEntry } from '../store/queue-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { librarySlice } from '../store/library-slice';
import { accountSlice } from '../store/account-slice';
import type { LibraryBook } from '../lib/types';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'e1',
  bookId: 'book-A',
  chapterId: 1,
  scope: 'this',
  addedAt: '2026-05-23T00:00:00.000Z',
  status: 'queued',
  order: 0,
  ...overrides,
});

const libraryBook = (bookId: string, title: string): LibraryBook => ({
  bookId,
  title,
  author: 'Test Author',
  status: 'complete',
  thumbnail: null,
  manuscriptId: 'm_test',
  chapters: [],
  characters: [],
  updatedAt: '2026-05-23T00:00:00.000Z',
  series: 'Standalones',
  audioFormat: 'mp3',
} as unknown as LibraryBook);

function renderModal(
  entries: QueueEntry[],
  opts: { paused?: boolean; books?: LibraryBook[]; dualModelEnabled?: boolean } = {},
) {
  const store = configureStore({
    reducer: {
      queue: queueSlice.reducer,
      notifications: notificationsSlice.reducer,
      library: librarySlice.reducer,
      account: accountSlice.reducer,
    },
    preloadedState: {
      queue: { entries, paused: opts.paused ?? false, loaded: true },
      library: {
        books: opts.books ?? [],
        pausedSnapshots: {},
      } as ReturnType<typeof librarySlice.reducer>,
      account: {
        ...accountSlice.getInitialState(),
        dualModelEnabled: opts.dualModelEnabled ?? false,
      },
    },
  });
  /* loadQueue thunk fires on open — return an empty snapshot so the re-fetch
     doesn't blow away the preloaded state. */
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: () => Promise.resolve({ entries, paused: opts.paused ?? false }),
  });
  const onClose = vi.fn();
  return {
    store,
    onClose,
    ...render(
      <Provider store={store}>
        <QueueModal open={true} onClose={onClose} />
      </Provider>,
    ),
  };
}

describe('QueueModal', () => {
  it('renders the empty state when no entries are queued', () => {
    renderModal([]);
    expect(screen.getByText('Empty')).toBeInTheDocument();
    expect(screen.getByText(/No chapters queued/)).toBeInTheDocument();
  });

  it('renders entries grouped by book with the book title from library', () => {
    renderModal(
      [
        entry({ id: 'a1', bookId: 'book-A', chapterId: 1, order: 0 }),
        entry({ id: 'b1', bookId: 'book-B', chapterId: 5, order: 1 }),
      ],
      { books: [libraryBook('book-A', 'Book Alpha'), libraryBook('book-B', 'Book Beta')] },
    );
    expect(screen.getByText('Book Alpha')).toBeInTheDocument();
    expect(screen.getByText('Book Beta')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a1')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-b1')).toBeInTheDocument();
  });

  it('falls back to bookId when the library doesn\'t know the book', () => {
    renderModal([entry({ id: 'a1', bookId: 'unknown-book' })]);
    expect(screen.getByText('unknown-book')).toBeInTheDocument();
  });

  it('shows "n entries pending" with plural agreement in the header', () => {
    renderModal([entry({ id: 'a1' })]);
    expect(screen.getByText('1 entry pending')).toBeInTheDocument();
  });

  it('pluralizes correctly when count > 1', () => {
    renderModal([
      entry({ id: 'a1', order: 0 }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
    ]);
    expect(screen.getByText('2 entries pending')).toBeInTheDocument();
  });

  it('marks the in-flight entry visually + hides its reorder/cancel buttons', () => {
    renderModal([
      entry({ id: 'a1', status: 'in_progress', order: 0, progress: 0.42 }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
    ]);
    /* In-flight entry has no move/cancel buttons. */
    expect(screen.queryByTestId('queue-entry-a1-up')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a1-down')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a1-cancel')).toBeNull();
    /* The other entry has them. */
    expect(screen.getByTestId('queue-entry-a2-up')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a2-down')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a2-cancel')).toBeInTheDocument();
    /* In-flight status line shows progress. */
    expect(screen.getByText(/In flight · 42%/)).toBeInTheDocument();
  });

  it('Move-down dispatches reorder thunk excluding the in-flight pinned entry', async () => {
    renderModal([
      entry({ id: 'a1', status: 'in_progress', order: 0 }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
      entry({ id: 'a3', chapterId: 3, order: 2 }),
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-entry-a2-down'));
    });
    const reorderCall = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/reorder');
    expect(reorderCall).toBeDefined();
    /* In-flight a1 is excluded from the order array; a3 moves before a2. */
    expect(reorderCall![1].body).toContain('"order":["a3","a2"]');
  });

  it('Cancel dispatches the cancel thunk', async () => {
    renderModal([
      entry({ id: 'a1', status: 'in_progress' }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-entry-a2-cancel'));
    });
    const cancelCall = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/a2');
    expect(cancelCall).toBeDefined();
    expect(cancelCall![1].method).toBe('DELETE');
  });

  it('Pause toggle flips paused via /api/queue/pause', async () => {
    renderModal([entry({ id: 'a1' })]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [entry({ id: 'a1' })], paused: true }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-modal-pause'));
    });
    const pauseCall = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/pause');
    expect(pauseCall).toBeDefined();
    expect(pauseCall![1].body).toBe('{"paused":true}');
  });

  it('shows Resume button when paused', () => {
    renderModal([entry({ id: 'a1' })], { paused: true });
    expect(screen.getByText('Resume')).toBeInTheDocument();
  });

  it('closes via the backdrop click', () => {
    const { onClose } = renderModal([entry({ id: 'a1' })]);
    fireEvent.click(screen.getByTestId('queue-modal-backdrop'));
    expect(onClose).toHaveBeenCalled();
  });

  it('drag-to-reorder dispatches reorder thunk with the new global order (BACKLOG Could #40)', async () => {
    renderModal([
      entry({ id: 'a1', chapterId: 1, order: 0 }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
      entry({ id: 'a3', chapterId: 3, order: 2 }),
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });

    const handle = screen.getByTestId('queue-entry-a1-drag');
    const targetRow = screen.getByTestId('queue-entry-a3');

    /* jsdom's elementFromPoint returns null; stub it to return the row
       we want the pointer to be "over" during the pointermove. */
    const originalEFP = document.elementFromPoint;
    document.elementFromPoint = (): Element => targetRow;

    /* Separate act blocks so React commits between events — the
       window-level pointermove listener is registered by a useEffect
       that runs AFTER pointerdown's setDrag commit. */
    await act(async () => {
      fireEvent.pointerDown(handle, { clientX: 0, clientY: 0, pointerId: 1 });
    });
    await act(async () => {
      /* jsdom doesn't ship PointerEvent — fake it with a plain Event +
         the two properties our handler reads (clientX/Y). */
      const moveEv = new Event('pointermove') as Event & { clientX: number; clientY: number };
      moveEv.clientX = 100;
      moveEv.clientY = 100;
      window.dispatchEvent(moveEv);
    });
    await act(async () => {
      window.dispatchEvent(new Event('pointerup'));
    });

    document.elementFromPoint = originalEFP;

    const reorderCall = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/reorder');
    expect(reorderCall).toBeDefined();
    /* a1 was dragged to a3's slot — within Book A the new order is
       a2, a3, a1 (a1 spliced into a3's index, which was 2). */
    expect(reorderCall![1].body).toContain('"order":["a2","a3","a1"]');
  });

  it('drag handle is absent on the in-flight pinned row (no drop target either)', () => {
    renderModal([
      entry({ id: 'a1', status: 'in_progress', order: 0 }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
    ]);
    /* a1 (in-flight) has no drag handle; a2 (queued) does. */
    expect(screen.queryByTestId('queue-entry-a1-drag')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a2-drag')).toBeInTheDocument();
  });

  it('renders a single-engine badge naming the engine (plan 108 Wave 3)', () => {
    renderModal([entry({ id: 'a1', requiredEngines: ['kokoro'], multiTts: false })]);
    const badge = screen.getByTestId('queue-entry-a1-engines');
    expect(badge).toHaveTextContent('Kokoro');
    expect(screen.queryByTestId('queue-entry-a1-dual-model-warning')).toBeNull();
  });

  it('renders a multi-engine badge naming both engines', () => {
    renderModal([entry({ id: 'a1', requiredEngines: ['kokoro', 'qwen'], multiTts: true })]);
    expect(screen.getByTestId('queue-entry-a1-engines')).toHaveTextContent('Kokoro + Qwen');
  });

  it('shows the dual-model advisory on a multi-TTS chapter when the flag is off', () => {
    renderModal([entry({ id: 'a1', requiredEngines: ['kokoro', 'qwen'], multiTts: true })], {
      dualModelEnabled: false,
    });
    expect(screen.getByTestId('queue-entry-a1-dual-model-warning')).toBeInTheDocument();
  });

  it('hides the dual-model advisory when the flag is on', () => {
    renderModal([entry({ id: 'a1', requiredEngines: ['kokoro', 'qwen'], multiTts: true })], {
      dualModelEnabled: true,
    });
    expect(screen.getByTestId('queue-entry-a1-engines')).toHaveTextContent('Kokoro + Qwen');
    expect(screen.queryByTestId('queue-entry-a1-dual-model-warning')).toBeNull();
  });

  it('renders no engine badge for a legacy entry without requiredEngines', () => {
    renderModal([entry({ id: 'a1' })]);
    expect(screen.queryByTestId('queue-entry-a1-engines')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a1-dual-model-warning')).toBeNull();
  });

  it('dispatches loadQueue on open (cross-tab freshness)', async () => {
    renderModal([]);
    /* The mount-time loadQueue fires; assert via fetchMock since the
       thunk routes through fetch. */
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });
    const loadCall = fetchMock.mock.calls.find((c) => c[0] === '/api/queue');
    expect(loadCall).toBeDefined();
  });
});
