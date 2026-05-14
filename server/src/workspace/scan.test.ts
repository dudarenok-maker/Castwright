/* Integration tests for scanLibrary's derived book stats: characterCount,
   voiceCount, and runtime. Set WORKSPACE_DIR to a tempdir before importing
   the modules (paths.ts reads it at load time), then scaffold synthetic
   book layouts with varying completeness so each branch in scanBook gets
   exercised. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let scanLibrary: typeof import('./scan.js').scanLibrary;
let makeBookId: typeof import('./paths.js').makeBookId;

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';

function bookSkeleton(
  title: string,
  opts: {
    castConfirmed?: boolean;
    chapters?: Array<{ id: number; slug: string }>;
  } = {},
) {
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  const audioRoot = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioRoot, { recursive: true });
  const chapters = opts.chapters ?? [{ id: 1, slug: 'chapter-one' }];
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: !!opts.castConfirmed,
      chapters: chapters.map(c => ({ id: c.id, title: `Chapter ${c.id}`, slug: c.slug })),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  return { bookId, bookDir, audioRoot };
}

function writeCast(bookDir: string, characters: Array<{ id: string; voiceId?: string }>) {
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters }),
  );
}

function writeSegments(audioRoot: string, slug: string, durationSec: number) {
  writeFileSync(
    join(audioRoot, `${slug}.segments.json`),
    JSON.stringify({
      bookId: 'unused',
      chapterId: 1,
      chapterTitle: 'unused',
      durationSec,
      sampleRate: 24_000,
      modelKey: 'xtts_v2',
      synthesizedAt: new Date().toISOString(),
      segments: [],
    }),
  );
}

function flatten() {
  /* Convenience: scanLibrary returns the 3-level hierarchy; tests assert
     on a flat list since each test fixture only writes one book per case. */
  return scanLibrary().then(r =>
    r.authors.flatMap(a => a.series.flatMap(s => s.books)),
  );
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-scan-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Defer module load so paths.ts picks up WORKSPACE_DIR. */
  const scan = await import('./scan.js');
  const paths = await import('./paths.js');
  scanLibrary = scan.scanLibrary;
  makeBookId = paths.makeBookId;
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('scanLibrary derived stats', () => {
  it('analysing book (state-only, no cast) reports zero voices/characters and no runtime', async () => {
    bookSkeleton('Analysing Book');
    const books = await flatten();
    const b = books.find(x => x.title === 'Analysing Book')!;
    expect(b.status).toBe('analysing');
    expect(b.characterCount).toBe(0);
    expect(b.voiceCount).toBe(0);
    expect(b.runtime).toBeUndefined();
  });

  it('cast_pending book reports cast counts but no runtime (no audio yet)', async () => {
    const { bookDir } = bookSkeleton('Cast Pending Book');
    writeCast(bookDir, [
      { id: 'narrator' },
      { id: 'Marlow', voiceId: 'voice-warm-male' },
      { id: 'Wren', voiceId: 'voice-bright-young' },
    ]);
    const books = await flatten();
    const b = books.find(x => x.title === 'Cast Pending Book')!;
    expect(b.status).toBe('cast_pending');
    expect(b.characterCount).toBe(3);
    expect(b.voiceCount).toBe(3);
    expect(b.runtime).toBeUndefined();
  });

  it('characters sharing a voiceId collapse into one voice slot', async () => {
    const { bookDir } = bookSkeleton('Shared Voice Book');
    /* Both Hespa and Corvin use the library voice 'voice-elder-female' →
       voiceCount must be 2 (narrator + the shared voice), not 3. */
    writeCast(bookDir, [
      { id: 'narrator' },
      { id: 'Hespa', voiceId: 'voice-elder-female' },
      { id: 'Corvin',   voiceId: 'voice-elder-female' },
    ]);
    const books = await flatten();
    const b = books.find(x => x.title === 'Shared Voice Book')!;
    expect(b.characterCount).toBe(3);
    expect(b.voiceCount).toBe(2);
  });

  it('complete book sums per-chapter segments.json into a formatted runtime', async () => {
    const { bookDir, audioRoot } = bookSkeleton('Complete Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'ch-01' },
        { id: 2, slug: 'ch-02' },
        { id: 3, slug: 'ch-03' },
      ],
    });
    writeCast(bookDir, [
      { id: 'narrator' },
      { id: 'Marlow', voiceId: 'voice-warm-male' },
    ]);
    /* 1500 + 1500 + 600 = 3600 sec = 60 min = '1h 0m' */
    writeSegments(audioRoot, 'ch-01', 1500);
    writeSegments(audioRoot, 'ch-02', 1500);
    writeSegments(audioRoot, 'ch-03', 600);
    /* Audio files must exist for status → complete (matches audioDir filter
       in scan.ts:175). Content can be empty — the scanner only counts. */
    writeFileSync(join(audioRoot, 'ch-01.mp3'), '');
    writeFileSync(join(audioRoot, 'ch-02.mp3'), '');
    writeFileSync(join(audioRoot, 'ch-03.mp3'), '');

    const books = await flatten();
    const b = books.find(x => x.title === 'Complete Book')!;
    expect(b.status).toBe('complete');
    expect(b.characterCount).toBe(2);
    expect(b.voiceCount).toBe(2);
    expect(b.runtime).toBe('1h 0m');
  });

  it('runtime under one hour formats as Xm only', async () => {
    const { bookDir, audioRoot } = bookSkeleton('Short Book', {
      castConfirmed: true,
      chapters: [{ id: 1, slug: 'only-ch' }],
    });
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'only-ch', 47 * 60); // 47 min
    writeFileSync(join(audioRoot, 'only-ch.mp3'), '');
    const books = await flatten();
    const b = books.find(x => x.title === 'Short Book')!;
    expect(b.runtime).toBe('47m');
  });

  it('partially-generated book sums only the chapters with segments on disk', async () => {
    const { bookDir, audioRoot } = bookSkeleton('Partial Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'p-01' },
        { id: 2, slug: 'p-02' },
        { id: 3, slug: 'p-03' },
      ],
    });
    writeCast(bookDir, [{ id: 'narrator' }]);
    /* Only chapter 1 has been generated. Runtime reports just that chapter's
       duration instead of waiting for the whole book. */
    writeSegments(audioRoot, 'p-01', 30 * 60); // 30 min
    writeFileSync(join(audioRoot, 'p-01.mp3'), '');
    const books = await flatten();
    const b = books.find(x => x.title === 'Partial Book')!;
    expect(b.status).toBe('generating');
    expect(b.runtime).toBe('30m');
  });

  it('malformed cast.json leaves counts at 0 without breaking the scan', async () => {
    const { bookDir } = bookSkeleton('Broken Cast Book');
    writeFileSync(join(bookDir, '.audiobook', 'cast.json'), '{not valid json');
    const books = await flatten();
    const b = books.find(x => x.title === 'Broken Cast Book')!;
    /* Book row still renders; counts stay at 0 (the badge will show '—'). */
    expect(b.characterCount).toBe(0);
    expect(b.voiceCount).toBe(0);
  });

  it('malformed segments.json is skipped without breaking the runtime total', async () => {
    const { bookDir, audioRoot } = bookSkeleton('Mixed Segments Book', {
      castConfirmed: true,
      chapters: [
        { id: 1, slug: 'ms-01' },
        { id: 2, slug: 'ms-02' },
      ],
    });
    writeCast(bookDir, [{ id: 'narrator' }]);
    writeSegments(audioRoot, 'ms-01', 600);
    writeFileSync(join(audioRoot, 'ms-02.segments.json'), '{not valid');
    writeFileSync(join(audioRoot, 'ms-01.mp3'), '');
    writeFileSync(join(audioRoot, 'ms-02.mp3'), '');
    const books = await flatten();
    const b = books.find(x => x.title === 'Mixed Segments Book')!;
    /* Only ms-01's 10 minutes is counted; ms-02's bad JSON doesn't poison
       the whole row. */
    expect(b.runtime).toBe('10m');
  });
});
