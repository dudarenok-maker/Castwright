/* Plan 290 (#3837) — the bundle overwrite stamps the stale-evidence marker
   (M27). A portable bundle never carries manuscript-edits.json and an
   overwrite leaves the local one in place, so its saved sentences are keyed to
   the chapter list the bundle just replaced: state.json lands with
   `sentencesPredateChapters: true`. No local sentences (absent file, empty
   array), a rename import and a fresh folder stamp nothing.

   Like scan-import-folder.test.ts, this writes into the workspace the test
   process loaded (paths.ts captures WORKSPACE_DIR at module load), with a
   unique title per case and cleanup after. */

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZipFile } from 'yazl';
import { importPortableBundle } from './scan-import-folder.js';
import { BOOKS_ROOT, manuscriptEditsJsonPath, stateJsonPath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';

function fixtureState(title: string, extra: Partial<BookStateJson> = {}): BookStateJson {
  return {
    ...extra,
    bookId: `demo__standalones__${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    manuscriptId: `mns_${title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    title,
    author: 'Demo Author',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: true,
    chapters: [
      { id: 1, title: 'Chapter 1', slug: '01-chapter-1' },
      { id: 2, title: 'Chapter 2', slug: '02-chapter-2' },
    ],
    coverGradient: ['#abc', '#def'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

/** The bundle layout build-portable-book.ts writes, minus cover and audio. */
function makeBundle(state: BookStateJson): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    const manifest = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedFrom: { appVersion: '0.0.0' },
      book: { bookId: state.bookId, title: state.title, author: state.author, series: state.series },
      contents: { stateJsonHash: 'stub', manuscriptHash: 'stub', audioCount: 0, totalSizeBytes: 0 },
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'MANIFEST.json');
    zip.addBuffer(Buffer.from(JSON.stringify(state, null, 2), 'utf8'), 'state.json');
    zip.addBuffer(Buffer.from('# Chapter 1\nbody one\n# Chapter 2\nbody two\n', 'utf8'), state.manuscriptFile);
    zip.end();
  });
}

const targetDirFor = (state: BookStateJson, title?: string): string =>
  join(BOOKS_ROOT, state.author, state.series, title ?? state.title);

const readState = (dir: string): BookStateJson =>
  JSON.parse(readFileSync(stateJsonPath(dir), 'utf8')) as BookStateJson;

const EDITS_WITH_SENTENCES = JSON.stringify({
  sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'An old-keyed saved sentence.' }],
});

/** Fresh import, then (optionally) a local edits file, then an overwrite import. */
async function overwriteWithLocalEdits(title: string, edits: string | null): Promise<string> {
  const state = fixtureState(title);
  const bundle = await makeBundle(state);
  const target = targetDirFor(state);
  rmSync(target, { recursive: true, force: true });
  await importPortableBundle(bundle, { onConflict: 'fail' });
  expect(readState(target).sentencesPredateChapters).toBeUndefined();
  if (edits !== null) writeFileSync(manuscriptEditsJsonPath(target), edits, 'utf8');
  await importPortableBundle(bundle, { onConflict: 'overwrite' });
  return target;
}

describe('bundle overwrite — stale-evidence marker (plan 290, M27)', () => {
  it('an overwrite onto a book with saved sentences lands the marker and leaves the edits file untouched', async () => {
    const title = 'Marker Overwrite Sentences';
    let target = '';
    try {
      target = await overwriteWithLocalEdits(title, EDITS_WITH_SENTENCES);
      expect(readState(target).sentencesPredateChapters).toBe(true);
      expect(readFileSync(manuscriptEditsJsonPath(target), 'utf8')).toBe(EDITS_WITH_SENTENCES);
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('an unreadable (corrupt) local edits file is treated as stale and stamps the marker', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Corrupt', '{ not json');
      expect(readState(target).sentencesPredateChapters).toBe(true);
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('an overwrite onto a book with no edits file stamps nothing', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Absent', null);
      expect(existsSync(manuscriptEditsJsonPath(target))).toBe(false);
      expect(readState(target)).not.toHaveProperty('sentencesPredateChapters');
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('an overwrite onto a book whose edits hold an empty sentences array stamps nothing', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Empty', JSON.stringify({ sentences: [] }));
      expect(readState(target)).not.toHaveProperty('sentencesPredateChapters');
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('a rename import beside a book with saved sentences stamps nothing', async () => {
    const state = fixtureState('Marker Rename');
    const bundle = await makeBundle(state);
    const existing = targetDirFor(state);
    rmSync(existing, { recursive: true, force: true });
    let renamed = '';
    try {
      await importPortableBundle(bundle, { onConflict: 'fail' });
      writeFileSync(manuscriptEditsJsonPath(existing), EDITS_WITH_SENTENCES, 'utf8');
      const result = await importPortableBundle(bundle, { onConflict: 'rename' });
      renamed = result.targetPath;
      expect(renamed).not.toBe(existing);
      expect(readState(renamed)).not.toHaveProperty('sentencesPredateChapters');
      /* The existing book is not touched by a rename import. */
      expect(readState(existing)).not.toHaveProperty('sentencesPredateChapters');
    } finally {
      rmSync(existing, { recursive: true, force: true });
      if (renamed) rmSync(renamed, { recursive: true, force: true });
    }
  });

  it('an import into a fresh folder stamps nothing', async () => {
    const state = fixtureState('Marker Fresh Folder');
    const target = targetDirFor(state);
    rmSync(target, { recursive: true, force: true });
    try {
      await importPortableBundle(await makeBundle(state), { onConflict: 'overwrite' });
      expect(readState(target)).not.toHaveProperty('sentencesPredateChapters');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  describe("a marker carried in the bundle's own state.json is stripped (only the stamp decides)", () => {
    const carried = (title: string) => fixtureState(title, { sentencesPredateChapters: true });

    it('fresh import', async () => {
      const state = carried('Marker Carried Fresh');
      const target = targetDirFor(state);
      rmSync(target, { recursive: true, force: true });
      try {
        await importPortableBundle(await makeBundle(state), { onConflict: 'fail' });
        expect(readState(target)).not.toHaveProperty('sentencesPredateChapters');
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });

    it('rename import', async () => {
      const state = carried('Marker Carried Rename');
      const bundle = await makeBundle(state);
      const existing = targetDirFor(state);
      rmSync(existing, { recursive: true, force: true });
      let renamed = '';
      try {
        await importPortableBundle(bundle, { onConflict: 'fail' });
        const result = await importPortableBundle(bundle, { onConflict: 'rename' });
        renamed = result.targetPath;
        expect(renamed).not.toBe(existing);
        expect(readState(renamed)).not.toHaveProperty('sentencesPredateChapters');
      } finally {
        rmSync(existing, { recursive: true, force: true });
        if (renamed) rmSync(renamed, { recursive: true, force: true });
      }
    });

    it('overwrite onto a target with an empty sentences array', async () => {
      const state = carried('Marker Carried Overwrite Empty');
      const bundle = await makeBundle(state);
      const target = targetDirFor(state);
      rmSync(target, { recursive: true, force: true });
      try {
        await importPortableBundle(bundle, { onConflict: 'fail' });
        writeFileSync(manuscriptEditsJsonPath(target), JSON.stringify({ sentences: [] }), 'utf8');
        await importPortableBundle(bundle, { onConflict: 'overwrite' });
        expect(readState(target)).not.toHaveProperty('sentencesPredateChapters');
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });
  });
});
