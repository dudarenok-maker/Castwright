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
   binds BOOKS_ROOT. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

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

  const [{ voiceStyleRouter }, { makeBookId }] = await Promise.all([
    import('./voice-style.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, BOOK);

  app = express();
  app.use(express.json());
  app.use('/api/books', voiceStyleRouter);
});

beforeEach(() => {
  generateVoiceStylePersona.mockReset();
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
});
