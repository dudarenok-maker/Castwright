/* Plan 290 (#3837, round 10) — a backup restore is the third producer of the
   stale-evidence marker `sentencesPredateChapters`. A restore swaps state.json
   only; manuscript-edits.json stays. So the restored state is marked when the
   local edits hold sentences (or cannot be read) AND the snapshot's chapter
   list (ids + titles, in order) differs from the book's current one, or the
   current state is already marked. The snapshot's own marker is never carried.

   Same temp-workspace harness as auto-backup.test.ts. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let mod: typeof import('./auto-backup.js');
let paths: typeof import('./paths.js');

type Chapter = { id: number; title: string; slug: string };
const CHAPTERS: Chapter[] = [
  { id: 1, title: 'One', slug: '01-one' },
  { id: 2, title: 'Two', slug: '02-two' },
  { id: 3, title: 'Three', slug: '03-three' },
];
const EDITS = JSON.stringify({ sentences: [{ id: 1, chapterId: 1, characterId: 'narr', text: 'A saved sentence.' }] });

function makeState(bookId: string, extra: object): Record<string, unknown> {
  return {
    bookId,
    manuscriptId: bookId,
    title: 'Test Book',
    author: 'tester',
    series: 'myseries',
    seriesPosition: null,
    isStandalone: false,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: CHAPTERS,
    coverGradient: ['#111111', '#222222'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'backup-stale-evidence-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  vi.resetModules();
  paths = await import('./paths.js');
  mod = await import('./auto-backup.js');
});

afterEach(async () => {
  delete process.env.WORKSPACE_DIR;
  await rm(workspaceRoot, { recursive: true, force: true });
});

/** Snapshot a book whose state is `snapshot`, then make its live state `current`
    (and its edits `edits`), then restore the snapshot. Returns the restored state. */
async function restoreOnto(
  name: string,
  snapshot: object,
  current: object,
  edits: string | null,
): Promise<Record<string, unknown>> {
  const bookId = `tester__myseries__${name}`;
  const bookDir = join(workspaceRoot, 'books', 'tester', 'myseries', name);
  await mkdir(join(bookDir, '.audiobook'), { recursive: true });
  await writeFile(join(bookDir, 'manuscript.txt'), 'chapter one', 'utf8');
  await writeFile(paths.stateJsonPath(bookDir), JSON.stringify(makeState(bookId, snapshot)), 'utf8');
  const file = await mod.backupBook({ bookId, bookDir }, { keep: 5, now: new Date(2026, 0, 1, 9, 0, 0) });
  await writeFile(paths.stateJsonPath(bookDir), JSON.stringify(makeState(bookId, current)), 'utf8');
  if (edits !== null) await writeFile(paths.manuscriptEditsJsonPath(bookDir), edits, 'utf8');
  await mod.restoreBackup(bookId, file!);
  const after = JSON.parse(await readFile(paths.stateJsonPath(bookDir), 'utf8')) as Record<string, unknown>;
  if (edits !== null) {
    /* A restore never touches the edits file. */
    expect(await readFile(paths.manuscriptEditsJsonPath(bookDir), 'utf8')).toBe(edits);
  }
  return after;
}

const retitled = CHAPTERS.map((c) => (c.id === 2 ? { ...c, title: 'Two (merged)' } : c));
const renumbered = CHAPTERS.map((c) => (c.id === 3 ? { ...c, id: 4 } : c));
const shorter = CHAPTERS.slice(0, 2);

describe('restoreBackup — stale-evidence marker (plan 290, round 10)', () => {
  it('same chapters + saved sentences: no marker', async () => {
    const after = await restoreOnto('same', { v: 'snap' }, { v: 'live' }, EDITS);
    expect(after.v).toBe('snap');
    expect(after).not.toHaveProperty('sentencesPredateChapters');
  });

  it.each([
    ['a title', 'title', retitled],
    ['an id', 'id', renumbered],
    ['the count', 'count', shorter],
  ] as const)('chapters differing in %s + saved sentences: marker', async (_l, tag, liveChapters) => {
    const after = await restoreOnto(`differs-${tag}`, {}, { chapters: liveChapters }, EDITS);
    expect(after.chapters).toEqual(CHAPTERS);
    expect(after.sentencesPredateChapters).toBe(true);
  });

  it('a corrupt edits file counts as stale when the chapters differ', async () => {
    const after = await restoreOnto('corrupt', {}, { chapters: retitled }, '{ not json');
    expect(after.sentencesPredateChapters).toBe(true);
  });

  it('same chapters, the current state already marked + saved sentences: marker', async () => {
    const after = await restoreOnto('marked', {}, { sentencesPredateChapters: true }, EDITS);
    expect(after.sentencesPredateChapters).toBe(true);
  });

  it("a snapshot carrying the marker onto the same chapters: the snapshot's marker is not carried", async () => {
    const after = await restoreOnto('snap-marked', { sentencesPredateChapters: true }, {}, EDITS);
    expect(after).not.toHaveProperty('sentencesPredateChapters');
  });

  it('no saved sentences: no marker even when the chapters differ', async () => {
    expect(await restoreOnto('absent', {}, { chapters: retitled }, null)).not.toHaveProperty('sentencesPredateChapters');
    expect(
      await restoreOnto('empty', {}, { chapters: retitled }, JSON.stringify({ sentences: [] })),
    ).not.toHaveProperty('sentencesPredateChapters');
  });
});
