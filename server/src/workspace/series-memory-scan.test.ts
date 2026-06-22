// server/src/workspace/series-memory-scan.test.ts
// Integration test: scanLibrary attaches seriesMemory to series with >=3 confirmed books.
// Follows the temp-workspace pattern from active-analyses.test.ts (WORKSPACE_DIR env var).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let scanLibrary: typeof import('./scan.js').scanLibrary;
let root: string;

function writeBook(
  author: string,
  series: string,
  title: string,
  pos: number,
  chars: unknown[],
  confirmed = true,
) {
  const dir = join(root, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.txt'), 'x');
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: `kell__ninth-house__${title.toLowerCase()}`,
      manuscriptId: `mid-${title.toLowerCase()}`,
      title,
      author,
      series,
      seriesPosition: pos,
      isStandalone: false,
      castConfirmed: confirmed,
      manuscriptFile: 'manuscript.txt',
      chapters: [], // 0 chapters → analysisComplete=true → castConfirmed drives status to 'complete'
      coverGradient: ['#000', '#fff'],
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
    }),
  );
  writeFileSync(
    join(dir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters: chars }),
  );
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'fe40-'));
  process.env.WORKSPACE_DIR = root;

  // Helper: build a Qwen character carried across books (matchedFrom chains them)
  const c = (
    id: string,
    name: string,
    vid: string,
    from?: { bookId: string; characterId: string },
  ) => ({
    id,
    name,
    voiceId: vid,
    ttsEngine: 'qwen',
    lines: Array(20).fill({}), // 20 lines > PRINCIPAL_LINE_FLOOR (5)
    matchedFrom: from ?? null,
  });

  // Three confirmed books: each character carries forward via matchedFrom
  const b1Id = 'kell__ninth-house__one';
  const b2Id = 'kell__ninth-house__two';
  const b3Id = 'kell__ninth-house__three';

  writeBook('Kell', 'Ninth House', 'One', 1, [
    c('marrow', 'Marrow', 'vqm'),
    c('edda', 'Edda', 'vqe'),
    c('vale', 'Vale', 'vqv'),
  ]);
  writeBook('Kell', 'Ninth House', 'Two', 2, [
    c('marrow', 'Marrow', 'vqm', { bookId: b1Id, characterId: 'marrow' }),
    c('edda', 'Edda', 'vqe', { bookId: b1Id, characterId: 'edda' }),
    c('vale', 'Vale', 'vqv', { bookId: b1Id, characterId: 'vale' }),
  ]);
  writeBook('Kell', 'Ninth House', 'Three', 3, [
    c('marrow', 'Marrow', 'vqm', { bookId: b2Id, characterId: 'marrow' }),
    c('edda', 'Edda', 'vqe', { bookId: b2Id, characterId: 'edda' }),
    c('vale', 'Vale', 'vqv', { bookId: b2Id, characterId: 'vale' }),
  ]);
  // 4th book: confirmed=false (in-flight cast_pending) — must be EXCLUDED from seriesMemory
  writeBook(
    'Kell',
    'Ninth House',
    'Four',
    4,
    [c('marrow', 'Marrow', 'vqm', { bookId: b3Id, characterId: 'marrow' })],
    false,
  );

  // Dynamic import AFTER setting WORKSPACE_DIR so paths.ts picks up the temp root
  scanLibrary = (await import('./scan.js')).scanLibrary;
});

afterAll(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('scanLibrary + series-memory', () => {
  it('attaches a seriesMemory summary built from CONFIRMED books only', async () => {
    const lib = await scanLibrary();
    const series = lib.authors
      .flatMap((a) => a.series)
      .find((s) => s.name === 'Ninth House');
    expect(series).toBeTruthy();
    expect(series!.seriesMemory).toBeTruthy();
    expect(series!.seriesMemory!.carriedCount).toBe(3);
    expect(series!.seriesMemory!.designedCount).toBe(3);
    expect(series!.seriesMemory!.spanBooks).toBe(3);
    // The 4th (cast_pending / confirmed=false) book is excluded
    expect(series!.seriesMemory!.confirmedBookCount).toBe(3);
  });
});
