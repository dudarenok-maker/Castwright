/* Writes a book-sized file into the per-parse scratch dir (as parseEpub's
   temp file would), then dies on an uncaught throw: its own `finally` never
   runs. The throw message is the test's positive control that the write ran. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerData } from 'node:worker_threads';

const dir = join(workerData.scratchDir, 'epub-leak');
mkdirSync(dir);
writeFileSync(join(dir, 'book.epub'), 'x');
setImmediate(() => {
  throw new Error('boom after scratch write');
});
setInterval(() => {}, 1000);
