/* #4320 step 8 (#4832) - the Sweep (D4), `reconcileBook` and the boot fsck's use
   of both (spec 2026-11-13-chapter-take-lifecycle-design.md §5.A "Sweep (D4)",
   "Ownership"; owner scope addition of 2026-11-19: the orphan
   `<slug>.previous.segments.json` and the `<name>.stale` files are quarantined).
   WORKSPACE_DIR is pointed at a tempdir BEFORE the modules load (paths.ts caches
   it at import). Real files, real handles. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import express from 'express';
import request from 'supertest';
import type { TakeJournal } from './chapter-take.js';

/* Fault injection, pass-through unless a test arms it: a returned error is
   thrown in the call's place. `stamp` is thrown by `updateStateAtDir`. */
const faults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Error | undefined),
  read: null as null | ((path: string) => Error | undefined),
  stat: null as null | ((path: string) => Error | undefined),
  stamp: null as null | Error,
}));
vi.mock('./atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-rename.js')>();
  return {
    ...actual,
    renameWithRetry: async (from: string, to: string) => {
      const error = faults.rename?.(from, to);
      if (error) throw error;
      await actual.renameWithRetry(from, to);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const error = faults.read?.(String(args[0]));
    if (error) throw error;
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  const stat = (async (...args: Parameters<typeof actual.stat>) => {
    const error = faults.stat?.(String(args[0]));
    if (error) throw error;
    return actual.stat(...args);
  }) as typeof actual.stat;
  return { ...actual, readFile, stat, default: { ...actual, readFile, stat } };
});
vi.mock('./book-state-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./book-state-update.js')>();
  return {
    ...actual,
    updateStateAtDir: async (...args: Parameters<typeof actual.updateStateAtDir>) => {
      if (faults.stamp) throw faults.stamp;
      return actual.updateStateAtDir(...args);
    },
  };
});

vi.setConfig({ testTimeout: 60_000 });

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let fsck: typeof import('./fsck-orphan-audio.js');
let scan: typeof import('./scan.js');
let bookState: typeof import('../routes/book-state.js');

const SLUG = 'ch-1';
/* A slug the first one is a prefix of. */
const OTHER = 'ch-10';
const ID = 'abcdefghijklmnop';
const JID = 'qrstuvwxyz234567';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]);
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'take-sweep-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  take = await import('./chapter-take.js');
  lock = await import('./book-op-lock.js');
  paths = await import('./paths.js');
  fsck = await import('./fsck-orphan-audio.js');
  scan = await import('./scan.js');
  bookState = await import('../routes/book-state.js');
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  faults.rename = null;
  faults.read = null;
  faults.stat = null;
  faults.stamp = null;
  vi.restoreAllMocks();
  rmSync(paths.BOOKS_ROOT, { recursive: true, force: true });
});

/* ---- fixtures -------------------------------------------------------------- */

interface Seeded {
  bookId: string;
  bookDir: string;
  audio: string;
  title: string;
}

function seedBook(slugs: string[] = [SLUG]): Seeded {
  seq += 1;
  const title = `Sweep Book ${seq}`;
  const bookId = paths.makeBookId('Sweeper', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Sweeper', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-sweep-${seq}`,
      title,
      author: 'Sweeper',
      series: 'Ser',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: slugs.map((slug, i) => ({ id: i + 1, title: `Chapter ${i + 1}`, slug })),
      coverGradient: ['#000', '#fff'],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  return { bookId, bookDir, audio, title };
}

/** Write each name into `audio/` with bytes that identify it. */
function put(book: Seeded, ...names: string[]): void {
  for (const name of names) writeFileSync(join(book.audio, name), `bytes of ${name}`);
}
const has = (book: Seeded, name: string): boolean => existsSync(join(book.audio, name));
/** Every file under `audio/`, `.orphaned/` included: relative name -> text. */
function files(book: Seeded): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(dir, e.name), 'utf8');
    }
  };
  walk(book.audio, '');
  return out;
}
/** `.orphaned/`: event folder -> the names in it, sorted. */
function events(book: Seeded): Record<string, string[]> {
  const root = join(book.audio, '.orphaned');
  if (!existsSync(root)) return {};
  return Object.fromEntries(readdirSync(root).map((e) => [e, readdirSync(join(root, e)).sort()]));
}
/** The quarantined names, asserting they share ONE dated event folder and hold
    the bytes `put` wrote. */
function quarantined(book: Seeded): string[] {
  const found = Object.entries(events(book));
  if (found.length === 0) return [];
  expect(found).toHaveLength(1);
  const [event, names] = found[0];
  expect(event).toMatch(/^\d{4}-\d{2}-\d{2}-[a-z2-7]{16}$/);
  for (const name of names) {
    expect(readFileSync(join(book.audio, '.orphaned', event, name), 'utf8')).toBe(`bytes of ${name}`);
    expect(has(book, name)).toBe(false);
  }
  return names;
}

async function inSpan<T>(
  book: Seeded,
  fn: (handle: import('./book-op-lock.js').BookHandle) => Promise<T>,
): Promise<T> {
  const out = await lock.withBookOp(book.bookId, fn);
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out as T;
}
const reconcile = (book: Seeded, slug = SLUG, opts?: Parameters<typeof take.reconcileSlug>[2]) =>
  inSpan(book, (h) => take.reconcileSlug(h, slug, opts));
const sweep = (book: Seeded, slug = SLUG) =>
  inSpan(book, async (h) => take.sweepSlug(h, slug, await take.listTakeJournals(h)));
const reconcileBook = (book: Seeded, touches: readonly string[] | 'book-wide' = 'book-wide') =>
  inSpan(book, async (h) => take.reconcileBook(h, await take.listTakeJournals(h), { touches }));

const fsError = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

function writeRealMp3(path: string, sec: number): void {
  const r = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=180:duration=${sec}`, '-ar', '8000', '-ac', '1', '-b:a', '16k', path],
    { windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`ffmpeg failed: ${String(r.stderr)}`);
}

function journal(phase: TakeJournal['phase'], over: Partial<TakeJournal> = {}): TakeJournal {
  return {
    op: 'commit',
    jid: JID,
    phase,
    newTakeId: ID,
    liveTakeId: null,
    prevTakeId: null,
    keepPrevious: false,
    parts: { live: [], previous: [], staged: [] },
    chapter: { id: 1, slug: SLUG },
    clearGenerationState: true,
    preserved: false,
    oldDuration: '',
    newDuration: '0:20',
    entry: null,
    supersedes: [],
    lost: [],
    ...over,
  };
}
const JOURNAL_NAME = `${SLUG}.take-journal.${JID}.json`;

/* One orphan of every kind the sweep handles, for `slug`. */
const orphans = (slug: string) => ({
  unlinked: [
    `${slug}.next-${ID}.mp3`,
    `${slug}.next-${ID}.segments.json`,
    `${slug}.mp3.tmp-4167-1700000000000`,
    `${slug}.segments.json.tmp-4167-1700000000000-3-0a1b2c3d`,
  ],
  quarantined: [
    `${slug}.discard-${JID}.prev.mp3`,
    `${slug}.discard-${JID}.live.segments.json`,
    `${slug}.relabel-${JID}-0.mp3`,
    `${slug}.mp3.stale`,
    `${slug}.previous.segments.json`,
  ],
});

/* ---- the sweep ------------------------------------------------------------- */

describe('the sweep, through reconcileSlug', () => {
  it('unlinks an orphan .next-* part, never quarantining it', async () => {
    const book = seedBook();
    put(book, `${SLUG}.next-${ID}.mp3`, `${SLUG}.next-${ID}.segments.json`);

    await reconcile(book);

    expect(files(book)).toEqual({});
  });

  it('keeps the parts of a take still in liveStaging, and unlinks them once it is released', async () => {
    const book = seedBook();
    const staged = await take.prepareTake(
      { bookDir: book.bookDir },
      { slug: SLUG, ext: 'mp3', audio: MP3, segments: { durationSec: 1, synthesizedAt: 'T', segments: [] } as never },
      new AbortController().signal,
    );
    const tmp = `${SLUG}.next-${staged.takeId}.embeddings.json.tmp-4167-1700000000000`;
    put(book, tmp, `${SLUG}.next-${ID}.mp3`);
    const kept = [...staged.parts.map((p) => basename(p.path)), tmp].sort();

    await reconcile(book);
    expect(Object.keys(files(book)).sort()).toEqual(kept);

    take.releaseStaging(staged.takeId);
    await reconcile(book);
    expect(files(book)).toEqual({});
  });

  it('unlinks a *.tmp-<pid>-<ts> leftover of any take name, a journal write included', async () => {
    const book = seedBook();
    put(
      book,
      `${SLUG}.mp3.tmp-4167-1700000000000`,
      `${SLUG}.previous.segments.json.tmp-4167-1700000000000-1-0a1b2c3d`,
      `${JOURNAL_NAME}.tmp-4167-1700000000000-2-0a1b2c3d`,
    );

    await reconcile(book);

    expect(files(book)).toEqual({});
  });

  it('leaves a name that only looks temporary', async () => {
    const book = seedBook();
    put(book, `${SLUG}.mp3.tmp-notes`);

    await reconcile(book);

    expect(has(book, `${SLUG}.mp3.tmp-notes`)).toBe(true);
  });

  it('quarantines a journal-less .discard-* part into one event folder, byte-identical', async () => {
    const book = seedBook();
    const names = [`${SLUG}.discard-${JID}.live.segments.json`, `${SLUG}.discard-${JID}.prev.mp3`];
    put(book, ...names);

    await reconcile(book);

    expect(quarantined(book)).toEqual(names);
  });

  it('quarantines an orphan .previous.segments.json with no previous audio, byte-identical', async () => {
    const book = seedBook();
    put(book, `${SLUG}.previous.segments.json`);

    await reconcile(book);

    expect(quarantined(book)).toEqual([`${SLUG}.previous.segments.json`]);
  });

  it.each(['mp3', 'm4a', 'ogg'])('keeps .previous.segments.json beside a .previous.%s', async (ext) => {
    const book = seedBook();
    writeFileSync(join(book.audio, `${SLUG}.previous.segments.json`), '{"durationSec":1}');
    put(book, `${SLUG}.previous.${ext}`);

    await sweep(book);

    expect(has(book, `${SLUG}.previous.segments.json`)).toBe(true);
    expect(events(book)).toEqual({});
  });

  it('keeps .previous.segments.json when a previous audio name cannot be probed (a held file is not an absent one)', async () => {
    const book = seedBook();
    put(book, `${SLUG}.previous.segments.json`);
    faults.stat = (path) => (path.endsWith(`${SLUG}.previous.m4a`) ? fsError('EPERM') : undefined);

    await sweep(book);

    expect(has(book, `${SLUG}.previous.segments.json`)).toBe(true);
    expect(events(book)).toEqual({});
  });

  it('quarantines a <slug>.mp3.stale, byte-identical', async () => {
    const book = seedBook();
    put(book, `${SLUG}.mp3.stale`);

    await reconcile(book);

    expect(quarantined(book)).toEqual([`${SLUG}.mp3.stale`]);
  });

  it('quarantines a relabel temp name with no book journal, and keeps one whose book journal is present', async () => {
    const book = seedBook();
    const owned = `${SLUG}.relabel-${ID}-1.mp3`;
    const loose = `${SLUG}.relabel-${JID}-0.mp3`;
    put(book, owned, loose, `.take-journal.relabel.${ID}.json`);

    await sweep(book);

    expect(has(book, owned)).toBe(true);
    expect(quarantined(book)).toEqual([loose]);
  });

  it("touches only the swept slug's files, and no live, previous or sidecar file", async () => {
    const book = seedBook([SLUG, OTHER]);
    const keep = [`${SLUG}.mp3`, `${SLUG}.previous.mp3`, `${SLUG}.peaks.json`];
    put(book, ...keep);
    const others = [...orphans(OTHER).unlinked, ...orphans(OTHER).quarantined];
    put(book, ...others);
    const mine = orphans(SLUG);
    put(book, ...mine.unlinked, ...mine.quarantined.filter((n) => !n.endsWith('.previous.segments.json')));

    await sweep(book);

    for (const name of [...keep, ...others]) expect(has(book, name), name).toBe(true);
    for (const name of mine.unlinked) expect(has(book, name), name).toBe(false);
    expect(quarantined(book)).toEqual(
      mine.quarantined.filter((n) => !n.endsWith('.previous.segments.json')).sort(),
    );
  });

  it.each([
    ['its own journal', JOURNAL_NAME],
    ['a journal whose name cannot be parsed', `${SLUG}.take-journal.damaged.json`],
  ])('sweeps nothing while the slug is named by %s', async (_label, name) => {
    const book = seedBook();
    const mine = orphans(SLUG);
    put(book, ...mine.unlinked, ...mine.quarantined, name);
    const before = files(book);

    await sweep(book);

    expect(files(book)).toEqual(before);
  });

  it('sweeps after the replay has removed the journal, in the same call', async () => {
    const book = seedBook();
    put(book, `${SLUG}.mp3.stale`);
    await inSpan(book, (h) => take.writeTakeJournal(h, SLUG, journal('discard')));

    await reconcile(book);

    expect(has(book, JOURNAL_NAME)).toBe(false);
    expect(quarantined(book)).toEqual([`${SLUG}.mp3.stale`]);
  });

  it('leaves an unreadable journal in place and quarantines nothing', async () => {
    const book = seedBook();
    const mine = orphans(SLUG);
    put(book, ...mine.unlinked, ...mine.quarantined);
    await inSpan(book, (h) => take.writeTakeJournal(h, SLUG, journal('discard')));
    const before = files(book);
    faults.read = (path) => (path.endsWith(JOURNAL_NAME) ? fsError('EBUSY') : undefined);

    await expect(reconcile(book)).rejects.toMatchObject({ code: 'EBUSY' });

    faults.read = null;
    expect(files(book)).toEqual(before);
  });

  it('does not sweep under migrate: false (replay only)', async () => {
    const book = seedBook();
    put(book, `${SLUG}.mp3.stale`, `${SLUG}.next-${ID}.mp3`);
    const before = files(book);

    await reconcile(book, SLUG, { migrate: false });

    expect(files(book)).toEqual(before);
  });

  it('quarantines an orphan previous segments file before the migration can pair it with a demoted live file', async () => {
    const book = seedBook();
    put(book, `${SLUG}.previous.segments.json`);
    /* Two live files, one matching the segments' length, and no previous audio:
       the migration demotes the other one to previous. */
    writeRealMp3(join(book.audio, `${SLUG}.mp3`), 2);
    writeFileSync(join(book.audio, `${SLUG}.segments.json`), JSON.stringify({ durationSec: 2, synthesizedAt: 'T' }));
    writeFileSync(join(book.audio, `${SLUG}.ogg`), Buffer.from('OggS-bytes'));

    await reconcile(book);

    expect(has(book, `${SLUG}.previous.ogg`)).toBe(true);
    expect(has(book, `${SLUG}.previous.segments.json`)).toBe(false);
    expect(quarantined(book)).toEqual([`${SLUG}.previous.segments.json`]);
  });

  it('a file that cannot be quarantined or unlinked is logged and left; the rest is swept and the call resolves', async () => {
    const book = seedBook();
    put(book, `${SLUG}.discard-${JID}.prev.mp3`, `${SLUG}.mp3.stale`, `${SLUG}.next-${ID}.mp3`);
    faults.rename = (from) => (from.endsWith('.prev.mp3') ? fsError('EXDEV') : undefined);

    await expect(reconcile(book)).resolves.toBeUndefined();

    expect(has(book, `${SLUG}.discard-${JID}.prev.mp3`)).toBe(true);
    expect(has(book, `${SLUG}.next-${ID}.mp3`)).toBe(false);
    expect(Object.values(events(book)).flat()).toEqual([`${SLUG}.mp3.stale`]);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(`${SLUG}.discard-${JID}.prev.mp3`), expect.anything());
  });

  it('skips a listed file that has gone since the listing, creating no event folder', async () => {
    const book = seedBook();
    put(book, `${SLUG}.mp3.stale`);

    await inSpan(book, async (h) => {
      const listing = await take.listTakeJournals(h);
      rmSync(join(book.audio, `${SLUG}.mp3.stale`));
      await take.sweepSlug(h, SLUG, listing);
    });

    expect(existsSync(join(book.audio, '.orphaned'))).toBe(false);
  });
});

/* ---- reconcileBook --------------------------------------------------------- */

describe('reconcileBook', () => {
  const BOOK_JOURNAL = `.take-journal.relabel.${JID}.json`;

  it('is in scope for a book journal only when the entry point touches a slug it names, or is book-wide', () => {
    expect(take.bookJournalInScope(['a', 'b'], 'book-wide')).toBe(true);
    expect(take.bookJournalInScope([], 'book-wide')).toBe(true);
    expect(take.bookJournalInScope(['a', 'b'], ['b', 'z'])).toBe(true);
    expect(take.bookJournalInScope(['a', 'b'], ['z'])).toBe(false);
    expect(take.bookJournalInScope(['a'], [])).toBe(false);
  });

  it.each([
    ['bytes that do not parse', '{ torn'],
    ['JSON that is not an object', '[1, 2]'],
  ])('quarantines a book journal of %s with the temp names it was moving, in its own event folder', async (_l, body) => {
    const book = seedBook([SLUG, OTHER]);
    const moving = [`${SLUG}.relabel-${JID}-0.mp3`, `${OTHER}.relabel-${JID}-1.segments.json`];
    const unrelated = `${SLUG}.relabel-${ID}-0.mp3`;
    put(book, ...moving, unrelated);
    writeFileSync(join(book.audio, BOOK_JOURNAL), body);

    /* Never blocks, whatever the entry point touches: it names nothing. */
    await reconcileBook(book, [SLUG]);

    const found = Object.entries(events(book));
    expect(found).toHaveLength(1);
    expect(found[0][0]).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${JID}$`));
    expect(found[0][1]).toEqual([BOOK_JOURNAL, ...moving].sort());
    expect(has(book, unrelated)).toBe(true);
  });

  it('leaves a book journal that parses to an object (its replay is Phase 4)', async () => {
    const book = seedBook();
    put(book, `${SLUG}.relabel-${JID}-0.mp3`);
    writeFileSync(join(book.audio, BOOK_JOURNAL), '{"phase":"stage"}');
    const before = files(book);

    await reconcileBook(book);

    expect(files(book)).toEqual(before);
  });

  it('a book journal that cannot be read throws and stays where it is', async () => {
    const book = seedBook();
    put(book, `${SLUG}.relabel-${JID}-0.mp3`);
    writeFileSync(join(book.audio, BOOK_JOURNAL), '{ torn');
    const before = files(book);
    faults.read = (path) => (path.endsWith(BOOK_JOURNAL) ? fsError('EBUSY') : undefined);

    await expect(reconcileBook(book)).rejects.toMatchObject({ code: 'EBUSY' });

    faults.read = null;
    expect(files(book)).toEqual(before);
  });

  it('refuses a handle that is not held', async () => {
    const book = seedBook();
    const listing = await inSpan(book, (h) => take.listTakeJournals(h));
    await expect(
      take.reconcileBook({ bookDir: book.bookDir } as never, listing, { touches: 'book-wide' }),
    ).rejects.toThrow(/not held/);
    await expect(take.sweepSlug({ bookDir: book.bookDir } as never, SLUG, listing)).rejects.toThrow(/not held/);
  });
});

/* ---- the boot fsck --------------------------------------------------------- */

describe('the boot fsck', () => {
  it('quarantines an orphan .previous.segments.json byte-identical under audio/.orphaned/<date>-.../, never unlinking it', async () => {
    const book = seedBook();
    put(book, `${SLUG}.previous.segments.json`);

    await fsck.fsckAllBooks();

    expect(quarantined(book)).toEqual([`${SLUG}.previous.segments.json`]);
  });

  it('sweeps the leftovers of a slug state.json no longer lists', async () => {
    const book = seedBook();
    const gone = orphans('gone-chapter');
    put(book, ...gone.unlinked, ...gone.quarantined);

    await fsck.fsckAllBooks();

    expect(Object.keys(files(book)).filter((n) => !n.startsWith('.orphaned/'))).toEqual([]);
    expect(quarantined(book)).toEqual([...gone.quarantined].sort());
  });

  it('quarantines an unparseable book journal and its temp names (book-wide)', async () => {
    const book = seedBook();
    put(book, `${SLUG}.relabel-${JID}-0.mp3`);
    writeFileSync(join(book.audio, `.take-journal.relabel.${JID}.json`), '{ torn');

    await fsck.fsckAllBooks();

    expect(Object.keys(events(book))).toEqual([expect.stringMatching(new RegExp(`-${JID}$`))]);
    expect(Object.values(events(book))[0]).toHaveLength(2);
  });

  it('still sweeps when a book journal cannot be read', async () => {
    const book = seedBook();
    const name = `.take-journal.relabel.${ID}.json`;
    writeFileSync(join(book.audio, name), '{}');
    put(book, `${SLUG}.mp3.stale`);
    faults.read = (path) => (path.endsWith(name) ? fsError('EBUSY') : undefined);

    await expect(fsck.fsckAllBooks()).resolves.toBeDefined();

    expect(has(book, name)).toBe(true);
    expect(quarantined(book)).toEqual([`${SLUG}.mp3.stale`]);
  });

  it('a replay whose stamp fails is logged, keeps the journal, and the run resolves', async () => {
    const book = seedBook();
    writeFileSync(join(book.audio, `${SLUG}.mp3`), MP3);
    writeFileSync(
      join(book.audio, `${SLUG}.segments.json`),
      JSON.stringify({ durationSec: 20, synthesizedAt: 'T', takeId: ID }),
    );
    put(book, `${SLUG}.mp3.stale`);
    await inSpan(book, (h) => take.writeTakeJournal(h, SLUG, journal('installed')));
    faults.stamp = fsError('EBUSY');

    await expect(fsck.fsckAllBooks()).resolves.toMatchObject({ errors: [] });

    expect(has(book, JOURNAL_NAME)).toBe(true);
    expect(has(book, `${SLUG}.mp3.stale`)).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(`reconcile failed for ${SLUG}`),
      expect.objectContaining({ code: 'EBUSY' }),
    );
  });

  it('leaves an unreadable journal in place and quarantines nothing', async () => {
    const book = seedBook();
    const mine = orphans(SLUG);
    put(book, ...mine.unlinked, ...mine.quarantined);
    await inSpan(book, (h) => take.writeTakeJournal(h, SLUG, journal('discard')));
    const before = files(book);
    faults.read = (path) => (path.endsWith(JOURNAL_NAME) ? fsError('EBUSY') : undefined);

    await fsck.fsckAllBooks();

    faults.read = null;
    const after = files(book);
    expect(after[JOURNAL_NAME]).toBe(before[JOURNAL_NAME]);
    expect(events(book)).toEqual({});
    for (const name of [...mine.unlinked, ...mine.quarantined]) expect(after[name], name).toBe(before[name]);
  });
});

/* ---- readers --------------------------------------------------------------- */

describe('readers never count a staged part', () => {
  it('GET /:bookId/state completedSlugs ignores .next-*', async () => {
    const book = seedBook([SLUG, OTHER]);
    put(book, `${SLUG}.next-${ID}.mp3`, `${OTHER}.mp3`);
    const app = express();
    app.use(express.json());
    app.use('/api/books', bookState.bookStateRouter);

    const res = await request(app).get(`/api/books/${book.bookId}/state`);

    expect(res.status).toBe(200);
    expect(res.body.completedSlugs).toEqual([OTHER]);
  });

  it('the library scan completedChapters ignores .next-*', async () => {
    const book = seedBook([SLUG, OTHER]);
    put(book, `${SLUG}.next-${ID}.mp3`, `${OTHER}.mp3`);

    const library = await scan.scanLibrary();
    const found = library.authors
      .flatMap((a) => a.series.flatMap((s) => s.books))
      .find((b) => b.title === book.title);

    expect(found?.completedChapters).toBe(1);
  });
});
