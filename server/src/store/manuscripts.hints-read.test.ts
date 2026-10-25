/* #3703 part 2 — a transient (non-SyntaxError) failure reading
   manuscript-hints.json must not fall back to a fresh parse: that record would
   be cached for the life of the process and a later analysis would write the
   wrong structure back. getOrHydrateManuscript returns undefined and caches
   nothing, so the next call retries. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const readManuscriptHints = vi.fn();
vi.mock('../workspace/manuscript-hints.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../workspace/manuscript-hints.js')>()),
  readManuscriptHints: (...a: unknown[]) => readManuscriptHints(...a),
}));
vi.mock('../workspace/scan.js', () => ({
  findBookByManuscriptId: vi.fn(async () => ({
    bookDir: process.env.TEST_BOOK_DIR,
    state: {
      bookId: 'b1',
      manuscriptId: 'm_hints_read',
      title: 'T',
      manuscriptFile: 'manuscript.md',
      createdAt: '2026-01-01T00:00:00.000Z',
      chapters: [{ id: 1, title: 'Alpha' }],
    },
  })),
}));

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrHydrateManuscript, getManuscript, removeManuscript } from './manuscripts.js';
import { sha256Hex } from '../workspace/manuscript-hints.js';

beforeEach(() => {
  removeManuscript('m_hints_read');
  readManuscriptHints.mockReset();
});

describe('hydrateFromDisk — hints file read errors', () => {
  it('returns undefined and caches nothing on a non-SyntaxError read error', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hints-read-'));
    process.env.TEST_BOOK_DIR = dir;
    try {
      writeFileSync(join(dir, 'manuscript.md'), '# Book\n\n# Alpha\n\n"Alpha plan is set." Silence followed.\n');
      const err = Object.assign(new Error('busy'), { code: 'EBUSY' });
      readManuscriptHints.mockRejectedValueOnce(err);
      const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(await getOrHydrateManuscript('m_hints_read')).toBeUndefined();
      expect(getManuscript('m_hints_read')).toBeUndefined();
      spy.mockRestore();
      // The next call retries and now succeeds (no file => fresh parse).
      readManuscriptHints.mockResolvedValueOnce(null);
      expect((await getOrHydrateManuscript('m_hints_read'))?.chapterHints.length).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TEST_BOOK_DIR;
    }
  });

  it('stamps the record with the sha256 of the bytes it was parsed from', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hints-read-'));
    process.env.TEST_BOOK_DIR = dir;
    try {
      const bytes = '# Book\n\n# Alpha\n\n"Alpha plan is set." Silence followed.\n';
      writeFileSync(join(dir, 'manuscript.md'), bytes);
      readManuscriptHints.mockResolvedValueOnce(null);
      const record = await getOrHydrateManuscript('m_hints_read');
      expect(record?.sourceSha256).toBe(sha256Hex(Buffer.from(bytes)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TEST_BOOK_DIR;
    }
  });

  it('falls back to the fresh parse on a corrupt (SyntaxError) file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hints-read-'));
    process.env.TEST_BOOK_DIR = dir;
    try {
      writeFileSync(join(dir, 'manuscript.md'), '# Book\n\n# Alpha\n\n"Alpha plan is set." Silence followed.\n');
      readManuscriptHints.mockRejectedValueOnce(new SyntaxError('bad json'));
      const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      expect((await getOrHydrateManuscript('m_hints_read'))?.chapterHints.length).toBe(1);
      spy.mockRestore();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      delete process.env.TEST_BOOK_DIR;
    }
  });
});
