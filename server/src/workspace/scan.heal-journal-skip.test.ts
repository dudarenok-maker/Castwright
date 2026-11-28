/* #4320 step 2 (#4826) - the scan heal skips journal-named slugs, reading a
   slug's segments BEFORE it checks for the journal, and keys `book` canonically
   (spec 2026-11-13-chapter-take-lifecycle-design.md §4.4 "Why the skip is
   needed", "Read first, then check"; R5-2, R6-11, R7-1, R8-4, R9-6, R10-2).
   WORKSPACE_DIR is pointed at a tempdir BEFORE the modules load (paths.ts caches
   it at import). Journals are real ones, written by `writeTakeJournal`. */
import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import type { TakeJournal } from './chapter-take.js';
import type { BookStateJson } from './scan.js';

let workspaceRoot: string;
let scan: typeof import('./scan.js');
let take: typeof import('./chapter-take.js');
let leaf: typeof import('./take-fields.js');
let lock: typeof import('./book-op-lock.js');
let bookLock: typeof import('./book-lock.js');
let dirKey: typeof import('./book-dir-key.js');
let stateUpdate: typeof import('./book-state-update.js');
let paths: typeof import('./paths.js');

const AUTHOR = 'Skipper';
const SERIES = 'Standalones';
const JID = 'aaaaaaaaaaaaaaaa';
const NAMED = 'ch-1';
const SIBLING = 'ch-2';
const MODEL = 'xtts_v2';
let seq = 0;

type Chapter = BookStateJson['chapters'][number];

interface Seeded {
  title: string;
  bookId: string;
  bookDir: string;
  audio: string;
  statePath: string;
  state: BookStateJson;
}

/** A two-chapter book with an empty `audio/`. Segments are written separately,
    so a resolve made while planting a journal has nothing to heal. */
function seedBook(opts: { addressed?: boolean; uuids?: boolean } = {}): Seeded {
  seq += 1;
  const title = `Skip Book ${seq}`;
  const bookId = paths.makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(paths.BOOKS_ROOT, AUTHOR, SERIES, title);
  const audio = join(bookDir, 'audio');
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  mkdirSync(audio, { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  const state = {
    ...(opts.addressed === false ? {} : { bookId }),
    manuscriptId: `ms-skip-${seq}`,
    title,
    author: AUTHOR,
    series: SERIES,
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters: [NAMED, SIBLING].map((slug, i) => ({
      id: i + 1,
      title: `Chapter ${i + 1}`,
      slug,
      ...(opts.uuids === false ? {} : { uuid: `uuid-${i + 1}` }),
    })),
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  } as unknown as BookStateJson;
  const statePath = join(bookDir, '.audiobook', 'state.json');
  writeFileSync(statePath, JSON.stringify(state));
  return { title, bookId, bookDir, audio, statePath, state };
}

function writeSegments(book: Seeded): void {
  for (const slug of [NAMED, SIBLING]) {
    writeFileSync(
      join(book.audio, `${slug}.segments.json`),
      JSON.stringify({
        durationSec: 90,
        modelKey: MODEL,
        synthesizedAt: '2026-02-02T00:00:00.000Z',
      }),
    );
  }
}

function commitJournal(): TakeJournal {
  return {
    op: 'commit',
    jid: JID,
    phase: 'install',
    newTakeId: 'cccccccccccccccc',
    liveTakeId: null,
    prevTakeId: null,
    keepPrevious: false,
    parts: { live: [], previous: [], staged: [{ part: 'segments', size: 1 }] },
    chapter: { id: 1, slug: NAMED, uuid: 'uuid-1' },
    clearGenerationState: true,
    preserved: false,
    oldDuration: '00:00',
    newDuration: '01:30',
    entry: null,
    supersedes: [],
    lost: [],
  };
}

/** Plant a valid commit journal for `NAMED` through the module's own writer. */
async function plantJournal(book: Seeded): Promise<string> {
  const path = await lock.withBookOp(book.bookId, (h) =>
    take.writeTakeJournal(h, NAMED, commitJournal()),
  );
  if (path === lock.BOOK_GONE) throw new Error('book gone');
  return path;
}

/** A valid journal's path and bytes, taken off disk again: a test plants it
    from inside a paused heal, where a second resolve would re-enter the heal. */
async function stashJournal(book: Seeded): Promise<{ plant: () => void }> {
  const path = await plantJournal(book);
  const bytes = readFileSync(path);
  unlinkSync(path);
  return { plant: () => writeFileSync(path, bytes) };
}

const diskChapters = (book: Seeded): Chapter[] =>
  (JSON.parse(readFileSync(book.statePath, 'utf8')) as BookStateJson).chapters;

const bySlug = (chapters: Chapter[], slug: string): Chapter => {
  const ch = chapters.find((c) => c.slug === slug);
  if (!ch) throw new Error(`no chapter ${slug}`);
  return ch;
};

function expectUnhealed(ch: Chapter): void {
  expect(ch.audioModelKey, `${ch.slug} audioModelKey`).toBeUndefined();
  expect(ch.audioRenderedAt, `${ch.slug} audioRenderedAt`).toBeUndefined();
  expect(ch.duration, `${ch.slug} duration`).toBeUndefined();
}

function expectHealed(ch: Chapter): void {
  expect(ch.audioModelKey, `${ch.slug} audioModelKey`).toBe(MODEL);
  expect(ch.audioRenderedAt, `${ch.slug} audioRenderedAt`).toBe('2026-02-02T00:00:00.000Z');
  expect(ch.duration, `${ch.slug} duration`).toBe('01:30');
}

/** The patches a backfill hands the locked merge: both chapters, from segments. */
const segmentPatches = (book: Seeded) =>
  book.state.chapters.map((c) => ({
    id: c.id,
    slug: c.slug,
    uuid: c.uuid,
    set: {},
    fromSegments: true,
  }));

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 150));

/** Hold `book`:`key` from a separate async context until `release()`. */
async function holdBookLock(key: string): Promise<{ release: () => Promise<void> }> {
  const gate = deferred();
  const entered = deferred();
  const holder = bookLock.withBookLock(key, async () => {
    entered.resolve();
    await gate.promise;
  });
  await entered.promise;
  return {
    release: async () => {
      gate.resolve();
      await holder;
    },
  };
}

/** Another spelling of the same directory. */
const respell = (dir: string): string =>
  process.platform === 'win32' ? dir.toUpperCase().split(sep).join('/') : `${dir}${sep}`;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-heal-journal-skip-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [scan, take, leaf, lock, bookLock, dirKey, stateUpdate, paths] = await Promise.all([
    import('./scan.js'),
    import('./chapter-take.js'),
    import('./take-fields.js'),
    import('./book-op-lock.js'),
    import('./book-lock.js'),
    import('./book-dir-key.js'),
    import('./book-state-update.js'),
    import('./paths.js'),
  ]);
});

afterEach(() => {
  scan.__setHealJournalCheckGateForTest(null);
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('journalNamedSlugs', () => {
  function audioWith(files: Record<string, string>): string {
    const dir = mkdtempSync(join(workspaceRoot, 'journals-'));
    for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
    return dir;
  }
  const journalFor = (slug: string) => JSON.stringify({ chapter: { id: 1, slug } });

  it('is the leaf function, re-exported by the module', () => {
    expect(take.journalNamedSlugs).toBe(leaf.journalNamedSlugs);
  });

  it('is empty for an absent audio directory', () => {
    expect(leaf.journalNamedSlugs(join(workspaceRoot, 'no-such-audio'))).toEqual(new Set());
  });

  it('names the slug of every per-slug journal, a BOM and a dotted slug included', () => {
    const dir = audioWith({
      [`ch.1.take-journal.${JID}.json`]: journalFor('ch.1'),
      [`ch-2.take-journal.${JID}.json`]: `\uFEFF${journalFor('ch-2')}`,
      'ch-3.segments.json': '{}',
      'ch-3.mp3': 'x',
    });
    expect(leaf.journalNamedSlugs(dir)).toEqual(new Set(['ch.1', 'ch-2']));
  });

  it("ignores a journal write's tmp leftover", () => {
    const dir = audioWith({ [`ch-1.take-journal.${JID}.json.tmp-1-2-3-ab`]: '{half' });
    expect(leaf.journalNamedSlugs(dir)).toEqual(new Set());
  });

  it.each([
    ['unparseable bytes', `ch-1.take-journal.${JID}.json`, '{not json'],
    ['JSON that is not a journal', `ch-1.take-journal.${JID}.json`, 'null'],
    ['a chapter.slug that disagrees', `ch-1.take-journal.${JID}.json`, journalFor('ch-9')],
    ['a book journal', `.take-journal.relabel.${JID}.json`, '{}'],
    ['a name nothing classifies', 'ch-1.take-journal.json', journalFor('ch-1')],
  ])('skips the whole book for %s', (_label, name, body) => {
    const dir = audioWith({
      [name]: body,
      [`ch-2.take-journal.${JID}.json`]: journalFor('ch-2'),
    });
    expect(leaf.journalNamedSlugs(dir)).toBe('skip-book');
  });

  it('skips the whole book for a journal it cannot read', () => {
    const dir = audioWith({});
    mkdirSync(join(dir, `ch-1.take-journal.${JID}.json`));
    expect(leaf.journalNamedSlugs(dir)).toBe('skip-book');
  });

  it('skips the whole book when audio/ cannot be listed', () => {
    const dir = audioWith({ 'not-a-directory': 'x' });
    expect(leaf.journalNamedSlugs(join(dir, 'not-a-directory'))).toBe('skip-book');
  });
});

describe('the heal skips a journal-named slug', () => {
  it('in persistHealPatches: the named chapter stays unfilled, its sibling is healed', async () => {
    const book = seedBook();
    await plantJournal(book);
    writeSegments(book);
    const { merged } = await scan.__persistHealPatchesForTest(
      book.bookDir,
      book.bookId,
      segmentPatches(book),
    );
    for (const chapters of [merged!.chapters, diskChapters(book)]) {
      expectUnhealed(bySlug(chapters, NAMED));
      expectHealed(bySlug(chapters, SIBLING));
    }
  });

  it('in backfillAudioModelKeysFromSegments: on disk and in the returned state', async () => {
    const book = seedBook();
    await plantJournal(book);
    writeSegments(book);
    const res = await scan.backfillAudioModelKeysFromSegments(book.bookDir, book.state);
    for (const chapters of [res.state.chapters, diskChapters(book)]) {
      expectUnhealed(bySlug(chapters, NAMED));
      expectHealed(bySlug(chapters, SIBLING));
    }
    expect(res.totalSec).toBe(180);
  });

  it('in the state a backfill returns when it cannot write (the folder is gone)', async () => {
    const book = seedBook();
    await plantJournal(book);
    writeSegments(book);
    unlinkSync(book.statePath);
    const res = await scan.backfillAudioModelKeysFromSegments(book.bookDir, book.state);
    expect(res.gone).toBe(true);
    expectUnhealed(bySlug(res.state.chapters, NAMED));
    expectHealed(bySlug(res.state.chapters, SIBLING));
  });

  it('skips the whole book for an unparseable journal: no chapter healed, nothing written', async () => {
    const book = seedBook({ uuids: false });
    writeSegments(book);
    writeFileSync(join(book.audio, `${NAMED}.take-journal.${JID}.json`), '{not json');
    const before = readFileSync(book.statePath, 'utf8');

    const { merged } = await scan.__persistHealPatchesForTest(book.bookDir, book.bookId, [
      ...segmentPatches(book),
    ]);
    for (const ch of merged!.chapters) expectUnhealed(ch);

    await scan.__persistHealPatchesForTest(book.bookDir, book.bookId, [
      { id: 1, slug: NAMED, set: { uuid: 'minted' } },
    ]);

    const res = await scan.backfillAudioModelKeysFromSegments(book.bookDir, book.state);
    for (const ch of res.state.chapters) expectUnhealed(ch);
    expect(readFileSync(book.statePath, 'utf8')).toBe(before);
  });
});

describe('read the segments first, then check for the journal (R6-11)', () => {
  /** Pause the first heal that reaches the gate; plant while it is paused. */
  async function plantInTheWindow<T>(
    key: string,
    journal: { plant: () => void },
    heal: () => Promise<T>,
  ): Promise<{ result: T; lockTakenWhilePaused: boolean }> {
    const paused = deferred();
    const resume = deferred();
    let fired = false;
    scan.__setHealJournalCheckGateForTest(async () => {
      if (fired) return;
      fired = true;
      paused.resolve();
      await resume.promise;
    });
    const running = heal();
    /* A heal that finishes without ever reaching the gate must not hang here. */
    await Promise.race([paused.promise, running]);
    expect(fired, 'the heal reached the gate').toBe(true);
    /* A journal unlink queues on `book` (R7-1). Started here, in the test's own
       async context, so it cannot inherit the heal's hold. */
    let taken = false;
    const unlinker = bookLock.withBookLock(key, async () => {
      taken = true;
    });
    await pause();
    const lockTakenWhilePaused = taken;
    journal.plant();
    resume.resolve();
    const result = await running;
    await unlinker;
    return { result, lockTakenWhilePaused };
  }

  it('persistHealPatches skips a slug whose journal appears after its segments read', async () => {
    const book = seedBook();
    const journal = await stashJournal(book);
    writeSegments(book);
    const { lockTakenWhilePaused } = await plantInTheWindow(book.bookId, journal, () =>
      scan.__persistHealPatchesForTest(book.bookDir, book.bookId, segmentPatches(book)),
    );
    expectUnhealed(bySlug(diskChapters(book), NAMED));
    expectHealed(bySlug(diskChapters(book), SIBLING));
    expect(lockTakenWhilePaused).toBe(false);
  });

  it('the resolve-time backfill does the same, holding `book` across the read and the check', async () => {
    const book = seedBook();
    const journal = await stashJournal(book);
    writeSegments(book);
    /* No state.json: the returned state is the backfill's own, not the merge's. */
    unlinkSync(book.statePath);
    const { result, lockTakenWhilePaused } = await plantInTheWindow(book.bookId, journal, () =>
      scan.backfillAudioModelKeysFromSegments(book.bookDir, book.state),
    );
    expectUnhealed(bySlug(result.state.chapters, NAMED));
    expectHealed(bySlug(result.state.chapters, SIBLING));
    expect(lockTakenWhilePaused).toBe(false);
    expect(existsSync(book.statePath)).toBe(false);
  });
});

describe('an unaddressed book is not healed (R8-4)', () => {
  it('skips a registered directory, however it is spelt, and heals it once released', async () => {
    const book = seedBook({ uuids: false });
    writeSegments(book);
    const before = readFileSync(book.statePath, 'utf8');
    expect(dirKey.registerUnaddressedDir(respell(book.bookDir))).toBe(true);
    try {
      const res = await scan.backfillAudioModelKeysFromSegments(book.bookDir, book.state);
      for (const ch of res.state.chapters) expectUnhealed(ch);
      await scan.__persistHealPatchesForTest(book.bookDir, book.bookId, [
        ...segmentPatches(book),
        { id: 1, slug: NAMED, set: { uuid: 'minted' } },
      ]);
      expect(readFileSync(book.statePath, 'utf8')).toBe(before);
    } finally {
      dirKey.releaseUnaddressedDir(book.bookDir);
    }
    await scan.backfillAudioModelKeysFromSegments(book.bookDir, book.state);
    for (const ch of diskChapters(book)) expectHealed(ch);
  });

  it('asks only once `book` is held: a registration made while the heal waits counts', async () => {
    const book = seedBook();
    writeSegments(book);
    const held = await holdBookLock(book.bookId);
    try {
      const healing = scan.__persistHealPatchesForTest(
        book.bookDir,
        book.bookId,
        segmentPatches(book),
      );
      await pause();
      dirKey.registerUnaddressedDir(book.bookDir);
      await held.release();
      await healing;
      for (const ch of diskChapters(book)) expectUnhealed(ch);
    } finally {
      await held.release();
      dirKey.releaseUnaddressedDir(book.bookDir);
    }
  });
});

describe('`book` keys taken from a directory are canonical (R8-4)', () => {
  it('the backfill of a book with no bookId waits on the canonical directory key', async () => {
    const book = seedBook({ addressed: false });
    writeSegments(book);
    const held = await holdBookLock(dirKey.canonicalDirKey(book.bookDir));
    const healing = scan.backfillAudioModelKeysFromSegments(respell(book.bookDir), book.state);
    try {
      await pause();
      for (const ch of diskChapters(book)) expectUnhealed(ch);
    } finally {
      await held.release();
    }
    await healing;
    for (const ch of diskChapters(book)) expectHealed(ch);
  });

  it("the library scan's uuid mint waits on the same key", async () => {
    const book = seedBook({ addressed: false, uuids: false });
    const held = await holdBookLock(dirKey.canonicalDirKey(book.bookDir));
    const scanning = scan.scanLibrary();
    try {
      /* Long enough for the walk over every book seeded above to reach this one. */
      await new Promise((resolve) => setTimeout(resolve, 750));
      expect(diskChapters(book).map((c) => c.uuid)).toEqual([undefined, undefined]);
    } finally {
      await held.release();
    }
    await scanning;
    for (const ch of diskChapters(book)) expect(ch.uuid).toBeTruthy();
  });

  it('updateStateAtDir serialises two spellings of one directory on one key', async () => {
    const book = seedBook({ addressed: false });
    const order: string[] = [];
    const release = deferred();
    const update = (name: string, dir: string, hold: Promise<void>) =>
      stateUpdate.updateStateAtDir(dir, () => null, {
        /* Under `book`, before the `state-json` leaf lock (which is keyed on the
           path and would hide a split `book` key). */
        underBookLock: async () => {
          order.push(`enter ${name}`);
          await hold;
          order.push(`exit ${name}`);
        },
      });
    const first = update('A', book.bookDir, release.promise);
    await pause();
    const second = update('B', respell(book.bookDir), Promise.resolve());
    await pause();
    release.resolve();
    await Promise.all([first, second]);
    expect(order).toEqual(['enter A', 'exit A', 'enter B', 'exit B']);
  });
});
