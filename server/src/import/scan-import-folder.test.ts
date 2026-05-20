/* Unit + round-trip tests for importPortableBundle (plan 75).

   Conflict-strategy tests cover 'rename', 'overwrite', 'fail'. The
   round-trip test exports a fixture book → imports it to a fresh
   workspace dir → asserts every chapter mp3 + state.json + manuscript are
   byte-identical. */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { buildPortableBundle } from '../export/build-portable-book.js';
import {
  BundleConflictError,
  InvalidBundleError,
  importPortableBundle,
} from './scan-import-folder.js';
import { ZipFile } from 'yazl';
import { audioDir, dotAudiobook, stateJsonPath } from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';

/** Build a tiny portable bundle in-memory without going through the real
    build pipeline — gives the import-side tests a stable, ffmpeg-free
    input. The bundle layout matches what build-portable-book.ts writes. */
function makeBundleFixture(state: BookStateJson): Promise<Buffer> {
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
    const cover = Buffer.from('cover-stub');
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
    zip.addBuffer(cover, 'cover.jpg');
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
    const bundle = await makeBundleFixture(state);
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
    const bundle = await makeBundleFixture(state);

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
    const bundle = await makeBundleFixture(state);
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

  it("'overwrite' strategy writes into the existing dir, preserving files not in the bundle", async () => {
    const state = fixtureState({ title: 'Overwrite Test' });
    const bundle = await makeBundleFixture(state);
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
});
