/* #3711 task 7 -- the book CREATORS (manuscript import, sample load, portable-bundle
   import) and the startup sweeps take part in the book-op / path-claim protocol:

     - a rename of A/S/T -> A/S/T2 followed by a fresh import of A/S/T never leaves
       two books with one bookId (`mintBookId` under the claim);
     - a sample keeps its deterministic id, and "already loaded" is decided by that
       id anywhere on disk, so a renamed sample is not copied in a second time;
     - a bundle whose id is already used elsewhere gets a minted one; an 'overwrite'
       keeps the existing id, is refused while a long job is registered, and is a
       conflict if the target stopped carrying that id while it queued;
     - the bundle is staged OUTSIDE `books/` and WITHOUT the claim;
     - `backgroundFetchCover`'s write and the startup sweeps run under book-op, on
       the folder the book lives in NOW.

   Event-based, never timer-based: a case that needs "X is queued on book-op" polls
   `__keyWaitersForTest`. */

import { describe, it, expect, beforeAll, afterAll, afterEach, beforeEach, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { ZipFile } from 'yazl';

vi.mock('../cover/search.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../cover/search.js')>();
  return { ...actual, firstAvailableCover: vi.fn() };
});

const { mkdtemp } = await import('node:fs/promises');

const AUTHOR = 'Creator Author';
const MANUSCRIPT_TEXT = '# Chapter One\n\nFirst sentence.\n\n# Chapter Two\n\nSecond sentence.\n';

let workspaceRoot: string;
let samplesRoot: string;
let app: Express;
let paths: typeof import('../workspace/paths.js');
let fileLock: typeof import('../workspace/file-lock.js');
let bookOp: typeof import('../workspace/book-op-lock.js');
let bookJobs: typeof import('../workspace/book-jobs.js');
let portable: typeof import('../import/scan-import-folder.js');
let samples: typeof import('./samples.js');

beforeAll(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'audiobook-book-op-creators-'));
  samplesRoot = await mkdtemp(join(tmpdir(), 'audiobook-book-op-creators-samples-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const [{ importRouter }, { bookStateRouter }, { samplesRouter }, { portableImportRouter }] = await Promise.all([
    import('./import.js'),
    import('./book-state.js'),
    import('./samples.js'),
    import('./exports-portable.js'),
  ]);
  paths = await import('../workspace/paths.js');
  fileLock = await import('../workspace/file-lock.js');
  bookOp = await import('../workspace/book-op-lock.js');
  bookJobs = await import('../workspace/book-jobs.js');
  portable = await import('../import/scan-import-folder.js');
  samples = await import('./samples.js');
  samples.setSamplesRoot(samplesRoot);
  app = express();
  app.use(express.json());
  app.use('/api', importRouter);
  app.use('/api/books', bookStateRouter);
  app.use('/api/samples', samplesRouter);
  app.use('/api/import', portableImportRouter);
});

afterAll(() => {
  samples._resetSamplesRoot();
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  if (samplesRoot) rmSync(samplesRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  rmSync(join(workspaceRoot, 'books'), { recursive: true, force: true });
  rmSync(join(workspaceRoot, '.staging'), { recursive: true, force: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(pred: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 8000;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const waiters = (key: string) => fileLock.__keyWaitersForTest(key);

/** Import a manuscript through the REAL two-step flow; resolves to the created book. */
async function importBook(title: string): Promise<{ bookId: string; status: number; body: Record<string, unknown> }> {
  const staged = await request(app).post('/api/import').send({ text: MANUSCRIPT_TEXT, fileName: 'm.md' });
  expect(staged.status).toBe(200);
  const res = await request(app)
    .post('/api/books')
    .send({ tempId: staged.body.tempId, author: AUTHOR, title, isStandalone: true, language: 'en' });
  return { bookId: res.body.bookId as string, status: res.status, body: res.body };
}

function rename(bookId: string, title: string) {
  return request(app).put(`/api/books/${bookId}/state`).send({ slice: 'state', patch: { title } });
}

function idsUnderBooks(): string[] {
  const out: string[] = [];
  const root = join(workspaceRoot, 'books');
  if (!existsSync(root)) return out;
  for (const a of readdirSync(root))
    for (const s of readdirSync(join(root, a)))
      for (const t of readdirSync(join(root, a, s))) {
        const p = join(root, a, s, t, '.audiobook', 'state.json');
        if (existsSync(p)) out.push((JSON.parse(readFileSync(p, 'utf8')) as { bookId: string }).bookId);
      }
  return out.sort();
}

function seedState(
  title: string,
  bookId: string,
  extra: Record<string, unknown> = {},
  author = AUTHOR,
): string {
  const dir = paths.bookDirByDisplay(author, paths.STANDALONES_SERIES, title);
  mkdirSync(join(dir, '.audiobook'), { recursive: true });
  writeFileSync(join(dir, 'manuscript.txt'), 'old manuscript');
  writeFileSync(
    paths.stateJsonPath(dir),
    JSON.stringify({
      bookId,
      manuscriptId: `mns_${bookId}`,
      title,
      author,
      series: paths.STANDALONES_SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [],
      coverGradient: ['#000', '#fff'],
      createdAt: '2025-01-01T00:00:00Z',
      updatedAt: '2025-01-01T00:00:00Z',
      ...extra,
    }),
  );
  return dir;
}

/** A minimal portable bundle (the layout buildPortableBundle writes). */
function makeBundle(state: Record<string, unknown>, manuscript = 'bundle manuscript'): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (c: Buffer) => chunks.push(c));
    zip.outputStream.on('end', () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on('error', reject);
    zip.addBuffer(Buffer.from(JSON.stringify({ schemaVersion: 1 })), 'MANIFEST.json');
    zip.addBuffer(Buffer.from(JSON.stringify(state)), 'state.json');
    zip.addBuffer(Buffer.from(manuscript), String(state.manuscriptFile));
    zip.addBuffer(Buffer.from('mp3'), 'audio/01-chapter-1.mp3');
    zip.end();
  });
}

function bundleState(title: string, bookId: string | undefined): Record<string, unknown> {
  return {
    ...(bookId ? { bookId } : {}),
    manuscriptId: 'mns_bundle',
    title,
    author: AUTHOR,
    series: paths.STANDALONES_SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: true,
    chapters: [{ id: 1, title: 'Chapter 1', slug: '01-chapter-1' }],
    coverGradient: ['#abc', '#def'],
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
  };
}

const stagingEntries = () => (existsSync(join(workspaceRoot, '.staging')) ? readdirSync(join(workspaceRoot, '.staging')) : []);

describe('#3711 -- manuscript import mints a unique bookId', () => {
  it('rename A/S/T -> T2, then import A/S/T: two books, two distinct ids, both resolve', async () => {
    const first = await importBook('Twin');
    expect(first.status).toBe(201);
    const renamed = await rename(first.bookId, 'Twin Renamed');
    expect(renamed.status).toBe(200);

    const second = await importBook('Twin');
    expect(second.status).toBe(201);

    expect(second.bookId).not.toBe(first.bookId);
    expect(second.bookId).toBe(`${first.bookId}-2`); // the title slug takes the suffix: parseBookId keeps 3 parts
    expect(idsUnderBooks()).toEqual([first.bookId, second.bookId].sort());
    const a = await bookOp.peekBook(first.bookId);
    const b = await bookOp.peekBook(second.bookId);
    expect(a?.bookDir).toBe(paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Twin Renamed'));
    expect(b?.bookDir).toBe(paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Twin'));
  });

  it('a plain import still gets the unsuffixed id, and a path collision is still 409 slug_collision', async () => {
    const first = await importBook('Plain');
    expect(first.bookId).toBe(paths.makeBookId(AUTHOR, paths.STANDALONES_SERIES, 'Plain'));
    const dup = await importBook('Plain');
    expect(dup.status).toBe(409);
    expect(dup.body.error).toBe('slug_collision');
    expect(idsUnderBooks()).toEqual([first.bookId]);
  });
});

describe('#3711 -- sample load detects "already loaded" by bookId anywhere on disk', () => {
  const SLUG = 'creator-sample';
  const SAMPLE_AUTHOR = 'Castwright';
  const SAMPLE_TITLE = 'The Coalfall Commission';
  /* The tour hardcodes this id (src/lib/tour-steps.ts). */
  const TOUR_ID = 'castwright__standalones__the-coalfall-commission';

  function seedSample(): void {
    const dir = join(samplesRoot, SLUG);
    mkdirSync(join(dir, '.audiobook'), { recursive: true });
    writeFileSync(join(dir, 'manuscript.md'), MANUSCRIPT_TEXT);
    writeFileSync(
      join(dir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId: 'ignored-by-load',
        title: SAMPLE_TITLE,
        author: SAMPLE_AUTHOR,
        series: paths.STANDALONES_SERIES,
        seriesPosition: null,
        isStandalone: true,
        manuscriptFile: 'manuscript.md',
        castConfirmed: true,
        chapters: [],
        coverGradient: ['#000', '#fff'],
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
      }),
    );
  }

  it('a renamed sample is alreadyLoaded: no second copy, and the tour id still resolves', async () => {
    seedSample();
    const loaded = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(loaded.status).toBe(200);
    expect(loaded.body).toMatchObject({ bookId: TOUR_ID, alreadyLoaded: false });

    const renamed = await rename(TOUR_ID, 'My Renamed Sample');
    expect(renamed.status).toBe(200);

    const again = await request(app).post(`/api/samples/${SLUG}/load`);
    expect(again.status).toBe(200);
    expect(again.body).toEqual({ bookId: TOUR_ID, alreadyLoaded: true });

    // Exactly one copy on disk, in the renamed folder; the original path stays free.
    expect(idsUnderBooks()).toEqual([TOUR_ID]);
    expect(existsSync(paths.bookDirByDisplay(SAMPLE_AUTHOR, paths.STANDALONES_SERIES, SAMPLE_TITLE))).toBe(false);
    expect((await bookOp.peekBook(TOUR_ID))?.bookDir).toBe(
      paths.bookDirByDisplay(SAMPLE_AUTHOR, paths.STANDALONES_SERIES, 'My Renamed Sample'),
    );
  });
});

describe('#3711 -- portable bundle import', () => {
  it('a bundle whose bookId is used elsewhere gets a minted id; a free one is kept', async () => {
    // "taken-id" lives at another path (a renamed book), so the bundle's path is free.
    seedState('Somewhere Else', 'creator-author__standalones__bundle-title');
    const clash = await portable.importPortableBundle(
      await makeBundle(bundleState('Bundle Title', 'creator-author__standalones__bundle-title')),
    );
    expect(clash.bookId).toBe('creator-author__standalones__bundle-title-2');
    const onDisk = JSON.parse(readFileSync(paths.stateJsonPath(clash.targetPath), 'utf8')) as { bookId: string };
    expect(onDisk.bookId).toBe(clash.bookId);

    const free = await portable.importPortableBundle(
      await makeBundle(bundleState('Free Title', 'a-free-bundle-id')),
    );
    expect(free.bookId).toBe('a-free-bundle-id');
    expect(new Set(idsUnderBooks()).size).toBe(idsUnderBooks().length); // no duplicate ids at all
  });

  it('a bundle without a bookId gets a minted one written to disk', async () => {
    const res = await portable.importPortableBundle(await makeBundle(bundleState('No Id Bundle', undefined)));
    expect(res.bookId).toBe(paths.makeBookId(AUTHOR, paths.STANDALONES_SERIES, 'No Id Bundle'));
    const onDisk = JSON.parse(readFileSync(paths.stateJsonPath(res.targetPath), 'utf8')) as { bookId: string };
    expect(onDisk.bookId).toBe(res.bookId);
  });

  it('stages outside books/ WITHOUT the path claim, then takes the claim only to place it', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let heldClaim!: () => void;
    const claimHeld = new Promise<void>((r) => (heldClaim = r));
    const holder = bookOp.withBookPathClaim(async () => {
      heldClaim();
      await gate;
    });
    await claimHeld;

    const imp = portable.importPortableBundle(await makeBundle(bundleState('Staged First', 'staged-first-id')));
    await waitUntil(() => waiters('book-path-claim') === 1, 'the import to queue on the path claim');
    // Everything is already staged (outside books/) while the claim is still held by someone else.
    const [nonce] = stagingEntries();
    expect(nonce).toBeTruthy();
    expect(existsSync(join(workspaceRoot, '.staging', nonce, 'manuscript.txt'))).toBe(true);
    expect(existsSync(join(workspaceRoot, '.staging', nonce, 'audio', '01-chapter-1.mp3'))).toBe(true);
    expect(idsUnderBooks()).toEqual([]);

    release();
    await holder;
    const res = await imp;
    expect(existsSync(join(res.targetPath, 'audio', '01-chapter-1.mp3'))).toBe(true);
    expect(stagingEntries()).toEqual([]); // the staged tree was RENAMED into place
  });

  it('a failed import (conflict strategy "fail") leaves no staging behind and no book', async () => {
    seedState('Dupe Target', 'dupe-id');
    await expect(
      portable.importPortableBundle(await makeBundle(bundleState('Dupe Target', 'x')), { onConflict: 'fail' }),
    ).rejects.toBeInstanceOf(portable.BundleConflictError);
    expect(stagingEntries()).toEqual([]);
    expect(idsUnderBooks()).toEqual(['dupe-id']);
  });

  describe('overwrite', () => {
    it('keeps the EXISTING bookId (not the bundle\'s) and replaces the files', async () => {
      const dir = seedState('Over Target', 'existing-id');
      writeFileSync(join(dir, 'listen-progress.json'), '{"keep":true}');
      const res = await portable.importPortableBundle(
        await makeBundle(bundleState('Over Target', 'bundle-id')),
        { onConflict: 'overwrite' },
      );
      expect(res.bookId).toBe('existing-id');
      expect(res.targetPath).toBe(dir);
      expect((JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8')) as { bookId: string }).bookId).toBe('existing-id');
      expect(readFileSync(join(dir, 'manuscript.txt'), 'utf8')).toBe('bundle manuscript');
      expect(readFileSync(join(dir, 'listen-progress.json'), 'utf8')).toBe('{"keep":true}'); // only-on-disk file left alone
      expect(stagingEntries()).toEqual([]);
    });

    it('is refused (BookBusyError, 409 book_busy via the route) while a long job is registered', async () => {
      const dir = seedState('Busy Target', 'busy-id');
      let finish!: () => void;
      const running = new Promise<void>((r) => (finish = r));
      const job = await bookJobs.runBookJob('busy-id', 'render', () => running);
      expect(job).not.toBe(bookOp.BOOK_GONE);

      await expect(
        portable.importPortableBundle(await makeBundle(bundleState('Busy Target', 'b')), { onConflict: 'overwrite' }),
      ).rejects.toBeInstanceOf(bookOp.BookBusyError);
      const res = await request(app)
        .post('/api/import/portable?onConflict=overwrite')
        .attach('file', await makeBundle(bundleState('Busy Target', 'b')), 'b.zip');
      expect(res.status).toBe(409);
      expect(res.body).toMatchObject({ code: 'book_busy' });
      // Nothing changed, nothing left staged.
      expect(readFileSync(join(dir, 'manuscript.txt'), 'utf8')).toBe('old manuscript');
      expect(stagingEntries()).toEqual([]);

      finish();
      if (job !== bookOp.BOOK_GONE) await job.done;
      const ok = await portable.importPortableBundle(await makeBundle(bundleState('Busy Target', 'b')), {
        onConflict: 'overwrite',
      });
      expect(ok.bookId).toBe('busy-id');
    });

    it('whose target stopped carrying that id while it queued is a BundleConflictError, and nothing is overwritten', async () => {
      const dir = seedState('Swap Target', 'orig-id');
      let queuedError: unknown;
      let imp!: Promise<unknown>;
      await bookOp.withBookOp('orig-id', async (book) => {
        imp = portable
          .importPortableBundle(await makeBundle(bundleState('Swap Target', 'b')), { onConflict: 'overwrite' })
          .catch((e) => {
            queuedError = e;
          });
        await waitUntil(() => waiters('book-op:orig-id') === 1, 'the overwrite to queue on book-op(orig-id)');
        // While it queues: the original book moves away, and a DIFFERENT book takes its path.
        await bookOp.moveBookFolder(
          book,
          paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Swap Moved'),
          (fresh) => ({ ...fresh, title: 'Swap Moved' }),
        );
        seedState('Swap Target', 'newcomer-id');
      });
      await imp;
      expect(queuedError).toBeInstanceOf(portable.BundleConflictError);
      expect(readFileSync(join(dir, 'manuscript.txt'), 'utf8')).toBe('old manuscript'); // the newcomer is untouched
      expect(stagingEntries()).toEqual([]);
    });

    it('whose book vanished while it queued falls back to a fresh import', async () => {
      const dir = seedState('Gone Target', 'gone-id');
      let imp!: Promise<Awaited<ReturnType<typeof portable.importPortableBundle>>>;
      await bookOp.withBookOp('gone-id', async (book) => {
        imp = portable.importPortableBundle(await makeBundle(bundleState('Gone Target', 'fresh-bundle-id')), {
          onConflict: 'overwrite',
        });
        await waitUntil(() => waiters('book-op:gone-id') === 1, 'the overwrite to queue on book-op(gone-id)');
        await bookOp.removeBookFolder(book);
      });
      const res = await imp;
      expect(res.targetPath).toBe(dir);
      expect(res.bookId).toBe('fresh-bundle-id'); // a NEW book, so the bundle's own id is kept
      expect(readFileSync(join(dir, 'manuscript.txt'), 'utf8')).toBe('bundle manuscript');
    });
  });
});

describe('#3711 -- backgroundFetchCover writes under book-op, into the folder the book lives in NOW', () => {
  it('a cover fetched after a rename lands in the new folder (the old folder is not recreated)', async () => {
    const created = await importBook('Cover Book');
    const oldDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Cover Book');
    const newDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Cover Book Renamed');

    const search = await import('../cover/search.js');
    let finishSearch!: () => void;
    const searchGate = new Promise<void>((r) => (finishSearch = r));
    vi.mocked(search.firstAvailableCover).mockImplementation(async () => {
      await searchGate;
      return { id: 'apple:1', source: 'apple', coverUrl: 'https://x/c.jpg' } as never;
    });
    const sharp = (await import('sharp')).default;
    const jpeg = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#123' } }).jpeg().toBuffer();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(jpeg), { status: 200, headers: { 'Content-Type': 'image/jpeg' } })),
    );

    const { backgroundFetchCover } = await import('../cover/store.js');
    const done = backgroundFetchCover(oldDir, 'Cover Book', AUTHOR, created.bookId);
    const renamed = await rename(created.bookId, 'Cover Book Renamed'); // the fetch is still "in flight"
    expect(renamed.status).toBe(200);
    finishSearch();
    await done;
    vi.unstubAllGlobals();

    expect(existsSync(oldDir)).toBe(false);
    expect(existsSync(join(newDir, '.audiobook', 'cover.jpg'))).toBe(true);
    const state = JSON.parse(readFileSync(paths.stateJsonPath(newDir), 'utf8')) as { coverImage?: { candidateId: string } };
    expect(state.coverImage?.candidateId).toBe('apple:1');
  });
});

describe('#3711 -- the startup sweeps run per book under book-op', () => {
  /** Hold book-op, queue `sweep`, move the book while it queues, release, await. */
  async function sweepQueuedBehindRename(
    bookId: string,
    newTitle: string,
    sweep: () => Promise<unknown>,
  ): Promise<string> {
    const newDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, newTitle);
    let swept!: Promise<unknown>;
    await bookOp.withBookOp(bookId, async (book) => {
      swept = sweep();
      await waitUntil(() => waiters(`book-op:${bookId}`) === 1, 'the sweep to queue on book-op');
      await bookOp.moveBookFolder(book, newDir, (fresh) => ({ ...fresh, title: newTitle }));
    });
    await swept;
    return newDir;
  }

  it('migrateLegacyChangeLogs queued behind a rename migrates the log in the MOVED folder', async () => {
    const created = await importBook('Log Book');
    const oldDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Log Book');
    writeFileSync(paths.changeLogJsonPath(oldDir), JSON.stringify([{ type: 'chapter_complete' }]));
    const { migrateLegacyChangeLogs } = await import('../workspace/changelog-migrate.js');

    const newDir = await sweepQueuedBehindRename(created.bookId, 'Log Book Renamed', migrateLegacyChangeLogs);

    expect(existsSync(oldDir)).toBe(false); // the vacated path was NOT recreated
    expect(existsSync(join(paths.dotAudiobook(newDir), 'change-log.legacy.json'))).toBe(true);
    expect(JSON.parse(readFileSync(paths.changeLogJsonPath(newDir), 'utf8'))).toEqual({ events: [] });
  });

  it('fsckAllBooks queued behind a rename promotes the preserved take in the MOVED folder', async () => {
    const created = await importBook('Fsck Book');
    const oldDir = paths.bookDirByDisplay(AUTHOR, paths.STANDALONES_SERIES, 'Fsck Book');
    writeFileSync(join(paths.audioDir(oldDir), '01-x.previous.mp3'), 'prev');
    const { fsckAllBooks } = await import('../workspace/fsck-orphan-audio.js');

    const newDir = await sweepQueuedBehindRename(created.bookId, 'Fsck Book Renamed', fsckAllBooks);

    expect(existsSync(oldDir)).toBe(false);
    expect(readFileSync(join(paths.audioDir(newDir), '01-x.mp3'), 'utf8')).toBe('prev');
  });

  it('a book whose state.json has no bookId is swept unlocked, on its own folder', async () => {
    const dir = seedState('No Id Book', 'will-be-removed');
    const raw = JSON.parse(readFileSync(paths.stateJsonPath(dir), 'utf8')) as Record<string, unknown>;
    delete raw.bookId;
    writeFileSync(paths.stateJsonPath(dir), JSON.stringify(raw));
    writeFileSync(paths.changeLogJsonPath(dir), JSON.stringify([{ type: 'chapter_complete' }]));
    const { migrateLegacyChangeLogs } = await import('../workspace/changelog-migrate.js');
    const result = await migrateLegacyChangeLogs();
    expect(result.migrated).toEqual([dir]);
    expect(existsSync(join(paths.dotAudiobook(dir), 'change-log.legacy.json'))).toBe(true);
  });
});
