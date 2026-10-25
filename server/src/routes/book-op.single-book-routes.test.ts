/* #3711 task 5 -- the single-book quick routes (cast-create, add-from-roster,
   aliases, link/reject-orphan, merge, merge-suggestions, revision-ops, the
   chapter-audio `previous` routes, cover, script-review ledger edits and the
   qwen-voice promote/discard/emotion-variant routes) hold the book's `book-op`
   lock for their whole span, so a folder-renaming PUT queued behind one lands
   everything in the NEW folder and recreates no old path.

   One "rename queued behind it" case per route, event-based and timer-free: the
   route is parked on a lock (or a `readJson`) it takes AFTER entering book-op,
   the rename is sent, and the test waits for `__keyWaitersForTest('book-op:<id>')`
   to show the rename QUEUED before releasing the route. A route that does not
   hold book-op never lets the rename queue there, so the wait times out (red);
   and had the rename run anyway, the route's write would recreate the old path. */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Express } from 'express';
import request from 'supertest';

const spies = vi.hoisted(() => ({
  readJsonGate: null as null | ((path: string) => Promise<void>),
}));

/* A deferred in front of `readJson`, for routes that take no inner lock. */
vi.mock('../workspace/state-io.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/state-io.js')>();
  return {
    ...actual,
    readJson: async (path: string, ...rest: unknown[]) => {
      if (spies.readJsonGate) await spies.readJsonGate(path);
      return (actual.readJson as (p: string, ...r: unknown[]) => Promise<unknown>)(path, ...rest);
    },
  };
});

/* The cover POST's slow, unlocked span (candidate search + download) is faked. */
vi.mock('../cover/search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cover/search.js')>();
  return {
    ...actual,
    findCandidateById: async () => ({
      id: 'openlibrary:1',
      source: 'openlibrary',
      coverUrl: 'https://covers.invalid/1.jpg',
    }),
  };
});
vi.mock('../cover/store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cover/store.js')>();
  return { ...actual, fetchCoverJpeg: async () => Buffer.from('JPEGBYTES') };
});

const AUTHOR = 'Single Author';
const SERIES_NAME = 'The Saga';
const MANUSCRIPT_ID_PREFIX = 'm_single_book_routes_';
const FILE_ID = '000000000000001-aaaaaaaa';

let workspaceRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let fileLock: typeof import('../workspace/file-lock.js');
let castLock: typeof import('../workspace/cast-lock.js');
let revisionsStore: typeof import('../workspace/revisions-store.js');
let manuscripts: typeof import('../store/manuscripts.js');
const manuscriptIds: string[] = [];

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-book-op-single-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  /* Sequential imports -- a Promise.all of dynamic imports races vi.mock factories (#2083). */
  const { bookStateRouter } = await import('./book-state.js');
  const { castCreateRouter } = await import('./cast-create.js');
  const { castAddFromRosterRouter } = await import('./cast-add-from-roster.js');
  const { castAliasesRouter } = await import('./cast-aliases.js');
  const { castLinkOrphanRouter } = await import('./cast-link-orphan.js');
  const { castMergeSuggestionsRouter } = await import('./cast-merge-suggestions.js');
  const { castRejectOrphanRouter } = await import('./cast-reject-orphan.js');
  const { castMergeRouter } = await import('./cast-merge.js');
  const { revisionOpsRouter } = await import('./revision-ops.js');
  const { chapterAudioRouter } = await import('./chapter-audio.js');
  const { coverRouter } = await import('./cover.js');
  const { scriptReviewRouter } = await import('./script-review.js');
  const { qwenVoiceRouter } = await import('./qwen-voice.js');
  paths = await import('../workspace/paths.js');
  fileLock = await import('../workspace/file-lock.js');
  castLock = await import('../workspace/cast-lock.js');
  revisionsStore = await import('../workspace/revisions-store.js');
  manuscripts = await import('../store/manuscripts.js');
  app = express();
  app.use(express.json());
  for (const r of [
    bookStateRouter,
    castCreateRouter,
    castAddFromRosterRouter,
    castAliasesRouter,
    castLinkOrphanRouter,
    castMergeSuggestionsRouter,
    castRejectOrphanRouter,
    castMergeRouter,
    revisionOpsRouter,
    chapterAudioRouter,
    coverRouter,
    scriptReviewRouter,
    qwenVoiceRouter,
  ]) {
    app.use('/api/books', r);
  }
  /* The qwen-voice routes best-effort evict against the sidecar; nothing listens. */
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
  for (const id of manuscriptIds) {
    rmSync(join(resolve(dirname(fileURLToPath(import.meta.url)), '..', '..'), 'handoff', 'cache', `${id}.json`), {
      force: true,
    });
  }
  delete process.env.WORKSPACE_DIR;
});

afterEach(() => {
  spies.readJsonGate = null;
  for (const id of manuscriptIds) manuscripts.removeManuscript(id);
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, 'voices'), { recursive: true, force: true });
});

interface Seeded {
  bookId: string;
  bookDir: string;
  title: string;
  series: string;
  manuscriptId: string;
}

interface SeedOpts {
  series?: string;
  coverImage?: object;
  cast?: object[];
}

const BASE_CAST = (): object[] => [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'narrator' },
  { id: 'alice', name: 'Alice', role: 'lead', color: 'narrator', aliases: ['Al'] },
  { id: 'bob', name: 'Bob', role: 'support', color: 'narrator' },
];

function seedBook(title: string, opts: SeedOpts = {}): Seeded {
  const series = opts.series ?? paths.STANDALONES_SERIES;
  const isStandalone = series === paths.STANDALONES_SERIES;
  const bookId = paths.makeBookId(AUTHOR, series, title);
  const bookDir = paths.bookDirByDisplay(AUTHOR, series, title);
  const manuscriptId = `${MANUSCRIPT_ID_PREFIX}${title.replace(/\W+/g, '_')}`;
  manuscriptIds.push(manuscriptId);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.md'), 'Opening prose here.\n');
  writeFileSync(
    paths.stateJsonPath(bookDir),
    JSON.stringify({
      bookId,
      manuscriptId,
      title,
      author: AUTHOR,
      series,
      seriesPosition: null,
      isStandalone,
      manuscriptFile: 'manuscript.md',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: '01-x' }],
      ...(opts.coverImage ? { coverImage: opts.coverImage } : {}),
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(
    paths.manuscriptEditsJsonPath(bookDir),
    JSON.stringify({ sentences: [{ id: 1, chapterId: 1, characterId: 'bob', text: 'Hi.' }] }),
  );
  writeFileSync(paths.castJsonPath(bookDir), JSON.stringify({ characters: opts.cast ?? BASE_CAST() }));
  return { bookId, bookDir, title, series, manuscriptId };
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

const castGate = (dir: string): Gate =>
  lockGate(paths.castJsonPath(dir), (fn) => castLock.withCastLock(dir, fn));
const stateJsonGate = (dir: string): Gate =>
  lockGate(`state-json:${paths.stateJsonPath(dir)}`, (fn) => fileLock.withStateJsonLock(paths.stateJsonPath(dir), fn));
const keyGate = (key: string): Gate => lockGate(key, (fn) => fileLock.withKeyLock(key, fn));

/** Park the route at the first `readJson` of a path ending in `suffix`. */
function readJsonGate(suffix: string): Gate {
  let release!: () => void;
  const open = new Promise<void>((r) => (release = r));
  let hit!: () => void;
  const parked = new Promise<void>((r) => (hit = r));
  let armed = true;
  spies.readJsonGate = async (path) => {
    if (armed && path.endsWith(suffix)) {
      armed = false;
      hit();
      await open;
    }
  };
  return { parked: () => parked, release };
}

/** Start the route, wait until it is parked on `gate`, send a folder-renaming PUT,
 *  wait for it to QUEUE ON BOOK-OP, release, and return both responses. */
async function renameBehind(
  book: Seeded,
  gate: Gate,
  route: () => { then: PromiseLike<unknown>['then'] },
  newTitle: string,
) {
  const routeP = fire(route());
  await gate.parked();
  const renameP = fire(
    request(app).put(`/api/books/${book.bookId}/state`).send({ slice: 'state', patch: { title: newTitle } }),
  );
  await waitUntil(() => waiters(`book-op:${book.bookId}`) >= 1, 'the rename to queue on book-op');
  gate.release();
  const [routeRes, renameRes] = await Promise.all([routeP, renameP]);
  return { routeRes, renameRes, newDir: paths.bookDirByDisplay(AUTHOR, book.series, newTitle) };
}

function readJsonFile<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

interface CastChar {
  id: string;
  name: string;
  aliases?: string[];
  notLinkedTo?: Array<{ bookId: string; characterId: string }>;
  matchedFrom?: { bookId: string };
  overrideTtsVoices?: { qwen?: { name?: string; variants?: Record<string, unknown> } };
}
const castOf = (dir: string): CastChar[] => readJsonFile<{ characters: CastChar[] }>(paths.castJsonPath(dir)).characters;

/** The common assertions: route ok, rename ok, nothing left at the old path. */
function expectLandedInNewFolder(
  r: { routeRes: request.Response; renameRes: request.Response },
  book: Seeded,
  routeStatus = 200,
): void {
  expect(r.routeRes.status).toBe(routeStatus);
  expect(r.renameRes.status).toBe(200);
  expect(existsSync(book.bookDir)).toBe(false);
}

const api = (book: Seeded, tail: string) => `/api/books/${book.bookId}/${tail}`;

describe('#3711 task 5 -- cast routes: a rename queued behind lands everything in the new folder', () => {
  it('cast-create', async () => {
    const book = seedBook('Single Create');
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).post(api(book, 'cast/create')).send({ name: 'Zed' }), 'Single Create Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).some((c) => c.name === 'Zed')).toBe(true);
  });

  it('cast-add-from-roster', async () => {
    const source = seedBook('Single Roster Source', { series: SERIES_NAME });
    const target = seedBook('Single Roster Target', { series: SERIES_NAME });
    const r = await renameBehind(
      source,
      castGate(source.bookDir),
      () => request(app).post(api(source, 'cast/add-from-roster')).send({ targetBookId: target.bookId, targetCharacterId: 'bob' }),
      'Single Roster Source Renamed',
    );
    expectLandedInNewFolder(r, source);
    expect(castOf(r.newDir).some((c) => c.matchedFrom?.bookId === target.bookId)).toBe(true);
  });

  it('cast-aliases: add-alias', async () => {
    const book = seedBook('Single AddAlias');
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).post(api(book, 'cast/add-alias')).send({ characterId: 'bob', aliasName: 'Bobby' }), 'Single AddAlias Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).find((c) => c.id === 'bob')?.aliases).toContain('Bobby');
  });

  it('cast-aliases: unlink-alias', async () => {
    const book = seedBook('Single Unlink');
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).post(api(book, 'cast/unlink-alias')).send({ sourceCharacterId: 'alice', aliasName: 'Al' }), 'Single Unlink Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.aliases ?? []).not.toContain('Al');
    expect(castOf(r.newDir).some((c) => c.name === 'Al')).toBe(true);
  });

  it('cast-aliases: repoint-alias', async () => {
    const book = seedBook('Single Repoint');
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).post(api(book, 'cast/repoint-alias')).send({ sourceCharacterId: 'alice', aliasName: 'Al', targetCharacterId: 'bob' }), 'Single Repoint Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).find((c) => c.id === 'bob')?.aliases).toContain('Al');
  });

  it('cast-link-orphan', async () => {
    const book = seedBook('Single Link');
    const r = await renameBehind(
      book,
      keyGate(`cast-id-history:${book.bookDir}`),
      () => request(app).post(api(book, 'cast/bob/link-orphan-match')).send({ orphanedId: 'robert' }),
      'Single Link Renamed',
    );
    expectLandedInNewFolder(r, book);
    const history = readJsonFile<{ supersededBy: Record<string, string> }>(join(r.newDir, '.audiobook', 'cast-id-history.json'));
    expect(history.supersededBy.robert).toBe('bob');
  });

  it('cast-reject-orphan: POST', async () => {
    const book = seedBook('Single Reject');
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).post(api(book, 'cast/bob/reject-orphan-match')).send({ orphanedId: 'robert' }), 'Single Reject Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).find((c) => c.id === 'bob')?.notLinkedTo).toContainEqual({ bookId: book.bookId, characterId: 'robert' });
  });

  it('cast-reject-orphan: DELETE (undo)', async () => {
    const book = seedBook('Single Undo');
    expect((await request(app).post(api(book, 'cast/bob/reject-orphan-match')).send({ orphanedId: 'robert' })).status).toBe(200);
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).delete(api(book, 'cast/bob/reject-orphan-match')).send({ orphanedId: 'robert' }), 'Single Undo Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).find((c) => c.id === 'bob')?.notLinkedTo ?? []).toEqual([]);
  });

  it('cast-merge', async () => {
    const book = seedBook('Single Merge');
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).post(api(book, 'cast/merge')).send({ sourceId: 'bob', targetId: 'alice' }), 'Single Merge Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).some((c) => c.id === 'bob')).toBe(false);
  });

  it('cast-merge-suggestions: accept', async () => {
    const book = seedBook('Single SuggAccept');
    writeFileSync(paths.castMergeSuggestionsJsonPath(book.bookDir), JSON.stringify({ suggestions: [{ sourceId: 'bob', targetId: 'alice' }] }));
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).post(api(book, 'cast/merge-suggestions/accept')).send({ sourceId: 'bob', targetId: 'alice' }), 'Single SuggAccept Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).some((c) => c.id === 'bob')).toBe(false);
    expect(readJsonFile<{ suggestions: unknown[] }>(paths.castMergeSuggestionsJsonPath(r.newDir)).suggestions).toEqual([]);
  });

  it('cast-merge-suggestions: dismiss', async () => {
    const book = seedBook('Single SuggDismiss');
    writeFileSync(paths.castMergeSuggestionsJsonPath(book.bookDir), JSON.stringify({ suggestions: [{ sourceId: 'bob', targetId: 'alice' }] }));
    const r = await renameBehind(book, readJsonGate('cast-merge-suggestions.json'), () => request(app).post(api(book, 'cast/merge-suggestions/dismiss')).send({ sourceId: 'bob', targetId: 'alice' }), 'Single SuggDismiss Renamed');
    expectLandedInNewFolder(r, book);
    expect(readJsonFile<{ suggestions: unknown[] }>(paths.castMergeSuggestionsJsonPath(r.newDir)).suggestions).toEqual([]);
  });
});

describe('#3711 task 5 -- revision-ops and chapter-audio previous routes', () => {
  function seedRevisions(book: Seeded): void {
    writeFileSync(
      paths.revisionsJsonPath(book.bookDir),
      JSON.stringify({
        schema: 1,
        fileId: FILE_ID,
        rev: 3,
        pending: [
          {
            id: 'r1',
            chapterId: 1,
            characterId: 'narrator',
            triggeredBy: 'Narrator voice change',
            playable: true,
            hasPreviousAudio: true,
            segments: [],
            origin: 'server',
          },
        ],
        dismissed: [],
        acceptedSelections: {},
        timeline: {},
      }),
    );
    const root = paths.audioDir(book.bookDir);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '01-x.mp3'), 'LIVE');
    writeFileSync(join(root, '01-x.previous.mp3'), 'PREV');
  }

  it('revision-ops: accept', async () => {
    const book = seedBook('Single Accept');
    seedRevisions(book);
    const r = await renameBehind(book, keyGate(revisionsStore.revisionsLockKey(book.bookDir)), () => request(app).post(api(book, 'revisions/r1/accept')).send({}), 'Single Accept Renamed');
    expectLandedInNewFolder(r, book);
    expect(readJsonFile<{ timeline: Record<string, unknown[]> }>(paths.revisionsJsonPath(r.newDir)).timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'accepted' }]);
    expect(existsSync(join(paths.audioDir(r.newDir), '01-x.previous.mp3'))).toBe(false);
  });

  it('revision-ops: reject', async () => {
    const book = seedBook('Single RejectRev');
    seedRevisions(book);
    const r = await renameBehind(book, keyGate(revisionsStore.revisionsLockKey(book.bookDir)), () => request(app).post(api(book, 'revisions/r1/reject')), 'Single RejectRev Renamed');
    expectLandedInNewFolder(r, book);
    expect(readFileSync(join(paths.audioDir(r.newDir), '01-x.mp3'), 'utf8')).toBe('PREV');
    expect(readJsonFile<{ timeline: Record<string, unknown[]> }>(paths.revisionsJsonPath(r.newDir)).timeline['1']).toMatchObject([{ id: 'r1', eventKind: 'rejected' }]);
  });

  it('revision-ops: drift dismiss', async () => {
    const book = seedBook('Single Dismiss');
    seedRevisions(book);
    const r = await renameBehind(book, keyGate(revisionsStore.revisionsLockKey(book.bookDir)), () => request(app).post(api(book, 'drift/drift%3Ab%3A1/dismiss')), 'Single Dismiss Renamed');
    expectLandedInNewFolder(r, book);
    expect(readJsonFile<{ dismissed: string[] }>(paths.revisionsJsonPath(r.newDir)).dismissed).toContain('drift:b:1');
  });

  /* The legacy DELETE previous (accept) / POST previous/restore (reject) routes
     answer 410 since plan 286 and touch no audio; restore-unrecorded is the one
     chapter-audio route that still moves `.previous` audio. */
  it('chapter-audio: POST previous/restore-unrecorded', async () => {
    const book = seedBook('Single AudioRestoreUnrecorded');
    const root = paths.audioDir(book.bookDir);
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, '01-x.mp3'), 'LIVE');
    writeFileSync(join(root, '01-x.previous.mp3'), 'PREV');
    const r = await renameBehind(book, keyGate(revisionsStore.revisionOpLockKey(book.bookDir, 1)), () => request(app).post(api(book, 'chapters/1/audio/previous/restore-unrecorded')), 'Single AudioRestoreUnrecorded Renamed');
    expectLandedInNewFolder(r, book, 204);
    expect(readFileSync(join(paths.audioDir(r.newDir), '01-x.mp3'), 'utf8')).toBe('PREV');
    expect(existsSync(join(paths.audioDir(r.newDir), '01-x.previous.mp3'))).toBe(false);
  });
});

describe('#3711 task 5 -- cover routes', () => {
  const COVER = { source: 'local', originalFilename: null, uploadedAt: '2026-01-01T00:00:00.000Z' };

  it('POST /cover (two-span: the commit holds book-op)', async () => {
    const book = seedBook('Single CoverPost');
    const r = await renameBehind(book, stateJsonGate(book.bookDir), () => request(app).post(api(book, 'cover')).send({ candidateId: 'openlibrary:1' }), 'Single CoverPost Renamed');
    expectLandedInNewFolder(r, book);
    expect(readFileSync(paths.coverImagePath(r.newDir), 'utf8')).toBe('JPEGBYTES');
    expect(readJsonFile<{ coverImage?: { source: string } }>(paths.stateJsonPath(r.newDir)).coverImage?.source).toBe('openlibrary');
  });

  it('DELETE /cover', async () => {
    const book = seedBook('Single CoverDelete', { coverImage: COVER });
    writeFileSync(paths.coverImagePath(book.bookDir), 'JPEGBYTES');
    const r = await renameBehind(book, stateJsonGate(book.bookDir), () => request(app).delete(api(book, 'cover')), 'Single CoverDelete Renamed');
    expectLandedInNewFolder(r, book, 204);
    expect(existsSync(paths.coverImagePath(r.newDir))).toBe(false);
    expect(readJsonFile<{ coverImage?: unknown }>(paths.stateJsonPath(r.newDir)).coverImage).toBeUndefined();
  });

  it('POST /cover/upload (two-span: the commit holds book-op)', async () => {
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } }).jpeg().toBuffer();
    const book = seedBook('Single CoverUpload');
    const r = await renameBehind(
      book,
      stateJsonGate(book.bookDir),
      () => request(app).post(api(book, 'cover/upload')).attach('image', jpeg, { filename: 'c.jpg', contentType: 'image/jpeg' }),
      'Single CoverUpload Renamed',
    );
    expectLandedInNewFolder(r, book);
    expect(existsSync(paths.coverImagePath(r.newDir))).toBe(true);
  });

  it('PATCH /cover/framing', async () => {
    const book = seedBook('Single CoverFraming', { coverImage: COVER });
    const r = await renameBehind(book, stateJsonGate(book.bookDir), () => request(app).patch(api(book, 'cover/framing')).send({ offsetX: 0, offsetY: 0, zoom: 1.5 }), 'Single CoverFraming Renamed');
    expectLandedInNewFolder(r, book, 204);
    expect(readJsonFile<{ coverImage: { framing: { zoom: number } } }>(paths.stateJsonPath(r.newDir)).coverImage.framing.zoom).toBe(1.5);
  });
});

describe('#3711 task 5 -- script-review ledger routes', () => {
  function seedLedger(book: Seeded): void {
    writeFileSync(
      paths.scriptReviewLedgerJsonPath(book.bookDir),
      JSON.stringify({
        nextVersion: 2,
        entries: {
          '1': { manuscriptId: book.manuscriptId, version: 1, ops: [], selected: {}, completedAt: '2026-01-01T00:00:00.000Z' },
        },
      }),
    );
  }
  const ledgerOf = (dir: string) =>
    readJsonFile<{ entries: Record<string, { selected: Record<string, boolean> }> }>(paths.scriptReviewLedgerJsonPath(dir));

  it('discard', async () => {
    const book = seedBook('Single SrDiscard');
    seedLedger(book);
    const r = await renameBehind(book, keyGate(`script-review-ledger:${book.bookId}`), () => request(app).post(api(book, 'script-review/discard')).send({ chapterIds: [1] }), 'Single SrDiscard Renamed');
    expectLandedInNewFolder(r, book);
    expect(ledgerOf(r.newDir).entries['1']).toBeUndefined();
  });

  it('selection', async () => {
    const book = seedBook('Single SrSelect');
    seedLedger(book);
    const r = await renameBehind(book, keyGate(`script-review-ledger:${book.bookId}`), () => request(app).patch(api(book, 'script-review/selection')).send({ chapterId: 1, version: 1, selected: { a: true } }), 'Single SrSelect Renamed');
    expectLandedInNewFolder(r, book);
    expect(ledgerOf(r.newDir).entries['1'].selected).toEqual({ a: true });
  });

  it('resolve', async () => {
    const book = seedBook('Single SrResolve');
    seedLedger(book);
    const r = await renameBehind(book, keyGate(`script-review-ledger:${book.bookId}`), () => request(app).post(api(book, 'script-review/resolve')).send({ chapterId: 1, version: 1, appliedOpKeys: [] }), 'Single SrResolve Renamed');
    expectLandedInNewFolder(r, book);
    expect(existsSync(paths.scriptReviewLedgerJsonPath(r.newDir))).toBe(true);
  });
});

describe('#3711 task 5 -- qwen-voice promote / discard / emotion-variant routes', () => {
  const withVariants = (): object[] => [
    ...BASE_CAST().filter((c) => (c as { id: string }).id !== 'alice'),
    {
      id: 'alice',
      name: 'Alice',
      role: 'lead',
      color: 'narrator',
      overrideTtsVoices: { qwen: { name: 'qwen-alice', variants: { angry: { name: 'qwen-alice__angry' } } } },
    },
  ];

  it('DELETE emotion-variant', async () => {
    const book = seedBook('Single Variant', { cast: withVariants() });
    const r = await renameBehind(book, castGate(book.bookDir), () => request(app).delete(api(book, 'cast/alice/emotion-variant/angry')), 'Single Variant Renamed');
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  it('POST promote-voice', async () => {
    const book = seedBook('Single Promote', { cast: withVariants() });
    mkdirSync(paths.qwenVoicesDir(), { recursive: true });
    writeFileSync(paths.qwenVoicePtPath('qwen-alice-preview'), 'PT');
    const r = await renameBehind(
      book,
      castGate(book.bookDir),
      () => request(app).post(api(book, 'cast/alice/promote-voice')).send({ previewVoiceId: 'qwen-alice-preview', sampleVoiceId: 's1', modelKey: 'qwen3-tts-0.6b' }),
      'Single Promote Renamed',
    );
    expectLandedInNewFolder(r, book);
    expect(castOf(r.newDir).find((c) => c.id === 'alice')?.overrideTtsVoices?.qwen?.variants).toBeUndefined();
  });

  it('POST discard-voice', async () => {
    const book = seedBook('Single Discard', { cast: withVariants() });
    const r = await renameBehind(book, readJsonGate('cast.json'), () => request(app).post(api(book, 'cast/alice/discard-voice')).send({ previewVoiceId: 'qwen-alice-preview' }), 'Single Discard Renamed');
    expectLandedInNewFolder(r, book);
    expect(existsSync(paths.castJsonPath(r.newDir))).toBe(true);
  });
});

describe('#3711 task 5 -- a deleted book answers 404 in each route family\'s own shape', () => {
  it('cast-create / revision-ops / chapter-audio / cover / script-review / qwen-voice on an unknown book', async () => {
    const ghost = 'ghost__standalones__ghost';
    expect((await request(app).post(`/api/books/${ghost}/cast/create`).send({ name: 'Zed' })).status).toBe(404);
    const rev = await request(app).post(`/api/books/${ghost}/revisions/r1/accept`).send({});
    expect(rev.status).toBe(404);
    expect(rev.body.error).toBe('book_not_found');
    expect((await request(app).post(`/api/books/${ghost}/chapters/1/audio/previous/restore-unrecorded`)).status).toBe(404);
    expect((await request(app).delete(`/api/books/${ghost}/cover`)).status).toBe(404);
    expect((await request(app).patch(`/api/books/${ghost}/cover/framing`).send({ offsetX: 0, offsetY: 0, zoom: 1 })).status).toBe(404);
    expect((await request(app).post(`/api/books/${ghost}/script-review/discard`).send({ chapterIds: [1] })).status).toBe(404);
    expect((await request(app).delete(`/api/books/${ghost}/cast/alice/emotion-variant/angry`)).status).toBe(404);
  });
});
