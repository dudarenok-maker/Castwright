/* The per-book state.json lock primitive (#3625 child 1). Case (a) is the
   outcome harness: two overlapping read-modify-writes, each stamping a
   DIFFERENT chapter, must both survive. Deliberately ONE module registry — no
   vi.resetModules() between the writers, because a partitioned lock behaves
   exactly like no lock and would make this pass vacuously
   (cast-lock.race.test.ts). Real readJson / writeStateJsonAtomic /
   stateJsonPath, no mocks. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { readJson } from './state-io.js';
import { stateJsonPath } from './paths.js';
import { writeStateJsonAtomic, type BookStateJsonWrite } from './state-migrate.js';
import { stateLockKey, withStateLock } from './state-lock.js';

interface Chapter {
  id: number;
  title: string;
  slug: string;
  duration?: string;
}
interface TestState {
  chapters: Chapter[];
}

let dir: string;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function seed(bookDir: string): Promise<void> {
  const state = {
    bookId: 'b1',
    chapters: [
      { id: 1, title: 'One', slug: '01-one' },
      { id: 2, title: 'Two', slug: '02-two' },
    ],
  } as unknown as BookStateJsonWrite;
  await writeStateJsonAtomic(stateJsonPath(bookDir), state);
}

async function stampDuration(bookDir: string, chapterId: number, duration: string, holdMs = 0) {
  await withStateLock(bookDir, async () => {
    const state = await readJson<TestState>(stateJsonPath(bookDir));
    if (holdMs > 0) await delay(holdMs);
    const next = {
      ...state!,
      chapters: state!.chapters.map((c) => (c.id === chapterId ? { ...c, duration } : c)),
    };
    await writeStateJsonAtomic(stateJsonPath(bookDir), next as unknown as BookStateJsonWrite);
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'state-lock-'));
  await seed(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('withStateLock', () => {
  it('(a) two overlapping read-modify-writes on one book both survive', async () => {
    const a = stampDuration(dir, 1, '1:00', 100);
    await delay(10); // A holds the lock and has read; B is started while A is held
    const b = stampDuration(dir, 2, '2:00');
    await Promise.all([a, b]);

    const state = await readJson<TestState>(stateJsonPath(dir));
    expect(state!.chapters.find((c) => c.id === 1)?.duration).toBe('1:00');
    expect(state!.chapters.find((c) => c.id === 2)?.duration).toBe('2:00');
  });

  it('(b) different books do not serialise', async () => {
    const other = await mkdtemp(join(tmpdir(), 'state-lock-other-'));
    try {
      let release!: () => void;
      const held = new Promise<void>((r) => (release = r));
      const x = withStateLock(dir, () => held);
      await delay(10);

      let yRan = false;
      await withStateLock(other, async () => {
        yRan = true;
      });
      expect(yRan).toBe(true); // resolved while X is still held

      release();
      await x;
    } finally {
      await rm(other, { recursive: true, force: true });
    }
  });

  it('(c) two spellings of one bookDir share one lock', async () => {
    /* Raw concatenation, not join(): join() already collapses '..', which would
       make both spellings identical strings and the case vacuous. */
    const alt = `${dir}${sep}sub${sep}..`;
    expect(stateLockKey(alt)).toBe(stateLockKey(dir));

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const first = withStateLock(dir, () => held);
    await delay(10);

    let secondRan = false;
    const second = withStateLock(alt, async () => {
      secondRan = true;
    });
    await delay(100);
    expect(secondRan).toBe(false);

    release();
    await first;
    await second;
    expect(secondRan).toBe(true);
  });

  it('(d) the key is exactly state:<resolved bookDir>', () => {
    expect(stateLockKey(dir)).toBe(`state:${resolve(dir)}`);
  });
});
