/* #2260 FINAL ROUND (B2) — what a client is told when a lock acquisition
 * expires, across every route that can produce one and fails the WHOLE request.
 *
 * THE LEAK, AND WHY IT IS NEW TO #2260. Twelve handlers take a lock on a path
 * that can surface `LockAcquisitionTimeoutError`; nine of them share the
 * literal shape `res.status(500).json({ error: (e as Error).message ||
 * '<wording>' })`, and the other three curate the same message through a
 * different response shape (see `workspace/file-lock.ts`'s
 * `requestFailureMessage` doc comment). Before this change a contended lock
 * HUNG, so there was no error to serialise and the branch was unreachable for
 * this class. Bounding acquisition made it reachable by ORDINARY CONTENTION —
 * and `LockAcquisitionTimeoutError`'s message embeds the lock key, which for a
 * cast lock is `castJsonPath(bookDir)`, i.e. the absolute path of the user's
 * library. This app is served over LAN HTTPS by design, so that is the
 * filesystem layout handed to any paired phone.
 *
 * The round-5 convention ("a failure body that escalates never carries the
 * error's own message") was recorded against the two merge routes and was false
 * everywhere else. `requestFailureMessage` (workspace/file-lock.ts) makes it
 * true; this file measures it at every route cheap enough to drive end to end.
 *
 * INJECTION — ONE seam, at the primitive that actually throws: `withKeyLock`.
 * Every lock class in the app funnels through it (`withCastLock` keys on
 * `castJsonPath(bookDir)`, `withLibraryVoiceLock` on `library-voice:<uuid>`,
 * listen-stats on `listen-stats:<bookDir>`), so one mock covers cast locks,
 * library-voice locks and the one non-cast key space without any per-route
 * stubbing. `fn` is never called, which is what a real expiry does —
 * `withKeyLock` must never fall through to the critical section unlocked.
 *
 * `file-lock.ts` imports NOTHING, which is why mocking it is safe here: there is
 * no transitive module graph for `importOriginal` to resolve a second time (the
 * trap `voice-library.test.ts` documents against `purge-clone-artifacts`, and
 * the one that made an earlier cut of this file mock the wrong module and
 * silently measure nothing).
 *
 * Mocked rather than genuinely contended, for the reason `file-lock.ts`'s own
 * budget note gives: the real budget is 10s and vitest's testTimeout is 15s.
 * That the real mutex throws this class on expiry is pinned in
 * `workspace/file-lock.test.ts`.
 *
 * TWO-DIRECTIONAL AT EVERY ROUTE. The second half is not decoration: these
 * handlers have always surfaced an ordinary failure's own message, that is a
 * separate judgement about a separate class, and nothing here is meant to
 * change it. A fix over-applied into "stop returning `e.message`" reddens on
 * every second case below.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const lockFault = vi.hoisted(() => ({ toThrow: null as unknown }));

vi.mock('../workspace/file-lock.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/file-lock.js')>();
  return {
    ...actual,
    withKeyLock: async <T>(key: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> => {
      if (lockFault.toThrow) throw lockFault.toThrow;
      return actual.withKeyLock(key, fn, timeoutMs);
    },
  };
});

const BOOK_ID = 'lock-timeout-book';
const VOICE_UUID = 'lock-timeout-voice';
const CHARACTER_ID = 'char-marlow';
const VOICE_ID = 'catalog-voice-1';

let dir: string;
let bookDir: string;
let app: Express;
let vl: typeof import('../workspace/voice-library.js');
let LockAcquisitionTimeoutError: typeof import('../workspace/file-lock.js').LockAcquisitionTimeoutError;
let LOCK_CONTENTION_REQUEST_ERROR: string;

/** A timeout carrying the key a real cast-lock expiry carries: the absolute
 *  path of this book's cast.json. That is what makes the no-leak assertions
 *  below non-vacuous. */
function castTimeout(): unknown {
  return new LockAcquisitionTimeoutError(join(bookDir, '.audiobook', 'cast.json'), 10_000);
}

/** A NON-timeout failure from the same seam. Distinctive wording so the
 *  assertion cannot pass on a fallback string. */
function ordinaryFault(): unknown {
  return Object.assign(new Error('some novel EPERM-shaped failure'), { code: 'EPERM' });
}

function writeCast(characters: object[]): void {
  writeFileSync(
    join(bookDir, '.audiobook', 'cast.json'),
    JSON.stringify({ characters }),
  );
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-lock-timeout-bodies-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();

  /* Sequential awaits, not `Promise.all` — #2083: a `Promise.all` of dynamic
     imports races the async `vi.mock` factory above, and the module under test
     can receive the real binding instead of the mock. */
  const { voiceLibraryRouter } = await import('./voice-library.js');
  const { bookStateRouter } = await import('./book-state.js');
  const { voicesRouter } = await import('./voices.js');
  vl = await import('../workspace/voice-library.js');
  const fileLock = await import('../workspace/file-lock.js');
  LockAcquisitionTimeoutError = fileLock.LockAcquisitionTimeoutError;
  LOCK_CONTENTION_REQUEST_ERROR = fileLock.LOCK_CONTENTION_REQUEST_ERROR;

  app = express();
  app.use(express.json());
  /* Same mount paths as app.ts. */
  app.use('/api/voice-library', voiceLibraryRouter);
  app.use('/api/books', bookStateRouter);
  app.use('/api/voices', voicesRouter);

  bookDir = join(dir, 'books', 'Della Renwick', 'The Hollow Tide', 'Book One');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId: BOOK_ID,
      manuscriptId: `m_${BOOK_ID}`,
      title: 'Book One',
      author: 'Della Renwick',
      series: 'The Hollow Tide',
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeCast([{ id: CHARACTER_ID, name: 'Marlow', voiceId: VOICE_ID }]);

  await vl.writeEntry({
    voiceUuid: VOICE_UUID,
    name: 'Test Voice',
    provenance: 'designed',
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
  /* The voice-library DELETE evicts from the sidecar; nothing is listening in a
     test environment, and ECONNREFUSED is the honest default. */
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
});

afterEach(() => {
  lockFault.toThrow = null;
  vi.restoreAllMocks();
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
});

/** Everything a body must NOT contain. `bookDir` is the absolute tempdir path
 *  the cast-lock key embeds. */
function expectNoLeak(body: { error?: string }): void {
  const error = body.error ?? '';
  expect(error).not.toContain(bookDir);
  expect(error).not.toContain('withKeyLock');
  expect(error).not.toContain('cast.json');
  expect(error).not.toContain('rule 4');
}

/* Each entry drives ONE route to its 500 handler through the lock seam. The
   `arrange` step seeds whatever that route needs in order to REACH the lock —
   load-bearing, not scenery: without it a route short-circuits to a 404/409 and
   the fixture proves nothing, which is why every case also asserts the status
   is 500 before looking at the body. */
interface Case {
  name: string;
  /** Which lock class this route's failure actually comes from. */
  lock: string;
  arrange?: () => void;
  call: () => request.Test;
}

const CASES: Case[] = [
  {
    name: 'POST /api/voice-library/:uuid/assign',
    lock: 'library-voice: → cast (2 deep)',
    call: () =>
      request(app)
        .post(`/api/voice-library/${VOICE_UUID}/assign`)
        .send({ bookId: BOOK_ID, characterId: CHARACTER_ID }),
  },
  {
    name: 'DELETE /api/voice-library/:uuid',
    lock: 'library-voice: → cast per confirmed book (N+1 deep)',
    arrange: () =>
      writeCast([
        {
          id: CHARACTER_ID,
          name: 'Marlow',
          overrideTtsVoices: { qwen: { name: `qwen-${VOICE_UUID}`, libraryUuid: VOICE_UUID } },
        },
      ]),
    call: () => request(app).delete(`/api/voice-library/${VOICE_UUID}?confirm=1`),
  },
  {
    name: 'DELETE /api/voice-library/:uuid/assign (unassign)',
    lock: 'cast',
    arrange: () =>
      writeCast([
        {
          id: CHARACTER_ID,
          name: 'Marlow',
          overrideTtsVoices: { qwen: { name: `qwen-${VOICE_UUID}`, libraryUuid: VOICE_UUID } },
        },
      ]),
    /* Query params, not a body — this route's own signature. */
    call: () =>
      request(app).delete(
        `/api/voice-library/${VOICE_UUID}/assign?bookId=${BOOK_ID}&characterId=${CHARACTER_ID}`,
      ),
  },
  {
    name: 'PUT /api/books/:bookId/state (cast slice)',
    lock: 'cast',
    call: () =>
      request(app)
        .put(`/api/books/${BOOK_ID}/state`)
        .send({ slice: 'cast', patch: { characters: [{ id: CHARACTER_ID, name: 'Marlow' }] } }),
  },
  {
    name: 'PUT /api/books/:bookId/listen-stats',
    lock: 'listen-stats: — the one non-cast key space that reaches a 500',
    call: () =>
      request(app)
        .put(`/api/books/${BOOK_ID}/listen-stats`)
        .send({ sessionId: 's1', days: [{ date: '2026-08-12', seconds: 60 }] }),
  },
  {
    name: 'POST /api/books/:bookId/reparse',
    lock: 'cast',
    call: () => request(app).post(`/api/books/${BOOK_ID}/reparse`).send({}),
  },
  {
    name: 'POST /api/books/:bookId/replace-manuscript',
    lock: 'cast — same applyReparse() core as reparse above',
    call: () =>
      request(app)
        .post(`/api/books/${BOOK_ID}/replace-manuscript`)
        .attach('file', Buffer.from('placeholder replacement'), 'revised.txt'),
  },
  {
    name: 'PUT /api/voices/:voiceId/override',
    lock: 'cast, one per matching book',
    call: () =>
      request(app)
        .put(`/api/voices/${VOICE_ID}/override`)
        .send({ override: { engine: 'kokoro', name: 'af_heart' } }),
  },
];

describe.each(CASES)('$name — lock-timeout body (#2260 final round, B2)', (c) => {
  it(`curates the ${c.lock} timeout and leaks no path`, async () => {
    c.arrange?.();
    lockFault.toThrow = castTimeout();

    const res = await c.call();

    expect(res.status).toBe(500);
    expect(res.type).toBe('application/json');
    /* By value, so a reword has to move `LOCK_CONTENTION_REQUEST_ERROR` and
       this assertion together and cannot reintroduce `err.message`. */
    expect(res.body.error).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expectNoLeak(res.body);
  });

  it('leaves a NON-timeout failure reporting its own message', async () => {
    c.arrange?.();
    lockFault.toThrow = ordinaryFault();

    const res = await c.call();

    expect(res.status).toBe(500);
    expect(res.body.error).toBe('some novel EPERM-shaped failure');
    expect(res.body.error).not.toBe(LOCK_CONTENTION_REQUEST_ERROR);
  });
});
