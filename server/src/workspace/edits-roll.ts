/* The interim manuscript-edits.json roll shared by the main and subset analysis
   routes (#3427). `buildRunning` is called inside the verified-dir callback — see below. */

import { withVerifiedBookDir, type WithVerifiedBookDirOpts } from './book-dir-guard.js';
import { withBookLock } from './book-lock.js';
import { manuscriptEditsJsonPath } from './paths.js';
import { writeJsonAtomicOrdered } from './ordered-write.js';

export async function rollManuscriptEdits(
  opts: WithVerifiedBookDirOpts,
  buildRunning: () => unknown[],
  bookId?: string,
): Promise<void> {
  await withVerifiedBookDir(opts, async (bookDir) => {
    /* `withVerifiedBookDir` awaits a state.json read (with a sleeping retry on a
       transient failure) before this callback runs, so rolls reach here in
       verification-completion order, not call order. Build the snapshot HERE,
       immediately before the ordered write, so the snapshot and the queue
       position are one synchronous step: whichever roll joins the queue last
       also holds the freshest snapshot. */
    const roll = async (): Promise<void> => {
      const running = buildRunning();
      await writeJsonAtomicOrdered(manuscriptEditsJsonPath(bookDir), { sentences: running });
    };
    /* #3784 — the write is `book`-locked, shared with the slice PUT's manuscript
       revision check + write, so a roll cannot land between them. The analysis
       job holds no lock here (order `cast` -> `book`); the lock is FIFO, so rolls
       still join the queue in the order they reach it. A record with no bookId
       (legacy) has no lock key; roll unlocked as before. */
    if (bookId) await withBookLock(bookId, roll);
    else await roll();
  });
}
