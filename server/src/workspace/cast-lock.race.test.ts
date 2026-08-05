/* The outcome harness for the cast.json lock sweep. Two overlapping
   read-modify-writes, each touching a DIFFERENT character: both mutations must
   survive. Deliberately ONE module registry — no vi.resetModules() between the
   two writers, because a partitioned lock behaves exactly like no lock and would
   make this pass vacuously (design §10.3). */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { readJson, writeJsonAtomic } from './state-io.js';
import { castJsonPath } from './paths.js';
import { withCastLock } from './cast-lock.js';

/* #1981 — mocks for the cross-module describe block at the bottom of this
   file (voice-style's generate route needs these so it never touches a real
   Gemini/GPU boundary). `vi.mock` factories cannot close over a plain
   top-level `const` — TDZ at hoist time — so the mock fns themselves must be
   declared via `vi.hoisted()` (same pattern as cast-design.test.ts /
   voice-style.test.ts), and both calls must sit here, at the file's true top
   level: nested inside the describe block below, they don't reliably hoist
   ahead of the dynamic `import('../routes/voice-style.js')` that needs them
   already wired. */
const { mockPreparePersonaBatch, mockGenerateVoiceStylePersona } = vi.hoisted(() => ({
  mockPreparePersonaBatch: vi.fn().mockResolvedValue({ onCpu: false, keepAlive: 0 }),
  mockGenerateVoiceStylePersona: vi
    .fn()
    .mockImplementation(async (c: { id: string }) => `persona-for-${c.id}`),
}));
vi.mock('../tts/persona-gpu-plan.js', () => ({
  preparePersonaBatch: mockPreparePersonaBatch,
}));
vi.mock('../analyzer/voice-style.js', () => ({
  generateVoiceStylePersona: mockGenerateVoiceStylePersona,
}));

interface Cast {
  characters: Array<{ id: string; voice?: string }>;
}

let dir: string;
let castPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'cast-lock-race-'));
  /* Build at castJsonPath(dir), NOT join(dir, 'cast.json') — castJsonPath
     returns <dir>/.audiobook/cast.json, and later tasks derive the lock key
     from the same helper. */
  castPath = castJsonPath(dir);
  await writeJsonAtomic(castPath, {
    characters: [{ id: 'alice' }, { id: 'bob' }],
  } satisfies Cast);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** One handler-shaped RMW: read the whole cast, mutate one character, write it
    all back. This is the shape of all 35 cast.json writers. */
export async function assignVoice(
  path: string,
  characterId: string,
  voice: string,
): Promise<void> {
  const cast = await readJson<Cast>(path);
  const characters = [...(cast?.characters ?? [])];
  const i = characters.findIndex((c) => c.id === characterId);
  characters[i] = { ...characters[i], voice };
  await writeJsonAtomic(path, { ...cast, characters });
}

export async function readVoices(path: string): Promise<Record<string, string | undefined>> {
  const cast = await readJson<Cast>(path);
  return Object.fromEntries((cast?.characters ?? []).map((c) => [c.id, c.voice]));
}

describe('cast.json concurrent read-modify-write', () => {
  it('loses a mutation when two writers overlap unlocked', async () => {
    await Promise.all([
      assignVoice(castPath, 'alice', 'a'),
      assignVoice(castPath, 'bob', 'b'),
    ]);
    const v = await readVoices(castPath);
    /* Documents the defect: unlocked, one mutation is always lost. Task 2 adds
       the locked counterpart beside this. If a future change to readJson /
       writeJsonAtomic ever stops them yielding in the same tick, this test goes
       red — the correct response is to update THIS test, never to reintroduce
       an unlocked write path. */
    expect(v.alice === 'a' && v.bob === 'b').toBe(false);
  });

  it('keeps both mutations when the writers hold the cast lock', async () => {
    const bookDir = dir; // castPath was built as castJsonPath(dir) in beforeEach
    await Promise.all([
      withCastLock(bookDir, () => assignVoice(castPath, 'alice', 'a')),
      withCastLock(bookDir, () => assignVoice(castPath, 'bob', 'b')),
    ]);
    const v = await readVoices(castPath);
    expect(v).toEqual({ alice: 'a', bob: 'b' });
  });
});

/* #1981 Task 6 — the required cross-module deliverable. Every OTHER spec in
   this sweep races a site against ITSELF: one import, one derivation of the
   lock key, so a key mismatch between two DIFFERENT sites is invisible to it.
   This is the only test in the whole suite that can catch that — it races
   cast-aliases' add-alias against voice-style's single-character generate,
   two genuinely different modules, on the SAME book, and asserts both
   writes survive. If either module ever derived its lock key even slightly
   differently from `withCastLock`'s own `castJsonPath(bookDir)` (case,
   trailing slash, a different `bookDir` resolution), the two would take
   independent, non-contending mutexes and this test would go red while
   every self-vs-self spec elsewhere stayed green.

   `vi.resetModules()` + a fresh dynamic import (the same lazy-import pattern
   the route test files use) is required here, unlike the primitive-harness
   tests above: `paths.js`'s `BOOKS_ROOT` is a module-level const baked in at
   import time from `WORKSPACE_DIR`, and this file's own top-of-file static
   `import './paths.js'` already resolved it before this block's `beforeAll`
   ever runs — findBookByBookId (which the real routes need) would silently
   resolve against the wrong root without the reset. */
describe('#1981 — cross-module race: two DIFFERENT sites racing the same book', () => {
  const AUTHOR = 'Cross Module Author';
  const SERIES = 'Standalones';
  const TITLE = 'Cross Module Book';

  let crossWorkspaceRoot: string;
  let crossBookDir: string;
  let crossBookId: string;
  let crossApp: Express;

  beforeAll(async () => {
    crossWorkspaceRoot = await mkdtemp(join(tmpdir(), 'cast-lock-cross-module-'));
    process.env.WORKSPACE_DIR = crossWorkspaceRoot;
    vi.resetModules();

    const [{ castAliasesRouter }, { voiceStyleRouter }, { makeBookId }] = await Promise.all([
      import('../routes/cast-aliases.js'),
      import('../routes/voice-style.js'),
      import('./paths.js'),
    ]);
    crossBookId = makeBookId(AUTHOR, SERIES, TITLE);
    crossBookDir = join(crossWorkspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    mkdirSync(join(crossBookDir, '.audiobook'), { recursive: true });
    writeFileSync(
      join(crossBookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: crossBookId,
        manuscriptId: 'm_cross_module',
        title: TITLE,
        author: AUTHOR,
        series: SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.txt',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );
    writeFileSync(join(crossBookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(crossBookDir, '.audiobook', 'cast.json'),
      JSON.stringify({
        characters: [
          { id: 'alpha', name: 'Alpha', role: 'character', color: 'unset', aliases: [] },
          { id: 'beta', name: 'Beta', role: 'character', color: 'unset' },
        ],
      }),
    );

    crossApp = express();
    crossApp.use(express.json());
    crossApp.use('/api/books', castAliasesRouter);
    crossApp.use('/api/books', voiceStyleRouter);
  });

  afterAll(async () => {
    if (crossWorkspaceRoot) await rm(crossWorkspaceRoot, { recursive: true, force: true });
    delete process.env.WORKSPACE_DIR;
    vi.resetModules();
  });

  it('keeps both writes when cast-aliases and voice-style race the same book', async () => {
    const [resAlias, resStyle] = await Promise.all([
      request(crossApp)
        .post(`/api/books/${crossBookId}/cast/add-alias`)
        .send({ characterId: 'alpha', aliasName: 'Ally' }),
      request(crossApp).post(`/api/books/${crossBookId}/cast/beta/voice-style/generate`),
    ]);
    expect(resAlias.status).toBe(200);
    expect(resStyle.status).toBe(200);

    const cast = await readJson<{
      characters: Array<{ id: string; aliases?: string[]; voiceStyle?: string }>;
    }>(castJsonPath(crossBookDir));
    const alpha = cast!.characters.find((c) => c.id === 'alpha')!;
    const beta = cast!.characters.find((c) => c.id === 'beta')!;
    expect(alpha.aliases).toEqual(['Ally']);
    expect(beta.voiceStyle).toBe('persona-for-beta');
  });
});
