/* Plan 102 — workspace queue CRUD thunks.
 *
 * Wrap the /api/queue/* routes (server side: server/src/routes/queue.ts) and
 * dispatch the resulting snapshot back to queue-slice. Every thunk follows
 * the same shape:
 *   1. POST/GET/DELETE the route.
 *   2. Parse response { entries, paused }.
 *   3. Dispatch queueActions.setSnapshot(...).
 *   4. Fire a notifications toast on enqueue (mirrors the spec — "Added to
 *      queue · n entries pending" with a "View queue" CTA).
 *
 * All thunks throw on non-2xx; callers wrap in try/catch when they want to
 * surface a specific error UI (the existing 10 regenerate sites already
 * have error-handling wrappers — they'll route their existing flows into
 * `enqueueQueueEntries` in Wave 4). */

import type { AppDispatch, RootState } from './index';
import { queueActions, type QueueEntry, type QueueScope } from './queue-slice';
import type { TtsModelKey } from '../lib/types';
import { notificationsActions } from './notifications-slice';
import { chaptersActions } from './chapters-slice';
import { mockQueueRequest } from '../mocks/mock-queue';
import { api } from '../lib/api';
import { selectAnalysisBusyForBook, analysisBusyMessage } from './analysis-substage-selectors';

/* Plan 111 — the persisted queue drives generation, so mock mode (dev app +
   e2e) needs a working queue with no backend. Route through the in-memory
   mock-queue when VITE_USE_MOCKS, else the real /api/queue/* routes. The
   mock returns a fetch-Response-like object so `readSnapshot` is unchanged. */
const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';

function queueRequest(
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<Response> {
  if (USE_MOCKS) return Promise.resolve(mockQueueRequest(path, init) as unknown as Response);
  return fetch(path, init);
}

export interface EnqueueInput {
  /** Frontend-minted unique id. Deterministic for tests; in production we
      use a crypto.randomUUID() prefixed by the source ("regen-modal-...") for
      easier debugging. */
  id: string;
  bookId: string;
  chapterId: number;
  scope: QueueScope;
  /** Required when scope === 'character'. */
  characterId?: string;
  /** Optional per-entry TTS model override (regenerate at a chosen quality
      tier, e.g. Qwen 1.7B). Absent → the dispatcher uses `ui.ttsModelKey`. */
  modelKey?: TtsModelKey;
  addedAt?: string;
}

interface QueueSnapshotResponse {
  entries: QueueEntry[];
  paused: boolean;
  recycling?: boolean;
}

async function readSnapshot(res: Response): Promise<QueueSnapshotResponse> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<QueueSnapshotResponse>;
}

/** Build a QueueSnapshotResponse from the live queue slice — used when all
    entries are gated so we can early-return without a network call.
    The server rejects an empty entries[] with 400, so we MUST NOT post it. */
function snapshotFromState(state: RootState): QueueSnapshotResponse {
  return {
    entries: state.queue.entries,
    paused: state.queue.paused,
    recycling: state.queue.recycling,
  };
}

/** GET /api/queue — cold-boot hydrate. Mount-time effect in Layout should
    call this once on app start so the modal renders the persisted queue
    even across hard reload / server bounce. */
export function loadQueue() {
  return async (dispatch: AppDispatch): Promise<void> => {
    const res = await queueRequest('/api/queue');
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
  };
}

/** POST /api/queue/enqueue — append one or more entries. The regenerate
    trigger sites funnel through here and pop a toast with the new count + a
    "View queue" CTA. Pass `{ silent: true }` (plan 111 enqueue-on-work) to
    suppress the toast — the auto-enqueue of a resumed/first run is not a
    user-initiated "Added to queue" action. */
export function enqueueQueueEntries(entries: EnqueueInput[], opts: { silent?: boolean } = {}) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<QueueSnapshotResponse> => {
    const state = getState();
    const allowed = entries.filter((e) => !selectAnalysisBusyForBook(state, e.bookId));
    const gated = entries.filter((e) => selectAnalysisBusyForBook(state, e.bookId));
    /* `silent` callers are background work (plan 111 enqueue-on-work auto-resume),
       not a user click — gate their entries the same way, but don't pop a warn
       toast for an action the user didn't initiate (mirrors the info toast below). */
    if (gated.length > 0 && !opts.silent) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message:
            analysisBusyMessage(state, gated[0].bookId) ??
            'Wait — analysis is still running on this book.',
          dedupeKey: 'gen-gated-by-analysis',
        }),
      );
    }
    /* The server rejects entries:[] with 400 ("entries[] required and non-empty"),
       so when every entry is gated we early-return the current snapshot without
       a network call rather than posting an empty array. */
    if (allowed.length === 0) return snapshotFromState(getState());
    const res = await queueRequest('/api/queue/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: allowed }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    if (!opts.silent) {
      const count = snapshot.entries.length;
      dispatch(
        notificationsActions.pushToast({
          kind: 'info',
          message: `Added to queue · ${count} ${count === 1 ? 'entry' : 'entries'} pending.`,
          dedupeKey: 'queue-enqueue',
        }),
      );
    }
    return snapshot;
  };
}

/** POST /api/queue/reorder — move non-pinned entries to the desired order.
    The modal calls this on drop / tap-pill release. */
export function reorderQueue(desiredOrder: string[]) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest('/api/queue/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: desiredOrder }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** Halt the in-flight generation NOW and stop the drain — used by the
    local-analyzer guard when a local analysis needs the GPU that TTS is
    holding. Two parts:
      (a) `requestStreamHalt` — observed by the generation-stream middleware,
          which POSTs /pause and closes the open SSE handle immediately
          (freeing the GPU within the chapter, not at the next boundary); and
      (b) `setQueuePaused(true)` — stops the dispatcher from draining the next
          entry and keeps reconcile from auto-reopening once the analysis owns
          the GPU.
    Replaces the old `chaptersActions.setPaused(true)` single-signal path
    (plan 102 Should #5 removed `chapters.paused`). The user resumes via the
    queue modal's Resume control after the analysis completes. */
export function haltActiveGeneration() {
  return async (dispatch: AppDispatch): Promise<void> => {
    dispatch(chaptersActions.requestStreamHalt());
    await dispatch(setQueuePaused(true)).catch((e: unknown) => {
      console.warn('[queue] haltActiveGeneration: pause failed', e);
    });
  };
}

/** POST /api/queue/pause — flip the queue-global pause flag. The relocated
    Resume/Pause control inside the modal calls this. */
export function setQueuePaused(paused: boolean) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest('/api/queue/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** POST /api/queue/clear — bulk-clear the queue. Default (`force` omitted/false)
    drops queued + failed entries but leaves any in_progress chapter running;
    `{ force: true }` drops everything, including in_progress. The modal's "Clear
    queue" control calls this; when the user opts to also stop generation it
    dispatches `chaptersActions.requestStreamHalt()` (tears the live streams down
    + pauses each book server-side) BEFORE this force-clear. */
export function clearQueue(opts: { force?: boolean } = {}) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest('/api/queue/clear', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ force: opts.force ?? false }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** POST /api/queue/:entryId/start — mark an entry in_progress. The dispatcher
    fires this the instant it claims an entry and opens that chapter's stream
    (one entry = one chapter actively starting; claim == in_progress). Status
    only — no reorder — because N entries can be in_progress at once under
    queue-sole concurrency. Idempotent server-side, so a retried claim is safe;
    failures are logged, not surfaced (the run still proceeds — this only
    affects the modal's In flight / Queued label). */
export function startQueueEntry(entryId: string) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest(`/api/queue/${encodeURIComponent(entryId)}/start`, {
      method: 'POST',
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** POST /api/queue/:entryId/complete — resolve a finished entry. The
    dispatcher's reconcile fires this once a chapter's stream closes. Distinct
    from cancelQueueEntry (user cancel, 409s an in_progress entry): completion
    is status-agnostic because the entry IS in_progress when its chapter
    finishes. Default `done` done-prunes it; `{ outcome: 'failed', errorReason }`
    marks it `failed` so it LINGERS in the queue for retry. */
export function completeQueueEntry(
  entryId: string,
  opts?: { outcome?: 'done' | 'failed'; errorReason?: string },
) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest(`/api/queue/${encodeURIComponent(entryId)}/complete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        outcome: opts?.outcome ?? 'done',
        ...(opts?.errorReason != null ? { errorReason: opts.errorReason } : {}),
      }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** POST /api/queue/:entryId/retry — re-queue a FAILED entry (status → queued).
    The modal's per-row Retry control on a failed entry fires this; the
    dispatcher then re-claims the now-queued entry and re-runs the chapter. */
export function retryQueueEntry(entryId: string) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest(`/api/queue/${encodeURIComponent(entryId)}/retry`, {
      method: 'POST',
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** POST /api/queue/:entryId/confirm-fallback — confirm a parked chapter's
    Qwen→Kokoro fallback (awaiting_confirm → queued, fallbackConfirmed). The
    dispatcher then re-claims it and the worker renders it (in Kokoro) straight
    through. Fired by the modal's "Render anyway" control on an awaiting_confirm
    row. */
export function confirmFallbackEntry(entryId: string) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest(
      `/api/queue/${encodeURIComponent(entryId)}/confirm-fallback`,
      { method: 'POST' },
    );
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** POST /api/queue/:entryId/skip-fallback — skip a parked chapter rather than
    render it in Kokoro (awaiting_confirm → removed). Fired by the modal's
    "Skip" control on an awaiting_confirm row. */
export function skipFallbackEntry(entryId: string) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await queueRequest(`/api/queue/${encodeURIComponent(entryId)}/skip-fallback`, {
      method: 'POST',
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** DELETE /api/queue/:entryId — cancel a queued entry. The modal's per-row
    cancel button calls this. Server 409s if the entry is in_progress; we
    surface a toast in that case rather than re-throwing because the user's
    intent is clear (they wanted to drop the entry) and surfacing a
    structured error keeps the flow self-explanatory.

    `force` appends `?force=true`, which lets the server drop even an
    in_progress entry — the modal's "Remove" control on a stuck/in-flight row
    uses it to clear an orphaned in_progress entry that Pause-then-cancel
    can't reach. */
export function cancelQueueEntry(entryId: string, opts?: { force?: boolean }) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<QueueSnapshotResponse> => {
    /* Capture the entry BEFORE the delete removes it — needed to decide whether
       this cancel should also mark its chapter "Not queued" (held) below. */
    const entry = getState().queue.entries.find((e) => e.id === entryId);

    const qs = opts?.force ? '?force=true' : '';
    const res = await queueRequest(`/api/queue/${encodeURIComponent(entryId)}${qs}`, {
      method: 'DELETE',
    });
    if (res.status === 409) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message: 'Pause the queue before cancelling the in-flight entry.',
          dedupeKey: `queue-cancel-${entryId}`,
        }),
      );
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      throw new Error(body.error ?? '409 entry is in_progress');
    }
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));

    /* Record the user's intent: deleting a chapter-scope entry for a chapter
       that is currently a genuinely-queued, un-rendered row means "don't
       generate this" — flip it to the "Not queued" hold so the row stops
       reading "Queued" and the auto-work resume stops re-enqueuing it (the bug
       this fixes). Guards:
       - `scope === 'this'` only — a `character`-scope splice entry doesn't map
         to a whole-chapter hold.
       - chapter must be `state === 'queued'` in the loaded book — so a
         regenerate ticket on a `done` chapter (or an `in_progress` row) is left
         alone; their audio stays and they must not flip to "Not queued".
       Cross-book entries (not the loaded book) are skipped: their rows aren't
       on screen, and we can't read their chapter state here. */
    if (entry && entry.scope === 'this' && entry.chapterId != null) {
      const chaptersState = getState().chapters;
      const ch =
        chaptersState.currentBookId === entry.bookId
          ? chaptersState.chapters.find((c) => c.id === entry.chapterId)
          : undefined;
      if (ch && ch.state === 'queued' && !ch.held) {
        dispatch(chaptersActions.setChapterHeld({ chapterId: entry.chapterId, held: true }));
        void api.setChapterHeld(entry.bookId, entry.chapterId, true).catch(() => {
          /* best-effort persist; the slice already reflects the hold and the
             next hydrate reconciles if this failed. */
        });
      }
    }

    return snapshot;
  };
}
