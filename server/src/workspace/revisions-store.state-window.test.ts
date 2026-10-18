/* #3400 pass 11 (🟠1) - `readLiveChapters` read state.json without recovery.

   Since #3625 `writeJsonAtomic` renames main to `.bak.1` BEFORE it renames the
   new file in, so for that window `.audiobook/state.json` is absent. A plain
   read saw "no state", returned [], and `loadWithStored` dropped a sibling
   chapter's pending A/B entry (the loss e36011dc exists to prevent); the next
   write persisted the drop. The read now goes through the recovering one.

   Adapted from e36011dc's "stale caller snapshot" test: state.json carries the
   sibling's fresh render, the caller's snapshot is stale. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const hold = vi.hoisted(() => ({
  /** When set, a rename onto this path waits for `release` first. */
  dest: null as string | null,
  reached: null as null | (() => void),
  release: null as Promise<void> | null,
}));

vi.mock('./atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-rename.js')>();
  return {
    ...actual,
    renameWithRetry: async (src: string, dest: string) => {
      if (hold.dest && dest === hold.dest && src.includes('.tmp-')) {
        hold.reached?.();
        await hold.release;
      }
      return actual.renameWithRetry(src, dest);
    },
  };
});

import { recordPending, type ChapterRef, type StoredRevision } from './revisions-store.js';
import { writeStateJsonAtomic } from './state-migrate.js';
import { revisionsJsonPath, audioDir, stateJsonPath } from './paths.js';

let bookDir: string;

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'revisions-window-'));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audioDir(bookDir), { recursive: true });
});
afterEach(() => {
  hold.dest = null;
  rmSync(bookDir, { recursive: true, force: true });
});

const entry = (chapterId: number, id: string): StoredRevision => ({
  id,
  chapterId,
  characterId: 'narrator',
  triggeredBy: 'Narrator voice change',
  triggeredAgo: 'just now',
  oldDuration: '00:10',
  newDuration: '00:11',
  confidence: 1,
  playable: true,
  hasPreviousAudio: true,
  segments: [],
  origin: 'server',
});
const sibling = (): StoredRevision => ({ ...entry(2, 'r-sib'), chapterUuid: 'u2', renderedAt: 't2-new' });
const staleSnapshot = (): ChapterRef[] => [
  { id: 1, slug: '01-one', uuid: 'u1', audioRenderedAt: 't1' },
  { id: 2, slug: '02-two', uuid: 'u2', audioRenderedAt: 't2-old' },
];
const freshState = () => ({
  chapters: [
    { id: 1, slug: '01-one', uuid: 'u1', audioRenderedAt: 't1' },
    { id: 2, slug: '02-two', uuid: 'u2', audioRenderedAt: 't2-new' },
  ],
});
const seed = () => {
  writeFileSync(stateJsonPath(bookDir), JSON.stringify(freshState()));
  writeFileSync(
    revisionsJsonPath(bookDir),
    JSON.stringify({ schema: 1, fileId: null, rev: 0, pending: [sibling()], dismissed: [], acceptedSelections: {}, timeline: {} }),
  );
};
const ids = () =>
  (JSON.parse(readFileSync(revisionsJsonPath(bookDir), 'utf8')).pending as { id: string }[]).map((p) => p.id).sort();
const record = () => recordPending(bookDir, staleSnapshot(), { ...entry(1, 'r-one'), chapterUuid: 'u1', renderedAt: 't1' });

describe("a state.json read inside a rotating write's rename window keeps a sibling's entry", () => {
  it('(a) main moved to .bak.1, only the backup present', async () => {
    seed();
    renameSync(stateJsonPath(bookDir), `${stateJsonPath(bookDir)}.bak.1`);
    expect(existsSync(stateJsonPath(bookDir)), 'precondition: main is absent').toBe(false);
    await record();
    expect(ids()).toEqual(['r-one', 'r-sib']);
  });

  it('(b) an unrelated writeStateJsonAtomic held between its two renames', async () => {
    seed();
    const statePath = stateJsonPath(bookDir);
    let release!: () => void;
    hold.release = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (hold.reached = r));
    hold.dest = statePath;
    let write: Promise<void> | undefined;
    try {
      write = writeStateJsonAtomic(statePath, { ...freshState(), updatedAt: '2026-10-02T00:00:00.000Z' } as never);
      await reached;
      expect(existsSync(statePath), 'precondition: main is absent mid-write').toBe(false);
      await record();
    } finally {
      hold.dest = null;
      release();
      await write;
    }
    expect(ids()).toEqual(['r-one', 'r-sib']);
  });
});
