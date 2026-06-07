/* srv-32 (plan 191) — integration tests for GET /api/library/sync-manifest.
 *
 * Tempdir workspace, deferred imports so paths.ts picks up WORKSPACE_DIR,
 * supertest against the real router. Pins: the two-level index/detail shape,
 * the ?since delta, gzip negotiation, the per-chapter fingerprint +
 * urlSuffix/audioUrl, and the audio-mutation invariant (fingerprint changes
 * when audioRenderedAt moves). */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let app: Express;
let b1: string;
let b2: string;
let b1Dir: string;
let stateJsonPathFn: (dir: string) => string;

const SERIES = 'Standalones';

function seedBook(
  author: string,
  title: string,
  bookId: string,
  opts: {
    updatedAt: string;
    chapters: Array<{
      id: number;
      uuid?: string;
      slug: string;
      title: string;
      audioRenderedAt?: string;
      excluded?: boolean;
      audioQa?: unknown;
    }>;
    audioFiles?: Array<{ slug: string; ext: string; bytes: number }>;
    segmentFiles?: Array<{ slug: string; durationSec: number }>;
  },
): { bookId: string; bookDir: string } {
  const bookDir = join(workspaceRoot, 'books', author, SERIES, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    stateJsonPathFn(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${title}`,
      title,
      author,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: opts.chapters,
      coverGradient: ['#000', '#fff'],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: opts.updatedAt,
    }),
  );
  for (const f of opts.audioFiles ?? []) {
    writeFileSync(join(bookDir, 'audio', `${f.slug}.${f.ext}`), 'x'.repeat(f.bytes));
  }
  for (const s of opts.segmentFiles ?? []) {
    writeFileSync(
      join(bookDir, 'audio', `${s.slug}.segments.json`),
      JSON.stringify({ durationSec: s.durationSec }),
    );
  }
  return { bookId, bookDir };
}

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-syncmanifest-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ syncManifestRouter }, { makeBookId }, paths] = await Promise.all([
    import('./library-sync-manifest.js'),
    import('../workspace/paths.js'),
    import('../workspace/paths.js'),
  ]);
  stateJsonPathFn = paths.stateJsonPath;

  b1 = makeBookId('Alpha Author', SERIES, 'Alpha Book');
  const seededB1 = seedBook('Alpha Author', 'Alpha Book', b1, {
    updatedAt: '2026-01-01T00:00:00.000Z',
    chapters: [
      {
        id: 1,
        uuid: 'uuid-a1',
        slug: '01-one',
        title: 'One',
        audioRenderedAt: '2026-04-01T00:00:00.000Z',
        audioQa: {
          status: 'ok',
          reasons: [],
          measuredLufs: -16,
          truePeakDb: -1,
          durationSec: 100,
          expectedSec: 100,
          checkedAt: '2026-04-01T00:00:00.000Z',
        },
      },
      { id: 2, uuid: 'uuid-a2', slug: '02-two', title: 'Two' }, // no audio
      { id: 3, uuid: 'uuid-a3', slug: '03-three', title: 'Three', excluded: true },
    ],
    audioFiles: [{ slug: '01-one', ext: 'mp3', bytes: 4096 }],
    // Segments file carries the authoritative PCM duration (250) — must win
    // over the audioQa verdict's 100.
    segmentFiles: [{ slug: '01-one', durationSec: 250 }],
  });
  b1Dir = seededB1.bookDir;

  b2 = makeBookId('Beta Author', SERIES, 'Beta Book');
  seedBook('Beta Author', 'Beta Book', b2, {
    updatedAt: '2026-06-01T00:00:00.000Z',
    chapters: [{ id: 1, uuid: 'uuid-b1', slug: '01-b', title: 'B One' }],
  });

  app = express();
  app.use('/api/library', syncManifestRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('GET /api/library/sync-manifest — index', () => {
  it('lists every book with audio-aware updatedAt and the full activeBookIds set', async () => {
    const res = await request(app).get('/api/library/sync-manifest');
    expect(res.status).toBe(200);
    const ids = res.body.books.map((b: { bookId: string }) => b.bookId).sort();
    expect(ids).toEqual([b1, b2].sort());
    expect(res.body.activeBookIds.sort()).toEqual([b1, b2].sort());
    // b1's updatedAt reflects its chapter audioRenderedAt (later than state.updatedAt)
    const b1row = res.body.books.find((b: { bookId: string }) => b.bookId === b1);
    expect(b1row.updatedAt).toBe('2026-04-01T00:00:00.000Z');
    expect(b1row.chapterCount).toBe(2); // excluded chapter not counted
  });

  it('?since trims the books list but keeps the full activeBookIds set', async () => {
    const res = await request(app)
      .get('/api/library/sync-manifest')
      .query({ since: '2026-05-01T00:00:00.000Z' });
    expect(res.status).toBe(200);
    expect(res.body.books.map((b: { bookId: string }) => b.bookId)).toEqual([b2]);
    expect(res.body.activeBookIds.sort()).toEqual([b1, b2].sort());
  });

  it('gzips the response when the client accepts it', async () => {
    // superagent advertises gzip and transparently decompresses, so the
    // Content-Encoding header proves the bytes went out gzipped and res.body
    // proves they decode back to the manifest.
    const res = await request(app).get('/api/library/sync-manifest').set('Accept-Encoding', 'gzip');
    expect(res.status).toBe(200);
    expect(res.headers['content-encoding']).toBe('gzip');
    expect(res.body.activeBookIds.sort()).toEqual([b1, b2].sort());
  });
});

describe('GET /api/library/sync-manifest?bookId= — detail', () => {
  it('returns uuid-keyed active chapters with fingerprint/urlSuffix/audioUrl', async () => {
    const res = await request(app).get('/api/library/sync-manifest').query({ bookId: b1 });
    expect(res.status).toBe(200);
    expect(res.body.bookId).toBe(b1);
    const uuids = res.body.chapters.map((c: { uuid: string }) => c.uuid).sort();
    expect(uuids).toEqual(['uuid-a1', 'uuid-a2']); // excluded chapter dropped
    expect(res.body.activeChapterUuids.sort()).toEqual(['uuid-a1', 'uuid-a2']);

    const c1 = res.body.chapters.find((c: { uuid: string }) => c.uuid === 'uuid-a1');
    expect(c1.urlSuffix).toBe('audio.mp3');
    expect(c1.audioUrl).toBe(`/api/books/${b1}/chapters/1/audio.mp3`);
    expect(c1.fingerprint).toContain('4096');
    expect(c1.durationSec).toBe(250); // segments-file duration wins over audioQa's 100
    expect(c1.lufs).toBe(-16);

    const c2 = res.body.chapters.find((c: { uuid: string }) => c.uuid === 'uuid-a2');
    expect(c2.fingerprint).toBeUndefined();
    expect(c2.audioUrl).toBeUndefined();
  });

  it('fingerprint changes when the chapter audio is re-rendered (audioRenderedAt bumps)', async () => {
    const before = await request(app).get('/api/library/sync-manifest').query({ bookId: b1 });
    const fpBefore = before.body.chapters.find(
      (c: { uuid: string }) => c.uuid === 'uuid-a1',
    ).fingerprint;

    // Simulate a re-record: bump audioRenderedAt in state.json.
    const state = JSON.parse(readFileSync(stateJsonPathFn(b1Dir), 'utf8'));
    state.chapters[0].audioRenderedAt = '2026-09-09T00:00:00.000Z';
    writeFileSync(stateJsonPathFn(b1Dir), JSON.stringify(state));

    const after = await request(app).get('/api/library/sync-manifest').query({ bookId: b1 });
    const fpAfter = after.body.chapters.find(
      (c: { uuid: string }) => c.uuid === 'uuid-a1',
    ).fingerprint;

    expect(fpAfter).not.toBe(fpBefore);
  });

  it('404s for an unknown bookId', async () => {
    const res = await request(app).get('/api/library/sync-manifest').query({ bookId: 'no-such' });
    expect(res.status).toBe(404);
  });
});
