/* Plan 102 — workspace-level chapter-generation queue slice.
 *
 * Mirrors `<workspace>/.queue.json` (server-side persistence at
 * server/src/workspace/queue-io.ts). Reducers are pure derivations of the
 * server file shape; mutations route through `queue-thunks.ts` which POSTs
 * to /api/queue/* then dispatches the resulting snapshot back.
 *
 * The slice is the source of truth for what the queue modal renders. The
 * generation-stream-middleware reads from it to decide what to dispatch
 * next (Wave 4 — the dispatcher rewrite that consumes this slice landed
 * separately so Wave 2b stays focused on the foundation + reconnect). */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { components } from '../lib/api-types';

export type QueueEntry = components['schemas']['QueueEntry'];
export type QueueScope = QueueEntry['scope'];
export type QueueStatus = QueueEntry['status'];

export interface QueueState {
  entries: QueueEntry[];
  /** Queue-global pause flag — flipped via POST /api/queue/pause. When true
      the dispatcher waits at the next chapter boundary; the in-flight entry
      runs to completion before the drain stops. */
  paused: boolean;
  /** First-load gate — true after the initial GET /api/queue completes. The
      modal renders empty-state UI vs spinner based on this. */
  loaded: boolean;
}

const initialState: QueueState = {
  entries: [],
  paused: false,
  loaded: false,
};

export const queueSlice = createSlice({
  name: 'queue',
  initialState,
  reducers: {
    /** Replace the whole snapshot — called by every queue-thunk after a
        successful round-trip. The server is authoritative; the slice is a
        mirror. */
    setSnapshot: (s, a: PayloadAction<{ entries: QueueEntry[]; paused: boolean }>) => {
      s.entries = a.payload.entries;
      s.paused = a.payload.paused;
      s.loaded = true;
    },
    /** Mark the queue as not-yet-loaded — used when the slice is reset
        (e.g. workspace switch in future multi-workspace mode). */
    reset: () => initialState,
  },
});

export const queueActions = queueSlice.actions;

/* --- Selectors ------------------------------------------------- */

interface RootSliceShape {
  queue: QueueState;
}

export const selectQueueEntries = (s: RootSliceShape): QueueEntry[] => s.queue.entries;
export const selectQueuePaused = (s: RootSliceShape): boolean => s.queue.paused;
export const selectQueueLoaded = (s: RootSliceShape): boolean => s.queue.loaded;
export const selectQueueCount = (s: RootSliceShape): number => s.queue.entries.length;

/** Find an entry by id — used by the modal's per-row reorder/cancel buttons. */
export const selectQueueEntryById = (id: string) => (s: RootSliceShape): QueueEntry | undefined =>
  s.queue.entries.find((e) => e.id === id);

/** Entries grouped by bookId, preserving cross-book order. Cheap to recompute
    per render because the modal needs both the flat list AND the per-book
    grouping (for the "Book A · n chapters" headers). */
export const selectQueueByBook = (s: RootSliceShape): { bookId: string; entries: QueueEntry[] }[] => {
  const grouped: Record<string, QueueEntry[]> = {};
  const order: string[] = [];
  for (const entry of s.queue.entries) {
    if (!grouped[entry.bookId]) {
      grouped[entry.bookId] = [];
      order.push(entry.bookId);
    }
    grouped[entry.bookId].push(entry);
  }
  return order.map((bookId) => ({ bookId, entries: grouped[bookId] }));
};

/** The current in-flight entry (status === 'in_progress'), or null. Pinned at
    order=0 by the server-side queue-io contract; the modal uses this to know
    which row is non-draggable. */
export const selectInFlightEntry = (s: RootSliceShape): QueueEntry | null =>
  s.queue.entries.find((e) => e.status === 'in_progress') ?? null;
