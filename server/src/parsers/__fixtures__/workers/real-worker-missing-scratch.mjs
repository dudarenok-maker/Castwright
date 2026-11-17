/* Points workerData.scratchDir at a directory that does not exist, then runs
   the REAL parse-worker entry. Both parsers must try to write under it and
   fail ENOENT: proves the real worker forwards `scratchDir` to the parsers
   (dropping it falls back to os.tmpdir() and leaks on a crash). Needs the tsx
   loader, which parseInWorker adds for a source-tree run. */
import { join } from 'node:path';
import { workerData } from 'node:worker_threads';

workerData.scratchDir = join(workerData.scratchDir, 'missing');
await import('../../parse-worker.ts');
