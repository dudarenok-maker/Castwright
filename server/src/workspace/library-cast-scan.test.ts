/* fs-38 Wave 1, Task 8 — unit tests for scanLibraryCharacters' cloned-provenance
   exclusion (spec §6 "Matcher exclusion — assignment-level, not manifest-level"):
   a character whose overrideTtsVoices slot carries provenance: 'cloned' must never
   be returned by the scan, since this is the single seam feeding both the
   confirm-time matcher (routes/voice-match.ts) and the analysis-time auto-linker
   (workspace/series-reuse-link.ts). imported/designed/provenance-less characters
   pass through unchanged. Mirrors the tempdir-workspace fixture pattern from
   voice-library-usage.test.ts / series-cast-scan.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let scanMod: typeof import('./library-cast-scan.js');

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  castConfirmed = true,
) {
  const bookDir = join(workspace, 'books', author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return bookDir;
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-library-cast-scan-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  scanMod = await import('./library-cast-scan.js');
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('scanLibraryCharacters — cloned-provenance exclusion (spec §6)', () => {
  it('excludes a character whose slot carries provenance: cloned, but keeps imported and legacy (provenance-less) characters', async () => {
    writeBookOnDisk(dir, 'Author A', 'Series A', 'Book A', 'book-a', [
      {
        id: 'char-cloned',
        name: 'Mum',
        overrideTtsVoices: { qwen: { name: 'qwen-lib-1', libraryUuid: 'lib-uuid-1', provenance: 'cloned' } },
      },
    ]);
    writeBookOnDisk(dir, 'Author B', 'Series B', 'Book B', 'book-b', [
      {
        id: 'char-imported',
        name: 'Imported Voice',
        overrideTtsVoices: { qwen: { name: 'qwen-lib-2', libraryUuid: 'lib-uuid-2', provenance: 'imported' } },
      },
      {
        id: 'char-legacy',
        name: 'Legacy Voice',
        overrideTtsVoices: { qwen: { name: 'qwen-lib-3', libraryUuid: 'lib-uuid-3' } },
      },
    ]);

    const records = await scanMod.scanLibraryCharacters();
    const ids = records.map((r) => r.character.id).sort();

    expect(ids).toEqual(['char-imported', 'char-legacy']);
    expect(ids).not.toContain('char-cloned');
  });

  it('keeps a designed-provenance character', async () => {
    writeBookOnDisk(dir, 'Author C', 'Series C', 'Book C', 'book-c', [
      {
        id: 'char-designed',
        name: 'Designed Voice',
        overrideTtsVoices: { qwen: { name: 'qwen-lib-4', provenance: 'designed' } },
      },
    ]);

    const records = await scanMod.scanLibraryCharacters();
    expect(records.map((r) => r.character.id)).toEqual(['char-designed']);
  });

  it('excludes a character if ANY engine slot is cloned-provenance, even alongside a non-cloned slot', async () => {
    writeBookOnDisk(dir, 'Author D', 'Series D', 'Book D', 'book-d', [
      {
        id: 'char-mixed',
        name: 'Mixed',
        overrideTtsVoices: {
          coqui: { name: 'preset-voice' },
          qwen: { name: 'qwen-lib-5', libraryUuid: 'lib-uuid-5', provenance: 'cloned' },
        },
      },
    ]);

    const records = await scanMod.scanLibraryCharacters();
    expect(records.map((r) => r.character.id)).toEqual([]);
  });

  it('keeps a character with no overrideTtsVoices at all', async () => {
    writeBookOnDisk(dir, 'Author E', 'Series E', 'Book E', 'book-e', [{ id: 'char-plain', name: 'Plain' }]);

    const records = await scanMod.scanLibraryCharacters();
    expect(records.map((r) => r.character.id)).toEqual(['char-plain']);
  });
});
