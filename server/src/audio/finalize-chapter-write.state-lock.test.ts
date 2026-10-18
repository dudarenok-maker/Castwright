/* #3625 — two finalizes for SIBLING chapters of one book must both keep their
   state.json stamp.

   THE OVERLAP IS FORCED, NOT HOPED FOR. Both `writeStateJsonAtomic` (state-migrate)
   and `readJson` (state-io) are wrapped around the real functions. The FIRST
   state.json write parks until either a SECOND state.json read has happened or
   5s have passed, then delegates to the real write.
     - Without the lock: finalize B reads state.json while A's write is parked, so
       B's snapshot lacks A's stamp and B's later write drops it.
     - With the lock: B cannot read until A's write lands, so the 5s fallback
       releases A, and B then reads a state.json that already carries A's stamp. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SR = 24_000;
const AUTHOR = 'Lock Author';
const SERIES = 'Standalones';
const TITLE = 'Lock Story';

const gate = vi.hoisted(() => ({
  stateReads: 0,
  stateWrites: 0,
  secondReadSeen: null as null | (() => void),
  secondReadPromise: null as null | Promise<void>,
}));

vi.mock('../workspace/state-io.js', async (orig) => {
  const real = await orig<typeof import('../workspace/state-io.js')>();
  return {
    ...real,
    readJson: (async (path: string) => {
      if (path.endsWith('state.json')) {
        gate.stateReads += 1;
        if (gate.stateReads >= 2) gate.secondReadSeen?.();
      }
      return real.readJson(path);
    }) as typeof real.readJson,
    /* state.json is read through the recovering reader (#3625 sweep); count it
       the same way so the forced-overlap gate still sees the second reader. */
    readJsonWithRecovery: (async (path: string, opts: { keep: number }) => {
      if (path.endsWith('state.json')) {
        gate.stateReads += 1;
        if (gate.stateReads >= 2) gate.secondReadSeen?.();
      }
      return real.readJsonWithRecovery(path, opts);
    }) as typeof real.readJsonWithRecovery,
  };
});

vi.mock('../workspace/state-migrate.js', async (orig) => {
  const real = await orig<typeof import('../workspace/state-migrate.js')>();
  return {
    ...real,
    writeStateJsonAtomic: (async (...args: Parameters<typeof real.writeStateJsonAtomic>) => {
      gate.stateWrites += 1;
      if (gate.stateWrites === 1 && gate.secondReadPromise) {
        await Promise.race([
          gate.secondReadPromise,
          new Promise<void>((r) => setTimeout(r, 5000)),
        ]);
      }
      return real.writeStateJsonAtomic(...args);
    }) as typeof real.writeStateJsonAtomic,
  };
});

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let finalizeChapterAudioWrite: typeof import('./finalize-chapter-write.js').finalizeChapterAudioWrite;

function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}

beforeEach(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-finalize-statelock-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  gate.stateReads = 0;
  gate.stateWrites = 0;
  gate.secondReadPromise = new Promise<void>((r) => {
    gate.secondReadSeen = r;
  });

  const [{ finalizeChapterAudioWrite: fn }, { makeBookId }] = await Promise.all([
    import('./finalize-chapter-write.js'),
    import('../workspace/paths.js'),
  ]);
  finalizeChapterAudioWrite = fn;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);

  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [
        { id: 1, title: 'Chapter 1', slug: 'chapter-one', duration: '0:00' },
        { id: 2, title: 'Chapter 2', slug: 'chapter-two', duration: '0:00' },
      ],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const inputFor = (id: number, slug: string, title: string, durationSec: number) => ({
  bookId,
  bookDir,
  chapter: { id, slug, title },
  pcm: tone(durationSec, 12000),
  sampleRate: SR,
  durationSec,
  segments: [
    { groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: durationSec },
  ],
  cast: [{ id: 'amy', name: 'Amy', gender: 'female' as const, attributes: [] }],
  castIdHistory: { schema: 1 as const, supersededBy: {} },
  defaultEngine: 'kokoro' as const,
  modelKey: 'kokoro-v1' as const,
  audioFormat: 'mp3' as const,
  resynthesizedIndices: 'all' as const,
});

describe('finalizeChapterAudioWrite state.json lock (#3625)', () => {
  it('keeps both stamps when two sibling-chapter finalizes overlap', async () => {
    await Promise.all([
      finalizeChapterAudioWrite(inputFor(1, 'chapter-one', 'Chapter 1', 1.0)),
      finalizeChapterAudioWrite(inputFor(2, 'chapter-two', 'Chapter 2', 2.0)),
    ]);

    const state = JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'));
    for (const id of [1, 2]) {
      const c = state.chapters.find((x: { id: number }) => x.id === id);
      expect(c.duration, `chapter ${id} duration stamp`).not.toBe('0:00');
      expect(c.audioRenderedAt, `chapter ${id} audioRenderedAt`).toBeTruthy();
      expect(c.audioModelKey, `chapter ${id} audioModelKey`).toBe('kokoro-v1');
    }
  }, 30_000);

  it('recovers a torn state.json from .bak.1 and still stamps (#3625 sweep)', async () => {
    gate.secondReadPromise = null; // one finalize: nothing to overlap with
    const statePath = join(bookDir, '.audiobook', 'state.json');
    const full = readFileSync(statePath, 'utf8');
    writeFileSync(`${statePath}.bak.1`, full);
    writeFileSync(statePath, full.slice(0, 40));

    await finalizeChapterAudioWrite(inputFor(1, 'chapter-one', 'Chapter 1', 1.0));

    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const c = state.chapters.find((x: { id: number }) => x.id === 1);
    expect(c.duration).not.toBe('0:00');
    expect(c.audioModelKey).toBe('kokoro-v1');
  }, 30_000);
});
