/* Workspace-level chapter-generation queue routes (plan 102).
 *
 * The queue is a single file at <workspace>/.queue.json that holds every
 * pending / in-flight / failed chapter-generation entry across every book.
 * The frontend's queue-slice middleware is the dispatcher — it POSTs
 * /api/books/{bookId}/generation with the next entry's chapterIds + the
 * entry's id (carried back via the resume_from ack) and watches the SSE
 * to decide when to pop the next entry.
 *
 * Routes:
 *   GET    /api/queue                  — read full queue + paused flag
 *   POST   /api/queue/enqueue          — append entries (forward expanded by client)
 *   POST   /api/queue/reorder          — set the order of non-pinned entries
 *   POST   /api/queue/pause            — toggle queue-global paused flag
 *   POST   /api/queue/clear            — bulk-clear (queued+failed; force = all)
 *   POST   /api/queue/:entryId/start   — mark an entry in_progress (no reorder)
 *   POST   /api/queue/:entryId/complete — drop a finished entry (done-prune)
 *   DELETE /api/queue/:entryId         — cancel a QUEUED entry (409 if in_progress)
 *
 * Queue-sole concurrency (plan-111 refactor): the dispatcher claims one entry
 * per worker and POSTs `/start` to flip it to in_progress, then POSTs
 * `/complete` once that chapter's stream closes — multiple entries are
 * in_progress at once, so removal-on-completion can't go through the
 * user-facing DELETE (which still 409s on an in_progress entry so the modal's
 * cancel button keeps its "pause first" guard). updateProgress remains a
 * queue-io helper without a route. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { queueJsonPath } from '../workspace/paths.js';
import { readQueueFile, writeQueueFile } from '../workspace/queue-migrate.js';
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';
import {
  cancel,
  clearQueue,
  completeEntry,
  confirmFallback,
  enqueue,
  markInProgress,
  reorder,
  retry,
  setPaused,
  skipFallback,
  type EnqueueInput,
  type QueueScope,
} from '../workspace/queue-io.js';
import { resolveChapterEngineStamp } from '../workspace/queue-engine-stamp.js';

export const queueRouter = Router();

const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isScope = (v: unknown): v is QueueScope => v === 'this' || v === 'character';

queueRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const file = await readQueueFile(queueJsonPath());
    const supervisor = getActiveSupervisor();
    const recycling = supervisor != null && supervisor.recycling() === true;
    res.json({ entries: file.entries, paused: file.paused, recycling });
  } catch (e) {
    console.error('[queue] GET failed', e);
    res.status(500).json({ error: (e as Error).message });
  }
});

interface EnqueueRequestBody {
  /* Frontend mints unique ids per entry; passing them in keeps tests
     deterministic and lets the broadcast layer correlate ticks to
     entries without a server-issued id round-trip. */
  entries?: unknown;
}

interface EnqueueRequestEntry {
  id?: unknown;
  bookId?: unknown;
  chapterId?: unknown;
  scope?: unknown;
  characterId?: unknown;
  addedAt?: unknown;
}

queueRouter.post('/enqueue', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as EnqueueRequestBody;
  const raw = Array.isArray(body.entries) ? (body.entries as EnqueueRequestEntry[]) : null;
  if (!raw || raw.length === 0) {
    return res.status(400).json({ error: 'entries[] required and non-empty' });
  }
  const inputs: EnqueueInput[] = [];
  for (const r of raw) {
    if (!isString(r.id) || !isString(r.bookId) || !isInt(r.chapterId) || !isScope(r.scope)) {
      return res.status(400).json({
        error:
          'each entry needs string id + string bookId + integer chapterId + scope ("this" | "character")',
      });
    }
    if (r.scope === 'character' && !isString(r.characterId)) {
      return res.status(400).json({
        error: `entry "${r.id}": scope === "character" requires string characterId`,
      });
    }
    inputs.push({
      id: r.id,
      bookId: r.bookId,
      chapterId: r.chapterId,
      scope: r.scope,
      ...(isString(r.characterId) ? { characterId: r.characterId } : {}),
      ...(isString(r.addedAt) ? { addedAt: r.addedAt } : {}),
    });
  }
  /* Plan 108 Wave 3 — stamp each entry with the TTS engines its chapter needs
     (cast + analysis cache + book default), so the queue modal can name the
     engine(s) and warn on a multi-TTS chapter when dual-model mode is off.
     Best-effort: a resolver throw / missing cast leaves the fields off (legacy
     / unknown) rather than failing the enqueue. */
  await Promise.all(
    inputs.map(async (input) => {
      try {
        const stamp = await resolveChapterEngineStamp(input.bookId, input.chapterId);
        if (stamp) {
          input.requiredEngines = stamp.requiredEngines;
          input.multiTts = stamp.multiTts;
        }
      } catch (e) {
        console.warn('[queue] engine-stamp failed for "%s"', input.id, e);
      }
    }),
  );
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = enqueue(before, inputs);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    /* Duplicate-id rejection from enqueue() lands here. The frontend
       should re-mint and retry; surface 409 so it knows the difference
       from a 500. */
    res.status(409).json({ error: (e as Error).message });
  }
});

interface ReorderRequestBody {
  order?: unknown;
}

queueRouter.post('/reorder', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ReorderRequestBody;
  if (!Array.isArray(body.order) || !body.order.every(isString)) {
    return res.status(400).json({ error: 'order must be a string[] of entry ids' });
  }
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = reorder(before, body.order as string[]);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    /* Mismatch = client raced a concurrent enqueue. 409 so the
       frontend can refetch + retry without surfacing as a 500. */
    res.status(409).json({ error: (e as Error).message });
  }
});

interface PauseRequestBody {
  paused?: unknown;
}

queueRouter.post('/pause', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as PauseRequestBody;
  if (typeof body.paused !== 'boolean') {
    return res.status(400).json({ error: 'paused must be a boolean' });
  }
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = setPaused(before, body.paused);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

interface ClearRequestBody {
  force?: unknown;
}

/* Bulk-clear the queue. `{ force: false }` (default) drops queued + failed
   entries but leaves in_progress ones running; `{ force: true }` drops
   everything (the frontend pairs force with a stream halt so the live SSE
   actually stops). Declared before `/:entryId` so the literal path wins. */
queueRouter.post('/clear', async (req: Request, res: Response) => {
  const body = (req.body ?? {}) as ClearRequestBody;
  const force = body.force === true;
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = clearQueue(before, { force });
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/* Mark an entry in_progress — the dispatcher fires this the instant it claims
   an entry and opens that chapter's stream (one entry = one chapter actively
   starting). Status-only, no reorder: with N concurrent workers multiple
   entries are in_progress at once, so pinning to order 0 would be wrong.
   Idempotent (already-in_progress / missing id both succeed) so a retried
   claim or a stale snapshot can't 4xx. */
queueRouter.post('/:entryId/start', async (req: Request, res: Response) => {
  const { entryId } = req.params;
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = markInProgress(before, entryId);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/* Drop a finished entry from the queue — the dispatcher's reconcile fires this
   once a chapter's stream closes. Unlike DELETE (user cancel, refuses an
   in_progress entry), completion removal is status-agnostic: the entry IS
   in_progress at this point. Done-prune so the modal shows only pending work.
   Idempotent for a missing id (the snapshot already caught up). */
queueRouter.post('/:entryId/complete', async (req: Request, res: Response) => {
  const { entryId } = req.params;
  /* Body `{ outcome: 'done' | 'failed', errorReason? }`. Default `done` for
     back-compat (the dispatcher's success path sends no body). `failed` marks
     the entry `failed` (it LINGERS for retry) instead of done-pruning it. */
  const body = (req.body ?? {}) as { outcome?: unknown; errorReason?: unknown };
  const outcome = body.outcome === 'failed' ? 'failed' : 'done';
  const errorReason = typeof body.errorReason === 'string' ? body.errorReason : undefined;
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = completeEntry(before, entryId, outcome, errorReason);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/* POST /api/queue/:entryId/retry — re-queue a FAILED entry (status → queued,
   clears errorReason) so the dispatcher re-claims it. No-op for a missing or
   non-failed entry. */
queueRouter.post('/:entryId/retry', async (req: Request, res: Response) => {
  const { entryId } = req.params;
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = retry(before, entryId);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/* POST /api/queue/:entryId/confirm-fallback — the user confirms a parked
   chapter's Qwen→Kokoro fallback (status awaiting_confirm → queued,
   fallbackConfirmed=true) so the dispatcher re-claims it and the worker renders
   straight through. No-op (idempotent 200) unless the entry is awaiting_confirm
   — a double-click or stale id returns the current snapshot. */
queueRouter.post('/:entryId/confirm-fallback', async (req: Request, res: Response) => {
  const { entryId } = req.params;
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = confirmFallback(before, entryId);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

/* POST /api/queue/:entryId/skip-fallback — the user skips a parked chapter
   rather than render it in Kokoro (status awaiting_confirm → removed). No-op
   (idempotent 200) unless the entry is awaiting_confirm. */
queueRouter.post('/:entryId/skip-fallback', async (req: Request, res: Response) => {
  const { entryId } = req.params;
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = skipFallback(before, entryId);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

queueRouter.delete('/:entryId', async (req: Request, res: Response) => {
  const { entryId } = req.params;
  /* `?force=true` drops even an in_progress entry — the escape hatch for a
     stuck/orphaned in_progress row that the dispatcher won't reconcile or
     re-claim (so Pause-then-cancel can't reach it). Any still-live stream for
     the chapter just idles into a no-op reconcile against the now-gone id. */
  const force = req.query.force === 'true';
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = cancel(before, entryId, { force });
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    /* in_progress rejection from cancel() (force not set) — 409 because the
       user must Pause first for a normally-cancellable in-flight entry. */
    res.status(409).json({ error: (e as Error).message });
  }
});
