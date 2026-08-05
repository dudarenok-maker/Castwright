/* Integration tests for the cast/add-from-roster router.

   Seeds two the Hollow Tide books on disk — the current ("source") book has a
   minimal cast (no Linnet); the prior ("target") book contains a
   "Councillor Linnet" character with a voice. The tests assert:

   - Success path appends a new character row to the source book's
     cast.json with name + gender + ageRange + voiceId copied from the
     target, voiceState = 'reused', matchedFrom set to the target. The
     target's cast.json is untouched.
   - Series guard: target in a different series, a standalone, or
     unknown bookId all return 404.
   - Source book without cast.json yet → 409.
   - Same-book target → 400.
   - Repeat call mints a NEW id each time (no dedupe on the server). */

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

/* #2123 — hoisted `vi.mock` (NOT a runtime `vi.spyOn`) so the lock-detector
   test at the bottom of this file can intercept this route's OWN in-lock
   `readJson(cast.json)` call. Defaults to a plain passthrough — every other
   test in this file behaves exactly as if this mock weren't here. Same idiom
   as `cast-not-linked-to.test.ts`'s own #2123 mock. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return { ...actual, readJson: vi.fn(actual.readJson) };
});

const AUTHOR = 'Della Renwick';
const SERIES = 'The Hollow Tide';
const PRIOR_BOOK = 'The Hollow Tide';
const SOURCE_BOOK = 'New the Hollow Tide Book';
const OTHER_BOOK = 'Other Series Book';
const STANDALONE = 'Some Standalone';

let workspaceRoot: string;
let app: Express;
let priorBookId: string;
let sourceBookId: string;
let otherBookId: string;
let standaloneBookId: string;

const initialPriorCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  {
    id: 'councillor-linnet',
    name: 'Councillor Linnet',
    role: 'character',
    color: 'unset',
    voiceId: 'v_linnet',
    gender: 'female',
    ageRange: 'adult',
  },
  { id: 'wren', name: 'Wren', role: 'character', color: 'unset', voiceId: 'v_wren' },
];

const initialSourceCast = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'lord-vane', name: 'Lord Vane', role: 'character', color: 'unset' },
];

function writeBookOnDisk(
  workspace: string,
  author: string,
  series: string,
  title: string,
  bookId: string,
  characters: object[],
  opts: { isStandalone?: boolean; omitCast?: boolean } = {},
) {
  const dir = join(workspace, 'books', author, series, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(
    join(dir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${bookId}`,
      title,
      author,
      series,
      seriesPosition: null,
      isStandalone: opts.isStandalone === true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(join(dir, 'manuscript.txt'), 'placeholder');
  if (!opts.omitCast) {
    writeFileSync(join(dir, '.audiobook', 'cast.json'), JSON.stringify({ characters }));
  }
  return dir;
}

function readCast(
  workspace: string,
  author: string,
  series: string,
  title: string,
): { characters: Array<Record<string, unknown>> } {
  const path = join(workspace, 'books', author, series, title, '.audiobook', 'cast.json');
  return JSON.parse(readFileSync(path, 'utf8'));
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-cast-add-from-roster-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;

  const [{ castAddFromRosterRouter }, { makeBookId }] = await Promise.all([
    import('./cast-add-from-roster.js'),
    import('../workspace/paths.js'),
  ]);
  priorBookId = makeBookId(AUTHOR, SERIES, PRIOR_BOOK);
  sourceBookId = makeBookId(AUTHOR, SERIES, SOURCE_BOOK);
  otherBookId = makeBookId(AUTHOR, 'Different Series', OTHER_BOOK);
  standaloneBookId = makeBookId(AUTHOR, SERIES, STANDALONE);

  app = express();
  app.use(express.json());
  app.use('/api/books', castAddFromRosterRouter);
});

beforeEach(() => {
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, PRIOR_BOOK, priorBookId, initialPriorCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK, sourceBookId, initialSourceCast);
  writeBookOnDisk(workspaceRoot, AUTHOR, 'Different Series', OTHER_BOOK, otherBookId, [
    { id: 'unrelated', name: 'Unrelated', role: 'character', color: 'unset' },
  ]);
  writeBookOnDisk(
    workspaceRoot,
    AUTHOR,
    SERIES,
    STANDALONE,
    standaloneBookId,
    [{ id: 'lonely', name: 'Lonely', role: 'character', color: 'unset' }],
    { isStandalone: true },
  );
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

function callAdd(bookId: string, body: object) {
  return request(app)
    .post(`/api/books/${bookId}/cast/add-from-roster`)
    .set('Content-Type', 'application/json')
    .send(body);
}

describe('POST /api/books/:bookId/cast/add-from-roster', () => {
  it('rejects when targetBookId or targetCharacterId is missing', async () => {
    const res = await callAdd(sourceBookId, { targetBookId: priorBookId });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/i);
  });

  it('rejects when targetBookId equals the path bookId', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: sourceBookId,
      targetCharacterId: 'lord-vane',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/differ/i);
  });

  it('returns 404 when the source book is unknown', async () => {
    const res = await callAdd('nope', {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/source book/i);
  });

  it('returns 404 when the target book is unknown', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: 'nope',
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target book/i);
  });

  it('returns 404 when target book is in a different series', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: otherBookId,
      targetCharacterId: 'unrelated',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when target book is a standalone', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: standaloneBookId,
      targetCharacterId: 'lonely',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/series-mate/i);
  });

  it('returns 404 when the target character is unknown', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'missing',
    });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/target character/i);
  });

  it('returns 409 when the source book has no cast.json yet', async () => {
    /* Delete the cast.json that beforeEach wrote; writeBookOnDisk
       with omitCast doesn't unlink existing files. */
    unlinkSync(
      join(workspaceRoot, 'books', AUTHOR, SERIES, SOURCE_BOOK, '.audiobook', 'cast.json'),
    );
    const res = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/source book has no cast/i);
  });

  it('appends a new character to source.cast.json with matchedFrom + preserved voiceId, returns the full new record', async () => {
    const res = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res.status).toBe(200);
    expect(res.body.character).toMatchObject({
      name: 'Councillor Linnet',
      role: 'character',
      gender: 'female',
      ageRange: 'adult',
      voiceId: 'v_linnet',
      voiceState: 'reused',
      matchedFrom: {
        bookId: priorBookId,
        characterId: 'councillor-linnet',
        bookTitle: PRIOR_BOOK,
        confidence: 1,
      },
    });
    expect(typeof res.body.character.id).toBe('string');
    expect(res.body.character.id).not.toBe('councillor-linnet'); // new local id, not the prior id

    const sourceOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK);
    /* New character appended; old characters untouched. */
    expect(sourceOnDisk.characters).toHaveLength(initialSourceCast.length + 1);
    const added = sourceOnDisk.characters.at(-1);
    expect(added).toMatchObject({
      name: 'Councillor Linnet',
      voiceId: 'v_linnet',
      voiceState: 'reused',
    });
  });

  it("does not modify the target book's cast.json", async () => {
    const before = readCast(workspaceRoot, AUTHOR, SERIES, PRIOR_BOOK);
    await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    const after = readCast(workspaceRoot, AUTHOR, SERIES, PRIOR_BOOK);
    expect(after).toEqual(before);
  });

  it('mints a unique id on repeat calls (no dedupe on the server)', async () => {
    const res1 = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    const res2 = await callAdd(sourceBookId, {
      targetBookId: priorBookId,
      targetCharacterId: 'councillor-linnet',
    });
    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);
    expect(res1.body.character.id).not.toBe(res2.body.character.id);

    const sourceOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK);
    expect(sourceOnDisk.characters).toHaveLength(initialSourceCast.length + 2);
  });

  /* #1981 — two concurrent add-from-roster calls into the SAME source book
     (pulling different characters from the prior book) race that source
     book's cast.json. Unlocked, both requests' readJson resolve before
     either writeJsonAtomic lands, so the later write replays a `characters`
     snapshot taken before the earlier write happened and silently drops it. */
  it('#1981 — keeps both new characters when two add-from-roster calls for one book overlap', async () => {
    const [resLinnet, resWren] = await Promise.all([
      callAdd(sourceBookId, { targetBookId: priorBookId, targetCharacterId: 'councillor-linnet' }),
      callAdd(sourceBookId, { targetBookId: priorBookId, targetCharacterId: 'wren' }),
    ]);
    expect(resLinnet.status).toBe(200);
    expect(resWren.status).toBe(200);

    const sourceOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK);
    const ids = sourceOnDisk.characters.map((c) => c['id']);
    expect(ids).toContain(resLinnet.body.character.id);
    expect(ids).toContain(resWren.body.character.id);
    expect(sourceOnDisk.characters).toHaveLength(initialSourceCast.length + 2);
  });
});

/* #2123 (srv-87) — cast-add-from-roster.ts was one of two cast-lock-sweep
   sites with no BEHAVIOURAL lock detector (the other being
   voice-library-usage.ts's `clearLibraryVoiceReferences`). Correction to the
   sweep's own premise, found while building this test: the #2040-era
   measurement that flagged this file assumed it called `withCastLocks`
   (plural) — it doesn't. This route calls `withCastLock` (singular, see its
   own "#1981" comment above `withCastLock(sourceLocated.bookDir, ...)`: only
   the source book is written, so `withCastLocks` "would be widening the lock
   for no reason"). Neutralising `withCastLocks` therefore never touches this
   route at all — mutating it leaves this file green regardless of whether a
   detector exists. The racer below uses `withCastLock`, the SAME primitive
   this route calls, per this file's own #1981 concurrent test just above and
   per `cast-not-linked-to.test.ts`'s #2123 comment on the same principle.

   The #1981 test just above (a bare `Promise.all` self-race on the SAME
   source book) happens to also catch both the lock-neutralised and the
   read-hoisted-outside-a-retained-lock mutations reliably in local testing —
   but it is a natural, untimed race, not the deterministic scripted
   construction this branch has standardised on elsewhere (see
   cast-not-linked-to.test.ts's #2123 block comment on why a natural race is
   not treated as sufficient coverage here). This detector is added
   independently of that test, not as a replacement for it.

   Unlike cast-not-linked-to.ts, there is no separate unlocked pre-lock read
   of the SOURCE book's cast.json to confuse the gate with: `findBookByBookId`
   (called before the lock) only reads state.json, never cast.json (verified
   by reading `workspace/scan.ts`'s `findBookBy`). The in-lock
   `readJson(castJsonPath(sourceLocated.bookDir))` at the top of this route's
   `withCastLock` callback is the FIRST and ONLY read of that path, so a
   simple "first occurrence" gate (no per-path occurrence counting, unlike
   voice-library-usage.test.ts's #2123 detector) is correct here.

   The racer touches `narrator.raceProbe` — a field this route never reads or
   writes — so its survival is a clean signal independent of the route's own
   append-a-character bookkeeping. `assertRouteOutcome` checks the new
   character actually landed on disk, so a failing/no-op target trivially
   "preserving" the racer's write can't pass by accident. */
async function runLockDetector(
  targetCall: () => ReturnType<typeof callAdd>,
  assertRouteOutcome: () => void,
): Promise<void> {
  const stateIo = await import('../workspace/state-io.js');
  const actual = await vi.importActual<typeof import('../workspace/state-io.js')>(
    '../workspace/state-io.js',
  );
  const { castJsonPath } = await import('../workspace/paths.js');
  const { withCastLock } = await import('../workspace/cast-lock.js');
  const sourceBookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, SOURCE_BOOK);
  const sourceCastPath = castJsonPath(sourceBookDir);

  let released!: () => void;
  const gate = new Promise<void>((resolve) => {
    released = resolve;
  });
  let intercepted = false;
  const spy = vi.mocked(stateIo.readJson).mockImplementation(async (path: string) => {
    if (!intercepted && path === sourceCastPath) {
      intercepted = true;
      const value = await actual.readJson(path); // real bytes, now — happens-before the racer's write
      await gate; // hold the RESOLUTION open until released below
      return value;
    }
    return actual.readJson(path);
  });

  // Bypasses the spy entirely (uses `actual` directly) so the racer's own
  // read/write are never accidentally re-intercepted — it's a plain,
  // faithful `withCastLock` consumer, same as any other real caller.
  let racerEntered = false;
  async function raceWrite(): Promise<void> {
    await withCastLock(sourceBookDir, async () => {
      racerEntered = true; // set on entry, before the read
      const cast = await actual.readJson<{
        characters: Array<Record<string, unknown>>;
      }>(sourceCastPath);
      const narrator = cast!.characters.find((c) => c.id === 'narrator')!;
      (narrator as Record<string, unknown>).raceProbe = 'concurrent-writer-survived';
      await actual.writeJsonAtomic(sourceCastPath, { characters: cast!.characters });
    });
  }

  let targetPromise: ReturnType<typeof callAdd> | undefined;
  let racePromise: Promise<void> | undefined;
  try {
    targetPromise = targetCall();
    targetPromise.catch(() => {}); // supertest is lazy — force real dispatch now

    // Poll rather than a fixed sleep — same precedent as
    // cast-not-linked-to.test.ts's own #2123 detector.
    const deadline = Date.now() + 2000;
    while (!intercepted && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(intercepted).toBe(true);

    racePromise = raceWrite();
    racePromise.catch(() => {}); // unhandled-rejection window, mirrors targetPromise above

    // Generous head start: completes fully when unlocked (the bug
    // window), or queues behind the target's held lock when locked (the
    // fix) — either way nothing depends on tuning a tight timing window.
    await new Promise((r) => setTimeout(r, 80));

    // Must hold even when the survival assertions below would still pass
    // by luck (a slow unlocked racer that loses the race anyway).
    expect(racerEntered).toBe(false);

    released();
    const [targetRes] = await Promise.all([targetPromise, racePromise]);
    expect(targetRes.status).toBe(200);
  } finally {
    // Idempotent: also fires here so a throw ANYWHERE above (before the
    // happy-path call) still releases a held `readJson` rather than
    // leaving it stuck on `await gate` forever. Resolving an
    // already-resolved promise a second time is a no-op.
    released();
    // Not `mockRestore()` — this is a `vi.fn()` wrapper (from the hoisted
    // `vi.mock` factory above), not a `vi.spyOn` spy, so restore its
    // default passthrough behaviour explicitly.
    spy.mockImplementation(actual.readJson);
    // On the failure path (an assertion above threw) these are still
    // in-flight — await them so the test can't return while either is
    // still running against fixtures `afterAll` is about to delete.
    await Promise.allSettled([targetPromise, racePromise]);
  }

  assertRouteOutcome();

  const narratorSource = readCast(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK).characters.find(
    (c) => c.id === 'narrator',
  );
  expect(narratorSource?.raceProbe).toBe('concurrent-writer-survived');
}

describe('#2123 — cast.json lock is real, and its read stays inside it', () => {
  it('a concurrent withCastLock writer on the same book survives add-from-roster', async () => {
    await runLockDetector(
      () =>
        callAdd(sourceBookId, {
          targetBookId: priorBookId,
          targetCharacterId: 'councillor-linnet',
        }),
      () => {
        const sourceOnDisk = readCast(workspaceRoot, AUTHOR, SERIES, SOURCE_BOOK);
        expect(sourceOnDisk.characters).toHaveLength(initialSourceCast.length + 1);
        const added = sourceOnDisk.characters.at(-1);
        expect(added).toMatchObject({
          name: 'Councillor Linnet',
          voiceId: 'v_linnet',
          voiceState: 'reused',
        });
      },
    );
  });
});
