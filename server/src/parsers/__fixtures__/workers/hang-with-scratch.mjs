/* Writes into the per-parse scratch dir, then hangs; only the main thread's
   timeout can stop it. */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerData } from 'node:worker_threads';

const dir = join(workerData.scratchDir, 'mobi-resources-leak');
mkdirSync(dir);
writeFileSync(join(dir, 'book.bin'), 'x');
setInterval(() => {}, 1000);
