/* Regression test for #3106 — stale awaiting_confirm blocked-state signal.
 *
 * Verifies that when an awaiting_confirm entry sits unanswered past the
 * STALE_AWAITING_CONFIRM_MS threshold while a queued entry exists behind
 * it, the Queue modal surfaces a persistent banner naming the blocked
 * characters and dispatches a warn toast.
 *
 * FAILS pre-fix (no banner, no toast); PASSES post-fix. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';
import { queueSlice, type QueueEntry } from '../store/queue-slice';
import { chaptersSlice } from '../store/chapters-slice';
import { uiSlice } from '../store/ui-slice';
import { accountSlice } from '../store/account-slice';
import { notificationsSlice } from '../store/notifications-slice';
import { librarySlice } from '../store/library-slice';
import { QueueModal } from './queue-modal';
import { STALE_AWAITING_CONFIRM_MS } from './queue-modal';

vi.mock('../store/queue-thunks', () => ({
  loadQueue: () => () => Promise.resolve(),
  cancelQueueEntry: () => () => Promise.resolve(),
  clearQueue: () => () => Promise.resolve(),
  confirmFallbackEntry: () => () => Promise.resolve(),
  reorderQueue: () => () => Promise.resolve(),
  retryQueueEntry: () => () => Promise.resolve(),
  setQueuePaused: () => () => Promise.resolve(),
  skipFallbackEntry: () => () => Promise.resolve(),
}));

vi.mock('../store/voice-readiness-selectors', () => ({
  selectFallbackEngineName: () => 'Kokoro',
}));

const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'e1',
  bookId: 'book-A',
  chapterId: 3,
  scope: 'this',
  addedAt: '2026-09-10T00:00:00.000Z',
  status: 'queued',
  order: 0,
  ...overrides,
});

function makeStore(entries: QueueEntry[]) {
  return configureStore({
    reducer: {
      queue: queueSlice.reducer,
      chapters: chaptersSlice.reducer,
      ui: uiSlice.reducer,
      account: accountSlice.reducer,
      notifications: notificationsSlice.reducer,
      library: librarySlice.reducer,
    },
    preloadedState: {
      queue: { entries, paused: false, recycling: false, loaded: true },
      library: {
        books: [{ bookId: 'book-A', title: 'Test Book' }],
      } as ReturnType<typeof librarySlice.reducer>,
    },
  });
}

describe('#3106 stale awaiting_confirm blocked-state signal', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows banner + toast when awaiting_confirm exceeds threshold', () => {
    const awaiting = entry({
      id: 'e10', status: 'awaiting_confirm', order: 0,
      fallbackCharacters: [{ id: 'c1', name: 'Narrator' }],
    });
    const queued = entry({ id: 'e11', chapterId: 4, status: 'queued', order: 1 });
    const store = makeStore([awaiting, queued]);

    render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
    expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();

    act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS + 6_000); });

    const banner = screen.getByTestId('queue-stale-awaiting-banner');
    expect(banner.textContent).toMatch(/1 chapter blocked/);
    expect(banner.textContent).toMatch(/Narrator/);

    const toasts = store.getState().notifications.toasts;
    const t = toasts.find((x) => x.dedupeKey === 'stale-awaiting-confirm-e10');
    expect(t).toBeTruthy();
    expect(t!.message).toMatch(/Narrator/);
  });

  it('does NOT fire before the threshold', () => {
    const awaiting = entry({
      id: 'e20', status: 'awaiting_confirm',
      fallbackCharacters: [{ id: 'c2', name: 'Hero' }],
    });
    const store = makeStore([awaiting]);

    render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
    act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS - 1_000); });

    expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();
    expect(
      store.getState().notifications.toasts.find((t) => t.dedupeKey === 'stale-awaiting-confirm-e20'),
    ).toBeUndefined();
  });

  it('clears banner when the entry is resolved', () => {
    const awaiting = entry({
      id: 'e30', status: 'awaiting_confirm',
      fallbackCharacters: [{ id: 'c3', name: 'Villain' }],
    });
    const store = makeStore([awaiting]);

    const { rerender } = render(
      <Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>,
    );
    act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS + 6_000); });
    expect(screen.getByTestId('queue-stale-awaiting-banner')).toBeTruthy();

    store.dispatch(queueSlice.actions.setSnapshot({
      entries: [{ ...awaiting, status: 'queued' }],
      paused: false, recycling: false,
    }));
    rerender(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
    act(() => { vi.advanceTimersByTime(6_000); });

    expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();
  });
});