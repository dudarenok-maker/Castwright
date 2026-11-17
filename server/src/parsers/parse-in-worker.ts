/* Main-thread spawner for the EPUB/MOBI parse worker (#4242). One worker per
   parse, terminated once it settles. The buffer is COPIED into the worker
   (plain workerData), never transferred: routes/import.ts keeps using the
   original buffer after the parse. */
import { mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
  /** Required, never defaulted: the worker must extract exactly as the
      in-process parser would at this version (#4217, #4242). */
  extractorVersion: number;
  /** Set by parseInWorker, never by a caller: the per-parse scratch dir the
      main thread owns and removes once the worker is gone. */
  scratchDir?: string;
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
  /** Test seam: parent of the per-parse scratch dir (default: os.tmpdir()). */
  scratchRoot?: string;
  /** Test seam: receives the spawned worker. */
  onWorker?: (worker: Worker) => void;
  /** Test seam: receives the background promise that settles once the worker
      has exited and the scratch dir has been removed (never rejects). */
  onCleanup?: (done: Promise<void>) => void;
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
    so tsx is never required in production. `execArgv` is left undefined
    whenever nothing needs adding: an explicit list makes Node reject V8 flags
    (`--max-old-space-size`) with ERR_WORKER_INVALID_EXEC_ARGV, while default
    inheritance accepts them. */
function resolveWorker(): { url: URL; execArgv?: string[] } {
  if (!import.meta.url.endsWith('.ts')) {
    return { url: new URL('./parse-worker.js', import.meta.url) };
  }
  const url = new URL('./parse-worker.ts', import.meta.url);
  if (process.execArgv.some((a) => a.includes('tsx'))) return { url };
  const loader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;
  return { url, execArgv: ['--import', loader] };
}

export async function parseInWorker(
  request: ParseWorkerRequest,
  opts: ParseInWorkerOptions = {},
): Promise<ParsedManuscript> {
  const parsed = await parseInWorkerWithThread(request, opts);
  return parsed.parsed;
}

/** Same as parseInWorker but also reports the worker's threadId (tests use it
    to prove the parse left the main thread). The main thread owns a per-parse
    scratch dir and removes it, in the background, once the worker has exited,
    on every outcome: a worker that dies or is terminated never runs the
    parsers' own `finally` cleanup, so whatever they wrote there would
    otherwise outlive the parse. The caller is NOT held up by that removal. */
export async function parseInWorkerWithThread(
  request: ParseWorkerRequest,
  opts: ParseInWorkerOptions = {},
): Promise<{ parsed: ParsedManuscript; threadId: number }> {
  const scratchDir = await mkdtemp(join(opts.scratchRoot ?? tmpdir(), 'parse-scratch-'));
  const removeScratch = (): Promise<void> =>
    rm(scratchDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch((err) =>
      console.error('[parse-worker] scratch cleanup failed', err),
    );
  return spawnParseWorker({ ...request, scratchDir }, opts, removeScratch);
}

function spawnParseWorker(
  request: ParseWorkerRequest,
  opts: ParseInWorkerOptions,
  removeScratch: () => Promise<void>,
): Promise<{ parsed: ParsedManuscript; threadId: number }> {
  const resolved = resolveWorker();
  const url = opts.workerUrl ?? resolved.url;
  const timeoutMs = opts.timeoutMs ?? PARSE_WORKER_TIMEOUT_MS;
  const { format } = request;
  return new Promise((resolve, reject) => {
    let settled = false;
    let worker: Worker;
    try {
      worker = new Worker(url, { workerData: request, execArgv: resolved.execArgv });
    } catch (err) {
      /* No worker exists, so nothing can hold the scratch dir. */
      opts.onCleanup?.(removeScratch());
      throw err;
    }
    opts.onWorker?.(worker);
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      /* The caller is released at once: terminate() resolves only after the
         worker's in-flight threadpool I/O finishes, which must not push the
         caller past its deadline. The scratch dir is removed in the
         background, strictly after the thread is gone (it may still hold
         files open until then); removeScratch never rejects. */
      const done = worker.terminate().then(removeScratch, removeScratch);
      opts.onCleanup?.(done);
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
