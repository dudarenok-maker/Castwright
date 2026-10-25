/* Unit + round-trip tests for importPortableBundle (plan 75).

   Conflict-strategy tests cover 'rename', 'overwrite', 'fail'. The
   round-trip test exports a fixture book → imports it to a fresh
   workspace dir → asserts every chapter mp3 + state.json + manuscript are
   byte-identical. */

import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { buildPortableBundle } from '../export/build-portable-book.js';
import {
  BundleConflictError,
  InvalidBundleError,
  importPortableBundle,
} from './scan-import-folder.js';
import { ZipFile } from 'yazl';

/* #3625 — widens the unlocked check-then-mkdir window so the concurrency tests
   below race deterministically: the FIRST mkdir of `slowMkdir.path` stalls. A
   pass-through for every other call. */
const slowMkdir = vi.hoisted(() => ({ path: null as string | null, ms: 250 }));
/* #3703 -- fails the FIRST rename whose destination is `path` with EBUSY. */
const failRename = vi.hoisted(() => ({ path: null as string | null }));
vi.mock('node:fs/promises', async () => {
  const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  return {
    ...actual,
    mkdir: (async (p: string, ...rest: unknown[]) => {
      if (slowMkdir.path !== null && p === slowMkdir.path) {
        slowMkdir.path = null;
        await new Promise((r) => setTimeout(r, slowMkdir.ms));
      }
      return (actual.mkdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    }) as typeof actual.mkdir,
    rename: (async (from: string, to: string) => {
      if (failRename.path !== null && to === failRename.path) {
        failRename.path = null;
        throw Object.assign(new Error('EBUSY: injected'), { code: 'EBUSY' });
      }
      return actual.rename(from, to);
    }) as typeof actual.rename,
  };
});
import sharp from 'sharp';
import {
  audioDir,
  dotAudiobook,
  manuscriptHintsJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import {
  buildHintsEntry,
  composeHintsFile,
  hintsFromPersisted,
  sha256Hex,
  writeManuscriptHints,
} from '../workspace/manuscript-hints.js';
import type { BookStateJson } from '../workspace/scan.js';
import { __stateJsonWaitersForTest, withStateJsonLock } from '../workspace/file-lock.js';

/** Build a tiny portable bundle in-memory without going through the real
    build pipeline — gives the import-side tests a stable, ffmpeg-free
    input. The bundle layout matches what build-portable-book.ts writes. */
function tinyImage(format: 'jpeg' | 'png' | 'gif' | 'webp', width = 8, height = 12): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#c33' } })
    .toFormat(format)
    .toBuffer();
}

function makeBundleFixture(
  state: BookStateJson,
  cover: Buffer | null,
  extraCovers: [string, Buffer][] = [],
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);

    const stateBuf = Buffer.from(JSON.stringify(state, null, 2), 'utf8');
    const manuscriptBuf = Buffer.from('# Title\nbody\n', 'utf8');
    const audio1 = Buffer.from('mp3-bytes-1');
    const audio2 = Buffer.from('mp3-bytes-2');
    const peaks = Buffer.from('{"peaks":[]}', 'utf8');
    const changeLog = Buffer.from(JSON.stringify({ events: [] }), 'utf8');

    const manifest = {
      schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      exportedFrom: { appVersion: '0.0.0' },
      book: {
        bookId: state.bookId,
        title: state.title,
        author: state.author,
        series: state.series,
      },
      contents: {
        stateJsonHash: 'stub',
        manuscriptHash: 'stub',
        audioCount: 2,
        totalSizeBytes: 0,
      },
    };
    zip.addBuffer(Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'), 'MANIFEST.json');
    zip.addBuffer(stateBuf, 'state.json');
    zip.addBuffer(manuscriptBuf, state.manuscriptFile);
    for (const [n, b] of extraCovers) zip.addBuffer(b, n);
    if (cover) zip.addBuffer(cover, 'cover.jpg');
    zip.addBuffer(changeLog, 'change-log.json');
    zip.addBuffer(audio1, 'audio/01-chapter-1.mp3');
    zip.addBuffer(audio2, 'audio/02-chapter-2.mp3');
    zip.addBuffer(peaks, 'audio/01-chapter-1.peaks.json');
    zip.end();
  });
}

function fixtureState(overrides: Partial<BookStateJson> = {}): BookStateJson {
  return {
    bookId: 'demo__standalones__import-test',
    manuscriptId: 'mns_import',
    title: 'Import Test',
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
    ...overrides,
  };
}

let tmpRoot: string;
let originalWorkspaceDir: string | undefined;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'import-portable-test-'));
  originalWorkspaceDir = process.env.WORKSPACE_DIR;
  /* paths.ts captures WORKSPACE_DIR at module load via top-level resolve(),
     so changing the env after the fact won't move BOOKS_ROOT for already-
     imported modules. We sidestep that by writing into the actual workspace
     the test process loaded, then cleaning up after each case. Each
     fixture state has a unique title to avoid cross-test collision. */
  void originalWorkspaceDir;
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

import { BOOKS_ROOT } from '../workspace/paths.js';

/** Compute the target dir for a given title. */
function targetDirFor(state: BookStateJson, title?: string): string {
  return join(BOOKS_ROOT, state.author, state.series, title ?? state.title);
}

describe('importPortableBundle', () => {
  it('writes state.json, manuscript, cover, change-log, and audio files to the workspace', async () => {
    const state = fixtureState({ title: 'Import Basic Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const result = await importPortableBundle(bundle, { onConflict: 'fail' });

    expect(result.bookId).toBe(state.bookId);
    const target = targetDirFor(state);
    expect(result.targetPath).toBe(target);

    /* Every expected path exists. */
    const stateRead = JSON.parse(readFileSync(stateJsonPath(target), 'utf8'));
    expect(stateRead.title).toBe('Import Basic Test');
    expect(readFileSync(join(target, 'manuscript.txt')).toString()).toContain('Title');
    expect(readFileSync(join(dotAudiobook(target), 'cover.jpg')).length).toBeGreaterThan(0);
    expect(readFileSync(join(dotAudiobook(target), 'change-log.json'))).toBeDefined();
    expect(readFileSync(join(audioDir(target), '01-chapter-1.mp3')).toString()).toBe('mp3-bytes-1');
    expect(readFileSync(join(audioDir(target), '02-chapter-2.mp3')).toString()).toBe('mp3-bytes-2');
    expect(readFileSync(join(audioDir(target), '01-chapter-1.peaks.json')).toString()).toContain(
      'peaks',
    );

    /* Cleanup */
    rmSync(target, { recursive: true, force: true });
  });

  it.each(['gif', 'webp', 'png'] as const)(
    'stores a %s cover.jpg entry as a real JPEG (#3535)',
    async (format) => {
      const state = fixtureState({ title: `Import Cover ${format} Test` });
      const bundle = await makeBundleFixture(state, await tinyImage(format));
      await importPortableBundle(bundle, { onConflict: 'fail' });
      const target = targetDirFor(state);
      try {
        const stored = readFileSync(join(dotAudiobook(target), 'cover.jpg'));
        expect((await sharp(stored).metadata()).format).toBe('jpeg');
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    },
  );

  it('skips an undecodable cover entry and still imports the book (#3535)', async () => {
    const state = fixtureState({ title: 'Import Bad Cover Test' });
    const bundle = await makeBundleFixture(state, Buffer.from('not-an-image'));
    const result = await importPortableBundle(bundle, { onConflict: 'fail' });
    const target = targetDirFor(state);
    try {
      expect(result.bookId).toBe(state.bookId);
      expect(existsSync(join(dotAudiobook(target), 'cover.jpg'))).toBe(false);
      expect(readFileSync(join(audioDir(target), '01-chapter-1.mp3')).toString()).toBe('mp3-bytes-1');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it.each([['cover.png', 'png'], ['cover.thumb.jpg', 'jpeg']] as const)(
    'imports a bundle with cover.jpg plus a second %s entry: audio lands, one JPEG cover (#3535)',
    async (extraName, format) => {
      const state = fixtureState({ title: `Import Two Covers ${format} Test` });
      const bundle = await makeBundleFixture(state, await tinyImage('jpeg'), [
        [extraName, await tinyImage(format)],
      ]);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const target = targetDirFor(state);
      try {
        await importPortableBundle(bundle, { onConflict: 'fail' });
        const stored = readFileSync(join(dotAudiobook(target), 'cover.jpg'));
        expect((await sharp(stored).metadata()).format).toBe('jpeg');
        expect(readFileSync(join(audioDir(target), '01-chapter-1.mp3')).toString()).toBe(
          'mp3-bytes-1',
        );
        expect(readdirSync(dotAudiobook(target)).filter((f) => f.includes('.tmp-'))).toEqual([]);
        expect(warn).toHaveBeenCalled();
      } finally {
        warn.mockRestore();
        rmSync(target, { recursive: true, force: true });
      }
    },
  );

  it.each([
    {
      label: 'an exact cover.jpg wins over an earlier cover.png',
      cover: () => tinyImage('jpeg', 6, 6),
      extras: async (): Promise<[string, Buffer][]> => [['cover.png', await tinyImage('png', 20, 10)]],
      expected: [6, 6],
    },
    {
      label: 'an undecodable cover.jpg falls through to a decodable cover.png',
      cover: async () => Buffer.from('not-an-image'),
      extras: async (): Promise<[string, Buffer][]> => [['cover.png', await tinyImage('png', 7, 3)]],
      expected: [7, 3],
    },
    {
      label: 'with no cover.jpg the first decodable cover.* entry wins',
      cover: async () => null,
      extras: async (): Promise<[string, Buffer][]> => [
        ['cover.bad', Buffer.from('not-an-image')],
        ['cover.png', await tinyImage('png', 9, 5)],
        ['cover.gif', await tinyImage('gif', 4, 4)],
      ],
      expected: [9, 5],
    },
  ])('cover selection: $label (#3535)', async ({ cover, extras, expected }) => {
    const state = fixtureState({ title: `Import Cover Select ${expected.join('x')} Test` });
    const bundle = await makeBundleFixture(state, await cover(), await extras());
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const target = targetDirFor(state);
    try {
      await importPortableBundle(bundle, { onConflict: 'fail' });
      const meta = await sharp(readFileSync(join(dotAudiobook(target), 'cover.jpg'))).metadata();
      expect([meta.width, meta.height]).toEqual(expected);
    } finally {
      warn.mockRestore();
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('rejects a bundle missing MANIFEST.json', async () => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    const done = new Promise<Buffer>((resolve) =>
      zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))),
    );
    zip.addBuffer(Buffer.from('{}'), 'state.json');
    zip.end();
    const buf = await done;
    await expect(importPortableBundle(buf)).rejects.toBeInstanceOf(InvalidBundleError);
  });

  it('rejects a bundle whose schemaVersion is newer than this server understands', async () => {
    const state = fixtureState({ title: 'Future Schema Test' });
    const buf = await (async () => {
      const zip = new ZipFile();
      const chunks: Buffer[] = [];
      zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
      const done = new Promise<Buffer>((resolve) =>
        zip.outputStream.on('end', () => resolve(Buffer.concat(chunks))),
      );
      zip.addBuffer(
        Buffer.from(
          JSON.stringify({
            schemaVersion: 999,
            exportedAt: '2099-01-01',
            exportedFrom: { appVersion: '99.0.0' },
            book: state,
            contents: {
              stateJsonHash: '',
              manuscriptHash: '',
              audioCount: 0,
              totalSizeBytes: 0,
            },
          }),
        ),
        'MANIFEST.json',
      );
      zip.addBuffer(Buffer.from(JSON.stringify(state)), 'state.json');
      zip.addBuffer(Buffer.from('mfile'), state.manuscriptFile);
      zip.end();
      return done;
    })();
    await expect(importPortableBundle(buf)).rejects.toMatchObject({ reason: 'unsupported_schema' });
  });

  it("default 'rename' strategy appends ' (imported)' on conflict and rewrites bookId/title in state.json", async () => {
    const state = fixtureState({ title: 'Rename Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));

    /* Pre-create the target dir to force a collision. */
    const existing = targetDirFor(state);
    mkdirSync(existing, { recursive: true });
    try {
      const result = await importPortableBundle(bundle); // default rename
      expect(result.conflict).toEqual({
        strategy: 'rename',
        renamedTo: targetDirFor(state, 'Rename Test (imported)'),
      });
      expect(result.targetPath).toContain(' (imported)');

      const stateRead = JSON.parse(readFileSync(stateJsonPath(result.targetPath), 'utf8'));
      expect(stateRead.title).toBe('Rename Test (imported)');
      expect(stateRead.bookId).not.toBe(state.bookId);
      expect(result.bookId).toBe(stateRead.bookId);

      /* Cleanup */
      rmSync(result.targetPath, { recursive: true, force: true });
    } finally {
      rmSync(existing, { recursive: true, force: true });
    }
  });

  it("'fail' strategy throws BundleConflictError without writing", async () => {
    const state = fixtureState({ title: 'Fail Conflict Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    mkdirSync(target, { recursive: true });
    try {
      await expect(importPortableBundle(bundle, { onConflict: 'fail' })).rejects.toBeInstanceOf(
        BundleConflictError,
      );
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  /* #3625 — the conflict decision is made under the target's state lock, so two
     concurrent imports of one title can't both see "free". */
  it("two concurrent 'fail' imports of one title: one succeeds, one conflicts", async () => {
    const state = fixtureState({ title: 'Concurrent Fail Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    rmSync(target, { recursive: true, force: true });
    slowMkdir.path = target;
    try {
      const results = await Promise.allSettled([
        importPortableBundle(bundle, { onConflict: 'fail' }),
        importPortableBundle(bundle, { onConflict: 'fail' }),
      ]);
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason).toBeInstanceOf(BundleConflictError);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("'overwrite' replaces an existing book's state.json only under the state-json lock (#3700)", async () => {
    const state = fixtureState({ title: 'Overwrite Lock Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    mkdirSync(dotAudiobook(target), { recursive: true });
    const sp = stateJsonPath(target);
    writeFileSync(sp, JSON.stringify({ marker: 'old-book' }));
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => {
        release = r;
      });
      let acquired!: () => void;
      const gotLock = new Promise<void>((r) => {
        acquired = r;
      });
      const holder = withStateJsonLock(sp, () => {
        acquired();
        return held;
      });
      await gotLock;
      const pending = importPortableBundle(bundle, { onConflict: 'overwrite' });
      const deadline = Date.now() + 5000;
      while (__stateJsonWaitersForTest(sp) < 1 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 5));
      }
      expect(__stateJsonWaitersForTest(sp), 'import never queued on the lock').toBe(1);
      expect(JSON.parse(readFileSync(sp, 'utf8')).marker).toBe('old-book');
      release();
      await holder;
      await pending;
      expect(JSON.parse(readFileSync(sp, 'utf8')).title).toBe('Overwrite Lock Test');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("two concurrent 'rename' imports of one title land in distinct dirs", async () => {
    const state = fixtureState({ title: 'Concurrent Rename Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    mkdirSync(target, { recursive: true });
    const created: string[] = [];
    slowMkdir.path = targetDirFor(state, 'Concurrent Rename Test (imported)');
    try {
      const [a, b] = await Promise.all([
        importPortableBundle(bundle, { onConflict: 'rename' }),
        importPortableBundle(bundle, { onConflict: 'rename' }),
      ]);
      created.push(a.targetPath, b.targetPath);
      expect(a.targetPath).not.toBe(b.targetPath);
      expect(a.bookId).not.toBe(b.bookId);
    } finally {
      rmSync(target, { recursive: true, force: true });
      for (const c of created) rmSync(c, { recursive: true, force: true });
    }
  });

  it("'overwrite' strategy writes into the existing dir, preserving files not in the bundle", async () => {
    const state = fixtureState({ title: 'Overwrite Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    mkdirSync(join(target, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(target), { recursive: true });
    /* listen-progress.json is excluded from the bundle but should NOT be
       wiped on overwrite. */
    writeFileSync(
      join(dotAudiobook(target), 'listen-progress.json'),
      JSON.stringify({ chapterId: 1, currentSec: 99 }),
    );
    try {
      const result = await importPortableBundle(bundle, { onConflict: 'overwrite' });
      expect(result.targetPath).toBe(target);
      const progressStill = JSON.parse(
        readFileSync(join(dotAudiobook(target), 'listen-progress.json'), 'utf8'),
      );
      expect(progressStill.currentSec).toBe(99);
      /* And the bundle's bytes landed: */
      expect(readFileSync(join(target, 'manuscript.txt')).toString()).toContain('Title');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('round-trip: build → import → bytes match', async () => {
    /* Construct a real on-disk book, run buildPortableBundle on it,
       then importPortableBundle into a renamed target — assert state.json,
       manuscript, and every audio file are byte-identical. */
    const sourceDir = join(tmpRoot, 'source-book');
    mkdirSync(join(sourceDir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(sourceDir), { recursive: true });

    const state = fixtureState({
      title: 'Round Trip Test',
      bookId: 'demo__standalones__round-trip-test',
      language: 'en',
    });
    const manuscript = Buffer.from('chapter one\nchapter two\n', 'utf8');
    const audio1 = Buffer.from('roundtrip-audio-1');
    const audio2 = Buffer.from('roundtrip-audio-2');
    writeFileSync(stateJsonPath(sourceDir), JSON.stringify(state, null, 2));
    writeFileSync(join(sourceDir, 'manuscript.txt'), manuscript);
    writeFileSync(join(audioDir(sourceDir), '01-chapter-1.mp3'), audio1);
    writeFileSync(join(audioDir(sourceDir), '02-chapter-2.mp3'), audio2);

    const built = await buildPortableBundle(sourceDir, state);
    /* Target is forced into the standard workspace tree (the import path
       resolves location from state.author/series/title), so the test
       cleans up after itself. */
    const importedTarget = targetDirFor(state);
    /* Ensure no pre-existing collision. */
    rmSync(importedTarget, { recursive: true, force: true });
    try {
      const result = await importPortableBundle(built.buffer, { onConflict: 'fail' });
      expect(result.targetPath).toBe(importedTarget);

      const importedState = JSON.parse(readFileSync(stateJsonPath(importedTarget), 'utf8'));
      expect(importedState).toEqual(state);
      expect(Buffer.compare(readFileSync(join(importedTarget, 'manuscript.txt')), manuscript)).toBe(
        0,
      );
      expect(
        Buffer.compare(readFileSync(join(audioDir(importedTarget), '01-chapter-1.mp3')), audio1),
      ).toBe(0);
      expect(
        Buffer.compare(readFileSync(join(audioDir(importedTarget), '02-chapter-2.mp3')), audio2),
      ).toBe(0);
    } finally {
      rmSync(importedTarget, { recursive: true, force: true });
    }
  });

  describe('manuscript-hints.json (#3703)', () => {
    const hintsState = () =>
      fixtureState({
        title: 'Hints Round Trip',
        bookId: 'demo__standalones__hints-round-trip',
        language: 'en',
        chapters: [
          { id: 1, title: 'Chapter 1', slug: '01-chapter-1', uuid: 'u-1' },
          { id: 2, title: 'Chapter 2', slug: '02-chapter-2', uuid: 'u-2' },
        ],
      });

    function writeSourceBook(state: BookStateJson, manuscript: Buffer): string {
      const sourceDir = join(tmpRoot, 'hints-source-book');
      mkdirSync(audioDir(sourceDir), { recursive: true });
      mkdirSync(dotAudiobook(sourceDir), { recursive: true });
      writeFileSync(stateJsonPath(sourceDir), JSON.stringify(state, null, 2));
      writeFileSync(join(sourceDir, 'manuscript.txt'), manuscript);
      return sourceDir;
    }

    it('round-trip carries .audiobook/manuscript-hints.json byte-identical', async () => {
      const state = hintsState();
      const manuscript = Buffer.from('chapter one\nchapter two\n', 'utf8');
      const sourceDir = writeSourceBook(state, manuscript);
      const persisted = composeHintsFile(buildHintsEntry({
        manuscriptId: state.manuscriptId!,
        manuscriptFile: state.manuscriptFile,
        sourceSha256: sha256Hex(manuscript),
        hints: [
          { id: 1, body: 'merged body A' },
          { id: 2, body: 'merged body B' },
        ],
        stateChapters: state.chapters,
      }), null, state, sha256Hex(manuscript));
      await writeManuscriptHints(sourceDir, persisted);

      const built = await buildPortableBundle(sourceDir, state);
      const importedTarget = targetDirFor(state);
      rmSync(importedTarget, { recursive: true, force: true });
      try {
        await importPortableBundle(built.buffer, { onConflict: 'fail' });
        expect(
          Buffer.compare(
            readFileSync(manuscriptHintsJsonPath(importedTarget)),
            readFileSync(manuscriptHintsJsonPath(sourceDir)),
          ),
        ).toBe(0);
      } finally {
        rmSync(importedTarget, { recursive: true, force: true });
      }
    });

    it('the imported file is still valid for the imported state.json and manuscript', async () => {
      const state = hintsState();
      const manuscript = Buffer.from('chapter one\nchapter two\n', 'utf8');
      const sourceDir = writeSourceBook(state, manuscript);
      await writeManuscriptHints(
        sourceDir,
        composeHintsFile(buildHintsEntry({
          manuscriptId: state.manuscriptId!,
          manuscriptFile: state.manuscriptFile,
          sourceSha256: sha256Hex(manuscript),
          hints: [
            { id: 1, body: 'not what a fresh parse gives A' },
            { id: 2, body: 'not what a fresh parse gives B' },
          ],
          stateChapters: state.chapters,
        }), null, state, sha256Hex(manuscript)),
      );

      const built = await buildPortableBundle(sourceDir, state);
      const importedTarget = targetDirFor(state);
      rmSync(importedTarget, { recursive: true, force: true });
      try {
        await importPortableBundle(built.buffer, { onConflict: 'fail' });
        /* findBookByManuscriptId needs the workspace scan cache, which this
           harness does not populate, so validate the imported files with the
           same check getOrHydrateManuscript runs. */
        const importedState = JSON.parse(readFileSync(stateJsonPath(importedTarget), 'utf8'));
        const importedManuscript = readFileSync(join(importedTarget, 'manuscript.txt'));
        const file = JSON.parse(readFileSync(manuscriptHintsJsonPath(importedTarget), 'utf8'));
        const res = hintsFromPersisted(file, importedState, sha256Hex(importedManuscript));
        expect(res.ok).toBe(true);
        if (res.ok) {
          expect(res.hints.map((h) => h.body)).toEqual([
            'not what a fresh parse gives A',
            'not what a fresh parse gives B',
          ]);
        }
      } finally {
        rmSync(importedTarget, { recursive: true, force: true });
      }
    });

    it('a book without the file stays without it', async () => {
      const state = hintsState();
      const sourceDir = writeSourceBook(state, Buffer.from('chapter one\nchapter two\n', 'utf8'));
      const built = await buildPortableBundle(sourceDir, state);
      expect(built.entries).not.toContain('manuscript-hints.json');
      const importedTarget = targetDirFor(state);
      rmSync(importedTarget, { recursive: true, force: true });
      try {
        await importPortableBundle(built.buffer, { onConflict: 'fail' });
        expect(existsSync(manuscriptHintsJsonPath(importedTarget))).toBe(false);
      } finally {
        rmSync(importedTarget, { recursive: true, force: true });
      }
    });

    /* Review pass 2: a restructure that moves a passage between chapters (split ->
       reorder [1,3,2] -> merge [2,3]) lands on the SAME uuid sequence with
       different bodies, and the manuscript file is never edited, so its sha still
       matches. Only the file-level drop on an overwrite import protects the
       restored book. */
    it("'overwrite' with a bundle that carries no hints drops the local manuscript-hints.json", async () => {
      const state = hintsState();
      const manuscript = Buffer.from(
        '# Alpha\n\nAlpha first. Alpha second.\n\n# Beta\n\nBeta first. Beta second.\n',
        'utf8',
      );
      const sourceDir = writeSourceBook(state, manuscript);
      const built = await buildPortableBundle(sourceDir, state);
      expect(built.entries).not.toContain('manuscript-hints.json');

      const target = targetDirFor(state);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(audioDir(target), { recursive: true });
      mkdirSync(dotAudiobook(target), { recursive: true });
      writeFileSync(stateJsonPath(target), JSON.stringify(state, null, 2));
      writeFileSync(join(target, 'manuscript.txt'), manuscript);
      const { getOrHydrateManuscript, removeManuscript } = await import('../store/manuscripts.js');
      try {
        removeManuscript(state.manuscriptId!);
        const original = (await getOrHydrateManuscript(state.manuscriptId!))!.chapterHints.map(
          (h) => h.body,
        );
        removeManuscript(state.manuscriptId!);

        /* The local restructure: same uuids, same manuscript sha, moved bodies. */
        const moved = ['Alpha first.', 'Beta first. Beta second. Alpha second.'];
        await writeManuscriptHints(
          target,
          composeHintsFile(
            buildHintsEntry({
              manuscriptId: state.manuscriptId!,
              manuscriptFile: state.manuscriptFile,
              sourceSha256: sha256Hex(manuscript),
              hints: moved.map((body, i) => ({ id: i + 1, body })),
              stateChapters: state.chapters,
            }),
            null,
            state,
            sha256Hex(manuscript),
          ),
        );
        const hydratedMoved = (await getOrHydrateManuscript(state.manuscriptId!))!.chapterHints.map(
          (h) => h.body,
        );
        expect(hydratedMoved).toEqual(moved); // the stale file is live before the import
        removeManuscript(state.manuscriptId!);

        await importPortableBundle(built.buffer, { onConflict: 'overwrite' });

        expect(existsSync(manuscriptHintsJsonPath(target))).toBe(false);
        const restored = (await getOrHydrateManuscript(state.manuscriptId!))!.chapterHints.map(
          (h) => h.body,
        );
        expect(restored).toEqual(original);
        expect(restored).not.toEqual(moved);
      } finally {
        removeManuscript(state.manuscriptId!);
        rmSync(target, { recursive: true, force: true });
      }
    });

    /* Review pass 3: the hints file must go the moment the bundle's state.json
       is live, not after the whole rename loop -- a later rename failing (EBUSY on
       the manuscript) otherwise leaves the local file beside the restored state. */
    it("'overwrite' that fails after state.json still drops the local manuscript-hints.json", async () => {
      const state = hintsState();
      const manuscript = Buffer.from(
        '# Alpha\n\nAlpha first. Alpha second.\n\n# Beta\n\nBeta first. Beta second.\n',
        'utf8',
      );
      const sourceDir = writeSourceBook(state, manuscript);
      const built = await buildPortableBundle(sourceDir, state);
      expect(built.entries).not.toContain('manuscript-hints.json');

      const target = targetDirFor(state);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(audioDir(target), { recursive: true });
      mkdirSync(dotAudiobook(target), { recursive: true });
      writeFileSync(stateJsonPath(target), JSON.stringify(state, null, 2));
      writeFileSync(join(target, 'manuscript.txt'), manuscript);
      const { getOrHydrateManuscript, removeManuscript } = await import('../store/manuscripts.js');
      try {
        const moved = ['Alpha first.', 'Beta first. Beta second. Alpha second.'];
        await writeManuscriptHints(
          target,
          composeHintsFile(
            buildHintsEntry({
              manuscriptId: state.manuscriptId!,
              manuscriptFile: state.manuscriptFile,
              sourceSha256: sha256Hex(manuscript),
              hints: moved.map((body, i) => ({ id: i + 1, body })),
              stateChapters: state.chapters,
            }),
            null,
            state,
            sha256Hex(manuscript),
          ),
        );
        removeManuscript(state.manuscriptId!);

        failRename.path = join(target, 'manuscript.txt');
        await expect(importPortableBundle(built.buffer, { onConflict: 'overwrite' })).rejects.toThrow(
          /EBUSY/,
        );
        failRename.path = null;

        expect(existsSync(manuscriptHintsJsonPath(target))).toBe(false);
        /* A restart: nothing warm, hydrate from disk. */
        removeManuscript(state.manuscriptId!);
        const hydrated = (await getOrHydrateManuscript(state.manuscriptId!))!.chapterHints.map(
          (h) => h.body,
        );
        expect(hydrated).not.toEqual(moved);
      } finally {
        failRename.path = null;
        removeManuscript(state.manuscriptId!);
        rmSync(target, { recursive: true, force: true });
      }
    });

    it("'overwrite' with a bundle that carries hints replaces the local file with the bundle's", async () => {
      const state = hintsState();
      const manuscript = Buffer.from('chapter one\nchapter two\n', 'utf8');
      const sourceDir = writeSourceBook(state, manuscript);
      const entryFor = (bodies: string[]) =>
        composeHintsFile(
          buildHintsEntry({
            manuscriptId: state.manuscriptId!,
            manuscriptFile: state.manuscriptFile,
            sourceSha256: sha256Hex(manuscript),
            hints: bodies.map((body, i) => ({ id: i + 1, body })),
            stateChapters: state.chapters,
          }),
          null,
          state,
          sha256Hex(manuscript),
        );
      await writeManuscriptHints(sourceDir, entryFor(['bundle A', 'bundle B']));
      const built = await buildPortableBundle(sourceDir, state);

      const target = targetDirFor(state);
      rmSync(target, { recursive: true, force: true });
      mkdirSync(audioDir(target), { recursive: true });
      mkdirSync(dotAudiobook(target), { recursive: true });
      writeFileSync(stateJsonPath(target), JSON.stringify(state, null, 2));
      writeFileSync(join(target, 'manuscript.txt'), manuscript);
      await writeManuscriptHints(target, entryFor(['local A', 'local B']));
      try {
        await importPortableBundle(built.buffer, { onConflict: 'overwrite' });
        expect(
          Buffer.compare(
            readFileSync(manuscriptHintsJsonPath(target)),
            readFileSync(manuscriptHintsJsonPath(sourceDir)),
          ),
        ).toBe(0);
      } finally {
        rmSync(target, { recursive: true, force: true });
      }
    });

    /* #3823 -- a renamed copy is a second book: it must not share the source's
       manuscriptId (one in-memory ManuscriptRecord per id), and its own hints
       must be re-keyed to the fresh id so they still validate. */
    describe("a 'rename' import mints a fresh manuscriptId (#3823)", () => {
      const manuscript = Buffer.from('chapter one\nchapter two\n', 'utf8');
      const readState = (dir: string) => JSON.parse(readFileSync(stateJsonPath(dir), 'utf8'));
      const readHints = (dir: string) =>
        JSON.parse(readFileSync(manuscriptHintsJsonPath(dir), 'utf8'));
      async function bundleWithHints(state: BookStateJson): Promise<Buffer> {
        const sourceDir = writeSourceBook(state, manuscript);
        await writeManuscriptHints(
          sourceDir,
          composeHintsFile(
            buildHintsEntry({
              manuscriptId: state.manuscriptId!,
              manuscriptFile: state.manuscriptFile,
              sourceSha256: sha256Hex(manuscript),
              hints: [
                { id: 1, body: 'restructured A' },
                { id: 2, body: 'restructured B' },
              ],
              stateChapters: state.chapters,
            }),
            null,
            state,
            sha256Hex(manuscript),
          ),
        );
        return (await buildPortableBundle(sourceDir, state)).buffer;
      }

      it('two renamed copies get distinct ids; the source twin is untouched', async () => {
        const state = hintsState();
        const bundle = await bundleWithHints(state);
        const original = targetDirFor(state);
        rmSync(original, { recursive: true, force: true });
        const copies: string[] = [];
        try {
          await importPortableBundle(bundle, { onConflict: 'fail' });
          const originalHintsBytes = readFileSync(manuscriptHintsJsonPath(original));
          for (let i = 0; i < 2; i++) {
            const r = await importPortableBundle(bundle); // default rename
            copies.push(r.targetPath);
          }
          const ids = [original, ...copies].map((d) => readState(d).manuscriptId);
          expect(ids[0]).toBe(state.manuscriptId);
          expect(new Set(ids).size).toBe(3);
          /* "restructuring" a copy rewrites only that copy's hints file. */
          await writeManuscriptHints(copies[0]!, { schema: 1, entries: [] });
          expect(Buffer.compare(readFileSync(manuscriptHintsJsonPath(original)), originalHintsBytes)).toBe(0);
          expect(readHints(copies[1]!).entries.length).toBe(1);
        } finally {
          for (const d of [original, ...copies]) rmSync(d, { recursive: true, force: true });
        }
      });

      it("the copy's persisted hints re-key to its fresh id and still validate", async () => {
        const state = hintsState();
        const bundle = await bundleWithHints(state);
        const original = targetDirFor(state);
        rmSync(original, { recursive: true, force: true });
        let copy = '';
        try {
          await importPortableBundle(bundle, { onConflict: 'fail' });
          copy = (await importPortableBundle(bundle)).targetPath;
          const copyState = readState(copy);
          expect(copyState.manuscriptId).not.toBe(state.manuscriptId);
          const file = readHints(copy);
          expect(file.entries.every((e: { manuscriptId: string }) => e.manuscriptId === copyState.manuscriptId)).toBe(true);
          const res = hintsFromPersisted(file, copyState, sha256Hex(readFileSync(join(copy, 'manuscript.txt'))));
          expect(res.ok).toBe(true);
          if (res.ok) expect(res.hints.map((h) => h.body)).toEqual(['restructured A', 'restructured B']);
          /* the source twin's own hints still carry the source id */
          expect(readHints(original).entries[0].manuscriptId).toBe(state.manuscriptId);
        } finally {
          rmSync(original, { recursive: true, force: true });
          if (copy) rmSync(copy, { recursive: true, force: true });
        }
      });

      it("'overwrite' keeps the bundle's manuscriptId", async () => {
        const state = hintsState();
        const bundle = await bundleWithHints(state);
        const target = targetDirFor(state);
        rmSync(target, { recursive: true, force: true });
        try {
          await importPortableBundle(bundle, { onConflict: 'fail' });
          await importPortableBundle(bundle, { onConflict: 'overwrite' });
          expect(readState(target).manuscriptId).toBe(state.manuscriptId);
          expect(readHints(target).entries[0].manuscriptId).toBe(state.manuscriptId);
        } finally {
          rmSync(target, { recursive: true, force: true });
        }
      });
    });
  });

  it("imports a bundle whose state.json has no language as language:null (key present)", async () => {
    const state = fixtureState({ title: 'No Language Import' }); // no `language` key
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    rmSync(target, { recursive: true, force: true });
    try {
      await importPortableBundle(bundle, { onConflict: 'fail' });
      const onDisk = JSON.parse(readFileSync(stateJsonPath(target), 'utf8'));
      expect('language' in onDisk).toBe(true);
      expect(onDisk.language).toBeNull();
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it('round-trips a language a bundle carries', async () => {
    const state = fixtureState({ title: 'Language Import', language: 'fr' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    rmSync(target, { recursive: true, force: true });
    try {
      await importPortableBundle(bundle, { onConflict: 'fail' });
      const onDisk = JSON.parse(readFileSync(stateJsonPath(target), 'utf8'));
      expect(onDisk.language).toBe('fr');
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("'overwrite' promotes state.json only after the state lock is released (#3625)", async () => {
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    const { stateJsonPath: stateJsonPathForLock } = await import('../workspace/paths.js');
    const state = fixtureState({ title: 'Overwrite Lock Test' });
    const bundle = await makeBundleFixture(state, await tinyImage('jpeg'));
    const target = targetDirFor(state);
    mkdirSync(dotAudiobook(target), { recursive: true });
    const existing = JSON.stringify({ ...state, title: 'Existing Book' });
    writeFileSync(stateJsonPath(target), existing);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let acquired!: () => void;
    const got = new Promise<void>((r) => (acquired = r));
    const held = withStateJsonLock(stateJsonPathForLock(target), async () => {
      acquired();
      await gate;
    });
    await got;
    try {
      const pending = importPortableBundle(bundle, { onConflict: 'overwrite' });
      await new Promise((r) => setTimeout(r, 200));
      expect(readFileSync(stateJsonPath(target), 'utf8')).toBe(existing);
      release();
      await Promise.all([pending, held]);
      expect(JSON.parse(readFileSync(stateJsonPath(target), 'utf8')).title).toBe(
        'Overwrite Lock Test',
      );
    } finally {
      release();
      rmSync(target, { recursive: true, force: true });
    }
  });
});
