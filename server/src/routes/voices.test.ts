/* Integration tests for the voices router — the voice-family aggregation,
   the base-voice catalog endpoint, and the per-cast override write.

   Sets up a tempdir workspace with two books that share a character
   identity (same voiceId across series entries) so the override-write path
   has more than one cast.json to touch. Stubs global fetch so the base-
   voice catalog resolves deterministically. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK_ONE = 'Book One';
const BOOK_TWO = 'Book Two';

let workspaceRoot: string;
let app: Express;
let bookOneId: string;
let bookTwoId: string;
let invalidateBaseVoiceCache: () => void;

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
) {
  const bookDir = join(workspace, 'books', author, series, title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  return bookDir;
}

function readCastFromDisk(workspace: string, author: string, series: string, title: string) {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8')) as { characters: Array<Record<string, unknown>> };
}

const realFetch = globalThis.fetch;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voices-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ voicesRouter }, paths, baseVoices] = await Promise.all([
    import('./voices.js'),
    import('../workspace/paths.js'),
    import('../tts/base-voices.js'),
  ]);
  invalidateBaseVoiceCache = baseVoices.invalidateBaseVoiceCache;
  bookOneId = paths.makeBookId(AUTHOR, SERIES, BOOK_ONE);
  bookTwoId = paths.makeBookId(AUTHOR, SERIES, BOOK_TWO);

  /* Two books in the same series, both with a Brann character sharing
     voiceId 'v_Brann'. The aggregator should fold these into one voice
     family; the override-write should touch both cast.json files. */
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE, bookOneId, [
    {
      id: 'char-Brann', name: 'Brann', role: 'protagonist', color: 'magenta',
      voiceId: 'v_Brann', gender: 'male', ageRange: 'teen',
      attributes: ['Male', 'Teen'], lines: 50, scenes: 5,
    },
  ]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO, bookTwoId, [
    {
      id: 'char-Brann', name: 'Brann', role: 'protagonist', color: 'magenta',
      voiceId: 'v_Brann', gender: 'male', ageRange: 'teen',
      attributes: ['Male', 'Teen'], lines: 80, scenes: 7,
    },
  ]);

  app = express();
  app.use(express.json());
  app.use('/api/voices', voicesRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  invalidateBaseVoiceCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

describe('GET /api/voices — aggregation', () => {
  it('emits bookSeries alongside bookId so the voice-family-grouped UI can nest by series', async () => {
    const res = await request(app).get('/api/voices');
    expect(res.status).toBe(200);
    const v_Brann = res.body.voices.find((v: { id: string }) => v.id === 'v_Brann');
    expect(v_Brann).toBeDefined();
    expect(v_Brann.bookSeries).toBe(SERIES);
    /* usedIn === 2 because both books share the same voiceId. */
    expect(v_Brann.usedIn).toBe(2);
  });

  it('exposes overrideTtsVoice when cast.json carries one', async () => {
    /* Quick targeted write — bypass the PUT endpoint to isolate the read side. */
    const castPath = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK_ONE, '.audiobook', 'cast.json');
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as { characters: Array<Record<string, unknown>> };
    cast.characters[0].overrideTtsVoice = { engine: 'coqui', name: 'Asya Anara' };
    writeFileSync(castPath, JSON.stringify(cast));

    const res = await request(app).get('/api/voices');
    const v_Brann = res.body.voices.find((v: { id: string }) => v.id === 'v_Brann');
    expect(v_Brann.overrideTtsVoice).toEqual({ engine: 'coqui', name: 'Asya Anara' });
    /* When override engine matches the (default) Coqui engine, ttsVoice
       must resolve to the override name. */
    expect(v_Brann.ttsVoice.name).toBe('Asya Anara');

    /* Reset for the next test. */
    delete cast.characters[0].overrideTtsVoice;
    writeFileSync(castPath, JSON.stringify(cast));
  });
});

describe('PUT /api/voices/:voiceId/override', () => {
  it('writes the override to every cast.json sharing the voiceId', async () => {
    const res = await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    expect(res.status).toBe(204);

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoice).toEqual({ engine: 'coqui', name: 'Asya Anara' });
    expect(two.characters[0].overrideTtsVoice).toEqual({ engine: 'coqui', name: 'Asya Anara' });
  });

  it('clears the override on every matching cast.json when override is null', async () => {
    await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    const clear = await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: null });
    expect(clear.status).toBe(204);

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoice).toBeUndefined();
    expect(two.characters[0].overrideTtsVoice).toBeUndefined();
  });

  it('400 when override body is malformed', async () => {
    const res = await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'nope', name: 'Asya Anara' } });
    expect(res.status).toBe(400);
  });

  it('404 when no character carries the voiceId', async () => {
    const res = await request(app)
      .put('/api/voices/v_does_not_exist/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/voices/base', () => {
  function mockSpeakersResponse(speakers: string[]) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const target = typeof input === 'string'
        ? input
        : input instanceof URL ? input.toString() : (input as Request).url;
      if (target.endsWith('/speakers')) {
        return new Response(JSON.stringify({ coqui: speakers }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('', { status: 404 });
    }) as unknown as typeof fetch;
  }

  it('merges sidecar /speakers (Coqui) with the static Gemini catalog', async () => {
    mockSpeakersResponse(['Asya Anara', 'Damien Black']);
    const res = await request(app).get('/api/voices/base');
    expect(res.status).toBe(200);
    const names = (res.body.voices as Array<{ engine: string; name: string }>);
    const coqui = names.filter(v => v.engine === 'coqui').map(v => v.name);
    const gemini = names.filter(v => v.engine === 'gemini').map(v => v.name);
    expect(coqui).toContain('Asya Anara');
    expect(coqui).toContain('Damien Black');
    expect(gemini).toContain('Charon');
    expect(gemini.length).toBeGreaterThanOrEqual(30);
  });
});
