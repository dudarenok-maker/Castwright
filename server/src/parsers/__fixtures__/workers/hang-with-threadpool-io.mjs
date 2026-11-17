/* Writes into the per-parse scratch dir, starts long async threadpool work
   (async pbkdf2), then hangs. worker.terminate() only resolves once that
   in-flight work finishes (~1s+), so a caller bounded by terminate() would
   reject far past its timeout. */
import { pbkdf2 } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { workerData } from 'node:worker_threads';

const dir = join(workerData.scratchDir, 'threadpool-leak');
mkdirSync(dir);
writeFileSync(join(dir, 'book.bin'), 'x');
for (let i = 0; i < 4; i++) pbkdf2('pw', 'salt', 2_000_000, 64, 'sha512', () => {});
setInterval(() => {}, 1000);
