/* #3427 — `writeJsonAtomic` that lands in CALL order per path. Lives beside
   (not inside) state-io so its `writeJsonAtomic` reference goes through the
   module boundary, which keeps the write stubbable in tests. */

import { enqueuePathOp, writeJsonAtomic } from './state-io.js';

/* The payload is serialised at CALL time: the queue can delay the actual
   write behind earlier ops, and a nested member the caller mutates in place
   in the meantime must not leak into this write's bytes.
   `opts.skip` (#3437, opt-in) is evaluated FIRST inside the queued op, after every
   earlier op on the path has finished; true skips the write. */
export async function writeJsonAtomicOrdered(
  path: string,
  value: unknown,
  opts?: { skip?: () => boolean },
): Promise<void> {
  const snapshot: unknown = JSON.parse(JSON.stringify(value));
  await enqueuePathOp(path, async () => {
    if (opts?.skip?.()) return;
    await writeJsonAtomic(path, snapshot);
  });
}
