/* #4320 step 1 (#4825) — the per-slug take journal's file layer (spec
   2026-11-13-chapter-take-lifecycle-design.md §5.A "Commit" step 3, "Journal
   rules"; R6-3, R7-1, R7-4, R7-8, R8-4). WORKSPACE_DIR is pointed at a tempdir
   BEFORE the modules load (paths.ts caches it at import). Handles come from a
   real `withBookOp` / `withBookOpAtDir` over a seeded book. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { TakeJournal } from './chapter-take.js';

/* Read fault injection: pass-through unless a test arms it for one path. */
const faults = vi.hoisted(() => ({ read: null as null | { path: string; error: Error } }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    if (faults.read && args[0] === faults.read.path) throw faults.read.error;
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, readFile, default: { ...actual, readFile } };
});

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let bookLock: typeof import('./book-lock.js');
let dirKey: typeof import('./book-dir-key.js');
let paths: typeof import('./paths.js');

const SLUG = 'ch-01';
const JID = 'aaaaaaaaaaaaaaaa';
const OTHER_JID = 'bbbbbbbbbbbbbbbb';
let seq = 0;

interface Seeded {
  bookId: string;
  bookDir: string;
  audio: string;
}

function seedBook(opts: { addressed?: boolean; audio?: boolean } = {}): Seeded {
  seq += 1;
  const title = `Journal Book ${seq}`;
  const bookId = paths.makeBookId('Taker', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Taker', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  if (opts.audio !== false) mkdirSync(audio, { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      ...(opts.addressed === false ? {} : { bookId }),
      manuscriptId: `ms-journal-${seq}`,
      title,
      author: 'Taker',
      series: 'Ser',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'One', slug: SLUG }],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  return { bookId, bookDir, audio };
}

/** A commit journal with every field populated. */
function journal(over: Partial<TakeJournal> = {}): TakeJournal {
  return {
    op: 'commit',
    jid: JID,
    phase: 'discard',
    newTakeId: 'cccccccccccccccc',
    liveTakeId: 'dddddddddddddddd',
    prevTakeId: null,
    keepPrevious: false,
    parts: {
      live: [
        { part: 'audio', ext: 'mp3', size: 1234 },
        { part: 'segments', size: 56 },
      ],
      previous: [
        { part: 'audio', ext: 'm4a', size: 789 },
        { part: 'embeddings', size: 0 },
      ],
      staged: [
        { part: 'audio', ext: 'ogg', size: 4321 },
        { part: 'verdicts', size: 7 },
        { part: 'attempted', size: 8 },
      ],
    },
    chapter: { id: 1, slug: SLUG, uuid: 'uuid-1' },
    clearGenerationState: true,
    review: { characterId: 'narrator', triggeredBy: 'voice-change' },
    preserved: true,
    oldDuration: '01:01',
    newDuration: '01:05',
    entry: {
      takeId: 'cccccccccccccccc',
      renderedAt: '2026-02-02T00:00:00.000Z',
      previousTakeId: 'dddddddddddddddd',
      previousRenderedAt: '2026-01-01T00:00:00.000Z',
    },
    supersedes: [
      { jid: 'eeeeeeeeeeeeeeee', discards: [`${SLUG}.discard-eeeeeeeeeeeeeeee.prev.mp3`], dropEntry: true },
      { jid: 'ffffffffffffffff', discards: [], dropEntry: false },
    ],
    lost: [
      {
        take: 'previous',
        part: 'peaks',
        basenames: [`${SLUG}.previous.peaks.json`, `${SLUG}.discard-${JID}.prev.peaks.json`],
      },
      { take: 'live', part: 'audio', ext: 'mp3', basenames: [`${SLUG}.mp3`] },
    ],
    ...over,
  };
}

async function withHandle<T>(book: Seeded, fn: (h: import('./book-op-lock.js').BookHandle) => Promise<T>): Promise<T> {
  const out = await lock.withBookOp(book.bookId, fn);
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out;
}

/** Write `body` (text as-is, anything else as JSON) under a journal's name. */
function plant(book: Seeded, body: unknown, jid = JID, slug = SLUG): string {
  const path = take.takeJournalPath(book.audio, slug, jid);
  writeFileSync(path, typeof body === 'string' ? body : JSON.stringify(body));
  return path;
}

/** Hold `book`:`key` from a separate async context until `release()`. */
async function holdBookLock(key: string): Promise<{ release: () => Promise<void> }> {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  let entered!: () => void;
  const held = new Promise<void>((resolve) => (entered = resolve));
  const holder = bookLock.withBookLock(key, async () => {
    entered();
    await gate;
  });
  await held;
  return {
    release: async () => {
      open();
      await holder;
    },
  };
}

const pause = () => new Promise((resolve) => setTimeout(resolve, 100));

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-take-journal-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [take, lock, bookLock, dirKey, paths] = await Promise.all([
    import('./chapter-take.js'),
    import('./book-op-lock.js'),
    import('./book-lock.js'),
    import('./book-dir-key.js'),
    import('./paths.js'),
  ]);
});

afterEach(() => {
  faults.read = null;
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('journal names and ids', () => {
  it('mints filename-safe ids from the take-id alphabet, fresh each time', () => {
    const ids = Array.from({ length: 50 }, () => take.mintJournalId());
    for (const id of ids) expect(id).toMatch(/^[a-z2-7]{16}$/);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('builds <slug>.take-journal.<jid>.json and parses it back, a dotted slug included', () => {
    const path = take.takeJournalPath('root', 'ch.1', JID);
    expect(path).toBe(join('root', `ch.1.take-journal.${JID}.json`));
    expect(take.parseTakeJournalName(`ch.1.take-journal.${JID}.json`)).toEqual({ slug: 'ch.1', jid: JID });
  });

  it.each([
    `${SLUG}.segments.json`,
    `${SLUG}.take-journal.json`,
    `${SLUG}.take-journal.short.json`,
    `${SLUG}.take-journal.${JID}.json.tmp-1-2`,
    `${SLUG}.take-journal.${JID}.json.stale`,
    `.take-journal.${JID}.json`,
    `.take-journal.relabel.${JID}.json`,
  ])('parses %s as no per-slug journal', (name) => {
    expect(take.parseTakeJournalName(name)).toBeNull();
  });
});

describe('writeTakeJournal / readTakeJournal', () => {
  it('round-trips every field: part sizes, supersedes as a list, lost, review and entry', async () => {
    const book = seedBook();
    const written = journal();
    const path = await withHandle(book, (h) => take.writeTakeJournal(h, SLUG, written));
    expect(path).toBe(join(book.audio, `${SLUG}.take-journal.${JID}.json`));
    expect(await take.readTakeJournal(path)).toStrictEqual({ kind: 'ok', journal: written });
  });

  it.each([
    ['a replace journal with no entry', { op: 'replace', entry: null, review: null, supersedes: [], lost: [] }],
    ['id-less takes', { liveTakeId: null, entry: { takeId: 'cccccccccccccccc', renderedAt: 'r', previousTakeId: null, previousRenderedAt: null } }],
    ['a chapter with no uuid', { chapter: { id: 1, slug: SLUG } }],
  ] as Array<[string, Partial<TakeJournal>]>)('round-trips %s', async (_name, over) => {
    const book = seedBook();
    const written = journal(over);
    const path = await withHandle(book, (h) => take.writeTakeJournal(h, SLUG, written));
    expect(await take.readTakeJournal(path)).toStrictEqual({ kind: 'ok', journal: written });
  });

  it('keeps an absent review absent (leave the review state alone) apart from null (drop the entry)', async () => {
    const book = seedBook();
    const path = await withHandle(book, (h) => take.writeTakeJournal(h, SLUG, journal({ review: undefined })));
    const read = await take.readTakeJournal(path);
    expect(read.kind).toBe('ok');
    expect(Object.keys(JSON.parse(readFileSync(path, 'utf8')))).not.toContain('review');
  });

  it('rewrites the one file at the next phase and leaves no temp file', async () => {
    const book = seedBook();
    const path = await withHandle(book, async (h) => {
      await take.writeTakeJournal(h, SLUG, journal());
      return take.writeTakeJournal(h, SLUG, journal({ phase: 'installed' }));
    });
    expect(readdirSync(book.audio)).toEqual([`${SLUG}.take-journal.${JID}.json`]);
    const read = await take.readTakeJournal(path);
    expect(read.kind === 'ok' && read.journal.phase).toBe('installed');
  });

  it('reads a journal that carries a UTF-8 BOM', async () => {
    const book = seedBook();
    const path = plant(book, `﻿${JSON.stringify(journal())}`);
    expect((await take.readTakeJournal(path)).kind).toBe('ok');
  });

  it.each([
    ['another slug', 'ch-02', journal()],
    ['an invalid journal', SLUG, journal({ op: 'restore' as TakeJournal['op'] })],
  ])('refuses to write %s, leaving audio/ empty', async (_name, slug, bad) => {
    const book = seedBook();
    await expect(withHandle(book, (h) => take.writeTakeJournal(h, slug, bad))).rejects.toThrow(
      /refusing to write a take journal/,
    );
    expect(readdirSync(book.audio)).toEqual([]);
  });

  it('refuses a handle that is no longer held', async () => {
    const book = seedBook();
    const stale = await withHandle(book, async (h) => h);
    await expect(take.writeTakeJournal(stale, SLUG, journal())).rejects.toThrow(/not held/);
    expect(readdirSync(book.audio)).toEqual([]);
  });
});

describe('readTakeJournal: unparseable', () => {
  const without = (field: keyof TakeJournal): Record<string, unknown> => {
    const copy: Record<string, unknown> = { ...journal() };
    delete copy[field];
    return copy;
  };

  async function expectUnparseable(body: unknown): Promise<string> {
    const book = seedBook();
    const read = await take.readTakeJournal(plant(book, body));
    expect(read.kind).toBe('unparseable');
    return read.kind === 'unparseable' ? read.reason : '';
  }

  it.each([
    ['non-JSON bytes', 'not json {'],
    ['an empty file', ''],
    ['a truncated journal', JSON.stringify(journal()).slice(0, 40)],
    ['JSON null', 'null'],
    ['a JSON array', '[]'],
  ])('%s', async (_name, body) => {
    await expectUnparseable(body);
  });

  it('a wrong op, naming the field', async () => {
    expect(await expectUnparseable({ ...journal(), op: 'restore' })).toContain('"op"');
  });

  it('a missing phase, naming the field', async () => {
    expect(await expectUnparseable(without('phase'))).toContain('"phase"');
  });

  /* `review` is the one optional member. */
  it.each(Object.keys(journal()).filter((k) => k !== 'review') as Array<keyof TakeJournal>)(
    'a journal with no %s',
    async (field) => {
      expect(await expectUnparseable(without(field))).toContain(`"${field}"`);
    },
  );

  const withPart = (part: unknown) => ({ ...journal(), parts: { live: [part], previous: [], staged: [] } });

  it.each([
    ['an unknown phase', { phase: 'promote' }],
    ['a newTakeId that is not a take id', { newTakeId: '../x' }],
    ['a part with no size', withPart({ part: 'segments' })],
    ['a part with a negative size', withPart({ part: 'segments', size: -1 })],
    ['an audio part with no extension', withPart({ part: 'audio', size: 1 })],
    ['an unknown part', withPart({ part: 'cover', size: 1 })],
    ['parts missing a take', { parts: { live: [], previous: [] } }],
    ['supersedes as a single object', { supersedes: { jid: OTHER_JID, discards: [], dropEntry: false } }],
    ['a superseded discard that names a path', { supersedes: [{ jid: OTHER_JID, discards: ['../state.json'], dropEntry: false }] }],
    ['a lost part with no take', { lost: [{ part: 'peaks', basenames: [] }] }],
    ['a chapter slug that names a path', { chapter: { id: 1, slug: 'a/b' } }],
    ['a review with no characterId', { review: { triggeredBy: 'x' } }],
    ['an entry with no previousRenderedAt', { entry: { takeId: 't', renderedAt: 'r', previousTakeId: null } }],
    ['a clearGenerationState that is not true', { clearGenerationState: false }],
    ['a jid that disagrees with the file name', { jid: OTHER_JID }],
    ['a chapter slug that disagrees with the file name', { chapter: { id: 1, slug: 'ch-02' } }],
  ])('%s', async (_name, over) => {
    await expectUnparseable({ ...journal(), ...over });
  });
});

describe('readTakeJournal: unreadable is not unparseable (R6-3, R7-4)', () => {
  it.each(['EBUSY', 'EPERM', 'EIO'])('a read that throws %s propagates', async (code) => {
    const book = seedBook();
    const path = plant(book, journal());
    faults.read = { path, error: Object.assign(new Error(`${code}: injected`), { code }) };
    await expect(take.readTakeJournal(path)).rejects.toMatchObject({ code });
  });

  it('a missing file propagates ENOENT', async () => {
    const book = seedBook();
    await expect(
      take.readTakeJournal(take.takeJournalPath(book.audio, SLUG, JID)),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('listTakeJournals', () => {
  it('groups two journals of one slug, keeps slugs apart and sorts the other names by kind', async () => {
    const book = seedBook();
    const names = {
      journals: [
        `${SLUG}.take-journal.${OTHER_JID}.json`,
        `${SLUG}.take-journal.${JID}.json`,
        `ch-02.take-journal.${JID}.json`,
      ],
      otherJournals: [`.take-journal.relabel.${JID}.json`],
      next: [`${SLUG}.next-cccccccccccccccc.mp3`],
      discard: [`${SLUG}.discard-${JID}.live.mp3`, `${SLUG}.discard-${JID}.stale.m4a`],
      tmp: [`${SLUG}.take-journal.${JID}.json.tmp-12-34-1-abcd`, `${SLUG}.next-cccccccccccccccc.mp3.tmp-12-34`],
      stale: [`${SLUG}.mp3.stale`],
      relabelTemp: [`${SLUG}.relabel-${JID}-0.mp3`],
      ignored: [`${SLUG}.mp3`, `${SLUG}.segments.json`, `${SLUG}.previous.m4a`, 'notes.txt'],
    };
    for (const name of Object.values(names).flat()) writeFileSync(join(book.audio, name), 'x');
    mkdirSync(join(book.audio, '.orphaned'));

    const listing = await withHandle(book, (h) => take.listTakeJournals(h));

    expect(listing.audioRoot).toBe(book.audio);
    expect([...listing.journals.keys()].sort()).toEqual(['ch-01', 'ch-02']);
    expect(listing.journals.get(SLUG)).toEqual(
      [JID, OTHER_JID].map((jid) => ({ slug: SLUG, jid, path: take.takeJournalPath(book.audio, SLUG, jid) })),
    );
    expect(listing.journals.get('ch-02')).toHaveLength(1);
    for (const kind of ['otherJournals', 'next', 'discard', 'tmp', 'stale', 'relabelTemp'] as const) {
      expect(listing[kind], kind).toEqual([...names[kind]].sort());
    }
  });

  it('answers an empty listing when audio/ is absent, and does not create it', async () => {
    const book = seedBook({ audio: false });
    const listing = await withHandle(book, (h) => take.listTakeJournals(h));
    expect(listing.journals.size).toBe(0);
    expect([listing.otherJournals, listing.next, listing.discard, listing.tmp, listing.stale, listing.relabelTemp]).toEqual(
      [[], [], [], [], [], []],
    );
    expect(existsSync(book.audio)).toBe(false);
  });

  it('propagates any other readdir error', async () => {
    const book = seedBook({ audio: false });
    writeFileSync(book.audio, 'a file where the directory belongs');
    await expect(withHandle(book, (h) => take.listTakeJournals(h))).rejects.toMatchObject({ code: 'ENOTDIR' });
  });

  it('refuses a handle that is no longer held', async () => {
    const book = seedBook();
    const stale = await withHandle(book, async (h) => h);
    await expect(take.listTakeJournals(stale)).rejects.toThrow(/not held/);
  });
});

describe('unlinkTakeJournal takes book (R7-1, R8-4)', () => {
  it('keys an addressed handle by its bookId', async () => {
    const book = seedBook();
    expect(await withHandle(book, async (h) => take.bookLockKeyFor(h))).toBe(book.bookId);
  });

  it('waits for a book lock another caller holds on the same key', async () => {
    const book = seedBook();
    const path = plant(book, journal());
    const holder = await holdBookLock(book.bookId);
    let done = false;
    const unlinking = withHandle(book, async (h) => {
      await take.unlinkTakeJournal(h, path);
      done = true;
    });
    await pause();
    expect(existsSync(path)).toBe(true);
    expect(done).toBe(false);
    await holder.release();
    await unlinking;
    expect(existsSync(path)).toBe(false);
  });

  it('treats a missing journal as success', async () => {
    const book = seedBook();
    const path = take.takeJournalPath(book.audio, SLUG, JID);
    await expect(withHandle(book, (h) => take.unlinkTakeJournal(h, path))).resolves.toBeUndefined();
  });

  it('refuses a handle that is no longer held, leaving the journal', async () => {
    const book = seedBook();
    const path = plant(book, journal());
    const stale = await withHandle(book, async (h) => h);
    await expect(take.unlinkTakeJournal(stale, path)).rejects.toThrow(/not held/);
    expect(existsSync(path)).toBe(true);
  });

  it('keys an unaddressed handle by the canonical directory, however it is spelt, for its whole life', async () => {
    const book = seedBook({ addressed: false });
    const caseFolds = process.platform === 'win32' || process.platform === 'darwin';
    /* A different spelling of the same folder: case where the filesystem folds
       it, doubled and trailing separators everywhere. */
    const respelt = `${(caseFolds ? book.bookDir.toUpperCase() : book.bookDir).split(sep).join(`${sep}${sep}`)}${sep}`;
    const canonical = dirKey.canonicalDirKey(book.bookDir);
    const path = plant(book, journal());
    const holder = await holdBookLock(canonical);

    let keyBefore = '';
    let keyAfter = '';
    let unlinked = false;
    const sweep = lock.withBookOpAtDir(respelt, async (h) => {
      expect('kind' in h).toBe(true);
      expect(h.bookDir).not.toBe(book.bookDir);
      keyBefore = take.bookLockKeyFor(h);
      /* The bundle overwrite's swap gives the book an id while the handle is held. */
      const statePath = join(book.bookDir, '.audiobook', 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
      writeFileSync(statePath, JSON.stringify({ ...state, bookId: book.bookId }));
      keyAfter = take.bookLockKeyFor(h);
      await take.unlinkTakeJournal(h, path);
      unlinked = true;
    });
    await pause();
    expect(existsSync(path)).toBe(true);
    expect(unlinked).toBe(false);
    await holder.release();
    expect(await sweep).not.toBe(lock.BOOK_GONE);

    expect(keyBefore).toBe(canonical);
    expect(keyAfter).toBe(canonical);
    expect(existsSync(path)).toBe(false);
  });
});
