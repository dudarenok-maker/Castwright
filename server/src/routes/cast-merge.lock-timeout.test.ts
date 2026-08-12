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
import express, { type Express } from 'express';
import request from 'supertest';

const retire = vi.hoisted(() => ({ toThrow: null as unknown }));

/* #2292 — a seam for a NON-lock failure that genuinely escapes
   `performCastMerge`. `retire.toThrow` cannot serve for that: an EPERM there
   is swallowed by design. `loadAnalysisCache` runs inside the merge with no
   handler of its own, so a throw there escapes exactly as a cast.json EACCES
   would. */
const cacheLoad = vi.hoisted(() => ({ toThrow: null as unknown }));

vi.mock('../store/analysis-cache.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../store/analysis-cache.js')>();
  return {
    ...actual,
    loadAnalysisCache: async (...args: Parameters<typeof actual.loadAnalysisCache>) => {
      if (cacheLoad.toThrow) throw cacheLoad.toThrow;
      return actual.loadAnalysisCache(...args);
    },
  };
});

/* #2260 FINAL ROUND (B1) — the OTHER origin of a `LockAcquisitionTimeoutError`
   out of `performCastMerge`, and the one no fixture in this file reached:
   `performCastMerge`'s whole body is `withCastLock(bookDir, …)`, so the OUTER
   acquisition can expire before the callback runs at all. Every timeout fixture
   above injects at `retire.toThrow`, which is INSIDE that callback and
   therefore only ever produces the merge-landed state — so the accept route's
   "dismiss on the error class" branch was only ever measured against the half
   of its input where dismissing is correct.

   The mock reproduces the real expiry exactly: `fn` is NEVER called (that is
   `withKeyLock`'s own hard rule — falling through to `fn()` on expiry would run
   the critical section unlocked), so nothing is read and nothing is written.
   Mocked rather than genuinely contended for the same reason the header gives
   for `retire`: the real budget is 10s and vitest's testTimeout is 15s. */
const outerLock = vi.hoisted(() => ({ toThrow: null as unknown }));

vi.mock('../workspace/cast-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/cast-lock.js')>();
  return {
    ...actual,
    withCastLock: async <T>(bookDir: string, fn: () => Promise<T>): Promise<T> => {
      if (outerLock.toThrow) throw outerLock.toThrow;
      return actual.withCastLock(bookDir, fn);
    },
  };
});

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
let suggestionsApp: Express;
let mergeApp: Express;
let LockAcquisitionTimeoutError: typeof import('../workspace/file-lock.js').LockAcquisitionTimeoutError;
/* The curated body both routes now return for this class — asserted by value
   rather than by phrase, so a reword has to move the constant and the
   assertion together and cannot silently reintroduce `err.message`. */
let LOCK_CONTENTION_REQUEST_ERROR: string;

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
    join(bookDir, '.audiobook', 'cast-merge-suggestions.json'),
    JSON.stringify({
      suggestions: [{ sourceId: SOURCE_ID, targetId: TARGET_ID, reason: 'diminutive' }],
    }),
  );

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

  const [castMerge, { makeBookId }, suggestionsRoute, fileLock] = await Promise.all([
    import('./cast-merge.js'),
    import('../workspace/paths.js'),
    import('./cast-merge-suggestions.js'),
    import('../workspace/file-lock.js'),
  ]);
  performCastMerge = castMerge.performCastMerge;
  LockAcquisitionTimeoutError = fileLock.LockAcquisitionTimeoutError;
  LOCK_CONTENTION_REQUEST_ERROR = fileLock.LOCK_CONTENTION_REQUEST_ERROR;
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);

  suggestionsApp = express();
  suggestionsApp.use(express.json());
  suggestionsApp.use('/api/books', suggestionsRoute.castMergeSuggestionsRouter);

  mergeApp = express();
  mergeApp.use(express.json());
  mergeApp.use('/api/books', castMerge.castMergeRouter);

  /* Same fixed-relative cache path cast-merge.test.ts computes. */
  const testFileDir = dirname(fileURLToPath(import.meta.url));
  cachePath = resolve(testFileDir, '..', '..', 'handoff', 'cache', `${MANUSCRIPT_ID}.json`);
  mkdirSync(dirname(cachePath), { recursive: true });
});

beforeEach(() => {
  retire.toThrow = null;
  cacheLoad.toThrow = null;
  outerLock.toThrow = null;
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

/* #2260 round 4 (C1) — `performCastMerge` has TWO production callers, and the
 * deferred rethrow above is only half a fix if the SECOND one's own follow-up
 * write is skipped on the way out.
 *
 * `POST /:bookId/cast/merge-suggestions/accept` does
 * `try { performCastMerge() } catch (err) { …; throw err }` and then
 * `await dismissSuggestion(...)`. The round-3 rethrow fires with the merge
 * FULLY APPLIED — so the dismiss is skipped for a merge that landed,
 * `loadSuggestions` does no roster filtering, and the suggestion survives
 * naming a character that is no longer in cast.json. Pressing Accept again
 * then 404s on `performCastMerge`'s own `if (!source)` guard and skips the
 * dismiss AGAIN: stuck until the user hits Dismiss or re-analyses.
 *
 * Two-directional, like every other pair in this file: the timeout dismisses,
 * a genuine merge FAILURE must not (its suggestion is still valid, and
 * dismissing it would silently discard a real one).
 */
describe('POST merge-suggestions/accept — a deferred timeout still dismisses (#2260 C1)', () => {
  function callAccept(source = SOURCE_ID, target = TARGET_ID) {
    return request(suggestionsApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: source, targetId: target });
  }

  function readSuggestions(): Array<{ sourceId: string; targetId: string }> {
    const path = join(bookDir, '.audiobook', 'cast-merge-suggestions.json');
    if (!existsSync(path)) return [];
    return (JSON.parse(readFileSync(path, 'utf8')) as { suggestions?: Array<{ sourceId: string; targetId: string }> })
      .suggestions ?? [];
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('the accept flow drops the suggestion even though the merge rejects with a lock timeout', async () => {
    retire.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);

    const res = await callAccept();
    /* Still loud — dismissing must not turn the timeout into a 200. */
    expect(res.status).toBe(500);

    /* The merge really did land, which is WHY dismissing is correct here. */
    expectMergeFullyApplied();

    /* The half the deferred rethrow skipped. Without the fix this is still
       [{wren -> wren-sparrow}] — a suggestion for a character no longer in
       cast.json. */
    expect(readSuggestions()).toHaveLength(0);
  });

  it('a second Accept is no longer possible — without the dismiss it 404s forever', async () => {
    retire.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);
    await callAccept();

    /* The stuck loop, if the dismiss had been skipped: sourceId is gone from
       cast.json, so `performCastMerge` 404s and the dismiss is skipped again.
       That 404 still happens — the merge genuinely cannot be repeated — but it
       no longer leaves anything behind for the user to press. */
    const second = await callAccept();
    expect(second.status).toBe(404);
    expect(readSuggestions()).toHaveLength(0);
  });

  it('a merge that genuinely FAILED keeps its suggestion', async () => {
    /* An unknown sourceId — `performCastMerge` throws its `{status:404,error}`
       shape before writing anything. Dismissing here would silently discard a
       still-valid suggestion, so the discrimination has to be on the error
       class, not on "the merge threw". */
    const res = await callAccept('no-such-id', TARGET_ID);
    expect(res.status).toBe(404);
    expect(readSuggestions()).toHaveLength(1);

    /* And an EPERM out of the retirement — swallowed by `performCastMerge`, so
       this is the ordinary success path and the dismiss runs as it always
       has. Pinned here so the new branch can't be mistaken for the only route
       to a dismissed suggestion. */
    retire.toThrow = Object.assign(
      new Error("EPERM: operation not permitted, rename 'cast-id-history.json'"),
      { code: 'EPERM' },
    );
    const ok = await callAccept();
    expect(ok.status).toBe(200);
    expect(readSuggestions()).toHaveLength(0);
  });
});

/* #2260 FINAL ROUND (B1) — the origin the describe above never reached, and
 * the bug that hid behind the gap.
 *
 * THE GAP. Every accept-route timeout fixture above injects at
 * `retire.toThrow`, i.e. inside `performCastMerge`'s `withCastLock` callback,
 * after cast.json is written. That is the merge-LANDED state and the only one
 * they measure. `performCastMerge` is itself `withCastLock(bookDir, …)`, so the
 * SAME error class also escapes it from the OUTER acquisition, where the
 * callback never ran and nothing whatsoever was written.
 *
 * THE BUG. Round 4's accept route discriminated on `isLockAcquisitionTimeout`
 * alone, and its own comment stated the assumption out loud ("Dismissing here
 * is correct precisely BECAUSE the merge landed"). True of one origin, false of
 * the other. `dismissSuggestion` is a plain load-filter-`writeJsonAtomic`, so
 * contention on `cast:<bookDir>` — the exact condition #2260 exists to surface
 * — meant: user presses Accept, the outer lock expires at 10s, NOTHING is
 * written, the suggestion is dismissed anyway, and the curated body tells them
 * to "reload to see whether the change landed, and retry if it did not". They
 * reload: it did not land, and there is nothing left to retry. Only a manual
 * merge or a re-analysis recovers it.
 *
 * THE SHAPE OF THE FIX, and what these fixtures pin: `performCastMerge` stamps
 * a marker on the parked error at the deferred rethrow and nowhere else, and
 * the route requires the MARKER, not the class. So the pair below asserts the
 * two origins produce opposite suggestion outcomes while producing the SAME
 * curated 500 — the discrimination is about which write is owed, not about what
 * the user is told.
 */
describe('merge routes — an OUTER cast-lock timeout wrote nothing (#2260 final round, B1)', () => {
  function readSuggestions(): Array<{ sourceId: string; targetId: string }> {
    const path = join(bookDir, '.audiobook', 'cast-merge-suggestions.json');
    if (!existsSync(path)) return [];
    return (
      (JSON.parse(readFileSync(path, 'utf8')) as {
        suggestions?: Array<{ sourceId: string; targetId: string }>;
      }).suggestions ?? []
    );
  }

  /** The inverse of `expectMergeFullyApplied` — every fact that says the merge
   *  never happened. The outer acquisition throws before the first `readJson`,
   *  so disk is byte-for-byte the seed. */
  function expectMergeNeverHappened(): void {
    const cast = JSON.parse(
      readFileSync(join(bookDir, '.audiobook', 'cast.json'), 'utf8'),
    ) as { characters: Array<{ id: string }> };
    expect(cast.characters.map((c) => c.id)).toContain(SOURCE_ID);
    expect((readCache().stage1?.characters ?? []).map((c) => c.id)).toContain(SOURCE_ID);
    expect(readJournal()).toBeNull();
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('POST merge-suggestions/accept — the suggestion SURVIVES, because the merge never ran', async () => {
    outerLock.toThrow = new LockAcquisitionTimeoutError(
      join(bookDir, '.audiobook', 'cast.json'),
      10_000,
    );

    const res = await request(suggestionsApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    /* Same curated 500 the deferred case gets — the user-facing half does not
       discriminate, and must not start to. */
    expect(res.status).toBe(500);
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(res.body.error).not.toContain(bookDir);

    /* Nothing was written... */
    expectMergeNeverHappened();
    /* ...INCLUDING the dismiss. This is the assertion the bug reddens: with the
       round-4 class-only branch the file comes back empty here, and the user is
       told to retry something that no longer exists. */
    expect(readSuggestions()).toHaveLength(1);
  });

  it('POST merge-suggestions/accept — a second Accept therefore still works', async () => {
    outerLock.toThrow = new LockAcquisitionTimeoutError(
      join(bookDir, '.audiobook', 'cast.json'),
      10_000,
    );
    const first = await request(suggestionsApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });
    expect(first.status).toBe(500);
    /* The precondition for a retry existing at all — asserted HERE too, not
       only in the test above, so this fixture is a discriminator rather than a
       narration of the happy path: with the class-only branch the file is
       already empty at this point and the rest of this test is vacuous. */
    expect(readSuggestions()).toHaveLength(1);

    /* The contention clears — the point of "retry if it did not". Without the
       surviving suggestion there is no button to press, which is why the
       assertion above is about the FILE and not only about the response. */
    outerLock.toThrow = null;
    const second = await request(suggestionsApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expect(second.status).toBe(200);
    expectMergeFullyApplied();
    expect(readSuggestions()).toHaveLength(0);
  });

  it('POST /cast/merge — the same origin curates identically and writes nothing', async () => {
    outerLock.toThrow = new LockAcquisitionTimeoutError(
      join(bookDir, '.audiobook', 'cast.json'),
      10_000,
    );

    const res = await request(mergeApp)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expect(res.status).toBe(500);
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    /* The key here IS the absolute cast.json path (that is literally what
       `withCastLock` keys on), so the no-leak bar is at its most load-bearing
       on this origin. */
    expect(res.body.error).not.toContain(bookDir);
    expect(res.body.error).not.toContain('withKeyLock');
    expectMergeNeverHappened();
  });

  it('the marker is not something any other escape carries', async () => {
    /* The fail-closed direction, asserted directly on `performCastMerge`
       rather than through a route: only the DEFERRED rethrow is marked, so a
       future caller that gains a follow-up write cannot be fooled by an outer
       expiry, and the two cases stay distinguishable even if both routes are
       rewritten. */
    const { didCastMergeApply } = await import('./cast-merge.js');
    const { isLockAcquisitionTimeout } = await import('../workspace/file-lock.js');

    outerLock.toThrow = new LockAcquisitionTimeoutError(
      join(bookDir, '.audiobook', 'cast.json'),
      10_000,
    );
    let outerErr: unknown = null;
    await runMerge().catch((e: unknown) => {
      outerErr = e;
    });
    expect(isLockAcquisitionTimeout(outerErr)).toBe(true);
    expect(didCastMergeApply(outerErr)).toBe(false);

    outerLock.toThrow = null;
    retire.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);
    let deferredErr: unknown = null;
    await runMerge().catch((e: unknown) => {
      deferredErr = e;
    });
    expect(isLockAcquisitionTimeout(deferredErr)).toBe(true);
    expect(didCastMergeApply(deferredErr)).toBe(true);
  });
});

/* #2292 (owner decision), REWRITTEN in review round 5 — the ROUTE-level body
 * of a merge failure, and specifically what must NOT be in it.
 *
 * WHAT ROUND 4 GOT WRONG. These fixtures were written to prove that a bare
 * `throw err` came back as `500 text/html` from Express 5's default handler,
 * and that the fix made it JSON. The premise was false: `app.ts:350` registers
 * `errorHandler` (`error-handler.ts`) last, and it answers
 * `500 {"error":"Internal server error."}`. Production has never served an
 * HTML error page from these routes. The `text/html` these fixtures observed
 * came from the fixtures THEMSELVES — `express()` + `express.json()` + the
 * router, with no `errorHandler` — so the mutation proofs measured the harness
 * and not the code under test. The `describe` below closes that gap by
 * driving the same two routes through the REAL assembled app.
 *
 * WHAT THAT MADE THE FIX. Not html→json but
 * `{"error":"Internal server error."}` → `{"error": err.message}` — and for
 * the class #2260 made reachable by ordinary contention, `err.message` is
 * `withKeyLock: timed out … waiting to acquire "cast-id-history:<ABSOLUTE
 * WORKSPACE PATH>" — either a cast-lock.ts rule 1 …`. This app is served over
 * LAN HTTPS by design, so that is the user's filesystem layout handed to any
 * paired phone that pressed Accept during an analysis. Generic, too: an
 * `EACCES` or an `ENOSPC` naming a temp path round-tripped verbatim.
 *
 * So these fixtures now assert the ABSENCE of the leak rather than its
 * presence — no workspace path, no `withKeyLock:` diagnostics — alongside the
 * curated wording that replaced it. The `{status, error}` case is still pinned
 * per route: a blanket `return res.status(500)` that ate those shapes would
 * turn every 404 into a 500, which is a worse regression than the bug.
 */
describe('merge routes curate the failure body and leak nothing (#2292 round 5)', () => {
  /* Everything a body must NOT contain, in one place so both routes and the
     real-app fixtures below assert the identical bar. `bookDir` is an absolute
     path under the OS tmpdir, which is what the lock key embeds. */
  function expectNoLeak(body: { error?: string }): void {
    const error = body.error ?? '';
    expect(error).not.toContain(bookDir);
    expect(error).not.toContain('withKeyLock');
    expect(error).not.toContain('cast-id-history:');
    expect(error).not.toContain('rule 4');
  }

  function expectJsonError(res: { status: number; type: string; body: { error?: string } }): void {
    expect(res.status).toBe(500);
    expect(res.type).toBe('application/json');
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error).not.toBe('');
  }

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('POST /cast/merge — a lock timeout is curated, actionable, and leaks no path', async () => {
    retire.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);

    const res = await request(mergeApp)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expectJsonError(res);
    /* The half round 4 inverted. Restoring `err.message` reddens here. */
    expectNoLeak(res.body);
    /* And the half that makes the 500 worth reading: the shared contention
       sentence, so this matches what the five per-item routes already say. */
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(res.body.error).toContain('another operation on this book');
    /* The merge really did land — the deferred rethrow's contract, and the
       reason the copy says "reload to see" rather than "nothing happened". */
    expectMergeFullyApplied();
  });

  it('POST /cast/merge — a NON-lock escape gets the generic body, not the raw error', async () => {
    /* Aimed at `loadAnalysisCache`, which runs inside `performCastMerge` after
       the retirement block and has no handler of its own, so a plain Error
       there escapes exactly the way a cast.json EACCES would. Its message
       names a file; the client must not be told which. */
    cacheLoad.toThrow = Object.assign(
      new Error("EPERM: operation not permitted, open 'analysis-cache.json'"),
      { code: 'EPERM' },
    );

    const res = await request(mergeApp)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expectJsonError(res);
    expect(res.body.error).toBe('Internal server error.');
    expect(res.body.error).not.toContain('EPERM');
    expect(res.body.error).not.toContain('analysis-cache.json');
  });

  it('POST /cast/merge — a structured {status,error} failure keeps ITS status', async () => {
    /* The regression this pair exists to prevent: the curated 500 must not eat
       the route's own 404/409 shapes, which ARE meant to be shown verbatim. */
    const res = await request(mergeApp)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: 'no-such-id', targetId: TARGET_ID });

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/json');
    expect(res.body.error).toContain('no-such-id');
  });

  it('POST merge-suggestions/accept — the second caller curates identically', async () => {
    retire.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);

    const res = await request(suggestionsApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expectJsonError(res);
    expectNoLeak(res.body);
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    /* Still dismissed (round 4's C1 fix) — the curated body is additive to
       that, not a replacement for it. */
    expect(
      (JSON.parse(readFileSync(join(bookDir, '.audiobook', 'cast-merge-suggestions.json'), 'utf8')) as {
        suggestions?: unknown[];
      }).suggestions ?? [],
    ).toHaveLength(0);
  });

  it('POST merge-suggestions/accept — a NON-lock escape gets the generic body too', async () => {
    cacheLoad.toThrow = Object.assign(
      new Error("EPERM: operation not permitted, open 'analysis-cache.json'"),
      { code: 'EPERM' },
    );

    const res = await request(suggestionsApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expectJsonError(res);
    expect(res.body.error).toBe('Internal server error.');
    expect(res.body.error).not.toContain('EPERM');
  });

  it('POST merge-suggestions/accept — a structured failure keeps ITS status', async () => {
    const res = await request(suggestionsApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: 'no-such-id', targetId: TARGET_ID });

    expect(res.status).toBe(404);
    expect(res.type).toBe('application/json');
  });
});

/* #2292 review round 5 — the same two routes, driven through the REAL
 * assembled app (`server/src/app.ts`) instead of a bare router.
 *
 * WHY THIS EXISTS AND WHAT IT IS FOR. Every other fixture in this file mounts
 * `express()` + `express.json()` + the router under test. That harness is
 * missing exactly one thing production has — the global `errorHandler`
 * registered at `app.ts:350` — and that one omission is what let round 4
 * record, and mutation-"prove", a claim about Express's default HTML handler
 * that production could never reach. The proofs were real; they were just
 * proofs about the harness. Nothing in the router-level fixtures can ever
 * catch that class of divergence, because the divergence IS the harness.
 *
 * So this block asserts the leak bar against the wired app, where the fallback
 * that would have served an unstructured throw is actually present. If someone
 * deletes the route's own `catch` entirely and lets the error escape, these
 * still hold — `errorHandler` answers `{"error":"Internal server error."}`,
 * which leaks nothing — while the router-level ones above would go red on
 * `text/html`. That asymmetry is the point: the invariant under test is "no
 * path in production returns the lock key to a client", not "this route's
 * catch block is shaped a particular way".
 *
 * `app.js` is imported in `beforeAll` after `WORKSPACE_DIR` is set, the same
 * way `app.workspace-static.test.ts` and `lan-cookie-integration.test.ts` do
 * it. The `vi.mock`s at the top of this file are file-scoped and apply to the
 * whole module graph, so the app's own `cast-merge` router picks up the same
 * `retire.toThrow` seam. The LAN guard is inert here (`isLanTokenEnforced()`
 * is false without `LAN_HTTPS`, and supertest is loopback regardless).
 */
describe('the REAL app returns no lock key to a client (#2292 round 5)', () => {
  let realApp: Express;

  beforeAll(async () => {
    ({ app: realApp } = await import('../app.js'));
  });

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('POST /cast/merge through the wired app — curated body, no workspace path', async () => {
    retire.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);

    const res = await request(realApp)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expect(res.status).toBe(500);
    expect(res.type).toBe('application/json');
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(res.body.error).not.toContain(bookDir);
    expect(res.body.error).not.toContain('withKeyLock');
    expectMergeFullyApplied();
  });

  it('POST merge-suggestions/accept through the wired app — same bar', async () => {
    retire.toThrow = new LockAcquisitionTimeoutError(`cast-id-history:${bookDir}`, 10_000);

    const res = await request(realApp)
      .post(`/api/books/${bookId}/cast/merge-suggestions/accept`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expect(res.status).toBe(500);
    expect(res.type).toBe('application/json');
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(res.body.error).not.toContain(bookDir);
  });

  it('an unstructured escape through the wired app is JSON, not an HTML page', async () => {
    /* The claim round 4 recorded, finally measured where it was claimed. The
       route's own catch answers first; `errorHandler` is the backstop behind
       it. Either way the client gets JSON with no filesystem detail — which is
       why "the user got a blank failure with no words in it" was never true of
       production, only of the bare-router harness. */
    cacheLoad.toThrow = Object.assign(
      new Error("EPERM: operation not permitted, open 'analysis-cache.json'"),
      { code: 'EPERM' },
    );

    const res = await request(realApp)
      .post(`/api/books/${bookId}/cast/merge`)
      .set('Content-Type', 'application/json')
      .send({ sourceId: SOURCE_ID, targetId: TARGET_ID });

    expect(res.status).toBe(500);
    expect(res.type).toBe('application/json');
    expect(res.body.error).toBe('Internal server error.');
  });
});
