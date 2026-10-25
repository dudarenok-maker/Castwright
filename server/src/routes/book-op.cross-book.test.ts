/* #3711 task 6 -- the cross-book writers hold a book-op PER BOOK, so a
   folder-renaming PUT queued behind one lands everything in the NEW folder and
   recreates no old path:
     - the two-book routes (cast-link-prior, cast-not-linked-to, library-cast-override)
       through `withBookOps`;
     - the series loops (cast-series-patch, voice-override-linked), one step per sibling;
     - the cross-book walker (`forEachMatchingCastCharacter`, via PUT /voices/:id/override),
       one step per book, re-checking the series filter on the FRESH state;
     - voice-library DELETE, library-voice -> book-op -> cast, per book.

   Each case is event-based and timer-free: the route is parked on a lock it takes
   AFTER entering book-op, the rename is sent, and the test waits for
   `__keyWaitersForTest('book-op:<id>')` to show the rename QUEUED before releasing.
   A route that does not hold book-op never lets the rename queue there, so the wait
   times out (red). */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const AUTHOR = 'Cross Author';
const SERIES_NAME = 'The Cross Saga';

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let fileLock: typeof import('../workspace/file-lock.js');
let castLock: typeof import('../workspace/cast-lock.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let voiceLibrary: typeof import('../workspace/voice-library.js');
let manuscripts: typeof import('../store/manuscripts.js');
const manuscriptIds: string[] = [];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-cross-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  const { castLinkPriorRouter } = await import('./cast-link-prior.js');
  const { castNotLinkedToRouter } = await import('./cast-not-linked-to.js');
  const { libraryCastOverrideRouter } = await import('./library-cast-override.js');
  const { castSeriesPatchRouter } = await import('./cast-series-patch.js');
  const { voiceOverrideLinkedRouter } = await import('./voice-override-linked.js');
  const { voicesRouter } = await import('./voices.js');
  const { voiceLibraryRouter } = await import('./voice-library.js');
  paths = await import('../workspace/paths.js');
  fileLock = await import('../workspace/file-lock.js');
  castLock = await import('../workspace/cast-lock.js');
  bookOp = await import('../workspace/book-op-lock.js');
  voiceLibrary = await import('../workspace/voice-library.js');
  manuscripts = await import('../store/manuscripts.js');
  app = express();
  app.use(express.json());
  for (const r of [bookStateRouter, castLinkPriorRouter, castNotLinkedToRouter, castSeriesPatchRouter, voiceOverrideLinkedRouter]) {
    app.use('/api/books', r);
  }
  app.use('/api', libraryCastOverrideRouter);
  app.use('/api/voices', voicesRouter);
  app.use('/api/voice-library', voiceLibraryRouter);
  /* The voice-library erase best-effort evicts against the sidecar; nothing listens. */
  vi.stubGlobal('fetch', async () => {
    throw new Error('ECONNREFUSED');
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterAll(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  for (const id of manuscriptIds) manuscripts.removeManuscript(id);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
});

interface Seeded {
  bookId: string;
  bookDir: string;
  title: string;
  series: string;
}

interface SeedOpts {
  series?: string;
  noBookId?: boolean;
  cast?: object[];
}

const BASE_CAST = (): object[] => [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  { id: 'alice', name: 'Alice', role: 'lead', color: 'narrator' },
  { id: 'bob', name: 'Bob', role: 'support', color: 'narrator' },
];

function seedBook(title: string, opts: SeedOpts = {}): Seeded {
  const series = opts.series ?? SERIES_NAME;
  const bookId = paths.makeBookId(AUTHOR, series, title);
  const bookDir = paths.bookDirByDisplay(AUTHOR, series, title);
  const manuscriptId = `m_cross_book_${title.replace(/\W+/g, '_')}`;
  manuscriptIds.push(manuscriptId);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), 'Opening prose here.\n');
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify({
      ...(opts.noBookId ? {} : { bookId }),
      manuscriptId,
      title,
      author: AUTHOR,
      series,
      seriesPosition: null,
      isStandalone: false,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-x' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: opts.cast ?? BASE_CAST() }));
  return { bookId, bookDir, title, series };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

function waiters(key: string): number {
  return (fileLock as unknown as { __keyWaitersForTest: (k: string) => number }).__keyWaitersForTest(key);
}

function fire<T extends { then: PromiseLike<unknown>['then'] }>(req: T): Promise<request.Response> {
  return Promise.resolve(req as unknown as PromiseLike<request.Response>);
}

interface Gate {
  parked: () => Promise<void>;
  release: () => void;
}

/** Hold a keyed lock until released; "parked" = one waiter queued on `waitKey`. */
function lockGate(waitKey: string, hold: (fn: () => Promise<void>) => Promise<unknown>): Gate {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let acquired!: () => void;
  const held = new Promise<void>((r) => (acquired = r));
  void hold(async () => {
    acquired();
    await open;
  });
  return {
    parked: async () => {
      await held;
      await waitUntil(() => waiters(waitKey) >= 1, `the route to queue on ${waitKey}`);
    },
    release,
  };
}

const castGate = (dir: string): Gate => lockGate(paths.castJsonPath(dir), (fn) => castLock.withCastLock(dir, fn));

const putState = (bookId: string, patch: object) =>
  request(app).put(`/api/books/${bookId}/state`).send({ slice: 'state', patch });

/** Start the route, wait until it is parked on `gate`, send a folder-renaming PUT of
 *  `renamed`, wait for it to QUEUE ON BOOK-OP, release, and return both responses. */
async function renameBehind(
  renamed: Seeded,
  gate: Gate,
  route: () => { then: PromiseLike<unknown>['then'] },
  newTitle: string,
) {
  const routeP = fire(route());
  await gate.parked();
  const renameP = fire(putState(renamed.bookId, { title: newTitle }));
  await waitUntil(() => waiters(`book-op:${renamed.bookId}`) >= 1, 'the rename to queue on book-op');
  gate.release();
  const [routeRes, renameRes] = await Promise.all([routeP, renameP]);
  return { routeRes, renameRes, newDir: paths.bookDirByDisplay(AUTHOR, renamed.series, newTitle) };
}

interface CastChar {
  id: string;
  name: string;
  gender?: string;
  aliases?: string[];
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
  overrideTtsVoices?: { qwen?: { name?: string; libraryUuid?: string } };
}
const castOf = (dir: string): CastChar[] =>
  (JSON.parse(readFileSync(paths.castJsonPath(dir), 'utf8')) as { characters: CastChar[] }).characters;

describe('#3711 task 6 -- two-book routes: a rename of the OTHER book queued behind lands in its new folder', () => {
  it('cast-link-prior: the target book is renamed while the link is being written', async () => {
    const source = seedBook('Link Source');
    const target = seedBook('Link Target');
    const r = await renameBehind(
      target,
      castGate(source.bookDir),
      () =>
        request(app)
          .post(`/api/books/${source.bookId}/cast/link-prior`)
          .send({ sourceCharacterId: 'alice', targetBookId: target.bookId, targetCharacterId: 'bob' }),
      'Link Target Renamed',
    );
    expect(r.routeRes.status).toBe(200);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(target.bookDir)).toBe(false); // the old folder was not recreated
    expect(castOf(r.newDir).find((c) => c.id === 'bob')?.aliases).toContain('Alice');
  });

  it('cast-not-linked-to: the other book is renamed while the pair is being written', async () => {
    const source = seedBook('Pair Source');
    const other = seedBook('Pair Other');
    const r = await renameBehind(
      other,
      castGate(source.bookDir),
      () =>
        request(app)
          .post(`/api/books/${source.bookId}/cast/alice/not-linked-to`)
          .send({ otherBookId: other.bookId, otherCharacterId: 'bob' }),
      'Pair Other Renamed',
    );
    expect(r.routeRes.status).toBe(200);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(other.bookDir)).toBe(false);
    expect(castOf(r.newDir).find((c) => c.id === 'bob')?.notLinkedTo).toEqual([
      { bookId: source.bookId, characterId: 'alice' },
    ]);
  });

  it('library-cast-override: the target book is renamed while the merge is being written', async () => {
    const source = seedBook('Override Source', {
      cast: [{ id: 'alice', name: 'Alice', role: 'lead', color: 'narrator', description: 'A long and rich description.' }],
    });
    const target = seedBook('Override Target');
    const r = await renameBehind(
      target,
      castGate(source.bookDir),
      () =>
        request(app).post('/api/library-cast/override').send({
          sourceBookId: source.bookId,
          sourceCharacterId: 'alice',
          targetBookId: target.bookId,
          targetCharacterId: 'bob',
        }),
      'Override Target Renamed',
    );
    expect(r.routeRes.status).toBe(200);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(target.bookDir)).toBe(false);
    expect((castOf(r.newDir).find((c) => c.id === 'bob') as { description?: string }).description).toBe(
      'A long and rich description.',
    );
  });

  it('a missing target book is still a 404 naming the target', async () => {
    const source = seedBook('Gone Source');
    const res = await request(app)
      .post(`/api/books/${source.bookId}/cast/link-prior`)
      .send({ sourceCharacterId: 'alice', targetBookId: 'no__such__book', targetCharacterId: 'bob' });
    expect(res.status).toBe(404);
    expect(res.body.error).toContain('Target book');
  });
});

describe('#3711 task 6 -- series loops: one book-op per sibling, resolved inside the step', () => {
  it('cast-series-patch: a sibling renamed while its patch is being written lands in the new folder', async () => {
    const source = seedBook('Patch Source');
    const sibling = seedBook('Patch Sibling');
    const r = await renameBehind(
      sibling,
      castGate(sibling.bookDir),
      () => request(app).post(`/api/books/${source.bookId}/cast/alice/series-patch`).send({ gender: 'female' }),
      'Patch Sibling Renamed',
    );
    expect(r.routeRes.status).toBe(200);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(sibling.bookDir)).toBe(false);
    expect(castOf(source.bookDir).find((c) => c.id === 'alice')?.gender).toBe('female');
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.gender).toBe('female');
  });

  it('voice-override-linked: a series-mate renamed while its write is parked lands in the new folder', async () => {
    const source = seedBook('Linked Source');
    const mate = seedBook('Linked Mate');
    const r = await renameBehind(
      mate,
      castGate(mate.bookDir),
      () =>
        request(app)
          .post(`/api/books/${source.bookId}/cast/alice/voice-override-linked`)
          .send({ override: { engine: 'qwen', name: 'Linked Voice' } }),
      'Linked Mate Renamed',
    );
    expect(r.routeRes.body).toMatchObject({ failed: [] });
    expect(r.routeRes.status).toBe(200);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(mate.bookDir)).toBe(false);
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.overrideTtsVoices?.qwen?.name).toBe('Linked Voice');
  });
});

describe('#3711 task 6 -- the cross-book walker (PUT /voices/:voiceId/override)', () => {
  const seriesOverride = (bookId: string) =>
    request(app)
      .put('/api/voices/bob/override')
      .send({ override: { engine: 'qwen', name: 'qwen-walk' }, scope: 'series', bookId });

  it('a sibling renamed while the walker is writing it: its cast.json lands in the NEW folder only', async () => {
    const a = seedBook('Walk A');
    const b = seedBook('Walk B');
    /* The walker writes A, then takes B's book-op and parks on B's cast lock. */
    const r = await renameBehind(b, castGate(b.bookDir), () => seriesOverride(a.bookId), 'Walk B Renamed');
    expect(r.routeRes.status).toBe(204);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(b.bookDir)).toBe(false); // the old folder was not recreated
    expect(castOf(a.bookDir).find((c) => c.id === 'bob')?.overrideTtsVoices?.qwen?.name).toBe('qwen-walk');
    expect(castOf(r.newDir).find((c) => c.id === 'bob')?.overrideTtsVoices?.qwen?.name).toBe('qwen-walk');
  });

  it('a sibling renamed OUT of the series after the walk saw it is skipped (scope re-checked on the fresh state)', async () => {
    const a = seedBook('Scope A');
    const b = seedBook('Scope B');
    /* Hold B's book-op so BOTH the rename and the walker queue on it, rename first. */
    const key = `book-op:${b.bookId}`;
    let release!: () => void;
    const open = new Promise<void>((r) => (release = r));
    let held!: () => void;
    const acquired = new Promise<void>((r) => (held = r));
    void fileLock.withKeyLock(key, async () => {
      held();
      await open;
    });
    await acquired;
    const renameP = fire(putState(b.bookId, { series: 'Another Saga' }));
    await waitUntil(() => waiters(key) >= 1, 'the rename to queue on book-op');
    const walkP = fire(seriesOverride(a.bookId));
    await waitUntil(() => waiters(key) >= 2, 'the walker to queue on book-op behind the rename');
    release();
    const [renameRes, walkRes] = await Promise.all([renameP, walkP]);
    expect(renameRes.status).toBe(200);
    expect(walkRes.status).toBe(204); // A was updated
    const movedDir = paths.bookDirByDisplay(AUTHOR, 'Another Saga', b.title);
    expect(existsSync(b.bookDir)).toBe(false);
    expect(castOf(a.bookDir).find((c) => c.id === 'bob')?.overrideTtsVoices?.qwen?.name).toBe('qwen-walk');
    expect(castOf(movedDir).find((c) => c.id === 'bob')?.overrideTtsVoices).toBeUndefined(); // skipped
  });

  it('a book whose state.json lacks a bookId still receives the write (cast lock only, no book-op)', async () => {
    const a = seedBook('Legacy A');
    const legacy = seedBook('Legacy B', { noBookId: true });
    const res = await seriesOverride(a.bookId);
    expect(res.status).toBe(204);
    expect(castOf(a.bookDir).find((c) => c.id === 'bob')?.overrideTtsVoices?.qwen?.name).toBe('qwen-walk');
    expect(castOf(legacy.bookDir).find((c) => c.id === 'bob')?.overrideTtsVoices?.qwen?.name).toBe('qwen-walk');
  });
});

describe('#3711 task 6 -- voice-library DELETE and assign: library-voice -> book-op -> cast, per book', () => {
  const entry = (voiceUuid: string) => ({
    voiceUuid,
    name: 'Cross Voice',
    provenance: 'designed' as const,
    tags: [],
    pinned: false,
    engines: {},
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });
  const referencing = (voiceUuid: string): object[] => [
    {
      id: 'alice',
      name: 'Alice',
      overrideTtsVoices: { qwen: { name: `qwen-${voiceUuid}`, libraryUuid: voiceUuid } },
    },
  ];

  it('DELETE ?confirm=1: a book renamed while its references are being cleared lands in the new folder', async () => {
    const uuid = 'cross-del-1';
    await voiceLibrary.writeEntry(entry(uuid));
    const book = seedBook('Lib Delete', { cast: referencing(uuid) });
    const r = await renameBehind(
      book,
      castGate(book.bookDir),
      () => request(app).delete(`/api/voice-library/${uuid}?confirm=1`),
      'Lib Delete Renamed',
    );
    expect(r.routeRes.status).toBe(200);
    expect(r.routeRes.body).toEqual({ deleted: true });
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('assign: the target book renamed while the assignment is parked on its cast lock lands in the new folder', async () => {
    const uuid = 'cross-assign-1';
    await voiceLibrary.writeEntry(entry(uuid));
    const book = seedBook('Lib Assign');
    const r = await renameBehind(
      book,
      castGate(book.bookDir),
      () => request(app).post(`/api/voice-library/${uuid}/assign`).send({ bookId: book.bookId, characterId: 'alice' }),
      'Lib Assign Renamed',
    );
    expect(r.routeRes.status).toBe(200);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.overrideTtsVoices?.qwen?.libraryUuid).toBe(uuid);
  });

  it('DELETE-assign (unassign): the book renamed while the unassign is parked lands in the new folder', async () => {
    const uuid = 'cross-unassign-1';
    const book = seedBook('Lib Unassign', { cast: referencing(uuid) });
    const r = await renameBehind(
      book,
      castGate(book.bookDir),
      () => request(app).delete(`/api/voice-library/${uuid}/assign?bookId=${book.bookId}&characterId=alice`),
      'Lib Unassign Renamed',
    );
    expect(r.routeRes.status).toBe(200);
    expect(r.renameRes.status).toBe(200);
    expect(existsSync(book.bookDir)).toBe(false);
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.overrideTtsVoices?.qwen).toBeUndefined();
  });

  it('promote: a book renamed while the promote queues on book-op is read from the NEW folder (201, not a spurious 404)', async () => {
    const book = seedBook('Lib Promote');
    const newDir = paths.bookDirByDisplay(AUTHOR, book.series, 'Lib Promote Renamed');
    let promoteP!: Promise<request.Response>;
    await bookOp.withBookOp(book.bookId, async (held) => {
      promoteP = fire(
        request(app).post('/api/voice-library/promote').send({ bookId: book.bookId, characterId: 'alice', name: 'Promoted' }),
      );
      await waitUntil(() => waiters(`book-op:${book.bookId}`) === 1, 'the promote to queue on book-op');
      await bookOp.moveBookFolder(held, newDir, (fresh) => ({ ...fresh, title: 'Lib Promote Renamed' }));
    });
    const res = await promoteP;
    expect(res.status).toBe(201);
    expect(res.body.promotedFrom).toEqual({ bookId: book.bookId, characterId: 'alice' });
    expect(existsSync(book.bookDir)).toBe(false); // the promote read; it recreated nothing
    expect(castOf(newDir).map((c) => c.id)).toEqual(['narrator', 'alice', 'bob']); // origin cast untouched
  });

  it('promote of a book that does not exist is a 404', async () => {
    const res = await request(app)
      .post('/api/voice-library/promote')
      .send({ bookId: 'no__such__book', characterId: 'alice', name: 'X' });
    expect(res.status).toBe(404);
  });
});
