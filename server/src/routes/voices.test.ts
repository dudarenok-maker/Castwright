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
/* A SECOND series under the same author, sharing the v_Brann voiceId, used
   to prove a series-scoped override only touches the anchor book's
   series (plan 108). */
const OTHER_SERIES = 'Unlocked';
const OTHER_BOOK = 'Other Book';

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
      id: 'char-Brann',
      name: 'Brann',
      role: 'protagonist',
      color: 'magenta',
      voiceId: 'v_Brann',
      gender: 'male',
      ageRange: 'teen',
      attributes: ['Male', 'Teen'],
      lines: 50,
      scenes: 5,
    },
  ]);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO, bookTwoId, [
    {
      id: 'char-Brann',
      name: 'Brann',
      role: 'protagonist',
      color: 'magenta',
      voiceId: 'v_Brann',
      gender: 'male',
      ageRange: 'teen',
      attributes: ['Male', 'Teen'],
      lines: 80,
      scenes: 7,
    },
  ]);
  /* Third book — DIFFERENT series, same author, same voiceId. A
     series-scoped write anchored on BOOK_ONE must NOT touch this one. */
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    OTHER_SERIES,
    OTHER_BOOK,
    paths.makeBookId(AUTHOR, OTHER_SERIES, OTHER_BOOK),
    [
      {
        id: 'char-Brann',
        name: 'Brann',
        role: 'protagonist',
        color: 'magenta',
        voiceId: 'v_Brann',
        gender: 'male',
        ageRange: 'teen',
        attributes: ['Male', 'Teen'],
        lines: 10,
        scenes: 1,
      },
    ],
  );

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
    /* usedIn === 3 — both same-series books plus the cross-series book
       share the same voiceId (the aggregator folds workspace-wide). */
    expect(v_Brann.usedIn).toBe(3);
  });

  it('exposes overrideTtsVoices map when cast.json carries one', async () => {
    /* Quick targeted write — bypass the PUT endpoint to isolate the read side. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoices = { coqui: { name: 'Asya Anara' } };
    writeFileSync(castPath, JSON.stringify(cast));

    const res = await request(app).get('/api/voices');
    const v_Brann = res.body.voices.find((v: { id: string }) => v.id === 'v_Brann');
    expect(v_Brann.overrideTtsVoices).toEqual({ coqui: { name: 'Asya Anara' } });
    /* Legacy field projects the active engine's slot for backwards-
       compatible clients. */
    expect(v_Brann.overrideTtsVoice).toEqual({ engine: 'coqui', name: 'Asya Anara' });
    /* When override engine matches the (default) Coqui engine, ttsVoice
       must resolve to the override name. */
    expect(v_Brann.ttsVoice.name).toBe('Asya Anara');

    /* Reset for the next test. */
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));
  });

  it('migrates legacy singular overrideTtsVoice into the new map on read', async () => {
    /* Regression for the read-time normaliser. cast.json files written
       by older clients carry the singular field; the aggregator must
       transparently treat that as if the map slot were populated. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoice = { engine: 'coqui', name: 'Damien Black' };
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));

    const res = await request(app).get('/api/voices');
    const v_Brann = res.body.voices.find((v: { id: string }) => v.id === 'v_Brann');
    expect(v_Brann.overrideTtsVoices).toEqual({ coqui: { name: 'Damien Black' } });
    expect(v_Brann.ttsVoice.name).toBe('Damien Black');

    /* Cleanup. */
    delete cast.characters[0].overrideTtsVoice;
    writeFileSync(castPath, JSON.stringify(cast));
  });

  it('keeps a Kokoro override available when the response engine is Coqui', async () => {
    /* Per-engine pluralization: a cast carrying both a Coqui and a
       Kokoro slot must expose both on the response, so the UI tabs
       render correctly. ttsVoice resolves to the engine in the query. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoices = {
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    };
    writeFileSync(castPath, JSON.stringify(cast));

    const coquiRes = await request(app).get('/api/voices?engine=coqui');
    const fromCoqui = coquiRes.body.voices.find((v: { id: string }) => v.id === 'v_Brann');
    expect(fromCoqui.ttsVoice.name).toBe('Asya Anara');
    expect(fromCoqui.overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    });

    const kokoroRes = await request(app).get('/api/voices?engine=kokoro');
    const fromKokoro = kokoroRes.body.voices.find((v: { id: string }) => v.id === 'v_Brann');
    expect(fromKokoro.ttsVoice.name).toBe('am_onyx');
    expect(fromKokoro.overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    });

    /* Cleanup. */
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));
  });
});

describe('PUT /api/voices/:voiceId/override', () => {
  it('writes the override into overrideTtsVoices[engine] across every cast.json sharing the voiceId', async () => {
    const res = await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    expect(res.status).toBe(204);

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoices).toEqual({ coqui: { name: 'Asya Anara' } });
    expect(two.characters[0].overrideTtsVoices).toEqual({ coqui: { name: 'Asya Anara' } });
    /* Legacy singular field must be removed on write so the cast.json
       has a single source of truth. */
    expect(one.characters[0].overrideTtsVoice).toBeUndefined();
    expect(two.characters[0].overrideTtsVoice).toBeUndefined();
  });

  it('preserves other engine slots when updating one engine', async () => {
    /* The per-engine map's whole point: setting the Coqui slot must not
       wipe a previously-set Kokoro slot. */
    await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'kokoro', name: 'am_onyx' } });
    await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    expect(one.characters[0].overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_onyx' },
    });

    /* Cleanup. */
    await request(app).put('/api/voices/v_Brann/override').send({ override: null });
  });

  it('migrates legacy overrideTtsVoice on the first write that touches the cast', async () => {
    /* User flow: cast.json was written by an older client (legacy field),
       user opens the profile drawer and pins a Coqui voice → the write
       path normalises the legacy field into the map and removes it. */
    const castPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      SERIES,
      BOOK_ONE,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(castPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    cast.characters[0].overrideTtsVoice = { engine: 'kokoro', name: 'am_michael' };
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(castPath, JSON.stringify(cast));

    await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });

    const after = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    /* Both engines now in the map, legacy field gone. */
    expect(after.characters[0].overrideTtsVoices).toEqual({
      coqui: { name: 'Asya Anara' },
      kokoro: { name: 'am_michael' },
    });
    expect(after.characters[0].overrideTtsVoice).toBeUndefined();

    /* Cleanup. */
    await request(app).put('/api/voices/v_Brann/override').send({ override: null });
  });

  it('clears every engine slot when override is null', async () => {
    await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'coqui', name: 'Asya Anara' } });
    await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'kokoro', name: 'am_onyx' } });
    const clear = await request(app).put('/api/voices/v_Brann/override').send({ override: null });
    expect(clear.status).toBe(204);

    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoices).toBeUndefined();
    expect(two.characters[0].overrideTtsVoices).toBeUndefined();
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

describe('PUT /api/voices/:voiceId/override — series scope (plan 108)', () => {
  afterEach(async () => {
    /* Clear all three casts between cases so the cross-series assertions
       start clean. */
    await request(app).put('/api/voices/v_Brann/override').send({ override: null });
    const otherPath = join(
      workspaceRoot,
      'books',
      AUTHOR,
      OTHER_SERIES,
      OTHER_BOOK,
      '.audiobook',
      'cast.json',
    );
    const cast = JSON.parse(readFileSync(otherPath, 'utf8')) as {
      characters: Array<Record<string, unknown>>;
    };
    delete cast.characters[0].overrideTtsVoices;
    writeFileSync(otherPath, JSON.stringify(cast));
  });

  it("writes ONLY to the anchor book's series, leaving other series untouched", async () => {
    const res = await request(app)
      .put('/api/voices/v_Brann/override')
      .send({
        override: { engine: 'qwen', name: 'qwen-v_Brann' },
        scope: 'series',
        bookId: bookOneId,
      });
    expect(res.status).toBe(204);

    /* Both same-series books got the Qwen designed voiceId. */
    const one = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_ONE);
    const two = readCastFromDisk(workspaceRoot, AUTHOR, SERIES, BOOK_TWO);
    expect(one.characters[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-v_Brann' } });
    expect(two.characters[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-v_Brann' } });

    /* The cross-series book did NOT change. */
    const other = readCastFromDisk(workspaceRoot, AUTHOR, OTHER_SERIES, OTHER_BOOK);
    expect(other.characters[0].overrideTtsVoices).toBeUndefined();
  });

  it('defaults to a workspace-wide write when no scope is passed', async () => {
    await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-v_Brann' } });
    /* All three books — including the cross-series one — get the override. */
    const other = readCastFromDisk(workspaceRoot, AUTHOR, OTHER_SERIES, OTHER_BOOK);
    expect(other.characters[0].overrideTtsVoices).toEqual({ qwen: { name: 'qwen-v_Brann' } });
  });

  it("400s when scope is 'series' but bookId is missing", async () => {
    const res = await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-v_Brann' }, scope: 'series' });
    expect(res.status).toBe(400);
  });

  it('404s when the series-anchor bookId is unknown', async () => {
    const res = await request(app)
      .put('/api/voices/v_Brann/override')
      .send({ override: { engine: 'qwen', name: 'qwen-v_Brann' }, scope: 'series', bookId: 'nope' });
    expect(res.status).toBe(404);
  });
});

describe('GET /api/voices/base', () => {
  function mockSpeakersResponse(speakers: string[]) {
    globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
      const target =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : (input as Request).url;
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
    const names = res.body.voices as Array<{ engine: string; name: string }>;
    const coqui = names.filter((v) => v.engine === 'coqui').map((v) => v.name);
    const gemini = names.filter((v) => v.engine === 'gemini').map((v) => v.name);
    expect(coqui).toContain('Asya Anara');
    expect(coqui).toContain('Damien Black');
    expect(gemini).toContain('Charon');
    expect(gemini.length).toBeGreaterThanOrEqual(30);
  });
});
