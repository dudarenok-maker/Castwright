/* #3625 pass-1 review — an 'overwrite' portable import that cannot take the
   state lock must not leak its staged `.tmp-*` files.

   `withKeyLock` never runs the callback when acquisition times out, so cleanup
   that lives INSIDE the `withStateJsonLock` callback is skipped on exactly that
   failure. withStateJsonLock is mocked here (a real 10s budget would race
   vitest's own timeout), so this lives apart from the real-lock tests in
   scan-import-folder.test.ts.

   #3711 — the bundle is staged under `<workspace>/.staging/<nonce>/` (not as
   `.tmp-*` siblings of the live files) and the staging dir is removed in a
   `finally`, so "nothing leaked" now means this import's staging dir does not
   survive and no staged file reached the target. */

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { isLockAcquisitionTimeout } from '../workspace/file-lock.js';
import { audioDir, BOOKS_ROOT, dotAudiobook, stateJsonPath } from '../workspace/paths.js';
import { makeStagingDir } from '../workspace/portable-staging.js';
import { importPortableBundle } from './scan-import-folder.js';

vi.mock('../workspace/file-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/file-lock.js')>();
  return { ...actual, withStateJsonLock: vi.fn(actual.withStateJsonLock) };
});

/* The server test forks share one workspace, so the global `.staging/` can hold
   a concurrent import test's dir; wrap makeStagingDir to learn THIS import's
   exact dir by identity rather than by diffing the directory listing. */
vi.mock('../workspace/portable-staging.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/portable-staging.js')>();
  return { ...actual, makeStagingDir: vi.fn(actual.makeStagingDir) };
});

function bundle(title: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    const state = {
      bookId: 'demo__standalones__lock-timeout',
      manuscriptId: 'mns_lock_timeout',
      title,
      author: 'Demo Author',
      series: 'Standalones',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
      coverGradient: ['#abc', '#def'],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
    };
    zip.addBuffer(
      Buffer.from(
        JSON.stringify({
          schemaVersion: 1,
          exportedAt: new Date().toISOString(),
          exportedFrom: { appVersion: '0.0.0' },
          book: { bookId: state.bookId, title, author: state.author, series: state.series },
          contents: { stateJsonHash: 'stub', manuscriptHash: 'stub', audioCount: 1, totalSizeBytes: 0 },
        }),
      ),
      'MANIFEST.json',
    );
    zip.addBuffer(Buffer.from(JSON.stringify(state)), 'state.json');
    zip.addBuffer(Buffer.from('# Title\nbody\n'), 'manuscript.txt');
    zip.addBuffer(Buffer.from('mp3-bytes-1'), 'audio/01-chapter-1.mp3');
    zip.end();
  });
}

const tmpFilesUnder = (dir: string): string[] =>
  readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((f) => f.includes('.tmp-'));

describe('importPortableBundle — lock-acquisition timeout (#3625)', () => {
  it("'overwrite' removes every staged tmp file when the state lock times out", async () => {
    const { withStateJsonLock } = await import('../workspace/file-lock.js');
    const title = 'Overwrite Lock Timeout';
    const target = join(BOOKS_ROOT, 'Demo Author', 'Standalones', title);
    mkdirSync(audioDir(target), { recursive: true });
    mkdirSync(dotAudiobook(target), { recursive: true });
    const existing = JSON.stringify({ title: 'Existing Book' });
    writeFileSync(stateJsonPath(target), existing);
    const actual = await vi.importActual<typeof import('../workspace/file-lock.js')>(
      '../workspace/file-lock.js',
    );
    /* The overwrite takes the target's state lock ONCE, for the promote, after
       every entry is staged; that call times out. */
    vi.mocked(makeStagingDir).mockClear();
    let stagedAtTimeout: boolean[] = [];
    vi.mocked(withStateJsonLock)
      .mockImplementationOnce(async (p, fn) => {
        stagedAtTimeout = (await Promise.all(vi.mocked(makeStagingDir).mock.results.map((r) => r.value))).map(
          (d) => existsSync(d),
        );
        /* A REAL acquisition timeout: a holder queued on the same key, then the
           call with a 50ms budget (the curated error comes from the real lock). */
        const holder = actual.withStateJsonLock(p, () => new Promise<void>((r) => setTimeout(r, 400)));
        try {
          return await actual.withStateJsonLock(p, fn, 50);
        } finally {
          await holder;
        }
      });
    try {
      const err = await importPortableBundle(await bundle(title), { onConflict: 'overwrite' }).catch(
        (e: unknown) => e,
      );
      expect(isLockAcquisitionTimeout(err)).toBe(true);
      /* Positive control: this import made exactly one staging dir and it
         existed at the timeout, so there is something to be cleaned up. */
      expect(stagedAtTimeout).toEqual([true]);
      /* The seam fired, the live file was never promoted... */
      expect(readFileSync(stateJsonPath(target), 'utf8')).toBe(existing);
      /* ...and the staged files (state.json, manuscript, audio) are gone: none
         reached the target, and this import's staging dir is gone. */
      expect(tmpFilesUnder(target)).toEqual([]);
      expect(readdirSync(target, { recursive: true, encoding: 'utf8' }).sort()).toEqual(
        ['.audiobook', 'audio', join('.audiobook', 'state.json')].sort(),
      );
      const made = await Promise.all(vi.mocked(makeStagingDir).mock.results.map((r) => r.value));
      expect(made.filter((d) => existsSync(d))).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
