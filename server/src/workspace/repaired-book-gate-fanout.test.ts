/* #3713 / PR #4004 (owner decision, pass 6) -- a series-scope fan-out that would write a repaired series-mate is
   REFUSED WHOLE (409 `book_repaired_reload`, before anything is written) on a request that does not carry the
   current repair epoch, and writes every mate, the repaired one included, when it does. The mates of a fan-out
   are matched by voice id or name, so the client never names them; the stale page reloads and repeats the change
   with the epoch. The real sweep repairs a pair in a temp workspace and the real routers serve it.

   SERVER-UNIT: the `X-Repair-Epoch` headers below are set by hand, standing for what the client sends. What the
   REAL client sends (the epoch it read from /api/info at page load, on every write) is pinned on the other side of
   the wire by `src/lib/repair-epoch.test.ts`. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let root: string;
let app: Express;
let paths: typeof import('./paths.js');
let sweep: typeof import('./duplicate-bookid-sweep.js');
let gate: typeof import('./repaired-book-gate.js');

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'audiobook-repaired-gate-fanout-'));
  process.env.WORKSPACE_DIR = root;
  paths = await import('./paths.js');
  sweep = await import('./duplicate-bookid-sweep.js');
  gate = await import('./repaired-book-gate.js');
  const { castSeriesPatchRouter } = await import('../routes/cast-series-patch.js');
  const { voiceOverrideLinkedRouter } = await import('../routes/voice-override-linked.js');
  const { castTierRouter } = await import('../routes/cast-tier.js');
  const { voicesRouter } = await import('../routes/voices.js');
  app = express();
  app.use(express.json());
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/books', castSeriesPatchRouter);
  app.use('/api/books', voiceOverrideLinkedRouter);
  app.use('/api/books', castTierRouter);
  app.use('/api/voices', voicesRouter);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
}, 120_000);

afterAll(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  rmSync(paths.BOOKS_ROOT, { recursive: true, force: true });
  sweep.__resetDuplicateBookIdRepairsForTest();
});
afterEach(() => sweep.__resetDuplicateBookIdRepairsForTest());

function seed(folder: string, bookId: string, opts: { rendered: boolean }): string {
  const dir = join(paths.BOOKS_ROOT, 'Auth', 'Ser', folder);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.md'), '# Chapter One\n\nText.\n');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId, manuscriptId: `m_${folder}`, title: folder, author: 'Auth', series: 'Ser', seriesPosition: 1,
      isStandalone: false, manuscriptFile: 'manuscript.md', castConfirmed: true, language: 'en',
      chapters: [{ id: 1, title: 'Chapter One', slug: '01-chapter-one', ...(opts.rendered ? { audioRenderedAt: '2026-02-01T00:00:00.000Z' } : {}) }],
      coverGradient: ['#000', '#fff'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', schema: 1,
    }),
  );
  writeFileSync(
    paths.castJsonPath(dir),
    JSON.stringify({ characters: [{ id: 'c0', name: 'Rhea', gender: 'female', description: 'orig' }] }),
  );
  return dir;
}

const DUP = 'auth__ser__book';
const SRC = 'auth__ser__src';
let kept: string;
let src: string;

async function repaired() {
  seed('Book', DUP, { rendered: false });
  kept = seed('Book original', DUP, { rendered: true });
  src = seed('Src', SRC, { rendered: false });
  await sweep.repairDuplicateBookIds();
}

const read = (dir: string) => readFileSync(paths.castJsonPath(dir), 'utf8');
/* Only the twin that KEPT the id is gated; the loser was re-minted a fresh id and is an ordinary mate. */
const everything = () => [read(kept), read(src)];
const refused = (res: { status: number; body: { code?: string } }) => {
  expect(res.status).toBe(409);
  expect(res.body.code).toBe('book_repaired_reload');
};

const E = () => gate.currentRepairEpoch()!;

describe('POST /books/:id/cast/:characterId/series-patch with a repaired series-mate (#3713)', () => {
  const patch = { gender: 'male' };

  it('no epoch: refused whole, nothing in the series changes (the source included)', async () => {
    await repaired();
    const before = everything();
    refused(await request(app).post(`/api/books/${SRC}/cast/c0/series-patch`).send(patch));
    expect(everything()).toEqual(before);
  });

  it('with the current epoch every mate is written, the repaired one included', async () => {
    await repaired();
    const res = await request(app).post(`/api/books/${SRC}/cast/c0/series-patch`).set('X-Repair-Epoch', E()).send(patch);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('skippedBooks');
    expect(JSON.parse(read(kept)).characters[0].gender).toBe('male');
    expect(JSON.parse(read(src)).characters[0].gender).toBe('male');
  });

  it('a stale epoch is refused the same way', async () => {
    await repaired();
    const before = everything();
    refused(await request(app).post(`/api/books/${SRC}/cast/c0/series-patch`).set('X-Repair-Epoch', 'pre-repair').send(patch));
    expect(everything()).toEqual(before);
  });

  it('a second patch from a page loaded after the repair writes the kept twin again', async () => {
    await repaired();
    for (const gender of ['male', 'female']) {
      const res = await request(app).post(`/api/books/${SRC}/cast/c0/series-patch`).set('X-Repair-Epoch', E()).send({ gender });
      expect(res.status).toBe(200);
      expect(JSON.parse(read(kept)).characters[0].gender).toBe(gender);
    }
  });
});

describe('POST /books/:id/cast/:characterId/voice-override-linked with a repaired series-mate (#3713)', () => {
  const body = { override: { engine: 'kokoro', name: 'af_heart' } };

  it('no epoch: refused whole, nothing in the series changes', async () => {
    await repaired();
    const before = everything();
    refused(await request(app).post(`/api/books/${SRC}/cast/c0/voice-override-linked`).send(body));
    expect(everything()).toEqual(before);
  });

  it('with the current epoch every mate is written', async () => {
    await repaired();
    const res = await request(app).post(`/api/books/${SRC}/cast/c0/voice-override-linked`).set('X-Repair-Epoch', E()).send(body);
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('skippedBooks');
    expect(read(kept)).toContain('af_heart');
    expect(read(src)).toContain('af_heart');
  });
});

describe('POST /books/:id/cast/tier with a repaired series-mate (#3713)', () => {
  const body = { voiceId: 'c0', ttsModelKey: 'qwen3-tts-1.7b' };

  it('no epoch: refused whole, nothing in the series changes', async () => {
    await repaired();
    const before = everything();
    refused(await request(app).post(`/api/books/${SRC}/cast/tier`).send(body));
    expect(everything()).toEqual(before);
  });

  it('with the current epoch every mate is written', async () => {
    await repaired();
    const res = await request(app).post(`/api/books/${SRC}/cast/tier`).set('X-Repair-Epoch', E()).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 3 }); // the source, the re-minted loser and the kept twin
    expect(read(kept)).toContain('qwen3-tts-1.7b');
  });
});

describe('PUT /voices/:id/override with a repaired series-mate (#3713)', () => {
  const series = { override: { engine: 'kokoro', name: 'af_heart' }, scope: 'series', bookId: SRC };
  const workspace = { override: { engine: 'kokoro', name: 'af_heart' } };

  it('series scope, no epoch: refused whole, nothing changes', async () => {
    await repaired();
    const before = everything();
    refused(await request(app).put('/api/voices/c0/override').send(series));
    expect(everything()).toEqual(before);
  });

  it('series scope, current epoch: every mate is written (204)', async () => {
    await repaired();
    const res = await request(app).put('/api/voices/c0/override').set('X-Repair-Epoch', E()).send(series);
    expect(res.status).toBe(204);
    expect(read(kept)).toContain('af_heart');
    expect(read(src)).toContain('af_heart');
  });

  it('workspace scope, no epoch: refused whole; with the current epoch the kept twin is written', async () => {
    await repaired();
    const before = everything();
    refused(await request(app).put('/api/voices/c0/override').send(workspace));
    expect(everything()).toEqual(before);
    const res = await request(app).put('/api/voices/c0/override').set('X-Repair-Epoch', E()).send(workspace);
    expect(res.status).toBe(204);
    expect(read(kept)).toContain('af_heart');
  });
});

/* #4029 item 2 -- the body/series checks retry an unreadable gate file the way the mount middlewares do. */
describe('a gate file that was unreadable at boot and is readable now (#4029)', () => {
  const file = () => paths.repairedBookGateJsonPath();
  /* A directory where the file should be: readFile fails with EISDIR -- the "exists but unreadable" shape. */
  const makeUnreadable = () => {
    rmSync(file(), { recursive: true, force: true });
    mkdirSync(file(), { recursive: true });
  };
  const restoreFileNaming = (...ids: string[]) => {
    rmSync(file(), { recursive: true, force: true });
    writeFileSync(
      file(),
      JSON.stringify({ version: 2, epoch: 'ep-file', entries: ids.map((bookId) => ({ bookId, repairedAt: new Date().toISOString() })), manuscripts: [] }),
    );
  };
  async function unreadableThenRestored(): Promise<void> {
    seed('Book', DUP, { rendered: true });
    kept = seed('Book other', 'auth__ser__kept', { rendered: true });
    src = seed('Src', SRC, { rendered: false });
    gate.__clearRepairedBookGateMemoryForTest();
    makeUnreadable();
    await gate.loadRepairedBookGate();
    expect(gate.gatedBookIds()).toEqual([]);
    restoreFileNaming('auth__ser__kept');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10_000);
  }
  afterEach(() => {
    vi.useRealTimers();
    gate.__clearRepairedBookGateMemoryForTest();
    rmSync(file(), { recursive: true, force: true });
  });

  it('a workspace-scope override without the epoch is refused whole and writes nothing', async () => {
    await unreadableThenRestored();
    const before = everything();
    refused(await request(app).put('/api/voices/c0/override').send({ override: { engine: 'kokoro', name: 'af_heart' } }));
    expect(everything()).toEqual(before);
  });

  it('a series-scope override naming the gated book is refused whole and writes nothing', async () => {
    await unreadableThenRestored();
    const before = everything();
    refused(
      await request(app)
        .put('/api/voices/c0/override')
        .send({ override: { engine: 'kokoro', name: 'af_heart' }, scope: 'series', bookId: 'auth__ser__kept' }),
    );
    expect(everything()).toEqual(before);
  });
});

describe('CONTROL: with no repair nothing is refused (#3713)', () => {
  it('a series-patch on an unrepaired series needs no epoch', async () => {
    seed('Book', DUP, { rendered: true });
    src = seed('Src', SRC, { rendered: false });
    const res = await request(app).post(`/api/books/${SRC}/cast/c0/series-patch`).send({ gender: 'male' });
    expect(res.status).toBe(200);
  });
});
