/* fs-38 Wave 1, Task 5 — unit tests for the voice-library usage scan +
   reference-clearing helpers. Mirrors the tempdir-workspace pattern from
   routes/voices.test.ts: a real books/ tree under a WORKSPACE_DIR temp
   root, seeded state.json + cast.json per book. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let dir: string;
let usageMod: typeof import('./voice-library-usage.js');

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

function readCastFromDisk(workspace: string, author: string, series: string, title: string) {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-voicelib-usage-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  usageMod = await import('./voice-library-usage.js');
});

afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

describe('scanLibraryVoiceUsage', () => {
  it('finds a character whose cast.json overrideTtsVoices slot references the library voice', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        overrideTtsVoices: { qwen: { name: 'qwen-lib-1', libraryUuid: 'lib-uuid-1' } },
      },
      { id: 'char-other', name: 'Other' },
    ]);

    const usage = await usageMod.scanLibraryVoiceUsage('lib-uuid-1');

    expect(usage).toEqual([
      {
        bookId: 'book-one',
        bookTitle: 'Book One',
        characterId: 'char-marlow',
        characterName: 'Marlow',
      },
    ]);
  });

  it('returns empty when no cast.json references the voiceUuid', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      { id: 'char-marlow', name: 'Marlow', overrideTtsVoices: { qwen: { name: 'x' } } },
    ]);

    expect(await usageMod.scanLibraryVoiceUsage('lib-uuid-unused')).toEqual([]);
  });

  it('ignores unconfirmed casts and books with no characters', async () => {
    writeBookOnDisk(
      dir,
      'Della Renwick',
      'The Hollow Tide',
      'Draft Book',
      'draft-book',
      [{ id: 'char-x', overrideTtsVoices: { qwen: { name: 'x', libraryUuid: 'lib-uuid-1' } } }],
      false,
    );

    expect(await usageMod.scanLibraryVoiceUsage('lib-uuid-1')).toEqual([]);
  });

  it('finds references across multiple books and multiple engine slots', async () => {
    writeBookOnDisk(dir, 'Author A', 'Series A', 'Book A', 'book-a', [
      { id: 'char-a', name: 'A', overrideTtsVoices: { qwen: { name: 'x', libraryUuid: 'lib-uuid-1' } } },
    ]);
    writeBookOnDisk(dir, 'Author B', 'Series B', 'Book B', 'book-b', [
      {
        id: 'char-b',
        name: 'B',
        overrideTtsVoices: {
          coqui: { name: 'y' },
          xtts: { name: 'z', libraryUuid: 'lib-uuid-1' },
        },
      },
    ]);

    const usage = await usageMod.scanLibraryVoiceUsage('lib-uuid-1');
    const bookIds = usage.map((u) => u.bookId).sort();
    expect(bookIds).toEqual(['book-a', 'book-b']);
  });
});

describe('clearLibraryVoiceReferences', () => {
  it('removes only the matching engine slot, leaving sibling slots and other characters untouched', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      {
        id: 'char-marlow',
        name: 'Marlow',
        overrideTtsVoices: {
          qwen: { name: 'qwen-lib-1', libraryUuid: 'lib-uuid-1' },
          coqui: { name: 'preset-voice' },
        },
      },
      { id: 'char-other', name: 'Other', overrideTtsVoices: { qwen: { name: 'unrelated' } } },
    ]);

    await usageMod.clearLibraryVoiceReferences('lib-uuid-1');

    const cast = readCastFromDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One');
    const marlow = cast.characters.find((c) => c.id === 'char-marlow')!;
    const overrides = marlow.overrideTtsVoices as Record<string, unknown>;
    expect(overrides.qwen).toBeUndefined();
    expect(overrides.coqui).toEqual({ name: 'preset-voice' });

    const other = cast.characters.find((c) => c.id === 'char-other')!;
    expect((other.overrideTtsVoices as Record<string, unknown>).qwen).toEqual({ name: 'unrelated' });
  });

  it('is a no-op (no write) when nothing references the voiceUuid', async () => {
    writeBookOnDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One', 'book-one', [
      { id: 'char-marlow', name: 'Marlow', overrideTtsVoices: { qwen: { name: 'unrelated' } } },
    ]);

    await usageMod.clearLibraryVoiceReferences('lib-uuid-does-not-exist');

    const cast = readCastFromDisk(dir, 'Della Renwick', 'The Hollow Tide', 'Book One');
    expect((cast.characters[0].overrideTtsVoices as Record<string, unknown>).qwen).toEqual({
      name: 'unrelated',
    });
  });
});
