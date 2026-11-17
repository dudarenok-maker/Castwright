/* Crash isolation (#4242): an error thrown from an async callback inside the
   parse worker never reaches the main process's uncaughtException handler.
   Vitest records an uncaught exception as a test error instead of dying, so
   each case runs a real child Node process with the real installCrashHandlers
   and reads its exit status and output. */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildEmptyHrefEpub } from '../test-utils/empty-href-epub.js';

const crashLoggingUrl = new URL('../crash-logging.ts', import.meta.url).href;
const parseInWorkerUrl = new URL('./parse-in-worker.ts', import.meta.url).href;
const throwInCallbackUrl = new URL('./__fixtures__/workers/throw-in-callback.mjs', import.meta.url).href;
const epub2ThrowUrl = new URL('./__fixtures__/workers/epub2-getchapter-throw.mjs', import.meta.url).href;
const serverDir = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-4242-crash-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

/* Worker cases: parseInWorker rejects, the process stays up. */
const WORKER_CHILD = `
const { installCrashHandlers } = await import(${JSON.stringify(crashLoggingUrl)});
const { parseInWorker } = await import(${JSON.stringify(parseInWorkerUrl)});
installCrashHandlers();
const [, , workerUrl, sourcePath] = process.argv;
try {
  await parseInWorker(
    { format: 'epub', buffer: Buffer.alloc(0), fileName: 'x.epub', sourcePath: sourcePath || undefined },
    { workerUrl: new URL(workerUrl) },
  );
  console.log('RESOLVED');
} catch (e) {
  console.log('REJECTED ' + e.constructor.name + ': ' + e.message);
}
await new Promise((r) => setTimeout(r, 500));
console.log('ALIVE');
`;

/* Control: the same epub2 fixture logic on the child's main thread. */
const CONTROL_CHILD = `
const { installCrashHandlers } = await import(${JSON.stringify(crashLoggingUrl)});
installCrashHandlers();
const { EPub } = await import('epub2');
const epub = await EPub.createAsync(process.argv[2]);
epub.getChapter(epub.flow[0].id, () => {});
await new Promise((r) => setTimeout(r, 1500));
console.log('ALIVE');
`;

function runChild(name: string, source: string, args: string[]) {
  const script = path.join(root, `${name}.mjs`);
  fs.writeFileSync(script, source);
  const res = spawnSync(process.execPath, ['--import', tsxLoader, script, ...args], {
    cwd: serverDir,
    encoding: 'utf8',
    timeout: 60_000,
    windowsHide: true,
  });
  return { status: res.status, stdout: res.stdout ?? '', stderr: res.stderr ?? '' };
}

async function emptyHrefEpubPath(): Promise<string> {
  const p = path.join(root, 'empty-href.epub');
  fs.writeFileSync(p, await buildEmptyHrefEpub());
  return p;
}

describe('parse worker crash isolation (#4242)', () => {
  const MALFORMED = 'REJECTED UnusableEpubError: This EPUB could not be read: the file appears to be malformed.';

  it('a throw in a setImmediate callback inside the worker rejects and the process lives', () => {
    const r = runChild('case1', WORKER_CHILD, [throwInCallbackUrl, '']);
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MALFORMED);
    expect(r.stdout).toContain('ALIVE');
    expect(out).not.toContain('FATAL uncaughtException');
  }, 90_000);

  it('a real epub2 getChapter callback throw inside the worker rejects and the process lives', async () => {
    const r = runChild('case2', WORKER_CHILD, [epub2ThrowUrl, await emptyHrefEpubPath()]);
    const out = r.stdout + r.stderr;
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(MALFORMED);
    expect(r.stdout).toContain('ALIVE');
    expect(out).not.toContain('FATAL uncaughtException');
  }, 90_000);

  it('control: the same epub2 throw on the main thread is fatal', async () => {
    const r = runChild('control', CONTROL_CHILD, [await emptyHrefEpubPath()]);
    const out = r.stdout + r.stderr;
    console.log('[4242 control]', out.split('\n').find((l) => l.includes('FATAL uncaughtException')));
    expect(r.status).toBe(1);
    expect(out).toContain('FATAL uncaughtException');
  }, 90_000);
});
