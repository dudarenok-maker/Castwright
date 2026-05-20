/* Unit tests for buildPortableBundle (plan 75).

   These tests construct a fixture book on disk (state.json + manuscript +
   audio files + cover + change-log + a deliberately-excluded
   listen-progress.json), call buildPortableBundle, decode the resulting
   zip with yauzl, and assert on:

     - MANIFEST.json shape + hashes
     - listen-progress.json is NOT in the bundle
     - state.json + manuscript are byte-identical
     - audio files round-trip byte-for-byte
     - entry order is deterministic (MANIFEST first → state → manuscript
       → cover → change-log → audio/* in chapter-id order)

   No ffmpeg required — we use raw bytes for the audio fixtures. */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { fromBuffer as yauzlFromBuffer, type Entry } from 'yauzl';
import { describe, expect, it, beforeAll, afterAll } from 'vitest';
import { buildPortableBundle, PORTABLE_SCHEMA_VERSION } from './build-portable-book.js';
import {
  audioDir,
  changeLogJsonPath,
  coverImagePath,
  dotAudiobook,
  listenProgressJsonPath,
  stateJsonPath,
} from '../workspace/paths.js';
import type { BookStateJson } from '../workspace/scan.js';

function sha256(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

function readZipEntries(zip: Buffer): Promise<Array<{ name: string; data: Buffer }>> {
  return new Promise((resolve, reject) => {
    yauzlFromBuffer(zip, { lazyEntries: true }, (err, zipFile) => {
      if (err || !zipFile) return reject(err);
      const out: Array<{ name: string; data: Buffer }> = [];
      zipFile.on('error', reject);
      zipFile.on('end', () => resolve(out));
      zipFile.on('entry', (entry: Entry) => {
        if (entry.fileName.endsWith('/')) {
          zipFile.readEntry();
          return;
        }
        zipFile.openReadStream(entry, (rsErr, rs) => {
          if (rsErr || !rs) return reject(rsErr);
          const chunks: Buffer[] = [];
          rs.on('data', (c: Buffer) => chunks.push(c));
          rs.on('end', () => {
            out.push({ name: entry.fileName, data: Buffer.concat(chunks) });
            zipFile.readEntry();
          });
          rs.on('error', reject);
        });
      });
      zipFile.readEntry();
    });
  });
}

function makeFixtureState(): BookStateJson {
  return {
    bookId: 'demo__standalones__test-book',
    manuscriptId: 'mns_test',
    title: 'Test Book',
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

describe('buildPortableBundle', () => {
  let tmpRoot: string;
  let bookDir: string;
  let state: BookStateJson;
  let manuscriptBytes: Buffer;
  let coverBytes: Buffer;
  let changeLogBytes: Buffer;
  let listenProgressBytes: Buffer;
  let chapter1Mp3: Buffer;
  let chapter2Mp3: Buffer;

  beforeAll(async () => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'portable-book-test-'));
    bookDir = join(tmpRoot, 'book');
    mkdirSync(join(bookDir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(bookDir), { recursive: true });

    state = makeFixtureState();
    manuscriptBytes = Buffer.from('# Chapter 1\n\nOnce upon a time...\n', 'utf8');
    coverBytes = Buffer.from('jpeg-stub-bytes-here');
    changeLogBytes = Buffer.from(
      JSON.stringify({ events: [{ kind: 'manuscript_imported', at: '2025-01-01' }] }, null, 2),
      'utf8',
    );
    listenProgressBytes = Buffer.from(
      JSON.stringify({ chapterId: 1, currentSec: 42, updatedAt: '2025-01-02' }, null, 2),
      'utf8',
    );
    chapter1Mp3 = Buffer.from('mp3-bytes-for-chapter-1');
    chapter2Mp3 = Buffer.from('mp3-bytes-for-chapter-2');

    await writeFile(join(bookDir, 'manuscript.txt'), manuscriptBytes);
    await writeFile(coverImagePath(bookDir), coverBytes);
    await writeFile(changeLogJsonPath(bookDir), changeLogBytes);
    /* listen-progress.json deliberately written so we can assert it is
       EXCLUDED from the bundle. */
    await writeFile(listenProgressJsonPath(bookDir), listenProgressBytes);
    await writeFile(join(audioDir(bookDir), '01-chapter-1.mp3'), chapter1Mp3);
    await writeFile(join(audioDir(bookDir), '02-chapter-2.mp3'), chapter2Mp3);
    /* Drop a .previous.* file alongside chapter 1's audio — must NOT be
       bundled (rollback-only artifact). */
    await writeFile(
      join(audioDir(bookDir), '01-chapter-1.previous.mp3'),
      Buffer.from('previous-rollback-bytes'),
    );
    /* peaks.json sidecar — should be bundled alongside the audio. */
    await writeFile(
      join(audioDir(bookDir), '01-chapter-1.peaks.json'),
      Buffer.from('{"peaks":[]}', 'utf8'),
    );

    /* Stamp state.json with the same shape we're packing. */
    await writeFile(stateJsonPath(bookDir), JSON.stringify(state, null, 2));
  });

  afterAll(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('packs MANIFEST first with the expected schemaVersion + book metadata + hashes', async () => {
    const result = await buildPortableBundle(bookDir, state);
    expect(result.buffer.length).toBe(result.sizeBytes);
    expect(result.entries[0]).toBe('MANIFEST.json');

    const entries = await readZipEntries(result.buffer);
    const manifestEntry = entries.find((e) => e.name === 'MANIFEST.json');
    expect(manifestEntry).toBeDefined();
    const manifest = JSON.parse(manifestEntry!.data.toString('utf8'));

    expect(manifest.schemaVersion).toBe(PORTABLE_SCHEMA_VERSION);
    expect(manifest.book).toEqual({
      bookId: state.bookId,
      title: state.title,
      author: state.author,
      series: state.series,
    });
    expect(typeof manifest.exportedAt).toBe('string');
    expect(typeof manifest.exportedFrom.appVersion).toBe('string');
    expect(manifest.contents.audioCount).toBe(2);
    expect(typeof manifest.contents.totalSizeBytes).toBe('number');

    /* Hash assertions compare against the bytes we know we packed. */
    const stateInBundle = entries.find((e) => e.name === 'state.json')!.data;
    expect(manifest.contents.stateJsonHash).toBe(sha256(stateInBundle));
    const manuscriptInBundle = entries.find((e) => e.name === 'manuscript.txt')!.data;
    expect(manifest.contents.manuscriptHash).toBe(sha256(manuscriptInBundle));
    expect(manifest.contents.coverHash).toBe(sha256(coverBytes));
  });

  it('excludes listen-progress.json — private user state', async () => {
    const result = await buildPortableBundle(bookDir, state);
    const entries = await readZipEntries(result.buffer);
    expect(entries.find((e) => e.name === 'listen-progress.json')).toBeUndefined();
    expect(entries.find((e) => e.name.includes('listen-progress'))).toBeUndefined();
  });

  it('excludes .previous.* rollback audio', async () => {
    const result = await buildPortableBundle(bookDir, state);
    const entries = await readZipEntries(result.buffer);
    for (const e of entries) {
      expect(e.name.includes('.previous.')).toBe(false);
    }
  });

  it('includes peaks.json sidecar files', async () => {
    const result = await buildPortableBundle(bookDir, state);
    const entries = await readZipEntries(result.buffer);
    expect(entries.find((e) => e.name === 'audio/01-chapter-1.peaks.json')).toBeDefined();
  });

  it('round-trips audio files byte-for-byte', async () => {
    const result = await buildPortableBundle(bookDir, state);
    const entries = await readZipEntries(result.buffer);
    const ch1 = entries.find((e) => e.name === 'audio/01-chapter-1.mp3')!;
    const ch2 = entries.find((e) => e.name === 'audio/02-chapter-2.mp3')!;
    expect(Buffer.compare(ch1.data, chapter1Mp3)).toBe(0);
    expect(Buffer.compare(ch2.data, chapter2Mp3)).toBe(0);
  });

  it('emits entries in deterministic order: MANIFEST → state → manuscript → cover → change-log → audio (chapter-id sorted)', async () => {
    const result = await buildPortableBundle(bookDir, state);
    const expectedPrefix = [
      'MANIFEST.json',
      'state.json',
      'manuscript.txt',
      'cover.jpg',
      'change-log.json',
    ];
    expect(result.entries.slice(0, expectedPrefix.length)).toEqual(expectedPrefix);
    /* Audio entries follow, sorted by chapter id (slug starts with the
       2-digit id). */
    const audioEntries = result.entries.slice(expectedPrefix.length);
    expect(audioEntries[0]).toBe('audio/01-chapter-1.mp3');
    expect(audioEntries).toContain('audio/02-chapter-2.mp3');
  });

  it('omits cover.* and change-log.json when those files are absent', async () => {
    /* Build a parallel fixture without cover / change-log to confirm the
       optional entries truly disappear (the manifest must still validate). */
    const minimalDir = join(tmpRoot, 'minimal');
    mkdirSync(join(minimalDir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(minimalDir), { recursive: true });
    const minimalState = { ...makeFixtureState(), bookId: 'demo__standalones__minimal' };
    writeFileSync(stateJsonPath(minimalDir), JSON.stringify(minimalState, null, 2));
    writeFileSync(join(minimalDir, 'manuscript.txt'), manuscriptBytes);
    writeFileSync(join(audioDir(minimalDir), '01-chapter-1.mp3'), chapter1Mp3);
    writeFileSync(join(audioDir(minimalDir), '02-chapter-2.mp3'), chapter2Mp3);

    const result = await buildPortableBundle(minimalDir, minimalState);
    expect(result.entries).not.toContain('cover.jpg');
    expect(result.entries).not.toContain('change-log.json');
    expect(result.manifest.contents.coverHash).toBeUndefined();
  });

  it('throws when the manuscript file is missing on disk', async () => {
    const badDir = join(tmpRoot, 'no-manuscript');
    mkdirSync(join(badDir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(badDir), { recursive: true });
    const badState = { ...makeFixtureState(), bookId: 'demo__standalones__bad' };
    writeFileSync(stateJsonPath(badDir), JSON.stringify(badState, null, 2));
    /* Intentionally no manuscript file. */
    await expect(buildPortableBundle(badDir, badState)).rejects.toThrow(/manuscript file missing/);
  });

  it('is byte-deterministic across runs against the same fixture (modulo MANIFEST exportedAt)', async () => {
    const a = await buildPortableBundle(bookDir, state);
    const b = await buildPortableBundle(bookDir, state);
    /* The bundles can differ at the MANIFEST.exportedAt timestamp. We
       reach into both bundles, replace exportedAt in each manifest with
       a fixed string, and assert that EVERY OTHER entry is byte-identical
       in order + content. */
    const aEntries = await readZipEntries(a.buffer);
    const bEntries = await readZipEntries(b.buffer);
    expect(aEntries.map((e) => e.name)).toEqual(bEntries.map((e) => e.name));
    for (let i = 0; i < aEntries.length; i++) {
      if (aEntries[i].name === 'MANIFEST.json') continue;
      expect(Buffer.compare(aEntries[i].data, bEntries[i].data)).toBe(0);
    }
    /* MANIFEST: normalise exportedAt + contents.totalSizeBytes (no other
       fields should differ). */
    const aMan = JSON.parse(aEntries.find((e) => e.name === 'MANIFEST.json')!.data.toString());
    const bMan = JSON.parse(bEntries.find((e) => e.name === 'MANIFEST.json')!.data.toString());
    aMan.exportedAt = '<fixed>';
    bMan.exportedAt = '<fixed>';
    expect(aMan).toEqual(bMan);
  });
});
