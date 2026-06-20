/* srv-32 (plan 191) — pure sync-manifest builders. No I/O. */

import { describe, it, expect } from 'vitest';
import {
  chapterFingerprint,
  bookManifestUpdatedAt,
  buildSyncManifestIndex,
  buildSyncManifestBookDetail,
  type ChapterAudioFact,
} from './sync-manifest.js';
import type { BookStateJson } from './scan.js';

type Chapter = BookStateJson['chapters'][number];

function ch(p: Partial<Chapter> & { id: number; uuid: string }): Chapter {
  return {
    title: `Chapter ${p.id}`,
    slug: `${String(p.id).padStart(2, '0')}-chapter-${p.id}`,
    ...p,
  };
}

function state(over: Partial<BookStateJson> & { chapters: Chapter[] }): BookStateJson {
  return {
    bookId: 'b1',
    manuscriptId: 'm',
    title: 'Book One',
    author: 'Author',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: true,
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('chapterFingerprint', () => {
  it('is undefined without an audioRenderedAt or a file size', () => {
    expect(chapterFingerprint(undefined, 100)).toBeUndefined();
    expect(chapterFingerprint('2026-01-01T00:00:00.000Z', undefined)).toBeUndefined();
  });

  it('combines audioRenderedAt and file size into a string', () => {
    const fp = chapterFingerprint('2026-01-01T00:00:00.000Z', 4096);
    expect(typeof fp).toBe('string');
    expect(fp).toContain('4096');
  });

  it('changes when audioRenderedAt changes (every audio mutation bumps it)', () => {
    const a = chapterFingerprint('2026-01-01T00:00:00.000Z', 4096);
    const b = chapterFingerprint('2026-02-02T00:00:00.000Z', 4096);
    expect(a).not.toBe(b);
  });

  it('changes when the file size changes', () => {
    const a = chapterFingerprint('2026-01-01T00:00:00.000Z', 4096);
    const b = chapterFingerprint('2026-01-01T00:00:00.000Z', 8192);
    expect(a).not.toBe(b);
  });
});

describe('bookManifestUpdatedAt', () => {
  it('falls back to state.updatedAt when no chapter has audio', () => {
    const s = state({
      updatedAt: '2026-03-01T00:00:00.000Z',
      chapters: [ch({ id: 1, uuid: 'u1' })],
    });
    expect(bookManifestUpdatedAt(s)).toBe('2026-03-01T00:00:00.000Z');
  });

  it('returns the latest audioRenderedAt when it is newer than state.updatedAt', () => {
    const s = state({
      updatedAt: '2026-03-01T00:00:00.000Z',
      chapters: [
        ch({ id: 1, uuid: 'u1', audioRenderedAt: '2026-04-10T00:00:00.000Z' }),
        ch({ id: 2, uuid: 'u2', audioRenderedAt: '2026-05-20T00:00:00.000Z' }),
      ],
    });
    expect(bookManifestUpdatedAt(s)).toBe('2026-05-20T00:00:00.000Z');
  });
});

describe('buildSyncManifestIndex', () => {
  const books = [
    {
      bookId: 'b1',
      state: state({ bookId: 'b1', updatedAt: '2026-01-01T00:00:00.000Z', chapters: [ch({ id: 1, uuid: 'u1' })] }),
      coverUrl: '/api/books/b1/cover',
    },
    {
      bookId: 'b2',
      state: state({ bookId: 'b2', updatedAt: '2026-06-01T00:00:00.000Z', chapters: [ch({ id: 1, uuid: 'u2' })] }),
    },
  ];

  it('lists every book with an audio-aware updatedAt and the full activeBookIds set', () => {
    const idx = buildSyncManifestIndex(books);
    expect(idx.books.map((b) => b.bookId).sort()).toEqual(['b1', 'b2']);
    expect(idx.activeBookIds.sort()).toEqual(['b1', 'b2']);
    expect(idx.books.find((b) => b.bookId === 'b1')?.coverUrl).toBe('/api/books/b1/cover');
  });

  it('?since trims the books list but keeps the FULL activeBookIds set', () => {
    const idx = buildSyncManifestIndex(books, '2026-03-01T00:00:00.000Z');
    // only b2 changed after the cutoff
    expect(idx.books.map((b) => b.bookId)).toEqual(['b2']);
    // but the active set still lists every book so the client can evict
    expect(idx.activeBookIds.sort()).toEqual(['b1', 'b2']);
  });

  it('carries finished + hidden flags through the index', () => {
    const idx = buildSyncManifestIndex([
      { bookId: 'b1', state: state({ bookId: 'b1', updatedAt: '2026-01-01T00:00:00.000Z', chapters: [ch({ id: 1, uuid: 'u1' })] }), finished: true, hidden: false },
      { bookId: 'b2', state: state({ bookId: 'b2', updatedAt: '2026-06-01T00:00:00.000Z', chapters: [ch({ id: 1, uuid: 'u2' })] }), hidden: true },
    ]);
    const b1 = idx.books.find((b) => b.bookId === 'b1')!;
    const b2 = idx.books.find((b) => b.bookId === 'b2')!;
    expect(b1.finished).toBe(true);
    expect(b2.hidden).toBe(true);
  });
});

describe('buildSyncManifestBookDetail', () => {
  const s = state({
    bookId: 'b1',
    chapters: [
      ch({
        id: 1,
        uuid: 'u1',
        audioRenderedAt: '2026-04-01T00:00:00.000Z',
        audioQa: {
          status: 'ok',
          reasons: [],
          measuredLufs: -16.2,
          truePeakDb: -1.5,
          durationSec: 123.4,
          expectedSec: 120,
          checkedAt: '2026-04-01T00:00:00.000Z',
        },
      }),
      ch({ id: 2, uuid: 'u2' }), // no audio yet
      ch({ id: 3, uuid: 'u3', excluded: true }), // front/back-matter
    ],
  });
  const audio = new Map<number, ChapterAudioFact>([
    [1, { fileSize: 4096, urlSuffix: 'audio.mp3' }],
  ]);

  it('emits uuid-keyed active chapters with fingerprint/urlSuffix/audioUrl/duration/lufs', () => {
    const detail = buildSyncManifestBookDetail('b1', s, audio);
    expect(detail.bookId).toBe('b1');
    const c1 = detail.chapters.find((c) => c.uuid === 'u1')!;
    expect(c1.id).toBe(1);
    expect(c1.fingerprint).toContain('4096');
    expect(c1.urlSuffix).toBe('audio.mp3');
    expect(c1.audioUrl).toBe('/api/books/b1/chapters/1/audio.mp3');
    expect(c1.durationSec).toBe(123.4);
    expect(c1.lufs).toBe(-16.2);
  });

  it('uses the audio fact durationSec (from the segments file) when audioQa has none', () => {
    const s2 = state({
      bookId: 'b1',
      chapters: [ch({ id: 1, uuid: 'u1', audioRenderedAt: '2026-04-01T00:00:00.000Z' })],
    });
    const audio2 = new Map<number, ChapterAudioFact>([
      [1, { fileSize: 4096, urlSuffix: 'audio.mp3', durationSec: 99.5 }],
    ]);
    const detail = buildSyncManifestBookDetail('b1', s2, audio2);
    expect(detail.chapters[0].durationSec).toBe(99.5);
  });

  it('lists a chapter without audio but with no fingerprint/urlSuffix', () => {
    const detail = buildSyncManifestBookDetail('b1', s, audio);
    const c2 = detail.chapters.find((c) => c.uuid === 'u2')!;
    expect(c2).toBeDefined();
    expect(c2.fingerprint).toBeUndefined();
    expect(c2.urlSuffix).toBeUndefined();
    expect(c2.audioUrl).toBeUndefined();
  });

  it('excludes excluded chapters from both chapters and activeChapterUuids', () => {
    const detail = buildSyncManifestBookDetail('b1', s, audio);
    expect(detail.chapters.map((c) => c.uuid).sort()).toEqual(['u1', 'u2']);
    expect(detail.activeChapterUuids.sort()).toEqual(['u1', 'u2']);
  });
});
