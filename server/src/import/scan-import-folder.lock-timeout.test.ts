/* #3625 pass-1 review — an 'overwrite' portable import that cannot take the
   state lock must not leak its staged `.tmp-*` files.

   `withKeyLock` never runs the callback when acquisition times out, so cleanup
   that lives INSIDE the `withStateJsonLock` callback is skipped on exactly that
   failure. withStateJsonLock is mocked here (a real 10s budget would race
   vitest's own timeout), so this lives apart from the real-lock tests in
   scan-import-folder.test.ts. */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { isLockAcquisitionTimeout } from '../workspace/file-lock.js';
import { audioDir, BOOKS_ROOT, dotAudiobook, stateJsonPath } from '../workspace/paths.js';
import { importPortableBundle } from './scan-import-folder.js';

vi.mock('../workspace/file-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/file-lock.js')>();
  return { ...actual, withStateJsonLock: vi.fn(actual.withStateJsonLock) };
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
    /* The FIRST call is the claim (conflict decision + mkdir): let it through
       for real. Only the SECOND — the phase-2 promote, after phase 1 has staged
       its tmp files — times out. Rejecting the first call would abort before
       anything was staged and the empty-tmp assertion below could not fail. */
    let stagedAtTimeout: string[] = [];
    vi.mocked(withStateJsonLock)
      .mockImplementationOnce((p, fn) => actual.withStateJsonLock(p, fn))
      .mockImplementationOnce(async (p, fn) => {
        stagedAtTimeout = tmpFilesUnder(target);
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
      /* Positive control: phase 1 really left tmp files to be cleaned up. */
      expect(stagedAtTimeout.length).toBeGreaterThan(0);
      /* The seam fired, the live file was never promoted... */
      expect(readFileSync(stateJsonPath(target), 'utf8')).toBe(existing);
      /* ...and phase 1's staged tmp files (state.json, manuscript, audio) are gone. */
      expect(tmpFilesUnder(target)).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
