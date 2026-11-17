/* #4099 — pinned as UNREACHABLE since R55 (PR #4103, owner ruling 2026-11-12).

   The reported race: a cast merge writes the manuscript-edits.json remap under the `book`
   lock BEFORE it records the retirement (`retireCharacterId`), so an analysis roll queued
   behind it could read the id history too early and write the merged-away id back.

   It cannot happen: the merge's whole span (R55 check, edits remap, cast.json write and the
   retirement) is inside ONE `withBookOp`, and `runBookJob` registers an analysis (and only
   then starts its body, where every roll and `resolveCurrentIds` run) under `withBookOp`.
   So while a merge is mid-remap the run cannot register, and by the time its body starts the
   retirement is on disk.

   The merge is held at a named write, once per case: its first manuscript-edits.json write
   (the START of the #4099 window) and its cast-id-history.json write (the retirement, the END
   of it). The run is started from the test's own async context, NOT from inside the hook (the
   `book` lock is re-entrant per async context, so work started in the hook would inherit the
   merge's held locks). "Parked behind the merge" is asserted only after a macrotask yield,
   because `withKeyLock` counts a waiter synchronously on entry, so an immediate check would
   pass even if nothing held book-op. Ordering is event-driven, not timed, but the negative
   assertions (the run has NOT started) are sampled, not proven.

   Not pinned here: the third leg of the argument, that every production roll runs inside the
   `runBookJob` lease (analysis.ts ~5598/~9301; rolls ~7827/~10245).

   The reverse ordering (run registered first, merge refused) lives in
   cast-identity-busy.test.ts. */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const hooks = vi.hoisted(() => ({
  beforeWrite: undefined as undefined | { file: string; match?: (data: unknown) => boolean; fire: () => Promise<void> },
}));

vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...orig,
    writeJsonAtomic: (async (path: string, ...rest: unknown[]) => {
      const hook = hooks.beforeWrite;
      if (hook && path.endsWith(hook.file) && (!hook.match || hook.match(rest[0]))) {
        hooks.beforeWrite = undefined;
        await hook.fire();
      }
      return (orig.writeJsonAtomic as (...a: unknown[]) => unknown)(path, ...rest);
    }) as typeof orig.writeJsonAtomic,
  };
});

const AUTHOR = 'Roll Race';
const SERIES = 'Standalones';
const TITLE = 'Roll Race Book';
const MANUSCRIPT_ID = 'm_roll_race';
const PRIOR = new Set(['narrator', 'wren', 'marlow']);

let workspaceRoot: string;
let bookDir: string;
let bookId: string;
let app: Express;

const editsPath = () => join(bookDir, '.audiobook', 'manuscript-edits.json');

async function until(cond: () => boolean, timeoutMs = 5000): Promise<void> {
  await vi.waitFor(
    () => {
      if (!cond()) throw new Error('until: condition not met');
    },
    { timeout: timeoutMs, interval: 5 },
  );
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-merge-roll-race-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ castMergeRouter }, { makeBookId }] = await Promise.all([
    import('./cast-merge.js'),
    import('../workspace/paths.js'),
  ]);
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
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
      chapters: [{ id: 1, title: 'One', slug: '01-one', uuid: 'u1' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  app = express();
  app.use(express.json());
  app.use('/api/books', castMergeRouter);
});

/* Re-seed per case: each case's merge rewrites cast.json / the edits and records a retirement. */
beforeEach(() => {
  hooks.beforeWrite = undefined;
  rmSync(join(bookDir, '.audiobook', 'cast-id-history.json'), { force: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({
      characters: [
        { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator', lines: 0, scenes: 1 },
        { id: 'wren', name: 'Wren', role: 'lead', color: 'eliza', lines: 2, scenes: 1 },
        { id: 'marlow', name: 'Marlow Halden', role: 'sidekick', color: 'halloran', lines: 1, scenes: 1 },
      ],
    }),
  );
  writeFileSync(
    editsPath(),
    JSON.stringify({
      sentences: [
        { id: 1, chapterId: 1, characterId: 'wren', text: 'Hello.' },
        { id: 2, chapterId: 1, characterId: 'wren', text: 'Where am I?' },
        { id: 3, chapterId: 1, characterId: 'marlow', text: 'Whoa there.' },
      ],
    }),
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

/* The retirement's write is the cast-id-history.json write that records wren -> marlow; other
   writes to that file (e.g. suggestion pruning) must not trip the hold. */
const isRetirementWrite = (data: unknown) =>
  (data as { supersededBy?: Record<string, string> } | undefined)?.supersededBy?.wren === 'marlow';
const HOLDS: ReadonlyArray<readonly [string, string, ((data: unknown) => boolean) | undefined]> = [
  ['its manuscript-edits.json remap', 'manuscript-edits.json', undefined],
  ['its cast-id-history.json retirement', 'cast-id-history.json', isRetirementWrite],
];

describe('cast merge vs an analysis registering mid-merge (#4099, unreachable since R55)', () => {
  for (const [label, holdFile, match] of HOLDS) {
    it(
      `the run cannot register until the merge has landed, retirement included (merge held at ${label})`,
      { retry: 0 },
      async () => {
        const [{ runBookJob, bookJobKinds }, fileLock, { loadCastIdHistoryWithStatus }, { resolveCurrentIds }, { rollManuscriptEdits }] =
          await Promise.all([
            import('../workspace/book-jobs.js'),
            import('../workspace/file-lock.js'),
            import('../store/cast-id-history.js'),
            import('./analysis.js'),
            import('../workspace/edits-roll.js'),
          ]);

        let paused!: () => void;
        const pausedP = new Promise<void>((r) => (paused = r));
        let release!: () => void;
        const releaseP = new Promise<void>((r) => (release = r));
        hooks.beforeWrite = {
          file: holdFile,
          match,
          fire: async () => {
            paused();
            await releaseP;
          },
        };

        let mergeAnswered = false;
        const mergeP = request(app)
          .post(`/api/books/${bookId}/cast/merge`)
          .send({ sourceId: 'wren', targetId: 'marlow' })
          .then((r) => {
            mergeAnswered = true;
            return r;
          });

        let ran = false;
        let supersededInside: string | undefined;
        let resolvedId: string | undefined;
        let regP!: ReturnType<typeof runBookJob>;
        try {
          // A merge that answers before reaching the held write fails here, not as a timeout.
          await Promise.race([
            pausedP,
            mergeP.then((r) => {
              throw new Error(`merge answered ${r.status} before reaching its ${holdFile} write`);
            }),
          ]);

          regP = runBookJob(bookId, 'analysis', async (lease) => {
            ran = true;
            const history = await loadCastIdHistoryWithStatus(lease.bookDir);
            supersededInside = history.history.supersededBy.wren;
            const [res] = await resolveCurrentIds(
              lease.bookDir,
              {},
              [{ id: 9, chapterId: 1, characterId: 'wren', text: 'x' }],
              PRIOR,
              undefined,
              new Set(),
            );
            resolvedId = res?.characterId;
            await rollManuscriptEdits(
              { manuscriptId: MANUSCRIPT_ID, candidateBookDir: lease.bookDir, mode: 'drop' },
              () => ({
                sentences: [
                  { id: 1, chapterId: 1, characterId: 'wren', text: 'Hello.' },
                  { id: 2, chapterId: 1, characterId: 'wren', text: 'Where am I?' },
                  { id: 3, chapterId: 1, characterId: 'marlow', text: 'Whoa there.' },
                ],
                chapterIds: [1],
              }),
              bookId,
              (s) => resolveCurrentIds(lease.bookDir, {}, s, PRIOR, undefined, new Set()),
            );
          });

          // The run is parked on book-op behind the paused merge. `withKeyLock` bumps its waiter
          // count synchronously on entry, so yield a macrotask and re-assert: these only hold if
          // the merge really holds book-op.
          await until(() => fileLock.__keyWaitersForTest(`book-op:${bookId}`) >= 1);
          await new Promise<void>((r) => setImmediate(r));
          // Bounded negative race: a merge that does NOT hold its write (a retirement left
          // un-awaited, say) finishes its remaining steps within this window and answers, and
          // the run then starts. Held, neither happens.
          await Promise.race([mergeP, new Promise<void>((r) => setTimeout(r, 300))]);
          expect(fileLock.__keyWaitersForTest(`book-op:${bookId}`)).toBeGreaterThanOrEqual(1); // R1w
          expect(mergeAnswered).toBe(false); // R1m
          expect(ran).toBe(false); // R1a
          expect(bookJobKinds(bookId)).not.toContain('analysis'); // R1b
        } finally {
          release();
        }

        const mergeRes = await mergeP;
        expect(mergeRes.status).toBe(200);
        const reg = await regP;
        if (typeof reg !== 'object' || reg === null || !('done' in reg)) throw new Error('run did not register');
        await reg.done;

        expect(ran).toBe(true);
        expect(supersededInside).toBe('marlow'); // R2a
        expect(resolvedId).toBe('marlow'); // R2b
        const sentences = JSON.parse(readFileSync(editsPath(), 'utf8')).sentences as Array<{ characterId: string; chapterId: number }>;
        expect(sentences.some((s) => s.characterId === 'wren')).toBe(false); // R3
        expect(sentences.filter((s) => s.chapterId === 1)).toHaveLength(3);
      },
    );
  }
});
