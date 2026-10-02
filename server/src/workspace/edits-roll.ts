/* The interim manuscript-edits.json roll shared by the main and subset analysis
   routes (#3427). `buildRunning` is called inside the verified-dir callback — see below. */

import { withVerifiedBookDir, type WithVerifiedBookDirOpts } from './book-dir-guard.js';
import { manuscriptEditsJsonPath } from './paths.js';
import { writeJsonAtomicOrdered } from './ordered-write.js';

export async function rollManuscriptEdits(
  opts: WithVerifiedBookDirOpts,
  buildRunning: () => unknown[],
): Promise<void> {
  await withVerifiedBookDir(opts, async (bookDir) => {
    /* `withVerifiedBookDir` awaits a state.json read (with a sleeping retry on a
       transient failure) before this callback runs, so rolls reach here in
       verification-completion order, not call order. Build the snapshot HERE,
       immediately before the ordered write, so the snapshot and the queue
       position are one synchronous step: whichever roll joins the queue last
       also holds the freshest snapshot. */
    const running = buildRunning();
    await writeJsonAtomicOrdered(manuscriptEditsJsonPath(bookDir), { sentences: running });
  });
}
