/* #3400 pass 8 -- a segments heal is read BEFORE it waits for the book lock, and
   its identity match is id + slug + uuid. A merge (without a new title) keeps
   the primary chapter's three, drops its audio fields and deletes its audio.
   The fill therefore has to come from the segments file as it is UNDER the lock
   (gone), not from the copy read before the wait (which still described the old
   take): otherwise the merged chapter is stamped with the old model / render
   date while its audio does not exist. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let paths: typeof import('./paths.js');

const BOOK_ID = 'tester__myseries__heal';
const SLUGS = ['01-chapter-one', '02-chapter-two'];

function stateJson(chapters: object[]): string {
  return JSON.stringify({
    bookId: BOOK_ID,
    manuscriptId: BOOK_ID,
    title: 'Heal',
    author: 'tester',
    series: 'myseries',
    seriesPosition: null,
    isStandalone: false,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters,
    coverGradient: ['#111111', '#222222'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'heal-merge-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  vi.resetModules();
  paths = await import('./paths.js');
  bookDir = join(workspaceRoot, 'books', 'tester', 'myseries', 'heal');
  audioRoot = join(bookDir, 'audio');
  await mkdir(join(bookDir, '.audiobook'), { recursive: true });
  await mkdir(audioRoot, { recursive: true });
  await writeFile(join(bookDir, 'manuscript.txt'), 'chapter one', 'utf8');
  for (const slug of SLUGS) {
    await writeFile(join(audioRoot, `${slug}.mp3`), `audio-${slug}`);
    await writeFile(
      join(audioRoot, `${slug}.segments.json`),
      JSON.stringify({ durationSec: 61, modelKey: 'OLD-MODEL', synthesizedAt: '2020-02-02T00:00:00.000Z', segments: [] }),
    );
  }
});

afterEach(async () => {
  delete process.env.WORKSPACE_DIR;
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('backfillAudioModelKeysFromSegments across a merge', () => {
  it('does not stamp the old take onto a chapter whose audio the merge deleted', async () => {
    const legacy = SLUGS.map((slug, i) => ({ id: i + 1, title: `Chapter ${i + 1}`, slug, uuid: `u${i + 1}` }));
    await writeFile(paths.stateJsonPath(bookDir), stateJson(legacy), 'utf8');
    const preRead = JSON.parse(await readFile(paths.stateJsonPath(bookDir), 'utf8'));

    const { withBookLock } = await import('./book-lock.js');
    const { backfillAudioModelKeysFromSegments } = await import('./scan.js');

    /* The "merge" holds the lock; the heal reads its segments (all present)
       and then queues behind it. */
    let release!: () => void;
    let entered!: () => void;
    const holderIn = new Promise<void>((r) => (entered = r));
    const merge = withBookLock(BOOK_ID, async () => {
      entered();
      await new Promise<void>((r) => (release = r));
      /* what a merge without a new title leaves for chapter 2: same id / slug /
         uuid, audio fields dropped, audio deleted. Chapter 1 is untouched. */
      await writeFile(paths.stateJsonPath(bookDir), stateJson(legacy), 'utf8');
      await rm(join(audioRoot, `${SLUGS[1]}.mp3`), { force: true });
      await rm(join(audioRoot, `${SLUGS[1]}.segments.json`), { force: true });
    });
    await holderIn;
    const heal = backfillAudioModelKeysFromSegments(bookDir, preRead);
    await new Promise((r) => setTimeout(r, 200)); // the heal's unlocked reads are done
    release();
    await merge;
    await heal;

    const final = JSON.parse(await readFile(paths.stateJsonPath(bookDir), 'utf8'));
    /* control: the chapter whose audio survived is healed */
    expect(final.chapters[0].audioModelKey).toBe('OLD-MODEL');
    /* the merged chapter keeps neither the old model nor the old render date */
    expect(final.chapters[1].audioModelKey).toBeUndefined();
    expect(final.chapters[1].audioRenderedAt).toBeUndefined();
  });
});
