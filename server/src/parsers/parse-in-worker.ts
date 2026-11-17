/* Main-thread spawner for the EPUB/MOBI parse worker (#4242). One worker per
   parse, terminated once it settles. The buffer is COPIED into the worker
   (plain workerData), never transferred: routes/import.ts keeps using the
   original buffer after the parse. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ParsedManuscript } from './index.js';

export interface ParseWorkerRequest {
  format: 'epub' | 'mobi';
  buffer: Buffer;
  fileName?: string;
  sourcePath?: string;
}

export type ParseWorkerMessage =
  | { ok: true; parsed: ParsedManuscript; threadId: number }
  | { ok: false; error: { name: string; message: string } };

export interface ParseInWorkerOptions {
  /** Test seam: run a different worker entry. */
  workerUrl?: URL;
}

/** Resolve the worker entry beside this module. From source (`.ts`: vitest or
    tsx) the worker needs tsx's loader because plain Node cannot resolve the
    `.js` sibling specifiers to `.ts`; tsx is skipped when the parent already
    registered it (tsx watch). From compiled output (`.js`) no flags are needed,
    so tsx is never required in production. */
function resolveWorker(): { url: URL; execArgv: string[] } {
  const base = [...process.execArgv];
  if (!import.meta.url.endsWith('.ts')) {
    return { url: new URL('./parse-worker.js', import.meta.url), execArgv: base };
  }
  const url = new URL('./parse-worker.ts', import.meta.url);
  if (base.some((a) => a.includes('tsx'))) return { url, execArgv: base };
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return { url, execArgv: [...base, '--import', loader] };
}

export async function parseInWorker(
  request: ParseWorkerRequest,
  opts: ParseInWorkerOptions = {},
): Promise<ParsedManuscript> {
  const parsed = await parseInWorkerWithThread(request, opts);
  return parsed.parsed;
}

/** Same as parseInWorker but also reports the worker's threadId (tests use it
    to prove the parse left the main thread). */
export function parseInWorkerWithThread(
  request: ParseWorkerRequest,
  opts: ParseInWorkerOptions = {},
): Promise<{ parsed: ParsedManuscript; threadId: number }> {
  const resolved = resolveWorker();
  const url = opts.workerUrl ?? resolved.url;
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(url, { workerData: request, execArgv: resolved.execArgv });
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      void worker.terminate();
      fn();
    };
    worker.on('error', (err) => settle(() => reject(err)));
    worker.on('message', (msg: ParseWorkerMessage) =>
      settle(() => {
        if (msg.ok) resolve({ parsed: msg.parsed, threadId: msg.threadId });
        else {
          const e = new Error(msg.error.message);
          e.name = msg.error.name;
          reject(e);
        }
      }),
    );
    worker.on('exit', (code) =>
      settle(() => reject(new Error(`parse worker exited (code ${code}) without a result`))),
    );
  });
}
