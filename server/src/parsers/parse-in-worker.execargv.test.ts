/* A server launched with a V8 flag (`node --max-old-space-size=8192 ...`) must
   still parse EPUBs: Node rejects such a flag in an EXPLICIT Worker execArgv
   (ERR_WORKER_INVALID_EXEC_ARGV) though default inheritance accepts it (#4242).
   Runs a real child Node with the flag; vitest's own process cannot carry it.
   Covers the source (`.ts`) branch of resolveWorker. The compiled (`.js`)
   branch needs a `tsc` build of the server, too slow and fragile for a unit
   test; it differs only in not adding the tsx loader, and shares the same
   execArgv handling. */
import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const parseInWorkerUrl = new URL('./parse-in-worker.ts', import.meta.url).href;
const epubPath = fileURLToPath(new URL('./__fixtures__/sample.epub', import.meta.url));
const serverDir = fileURLToPath(new URL('../..', import.meta.url));
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve('tsx')).href;

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-4242-execargv-'));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const CHILD = `
import { readFileSync } from 'node:fs';
const { parseInWorker } = await import(${JSON.stringify(parseInWorkerUrl)});
try {
  const out = await parseInWorker({
    format: 'epub',
    buffer: readFileSync(process.argv[2]),
    fileName: 'sample.epub',
    extractorVersion: 1,
  });
  console.log('PARSED ' + out.chapters.length);
} catch (e) {
  console.log('REJECTED ' + e.constructor.name + ': ' + e.message);
}
`;

describe('parse worker inherits the parent execArgv (#4242)', () => {
  it('parses an EPUB when the server runs with --max-old-space-size', () => {
    const script = path.join(root, 'child.mjs');
    fs.writeFileSync(script, CHILD);
    const res = spawnSync(
      process.execPath,
      ['--max-old-space-size=512', '--import', tsxLoader, script, epubPath],
      { cwd: serverDir, encoding: 'utf8', timeout: 60_000, windowsHide: true },
    );
    const out = (res.stdout ?? '') + (res.stderr ?? '');
    expect(out).toMatch(/PARSED [1-9]/);
    expect(out).not.toContain('ERR_WORKER_INVALID_EXEC_ARGV');
  }, 90_000);
});
