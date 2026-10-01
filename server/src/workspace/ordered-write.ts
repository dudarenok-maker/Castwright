/* #3427 — `writeJsonAtomic` that lands in CALL order per path. Lives beside
   (not inside) state-io so its `writeJsonAtomic` reference goes through the
   module boundary, which keeps the write stubbable in tests. */

import { enqueuePathOp, writeJsonAtomic } from './state-io.js';

export async function writeJsonAtomicOrdered(path: string, value: unknown): Promise<void> {
  await enqueuePathOp(path, () => writeJsonAtomic(path, value));
}
