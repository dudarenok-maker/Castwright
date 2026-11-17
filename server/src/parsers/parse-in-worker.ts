/* Main-thread spawner for the EPUB/MOBI parse worker (#4242). One worker per
   parse, terminated once it settles. The buffer is COPIED into the worker
   (plain workerData), never transferred: routes/import.ts keeps using the
   original buffer after the parse. */
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { ParsedManuscript } from './text.js';
import { UnusableEpubError } from './epub.js';
import { UnusableMediaError } from './errors.js';
import { DrmProtectedError } from './mobi.js';

export interface ParseWorkerRequest {
  format: 'epub' | 'mobi';
  buffer: Buffer;
  fileName?: string;
  sourcePath?: string;
}

export type ParseWorkerMessage =
  | { ok: true; parsed: ParsedManuscript; threadId: number }
  | { ok: false; error: SerializedParseError };

/** A parser rejection flattened for the thread hop. `kind` picks the class the
    main side rebuilds; `code`/`syscall`/`path`/`errno` are the Node fs fields a
    structured clone of an Error would not reliably keep. */
export interface SerializedParseError {
  kind: 'UnusableEpubError' | 'DrmProtectedError' | 'UnusableMediaError' | 'Error';
  name: string;
  message: string;
  stack?: string;
  code?: string;
  syscall?: string;
  path?: string;
  errno?: number;
}

export interface ParseInWorkerOptions {
  /** Test seam: run a different worker entry. */
  workerUrl?: URL;
  /** Hang bound; defaults to PARSE_WORKER_TIMEOUT_MS. */
  timeoutMs?: number;
}

/* Bounds how long a hung worker can stall a parse. Precedent:
   MEASURE_TIMEOUT_MS in audio/measure-loudness.ts:66-75, which exists purely
   to bound how long a hang can stall a one-shot child. */
export const PARSE_WORKER_TIMEOUT_MS = 120_000;

const CRASH_MESSAGE: Record<'epub' | 'mobi', string> = {
  epub: 'This EPUB could not be read: the file appears to be malformed.',
  mobi: 'This MOBI/AZW3 file could not be read: the file appears to be malformed.',
};
const TIMEOUT_MESSAGE = 'This book took too long to read and was stopped.';

/** Fixed, path-free error for a crash, silent exit or timeout. The raw cause
    goes to console.error only (a crash message can embed an absolute path). */
function unusable(format: 'epub' | 'mobi', message: string): UnusableMediaError {
  if (format === 'epub') return new UnusableEpubError(message);
  const e = new UnusableMediaError(message);
  e.name = 'UnusableMediaError';
  return e;
}

function rebuildError(s: SerializedParseError): Error {
  let e: Error;
  if (s.kind === 'DrmProtectedError') e = new DrmProtectedError(s.message);
  else if (s.kind === 'UnusableEpubError') e = new UnusableEpubError(s.message);
  else if (s.kind === 'UnusableMediaError') {
    e = new UnusableMediaError(s.message);
    e.name = s.name;
  } else {
    e = new Error(s.message);
    e.name = s.name;
    const fs = e as Error & { code?: string; syscall?: string; path?: string; errno?: number };
    if (s.code !== undefined) fs.code = s.code;
    if (s.syscall !== undefined) fs.syscall = s.syscall;
    if (s.path !== undefined) fs.path = s.path;
    if (s.errno !== undefined) fs.errno = s.errno;
  }
  return e;
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
  const timeoutMs = opts.timeoutMs ?? PARSE_WORKER_TIMEOUT_MS;
  const { format } = request;
  return new Promise((resolve, reject) => {
    let settled = false;
    const worker = new Worker(url, { workerData: request, execArgv: resolved.execArgv });
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      fn();
    };
    const timer = setTimeout(() => {
      settle(() => {
        console.error(`[parse-worker] ${format} timeout after ${timeoutMs} ms`);
        reject(unusable(format, TIMEOUT_MESSAGE));
      });
    }, timeoutMs);
    worker.on('error', (err) =>
      settle(() => {
        console.error(`[parse-worker] ${format} crash`, err);
        reject(unusable(format, CRASH_MESSAGE[format]));
      }),
    );
    worker.on('message', (msg: ParseWorkerMessage) =>
      settle(() => {
        if (msg.ok) resolve({ parsed: msg.parsed, threadId: msg.threadId });
        else reject(rebuildError(msg.error));
      }),
    );
    worker.on('exit', (code) =>
      settle(() => {
        console.error(`[parse-worker] ${format} exit ${code} without a result`);
        reject(unusable(format, CRASH_MESSAGE[format]));
      }),
    );
  });
}
