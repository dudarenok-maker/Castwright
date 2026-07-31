/* The outcome harness for the cast.json lock sweep. Two overlapping
   read-modify-writes, each touching a DIFFERENT character: both mutations must
   survive. Deliberately ONE module registry — no vi.resetModules() between the
   two writers, because a partitioned lock behaves exactly like no lock and would
   make this pass vacuously (design §10.3). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readJson, writeJsonAtomic } from './state-io.js';
import { castJsonPath } from './paths.js';

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
});
