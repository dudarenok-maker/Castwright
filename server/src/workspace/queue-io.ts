/* In-memory shape + helpers for the workspace-level chapter-generation
 * queue (plan 102). Persistence lives in queue-migrate.ts (`readQueueFile`
 * + `writeQueueFile`); this module owns the data shape, the mutators, and
 * the cross-mutation invariants.
 *
 * Invariants (mirror plan 102 doc):
 *   - entries[].id is unique within the workspace queue.
 *   - entries[].order is contiguous 0..N-1 after every mutation (renumber
 *     on insert / reorder / cancel / book-delete prune).
 *   - MULTIPLE entries may be status === 'in_progress' at once. Under the
 *     plan-111-refactor queue-sole concurrency model the dispatcher runs one
 *     chapter per worker (N concurrent), so up to N entries are in flight
 *     simultaneously across all books — including sibling chapters of the same
 *     book. `markInProgress` is the status-only transition the dispatcher uses
 *     on claim; it does NOT reorder (unlike the legacy single-in-flight
 *     `startEntry`, which pins to order 0 and is now unused).
 *   - 'forward' scope is expanded by the frontend at enqueue time into
 *     per-chapter `{ scope: 'this' }` entries; this server-side shape
 *     never carries 'forward' as a row. */

import type { TtsEngine, TtsModelKey } from '../tts/index.js';

export type QueueScope = 'this' | 'character';
export type QueueStatus =
  | 'queued'
  | 'in_progress'
  | 'paused'
  | 'done'
  | 'failed'
  /* The chapter would silently fall back from Qwen to Kokoro for one or more
     characters with no designed voice. The worker PARKS it here (rather than
     rendering generic voices) and waits for the user to confirm (→ queued,
     fallbackConfirmed) or skip (→ removed). The dispatcher never claims an
     `awaiting_confirm` entry (FILL claims only `queued`), and the boot orphan
     sweep leaves it alone — an unanswered question, not orphaned in-flight
     work. See the per-chapter loud-fallback gate plan. */
  | 'awaiting_confirm';

export interface QueueEntry {
  id: string;
  bookId: string;
  chapterId: number;
  scope: QueueScope;
  characterId?: string;
  /* Optional per-entry TTS model override (e.g. a regenerate requested at the
     Qwen 1.7B quality tier). Absent → the dispatcher uses the session default
     `ui.ttsModelKey`. Mirrored in openapi.yaml's QueueEntry. */
  modelKey?: TtsModelKey;
  addedAt: string; // ISO 8601
  status: QueueStatus;
  order: number;
  progress?: number;
  errorReason?: string | null;
  /* Plan 108 Wave 3 — the distinct TTS engines this chapter requires, computed
     server-side at enqueue time from the chapter's speaking characters (cast +
     analysis cache) + the book's default engine. Sorted + deduped. ABSENT on a
     legacy entry (pre-108) or when cast/analysis wasn't available at enqueue —
     treat absence as "single-engine / unknown" rather than multi. Lives on the
     SERVER queue shape only (NOT in openapi.yaml). */
  requiredEngines?: TtsEngine[];
  /* True when `requiredEngines.length > 1` — surfaced as the multi-TTS badge +
     dual-model advisory in the queue modal. Mirrors `isMultiTts`. */
  multiTts?: boolean;
  /* Per-chapter loud-fallback gate. The characters in THIS chapter that resolve
     to Qwen but have no designed voice, so would render in Kokoro. Stamped when
     the worker transitions the entry to `awaiting_confirm`; the modal lists
     them in the confirmation prompt. SERVER queue shape only (NOT in
     openapi.yaml's QueueEntry — like `requiredEngines`). */
  fallbackCharacters?: Array<{ id: string; name?: string }>;
  /* Set true once the user CONFIRMs the fallback for this entry. The worker
     reads it (threaded through the generation request) so a confirmed entry
     that re-enters (retry / reload / re-dispatch) renders straight through
     instead of re-prompting. */
  fallbackConfirmed?: boolean;
}

export interface QueueFile {
  entries: QueueEntry[];
  paused: boolean;
  schema?: number;
}

export interface EnqueueInput {
  id: string; // frontend-minted (deterministic for replay tests)
  bookId: string;
  chapterId: number;
  scope: QueueScope;
  characterId?: string;
  /* Optional per-entry TTS model override (regenerate at a chosen quality tier). */
  modelKey?: TtsModelKey;
  addedAt?: string; // optional — defaults to now()
  /* Plan 108 Wave 3 — engine set stamped by the route from the chapter's
     speaking characters. Omitted when cast/analysis isn't available. */
  requiredEngines?: TtsEngine[];
  multiTts?: boolean;
}

/** Append entries to the bottom of the queue. Renumbers `order` to stay
 *  contiguous. Duplicate ids are rejected with a thrown Error (the
 *  frontend mints unique ids at enqueue time — duplicates are a bug). */
export function enqueue(file: QueueFile, inputs: EnqueueInput[]): QueueFile {
  const seen = new Set(file.entries.map((e) => e.id));
  const fresh: QueueEntry[] = [];
  for (const input of inputs) {
    if (seen.has(input.id)) {
      throw new Error(`queue.enqueue: duplicate entry id "${input.id}"`);
    }
    seen.add(input.id);
    fresh.push({
      id: input.id,
      bookId: input.bookId,
      chapterId: input.chapterId,
      scope: input.scope,
      ...(input.characterId ? { characterId: input.characterId } : {}),
      ...(input.modelKey ? { modelKey: input.modelKey } : {}),
      addedAt: input.addedAt ?? new Date().toISOString(),
      status: 'queued',
      order: 0, // overwritten by renumber below
      /* Plan 108 Wave 3 — only stamped when the route resolved them; absent
         otherwise (legacy / cast or analysis unavailable). */
      ...(input.requiredEngines ? { requiredEngines: input.requiredEngines } : {}),
      ...(input.multiTts != null ? { multiTts: input.multiTts } : {}),
    });
  }
  return renumber({ ...file, entries: [...file.entries, ...fresh] });
}

/** Reorder the queue to match `desiredOrder` — a list of entry ids in the
 *  new order. The list MUST exclude the in-flight pinned entry (the
 *  frontend doesn't render a drag handle for it). Returns the new file
 *  on success; throws on mismatch (concurrent enqueue happened; client
 *  refetches + retries). */
export function reorder(file: QueueFile, desiredOrder: string[]): QueueFile {
  const inFlight = file.entries.find((e) => e.status === 'in_progress');
  const reorderable = file.entries.filter((e) => e.status !== 'in_progress');
  const reorderableIds = new Set(reorderable.map((e) => e.id));

  if (desiredOrder.length !== reorderable.length) {
    throw new Error(
      `queue.reorder: order length ${desiredOrder.length} doesn't match ${reorderable.length} reorderable entries`,
    );
  }
  for (const id of desiredOrder) {
    if (!reorderableIds.has(id)) {
      throw new Error(`queue.reorder: id "${id}" is not a reorderable entry`);
    }
  }

  const byId = new Map(reorderable.map((e) => [e.id, e]));
  const reordered = desiredOrder.map((id) => byId.get(id)!);
  const nextEntries = inFlight ? [inFlight, ...reordered] : reordered;
  return renumber({ ...file, entries: nextEntries });
}

/** Cancel (remove) an entry. Refuses to drop an in_progress entry unless
 *  `force` is set — normally callers must Pause first, but a stuck entry
 *  (e.g. orphaned in_progress after a reload, so the dispatcher neither
 *  reconciles nor re-claims it) can only be cleared with force. Returns the
 *  new file. */
export function cancel(file: QueueFile, entryId: string, opts?: { force?: boolean }): QueueFile {
  const target = file.entries.find((e) => e.id === entryId);
  if (!target) {
    /* Already gone — idempotent success rather than 404. */
    return file;
  }
  if (target.status === 'in_progress' && !opts?.force) {
    throw new Error(`queue.cancel: entry "${entryId}" is in_progress; pause the queue first`);
  }
  return renumber({ ...file, entries: file.entries.filter((e) => e.id !== entryId) });
}

/** Bulk-clear the queue. By default drops every `queued` + `failed` entry but
 *  KEEPS `in_progress` ones (the user wants a clean pending list, not to abort
 *  chapters mid-render). `force` drops everything, including `in_progress` — the
 *  caller pairs this with a stream teardown (chapters/requestStreamHalt) so the
 *  live SSE actually stops. Leaves the `paused` flag untouched (a clear is not a
 *  pause). Idempotent on an empty queue. */
export function clearQueue(file: QueueFile, opts?: { force?: boolean }): QueueFile {
  return renumber({
    ...file,
    entries: opts?.force ? [] : file.entries.filter((e) => e.status === 'in_progress'),
  });
}

/** Set the queue-global pause flag. */
export function setPaused(file: QueueFile, paused: boolean): QueueFile {
  return { ...file, paused };
}

/** Mark a specific entry as in_progress WITHOUT reordering — the status-only
 *  transition the queue-sole-concurrency dispatcher uses when it claims an
 *  entry to run. Multiple entries can be in_progress at once (one per worker),
 *  so this neither pins to order 0 nor enforces a single-in-flight invariant.
 *  Idempotent: marking an already-in_progress entry is a no-op; a missing
 *  entry id is a no-op (the snapshot caught up / the entry was cancelled). */
export function markInProgress(file: QueueFile, entryId: string): QueueFile {
  return {
    ...file,
    entries: file.entries.map(
      (e): QueueEntry => (e.id === entryId ? { ...e, status: 'in_progress' } : e),
    ),
  };
}

/** LEGACY single-in-flight start (pre-refactor): marks the entry in_progress
 *  AND pins it to order=0, throwing if another entry is already in_progress.
 *  Superseded by `markInProgress` under queue-sole concurrency (which allows N
 *  concurrent in-flight entries and never reorders). Retained for the unit
 *  tests that pin its FIFO/pin behaviour; not wired to any route. */
export function startEntry(file: QueueFile, entryId: string): QueueFile {
  const inFlight = file.entries.find((e) => e.status === 'in_progress');
  if (inFlight && inFlight.id !== entryId) {
    throw new Error(
      `queue.startEntry: cannot start "${entryId}" while "${inFlight.id}" is in_progress`,
    );
  }
  const next = file.entries.map(
    (e): QueueEntry => (e.id === entryId ? { ...e, status: 'in_progress' } : e),
  );
  /* Pin the in-flight to order=0 by moving it to the head. */
  const target = next.find((e) => e.id === entryId);
  if (!target) {
    throw new Error(`queue.startEntry: entry "${entryId}" not found`);
  }
  const rest = next.filter((e) => e.id !== entryId);
  return renumber({ ...file, entries: [target, ...rest] });
}

/** Mark an entry as done/failed and remove it from the active queue.
 *  Failed entries linger for the user to inspect; done entries are
 *  pruned so the modal doesn't accumulate completed work indefinitely.
 *  Done-pruning matches the user's mental model: the modal shows what's
 *  pending, not a history. */
export function completeEntry(
  file: QueueFile,
  entryId: string,
  outcome: 'done' | 'failed',
  errorReason?: string,
): QueueFile {
  /* Loud-fallback gate guard: NEVER complete a parked entry. When the worker
     parks a chapter on `awaiting_confirm` and returns, its SSE stream closes —
     the frontend dispatcher's reconcile then POSTs /complete, and the server's
     srv-16 done-flip is shaped to fire only on chapter_complete (which a parked
     chapter never emits). Both ultimately call here; a no-op for an
     `awaiting_confirm` entry keeps the parked row alive until the user
     confirms (→ queued) or skips (→ removed). */
  const target = file.entries.find((e) => e.id === entryId);
  if (target?.status === 'awaiting_confirm') return file;
  if (outcome === 'done') {
    return renumber({ ...file, entries: file.entries.filter((e) => e.id !== entryId) });
  }
  const next = file.entries.map(
    (e): QueueEntry =>
      e.id === entryId
        ? {
            ...e,
            status: 'failed',
            errorReason: errorReason ?? null,
          }
        : e,
  );
  return renumber({ ...file, entries: next });
}

/** Retry a failed entry — flip it back to `queued` and clear its
 *  `errorReason`/`progress` so the dispatcher re-claims it. No-op (returns the
 *  file unchanged) for a missing entry or one that isn't `failed`, so a
 *  double-click or a stale id can't disturb a running/queued entry. */
export function retry(file: QueueFile, entryId: string): QueueFile {
  const target = file.entries.find((e) => e.id === entryId);
  if (!target || target.status !== 'failed') return file;
  const next = file.entries.map(
    (e): QueueEntry =>
      e.id === entryId ? { ...e, status: 'queued', errorReason: null, progress: undefined } : e,
  );
  return renumber({ ...file, entries: next });
}

/** Park an in-flight entry on the loud-fallback gate: `in_progress →
 *  awaiting_confirm`, stamping the characters that would fall back to Kokoro.
 *  The worker calls this (instead of rendering) when it detects an
 *  undesigned-voice fallback set. No-op (returns the file unchanged) unless the
 *  entry exists and is `in_progress`, so a stale/raced id can't disturb another
 *  entry. Order is preserved. */
export function markAwaitingConfirm(
  file: QueueFile,
  entryId: string,
  fallbackCharacters: Array<{ id: string; name?: string }>,
): QueueFile {
  const target = file.entries.find((e) => e.id === entryId);
  if (!target || target.status !== 'in_progress') return file;
  return {
    ...file,
    entries: file.entries.map(
      (e): QueueEntry =>
        e.id === entryId
          ? { ...e, status: 'awaiting_confirm', fallbackCharacters, progress: undefined }
          : e,
    ),
  };
}

/** Confirm the fallback for a parked entry: `awaiting_confirm → queued` with
 *  `fallbackConfirmed: true` so the dispatcher re-claims it and the worker
 *  renders straight through (no re-prompt). No-op unless the entry is
 *  `awaiting_confirm`. Clears `progress`. */
export function confirmFallback(file: QueueFile, entryId: string): QueueFile {
  const target = file.entries.find((e) => e.id === entryId);
  if (!target || target.status !== 'awaiting_confirm') return file;
  return renumber({
    ...file,
    entries: file.entries.map(
      (e): QueueEntry =>
        e.id === entryId
          ? { ...e, status: 'queued', fallbackConfirmed: true, progress: undefined }
          : e,
    ),
  });
}

/** Skip a parked entry: drop it from the queue entirely (the chapter is
 *  intentionally NOT rendered). Same done-prune as `completeEntry(…, 'done')`.
 *  No-op unless the entry is `awaiting_confirm`. */
export function skipFallback(file: QueueFile, entryId: string): QueueFile {
  const target = file.entries.find((e) => e.id === entryId);
  if (!target || target.status !== 'awaiting_confirm') return file;
  return renumber({ ...file, entries: file.entries.filter((e) => e.id !== entryId) });
}

/** Update progress on the in-flight entry. Cheap mutator the frontend
 *  calls (via the queue route) on every progress tick. */
export function updateProgress(file: QueueFile, entryId: string, progress: number): QueueFile {
  const next = file.entries.map((e): QueueEntry => (e.id === entryId ? { ...e, progress } : e));
  return { ...file, entries: next };
}

/** Prune every entry whose `bookId` matches — used by the book-delete
 *  route to drop stale entries when a book directory is removed. Atomic
 *  alongside the directory drop (same write transaction). */
export function pruneByBook(file: QueueFile, bookId: string): QueueFile {
  return renumber({
    ...file,
    entries: file.entries.filter((e) => e.bookId !== bookId),
  });
}

/** Reset every `in_progress` entry back to `queued` — the server-boot orphan
 *  sweep. A server restart kills all in-flight synthesis (the server owns the
 *  generation SSE), so any entry left `in_progress` on disk is an orphan with
 *  no live stream behind it. Left as-is the frontend dispatcher would neither
 *  re-run it (FILL claims only `queued` entries) nor reconcile it (its
 *  in-memory inFlight map is empty on a fresh boot), wedging that chapter
 *  forever. Other statuses (queued / failed / done / paused) are untouched.
 *  Order is preserved (renumber keeps the contiguous-order invariant). */
export function resetInProgressToQueued(file: QueueFile): QueueFile {
  return renumber({
    ...file,
    entries: file.entries.map(
      (e): QueueEntry => (e.status === 'in_progress' ? { ...e, status: 'queued' } : e),
    ),
  });
}

/** Reset a SINGLE `in_progress` entry back to `queued` — the SSE
 *  last-subscriber-disconnect orphan recovery (srv-12). When the last
 *  subscriber to a generation SSE closes BEFORE the frontend POSTed
 *  /complete, the in-flight chapter's queue entry is an orphan: nobody is
 *  watching the run and the server aborts the now-unwatched synthesis, so the
 *  entry must go back to `queued` for the dispatcher to re-claim. Guarded to a
 *  single id and a no-op unless that entry is `in_progress` — a missing id or a
 *  done/queued/failed entry is returned unchanged so we never resurrect a
 *  finished entry or fight the frontend-owned lifecycle. Order is preserved. */
export function resetEntryToQueued(file: QueueFile, entryId: string): QueueFile {
  const target = file.entries.find((e) => e.id === entryId);
  if (!target || target.status !== 'in_progress') return file;
  return renumber({
    ...file,
    entries: file.entries.map(
      (e): QueueEntry => (e.id === entryId ? { ...e, status: 'queued' } : e),
    ),
  });
}

/** Recompute `order` to be contiguous 0..N-1 after any mutation. The
 *  in_progress entry (if present) stays at order=0; the rest follow in
 *  their current array order. */
function renumber(file: QueueFile): QueueFile {
  return {
    ...file,
    entries: file.entries.map((e, i) => ({ ...e, order: i })),
  };
}
