/* Worker-thread entry for EPUB/MOBI parsing (#4242). Runs one parse and posts
   the outcome back; `parse-in-worker.ts` spawns it. A throw from an epub2
   async callback lands in this thread's own uncaughtException path, never the
   main thread's crash handler. Wraps the parser entry points only: it changes
   no extraction logic. */
import { parentPort, threadId, workerData } from 'node:worker_threads';
import { parseEpub, UnusableEpubError } from './epub.js';
import { UnusableMediaError } from './errors.js';
import { parseMobi, DrmProtectedError } from './mobi.js';
import type { ParseWorkerRequest, ParseWorkerMessage, SerializedParseError } from './parse-in-worker.js';

async function run(): Promise<ParseWorkerMessage> {
  const req = workerData as ParseWorkerRequest;
  /* workerData is structured-cloned, so the Buffer arrives as a plain
     Uint8Array. Rewrap it without copying (parseMobi calls readUInt32BE). */
  const u8 = req.buffer as unknown as Uint8Array;
  const buffer = Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
  try {
    const parsed =
      req.format === 'epub'
        ? await parseEpub(buffer, {
            fileName: req.fileName,
            sourcePath: req.sourcePath,
            extractorVersion: req.extractorVersion,
            scratchDir: req.scratchDir,
          })
        : await parseMobi(buffer, {
            fileName: req.fileName,
            extractorVersion: req.extractorVersion,
            scratchDir: req.scratchDir,
          });
    return { ok: true, parsed, threadId };
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    /* Most specific class first: DRM and Epub both extend UnusableMediaError. */
    const kind: SerializedParseError['kind'] =
      e instanceof DrmProtectedError
        ? 'DrmProtectedError'
        : e instanceof UnusableEpubError
          ? 'UnusableEpubError'
          : e instanceof UnusableMediaError
            ? 'UnusableMediaError'
            : 'Error';
    const error: SerializedParseError = { kind, name: e.name, message: e.message, stack: e.stack };
    const f = e as Error & { code?: unknown; syscall?: unknown; path?: unknown; errno?: unknown };
    if (typeof f.code === 'string') error.code = f.code;
    if (typeof f.syscall === 'string') error.syscall = f.syscall;
    if (typeof f.path === 'string') error.path = f.path;
    if (typeof f.errno === 'number') error.errno = f.errno;
    return { ok: false, error };
  }
}

run().then((msg) => parentPort?.postMessage(msg));
