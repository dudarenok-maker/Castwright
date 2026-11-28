/* #4320 step 7 (#4831) - Commit step 0: supersession (E10, R9-3), repeat until
   settled (R10-3), the failure classes by protocol step (R7-4, R8-2) and the
   record-step budget (spec 2026-11-13-chapter-take-lifecycle-design.md §5.A
   "Commit" step 0, "Ownership", "Retries"). Leftover journals are built by
   running `commitTake` and failing a chosen disk write. WORKSPACE_DIR is
   pointed at a tempdir BEFORE the modules load (paths.ts caches it at import).
   Real files, real handles. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CommitTakeOptions, StagedTake, TakeJournal } from './chapter-take.js';

/* Fault injection, pass-through unless a test arms it.
   - `rename` / `unlink` / `read`: a returned error is thrown in the call's place.
   - `crashAt`: `true` for a completed rename kills the process there: that call
     throws, and so does every rename and unlink after it, until disarmed.
   - `step`: called after every completed rename or unlink.
   - `renames` / `unlinks`: every attempted target, in order.
   - `revisions`: every version of revisions.json that reached disk. */
const faults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Error | undefined),
  unlink: null as null | ((path: string) => Error | undefined),
  read: null as null | ((path: string) => Error | undefined),
  crashAt: null as null | ((from: string, to: string) => boolean),
  step: null as null | (() => void),
  dead: false,
  renames: [] as string[],
  unlinks: [] as string[],
  revisions: [] as string[],
}));
const crashError = vi.hoisted(
  () => (): Error => Object.assign(new Error('injected crash'), { code: 'ECRASH' }),
);
vi.mock('./atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-rename.js')>();
  const fs = await import('node:fs');
  return {
    ...actual,
    renameWithRetry: async (from: string, to: string) => {
      faults.renames.push(to);
      if (faults.dead) throw crashError();
      const error = faults.rename?.(from, to);
      if (error) throw error;
      const revisions = to.endsWith('revisions.json') ? fs.readFileSync(from, 'utf8') : null;
      const crash = faults.crashAt?.(from, to) ?? false;
      await actual.renameWithRetry(from, to);
      if (revisions !== null) faults.revisions.push(revisions);
      faults.step?.();
      if (crash) {
        faults.dead = true;
        throw crashError();
      }
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const unlink = (async (...args: Parameters<typeof actual.unlink>) => {
    faults.unlinks.push(String(args[0]));
    if (faults.dead) throw crashError();
    const error = faults.unlink?.(String(args[0]));
    if (error) throw error;
    await actual.unlink(...args);
    faults.step?.();
  }) as typeof actual.unlink;
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const error = faults.read?.(String(args[0]));
    if (error) throw error;
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, unlink, readFile, default: { ...actual, unlink, readFile } };
});

/* Each test runs several real commits (fsyncs and renames), and an injected
   EPERM walks the whole unlink backoff: on a loaded box that outlasts the 15 s
   default. */
vi.setConfig({ testTimeout: 60_000 });

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let fileLock: typeof import('./file-lock.js');

const SLUG = 'ch-01';
const CHAPTER_ID = 3;
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const LIVE_AT = '2026-02-02T00:00:00.000Z';
const PREV_AT = '2026-01-01T00:00:00.000Z';
const NEW_AT = '2026-03-03T00:00:00.000Z';
const CHAPTER_SENTENCE =
  "Some of this chapter's audio files could not be moved into place. Close any other program using the book's folder, and check free disk space and the folder's permissions, then try again.";
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'take-step0-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  take = await import('./chapter-take.js');
  lock = await import('./book-op-lock.js');
  paths = await import('./paths.js');
  fileLock = await import('./file-lock.js');
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

const disarm = (): void => {
  faults.rename = null;
  faults.unlink = null;
  faults.read = null;
  faults.crashAt = null;
  faults.step = null;
  faults.dead = false;
};
const clearLogs = (): void => {
  faults.renames.length = 0;
  faults.unlinks.length = 0;
  faults.revisions.length = 0;
};

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  disarm();
  clearLogs();
  vi.restoreAllMocks();
});

/* ---- fixtures -------------------------------------------------------------- */

interface Seeded {
  bookId: string;
  bookDir: string;
  audio: string;
}

function segmentsFile(synthesizedAt: string, durationSec: number, takeId?: string) {
  return {
    chapterId: CHAPTER_ID,
    durationSec,
    modelKey: 'kokoro-v1',
    synthesizedAt,
    segments: [{ characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 1 }],
    characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
    ...(takeId ? { takeId } : {}),
  };
}

function seedTake(audio: string, prefix: string, takeId: string | undefined, at: string, durationSec: number) {
  writeFileSync(join(audio, `${prefix}.mp3`), Buffer.from(`ID3${takeId ?? 'idless'}`));
  writeFileSync(join(audio, `${prefix}.segments.json`), JSON.stringify(segmentsFile(at, durationSec, takeId)));
  writeFileSync(join(audio, `${prefix}.peaks.json`), JSON.stringify({ peaks: [takeId ?? 'idless'] }));
}

/** A book with live take B and previous take A; `idless` strips the live id. */
function seedBook(opts: { idless?: boolean } = {}): Seeded {
  seq += 1;
  const title = `Step Zero Book ${seq}`;
  const bookId = paths.makeBookId('Taker', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Taker', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-step0-${seq}`,
      title,
      author: 'Taker',
      series: 'Ser',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [
        {
          id: CHAPTER_ID,
          title: 'One',
          slug: SLUG,
          uuid: 'uuid-3',
          duration: '00:20',
          audioRenderedAt: LIVE_AT,
          ...(opts.idless ? {} : { audioTakeId: B }),
        },
      ],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  seedTake(audio, SLUG, opts.idless ? undefined : B, LIVE_AT, 20);
  seedTake(audio, `${SLUG}.previous`, A, PREV_AT, 10);
  return { bookId, bookDir, audio };
}

const stage = (book: Seeded, over: { resynthesizedIndices?: number[] } = {}): Promise<StagedTake> =>
  take.prepareTake(
    { bookDir: book.bookDir },
    {
      slug: SLUG,
      ext: 'mp3',
      audio: Buffer.from(`ID3new-${++seq}`),
      segments: segmentsFile(NEW_AT, 65),
      peaks: { peaks: ['new'] },
      ...over,
    },
    new AbortController().signal,
  );

const commitOpts = (over: Partial<CommitTakeOptions> = {}): CommitTakeOptions => ({
  base: undefined,
  startTakeId: null,
  signal: new AbortController().signal,
  review: { characterId: 'narrator', triggeredBy: 'voice-change' },
  ...over,
});

async function inSpan<T>(book: Seeded, fn: (h: import('./book-op-lock.js').BookHandle) => Promise<T>): Promise<T> {
  const out = await lock.withBookOp(book.bookId, fn);
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out as T;
}

const commit = (book: Seeded, staged: StagedTake, over: Partial<CommitTakeOptions> = {}) =>
  inSpan(book, (h) => take.commitTake(h, staged, commitOpts(over)));
const reconcile = (book: Seeded) => inSpan(book, (h) => take.reconcileSlug(h, SLUG));

/* ---- observers and faults -------------------------------------------------- */

const names = (book: Seeded, marker: string): string[] =>
  readdirSync(book.audio)
    .filter((n) => n.includes(marker) && !n.includes('.tmp-'))
    .sort();
const journals = (book: Seeded): TakeJournal[] =>
  names(book, '.take-journal.').map((n) => JSON.parse(readFileSync(join(book.audio, n), 'utf8')) as TakeJournal);
const journalOf = (book: Seeded, newTakeId: string): TakeJournal => {
  const found = journals(book).find((j) => j.newTakeId === newTakeId);
  if (!found) throw new Error(`no journal for ${newTakeId}`);
  return found;
};
const journalName = (jid: string): string => `${SLUG}.take-journal.${jid}.json`;
const liveId = (book: Seeded): unknown =>
  (JSON.parse(readFileSync(join(book.audio, `${SLUG}.segments.json`), 'utf8')) as { takeId?: unknown }).takeId;
const chapterState = (book: Seeded): Record<string, unknown> =>
  (
    JSON.parse(readFileSync(join(book.bookDir, '.audiobook', 'state.json'), 'utf8')) as {
      chapters: Record<string, unknown>[];
    }
  ).chapters[0];
const revisionsPath = (book: Seeded): string => join(book.bookDir, '.audiobook', 'revisions.json');
const pendingIds = (raw: string): string[] => (JSON.parse(raw) as { pending: { id: string }[] }).pending.map((p) => p.id);
const entryId = (takeId: string): string => `revision:${CHAPTER_ID}:${takeId}`;

const fsError = (code: string, syscall = 'rename'): Error =>
  Object.assign(new Error(`injected ${code} C:\\secret\\path`), { code, syscall });
const isStateJson = (to: string): boolean => basename(to) === 'state.json';
const stateWrites = (): number => faults.renames.filter(isStateJson).length;
const failStamp = (code = 'EACCES'): void => {
  faults.rename = (_from, to) => (isStateJson(to) ? fsError(code) : undefined);
};
const phaseWrite =
  (phase: string) =>
  (from: string, to: string): boolean =>
    to.includes('.take-journal.') && readFileSync(from, 'utf8').includes(`"phase": "${phase}"`);

/** A commit whose stamp fails: its journal stays at `installed`. */
async function stuckAtInstalled(book: Seeded): Promise<{ staged: StagedTake; journal: TakeJournal }> {
  const staged = await stage(book);
  failStamp();
  await expect(commit(book, staged)).rejects.toMatchObject({ code: 'EACCES' });
  disarm();
  clearLogs();
  const journal = journalOf(book, staged.takeId);
  expect(journal.phase).toBe('installed');
  return { staged, journal };
}

/** Kill a commit right after its `phase` journal write: the journal is left. */
async function crashAt(book: Seeded, phase: string): Promise<{ staged: StagedTake; journal: TakeJournal }> {
  const staged = await stage(book);
  faults.crashAt = phaseWrite(phase);
  await expect(commit(book, staged)).rejects.toThrow('injected crash');
  disarm();
  clearLogs();
  return { staged, journal: journalOf(book, staged.takeId) };
}

/** Journals no other journal names. */
const unsuperseded = (book: Seeded): string[] => {
  const all = journals(book);
  const named = new Set(all.flatMap((j) => j.supersedes.map((s) => s.jid)));
  return all.filter((j) => !named.has(j.jid)).map((j) => j.jid);
};

/* ---- supersession ---------------------------------------------------------- */

describe('commit step 0 - supersession (E10)', () => {
  it('supersedes a journal stuck on its stamp without retrying it, installs its own take, fails loud at step 7, and replay later finishes both', async () => {
    const book = seedBook();
    const first = await stuckAtInstalled(book);
    const second = await stage(book);
    failStamp();

    await expect(commit(book, second)).rejects.toMatchObject({ code: 'EACCES' });

    /* One attempt for the leftover journal (its one replay), one for step 7. */
    expect(stateWrites()).toBe(2);
    expect(liveId(book)).toBe(second.takeId);
    const own = journalOf(book, second.takeId);
    expect(own.phase).toBe('installed');
    expect(own.supersedes).toEqual([{ jid: first.journal.jid, discards: [], dropEntry: true }]);
    expect(unsuperseded(book)).toEqual([own.jid]);

    disarm();
    /* An entry for the superseded take, as if it had been recorded. */
    writeFileSync(
      revisionsPath(book),
      JSON.stringify({
        schema: 1,
        fileId: null,
        rev: 5,
        pending: [
          {
            id: entryId(first.staged.takeId),
            chapterId: CHAPTER_ID,
            characterId: 'narrator',
            playable: true,
            hasPreviousAudio: true,
            segments: [],
            origin: 'server',
          },
        ],
      }),
    );
    clearLogs();
    await reconcile(book);

    expect(chapterState(book)).toMatchObject({ audioTakeId: second.takeId, duration: '01:05' });
    /* The superseded entry is dropped first, then this commit's own is recorded. */
    expect(faults.revisions.map(pendingIds)).toEqual([[], [entryId(second.takeId)]]);
    expect(names(book, '.take-journal.')).toEqual([]);
    expect(names(book, '.discard-')).toEqual([]);
  });

  it("carries the old journal's still-owed discards and unlinks them, the old journal, then its own", async () => {
    const book = seedBook();
    const staged = await stage(book);
    /* Not a retryable code: `unlinkWithRetry` throws it at once. */
    const holdDiscards = (path: string): Error | undefined =>
      path.includes('.discard-') ? fsError('EISDIR', 'unlink') : undefined;
    failStamp();
    faults.unlink = holdDiscards;
    await expect(commit(book, staged)).rejects.toMatchObject({ code: 'EACCES' });
    const old = journalOf(book, staged.takeId);
    const oldDiscards = names(book, `.discard-${old.jid}.`);
    expect(oldDiscards.length).toBeGreaterThan(0);

    const second = await stage(book);
    faults.unlink = (path) => (path.includes(`.discard-${old.jid}.`) ? fsError('EISDIR', 'unlink') : undefined);
    await expect(commit(book, second)).rejects.toMatchObject({ code: 'EACCES' });
    const own = journalOf(book, second.takeId);
    expect(own.supersedes).toEqual([{ jid: old.jid, discards: oldDiscards, dropEntry: true }]);
    expect(names(book, '.take-journal.')).toHaveLength(2);

    disarm();
    clearLogs();
    await reconcile(book);
    const unlinked = faults.unlinks.map((p) => basename(p));
    const chain = [...oldDiscards, journalName(old.jid), journalName(own.jid)];
    expect(unlinked.filter((n) => chain.includes(n))).toEqual(chain);
    expect(names(book, '.take-journal.')).toEqual([]);
    expect(names(book, '.discard-')).toEqual([]);
  });

  it('supersedes a `replace` journal too (E14)', async () => {
    const book = seedBook();
    const first = await stuckAtInstalled(book);
    writeFileSync(
      join(book.audio, journalName(first.journal.jid)),
      JSON.stringify({ ...first.journal, op: 'replace' }, null, 2),
    );
    const second = await stage(book);
    failStamp();
    await expect(commit(book, second)).rejects.toMatchObject({ code: 'EACCES' });
    expect(journalOf(book, second.takeId).supersedes.map((s) => s.jid)).toEqual([first.journal.jid]);
    expect(liveId(book)).toBe(second.takeId);
  });

  it('a replay that parked but removed its journal leaves nothing to supersede', async () => {
    const book = seedBook();
    await stuckAtInstalled(book);
    const second = await stage(book);
    let failed = false;
    /* Only the leftover journal's `cleanup` phase write fails. */
    faults.rename = (from, to) => {
      if (failed || !phaseWrite('cleanup')(from, to)) return undefined;
      failed = true;
      return fsError('EISDIR');
    };
    let writtenSupersedes: TakeJournal['supersedes'] | undefined;
    faults.crashAt = (from, to) => {
      if (phaseWrite('discard')(from, to)) {
        writtenSupersedes = (JSON.parse(readFileSync(from, 'utf8')) as TakeJournal).supersedes;
      }
      return false;
    };
    expect(await commit(book, second)).toMatchObject({ outcome: 'committed' });
    expect(failed).toBe(true);
    expect(writtenSupersedes).toEqual([]);
    expect(names(book, '.take-journal.')).toEqual([]);
  });
});

describe('commit step 0 - chains (R9-3)', () => {
  /** J1 stuck at `cleanup` because its own unlink fails; J2 supersedes it and
      cannot unlink it either. */
  async function chainOfTwo(book: Seeded) {
    const s1 = await stage(book);
    faults.unlink = (path) => (path.includes('.take-journal.') ? fsError('EISDIR', 'unlink') : undefined);
    await expect(commit(book, s1)).rejects.toMatchObject({ code: 'EISDIR' });
    const j1 = journalOf(book, s1.takeId);
    expect(j1.phase).toBe('cleanup');
    faults.unlink = (path) => (basename(path) === journalName(j1.jid) ? fsError('EISDIR', 'unlink') : undefined);
    const s2 = await stage(book);
    await expect(commit(book, s2)).rejects.toMatchObject({ code: 'EISDIR' });
    const j2 = journalOf(book, s2.takeId);
    expect(j2.supersedes.map((s) => s.jid)).toEqual([j1.jid]);
    expect(names(book, '.take-journal.')).toHaveLength(2);
    clearLogs();
    return { j1, j2 };
  }

  const journalUnlinks = (): string[] =>
    faults.unlinks.map((p) => basename(p)).filter((n) => n.includes('.take-journal.'));

  it('J3 supersedes J2: it names J1 then J2, unlinks J1, J2, itself, and the pending entry is J3’s', async () => {
    const book = seedBook();
    const { j1, j2 } = await chainOfTwo(book);
    const s3 = await stage(book);
    let named: string[] | undefined;
    /* J1's unlink fails through step 0, and clears once J3 is installed. */
    faults.crashAt = (from, to) => {
      if (phaseWrite('installed')(from, to)) {
        const written = JSON.parse(readFileSync(from, 'utf8')) as TakeJournal;
        if (written.newTakeId === s3.takeId) {
          named = written.supersedes.map((s) => s.jid);
          faults.unlink = null;
          clearLogs();
        }
      }
      return false;
    };

    expect(await commit(book, s3)).toMatchObject({ outcome: 'committed', newTakeId: s3.takeId });

    expect(named).toEqual([j1.jid, j2.jid]);
    const unlinked = journalUnlinks();
    expect(unlinked.slice(0, 2)).toEqual([journalName(j1.jid), journalName(j2.jid)]);
    expect(unlinked).toHaveLength(3);
    expect(names(book, '.take-journal.')).toEqual([]);
    expect(pendingIds(readFileSync(revisionsPath(book), 'utf8'))).toEqual([entryId(s3.takeId)]);
  });

  it('stops the chain at the first failed unlink: J2 is never unlinked while it names J1', async () => {
    const book = seedBook();
    const { j1, j2 } = await chainOfTwo(book);
    const s3 = await stage(book);

    await expect(commit(book, s3)).rejects.toMatchObject({ code: 'EISDIR' });

    const j3 = journalOf(book, s3.takeId);
    expect(j3.supersedes.map((s) => s.jid)).toEqual([j1.jid, j2.jid]);
    expect(journalUnlinks()).not.toContain(journalName(j2.jid));
    expect(names(book, '.take-journal.')).toHaveLength(3);
    expect(unsuperseded(book)).toEqual([j3.jid]);

    disarm();
    clearLogs();
    await reconcile(book);
    expect(journalUnlinks()).toEqual([j1.jid, j2.jid, j3.jid].map(journalName));
    expect(names(book, '.take-journal.')).toEqual([]);
  });

  it('an unreadable journal in a chain stops step 0 as a record step, acting on none', async () => {
    const book = seedBook();
    const { j1, j2 } = await chainOfTwo(book);
    const s3 = await stage(book);
    faults.read = (path) => (basename(path) === journalName(j2.jid) ? fsError('EBUSY', 'read') : undefined);
    expect(await commit(book, s3)).toMatchObject({ outcome: 'record-step-failed', err: { code: 'EBUSY' } });
    expect(faults.unlinks.filter((p) => basename(p) === journalName(j1.jid))).toEqual([]);
    expect(names(book, '.take-journal.')).toHaveLength(2);
  });
});

describe('commit step 0 - repeats until it settles (R10-3)', () => {
  it('rolls back a superseding journal and supersedes the one it named, in the same span', async () => {
    const book = seedBook();
    const first = await stuckAtInstalled(book);
    const second = await stage(book);
    failStamp();
    faults.crashAt = phaseWrite('install');
    await expect(commit(book, second)).rejects.toThrow('injected crash');
    disarm();
    const j2 = journalOf(book, second.takeId);
    expect(j2.supersedes.map((s) => s.jid)).toEqual([first.journal.jid]);

    const third = await stage(book);
    failStamp();
    const seen: number[] = [];
    faults.step = () => seen.push(unsuperseded(book).length);
    await expect(commit(book, third)).rejects.toMatchObject({ code: 'EACCES' });

    expect(seen.length).toBeGreaterThan(0);
    expect(Math.max(...seen)).toBe(1);
    const j3 = journalOf(book, third.takeId);
    expect(j3.supersedes.map((s) => s.jid)).toEqual([first.journal.jid]);
    expect(journals(book).map((j) => j.jid)).not.toContain(j2.jid);
    expect(liveId(book)).toBe(third.takeId);
    /* The take the first commit installed is the previous one: J2's was undone. */
    expect(
      JSON.parse(readFileSync(join(book.audio, `${SLUG}.previous.segments.json`), 'utf8')),
    ).toMatchObject({ takeId: first.staged.takeId });
  });
});

/* ---- classes by protocol step ---------------------------------------------- */

describe('commit step 0 - failure classes by step (R7-4, R8-2)', () => {
  it("a held state.json (EBUSY from its own rename) is a record step: superseded, never take_repair_pending", async () => {
    const book = seedBook();
    const first = await stuckAtInstalled(book);
    const second = await stage(book);
    let stamps = 0;
    /* Held for the leftover journal's replay only. */
    faults.rename = (_from, to) => (isStateJson(to) && stamps++ === 0 ? fsError('EBUSY') : undefined);

    expect(await commit(book, second)).toMatchObject({ outcome: 'committed', newTakeId: second.takeId });

    expect(stamps).toBe(2);
    expect(liveId(book)).toBe(second.takeId);
    expect(names(book, journalName(first.journal.jid))).toEqual([]);
  });

  it('a held take part is a move step: repair-pending, the staged set swept, the journal kept', async () => {
    const book = seedBook();
    const first = await crashAt(book, 'install');
    const second = await stage(book);
    faults.rename = (from, to) =>
      from.includes('.previous.') && !to.includes('.tmp-') ? fsError('EBUSY') : undefined;

    expect(await commit(book, second)).toEqual({ outcome: 'repair-pending' });

    expect(names(book, `.next-${second.takeId}.`)).toEqual([]);
    expect(take.liveStaging.has(second.takeId)).toBe(false);
    expect(journals(book).map((j) => j.jid)).toEqual([first.journal.jid]);
  });

  it('exports one move-step sentence for every code, and the book-wide variant', () => {
    expect(take.TAKE_REPAIR_PENDING_ERROR).toBe(CHAPTER_SENTENCE);
    const bookWide = CHAPTER_SENTENCE.replace("this chapter's", "this book's");
    expect(take.TAKE_REPAIR_PENDING_BOOK_ERROR).toBe(bookWide);
    const err = new take.TakeRepairPendingError();
    expect(err).toMatchObject({ code: 'take_repair_pending', message: CHAPTER_SENTENCE });
    expect(new take.TakeRepairPendingError({ bookWide: true }).message).toBe(bookWide);
  });

  it('classifies by the step that threw, never by code or syscall', () => {
    expect(take.classifyReplayFailure(new take.TakeMoveStepError(SLUG, fsError('EROFS')))).toBe('move');
    expect(take.classifyReplayFailure(new take.TakeRepairPendingError())).toBe('move');
    expect(take.classifyReplayFailure(new take.TakeJournalConflictError(SLUG, 2))).toBe('conflict');
    for (const code of ['EBUSY', 'EPERM', 'EACCES', 'ENOENT', 'EIO']) {
      expect(take.classifyReplayFailure(fsError(code)), code).toBe('record');
    }
  });

  it('two unsuperseded journals throw the conflict, sweep the staged set, and have a path-free sentence', async () => {
    const book = seedBook();
    const first = await stuckAtInstalled(book);
    const twin = 'cccccccccccccccc';
    writeFileSync(join(book.audio, journalName(twin)), JSON.stringify({ ...first.journal, jid: twin }, null, 2));
    const second = await stage(book);
    await expect(commit(book, second)).rejects.toBeInstanceOf(take.TakeJournalConflictError);
    expect(names(book, `.next-${second.takeId}.`)).toEqual([]);
    expect(take.liveStaging.has(second.takeId)).toBe(false);
    expect(take.TAKE_JOURNAL_CONFLICT_ERROR).toMatch(/chapter/);
    expect(take.TAKE_JOURNAL_CONFLICT_ERROR).not.toMatch(/[\\/]/);
  });

  it.each([
    /* A full render over an id-less live take, and a partial write whose
       previous take is id-less: a mint is attempted at step 0 in both. */
    { label: 'a full render', idless: true, staged: {}, over: {} },
    { label: 'a partial write', idless: false, staged: { resynthesizedIndices: [] }, over: { base: B } },
  ])('a failed take-id mint never stops $label at step 0', async ({ idless, staged: stagedOver, over }) => {
    const book = seedBook({ idless });
    if (!idless) {
      writeFileSync(join(book.audio, `${SLUG}.previous.segments.json`), JSON.stringify(segmentsFile(PREV_AT, 10)));
    }
    const staged = await stage(book, stagedOver);
    let mints = 0;
    /* A mint is the only atomic write of a take's segments file. */
    faults.rename = (from, to) => {
      if (!from.includes('.tmp-') || !to.endsWith('.segments.json') || to.includes('.next-')) return undefined;
      mints += 1;
      return fsError('ENOSPC');
    };
    expect(await commit(book, staged, over)).toMatchObject({ outcome: 'committed' });
    expect(mints).toBeGreaterThan(0);
    expect(liveId(book)).toBe(staged.takeId);
  });
});

/* ---- the record-step budget ------------------------------------------------ */

describe('runWithRecordStepBudget', () => {
  const spanFor = (book: Seeded, handles: unknown[]) => (run: (h: import('./book-op-lock.js').BookHandle) => Promise<void>) =>
    lock.withBookOp(book.bookId, (h) => {
      handles.push(h);
      return run(h);
    });

  /** A commit journal before `installed` (off the supersedable list). */
  async function leftover(book: Seeded) {
    const { journal } = await crashAt(book, 'preserve');
    const staged = await stage(book);
    const failUnlink = (code: string) => {
      faults.unlink = (path) =>
        basename(path) === journalName(journal.jid) ? fsError(code, 'unlink') : undefined;
    };
    return { staged, failUnlink };
  }

  async function budgetedCommit(book: Seeded, staged: StagedTake, onSleep: () => void = () => {}) {
    const handles: unknown[] = [];
    const sleeps: number[] = [];
    const result = await take.runWithRecordStepBudget(
      spanFor(book, handles),
      (h) => take.commitTake(h, staged, commitOpts()),
      {
        sleep: async (ms) => {
          sleeps.push(ms);
          onSleep();
        },
      },
    );
    return { result, handles, sleeps };
  }

  it.each([
    ['EPERM', 'FS_FAILURE_REQUEST_ERROR'],
    ['EACCES', 'FS_PERMANENT_FAILURE_REQUEST_ERROR'],
  ] as const)(
    'a rolled-back journal whose unlink fails with %s: three attempts in fresh spans, then %s',
    async (code, sentence) => {
      const book = seedBook();
      const { staged, failUnlink } = await leftover(book);
      failUnlink(code);

      const { result, handles, sleeps } = await budgetedCommit(book, staged);

      expect(result).toMatchObject({ outcome: 'record-step-failed', err: { code }, message: fileLock[sentence] });
      expect(sleeps).toEqual([1000, 2000]);
      expect(handles).toHaveLength(3);
      expect(new Set(handles).size).toBe(3);
      /* Kept for the caller to sweep: nothing of this commit has moved. */
      expect(take.liveStaging.has(staged.takeId)).toBe(true);
      expect(names(book, `.next-${staged.takeId}.`).length).toBeGreaterThan(0);
      expect(liveId(book)).toBe(B);
    },
  );

  it('a failure that clears on the second attempt commits', async () => {
    const book = seedBook();
    const { staged, failUnlink } = await leftover(book);
    failUnlink('EACCES');
    const { result, handles, sleeps } = await budgetedCommit(book, staged, () => {
      faults.unlink = null;
    });
    expect(result).toMatchObject({ outcome: 'committed', newTakeId: staged.takeId });
    expect(sleeps).toEqual([1000]);
    expect(handles).toHaveLength(2);
  });

  it("does not run a commit again for the error it threw after step 0 (the take is committed)", async () => {
    const book = seedBook();
    const staged = await stage(book);
    failStamp('EBUSY');
    const handles: unknown[] = [];
    await expect(
      take.runWithRecordStepBudget(spanFor(book, handles), (h) => take.commitTake(h, staged, commitOpts()), {
        sleep: async () => {},
      }),
    ).rejects.toMatchObject({ code: 'EBUSY' });
    expect(handles).toHaveLength(1);
  });

  it('retries a thrown record-step error and answers the fixed fallback for one that is not an fs error', async () => {
    const book = seedBook();
    const handles: unknown[] = [];
    const result = await take.runWithRecordStepBudget(
      spanFor(book, handles),
      async () => {
        throw new Error('C:\\secret\\path is odd');
      },
      { sleep: async () => {} },
    );
    expect(result).toMatchObject({ outcome: 'record-step-failed', message: fileLock.FS_FAILURE_REQUEST_ERROR });
    expect(handles).toHaveLength(3);
  });

  it.each([
    ['a move step', () => new take.TakeMoveStepError(SLUG, fsError('EBUSY'))],
    ['a journal conflict', () => new take.TakeJournalConflictError(SLUG, 2)],
    ['an abort', () => new DOMException('aborted', 'AbortError')],
  ])('throws %s at once', async (_label, make) => {
    const book = seedBook();
    const handles: unknown[] = [];
    const error = make();
    await expect(
      take.runWithRecordStepBudget(
        spanFor(book, handles),
        async () => {
          throw error;
        },
        { sleep: async () => {} },
      ),
    ).rejects.toBe(error);
    expect(handles).toHaveLength(1);
  });

  it('passes through what a span that never ran answered, and its own error', async () => {
    const fn = vi.fn(async () => 'ran');
    expect(await take.runWithRecordStepBudget(async () => lock.BOOK_GONE, fn)).toBe(lock.BOOK_GONE);
    const busy = new Error('busy');
    let opened = 0;
    await expect(
      take.runWithRecordStepBudget(async () => {
        opened += 1;
        throw busy;
      }, fn),
    ).rejects.toBe(busy);
    expect(opened).toBe(1);
    expect(fn).not.toHaveBeenCalled();
  });
});
