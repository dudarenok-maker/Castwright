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
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { buildPortableBundle, PORTABLE_SCHEMA_VERSION } from './build-portable-book.js';

/* One-shot intercept for node:fs's createReadStream — lets the crash-
   regression test below (see its own comment) delete a target audio file
   at the EXACT moment buildPortableBundle's audio loop asks to stream it,
   before Node's real (async) fs.open() behind the real createReadStream
   can possibly have resolved. buildPortableBundle's own audio loop has no
   `await` between entries (unlike build-mp3-zip.ts / build-codec-zip.ts,
   which expose an `onProgress` hook that fires mid-loop), so there's no
   production seam to piggyback a deletion on — this mock IS that seam,
   test-only, deterministic, and a no-op passthrough for every other call
   (every other test in this file goes through the real `real.
   createReadStream(...)` below unchanged). */
let deleteOnRead: string | null = null;
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    createReadStream: (...args: Parameters<typeof real.createReadStream>) => {
      const path = args[0];
      if (deleteOnRead && path === deleteOnRead) {
        real.rmSync(deleteOnRead, { force: true });
      }
      return real.createReadStream(...args);
    },
  };
});

/* Behavioral regression for the ZipFile-level `zip.on('error', reject)`
   listener in buildPortableBundle's own `done` promise (this file's
   production module, ~line 291) — a SEPARATE line from the one shared by
   buildMp3Zip/buildCodecZip (build-mp3-zip.ts's createZipWritePipeline):
   buildPortableBundle drives yazl into an in-memory Buffer via its own
   `new Promise` rather than that shared helper. See build-captions.test.ts's
   identical mock (the reference implementation this is copied from) for
   the full explanation of why the injected error is emitted via
   `process.nextTick` rather than synchronously during construction: `new
   Promise(executor)` auto-catches a *synchronous* throw inside its executor
   and turns it into a rejection on its own, so emitting synchronously from
   the ZipFile constructor would "pass" this test even with the fix line
   deleted, for JS's reasons rather than buildPortableBundle's own
   forwarding. Scheduling via `process.nextTick` moves the emit outside that
   frame — same as yazl's real internal error sites — so an absent
   `zip.on('error', reject)` reproduces the real bug: zero listeners, an
   `uncaughtException`, and the bundle promise never settling. */
let triggerZipFileError: Error | null = null;
/* Same mechanism aimed at a different emitter: real yazl also emits
   `'error'` on `zip.outputStream` itself for a bad write (distinct from the
   ZipFile-level validation failures above), and
   `zip.outputStream.on('error', rejectBuild)` (~build-portable-book.ts:307)
   is its own separate forwarding line — the only one of the pipeline's
   three error forwarders left uncovered by this file's tests (see the test
   below). Unlike build-mp3-zip.test.ts's equivalent, this one stays safe to
   drive through the full nextTick/Promise.race shape: buildPortableBundle's
   audio loop has no `await` between entries (see the ZipFile-level test's
   own comment above), so `await done` is reached synchronously right after
   `zip.end()` regardless of how much real per-chapter work happened —
   there's no "wait for N real ffmpeg spawns" gate for contention to stretch
   past the race's timeout. */
let triggerOutputStreamError: Error | null = null;
/* N6 regression (found in passing while reviewing this PR): captures the
   most recently constructed ZipFile instance so a test can inspect its
   `outputStream` after a build has rejected — see the test near the
   bottom of this file. */
let lastZipFile: InstanceType<typeof import('yazl').ZipFile> | null = null;
vi.mock('yazl', async (importOriginal) => {
  const real = await importOriginal<typeof import('yazl')>();
  class TestZipFile extends real.ZipFile {
    constructor() {
      super();
      // eslint-disable-next-line @typescript-eslint/no-this-alias -- test-only capture of the constructed instance, see comment above.
      lastZipFile = this;
      if (triggerZipFileError) {
        const err = triggerZipFileError;
        process.nextTick(() => {
          this.emit('error', err);
        });
      }
      if (triggerOutputStreamError) {
        const err = triggerOutputStreamError;
        process.nextTick(() => {
          this.outputStream.emit('error', err);
        });
      }
    }
  }
  return { ...real, ZipFile: TestZipFile };
});
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

  /* Same defect class as build-mp3-zip.ts's own regression test (see that
     file's comment for the full root cause): `zip.addReadStream(
     createReadStream(a.diskPath), ...)` hands yazl a raw readStream. yazl's
     `addFile` attaches its own `readStream.on('error', ...)` before pumping
     — `addReadStream` does not, and `.pipe()` never forwards 'error' from
     source to destination. A read failure on that stream (e.g. an audio
     file vanishing between being enumerated and being zipped) had zero
     listeners: Node throws it as an uncaught exception, killing the whole
     server (crash-logging.ts's uncaughtException handler exits 1) instead
     of just failing this export.

     buildPortableBundle's audio loop has no `onProgress` hook and no
     `await` between entries, so this test uses the `createReadStream`
     intercept declared at the top of this file instead: it deletes
     `01-chapter-1.mp3` the INSTANT buildPortableBundle asks to stream it,
     before Node's real (async) fs.open() behind the real createReadStream
     can possibly have resolved — deterministic on any platform, no sleep
     or poll required. */
  it('forwards a deleted-audio-file read error instead of crashing the process', async () => {
    const raceDir = join(tmpRoot, 'race');
    mkdirSync(join(raceDir, 'audio'), { recursive: true });
    mkdirSync(dotAudiobook(raceDir), { recursive: true });
    const raceState = { ...makeFixtureState(), bookId: 'demo__standalones__race' };
    writeFileSync(stateJsonPath(raceDir), JSON.stringify(raceState, null, 2));
    writeFileSync(join(raceDir, 'manuscript.txt'), manuscriptBytes);
    const doomedPath = join(audioDir(raceDir), '01-chapter-1.mp3');
    writeFileSync(doomedPath, chapter1Mp3);
    writeFileSync(join(audioDir(raceDir), '02-chapter-2.mp3'), chapter2Mp3);

    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    deleteOnRead = doomedPath;
    try {
      await expect(buildPortableBundle(raceDir, raceState)).rejects.toThrow(/ENOENT/);
    } finally {
      process.off('uncaughtException', onUncaught);
      deleteOnRead = null;
    }
    // The real assertion: nothing escaped as a raw uncaught exception. If
    // this is non-null, the read-stream error crashed the process instead
    // of rejecting buildPortableBundle's own promise.
    expect(escaped).toBeNull();
  }, 10_000);

  /* Reviewer finding: `zip.on('error', reject)` in buildPortableBundle's
     own `done` promise had NO regression test — deleting that one line and
     running the whole export suite left every test green, including this
     file's.

     An `addBuffer`-only bundle (MANIFEST/state.json/manuscript, no audio)
     is NOT a sufficient repro (tried first, see PR discussion): those
     writes are purely synchronous byte copies with `compress: false` — no
     genuine async gap for the injected error to actually interrupt — so
     yazl's own completion races ahead and finishes on its own regardless
     of whether the listener exists, silently masking the missing
     forwarding rather than exposing it. At least one REAL `addReadStream`
     audio entry (a genuine async fs read, same as build-mp3-zip.ts /
     build-codec-zip.ts) is what actually gives the disruption something in
     flight to interrupt — confirmed empirically: this test hangs to the 1s
     race timeout without the fix, and resolves instantly with it. */
  it('forwards a ZipFile-level internal error to the rejection instead of crashing the process', async () => {
    const errDir = join(tmpRoot, 'ziperr');
    mkdirSync(join(errDir, 'audio'), { recursive: true });
    const errState = { ...makeFixtureState(), bookId: 'demo__standalones__ziperr' };
    writeFileSync(join(errDir, 'manuscript.txt'), manuscriptBytes);
    writeFileSync(join(errDir, 'audio', '01-chapter-1.mp3'), chapter1Mp3);

    const injected = new Error('mock yazl internal validation failure (ZipFile-level)');
    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    triggerZipFileError = injected;
    try {
      const raced = await Promise.race([
        buildPortableBundle(errDir, errState).then(
          (r) => ({ kind: 'resolved' as const, value: r }),
          (e) => ({ kind: 'rejected' as const, value: e }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), 1000),
        ),
      ]);
      // With the listener wired, the injected error rejects
      // buildPortableBundle's own promise with the SAME error object.
      // Without it, the promise never settles at all — that's the
      // 'timeout' branch, a deliberate, fast, diagnosable failure instead
      // of waiting on vitest's own test timeout.
      expect(raced.kind).toBe('rejected');
      expect((raced as { kind: 'rejected'; value: unknown }).value).toBe(injected);
    } finally {
      process.off('uncaughtException', onUncaught);
      triggerZipFileError = null;
    }
    // The other half of the regression: the injected error must have been
    // forwarded to the rejection, NOT escaped as a raw uncaught exception.
    expect(escaped).toBeNull();
  }, 10_000);

  /* The last uncovered `'error'` forwarder in server/src/export/: unlike
     build-mp3-zip.ts / build-codec-zip.ts (createZipWritePipeline), which
     pipe `zip.outputStream` into a real write stream, buildPortableBundle
     consumes it directly via 'data'/'end' — so nothing else in this module
     ever attaches an 'error' listener to it either. Drop
     `zip.outputStream.on('error', rejectBuild)` here and a bad write has
     zero listeners: the same uncaughtException → exit(1) crash class this
     module exists to avoid, with no test to notice (all 122 export tests
     stay green without it).

     Same injection + assertion shape as the ZipFile-level test above,
     aimed at `outputStream` instead of the ZipFile object itself — see this
     describe block's `triggerOutputStreamError` mock comment (top of file)
     for why this one stays safe to race with a fixed 1s timeout even though
     build-mp3-zip.ts's identically-shaped test was not (no real per-chapter
     I/O gates `await done` here). */
  it('forwards an outputStream-level write error to the rejection instead of crashing the process', async () => {
    const errDir = join(tmpRoot, 'outputstreamerr');
    mkdirSync(join(errDir, 'audio'), { recursive: true });
    const errState = { ...makeFixtureState(), bookId: 'demo__standalones__outputstreamerr' };
    writeFileSync(join(errDir, 'manuscript.txt'), manuscriptBytes);
    writeFileSync(join(errDir, 'audio', '01-chapter-1.mp3'), chapter1Mp3);

    const injected = new Error('mock yazl write failure (outputStream-level)');
    let escaped: unknown = null;
    const onUncaught = (err: unknown) => {
      escaped = err;
    };
    process.on('uncaughtException', onUncaught);
    triggerOutputStreamError = injected;
    try {
      const raced = await Promise.race([
        buildPortableBundle(errDir, errState).then(
          (r) => ({ kind: 'resolved' as const, value: r }),
          (e) => ({ kind: 'rejected' as const, value: e }),
        ),
        new Promise<{ kind: 'timeout' }>((resolve) =>
          setTimeout(() => resolve({ kind: 'timeout' }), 1000),
        ),
      ]);
      // With the listener wired, the injected error rejects
      // buildPortableBundle's own promise with the SAME error object.
      // Without it, the promise never settles at all — that's the
      // 'timeout' branch, a deliberate, fast, diagnosable failure instead
      // of waiting on vitest's own test timeout.
      expect(raced.kind).toBe('rejected');
      expect((raced as { kind: 'rejected'; value: unknown }).value).toBe(injected);
    } finally {
      process.off('uncaughtException', onUncaught);
      triggerOutputStreamError = null;
    }
    // The other half of the regression: the injected error must have been
    // forwarded to the rejection, NOT escaped as a raw uncaught exception.
    expect(escaped).toBeNull();
  }, 10_000);

  /* N6 (found in passing, independent review — not the subject of this
     PR's original crash fix): before errors here rejected instead of
     crashing the process, nothing downstream of an 'error' event ever ran.
     Once rejection became the normal failure path, `zip.outputStream`'s
     'data' listener kept accumulating `chunks` after the promise had
     already settled — an unbounded (well, bounded by the rest of the
     bundle) memory cost for a Buffer nobody would ever read. Fixed by
     detaching the listener the instant the promise settles.

     Reuses the same ZipFile-level-error injection as the test above
     (`triggerZipFileError`) so the promise rejects deterministically, then
     inspects the captured ZipFile instance's `outputStream` — a listener
     count of 0 for 'data' is the direct, black-box-observable signal that
     the accumulation stopped; deleting the `.off('data', onData)` call in
     build-portable-book.ts leaves this at 1 (it was never removed) and
     reddens this test without needing to observe `chunks` itself, which
     isn't exposed outside the module. */
  it('stops accumulating output chunks once the build has already rejected (N6)', async () => {
    const errDir = join(tmpRoot, 'n6-leak');
    mkdirSync(join(errDir, 'audio'), { recursive: true });
    const errState = { ...makeFixtureState(), bookId: 'demo__standalones__n6leak' };
    writeFileSync(join(errDir, 'manuscript.txt'), manuscriptBytes);
    writeFileSync(join(errDir, 'audio', '01-chapter-1.mp3'), chapter1Mp3);

    const injected = new Error('mock yazl internal validation failure (ZipFile-level, N6)');
    triggerZipFileError = injected;
    try {
      await expect(buildPortableBundle(errDir, errState)).rejects.toBe(injected);
    } finally {
      triggerZipFileError = null;
    }

    expect(lastZipFile).not.toBeNull();
    expect(lastZipFile!.outputStream.listenerCount('data')).toBe(0);
  }, 10_000);
});
