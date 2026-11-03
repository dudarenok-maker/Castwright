/* #3713 / PR #4004 pass 5 (owner decision) -- a series-scope fan-out SKIPS a repaired series-mate it holds no
   token for, and writes it when the request echoes the token. The mates of a fan-out are matched by voice id or
   name, so the client never names them: refusing would make the write impossible, writing would land on the wrong
   twin. The real sweep repairs a pair in a temp workspace and the real routers serve it.

   SERVER-UNIT: the `X-Book-Read-Token` headers below are set by hand, standing for what the client sends. What the
   REAL client sends (every token the tab has committed, comma-joined, on every write) is pinned on the other side of
   the wire by `src/lib/api-body-keyed-token.test.ts` ("a series fan-out echoes every committed token"); the
   "client wire shape" block here feeds the server exactly that shape. */
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
  app.use('/api', gate.repairedFanOutScope);
  app.use('/api/books/:bookId', gate.repairedBookGate);
  app.use('/api/books', castSeriesPatchRouter);
  app.use('/api/books', voiceOverrideLinkedRouter);
  app.use('/api/books', castTierRouter);
  app.use('/api/voices', voicesRouter);
  /* The series voiceUuid stamp a design job runs (a fan-out onto every series-mate). */
  const { ensureCharacterVoiceUuid } = await import('../routes/qwen-voice.js');
  app.post('/api/__stamp', async (_req, res) => {
    res.json({ uuid: await ensureCharacterVoiceUuid(src, 'c0', { author: 'Auth', series: 'Ser' }) });
  });
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
const mates = () => [read(kept)];
const skippedIds = (body: { skippedBooks?: Array<{ bookId: string }> }) => (body.skippedBooks ?? []).map((s) => s.bookId);

function headerList(res: { headers: Record<string, string> }): Array<{ bookId: string; bookTitle: string; reason: string }> {
  const raw = res.headers[gate.SKIPPED_BOOKS_HEADER];
  return raw ? JSON.parse(decodeURIComponent(raw)) : [];
}

describe('POST /books/:id/cast/:characterId/series-patch with a repaired series-mate (#3713)', () => {
  const patch = { gender: 'male' };

  it('no token: the repaired mate is byte-identical and reported skipped; the source updates', async () => {
    await repaired();
    const before = mates();
    const res = await request(app).post(`/api/books/${SRC}/cast/c0/series-patch`).send(patch);
    expect(res.status).toBe(200);
    expect(mates()).toEqual(before);
    expect(JSON.parse(read(src)).characters[0].gender).toBe('male');
    expect(skippedIds(res.body)).toContain(DUP);
    expect(res.body.skippedBooks[0].reason).toMatch(/^Reopen ".+" to apply/);
    expect(headerList(res).map((s) => s.bookId)).toContain(DUP);
  });

  it('with the mate\'s token it is written and nothing is skipped', async () => {
    await repaired();
    const res = await request(app).post(`/api/books/${SRC}/cast/c0/series-patch`).set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send(patch);
    expect(res.status).toBe(200);
    expect(skippedIds(res.body)).toEqual([]);
    expect(res.headers[gate.SKIPPED_BOOKS_HEADER]).toBeUndefined();
    expect(mates().every((c) => JSON.parse(c).characters[0].gender === 'male')).toBe(true);
  });
});

describe('POST /books/:id/cast/:characterId/voice-override-linked with a repaired series-mate (#3713)', () => {
  const body = { override: { engine: 'kokoro', name: 'af_heart' } };

  it('no token: the repaired mate is byte-identical and reported skipped; the source updates', async () => {
    await repaired();
    const before = mates();
    const res = await request(app).post(`/api/books/${SRC}/cast/c0/voice-override-linked`).send(body);
    expect(res.status).toBe(200);
    expect(mates()).toEqual(before);
    expect(read(src)).toContain('af_heart');
    expect(skippedIds(res.body)).toContain(DUP);
    expect(headerList(res).map((s) => s.bookId)).toContain(DUP);
  });

  it('with the mate\'s token it is written', async () => {
    await repaired();
    const res = await request(app).post(`/api/books/${SRC}/cast/c0/voice-override-linked`).set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send(body);
    expect(res.status).toBe(200);
    expect(skippedIds(res.body)).toEqual([]);
    expect(read(kept)).toContain('af_heart');
  });
});

describe('POST /books/:id/cast/tier with a repaired series-mate (#3713)', () => {
  const body = { voiceId: 'c0', ttsModelKey: 'qwen3-tts-1.7b' };

  it('no token: the repaired mate is byte-identical and reported skipped; the source updates', async () => {
    await repaired();
    const before = mates();
    const res = await request(app).post(`/api/books/${SRC}/cast/tier`).send(body);
    expect(res.status).toBe(200);
    expect(mates()).toEqual(before);
    expect(read(src)).toContain('qwen3-tts-1.7b');
    expect(res.body.updated).toBe(2); // the source and the re-minted loser; the kept twin is skipped
    expect(skippedIds(res.body)).toContain(DUP);
    expect(headerList(res).map((s) => s.bookId)).toContain(DUP);
  });

  it('with the mate\'s token it is written', async () => {
    await repaired();
    const res = await request(app).post(`/api/books/${SRC}/cast/tier`).set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send(body);
    expect(res.status).toBe(200);
    expect(skippedIds(res.body)).toEqual([]);
    expect(read(kept)).toContain('qwen3-tts-1.7b');
  });
});

describe('PUT /voices/:id/override (series scope) with a repaired series-mate (#3713)', () => {
  const body = { override: { engine: 'kokoro', name: 'af_heart' }, scope: 'series', bookId: SRC };

  it('no token: the repaired mate is byte-identical and reported skipped; the source updates', async () => {
    await repaired();
    const before = mates();
    const res = await request(app).put('/api/voices/c0/override').send(body);
    expect(res.status).toBe(200);
    expect(mates()).toEqual(before);
    expect(read(src)).toContain('af_heart');
    expect(skippedIds(res.body)).toContain(DUP);
    expect(headerList(res).map((s) => s.bookId)).toContain(DUP);
  });

  it('with the mate\'s token it is written (204, nothing skipped)', async () => {
    await repaired();
    const res = await request(app).put('/api/voices/c0/override').set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send(body);
    expect(res.status).toBe(204);
    expect(read(kept)).toContain('af_heart');
  });

  it('when every match is a skipped repaired book it is 200 skipped, not a 404', async () => {
    await repaired();
    rmSync(paths.castJsonPath(src));
    writeFileSync(paths.castJsonPath(src), JSON.stringify({ characters: [{ id: 'other', name: 'Other' }] }));
    const res = await request(app).put('/api/voices/c0/override').send(body);
    expect(res.status).toBe(200);
    expect(skippedIds(res.body)).toContain(DUP);
  });
});

/* PR #4004 pass 4, finding 4. The client echoes every token it has committed on every write, comma-joined: a
   series-mate it read since the repair is written, one it never read is still skipped. */
describe('client wire shape: every committed token, comma-joined (#3713, pass 4)', () => {
  const sendPatch = (token: string | null) => {
    const r = request(app).post(`/api/books/${SRC}/cast/c0/series-patch`);
    return (token === null ? r : r.set('X-Book-Read-Token', token)).send({ gender: 'male' });
  };

  it('the mate\'s token among unrelated ones: the mate is written, nothing skipped', async () => {
    await repaired();
    const res = await sendPatch(`some-other-book-token,${gate.repairedReadToken(DUP)!}`);
    expect(res.status).toBe(200);
    expect(skippedIds(res.body)).toEqual([]);
    expect(JSON.parse(read(kept)).characters[0].gender).toBe('male');
  });

  it('only unrelated tokens: the mate is still skipped, byte-identical', async () => {
    await repaired();
    const before = mates();
    const res = await sendPatch('some-other-book-token,another');
    expect(skippedIds(res.body)).toContain(DUP);
    expect(mates()).toEqual(before);
  });

  it('the tab read the kept twin and the series-patch comes from the other book: written, not skipped; a second patch too', async () => {
    await repaired();
    for (const gender of ['male', 'female']) {
      const res = await request(app)
        .post(`/api/books/${SRC}/cast/c0/series-patch`)
        .set('X-Book-Read-Token', gate.repairedReadToken(DUP)!)
        .send({ gender });
      expect(skippedIds(res.body)).toEqual([]);
      expect(JSON.parse(read(kept)).characters[0].gender).toBe(gender);
    }
  });

  it('the workspace scope of a voice override reaches the kept twin with its token, and skips it without', async () => {
    await repaired();
    const before = mates();
    const skipped = await request(app).put('/api/voices/c0/override').send({ override: { engine: 'kokoro', name: 'af_heart' } });
    expect(skippedIds(skipped.body)).toContain(DUP);
    expect(mates()).toEqual(before);
    const res = await request(app)
      .put('/api/voices/c0/override')
      .set('X-Book-Read-Token', gate.repairedReadToken(DUP)!)
      .send({ override: { engine: 'kokoro', name: 'af_heart' } });
    expect(res.status).toBe(204);
    expect(read(kept)).toContain('af_heart');
  });

  it('the series voiceUuid stamp reaches the kept twin with its token, and leaves it unstamped without', async () => {
    await repaired();
    const without = await request(app).post('/api/__stamp').send({});
    expect(without.body.uuid).toBeTruthy();
    expect(JSON.parse(read(src)).characters[0].voiceUuid).toBe(without.body.uuid);
    expect(JSON.parse(read(kept)).characters[0].voiceUuid).toBeUndefined();
    /* the source is clean again, as it would be before the design that mints the uuid */
    writeFileSync(paths.castJsonPath(src), JSON.stringify({ characters: [{ id: 'c0', name: 'Rhea' }] }));
    const withToken = await request(app).post('/api/__stamp').set('X-Book-Read-Token', gate.repairedReadToken(DUP)!).send({});
    expect(JSON.parse(read(kept)).characters[0].voiceUuid).toBe(withToken.body.uuid);
  });
});
