/* #2260 review round 3, C2 — WHERE `performCastMerge`'s lock-timeout rethrow
 * happens, driven against a real book on disk.
 *
 * Round 2 made the `catch (historyErr)` around `retireCharacterId` rethrow a
 * `LockAcquisitionTimeoutError` instead of swallowing it. Right class, wrong
 * place: thrown at that point it aborts BEFORE the analysis-cache
 * reconciliation and the `cast-merges` journal entry that follow it — which
 * recreates precisely the half-applied state the wrap at the top of that block
 * exists to prevent. cast.json has `sourceId` folded into `targetId`, but the
 * cache still lists `sourceId` and still attributes sentences to it, so the
 * merged-away character reappears the moment the user resumes (the cache
 * comment in the route says exactly this), and no journal entry exists, so the
 * unlink-alias route can never undo the merge.
 *
 * The fix parks the timeout and rethrows after BOTH. This file pins that: the
 * call still rejects with the same error object (loud), AND the cache and the
 * journal both reflect the merge (whole). Neither assertion alone would
 * distinguish the fix from the bug.
 *
 * The disk-fault direction is pinned alongside it — the two-directional shape
 * `store/not-linked-edges.lock-timeout.test.ts` established. An EPERM out of
 * the same call is still swallowed, still warns, and the merge still resolves.
 *
 * `retireCharacterId` is mocked rather than the lock genuinely contended: the
 * real budget is 10s and vitest's testTimeout is 15s. The mock throws the REAL
 * error class; that the real mutex throws it on expiry is pinned in
 * `workspace/file-lock.test.ts`.
 */

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const retire = vi.hoisted(() => ({ toThrow: null as unknown }));

vi.mock('../store/cast-id-history.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/cast-id-history.js')>();
  return {
    ...actual,
    retireCharacterId: async (bookDir: string, from: string, to: string) => {
      if (retire.toThrow) throw retire.toThrow;
      return actual.retireCharacterId(bookDir, from, to);
    },
  };
});

const AUTHOR = 'Test Author';
const SERIES = 'Standalones';
const TITLE = 'Cast Merge Lock Timeout Book';
const MANUSCRIPT_ID = 'm_merge_lock_timeout_test';

const SOURCE_ID = 'wren';
const TARGET_ID = 'wren-sparrow';

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let cachePath: string;
let performCastMerge: typeof import('./cast-merge.js').performCastMerge;

const characters = [
  { id: TARGET_ID, name: 'Wren Sparrow', role: 'protagonist', color: 'eliza', lines: 12, scenes: 4 },
  { id: SOURCE_ID, name: 'Wren', role: 'protagonist', color: 'eliza', lines: 5, scenes: 2 },
];

const sentences = [
  { id: 1, chapterId: 1, characterId: SOURCE_ID, text: 'Hello world.' },
  { id: 2, chapterId: 1, characterId: TARGET_ID, text: 'Take me with you.' },
];

interface StateJson {
  manuscriptId: string;
}

function seedDisk(): void {
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: MANUSCRIPT_ID,
      title: TITLE,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'One', slug: '01-one' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(join(bookDir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  writeFileSync(join(bookDir, '.audiobook', 'manuscript-edits.json'), JSON.stringify({ sentences }));
  rmSync(join(bookDir, '.audiobook', 'cast-merges.json'), { force: true });
  rmSync(join(bookDir, '.audiobook', 'cast-id-history.json'), { force: true });

  writeFileSync(
    cachePath,
    JSON.stringify({
      stage1: { characters, chapters: [{ id: 1, title: 'One' }] },
      chapters: { 1: sentences },
      updatedAt: new Date().toISOString(),
    }),
  );
}

/** The cache after the merge — the file the route replays on resume. */
function readCache(): {
  stage1?: { characters?: Array<{ id: string }> };
  chapters?: Record<string, Array<{ characterId?: string }>>;
} {
  return JSON.parse(readFileSync(cachePath, 'utf8'));
}

/** The `cast-merges` journal — what the unlink-alias route reads to undo. */
function readJournal(): { entries?: Array<{ sourceId?: string; targetId?: string }> } | null {
  const path = join(bookDir, '.audiobook', 'cast-merges.json');
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, 'utf8'));
}

function runMerge(): Promise<unknown> {
  const state = JSON.parse(
    readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8'),
  ) as StateJson;
  return performCastMerge({
    bookId,
    bookDir,
    state: state as never,
    sourceId: SOURCE_ID,
    targetId: TARGET_ID,
  });
}

/** Every fact that says "the merge is fully applied on disk". Asserted
 *  identically on BOTH sides of the discrimination — the whole point of the
 *  fix is that the disk outcome is the same either way and only the RETURN
 *  differs. */
function expectMergeFullyApplied(): void {
  const cast = JSON.parse(
    readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
  ) as { characters: Array<{ id: string }> };
  expect(cast.characters.map((c) => c.id)).not.toContain(SOURCE_ID);

  /* The cache reconciliation (route lines after the retirement block): the
     source is gone from stage1 AND its sentences are re-attributed. Skipping
     this is what makes the merged-away character reappear on resume. */
  const cache = readCache();
  expect((cache.stage1?.characters ?? []).map((c) => c.id)).not.toContain(SOURCE_ID);
  expect((cache.chapters?.['1'] ?? []).some((s) => s.characterId === SOURCE_ID)).toBe(false);

  /* The journal entry — without it the merge can never be unlinked. */
  const journal = readJournal();
  expect(journal).not.toBeNull();
  expect(
    (journal!.entries ?? []).some((e) => e.sourceId === SOURCE_ID && e.targetId === TARGET_ID),
  ).toBe(true);
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-merge-lock-timeout-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [castMerge, { makeBookId }] = await Promise.all([
    import('./cast-merge.js'),
    import('../workspace/paths.js'),
  ]);
  performCastMerge = castMerge.performCastMerge;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  /* Same fixed-relative cache path cast-merge.test.ts computes. */
  const testFileDir = dirname(fileURLToPath(import.meta.url));
  cachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
});

beforeEach(() => {
  retire.toThrow = null;
  seedDisk();
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
  if (cachePath) rmSync(cachePath, { force: true });
});

describe('performCastMerge — lock timeout vs disk fault (#2260 C2)', () => {
  it('a lock timeout REJECTS the merge but only after the cache and journal are written', async () => {
    const timeout = await import('../workspace/file-lock.js').then(
      (m) => new m.LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000),
    );
    retire.toThrow = timeout;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    /* Loud: the SAME object, so a caller above can discriminate on it too. */
    await expect(runMerge()).rejects.toBe(timeout);
    /* Not warned — a warning would mean it was still treated as best-effort. */
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('[cast-merge]'))).toHaveLength(0);

    /* And whole: this is the half round 2 broke. Every one of these was
       skipped when the rethrow fired at the retirement site. */
    expectMergeFullyApplied();
  });

  it('an EPERM-shaped disk fault is STILL swallowed — the merge resolves and disk is identical', async () => {
    retire.toThrow = Object.assign(
      new Error("EPERM: operation not permitted, rename 'cast-id-history.json'"),
      { code: 'EPERM' },
    );
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});

    const result = (await runMerge()) as { sourceId: string };
    expect(result.sourceId).toBe(SOURCE_ID);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('failed to record character-id retirement')),
    ).toBe(true);

    /* Identical disk outcome to the timeout case above — the discrimination
       is about the RETURN, not about what got written. */
    expectMergeFullyApplied();
  });
});
