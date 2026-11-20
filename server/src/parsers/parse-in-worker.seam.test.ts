import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import * as epubModule from './epub.js';
import * as mobiModule from './mobi.js';
import { DrmProtectedError, parseManuscript } from './index.js';

/* A vi.mock does not reach a worker thread, so the worker still runs the real
   parsers; the spies only see main-thread calls. */
vi.mock('./epub.js', async (orig) => {
  const a = await orig<typeof import('./epub.js')>();
  return { ...a, parseEpub: vi.fn(a.parseEpub) };
});
vi.mock('./mobi.js', async (orig) => {
  const a = await orig<typeof import('./mobi.js')>();
  return { ...a, parseMobi: vi.fn(a.parseMobi) };
});

describe('parseManuscript runs EPUB/MOBI off the main thread', () => {
  it('parses an EPUB without calling parseEpub on the main thread', async () => {
    const buffer = readFileSync(
      fileURLToPath(new URL('./__fixtures__/sample.epub', import.meta.url)),
    );
    const out = await parseManuscript({ buffer, fileName: 'sample.epub', extractorVersion: 1 });
    expect(out.chapters.length).toBeGreaterThan(0);
    expect(vi.mocked(epubModule.parseEpub)).toHaveBeenCalledTimes(0);
  });

  it('rejects a DRM MOBI as DrmProtectedError without calling parseMobi on the main thread', async () => {
    const buffer = Buffer.alloc(256, 0);
    buffer.writeUInt32BE(96, 78);
    buffer.writeUInt16BE(2, 96 + 0x0c);
    await expect(parseManuscript({ buffer, fileName: 'x.mobi', extractorVersion: 1 })).rejects.toBeInstanceOf(
      DrmProtectedError,
    );
    expect(vi.mocked(mobiModule.parseMobi)).toHaveBeenCalledTimes(0);
  });
});
