/* #3625 pass-1 review — an 'overwrite' portable import that cannot take the
   state lock must not leak its staged `.tmp-*` files.

   `withKeyLock` never runs the callback when acquisition times out, so cleanup
   that lives INSIDE the `withStateLock` callback is skipped on exactly that
   failure. withStateLock is mocked here (a real 10s budget would race vitest's
   own timeout), so this lives apart from the real-lock tests in
   scan-import-folder.test.ts. */

import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ZipFile } from 'yazl';
import { LockAcquisitionTimeoutError } from '../workspace/file-lock.js';
import { audioDir, BOOKS_ROOT, dotAudiobook, stateJsonPath } from '../workspace/paths.js';
import { importPortableBundle } from './scan-import-folder.js';

vi.mock('../workspace/state-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-lock.js')>();
  return { ...actual, withStateLock: vi.fn(actual.withStateLock) };
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
    const { withStateLock } = await import('../workspace/state-lock.js');
    const title = 'Overwrite Lock Timeout';
    const target = join(BOOKS_ROOT, 'Demo Author', 'Standalones', title);
    mkdirSync(audioDir(target), { recursive: true });
    mkdirSync(dotAudiobook(target), { recursive: true });
    const existing = JSON.stringify({ title: 'Existing Book' });
    writeFileSync(stateJsonPath(target), existing);
    vi.mocked(withStateLock).mockRejectedValueOnce(
      new LockAcquisitionTimeoutError('state:/abs/secret/path', 10_000),
    );
    try {
      await expect(importPortableBundle(await bundle(title), { onConflict: 'overwrite' })).rejects.toBeInstanceOf(
        LockAcquisitionTimeoutError,
      );
      /* The seam fired, the live file was never promoted... */
      expect(readFileSync(stateJsonPath(target), 'utf8')).toBe(existing);
      /* ...and phase 1's staged tmp files (state.json, manuscript, audio) are gone. */
      expect(tmpFilesUnder(target)).toEqual([]);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });
});
