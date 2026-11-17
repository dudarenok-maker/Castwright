/* #4236 -- the whole-request 500 / 409 bodies of the routes below used to echo
   `(e as Error).message`. A node fs error's message embeds the absolute path it
   failed on (a book folder keeps the display title), and this app is served over
   LAN HTTPS, so a paired phone read the library layout out of the body. Each route
   now answers via `requestFailureMessageFs`; an ordinary (non-fs) error keeps its
   own message, which is the other direction every case below asserts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

const ABS = 'C:\\Users\\someone\\Castwright\\books\\The Quota\\Series\\Title\\.audiobook\\state.json';

function fsError(code = 'EBUSY'): Error {
  return Object.assign(new Error(`${code}: resource busy or locked, open '${ABS}'`), {
    code,
    syscall: 'open',
    path: ABS,
  });
}

/* One switch for every mocked seam: set `boom` before a request, the seam throws it. */
const seam = vi.hoisted(() => ({ boom: null as unknown }));
const fail = (): never => {
  throw seam.boom;
};

vi.mock('../workspace/scan.js', async (orig) => ({
  ...(await orig<typeof import('../workspace/scan.js')>()),
  scanLibrary: vi.fn(async () => fail()),
  collectBooks: vi.fn(async () => fail()),
  buildSeriesInputs: vi.fn(async () => fail()),
  findBookByBookId: vi.fn(async () => fail()),
}));
vi.mock('../workspace/active-analyses.js', () => ({ scanActiveAnalyses: vi.fn(async () => fail()) }));
vi.mock('../workspace/series-full-cast-scan.js', () => ({
  scanSeriesFullCharactersForBookId: vi.fn(async () => fail()),
}));
vi.mock('../workspace/series-cast-scan.js', () => ({
  scanSeriesCharactersForBookId: vi.fn(async () => fail()),
}));
vi.mock('../workspace/queue-migrate.js', async (orig) => ({
  ...(await orig<typeof import('../workspace/queue-migrate.js')>()),
  readQueueFile: vi.fn(async () => fail()),
}));
vi.mock('../parsers/index.js', async (orig) => ({
  ...(await orig<typeof import('../parsers/index.js')>()),
  parseManuscript: vi.fn(async () => fail()),
}));

import { libraryRouter } from './library.js';
import { seriesCastRouter } from './series-cast.js';
import { seriesRosterRouter } from './series-roster.js';
import { seriesMemoryRouter } from './series-memory.js';
import { syncManifestRouter } from './library-sync-manifest.js';
import { queueRouter } from './queue.js';
import { manuscriptsRouter } from './manuscripts.js';

function app() {
  const a = express();
  a.use(express.json());
  a.use('/api/library', libraryRouter);
  a.use('/api/library', seriesMemoryRouter);
  a.use('/api/library', syncManifestRouter);
  a.use('/api/books', seriesCastRouter);
  a.use('/api/books', seriesRosterRouter);
  a.use('/api/queue', queueRouter);
  a.use('/api/manuscripts', manuscriptsRouter);
  return a;
}

const CASES: Array<{ name: string; send: (a: express.Express) => request.Test }> = [
  { name: 'GET /library', send: (a) => request(a).get('/api/library/') },
  { name: 'GET /library/active-analyses', send: (a) => request(a).get('/api/library/active-analyses') },
  { name: 'GET /library/stats', send: (a) => request(a).get('/api/library/stats') },
  { name: 'GET /library/continue-listening', send: (a) => request(a).get('/api/library/continue-listening') },
  { name: 'GET /books/:id/series-cast', send: (a) => request(a).get('/api/books/b1/series-cast') },
  { name: 'GET /books/:id/series-roster', send: (a) => request(a).get('/api/books/b1/series-roster') },
  { name: 'GET /library/series-memory', send: (a) => request(a).get('/api/library/series-memory?author=A&series=S') },
  { name: 'GET /library/sync-manifest', send: (a) => request(a).get('/api/library/sync-manifest') },
  { name: 'GET /queue', send: (a) => request(a).get('/api/queue/') },
  { name: 'POST /queue/pause', send: (a) => request(a).post('/api/queue/pause').send({ paused: true }) },
  { name: 'POST /queue/reorder', send: (a) => request(a).post('/api/queue/reorder').send({ order: [] }) },
  {
    name: 'POST /queue/enqueue',
    send: (a) =>
      request(a)
        .post('/api/queue/enqueue')
        .send({ entries: [{ id: 'e1', bookId: 'b1', chapterId: 1, scope: 'this' }] }),
  },
  { name: 'POST /queue/clear', send: (a) => request(a).post('/api/queue/clear').send({}) },
  { name: 'POST /queue/:id/start', send: (a) => request(a).post('/api/queue/e1/start') },
  { name: 'POST /queue/:id/complete', send: (a) => request(a).post('/api/queue/e1/complete').send({}) },
  { name: 'POST /queue/:id/retry', send: (a) => request(a).post('/api/queue/e1/retry') },
  { name: 'POST /queue/:id/confirm-fallback', send: (a) => request(a).post('/api/queue/e1/confirm-fallback') },
  { name: 'POST /queue/:id/skip-fallback', send: (a) => request(a).post('/api/queue/e1/skip-fallback') },
  { name: 'DELETE /queue/:id', send: (a) => request(a).delete('/api/queue/e1') },  { name: 'POST /manuscripts', send: (a) => request(a).post('/api/manuscripts/').send({ text: 'hello' }) },
];

describe('whole-request error bodies are path-free (#4236)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const c of CASES) {
    it(`${c.name}: a node fs error answers the curated sentence, never the path`, async () => {
      seam.boom = fsError();
      const res = await c.send(app());
      expect(res.status).toBeGreaterThanOrEqual(400);
      const body = JSON.stringify(res.body);
      expect(body).not.toContain('Quota');
      expect(body).not.toContain('state.json');
      expect(body).not.toContain('someone');
      expect(res.body.error).toBe('Files could not be read or written right now. Try again.');
    });

    it(`${c.name}: an ordinary error keeps its own message`, async () => {
      seam.boom = new Error('ordinary failure text');
      const res = await c.send(app());
      expect(res.body.error).toContain('ordinary failure text');
    });
  }

  it('a full disk answers the permanent sentence, not "Try again"', async () => {
    seam.boom = fsError('ENOSPC');
    const res = await request(app()).get('/api/library/');
    expect(res.body.error).toBe('Files could not be read or written. Check free disk space and folder permissions.');
  });
});
