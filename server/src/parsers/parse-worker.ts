/* Worker-thread entry for EPUB/MOBI parsing (#4242). Runs one parse and posts
   the outcome back; `parse-in-worker.ts` spawns it. A throw from an epub2
   async callback lands in this thread's own uncaughtException path, never the
   main thread's crash handler. Wraps the parser entry points only: it changes
   no extraction logic. */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { parseEpub } from './epub.js';
import { parseMobi } from './mobi.js';
import type { ParseWorkerRequest, ParseWorkerMessage } from './parse-in-worker.js';

async function run(): Promise<ParseWorkerMessage> {
  const req = workerData as ParseWorkerRequest;
  /* workerData is structured-cloned, so the Buffer arrives as a plain
     Uint8Array. Rewrap it without copying (parseMobi calls readUInt32BE). */
  const u8 = req.buffer as unknown as Uint8Array;
  const buffer = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  try {
    const parsed =
      req.format === 'epub'
        ? await parseEpub(buffer, { fileName: req.fileName, sourcePath: req.sourcePath })
        : await parseMobi(buffer, { fileName: req.fileName });
    return { ok: true, parsed, threadId };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    return { ok: false, error: { name: e.name, message: e.message } };
  }
}

run().then((msg) => parentPort?.postMessage(msg));
