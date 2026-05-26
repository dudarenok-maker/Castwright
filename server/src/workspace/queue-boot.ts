/* Server-boot sweep for the workspace chapter-generation queue.
 *
 * A server restart / crash / browser reload can leave queue entries stuck in
 * `in_progress` on disk with no live stream behind them. The frontend
 * dispatcher (src/store/queue-dispatcher-middleware.ts) is the sole
 * stream-opener: on a fresh boot its in-memory `inFlight` map is empty, so it
 * neither reconciles those orphans (STEP 1 only walks its own map) nor
 * re-runs them (STEP 2 FILL claims only `queued` entries). The chapter then
 * appears "generating" forever while the GPU sits idle — the wedge this sweep
 * unblocks.
 *
 * Flipping orphaned `in_progress` → `queued` on boot is safe because a server
 * restart kills all in-flight synthesis (the server owns the generation SSE);
 * any entry still `in_progress` at boot is definitionally orphaned. The sweep
 * runs once, on the server, before it accepts requests — a frontend cold-boot
 * reclaim would be unsafe because two browser tabs each run the dispatcher
 * with independent in-memory maps and would double-claim. */

import { queueJsonPath } from './paths.js';
import { readQueueFile, writeQueueFile } from './queue-migrate.js';
import { resetInProgressToQueued } from './queue-io.js';

/** Reset orphaned `in_progress` queue entries back to `queued`. Reads +
 *  rewrites <workspace>/.queue.json. No-ops (no write) when nothing is
 *  in_progress or the file is absent (readQueueFile returns an empty queue).
 *  Returns the number of entries reset. Never throws on a malformed/missing
 *  file beyond what readQueueFile surfaces — callers should still guard with
 *  .catch so a queue read error can't block server startup. */
export async function resetOrphanedQueueEntries(): Promise<{ reset: number }> {
  const path = queueJsonPath();
  const before = await readQueueFile(path);
  const orphaned = before.entries.filter((e) => e.status === 'in_progress').length;
  if (orphaned === 0) return { reset: 0 };
  await writeQueueFile(path, resetInProgressToQueued(before));
  return { reset: orphaned };
}
