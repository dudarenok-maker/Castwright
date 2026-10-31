/* Plan 290 (#3837) — the bundle overwrite stamps the stale-evidence marker
   (M27). A portable bundle never carries manuscript-edits.json and an
   overwrite leaves the local one in place, so its saved sentences are keyed to
   the chapter list the bundle just replaced: state.json lands with
   `sentencesPredateChapters: true`. No local sentences (absent file, empty
   array), a rename import and a fresh folder stamp nothing.

   Like scan-import-folder.test.ts, this writes into the workspace the test
   process loaded (paths.ts captures WORKSPACE_DIR at module load), with a
   unique title per case and cleanup after.

   The last case drives an analysis Start through the start seam (Task 5), so
   the analyzer is stubbed as in analysis.title-flags.test.ts: a Start that is
   not refused never reaches a real model. */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { ZipFile } from 'yazl';
import { importPortableBundle } from './scan-import-folder.js';
import { BOOKS_ROOT, manuscriptEditsJsonPath, stateJsonPath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';
import type { Analyzer, AnalyzerSelection } from '../analyzer/index.js';
import type { Stage1ChapterOutput, Stage2ChapterOutput } from '../handoff/schemas.js';

/* PR #3966 review pass 2 -- fails the FIRST rename whose destination is `path`
   with EBUSY (the scan-import-folder.test.ts pattern). A pass-through otherwise. */
const failRename = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    rename: (async (from: string, to: string) => {
      if (failRename.path !== null && to === failRename.path) {
        failRename.path = null;
        throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' });
      }
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});
vi.mock('../routes/ollama-health.js', () => ({
  detectOllamaDevice: vi.fn(async () => 'cuda'),
  unloadResidentOllama: vi.fn(async () => {}),
}));
vi.mock('../gpu/analyzer-device-state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gpu/analyzer-device-state.js')>()),
  setLastKnownAnalyzerDevice: vi.fn(),
}));
vi.mock('../analyzer/select-analyzer.js', async () => {
  const actual = await vi.importActual<typeof import('../analyzer/select-analyzer.js')>(
    '../analyzer/select-analyzer.js',
  );
  return {
    ...actual,
    selectAnalyzerForPhase: (opts: { phase: 'phase0' | 'phase1' }) => {
      const g = globalThis as Record<string, unknown>;
      if (g.__overwrite_marker_test_selection) return g.__overwrite_marker_test_selection;
      return actual.selectAnalyzerForPhase(opts as Parameters<typeof actual.selectAnalyzerForPhase>[0]);
    },
    isPerPhaseModelSelectionActive: () => false,
  };
});

afterEach(() => {
  delete (globalThis as Record<string, unknown>).__overwrite_marker_test_selection;
  failRename.path = null;
});

function fixtureState(title: string, extra: Partial<BookStateJson> = {}): BookStateJson {
  return {
    ...extra,
    bookId: `demo__standalones__${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    manuscriptId: `mns_${title.toLowerCase().replace(/[^a-z0-9]+/g, '')}`,
    title,
    language: 'en',
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
function makeBundle(state: BookStateJson, manuscript = '# Chapter 1\nbody one\n# Chapter 2\nbody two\n'): Promise<Buffer> {
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
    zip.addBuffer(Buffer.from(manuscript, 'utf8'), state.manuscriptFile);
    zip.end();
  });
}

function stubSelection(): AnalyzerSelection {
  const analyzer: Analyzer = {
    runStage1: () => Promise.reject(new Error('not used')),
    async runStage1Chapter(): Promise<Stage1ChapterOutput> {
      return { characters: [] } as unknown as Stage1ChapterOutput;
    },
    async runStage2Chapter(): Promise<Stage2ChapterOutput> {
      return { sentences: [] };
    },
    runEmotionChapter: () => Promise.reject(new Error('not used')),
    runScriptReviewChapter: () => Promise.reject(new Error('not used')),
    runStage3Chapter: () => Promise.reject(new Error('not used')),
    runAttributionEscalation: () => Promise.resolve(null),
  };
  return { analyzer, engine: 'gemini', model: 'stub-model', fallbackModel: null, fallbackEngine: null };
}

const targetDirFor = (state: BookStateJson, title?: string): string =>
  join(BOOKS_ROOT, state.author, state.series, title ?? state.title);

const readState = (dir: string): BookStateJson =>
  JSON.parse(readFileSync(stateJsonPath(dir), 'utf8')) as BookStateJson;

const EDITS_WITH_SENTENCES = JSON.stringify({
  sentences: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'An old-keyed saved sentence.' }],
});

/** Fresh import, then (optionally) a local edit of the target's state.json and
    a local edits file, then an overwrite import of the same bundle. Without a
    `localState` edit the target's chapter list equals the bundle's. */
async function overwriteWithLocalEdits(
  title: string,
  edits: string | null,
  localState?: (s: BookStateJson) => void,
): Promise<string> {
  const state = fixtureState(title);
  const bundle = await makeBundle(state);
  const target = targetDirFor(state);
  rmSync(target, { recursive: true, force: true });
  await importPortableBundle(bundle, { onConflict: 'fail' });
  expect(readState(target).sentencesPredateChapters).toBeUndefined();
  if (localState) {
    const live = readState(target);
    localState(live);
    writeFileSync(stateJsonPath(target), JSON.stringify(live), 'utf8');
  }
  if (edits !== null) writeFileSync(manuscriptEditsJsonPath(target), edits, 'utf8');
  await importPortableBundle(bundle, { onConflict: 'overwrite' });
  return target;
}

/* Round 10 (#3837): the overwrite stamps only when the bundle's chapter list
   (ids + titles, in order) differs from the target's, or the target is
   already marked. */
const retitleChapter2 = (s: BookStateJson) => {
  s.chapters[1]!.title = 'Chapter Two (merged)';
};
const renumberChapter2 = (s: BookStateJson) => {
  s.chapters[1]!.id = 3;
};
const dropChapter2 = (s: BookStateJson) => {
  s.chapters.splice(1, 1);
};
const alreadyMarked = (s: BookStateJson) => {
  s.sentencesPredateChapters = true;
};

describe('bundle overwrite — stale-evidence marker (plan 290, M27)', () => {
  it.each([
    ['a retitled chapter', 'Title', retitleChapter2],
    ['a renumbered chapter', 'Id', renumberChapter2],
    ['a different chapter count', 'Count', dropChapter2],
  ] as const)(
    'an overwrite onto a book with saved sentences and %s lands the marker; the edits file is untouched',
    async (_label, tag, localState) => {
      let target = '';
      try {
        target = await overwriteWithLocalEdits(`Marker Overwrite Differs ${tag}`, EDITS_WITH_SENTENCES, localState);
        expect(readState(target).sentencesPredateChapters).toBe(true);
        expect(readFileSync(manuscriptEditsJsonPath(target), 'utf8')).toBe(EDITS_WITH_SENTENCES);
      } finally {
        if (target) rmSync(target, { recursive: true, force: true });
      }
    },
  );

  it('a same-chapters overwrite onto a book with saved sentences stamps nothing (a restore of the same structure)', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Same', EDITS_WITH_SENTENCES);
      expect(readState(target)).not.toHaveProperty('sentencesPredateChapters');
      expect(readFileSync(manuscriptEditsJsonPath(target), 'utf8')).toBe(EDITS_WITH_SENTENCES);
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('a same-chapters overwrite onto an already-marked book with saved sentences keeps the marker', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Marked', EDITS_WITH_SENTENCES, alreadyMarked);
      expect(readState(target).sentencesPredateChapters).toBe(true);
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('an unreadable (corrupt) local edits file is treated as stale and stamps the marker when the chapters differ', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Corrupt', '{ not json', retitleChapter2);
      expect(readState(target).sentencesPredateChapters).toBe(true);
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('an overwrite onto a book with no edits file stamps nothing, even when the chapters differ', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Absent', null, retitleChapter2);
      expect(existsSync(manuscriptEditsJsonPath(target))).toBe(false);
      expect(readState(target)).not.toHaveProperty('sentencesPredateChapters');
    } finally {
      if (target) rmSync(target, { recursive: true, force: true });
    }
  });

  it('an overwrite onto a book whose edits hold an empty sentences array stamps nothing', async () => {
    let target = '';
    try {
      target = await overwriteWithLocalEdits('Marker Overwrite Empty', JSON.stringify({ sentences: [] }), retitleChapter2);
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

  it('after a stamped (structure-changing) overwrite and a restart, Start is not refused with hints_out_of_sync', async () => {
    /* The local edits hold each line under the OTHER chapter: evidence the start seam's
       sentence check would refuse on score. The overwrite changes the chapter list (the
       target's chapter 2 was retitled), so it stamps the marker, and the seam uses
       main's count/id rule instead. */
    const line = (w: string) => `"${w} is the word," she said, and nothing more.`;
    const state: BookStateJson = {
      ...fixtureState('Marker Overwrite Start'),
      manuscriptFile: 'manuscript.md',
      language: 'en',
      chapters: [
        { id: 1, title: 'Alpha', slug: '01-alpha' },
        { id: 2, title: 'Beta', slug: '02-beta' },
      ],
    };
    const bundle = await makeBundle(state, `# Alpha\n\n${line('Amber')}\n\n# Beta\n\n${line('Cobalt')}\n`);
    const target = targetDirFor(state);
    rmSync(target, { recursive: true, force: true });
    try {
      await importPortableBundle(bundle, { onConflict: 'fail' });
      const live = readState(target);
      live.chapters[1]!.title = 'Beta (renamed)';
      writeFileSync(stateJsonPath(target), JSON.stringify(live), 'utf8');
      writeFileSync(
        manuscriptEditsJsonPath(target),
        JSON.stringify({
          sentences: [
            { id: 1, chapterId: 1, characterId: 'nova', text: line('Cobalt') },
            { id: 1, chapterId: 2, characterId: 'nova', text: line('Amber') },
          ],
        }),
        'utf8',
      );
      await importPortableBundle(bundle, { onConflict: 'overwrite' });
      expect(readState(target).sentencesPredateChapters).toBe(true);

      const { removeManuscript, getOrHydrateManuscript } = await import('../store/manuscripts.js');
      removeManuscript(state.manuscriptId); // a restart
      expect((await getOrHydrateManuscript(state.manuscriptId))!.hintsSource).toBe('parse');
      (globalThis as Record<string, unknown>).__overwrite_marker_test_selection = stubSelection();
      const { analysisRouter } = await import('../routes/analysis.js');
      const app = express();
      app.use(express.json());
      app.use('/api/manuscripts', analysisRouter);
      const res = await request(app).post(`/api/manuscripts/${state.manuscriptId}/analysis`).send({});
      expect(res.body?.code).not.toBe('hints_out_of_sync');
      expect(res.status).toBe(200);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  }, 60_000);

  /* Owner round 11 (PR #3966): an overwrite that stamps the marker clears the
     analysis cache of the manuscriptId the book keeps -- its takes are keyed to
     the chapter list the bundle replaced, and a main run would replay them. An
     overwrite that stamps nothing leaves the cache as it was. */
  describe('the analysis cache (owner round 11)', () => {
    const CACHE_BYTES = JSON.stringify({ chapters: { 1: [{ id: 1, chapterId: 1, characterId: 'narrator', text: 'Old take.' }] } });

    async function overwriteWithCache(
      title: string,
      localState?: (s: BookStateJson) => void,
      failStateRename = false,
    ) {
      const state = fixtureState(title);
      const bundle = await makeBundle(state);
      const target = targetDirFor(state);
      rmSync(target, { recursive: true, force: true });
      await importPortableBundle(bundle, { onConflict: 'fail' });
      if (localState) {
        const live = readState(target);
        localState(live);
        writeFileSync(stateJsonPath(target), JSON.stringify(live), 'utf8');
      }
      writeFileSync(manuscriptEditsJsonPath(target), EDITS_WITH_SENTENCES, 'utf8');
      const { cachePath } = await import('../store/analysis-cache.js');
      const cacheFile = cachePath(state.manuscriptId);
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, CACHE_BYTES, 'utf8');
      if (failStateRename) {
        failRename.path = stateJsonPath(target);
        await expect(importPortableBundle(bundle, { onConflict: 'overwrite' })).rejects.toThrow(/EBUSY/);
      } else {
        await importPortableBundle(bundle, { onConflict: 'overwrite' });
      }
      return { target, cacheFile };
    }

    it('a structure-changing overwrite (marker stamped) removes the cache of the kept manuscriptId', async () => {
      let paths: { target: string; cacheFile: string } | undefined;
      try {
        paths = await overwriteWithCache('Marker Overwrite Cache Differs', retitleChapter2);
        expect(readState(paths.target).sentencesPredateChapters).toBe(true);
        expect(readState(paths.target).manuscriptId).toBe(fixtureState('Marker Overwrite Cache Differs').manuscriptId);
        expect(existsSync(paths.cacheFile)).toBe(false);
      } finally {
        if (paths) {
          rmSync(paths.target, { recursive: true, force: true });
          rmSync(paths.cacheFile, { force: true });
        }
      }
    });

    /* PR #3966 review pass 2 -- the clear is gated on the bundle's state.json
       having LANDED (`stateLanded`): a structure-changing overwrite whose
       state.json rename fails leaves the old, unmarked state live, so its cache
       still matches it and must stay. */
    it('a structure-changing overwrite whose state.json rename fails surfaces the error and leaves the cache byte-identical', async () => {
      let paths: { target: string; cacheFile: string } | undefined;
      try {
        paths = await overwriteWithCache('Marker Overwrite Cache State Fails', retitleChapter2, true);
        expect(readState(paths.target)).not.toHaveProperty('sentencesPredateChapters');
        expect(readState(paths.target).chapters[1]!.title).toBe('Chapter Two (merged)');
        expect(readFileSync(paths.cacheFile, 'utf8')).toBe(CACHE_BYTES);
      } finally {
        if (paths) {
          rmSync(paths.target, { recursive: true, force: true });
          rmSync(paths.cacheFile, { force: true });
        }
      }
    });

    it('a same-chapters overwrite (no marker) leaves the cache byte-identical', async () => {
      let paths: { target: string; cacheFile: string } | undefined;
      try {
        paths = await overwriteWithCache('Marker Overwrite Cache Same');
        expect(readState(paths.target)).not.toHaveProperty('sentencesPredateChapters');
        expect(readFileSync(paths.cacheFile, 'utf8')).toBe(CACHE_BYTES);
      } finally {
        if (paths) {
          rmSync(paths.target, { recursive: true, force: true });
          rmSync(paths.cacheFile, { force: true });
        }
      }
    });
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
