/* Integration tests for the voice-style router (plan 108).

   Seeds one book with a narrator + two speaking characters on disk and
   asserts:
     - the single route generates + persists `voiceStyle` to cast.json
     - the batch route loops the cast, persists each, and skips the narrator
       by default (and includes it with includeNarrator: true)
     - a per-character generator failure is collected (not aborted) and the
       batch still persists the successes
     - unknown book / character / no-cast → 404 / 409

   The Gemini generator is mocked (no network). Lazy-import pattern mirrors
   the sibling cast route tests so WORKSPACE_DIR is set before paths.ts
   binds BOOKS_ROOT.

   A second describe block (at the bottom) pins the GPU plan wiring:
   preparePersonaBatch is called once per /generate and once total for
   /generate-all, and its result is threaded into every generateVoiceStylePersona
   call. These use a lightweight supertest setup (no disk) to verify the
   call-site contract. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* Mock the GPU plan helper so the integration tests never touch real GPU state.
   preparePersonaBatch returns the off-GPU default (gemini engine). */
const mockPreparePersonaBatch = vi.fn<() => Promise<{ onCpu: boolean; keepAlive: string | number }>>();
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: mockPreparePersonaBatch,
}));

/* Mock the generator so the route test never touches Gemini. Default
   echoes a per-character persona; individual tests override via mockImpl. */
const generateVoiceStylePersona = vi.fn();
vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona,
}));

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const BOOK = 'The Hollow Tide';

let workspaceRoot: string;
let app: Express;
let bookId: string;

const characters = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  {
    id: 'wren',
    name: 'Wren',
    role: 'protagonist',
    color: 'lilac',
    gender: 'female',
    ageRange: 'teen',
    evidence: [{ quote: 'I can do this.' }],
  },
  {
    id: 'marlow',
    name: 'Marlow',
    role: 'sidekick',
    color: 'amber',
    gender: 'male',
    ageRange: 'teen',
    evidence: [{ quote: 'Relax, Foster.' }],
  },
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

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-voice-style-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ voiceStyleRouter }, { castAliasesRouter }, { makeBookId }] = await Promise.all([
    import('./voice-style.js'),
    import('./cast-aliases.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', voiceStyleRouter);
  /* #1981 review fix round — cast-aliases mounted too, for the
     generate-all-vs-add-alias race test at the bottom of this file. */
  app.use('/api/books', castAliasesRouter);
});

beforeEach(() => {
  generateVoiceStylePersona.mockReset();
  mockPreparePersonaBatch.mockReset();
  mockPreparePersonaBatch.mockResolvedValue({ onCpu: false, keepAlive: 0 });
  /* Default: persona derived from the character id so assertions can pin
     which character drove which call. */
  generateVoiceStylePersona.mockImplementation(async (c: { id: string }) => `persona-for-${c.id}`);
  writeBookOnDisk(characters);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('POST /api/books/:bookId/cast/:characterId/voice-style/generate', () => {
  it('generates and persists the persona to cast.json', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/wren/voice-style/generate`);
    expect(res.status).toBe(200);
    expect(res.body.voiceStyle).toBe('persona-for-wren');
    expect(generateVoiceStylePersona).toHaveBeenCalledTimes(1);
    /* The single character's row carries the persona; others untouched. */
    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'wren')?.voiceStyle).toBe('persona-for-wren');
    expect(cast.characters.find((c) => c.id === 'marlow')?.voiceStyle).toBeUndefined();
  });

  it('returns 404 for an unknown bookId', async () => {
    const res = await request(app).post('/api/books/nope/cast/wren/voice-style/generate');
    expect(res.status).toBe(404);
  });

  it('returns 404 for an unknown characterId', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/ghost/voice-style/generate`);
    expect(res.status).toBe(404);
  });

  it('surfaces a generator failure as 500', async () => {
    generateVoiceStylePersona.mockRejectedValue(new Error('GEMINI_API_KEY is required'));
    const res = await request(app).post(`/api/books/${bookId}/cast/wren/voice-style/generate`);
    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/GEMINI_API_KEY/);
  });

  /* #3711 PR #3714 — a node fs error's message embeds the absolute path it
     failed on; the 500 body must not carry it (LAN HTTPS). */
  it('answers a curated 500 for a node fs error, never its path', async () => {
    const { FS_FAILURE_REQUEST_ERROR } = await import('../workspace/file-lock.js');
    const path = join(workspaceRoot, 'books', 'x', '.audiobook', 'cast.json');
    generateVoiceStylePersona.mockRejectedValue(
      Object.assign(new Error(`EBUSY: resource busy or locked, open '${path}'`), {
        code: 'EBUSY',
        syscall: 'open',
        path,
      }),
    );
    const res = await request(app).post(`/api/books/${bookId}/cast/wren/voice-style/generate`);
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(FS_FAILURE_REQUEST_ERROR);
    expect(JSON.stringify(res.body)).not.toContain('EBUSY');
  });

  /* #1981 — two concurrent /generate calls for DIFFERENT characters in the
     SAME book race that book's cast.json. Unlocked, both requests' readJson
     resolve before either writeJsonAtomic lands, so the later write replays
     a `characters` snapshot taken before the earlier write happened and
     silently drops it. */
  it('#1981 — keeps both personas when two /generate calls for one book overlap', async () => {
    const [resWren, resMarlow] = await Promise.all([
      request(app).post(`/api/books/${bookId}/cast/wren/voice-style/generate`),
      request(app).post(`/api/books/${bookId}/cast/marlow/voice-style/generate`),
    ]);
    expect(resWren.status).toBe(200);
    expect(resMarlow.status).toBe(200);

    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'wren')?.voiceStyle).toBe('persona-for-wren');
    expect(cast.characters.find((c) => c.id === 'marlow')?.voiceStyle).toBe('persona-for-marlow');
  });

  /* #1981 fix round 3 — /generate's OWN written=false path (mirrors the
     written=false test for /generate-all further down this file). While the
     LLM call is "in flight" (inside the mocked generateVoiceStylePersona,
     before it resolves), a concurrent edit removes the target character from
     cast.json — simulating an unlink/merge landing between /generate's
     pre-lock read and writeVoiceStylePersona's own fresh read. The persist
     must not resurrect the character, and the route must report the same
     404 an unknown character gets up front, not a false 200. */
  it('#1981 — 404s when the character vanishes while the LLM call is in flight, and does not resurrect it', async () => {
    generateVoiceStylePersona.mockImplementation(async (c: { id: string }) => {
      const path = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json');
      const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
        characters: Array<{ id: string }>;
      };
      writeFileSync(
        path,
        JSON.stringify({ characters: onDisk.characters.filter((ch) => ch.id !== c.id) }),
      );
      return `persona-for-${c.id}`;
    });

    const res = await request(app).post(`/api/books/${bookId}/cast/wren/voice-style/generate`);
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/wren/);

    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'wren')).toBeUndefined();
  });
});

describe('POST /api/books/:bookId/cast/voice-style/generate-all', () => {
  it('generates for every speaking character and skips the narrator by default', async () => {
    const res = await request(app).post(`/api/books/${bookId}/cast/voice-style/generate-all`);
    expect(res.status).toBe(200);
    /* Two speaking characters, narrator skipped → 2 calls, 2 personas. */
    expect(generateVoiceStylePersona).toHaveBeenCalledTimes(2);
    expect(res.body.voiceStyles).toEqual({
      wren: 'persona-for-wren',
      marlow: 'persona-for-marlow',
    });
    expect(res.body.failures).toEqual({});
    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'narrator')?.voiceStyle).toBeUndefined();
    expect(cast.characters.find((c) => c.id === 'wren')?.voiceStyle).toBe('persona-for-wren');
    expect(cast.characters.find((c) => c.id === 'marlow')?.voiceStyle).toBe('persona-for-marlow');
  });

  it('includes the narrator when includeNarrator: true', async () => {
    const res = await request(app)
      .post(`/api/books/${bookId}/cast/voice-style/generate-all`)
      .send({ includeNarrator: true });
    expect(res.status).toBe(200);
    expect(generateVoiceStylePersona).toHaveBeenCalledTimes(3);
    expect(res.body.voiceStyles.narrator).toBe('persona-for-narrator');
  });

  it('tolerates a per-character failure and still persists the successes', async () => {
    generateVoiceStylePersona.mockImplementation(async (c: { id: string }) => {
      if (c.id === 'marlow') throw new Error('rate limited');
      return `persona-for-${c.id}`;
    });
    const res = await request(app).post(`/api/books/${bookId}/cast/voice-style/generate-all`);
    expect(res.status).toBe(200);
    expect(res.body.voiceStyles).toEqual({ wren: 'persona-for-wren' });
    expect(res.body.failures).toEqual({ marlow: 'rate limited' });
    /* The success is persisted; the failed character has no voiceStyle. */
    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'wren')?.voiceStyle).toBe('persona-for-wren');
    expect(cast.characters.find((c) => c.id === 'marlow')?.voiceStyle).toBeUndefined();
  });

  it('returns 409 when the book has no cast on disk', async () => {
    writeBookOnDisk([]);
    const res = await request(app).post(`/api/books/${bookId}/cast/voice-style/generate-all`);
    expect(res.status).toBe(409);
  });

  it('also skips a char-narrator id by default — the promoted-cast-row twin of "narrator" (#1895)', async () => {
    // Name deliberately does NOT literal-match "Narrator" — isolates the
    // id-based branch of isNarrator from its by-name fallback.
    writeBookOnDisk([
      { id: 'char-narrator', name: 'The Storyteller', role: 'narrator', color: 'narrator' },
      { id: 'wren', name: 'Wren', role: 'protagonist', color: 'lilac' },
    ]);
    const res = await request(app).post(`/api/books/${bookId}/cast/voice-style/generate-all`);
    expect(res.status).toBe(200);
    expect(generateVoiceStylePersona).toHaveBeenCalledTimes(1);
    expect(res.body.voiceStyles).toEqual({ wren: 'persona-for-wren' });
    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'char-narrator')?.voiceStyle).toBeUndefined();
  });
});

/* --- GPU plan wiring (srv-48 Task 8) ----------------------------------------
   Pin that preparePersonaBatch is called once per /generate and ONCE for
   the whole /generate-all batch, and that its result is threaded into every
   generateVoiceStylePersona call. The disk-backed `app` above is reused;
   mockPreparePersonaBatch is already wired at the top. */

describe('voice-style routes apply the persona GPU plan', () => {
  it('/generate calls preparePersonaBatch and threads prep into generateVoiceStylePersona', async () => {
    const prep = { onCpu: true, keepAlive: 0 };
    mockPreparePersonaBatch.mockResolvedValue(prep);

    const res = await request(app).post(`/api/books/${bookId}/cast/wren/voice-style/generate`);
    expect(res.status).toBe(200);

    /* preparePersonaBatch called once for this single-character request */
    expect(mockPreparePersonaBatch).toHaveBeenCalledTimes(1);

    /* generateVoiceStylePersona received (character, prep) — not bare character */
    expect(generateVoiceStylePersona).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'wren' }),
      prep,
    );
  });

  it('/generate-all calls preparePersonaBatch ONCE (not per character) and threads same prep', async () => {
    const prep = { onCpu: false, keepAlive: '5m' };
    mockPreparePersonaBatch.mockResolvedValue(prep);

    const res = await request(app)
      .post(`/api/books/${bookId}/cast/voice-style/generate-all`)
      .send({});
    expect(res.status).toBe(200);

    /* One prepare for the whole batch — never per character */
    expect(mockPreparePersonaBatch).toHaveBeenCalledTimes(1);

    /* Both speaking characters were generated with the SAME prep object */
    expect(generateVoiceStylePersona).toHaveBeenCalledTimes(2); // narrator skipped
    for (const call of generateVoiceStylePersona.mock.calls) {
      expect(call[1]).toEqual(prep);
    }
  });
});

/* #1981 review fix round — the site the review flagged as holding the book's
   cast lock across the WHOLE batch. Proves the fix with an ordering proof,
   not a wall-clock budget: the mocked generator parks its FIRST call on a
   manually released gate, a concurrent add-alias on the same book is posted
   and shown to complete while that call is still pending, and only then is
   the generator released.
   Under the pre-fix-round design (one withCastLock wrapping
   preparePersonaBatch + every generateVoiceStylePersona call + the final
   write), the add-alias's own withCastLock call couldn't even START until
   the whole batch released the lock, so the add-alias would block behind
   the gated generator (which blocks on the test) and the deadlock race
   fires — a property of ordering, independent of runner speed, which is
   exactly why this needs its own dedicated test rather than folding into
   the plain correctness checks above. Own isolated book (own bookId/app
   reuse, own cast.json) so the extra characters and the gated generator
   can't disturb the assertions above or its own repeat runs. */
describe('#1981 — /generate-all no longer holds the book lock across the whole batch', () => {
  const RACE_TITLE = 'Voice Style Batch Race Book';
  const BATCH_CHARACTER_IDS = ['echo', 'foxtrot', 'golf', 'hotel'];
  let raceBookId: string;
  let raceBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    raceBookId = makeBookId(AUTHOR, SERIES, RACE_TITLE);
    raceBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, RACE_TITLE);
  });

  beforeEach(() => {
    mkdirSync(join(raceBookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(raceBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: raceBookId,
        manuscriptId: `m_${raceBookId}`,
        title: RACE_TITLE,
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
    writeFileSync(join(raceBookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(raceBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
          ...BATCH_CHARACTER_IDS.map((id) => ({
            id,
            name: id,
            role: 'character',
            color: 'unset',
            aliases: [],
          })),
        ],
      }),
    );
  });

  it('lets a concurrent add-alias land quickly instead of waiting for the whole batch', async () => {
    generateVoiceStylePersona.mockReset();

    /* Order-based proof (replaces this test's old wall-clock budget): the
       mocked generator signals on entry, then parks on a gate only the test
       releases — no setTimeout stub, no milliseconds. */
    let releaseGenerator!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGenerator = r;
    });
    let enteredGenerator!: () => void;
    const entered = new Promise<void>((r) => {
      enteredGenerator = r;
    });
    /* Gate only the FIRST generator call; later calls return immediately,
       so after the release the whole 4-character batch still completes and
       the closing "every character got its voiceStyle" assertions stay
       meaningful. */
    let firstGeneratorCall = true;
    generateVoiceStylePersona.mockImplementation(async (c: { id: string }) => {
      if (firstGeneratorCall) {
        firstGeneratorCall = false;
        enteredGenerator();
        await gate;
        aliasLandedWhenGeneratorResumed = aliasLanded;
      }
      return `persona-for-${c.id}`;
    });
    /* Witness for the ordering: set once the add-alias response has resolved,
       and read by the generator the moment it resumes from the gate. */
    let aliasLanded = false;
    let aliasLandedWhenGeneratorResumed: boolean | undefined;

    const genAllPromise = request(app).post(
      `/api/books/${raceBookId}/cast/voice-style/generate-all`,
    );
    genAllPromise.catch(() => {}); // supertest is lazy — force real dispatch now

    try {
      /* Wait until generate-all has actually STARTED its first LLM call,
         bounded by a deadlock race so a route that never gets there fails
         loudly instead of hanging. */
      let enteredTimer!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, rej) => {
            enteredTimer = setTimeout(
              () => rej(new Error('DEADLOCK: route never reached the LLM call')),
              8_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(enteredTimer);
      }

      /* A concurrent add-alias on the same book must land WHILE the generator
         is still pending on the gate; the witness assertion after the
         generator is released proves it. The 8 s race is a hang detector only — it sits under the 15 s testTimeout and is NOT
         an assertion about speed; under the pre-fix design the add-alias
         would block behind the gated generator and turn this red here
         instead of hanging. */
      let aliasTimer!: ReturnType<typeof setTimeout>;
      let addAliasRes!: { status: number };
      try {
        addAliasRes = await Promise.race([
          request(app)
            .post(`/api/books/${raceBookId}/cast/add-alias`)
            .send({ characterId: 'echo', aliasName: 'Fast' }),
          new Promise<never>((_, rej) => {
            aliasTimer = setTimeout(
              () => rej(new Error('DEADLOCK: add-alias blocked behind the LLM call')),
              8_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(aliasTimer);
      }

      aliasLanded = true;
      expect(addAliasRes.status).toBe(200);
    } finally {
      /* Release the generator even on a failed run (e.g. under the
         pre-fix-design mutation), so the supertest generate-all request is
         never left dangling on the gate. */
      releaseGenerator();
    }

    const genAllRes = await genAllPromise;
    expect(genAllRes.status).toBe(200);
    /* The ordering witness: add-alias had already resolved when the parked
       generator resumed, i.e. it completed while the generator was pending. */
    expect(aliasLandedWhenGeneratorResumed).toBe(true);

    const cast = JSON.parse(
      readFileSync(join(raceBookDir, '.audiobook', 'cast.json'), 'utf8'),
    ) as { characters: Array<{ id: string; aliases?: string[]; voiceStyle?: string }> };
    const echo = cast.characters.find((c) => c.id === 'echo')!;
    expect(echo.aliases).toEqual(['Fast']);
    for (const id of BATCH_CHARACTER_IDS) {
      expect(cast.characters.find((c) => c.id === id)?.voiceStyle).toBe(`persona-for-${id}`);
    }
  });
});

/* #1981 review fix round 2 — the sibling defect the re-review flagged
   (NEW-1): /generate held the book's cast lock across the LLM call (and, on
   the Gemini path, geminiRateLimiter.acquire's unbounded sleep ahead of it).
   Same proof shape as the /generate-all race above: hold the single
   generator call open on a manually released gate and show a concurrent
   add-alias on the same book completes while that call is still pending —
   ordering, not milliseconds. Own isolated book so the gated generator
   can't disturb the assertions in the sibling describe block above. */
describe('#1981 — /generate no longer holds the book lock across the LLM call', () => {
  const RACE_TITLE = 'Voice Style Single Race Book';
  let raceBookId: string;
  let raceBookDir: string;

  beforeAll(async () => {
    const { makeBookId } = await import('../workspace/paths.js');
    raceBookId = makeBookId(AUTHOR, SERIES, RACE_TITLE);
    raceBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, RACE_TITLE);
  });

  beforeEach(() => {
    mkdirSync(join(raceBookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(raceBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: raceBookId,
        manuscriptId: `m_${raceBookId}`,
        title: RACE_TITLE,
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
    writeFileSync(join(raceBookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(raceBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
          { id: 'india', name: 'India', role: 'character', color: 'unset', aliases: [] },
        ],
      }),
    );
  });

  it('lets a concurrent add-alias land quickly instead of waiting for the generation', async () => {
    generateVoiceStylePersona.mockReset();

    /* Order-based proof (replaces this test's old wall-clock budget): the
       single mocked generator call signals on entry, then parks on a gate
       only the test releases — no setTimeout stub, no milliseconds. */
    let releaseGenerator!: () => void;
    const gate = new Promise<void>((r) => {
      releaseGenerator = r;
    });
    let enteredGenerator!: () => void;
    const entered = new Promise<void>((r) => {
      enteredGenerator = r;
    });
    generateVoiceStylePersona.mockImplementation(async (c: { id: string }) => {
      enteredGenerator();
      await gate;
      aliasLandedWhenGeneratorResumed = aliasLanded;
      return `persona-for-${c.id}`;
    });
    /* Witness for the ordering: set once the add-alias response has resolved,
       and read by the generator the moment it resumes from the gate. */
    let aliasLanded = false;
    let aliasLandedWhenGeneratorResumed: boolean | undefined;

    const generatePromise = request(app).post(
      `/api/books/${raceBookId}/cast/india/voice-style/generate`,
    );
    generatePromise.catch(() => {}); // supertest is lazy — force real dispatch now

    try {
      /* Wait until /generate has actually STARTED its LLM call, bounded by
         a deadlock race so a route that never gets there fails loudly
         instead of hanging. */
      let enteredTimer!: ReturnType<typeof setTimeout>;
      try {
        await Promise.race([
          entered,
          new Promise<never>((_, rej) => {
            enteredTimer = setTimeout(
              () => rej(new Error('DEADLOCK: route never reached the LLM call')),
              8_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(enteredTimer);
      }

      /* A concurrent add-alias on the same book must land WHILE the generator
         is still pending on the gate; the witness assertion after the
         generator is released proves it. The 8 s race is a hang detector only — it sits under the 15 s testTimeout and is NOT
         an assertion about speed; under the pre-fix design the add-alias
         would block behind the gated generator and turn this red here
         instead of hanging. */
      let aliasTimer!: ReturnType<typeof setTimeout>;
      let addAliasRes!: { status: number };
      try {
        addAliasRes = await Promise.race([
          request(app)
            .post(`/api/books/${raceBookId}/cast/add-alias`)
            .send({ characterId: 'india', aliasName: 'Fast' }),
          new Promise<never>((_, rej) => {
            aliasTimer = setTimeout(
              () => rej(new Error('DEADLOCK: add-alias blocked behind the LLM call')),
              8_000,
            );
          }),
        ]);
      } finally {
        clearTimeout(aliasTimer);
      }

      aliasLanded = true;
      expect(addAliasRes.status).toBe(200);
    } finally {
      /* Release the generator even on a failed run (e.g. under the
         pre-fix-design mutation), so the supertest generate request is
         never left dangling on the gate. */
      releaseGenerator();
    }

    const generateRes = await generatePromise;
    expect(generateRes.status).toBe(200);
    /* The ordering witness: add-alias had already resolved when the parked
       generator resumed, i.e. it completed while the generator was pending. */
    expect(aliasLandedWhenGeneratorResumed).toBe(true);

    const cast = JSON.parse(
      readFileSync(join(raceBookDir, '.audiobook', 'cast.json'), 'utf8'),
    ) as { characters: Array<{ id: string; aliases?: string[]; voiceStyle?: string }> };
    const india = cast.characters.find((c) => c.id === 'india')!;
    expect(india.aliases).toEqual(['Fast']);
    expect(india.voiceStyle).toBe('persona-for-india');
  });
});

/* #1981 review fix round 2 (NEW-2) — pins what writeVoiceStylePersona's
   `boolean` return is actually FOR: the observable difference between the
   written and not-written paths. Simulates a character being removed from
   cast.json — by a concurrent unlink/merge, say — between generate-all's
   pre-lock read (which decided to attempt a persona for it) and that
   character's own locked persist. The vanished character must be reported
   as neither a success nor a failure, and must not be resurrected on disk.
   A generator-return-value mutation (`return false` -> `return true`, or
   dropping the `if (written)` guard) makes this assertion fail: the vanished
   character would show up in `voiceStyles` even though nothing was written. */
describe('#1981 — writeVoiceStylePersona\'s written=false path (a character deleted mid-batch)', () => {
  it('is neither reported as a success nor a failure, and is not resurrected in cast.json', async () => {
    generateVoiceStylePersona.mockImplementation(async (c: { id: string }) => {
      if (c.id === 'wren') {
        // Concurrent edit landing between generate-all's pre-lock read and
        // marlow's own turn in the loop: marlow is removed from the roster.
        const path = join(workspaceRoot, 'books', AUTHOR, SERIES, BOOK, '.audiobook', 'cast.json');
        const onDisk = JSON.parse(readFileSync(path, 'utf8')) as {
          characters: Array<{ id: string }>;
        };
        writeFileSync(
          path,
          JSON.stringify({ characters: onDisk.characters.filter((ch) => ch.id !== 'marlow') }),
        );
      }
      return `persona-for-${c.id}`;
    });

    const res = await request(app).post(`/api/books/${bookId}/cast/voice-style/generate-all`);
    expect(res.status).toBe(200);

    // written=false is a silent, intentional skip — not a reported success...
    expect(res.body.voiceStyles.marlow).toBeUndefined();
    // ...and not a reported failure either (the LLM call itself succeeded).
    expect(res.body.failures.marlow).toBeUndefined();
    // The unaffected character still gets its persona normally (written=true).
    expect(res.body.voiceStyles.wren).toBe('persona-for-wren');

    // Not resurrected in cast.json — the deletion stands.
    const cast = readCast();
    expect(cast.characters.find((c) => c.id === 'marlow')).toBeUndefined();
  });
});

/* #2292 (owner decision) — a lock timeout on ONE character's persist reports
 * contention, not a failed persona.
 *
 * `writeVoiceStylePersona` takes the book's cast lock, so ordinary contention
 * lands in the per-character `failures` map. That map stays (one contended
 * character must not fail the batch — the other characters' personas are
 * already generated and persisted by then), but the reason no longer reads as
 * "this character's voice style could not be generated", which is the opposite
 * of what happened: the persona generated fine and the write was blocked.
 *
 * Two-directional: an ordinary error at the same site keeps its own message,
 * which is the half that reddens if the route rewrote every failure reason.
 */
describe('voice-style generate-all — per-item reason on a lock timeout (#2292)', () => {
  async function generateAllWithThrowOnWren(toThrow: unknown) {
    const castDesign = await import('./cast-design.js');
    const original = castDesign.writeVoiceStylePersona;
    const spy = vi
      .spyOn(castDesign, 'writeVoiceStylePersona')
      .mockImplementation(async (dir: string, characterId: string, persona: string) => {
        if (characterId === 'wren') throw toThrow;
        return original(dir, characterId, persona);
      });
    try {
      return await request(app).post(`/api/books/${bookId}/cast/voice-style/generate-all`);
    } finally {
      spy.mockRestore();
    }
  }

  it('reports contention for the contended character and still persists the others', async () => {
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_ITEM_REASON } = await import(
      '../workspace/file-lock.js'
    );
    const res = await generateAllWithThrowOnWren(
      new LockAcquisitionTimeoutError('cast:/w/hollow-tide', 10_000),
    );

    expect(res.status).toBe(200);
    /* The site really ran, for exactly the character the spy aimed at. */
    expect(Object.keys(res.body.failures)).toEqual(['wren']);
    expect(res.body.failures.wren).toBe(LOCK_CONTENTION_ITEM_REASON);
    expect(res.body.failures.wren).not.toContain('withKeyLock');

    /* Not escalated: the other character's persona is on disk. */
    expect(res.body.voiceStyles).toEqual({ marlow: 'persona-for-marlow' });
    expect(readCast().characters.find((c) => c.id === 'marlow')?.voiceStyle).toBe(
      'persona-for-marlow',
    );
  });

  it('an ordinary error at the same site keeps its own message', async () => {
    const res = await generateAllWithThrowOnWren(new Error('simulated disk-full'));

    expect(res.status).toBe(200);
    expect(res.body.failures.wren).toBe('simulated disk-full');
  });
});
