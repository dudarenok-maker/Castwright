/* A re-parse with `sourcePath` reads the book from disk (epub.ts); the buffer
   is never touched, so parseManuscript must not clone it into the worker
   (#4242). Output must not change. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import * as workerModule from './parse-in-worker.js';
import { parseManuscript } from './index.js';

vi.mock('./parse-in-worker.js', async (orig) => {
  const a = await orig<typeof import('./parse-in-worker.js')>();
  return { ...a, parseInWorker: vi.fn(a.parseInWorker) };
});

const dir = mkdtempSync(join(tmpdir(), 'cw-4242-srcpath-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('parseManuscript with sourcePath', () => {
  it('sends no buffer to the worker and parses identically', async () => {
    const buffer = readFileSync(fileURLToPath(new URL('./__fixtures__/sample.epub', import.meta.url)));
    const sourcePath = join(dir, 'sample.epub');
    writeFileSync(sourcePath, buffer);

    const fromBuffer = await parseManuscript({ buffer, fileName: 'sample.epub', extractorVersion: 1 });
    const fromDisk = await parseManuscript({ buffer, fileName: 'sample.epub', sourcePath, extractorVersion: 1 });

    const calls = vi.mocked(workerModule.parseInWorker).mock.calls;
    expect(calls[0][0].buffer.length).toBe(buffer.length);
    expect(calls[1][0].sourcePath).toBe(sourcePath);
    expect(calls[1][0].buffer.length).toBe(0);
    expect(JSON.stringify(fromDisk)).toBe(JSON.stringify(fromBuffer));
  }, 30_000);
});
