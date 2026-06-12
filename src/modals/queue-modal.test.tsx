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
import { chaptersSlice } from '../store/chapters-slice';
import type { ActiveStreamSnapshot } from '../store/chapters-slice';
import type { LibraryBook } from '../lib/types';

/* Read-side honesty preload — when set, the store carries a live activeStream
   (the reconcile-driven path writes no queue entry) so the modal should show
   the active run instead of "Empty". */
interface ActiveGenerationPreload {
  activeStream: ActiveStreamSnapshot;
  currentBookId: string | null;
  chapters?: Array<{ id: number; state: string; excluded?: boolean }>;
}

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

const libraryBook = (bookId: string, title: string): LibraryBook =>
  ({
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
  }) as unknown as LibraryBook;

function renderModal(
  entries: QueueEntry[],
  opts: {
    paused?: boolean;
    books?: LibraryBook[];
    dualModelEnabled?: boolean;
    activeGeneration?: ActiveGenerationPreload;
  } = {},
) {
  const store = configureStore({
    reducer: {
      queue: queueSlice.reducer,
      notifications: notificationsSlice.reducer,
      library: librarySlice.reducer,
      account: accountSlice.reducer,
      chapters: chaptersSlice.reducer,
    },
    preloadedState: {
      queue: { entries, paused: opts.paused ?? false, recycling: false, loaded: true },
      library: {
        books: opts.books ?? [],
        pausedSnapshots: {},
      } as ReturnType<typeof librarySlice.reducer>,
      account: {
        ...accountSlice.getInitialState(),
        dualModelEnabled: opts.dualModelEnabled ?? false,
      },
      chapters: {
        ...chaptersSlice.getInitialState(),
        ...(opts.activeGeneration
          ? {
              activeStreams: {
                [opts.activeGeneration.activeStream.bookId]: opts.activeGeneration.activeStream,
              },
              currentBookId: opts.activeGeneration.currentBookId,
              chapters: (opts.activeGeneration.chapters ?? []) as ReturnType<
                typeof chaptersSlice.reducer
              >['chapters'],
            }
          : {}),
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

  it('shows the active-generation run instead of "Empty" when the queue is empty but a stream is live', () => {
    renderModal([], {
      books: [libraryBook('book-A', 'Book Alpha')],
      activeGeneration: {
        activeStream: {
          bookId: 'book-A',
          modelKey: 'kokoro-v1',
          done: 2,
          total: 5,
          inProgress: 1,
          lastTickAt: null,
          halted: false,
        } as ActiveStreamSnapshot,
        currentBookId: 'book-A',
        chapters: [
          { id: 1, state: 'done' },
          { id: 2, state: 'in_progress' },
          { id: 3, state: 'queued' },
        ],
      },
    });
    /* Header reads "Generating…" not "Empty"; the empty CTA is gone. */
    expect(screen.getByText('Generating…')).toBeInTheDocument();
    expect(screen.queryByText(/No chapters queued/)).not.toBeInTheDocument();
    /* The active-generation section names the book + lists the live rows. */
    expect(screen.getByTestId('queue-modal-active-generation')).toBeInTheDocument();
    expect(screen.getByText('Book Alpha')).toBeInTheDocument();
    expect(screen.getByTestId('queue-active-chapter-2')).toBeInTheDocument();
    expect(screen.getByTestId('queue-active-chapter-3')).toBeInTheDocument();
    /* Done chapter is not listed as pending work. */
    expect(screen.queryByTestId('queue-active-chapter-1')).not.toBeInTheDocument();
  });

  it('prefers real queue entries over the active-stream overlay', () => {
    renderModal([entry({ id: 'a1', bookId: 'book-A', chapterId: 1, order: 0 })], {
      books: [libraryBook('book-A', 'Book Alpha')],
      activeGeneration: {
        activeStream: {
          bookId: 'book-A',
          modelKey: 'kokoro-v1',
          done: 0,
          total: 3,
          inProgress: 1,
          lastTickAt: null,
          halted: false,
        } as ActiveStreamSnapshot,
        currentBookId: 'book-A',
        chapters: [{ id: 1, state: 'in_progress' }],
      },
    });
    /* Real entry wins — the synthetic active-generation section is suppressed. */
    expect(screen.queryByTestId('queue-modal-active-generation')).not.toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a1')).toBeInTheDocument();
    expect(screen.getByText('1 entry pending')).toBeInTheDocument();
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

  it("falls back to bookId when the library doesn't know the book", () => {
    renderModal([entry({ id: 'a1', bookId: 'unknown-book' })]);
    expect(screen.getByText('unknown-book')).toBeInTheDocument();
  });

  it('shows "n entries pending" with plural agreement in the header', () => {
    renderModal([entry({ id: 'a1' })]);
    expect(screen.getByText('1 entry pending')).toBeInTheDocument();
  });

  it('pluralizes correctly when count > 1', () => {
    renderModal([entry({ id: 'a1', order: 0 }), entry({ id: 'a2', chapterId: 2, order: 1 })]);
    expect(screen.getByText('2 entries pending')).toBeInTheDocument();
  });

  it('marks the in-flight entry visually + hides its reorder/cancel buttons', () => {
    renderModal([
      entry({ id: 'a1', status: 'in_progress', order: 0, progress: 0.42 }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
    ]);
    /* In-flight entry has no move/cancel buttons, BUT carries a force-remove
       control so a stuck/orphaned in_progress row can always be cleared. */
    expect(screen.queryByTestId('queue-entry-a1-up')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a1-down')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a1-cancel')).toBeNull();
    expect(screen.getByTestId('queue-entry-a1-force-remove')).toBeInTheDocument();
    /* The queued entry has the normal controls and NO force-remove. */
    expect(screen.getByTestId('queue-entry-a2-up')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a2-down')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a2-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-entry-a2-force-remove')).toBeNull();
    /* In-flight status line shows progress. */
    expect(screen.getByText(/In flight · 42%/)).toBeInTheDocument();
  });

  it('force-remove on a stuck in-flight row DELETEs with ?force=true', async () => {
    renderModal([entry({ id: 'a1', status: 'in_progress', order: 0 })]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-entry-a1-force-remove'));
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]).startsWith('/api/queue/a1'));
    expect(call).toBeDefined();
    expect(call![0]).toBe('/api/queue/a1?force=true');
    expect(call![1].method).toBe('DELETE');
  });

  it('a failed entry renders "Failed · reason" with a Retry control (and no force-remove)', () => {
    renderModal([
      entry({ id: 'a1', status: 'failed', order: 0, errorReason: 'sidecar 500' }),
    ]);
    expect(screen.getByText(/Failed · sidecar 500/)).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a1-retry')).toBeInTheDocument();
    /* Failed isn't in-flight: it keeps cancel, and shows no force-remove. */
    expect(screen.getByTestId('queue-entry-a1-cancel')).toBeInTheDocument();
    expect(screen.queryByTestId('queue-entry-a1-force-remove')).toBeNull();
  });

  it('Retry on a failed entry POSTs /retry to re-queue it', async () => {
    renderModal([entry({ id: 'a1', status: 'failed', order: 0, errorReason: 'x' })]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-entry-a1-retry'));
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/queue/a1/retry');
    expect(call).toBeDefined();
    expect(call![1].method).toBe('POST');
  });

  it('a queued entry shows neither Retry nor force-remove', () => {
    renderModal([entry({ id: 'a1', status: 'queued', order: 0 })]);
    expect(screen.queryByTestId('queue-entry-a1-retry')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a1-force-remove')).toBeNull();
    expect(screen.getByTestId('queue-entry-a1-cancel')).toBeInTheDocument();
  });

  it('an awaiting_confirm entry names the fallback characters + shows Render-anyway / Skip', () => {
    renderModal([
      entry({
        id: 'a1',
        status: 'awaiting_confirm',
        order: 0,
        fallbackCharacters: [
          { id: 'wren', name: 'Wren' },
          { id: 'ro', name: 'Ro' },
        ],
      }),
    ]);
    expect(screen.getByTestId('queue-entry-a1-status')).toHaveTextContent(
      /no designed Qwen voice for Wren, Ro/,
    );
    expect(screen.getByTestId('queue-entry-a1-confirm-fallback')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a1-skip-fallback')).toBeInTheDocument();
  });

  it('Render-anyway POSTs /confirm-fallback', async () => {
    renderModal([entry({ id: 'a1', status: 'awaiting_confirm', order: 0, fallbackCharacters: [] })]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-entry-a1-confirm-fallback'));
    });
    const call = fetchMock.mock.calls.find(
      (c) => String(c[0]) === '/api/queue/a1/confirm-fallback',
    );
    expect(call).toBeDefined();
    expect(call![1].method).toBe('POST');
  });

  it('Skip POSTs /skip-fallback', async () => {
    renderModal([entry({ id: 'a1', status: 'awaiting_confirm', order: 0, fallbackCharacters: [] })]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-entry-a1-skip-fallback'));
    });
    const call = fetchMock.mock.calls.find((c) => String(c[0]) === '/api/queue/a1/skip-fallback');
    expect(call).toBeDefined();
    expect(call![1].method).toBe('POST');
  });

  it('renders EVERY in_progress entry as "In flight" (multiple concurrent under queue-sole concurrency)', () => {
    renderModal([
      entry({
        id: 'a1',
        bookId: 'book-A',
        chapterId: 1,
        status: 'in_progress',
        order: 0,
        progress: 0.4,
      }),
      entry({
        id: 'a2',
        bookId: 'book-A',
        chapterId: 2,
        status: 'in_progress',
        order: 1,
        progress: 0.1,
      }),
      entry({ id: 'a3', bookId: 'book-A', chapterId: 3, status: 'queued', order: 2 }),
    ]);
    /* Two rows read "In flight" (with their own progress %); the queued row
       reads "Queued". */
    expect(screen.getByText(/In flight · 40%/)).toBeInTheDocument();
    expect(screen.getByText(/In flight · 10%/)).toBeInTheDocument();
    expect(screen.getByText('Queued')).toBeInTheDocument();
    /* BOTH in-flight rows are pinned: no reorder/cancel controls. */
    expect(screen.queryByTestId('queue-entry-a1-cancel')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a2-cancel')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a1-drag')).toBeNull();
    expect(screen.queryByTestId('queue-entry-a2-drag')).toBeNull();
    /* The queued row keeps its controls. */
    expect(screen.getByTestId('queue-entry-a3-cancel')).toBeInTheDocument();
    expect(screen.getByTestId('queue-entry-a3-drag')).toBeInTheDocument();
  });

  it('reorder excludes ALL in-flight entries from the order array (server reorder() drops every in_progress row)', async () => {
    renderModal([
      entry({ id: 'a1', bookId: 'book-A', chapterId: 1, status: 'in_progress', order: 0 }),
      entry({ id: 'a2', bookId: 'book-A', chapterId: 2, status: 'in_progress', order: 1 }),
      entry({ id: 'a3', bookId: 'book-A', chapterId: 3, status: 'queued', order: 2 }),
      entry({ id: 'a4', bookId: 'book-A', chapterId: 4, status: 'queued', order: 3 }),
    ]);
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId('queue-entry-a4-up'));
    });
    const reorderCall = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/reorder');
    expect(reorderCall).toBeDefined();
    /* Both in-flight a1 + a2 excluded; a4 moves before a3. */
    expect(reorderCall![1].body).toContain('"order":["a4","a3"]');
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

  it('drag-to-reorder dispatches reorder thunk with the new global order (plan 102)', async () => {
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

describe('QueueModal — Clear queue', () => {
  /* The header "Clear queue" button and the confirm dialog's confirm button
     share the accessible name "Clear queue"; the header one carries the testid,
     so the dialog confirm is the other match. */
  function clickDialogConfirm() {
    const btns = screen.getAllByRole('button', { name: 'Clear queue' });
    const confirm = btns.find((b) => b.getAttribute('data-testid') !== 'queue-modal-clear');
    fireEvent.click(confirm!);
  }

  it('shows the Clear queue button when entries are queued', () => {
    renderModal([entry({ id: 'a1' })]);
    expect(screen.getByTestId('queue-modal-clear')).toBeInTheDocument();
  });

  it('hides the Clear queue button when the queue is empty and nothing is generating', () => {
    renderModal([]);
    expect(screen.queryByTestId('queue-modal-clear')).toBeNull();
  });

  it('clears pending entries with force:false when nothing is in flight', async () => {
    renderModal([entry({ id: 'a1' }), entry({ id: 'a2', chapterId: 2, order: 1 })]);
    fireEvent.click(screen.getByTestId('queue-modal-clear'));
    /* No in-flight run → no "also stop" checkbox to offer. */
    expect(screen.queryByTestId('queue-clear-also-stop')).toBeNull();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      clickDialogConfirm();
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/clear');
    expect(call).toBeDefined();
    expect(call![1].method).toBe('POST');
    expect(call![1].body).toBe('{"force":false}');
  });

  it('offers "Also stop generation" when in flight; checking it force-clears', async () => {
    renderModal([
      entry({ id: 'a1', status: 'in_progress', order: 0 }),
      entry({ id: 'a2', chapterId: 2, order: 1 }),
    ]);
    fireEvent.click(screen.getByTestId('queue-modal-clear'));
    fireEvent.click(screen.getByTestId('queue-clear-also-stop'));
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ entries: [], paused: false }),
    });
    await act(async () => {
      clickDialogConfirm();
    });
    const call = fetchMock.mock.calls.find((c) => c[0] === '/api/queue/clear');
    expect(call).toBeDefined();
    expect(call![1].body).toBe('{"force":true}');
  });
});
