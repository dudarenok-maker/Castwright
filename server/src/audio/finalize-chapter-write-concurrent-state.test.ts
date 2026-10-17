/* #3700 — two chapters of one book finalizing at the same time must BOTH land
   their state.json stamp. finalizeChapterAudioWrite's state.json update is a
   read-modify-write; unserialised, the second writer's snapshot was read before
   the first writer landed, so it clobbered the first chapter's stamp (and on
   Windows the read could even hit the rename-over window and throw ENOENT,
   failing the chapter outright). Real ffmpeg encode against a tempdir
   workspace, like the rest of the audio suite. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* Force the interleaving instead of hoping for it: the first state.json read
   parks until a second state.json read is issued (or a short grace elapses).
   Unserialised, both finalizes read the same snapshot -> lost update. With the
   per-book lock the second read cannot start until the first writer has
   landed, so the grace elapses and the first proceeds alone. */
const stateReads = { count: 0, waiters: [] as Array<() => void> };
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    readJson: async (path: string) => {
      const out = await actual.readJson(path);
      if (path.endsWith('state.json')) {
        stateReads.count += 1;
        if (stateReads.count === 1) {
          await new Promise<void>((resolve) => {
            stateReads.waiters.push(resolve);
            setTimeout(resolve, 400);
          });
        } else {
          for (const w of stateReads.waiters.splice(0)) w();
        }
      }
      return out;
    },
  };
});

const AUTHOR = 'Finalize Author';
const SERIES = 'Standalones';
const TITLE = 'Finalize Concurrent Story';
const SR = 24_000;

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
  stateReads.count = 0;
  stateReads.waiters = [];
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-finalize-concurrent-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
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

const input = (id: number, slug: string) => ({
  bookId,
  bookDir,
  chapter: { id, slug, title: `Chapter ${id}` },
  pcm: tone(1.0, 12000),
  sampleRate: SR,
  durationSec: 1.0,
  segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: 1.0 }],
  cast: [{ id: 'amy', name: 'Amy', gender: 'female' as const, attributes: [] }],
  castIdHistory: { schema: 1 as const, supersededBy: {} },
  defaultEngine: 'kokoro' as const,
  modelKey: 'kokoro-v1' as const,
  audioFormat: 'mp3' as const,
  resynthesizedIndices: 'all' as const,
});

describe('finalizeChapterAudioWrite — concurrent siblings (#3700)', () => {
  it('both chapters of one book keep their state.json stamp when finalized concurrently', async () => {
    await Promise.all([
      finalizeChapterAudioWrite(input(1, 'chapter-one')),
      finalizeChapterAudioWrite(input(2, 'chapter-two')),
    ]);
    const { readJson } = await import('../workspace/state-io.js');
    const state = await readJson<{ chapters: Array<Record<string, unknown>> }>(
      join(bookDir, '.audiobook', 'state.json'),
    );
    for (const id of [1, 2]) {
      const ch = state!.chapters.find((c) => c.id === id)!;
      expect(ch.audioRenderedAt, `chapter ${id} stamp lost`).toBeDefined();
      expect(ch.audioModelKey).toBe('kokoro-v1');
    }
  });
});
