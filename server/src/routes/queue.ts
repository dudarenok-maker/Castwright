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
 *   GET    /api/queue                — read full queue + paused flag
 *   POST   /api/queue/enqueue        — append entries (forward expanded by client)
 *   POST   /api/queue/reorder        — set the order of non-pinned entries
 *   POST   /api/queue/pause          — toggle queue-global paused flag
 *   DELETE /api/queue/:entryId       — cancel a queued entry
 *
 * Two additional mutators (startEntry, completeEntry, updateProgress) live
 * on the queue-io helpers but are not exposed as routes — they're called
 * by the generation route directly as it advances the queue. */

import { Router, type Request, type Response } from 'express';
import { queueJsonPath } from '../workspace/paths.js';
import { readQueueFile, writeQueueFile } from '../workspace/queue-migrate.js';
import {
  cancel,
  enqueue,
  reorder,
  setPaused,
  type EnqueueInput,
  type QueueScope,
} from '../workspace/queue-io.js';

export const queueRouter = Router();

const isString = (v: unknown): v is string => typeof v === 'string';
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isScope = (v: unknown): v is QueueScope => v === 'this' || v === 'character';

queueRouter.get('/', async (_req: Request, res: Response) => {
  try {
    const file = await readQueueFile(queueJsonPath());
    res.json({ entries: file.entries, paused: file.paused });
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

queueRouter.delete('/:entryId', async (req: Request, res: Response) => {
  const { entryId } = req.params;
  try {
    const before = await readQueueFile(queueJsonPath());
    const after = cancel(before, entryId);
    await writeQueueFile(queueJsonPath(), after);
    res.json({ entries: after.entries, paused: after.paused });
  } catch (e) {
    /* in_progress rejection from cancel() — 409 because the user must
       Pause first. */
    res.status(409).json({ error: (e as Error).message });
  }
});
