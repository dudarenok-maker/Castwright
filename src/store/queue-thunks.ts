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

import type { AppDispatch } from './index';
import { queueActions, type QueueEntry, type QueueScope } from './queue-slice';
import { notificationsActions } from './notifications-slice';

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
  addedAt?: string;
}

interface QueueSnapshotResponse {
  entries: QueueEntry[];
  paused: boolean;
}

async function readSnapshot(res: Response): Promise<QueueSnapshotResponse> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<QueueSnapshotResponse>;
}

/** GET /api/queue — cold-boot hydrate. Mount-time effect in Layout should
    call this once on app start so the modal renders the persisted queue
    even across hard reload / server bounce. */
export function loadQueue() {
  return async (dispatch: AppDispatch): Promise<void> => {
    const res = await fetch('/api/queue');
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
  };
}

/** POST /api/queue/enqueue — append one or more entries. The 10 regenerate
    trigger sites funnel through here (Wave 4). Pops a toast with the new
    count + a "View queue" CTA. */
export function enqueueQueueEntries(entries: EnqueueInput[]) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await fetch('/api/queue/enqueue', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    const count = snapshot.entries.length;
    dispatch(
      notificationsActions.pushToast({
        kind: 'info',
        message: `Added to queue · ${count} ${count === 1 ? 'entry' : 'entries'} pending.`,
        dedupeKey: 'queue-enqueue',
      }),
    );
    return snapshot;
  };
}

/** POST /api/queue/reorder — move non-pinned entries to the desired order.
    The modal calls this on drop / tap-pill release. */
export function reorderQueue(desiredOrder: string[]) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await fetch('/api/queue/reorder', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ order: desiredOrder }),
    });
    const snapshot = await readSnapshot(res);
    dispatch(queueActions.setSnapshot(snapshot));
    return snapshot;
  };
}

/** POST /api/queue/pause — flip the queue-global pause flag. The relocated
    Resume/Pause control inside the modal calls this. */
export function setQueuePaused(paused: boolean) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await fetch('/api/queue/pause', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paused }),
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
    structured error keeps the flow self-explanatory. */
export function cancelQueueEntry(entryId: string) {
  return async (dispatch: AppDispatch): Promise<QueueSnapshotResponse> => {
    const res = await fetch(`/api/queue/${encodeURIComponent(entryId)}`, { method: 'DELETE' });
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
    return snapshot;
  };
}
