/* Regression test for #3106 — stale awaiting_confirm signal.
 *
 * Verifies that when an awaiting_confirm entry sits unanswered past the
 * STALE_AWAITING_CONFIRM_MS threshold while another entry is queued
 * elsewhere in the workspace, the Queue modal surfaces a persistent banner
 * naming the waiting characters and dispatches a warn toast.
 *
 * FAILS pre-fix (no banner, no toast); PASSES post-fix.
 *
 * pr-review-gate pass on #3106 additionally pins:
 *   - S1/N1: a lone awaiting_confirm entry with nothing else queued in the
 *     workspace never fires, even past the threshold. (Pass 2 renamed the
 *     signal's copy from "blocked" to "needs your input" — the gate is
 *     "is there other queued work", not "is this entry blocking it".)
 *   - S3: repeated polls while still awaiting_confirm don't repeatedly
 *     re-push the toast and reset its auto-dismiss window.
 *   - S4: staleness is read from the entry's own `parkedAt`, not from when
 *     the component first observed it — an entry already stale before mount
 *     fires immediately, and a reload can't reset the clock.
 *   - S5: the stale toast reuses the park-time toast's dedupe key
 *     (`fallback-confirm:<id>`) instead of stacking a second toast.
 *   - N2 (pass 2): a `parkedAt` that reads as being in the CLIENT's future
 *     (the device clock is behind the server's) doesn't permanently
 *     suppress the signal — see the "clock skew" describe block below. */

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

/* Fixed "now" the fake clock starts at — entries default their `addedAt` (the
   S4 fallback stamp) to the same instant, so an entry is "just parked" (zero
   elapsed) unless a test explicitly backdates `parkedAt`/`addedAt`. */
const NOW_ISO = '2026-09-10T00:00:00.000Z';

const entry = (overrides: Partial<QueueEntry> = {}): QueueEntry => ({
  id: 'e1',
  bookId: 'book-A',
  chapterId: 3,
  scope: 'this',
  addedAt: NOW_ISO,
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
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW_ISO));
  });
  afterEach(() => { vi.useRealTimers(); });

  it('shows banner + toast when awaiting_confirm exceeds threshold, with something queued behind it', () => {
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
    expect(banner.textContent).toMatch(/1 chapter needs your input/);
    expect(banner.textContent).toMatch(/Narrator/);

    const toasts = store.getState().notifications.toasts;
    const t = toasts.find((x) => x.dedupeKey === 'fallback-confirm:e10');
    expect(t).toBeTruthy();
    expect(t!.message).toMatch(/Narrator/);
  });

  it('does NOT fire before the threshold, even with something queued behind it', () => {
    const awaiting = entry({
      id: 'e20', status: 'awaiting_confirm',
      fallbackCharacters: [{ id: 'c2', name: 'Hero' }],
    });
    const queued = entry({ id: 'e21', chapterId: 5, status: 'queued', order: 1 });
    const store = makeStore([awaiting, queued]);

    render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
    act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS - 1_000); });

    expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();
    expect(
      store.getState().notifications.toasts.find((t) => t.dedupeKey === 'fallback-confirm:e20'),
    ).toBeUndefined();
  });

  /* S1/N1 — the fixture's `queued` sibling above is load-bearing: without
     ANY other `queued` entry in the workspace queue, the signal doesn't
     fire (it's gated on "is there other queued work", not on ordering or
     book — see N1 in PR #3143's pass-2 review). */
  it('does NOT fire when nothing else is queued in the workspace, even past the threshold', () => {
    const awaiting = entry({
      id: 'e60', status: 'awaiting_confirm',
      fallbackCharacters: [{ id: 'c6', name: 'Loner' }],
    });
    const store = makeStore([awaiting]);

    render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
    act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS + 6_000); });

    expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();
    expect(
      store.getState().notifications.toasts.find((t) => t.dedupeKey === 'fallback-confirm:e60'),
    ).toBeUndefined();
  });

  it('clears banner when the entry is resolved', () => {
    const awaiting = entry({
      id: 'e30', status: 'awaiting_confirm',
      fallbackCharacters: [{ id: 'c3', name: 'Villain' }],
    });
    const queued = entry({ id: 'e31', chapterId: 6, status: 'queued', order: 1 });
    const store = makeStore([awaiting, queued]);

    const { rerender } = render(
      <Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>,
    );
    act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS + 6_000); });
    expect(screen.getByTestId('queue-stale-awaiting-banner')).toBeTruthy();

    store.dispatch(queueSlice.actions.setSnapshot({
      entries: [{ ...awaiting, status: 'queued' }, queued],
      paused: false, recycling: false,
    }));
    rerender(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
    act(() => { vi.advanceTimersByTime(6_000); });

    expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();
  });

  /* S3 — without the one-shot `toastFiredRef` guard, every 5s poll while the
     entry is still awaiting_confirm past the threshold would re-push the
     toast; notifications-slice bumps `createdAt` on every dedupe-key push,
     which would reset ToastStack's 6s auto-dismiss timer forever. */
  it('does not repeatedly re-push the toast on later polls, once fired', () => {
    const awaiting = entry({
      id: 'e40', status: 'awaiting_confirm',
      fallbackCharacters: [{ id: 'c4', name: 'Sidekick' }],
    });
    const queued = entry({ id: 'e41', chapterId: 7, status: 'queued', order: 1 });
    const store = makeStore([awaiting, queued]);

    render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
    act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS + 6_000); });

    const firstToast = store
      .getState().notifications.toasts
      .find((t) => t.dedupeKey === 'fallback-confirm:e40');
    expect(firstToast).toBeTruthy();
    const firstCreatedAt = firstToast!.createdAt;

    /* Several more 5s poll intervals (queue-modal.tsx's STALE_CHECK_INTERVAL_MS)
       while status stays awaiting_confirm. */
    act(() => { vi.advanceTimersByTime(5_000 * 4); });

    const toastsAfter = store.getState().notifications.toasts;
    const matching = toastsAfter.filter((t) => t.dedupeKey === 'fallback-confirm:e40');
    expect(matching).toHaveLength(1);
    expect(matching[0].createdAt).toBe(firstCreatedAt);
  });

  /* S4 — an entry already stale (parkedAt more than the threshold in the
     past, e.g. parked in a prior session before a reload) surfaces the
     signal on mount, without waiting an extra threshold's worth of time. */
  it('fires immediately on mount when parkedAt is already past the threshold', () => {
    const longAgo = new Date(Date.now() - STALE_AWAITING_CONFIRM_MS - 5_000).toISOString();
    const awaiting = entry({
      id: 'e50', status: 'awaiting_confirm', parkedAt: longAgo,
      fallbackCharacters: [{ id: 'c5', name: 'Oracle' }],
    });
    const queued = entry({ id: 'e51', chapterId: 8, status: 'queued', order: 1 });
    const store = makeStore([awaiting, queued]);

    render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);

    expect(screen.getByTestId('queue-stale-awaiting-banner')).toBeTruthy();
    expect(
      store.getState().notifications.toasts.find((t) => t.dedupeKey === 'fallback-confirm:e50'),
    ).toBeTruthy();
  });

  /* N2 (pass-2 review) — clock skew. `parkedAt` is SERVER-stamped
     (queue-io.ts markAwaitingConfirm) but the staleness check runs against
     the BROWSER's Date.now(). These two entries build `parkedAt` from a
     DIFFERENT time source than the fake clock the component reads (`NOW_ISO`
     + a fixed offset), rather than deriving it from `Date.now()` the way
     every other test in this file does — that's what lets this test see a
     bug the rest of the suite can't. */
  describe('clock skew (N2)', () => {
    it('does not permanently suppress the signal when the device clock reads BEHIND the server', () => {
      /* The server stamped `parkedAt` 2 minutes ahead of this client's fake
         "now" — i.e. this client's clock is 2 minutes behind the server's.
         A naive `Date.now() - Date.parse(parkedAt)` stays negative forever
         here (the gap only widens as the skew persists), so pre-fix this
         entry would never cross STALE_AWAITING_CONFIRM_MS. */
      const skewedParkedAt = new Date(Date.parse(NOW_ISO) + 2 * 60_000).toISOString();
      const awaiting = entry({
        id: 'e70', status: 'awaiting_confirm', parkedAt: skewedParkedAt,
        fallbackCharacters: [{ id: 'c7', name: 'Skewed' }],
      });
      const queued = entry({ id: 'e71', chapterId: 9, status: 'queued', order: 1 });
      const store = makeStore([awaiting, queued]);

      render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);
      expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();

      /* Just past the threshold measured from MOUNT (first client
         observation) — the skew-defensive fallback should fire here. A
         naive `now - Date.parse(parkedAt)` would still read NEGATIVE at
         this point (it needs threshold + the 2-minute skew, i.e. 3 minutes,
         to cross zero), so this window is exactly what distinguishes the
         fix from the bug. */
      act(() => { vi.advanceTimersByTime(STALE_AWAITING_CONFIRM_MS + 6_000); });

      expect(screen.getByTestId('queue-stale-awaiting-banner')).toBeTruthy();
      expect(
        store.getState().notifications.toasts.find((t) => t.dedupeKey === 'fallback-confirm:e70'),
      ).toBeTruthy();
    });

    it('does not fire instantly on mount for a skewed-behind clock, even though the entry just parked', () => {
      const skewedParkedAt = new Date(Date.parse(NOW_ISO) + 2 * 60_000).toISOString();
      const awaiting = entry({
        id: 'e80', status: 'awaiting_confirm', parkedAt: skewedParkedAt,
        fallbackCharacters: [{ id: 'c8', name: 'FreshSkewed' }],
      });
      const queued = entry({ id: 'e81', chapterId: 10, status: 'queued', order: 1 });
      const store = makeStore([awaiting, queued]);

      render(<Provider store={store}><QueueModal open={true} onClose={() => {}} /></Provider>);

      /* Immediately on mount — the fallback starts its own client-clock
         count from first observation, so this behaves like a freshly-parked
         entry (not stale yet), rather than firing on the very first check(). */
      expect(screen.queryByTestId('queue-stale-awaiting-banner')).toBeNull();
      expect(
        store.getState().notifications.toasts.find((t) => t.dedupeKey === 'fallback-confirm:e80'),
      ).toBeUndefined();
    });
  });
});
