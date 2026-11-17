/* #4217 child 4 — hydrate re-reads an existing book with the extractor version
   its state.json stamp names. An unstamped book (every book in a library today)
   re-reads byte-identically to version 1. */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const bookState: { stamp?: number } = {};
vi.mock('../workspace/scan.js', () => ({
  findBookByManuscriptId: vi.fn(async () => ({
    bookDir: process.env.TEST_BOOK_DIR,
    state: {
      bookId: 'b1',
      manuscriptId: 'm_extractor_pin',
      title: 'T',
      manuscriptFile: 'manuscript.epub',
      createdAt: '2026-01-01T00:00:00.000Z',
      chapters: [{ id: 1, title: 'One' }],
      ...(bookState.stamp !== undefined ? { manuscriptExtractorVersion: bookState.stamp } : {}),
    },
  })),
}));

import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getOrHydrateManuscript, removeManuscript } from './manuscripts.js';
import { parseEpub } from '../parsers/epub.js';
import { extractorVersionOf } from '../parsers/version.js';
import { buildEpub } from '../test-utils/empty-href-epub.js';

const CHAPTER =
  '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>x</title></head><body>' +
  '<div class="p">First para one.</div><div class="p">First para two.</div></body></html>';

beforeEach(() => {
  removeManuscript('m_extractor_pin');
  delete bookState.stamp;
});

async function hydrate() {
  const dir = mkdtempSync(join(tmpdir(), 'extractor-pin-'));
  process.env.TEST_BOOK_DIR = dir;
  try {
    const bytes = await buildEpub([CHAPTER]);
    writeFileSync(join(dir, 'manuscript.epub'), bytes);
    const record = await getOrHydrateManuscript('m_extractor_pin');
    return { record, bytes };
  } finally {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TEST_BOOK_DIR;
  }
}

describe('hydrateFromDisk — extractor pin', () => {
  it('P1: an unstamped book re-reads byte-identically to version 1', async () => {
    const { record, bytes } = await hydrate();
    const v1 = await parseEpub(bytes, { fileName: 'manuscript.epub', extractorVersion: 1 });
    expect(record).toBeDefined();
    expect(record!.sourceText).toBe(v1.sourceText);
    expect(record!.sourceText).not.toContain('\n\n');
    expect(record!.chapterHints.map((h) => h.body)).toEqual(v1.chapters.map((c) => c.body));
  });

  it('P2: a book stamped 2 re-reads with the version-2 (split) text', async () => {
    bookState.stamp = 2;
    const { record, bytes } = await hydrate();
    const v2 = await parseEpub(bytes, { fileName: 'manuscript.epub', extractorVersion: 2 });
    expect(record!.sourceText).toBe(v2.sourceText);
    expect(record!.sourceText).toContain('\n\n');
  });

  it('P3: extractorVersionOf defaults to 1 and reads the stamp', () => {
    expect(extractorVersionOf({})).toBe(1);
    expect(extractorVersionOf({ manuscriptExtractorVersion: 2 })).toBe(2);
    expect(extractorVersionOf({ manuscriptExtractorVersion: 1 })).toBe(1);
  });
});
