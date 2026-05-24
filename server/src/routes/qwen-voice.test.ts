/* Integration tests for the Qwen design-voice proxy router (plan 108,
   Wave 4).

   Seeds one book with a speaking character carrying a persona on disk and
   asserts:
     - the route proxies the sidecar's /qwen/design-voice with the derived
       voiceId + persona, and streams back the PCM + X-Sample-Rate +
       X-Qwen-Voice-Id headers (the audition)
     - the persona defaults to the character's voiceStyle, and an explicit
       body persona overrides it
     - 400 when neither a body persona nor a persisted voiceStyle exists
     - the route does NOT persist the override (design only caches + previews)
     - a sidecar that's down → 502 with a clear message
     - unknown book / character → 404

   `global.fetch` is mocked so the route test never touches a live sidecar.
   Lazy-import pattern mirrors the sibling route tests so WORKSPACE_DIR is
   set before paths.ts binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK = 'The Hollow Tide';

let workspaceRoot: string;
let app: Express;
let bookId: string;

const fetchMock = vi.fn();

const characters = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  {
    id: 'Maerin',
    name: 'Maerin',
    role: 'supporting',
    color: 'lilac',
    voiceId: 'v_Maerin',
    voiceStyle: 'a poised, confident teenage girl, clear and warm',
  },
  { id: 'nopersona', name: 'Nopersona', role: 'extra', color: 'amber' },
];

function writeBookOnDisk(chars: object[]) {
  const dir = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title: BOOK,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: 1,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters: chars }));
}

function readCast(): { characters: Array<Record<string, unknown>> } {
  const path = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

/* A successful sidecar response: a few PCM bytes + the headers the engine
   sets on a design audition. */
function okSidecarResponse(pcm = new Uint8Array([1, 2, 3, 4])) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'Content-Type': 'audio/L16', 'X-Sample-Rate': '24000' }),
    arrayBuffer: async () => pcm.buffer,
    json: async () => ({}),
  };
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-qwen-voice-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  vi.stubGlobal('fetch', fetchMock);

  const [{ qwenVoiceRouter }, { makeBookId }] = await Promise.all([
    import('./qwen-voice.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', qwenVoiceRouter);
});

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(okSidecarResponse());
  writeBookOnDisk(characters);
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books/:bookId/cast/:characterId/design-voice', () => {
  it('proxies the sidecar with the derived voiceId + persona and streams back PCM + headers', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/Maerin/design-voice`).send({});
    expect(res.status).toBe(200);
    /* PCM streamed back verbatim. */
    expect(res.body).toBeInstanceOf(Buffer);
    expect(Array.from(res.body as Buffer)).toEqual([1, 2, 3, 4]);
    /* Headers echo the sample rate + the derived cache voiceId. */
    expect(res.headers['x-sample-rate']).toBe('24000');
    expect(res.headers['x-qwen-voice-id']).toBe('qwen-v_Maerin');
    /* Sidecar called once with the right payload. */
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('http://localhost:9000/qwen/design-voice');
    const sent = JSON.parse(init.body);
    expect(sent).toEqual({
      voiceId: 'qwen-v_Maerin',
      instruct: 'a poised, confident teenage girl, clear and warm',
      language: 'English',
    });
  });

  it('defaults the persona to the character voiceStyle and lets the body override it', async () => {
    await request(app)
      .post(`/api/books/${bookId}/cast/Maerin/design-voice`)
      .send({ persona: 'a gruff old sailor' });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent.instruct).toBe('a gruff old sailor');
  });

  it('does NOT persist the override (design only caches + previews)', async () => {
    await request(app).post(`/api/books/${bookId}/cast/Maerin/design-voice`).send({});
    const cast = readCast();
    const Maerin = cast.characters.find((c) => c.id === 'Maerin');
    expect(Maerin?.overrideTtsVoices).toBeUndefined();
    expect(Maerin?.ttsEngine).toBeUndefined();
  });

  it('400s when neither a body persona nor a persisted voiceStyle exists', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/nopersona/design-voice`)
      .send({});
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('502s with a clear message when the sidecar is unreachable', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNREFUSED'));
    const res = await request(app).post(`/api/books/${bookId}/cast/Maerin/design-voice`).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/unreachable/i);
  });

  it('502s when the sidecar returns a non-OK status', async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      headers: new Headers(),
      arrayBuffer: async () => new ArrayBuffer(0),
      json: async () => ({ error: 'qwen-tts not installed' }),
    });
    const res = await request(app).post(`/api/books/${bookId}/cast/Maerin/design-voice`).send({});
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/qwen-tts not installed/);
  });

  it('404s for an unknown bookId', async () => {
    const res = await request(app).post('/api/books/nope/cast/Maerin/design-voice').send({});
    expect(res.status).toBe(404);
  });

  it('404s for an unknown characterId', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/ghost/design-voice`).send({});
    expect(res.status).toBe(404);
  });
});
