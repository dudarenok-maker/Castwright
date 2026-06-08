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

import { createSelector, createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { components } from '../lib/api-types';
import type { ChaptersState } from './chapters-slice';

/* Plan 108 Wave 3 — the TTS engines a chapter requires, stamped server-side at
   enqueue time. The contract lives on the SERVER queue shape only (NOT in
   openapi.yaml), so it's mirrored here as a local union rather than pulled from
   the generated api-types. Keep in lockstep with server/src/tts/index.ts
   TtsEngine. */
export type TtsEngine = 'coqui' | 'piper' | 'kokoro' | 'gemini' | 'qwen';

/* Generated base shape (openapi) widened with the additive Wave-3 fields.
   Absent on a legacy entry / when the server couldn't resolve them. */
export type QueueEntry = components['schemas']['QueueEntry'] & {
  requiredEngines?: TtsEngine[];
  multiTts?: boolean;
};
export type QueueScope = QueueEntry['scope'];
export type QueueStatus = QueueEntry['status'];

export interface QueueState {
  entries: QueueEntry[];
  /** Queue-global pause flag — flipped via POST /api/queue/pause. When true
      the dispatcher waits at the next chapter boundary; the in-flight entry
      runs to completion before the drain stops.

      DEFAULT IS false → the queue AUTO-DRAINS. There is no "start" gate: when
      `paused === false` and there is queued work, the dispatcher
      (`queue-dispatcher-middleware`) begins the head entry as soon as a
      snapshot loads — on any view, on app boot, without an explicit Resume.
      `Pause` is the only opt-out; `Resume` un-pauses, it does not "start" an
      idle queue. Since plan 102 Should #5 this flag is also the open-side gate
      the generation-stream middleware reads (it replaced the removed
      `chapters.paused`), so a paused queue suppresses cold-boot auto-resume
      too. Contract documented in docs/features/archive/102-global-queue-modal.md
      (invariant 8). */
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
export const selectQueueEntryById =
  (id: string) =>
  (s: RootSliceShape): QueueEntry | undefined =>
    s.queue.entries.find((e) => e.id === id);

/** Entries grouped by bookId, preserving cross-book order. Cheap to recompute
    per render because the modal needs both the flat list AND the per-book
    grouping (for the "Book A · n chapters" headers). */
export const selectQueueByBook = (
  s: RootSliceShape,
): { bookId: string; entries: QueueEntry[] }[] => {
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

/** The FIRST in-flight entry (status === 'in_progress'), or null. Kept for the
    reorder/drag path which still pins one entry; under queue-sole concurrency
    MULTIPLE entries can be in_progress at once, so the modal's per-row "In
    flight" label reads `selectInFlightEntryIds` instead. */
export const selectInFlightEntry = (s: RootSliceShape): QueueEntry | null =>
  s.queue.entries.find((e) => e.status === 'in_progress') ?? null;

/** The set of ALL in-flight entry ids (status === 'in_progress'). Under
    queue-sole concurrency the dispatcher runs one chapter per worker, so up to
    N entries are in flight simultaneously — the modal renders EVERY one as "In
    flight" rather than assuming a single in-flight row. Memoised on the entries
    reference so the modal's useSelector gets a stable Set across unrelated
    re-renders (a fresh Set each call would re-render on every store tick). */
export const selectInFlightEntryIds = createSelector(
  [selectQueueEntries],
  (entries): Set<string> =>
    new Set(entries.filter((e) => e.status === 'in_progress').map((e) => e.id)),
);

/* --- Active-generation overlay (read-side honesty) ------------------------
   The workspace queue (`.queue.json`) is populated only by explicit
   regenerate / "Add to queue" actions. The PRIMARY generation path — first
   generation after analysis, and resume-on-reopen — opens its SSE through the
   generation-stream-middleware `reconcile` (`hasWork(chapters)`), which never
   writes a queue entry. That left the queue modal + "Queue · N" chip reporting
   "Empty"/0 while a book was visibly generating (line counts incrementing).

   These two selectors let the modal / chip reflect that live run by reading the
   `chapters.activeStream` snapshot the runner publishes. They read `chapters`
   via an OPTIONAL field so lean stores that omit the slice (e.g. the queue-modal
   unit test store) stay valid — mirrors the defensive `queue?` read in
   generation-stream-middleware. */

interface ActiveGenerationRootShape {
  queue: QueueState;
  chapters?: ChaptersState;
}

export interface ActiveGenerationChapterRow {
  id: number;
  state: 'in_progress' | 'queued';
}

export interface ActiveGenerationView {
  bookId: string;
  done: number;
  total: number;
  inProgress: number;
  /** Per-chapter rows when the streaming book is the one currently loaded in
      the chapters slice. `null` for a cross-book stream — the slice then holds
      a DIFFERENT book's rows, so only the summary counts are trustworthy. */
  chapters: ActiveGenerationChapterRow[] | null;
}

/** A view of the in-flight generation run when the workspace queue has no
    real entries to show. Returns `null` when there ARE real entries (the real
    queue always wins) or when no stream is live. Same-book streams carry the
    per-chapter rows; cross-book streams carry only the done/total summary. */
export const selectActiveGenerationView = (
  s: ActiveGenerationRootShape,
): ActiveGenerationView | null => {
  if (s.queue.entries.length > 0) return null;
  const chapters = s.chapters;
  if (!chapters) return null;
  /* Prefer the stream for the currently-viewed book (so the overlay lists its
     rows); else any open stream. With one stream this is exactly the prior
     single-snapshot behaviour. */
  const streams = Object.values(chapters.activeStreams);
  const active =
    (chapters.currentBookId ? chapters.activeStreams[chapters.currentBookId] : undefined) ??
    streams[0] ??
    null;
  if (!active) return null;
  const sameBook = chapters.currentBookId === active.bookId;
  /* Excluded chapters never queue or synthesise — mirror the filter in the
     runner's snapshotFromChapters + middleware hasWork so the row count agrees
     with the pill's done/total. */
  const rows: ActiveGenerationChapterRow[] | null = sameBook
    ? chapters.chapters
        .filter(
          (c) =>
            !c.excluded &&
            !c.held &&
            (c.state === 'in_progress' || c.state === 'queued'),
        )
        .map((c) => ({ id: c.id, state: c.state as 'in_progress' | 'queued' }))
    : null;
  return {
    bookId: active.bookId,
    done: active.done,
    total: active.total,
    inProgress: active.inProgress,
    chapters: rows,
  };
};

/** Count for the "Queue · N" chip + "View queue · N" button. Real queue entries
    win; otherwise reflect the live run so the chip doesn't read 0 / disappear
    while a book generates. Distinct from `selectQueueCount` (which must stay the
    REAL entry count — the modal header + pause gate operate on real entries). */
export const selectGenerationActivityCount = (s: ActiveGenerationRootShape): number => {
  if (s.queue.entries.length > 0) return s.queue.entries.length;
  const view = selectActiveGenerationView(s);
  if (!view) return 0;
  if (view.chapters) return view.chapters.length;
  return Math.max(view.total - view.done, view.inProgress, 1);
};
