/* #4320 step 6 (#4830) - `replaySlugJournals`, called first by `reconcileSlug`:
   direction (roll back before `installed`, forward from it), chains, the one
   journal in charge, and the unparseable journal (spec
   2026-11-13-chapter-take-lifecycle-design.md §5.A "Journal rules", R6-3, R9-3,
   R10-1, E6, E10). The journals are built by running `commitTake` and killing it
   at a chosen disk write. WORKSPACE_DIR is pointed at a tempdir BEFORE the
   modules load (paths.ts caches it at import). Real files, real handles. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { PrepareTakeInput, ReplayOutcome, StagedTake, TakeJournal } from './chapter-take.js';

/* Fault injection, pass-through unless a test arms it.
   - `rename` / `unlink` / `read`: a returned error is thrown in the call's place.
   - `after`: called after each completed `renameWithRetry` or `unlink`; `true`
     kills the process there: that call throws, and so does every rename and
     unlink after it, until the test disarms.
   - `stamp`: thrown by `updateStateAtDir` while a journal sits at `installed` or
     later (replay's and the commit's stamp).
   - `revisions`: every version of revisions.json that reached disk. */
const faults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Error | undefined),
  unlink: null as null | ((path: string) => Error | undefined),
  read: null as null | ((path: string) => Error | undefined),
  after: null as null | ((op: 'rename' | 'unlink', from: string, to: string) => boolean),
  dead: false,
  stamp: null as null | Error,
  revisions: [] as string[],
}));
/* Not a retryable code: `unlinkWithRetry` throws it at once. */
const crashError = vi.hoisted(
  () => (): Error => Object.assign(new Error('injected crash'), { code: 'ECRASH' }),
);
vi.mock('./atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-rename.js')>();
  const fs = await import('node:fs');
  return {
    ...actual,
    renameWithRetry: async (from: string, to: string) => {
      if (faults.dead) throw crashError();
      const error = faults.rename?.(from, to);
      if (error) throw error;
      const revisions = to.endsWith('revisions.json') ? fs.readFileSync(from, 'utf8') : null;
      await actual.renameWithRetry(from, to);
      if (revisions !== null) faults.revisions.push(revisions);
      if (faults.after?.('rename', from, to)) {
        faults.dead = true;
        throw crashError();
      }
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const unlink = (async (...args: Parameters<typeof actual.unlink>) => {
    if (faults.dead) throw crashError();
    const error = faults.unlink?.(String(args[0]));
    if (error) throw error;
    await actual.unlink(...args);
    if (faults.after?.('unlink', String(args[0]), '')) {
      faults.dead = true;
      throw crashError();
    }
  }) as typeof actual.unlink;
  const readFile = (async (...args: Parameters<typeof actual.readFile>) => {
    const error = faults.read?.(String(args[0]));
    if (error) throw error;
    return actual.readFile(...args);
  }) as typeof actual.readFile;
  return { ...actual, unlink, readFile, default: { ...actual, unlink, readFile } };
});
vi.mock('./book-state-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./book-state-update.js')>();
  const fs = await import('node:fs');
  const path = await import('node:path');
  const installed = (bookDir: string): boolean => {
    const audio = path.join(bookDir, 'audio');
    return fs
      .readdirSync(audio)
      .filter((n) => n.includes('.take-journal.') && !n.includes('.tmp-'))
      .some((n) => /"phase": "(installed|cleanup)"/.test(fs.readFileSync(path.join(audio, n), 'utf8')));
  };
  return {
    ...actual,
    updateStateAtDir: async (...args: Parameters<typeof actual.updateStateAtDir>) => {
      if (faults.stamp && installed(args[0])) throw faults.stamp;
      return actual.updateStateAtDir(...args);
    },
  };
});

/* Each test runs one or two real commits (fsyncs and renames): on a loaded box
   that outlasts the 15 s default. */
vi.setConfig({ testTimeout: 60_000 });

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let embeddingsIo: typeof import('../audio/render-integrity/embeddings-io.js');

const SLUG = 'ch-01';
const CHAPTER_ID = 3;
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
/* The new take's sidecar tag: as long as a take id, so its parts are the same
   size as the old ones and a part cannot be told apart by size alone. */
const NEWTAG = 'nnnnnnnnnnnnnnnn';
const SIDECARS = [
  'segments.json',
  'peaks.json',
  'lufs.json',
  'embeddings.json',
  'render-integrity.json',
  'render-integrity-attempted.json',
];
const STAGED_SIDECARS = SIDECARS.filter((s) => s !== 'render-integrity-attempted.json');
type Ext = 'mp3' | 'm4a' | 'ogg';
const AUDIO_BYTES: Record<Ext, (tag: string) => Buffer> = {
  mp3: (tag) => Buffer.from(`ID3${tag}`),
  m4a: (tag) => Buffer.from(`\0\0\0\x18ftyp${tag}`),
  ogg: (tag) => Buffer.from(`OggS${tag}`),
};
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'take-replay-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  take = await import('./chapter-take.js');
  lock = await import('./book-op-lock.js');
  paths = await import('./paths.js');
  embeddingsIo = await import('../audio/render-integrity/embeddings-io.js');
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

function disarm(): void {
  faults.rename = null;
  faults.unlink = null;
  faults.read = null;
  faults.after = null;
  faults.dead = false;
  faults.stamp = null;
}

afterEach(() => {
  disarm();
  faults.revisions.length = 0;
  vi.restoreAllMocks();
});

/* ---- fixtures -------------------------------------------------------------- */

interface Seeded {
  bookId: string;
  bookDir: string;
  audio: string;
}

const vec = (n: number): Float32Array => new Float32Array([n, n + 0.5]);
const seg = (characterId: string, sentenceId: number) => ({
  characterId,
  sentenceIds: [sentenceId],
  startSec: sentenceId - 1,
  endSec: sentenceId,
});
const SEGMENTS = [seg('narrator', 1), seg('amy', 2)];

function segmentsFile(synthesizedAt: string, durationSec: number, takeId?: string) {
  return {
    chapterId: CHAPTER_ID,
    durationSec,
    modelKey: 'kokoro-v1',
    synthesizedAt,
    segments: SEGMENTS,
    characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
    ...(takeId ? { takeId } : {}),
  };
}

const verdictRow = (sentenceId: number, cosine: number) => ({
  characterId: 'amy',
  sentenceIds: [sentenceId],
  verdict: 'voice-match' as const,
  cosine,
  severity: null,
  fixable: false,
  expectedEngine: 'kokoro',
  renderedEngine: 'kokoro',
  referenceKind: 'in-book' as const,
  windowed: false,
});

const LIVE_AT = '2026-02-02T00:00:00.000Z';
const PREV_AT = '2026-01-01T00:00:00.000Z';
const NEW_AT = '2026-03-03T00:00:00.000Z';

/** Write one whole take under its live or previous names, minus `omit`. */
async function seedTake(
  book: Seeded,
  which: 'live' | 'previous',
  takeId: string,
  opts: { ext: Ext; synthesizedAt: string; omit?: string[] },
): Promise<void> {
  const prefix = join(book.audio, which === 'live' ? SLUG : `${SLUG}.previous`);
  const put = (suffix: string, data: string | Buffer): void => {
    if (!opts.omit?.includes(suffix)) writeFileSync(`${prefix}.${suffix}`, data);
  };
  put(opts.ext, AUDIO_BYTES[opts.ext](takeId));
  put('segments.json', JSON.stringify(segmentsFile(opts.synthesizedAt, 20, takeId), null, 2));
  put('peaks.json', JSON.stringify({ peaks: [takeId] }, null, 2));
  put('lufs.json', JSON.stringify({ i: -18, of: takeId }, null, 2));
  if (!opts.omit?.includes('embeddings.json')) {
    await embeddingsIo.writeEmbeddings(
      `${prefix}.embeddings.json`,
      SEGMENTS.map((s, i) => ({ characterId: s.characterId, sentenceIds: s.sentenceIds, vec: vec(i + 1) })),
      'v-live',
    );
  }
  put('render-integrity.json', JSON.stringify([verdictRow(2, 0.42)], null, 2));
  put('render-integrity-attempted.json', JSON.stringify({ attemptedAt: takeId }));
}

interface SeedOptions {
  live?: boolean;
  previous?: boolean;
  liveExt?: Ext;
  previousExt?: Ext;
  omitLive?: string[];
  omitPrevious?: string[];
}

/** A book with live take B and previous take A, unless told otherwise. */
async function seedBook(opts: SeedOptions = {}): Promise<Seeded> {
  seq += 1;
  const title = `Replay Book ${seq}`;
  const bookId = paths.makeBookId('Taker', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Taker', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  const live = opts.live !== false;
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-replay-${seq}`,
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
          ...(live ? { duration: '00:20', audioRenderedAt: LIVE_AT, audioTakeId: B } : {}),
          generationState: 'failed',
          generationError: 'boom',
        },
      ],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  const book = { bookId, bookDir, audio };
  if (live) {
    await seedTake(book, 'live', B, {
      ext: opts.liveExt ?? 'mp3',
      synthesizedAt: LIVE_AT,
      omit: opts.omitLive,
    });
  }
  if (opts.previous !== false) {
    await seedTake(book, 'previous', A, {
      ext: opts.previousExt ?? 'mp3',
      synthesizedAt: PREV_AT,
      omit: opts.omitPrevious,
    });
  }
  return book;
}

function newTakeInput(ext: Ext): PrepareTakeInput {
  return {
    slug: SLUG,
    ext,
    audio: AUDIO_BYTES[ext](NEWTAG),
    segments: segmentsFile(NEW_AT, 65),
    peaks: { peaks: [NEWTAG] },
    lufs: { i: -18, of: NEWTAG },
    embeddings: {
      version: 'v-live',
      rows: SEGMENTS.map((s, i) => ({ characterId: s.characterId, sentenceIds: s.sentenceIds, vec: vec(i + 7) })),
    },
    verdicts: [verdictRow(2, 0.99)],
  };
}

const stage = (book: Seeded, ext: Ext = 'mp3'): Promise<StagedTake> =>
  take.prepareTake({ bookDir: book.bookDir }, newTakeInput(ext), new AbortController().signal);

async function inSpan<T>(
  book: Seeded,
  fn: (handle: import('./book-op-lock.js').BookHandle) => Promise<T>,
): Promise<T> {
  const out = await lock.withBookOp(book.bookId, fn);
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out as T;
}

const commit = (book: Seeded, staged: StagedTake, startTakeId: string | null = null) =>
  inSpan(book, (h) =>
    take.commitTake(h, staged, {
      base: undefined,
      startTakeId,
      signal: new AbortController().signal,
      review: { characterId: 'amy', triggeredBy: 'voice-change' },
    }),
  );

const reconcile = (book: Seeded, opts?: Parameters<typeof take.reconcileSlug>[2]) =>
  inSpan(book, (h) => take.reconcileSlug(h, SLUG, opts));

const replay = (book: Seeded): Promise<ReplayOutcome> =>
  inSpan(book, async (h) => take.replaySlugJournals(h, SLUG, await take.listTakeJournals(h)));

/* ---- observers ------------------------------------------------------------- */

/** Every take file in `audio/` (staged parts, temp leftovers and `.orphaned/`
    apart), by name -> bytes. */
function snapshot(audio: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(audio, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.includes('.next-') && !e.name.includes('.tmp-'))
      .map((e) => e.name)
      .sort()
      .map((n) => [n, readFileSync(join(audio, n), 'base64')]),
  );
}
/** Everything in the book folder, `.orphaned/` included: path -> bytes. */
function wholeBook(book: Seeded): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(dir, e.name), `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(join(dir, e.name), 'base64');
    }
  };
  walk(book.bookDir, '');
  return out;
}
const names = (audio: string, marker: string): string[] =>
  readdirSync(audio)
    .filter((n) => n.includes(marker) && !n.includes('.tmp-'))
    .sort();
const read = (path: string): string => readFileSync(path, 'utf8');
const json = <T = Record<string, unknown>>(book: Seeded, name: string): T =>
  JSON.parse(read(join(book.audio, name))) as T;
const statePath = (book: Seeded) => join(book.bookDir, '.audiobook', 'state.json');
const chapterState = (book: Seeded): Record<string, unknown> =>
  (JSON.parse(read(statePath(book))) as { chapters: Record<string, unknown>[] }).chapters[0];
function pending(book: Seeded): Array<{ id: string }> {
  const path = join(book.bookDir, '.audiobook', 'revisions.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(read(path)) as { pending: Array<{ id: string }> }).pending;
}
const entryId = (takeId: string) => `revision:${CHAPTER_ID}:${takeId}`;
/** `.orphaned/`, as `<event>/<name>` -> text. */
function orphaned(book: Seeded): Record<string, string> {
  const root = join(book.audio, '.orphaned');
  if (!existsSync(root)) return {};
  return Object.fromEntries(
    readdirSync(root)
      .sort()
      .flatMap((event) =>
        readdirSync(join(root, event))
          .sort()
          .map((name) => [`${event}/${name}`, read(join(root, event, name))]),
      ),
  );
}
const onlyJournal = (book: Seeded): TakeJournal => {
  const found = names(book.audio, '.take-journal.');
  expect(found).toHaveLength(1);
  return json<TakeJournal>(book, found[0]);
};
const fsError = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

/* ---- crash points ---------------------------------------------------------- */

type After = NonNullable<typeof faults.after>;

const isJournalName = (path: string): boolean =>
  path.includes('.take-journal.') && !path.includes('.tmp-');
/* The rename that puts a journal at `phase` on disk. */
const journalWritten =
  (phase: string): After =>
  (op, _from, to) =>
    op === 'rename' && isJournalName(to) && read(to).includes(`"phase": "${phase}"`);
const renamed =
  (from: RegExp, to: RegExp): After =>
  (op, source, target) =>
    op === 'rename' && from.test(basename(source)) && to.test(basename(target));
const esc = (s: string): string => s.replace(/[.]/g, '\\.');
const discarded = (role: string, suffix: string): RegExp =>
  new RegExp(`^${SLUG}\\.discard-[a-z2-7]{16}\\.${role}\\.${esc(suffix)}$`);
const discardRename = (suffix: string): After =>
  renamed(new RegExp(`^${SLUG}\\.previous\\.${esc(suffix)}$`), discarded('prev', suffix));
const preserveRename = (suffix: string): After =>
  renamed(new RegExp(`^${SLUG}\\.${esc(suffix)}$`), new RegExp(`^${SLUG}\\.previous\\.${esc(suffix)}$`));
const discardLiveRename = (suffix: string): After =>
  renamed(new RegExp(`^${SLUG}\\.${esc(suffix)}$`), discarded('live', suffix));
const installRename = (suffix: string): After =>
  renamed(new RegExp(`^${SLUG}\\.next-[a-z2-7]{16}\\.${esc(suffix)}$`), new RegExp(`^${SLUG}\\.${esc(suffix)}$`));
const discardUnlinked =
  (role: string, suffix: string): After =>
  (op, path) =>
    op === 'unlink' && discarded(role, suffix).test(basename(path));

/** Run a commit that dies right after the first write `after` matches, leaving
    the disk as the dead process would. Asserts the crash really happened. */
async function crashCommit(
  book: Seeded,
  after: After,
  opts: { ext?: Ext; startTakeId?: string | null } = {},
): Promise<{ staged: StagedTake; stagedBytes: Record<string, string> }> {
  const staged = await stage(book, opts.ext);
  const stagedBytes = Object.fromEntries(
    staged.parts.map((p) => [p.suffix, readFileSync(p.path, 'base64')]),
  );
  faults.after = after;
  await commit(book, staged, opts.startTakeId ?? null).catch(() => {});
  expect(faults.dead, 'the crash point was never reached').toBe(true);
  disarm();
  return { staged, stagedBytes };
}

/* A crash loses nothing: replay must never report a part lost. */
const expectNoLostPart = (): void =>
  expect(vi.mocked(console.warn).mock.calls.map((c) => String(c[0])).filter((m) => m.includes(': lost '))).toEqual(
    [],
  );

/** Before `installed`: both takes are as they were and nothing of the new one is left. */
function expectOriginals(book: Seeded, before: Record<string, string>, staged: StagedTake): void {
  expect(snapshot(book.audio)).toEqual(before);
  expect(names(book.audio, '.next-')).toEqual([]);
  expect(orphaned(book)).toEqual({});
  expectNoLostPart();
  expect(chapterState(book)).toMatchObject({ generationState: 'failed' });
  expect(chapterState(book).audioTakeId).not.toBe(staged.takeId);
  expect(pending(book).map((p) => p.id)).not.toContain(entryId(staged.takeId));
}

/** From `installed`: the new take is live, recorded once, and nothing is left over. */
function expectCommitted(
  book: Seeded,
  before: Record<string, string>,
  crashed: { staged: StagedTake; stagedBytes: Record<string, string> },
  previousFrom: 'live' | 'previous' | 'none',
): void {
  const { staged, stagedBytes } = crashed;
  const expected: Record<string, string> = {};
  for (const [suffix, bytes] of Object.entries(stagedBytes)) expected[`${SLUG}.${suffix}`] = bytes;
  for (const [name, bytes] of Object.entries(before)) {
    const isPrevious = name.startsWith(`${SLUG}.previous.`);
    if (previousFrom === 'previous' && isPrevious) expected[name] = bytes;
    if (previousFrom === 'live' && !isPrevious) {
      expected[name.replace(`${SLUG}.`, `${SLUG}.previous.`)] = bytes;
    }
  }
  expect(snapshot(book.audio)).toEqual(expected);
  expect(names(book.audio, '.next-')).toEqual([]);
  expect(orphaned(book)).toEqual({});
  expectNoLostPart();
  const chapter = chapterState(book);
  expect(chapter).toMatchObject({ audioTakeId: staged.takeId, audioRenderedAt: NEW_AT, duration: '01:05' });
  expect(chapter).not.toHaveProperty('generationState');
  expect(chapter).not.toHaveProperty('generationError');
  expect(pending(book).map((p) => p.id)).toEqual(previousFrom === 'none' ? [] : [entryId(staged.takeId)]);
}

/** Replay twice equals once: the whole book folder, `state.json` included. */
async function expectSettled(book: Seeded): Promise<void> {
  const once = wholeBook(book);
  await reconcile(book);
  expect(wholeBook(book)).toEqual(once);
}

/* ---- fault injection over the commit --------------------------------------- */

const ALL = ['mp3', ...SIDECARS];
const STAGED = ['mp3', ...STAGED_SIDECARS];

describe('reconcileSlug after a commit crashed before installed: rolled back', () => {
  const cases: Array<[string, After]> = [
    ['discard: the journal just written', journalWritten('discard')],
    ...ALL.map((s): [string, After] => [`discard: after previous ${s}`, discardRename(s)]),
    ['preserve: the journal just written', journalWritten('preserve')],
    ...ALL.map((s): [string, After] => [`preserve: after live ${s}`, preserveRename(s)]),
    ['install: the journal just written', journalWritten('install')],
    ...STAGED.map((s): [string, After] => [`install: after ${s}`, installRename(s)]),
  ];

  it.each(cases)('%s', async (_label, after) => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const { staged } = await crashCommit(book, after);

    await reconcile(book);

    expectOriginals(book, before, staged);
    await expectSettled(book);
  });

  it.each([
    ['discard-live: the journal just written', journalWritten('discard-live')],
    ...ALL.map((s): [string, After] => [`discard-live: after live ${s}`, discardLiveRename(s)]),
    ...STAGED.map((s): [string, After] => [`keepPrevious install: after ${s}`, installRename(s)]),
  ] as Array<[string, After]>)('%s', async (_label, after) => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    /* R3-1: another render committed meanwhile, so the previous take stays. */
    const { staged } = await crashCommit(book, after, { startTakeId: A });

    await reconcile(book);

    expectOriginals(book, before, staged);
    await expectSettled(book);
  });
});

describe('reconcileSlug after a commit crashed from installed on: rolled forward', () => {
  const cases: Array<[string, After]> = [
    ['installed: the journal just written, no stamp yet', journalWritten('installed')],
    [
      'installed: stamped, no review record yet',
      (op, _from, to) => op === 'rename' && to.endsWith('state.json') && existsSync(to) && read(to).includes(NEW_AT),
    ],
    ['installed: the review record written', (op, _from, to) => op === 'rename' && to.endsWith('revisions.json')],
    ['cleanup: the journal just written', journalWritten('cleanup')],
    ...ALL.map((s): [string, After] => [`cleanup: after unlinking previous ${s}`, discardUnlinked('prev', s)]),
  ];

  it.each(cases)('%s', async (_label, after) => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const crashed = await crashCommit(book, after);

    await reconcile(book);

    expectCommitted(book, before, crashed, 'live');
    await expectSettled(book);
  });

  it.each(ALL)('keepPrevious cleanup: after unlinking live %s', async (suffix) => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const crashed = await crashCommit(book, discardUnlinked('live', suffix), { startTakeId: A });

    await reconcile(book);

    expectCommitted(book, before, crashed, 'previous');
    await expectSettled(book);
  });

  it('after installed and before the review record: stamp first, then one entry, and one after a second replay', async () => {
    const book = await seedBook();
    const { staged } = await crashCommit(book, journalWritten('installed'));
    expect(chapterState(book).audioTakeId).toBe(B);
    expect(pending(book)).toEqual([]);

    faults.stamp = fsError('EROFS');
    await expect(reconcile(book)).rejects.toBe(faults.stamp);
    /* E6: no entry while the stamp is owed, and the journal still owes it. */
    expect(faults.revisions.filter((v) => v.includes(staged.takeId))).toEqual([]);
    expect(onlyJournal(book).phase).toBe('installed');

    faults.stamp = null;
    await reconcile(book);
    expect(chapterState(book).audioTakeId).toBe(staged.takeId);
    expect(pending(book).map((p) => p.id)).toEqual([entryId(staged.takeId)]);
    await reconcile(book);
    expect(pending(book).map((p) => p.id)).toEqual([entryId(staged.takeId)]);
  });
});

/* Every write of a commit, in turn, over takes whose part sets differ. Each test
   runs one commit and one replay per write, hence the longer timeout. */
describe('every crash point converges', { timeout: 300_000 }, () => {
  const variants: Array<{
    label: string;
    seed: SeedOptions;
    ext: Ext;
    startTakeId: string | null;
    previousFrom: 'live' | 'previous' | 'none';
  }> = [
    {
      label: 'uneven part sets and three audio extensions',
      seed: {
        previousExt: 'm4a',
        omitLive: ['lufs.json', 'render-integrity.json'],
        omitPrevious: ['peaks.json', 'embeddings.json'],
      },
      ext: 'ogg',
      startTakeId: null,
      previousFrom: 'live',
    },
    { label: 'keepPrevious (R3-1)', seed: {}, ext: 'mp3', startTakeId: A, previousFrom: 'previous' },
    { label: 'a first render', seed: { live: false, previous: false }, ext: 'mp3', startTakeId: null, previousFrom: 'none' },
  ];

  /* Counting starts at the commit's own journal: before it nothing has moved. */
  const nthWrite = (n: number, seen: { installed: boolean }): After => {
    let count = -1;
    return (op, from, to) => {
      if (count < 0 && !(op === 'rename' && isJournalName(to))) return false;
      count += 1;
      if (journalWritten('installed')(op, from, to)) seen.installed = true;
      return count === n;
    };
  };

  /* keepPrevious is covered write by write in the named cases above. */
  it.each([variants[0], variants[2]])('$label: a crash after any write', async ({ seed, ext, startTakeId, previousFrom }) => {
    let reached = 0;
    for (let n = 0; ; n++) {
      const book = await seedBook(seed);
      const before = snapshot(book.audio);
      const staged = await stage(book, ext);
      const stagedBytes = Object.fromEntries(staged.parts.map((p) => [p.suffix, readFileSync(p.path, 'base64')]));
      const seen = { installed: false };
      faults.after = nthWrite(n, seen);
      await commit(book, staged, startTakeId).catch(() => {});
      const crashed = faults.dead;
      disarm();
      if (!crashed) break;
      reached += 1;

      await reconcile(book);

      if (seen.installed) expectCommitted(book, before, { staged, stagedBytes }, previousFrom);
      else expectOriginals(book, before, staged);
    }
    expect(reached).toBeGreaterThan(8);
  });

  it.each([variants[0]])(
    '$label: a replay that itself crashes after any write',
    async ({ seed, ext, startTakeId }) => {
      let reached = 0;
      for (let n = 0; ; n++) {
        const book = await seedBook(seed);
        const before = snapshot(book.audio);
        /* Everything installed, `installed` not yet written: the longest rollback. */
        const { staged } = await crashCommit(book, installRename('segments.json'), { ext, startTakeId });
        let count = 0;
        faults.after = () => count++ === n;
        await replay(book).catch(() => {});
        const crashed = faults.dead;
        disarm();
        if (!crashed) break;
        reached += 1;
        /* Died between the journal unlink and the staged sweep: no journal names
           those parts, so they are the sweep's (#4832), and no replay touches them. */
        if (names(book.audio, '.take-journal.').length === 0) {
          for (const name of names(book.audio, '.next-')) rmSync(join(book.audio, name));
        }

        await reconcile(book);

        expectOriginals(book, before, staged);
      }
      expect(reached).toBeGreaterThan(8);
    },
  );

  /* The commit's own rollback stops part-way, which leaves the journal at a later
     phase than the disk. */
  /* A first render has no old take for a stopped rollback to disturb. */
  it.each(variants.slice(0, 2))(
    '$label: an in-span rollback that stops after any rename',
    async ({ seed, ext, startTakeId }) => {
      let reached = 0;
      for (let n = 0; ; n++) {
        const book = await seedBook(seed);
        const before = snapshot(book.audio);
        const staged = await stage(book, ext);
        let failed = false;
        let count = 0;
        faults.rename = (from, to) => {
          if (!failed && isJournalName(to) && read(from).includes('"phase": "installed"')) {
            failed = true;
            return fsError('EIO');
          }
          return undefined;
        };
        faults.after = (op) => failed && op === 'rename' && count++ === n;
        await commit(book, staged, startTakeId).catch(() => {});
        const crashed = faults.dead;
        disarm();
        if (!crashed) break;
        reached += 1;

        await reconcile(book);

        expectOriginals(book, before, staged);
      }
      expect(reached).toBeGreaterThan(2);
    },
  );

  it('an in-span rollback that restored everything but could not unlink its journal', async () => {
    for (const { seed, ext, startTakeId } of variants) {
      const book = await seedBook(seed);
      const before = snapshot(book.audio);
      const staged = await stage(book, ext);
      faults.rename = (from, to) =>
        isJournalName(to) && read(from).includes('"phase": "installed"') ? fsError('EIO') : undefined;
      faults.unlink = (path) => (isJournalName(path) ? fsError('EISDIR') : undefined);
      await commit(book, staged, startTakeId).catch(() => {});
      expect(names(book.audio, '.take-journal.')).toHaveLength(1);
      disarm();

      await reconcile(book);

      expect(names(book.audio, '.take-journal.')).toEqual([]);
      expectOriginals(book, before, staged);
    }
  });
});

/* ---- a name refilled from outside (R10-1) ---------------------------------- */

describe('replay meets a refilled name', () => {
  const PLANTED = 'ID3 planted by a sync client';
  const quarantinedAs = (book: Seeded, jid: string, name: string) => {
    const found = orphaned(book);
    expect(Object.keys(found)).toEqual([expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${jid}/`))]);
    expect(basename(Object.keys(found)[0])).toBe(name);
    return Object.values(found)[0];
  };

  it.each([
    ['right after step 5 moved the live audio', preserveRename('mp3')],
    ['once the install phase is journalled', journalWritten('install')],
  ] as Array<[string, After]>)(
    'the live audio name, %s: rolled back, the copy quarantined, the old take live whole',
    async (_label, after) => {
      const book = await seedBook();
      const before = snapshot(book.audio);
      const { staged } = await crashCommit(book, after);
      const { jid } = onlyJournal(book);
      writeFileSync(join(book.audio, `${SLUG}.mp3`), PLANTED);

      await reconcile(book);

      expect(snapshot(book.audio)).toEqual(before);
      expect(names(book.audio, '.next-')).toEqual([]);
      expect(quarantinedAs(book, jid, `${SLUG}.mp3`)).toBe(PLANTED);
      expect(chapterState(book).audioTakeId).not.toBe(staged.takeId);
    },
  );

  it.each([
    ['right after step 4', discardRename('render-integrity-attempted.json')],
    ['once the preserve phase is journalled', journalWritten('preserve')],
  ] as Array<[string, After]>)(
    'a discard rolled back onto .previous.mp3, %s: the copy quarantined, the old previous take whole',
    async (_label, after) => {
      const book = await seedBook();
      const before = snapshot(book.audio);
      await crashCommit(book, after);
      const { jid } = onlyJournal(book);
      writeFileSync(join(book.audio, `${SLUG}.previous.mp3`), PLANTED);

      await reconcile(book);

      expect(snapshot(book.audio)).toEqual(before);
      expect(quarantinedAs(book, jid, `${SLUG}.previous.mp3`)).toBe(PLANTED);
    },
  );

  it('a leftover live audio the install moved to .stale. goes back to its name', async () => {
    const book = await seedBook();
    const staged = await stage(book);
    faults.rename = (_from, to) => {
      const leftover = join(book.audio, `${SLUG}.ogg`);
      if (to.includes('.previous.') && !existsSync(leftover)) writeFileSync(leftover, 'OggSleftover');
      return undefined;
    };
    faults.after = (op, _from, to) => op === 'rename' && to.includes('.stale.');
    await commit(book, staged).catch(() => {});
    expect(faults.dead).toBe(true);
    disarm();

    expect(await replay(book)).toEqual({ result: 'rolled-back', gone: true });

    expect(read(join(book.audio, `${SLUG}.ogg`))).toBe('OggSleftover');
    expect(readFileSync(join(book.audio, `${SLUG}.mp3`))).toEqual(AUDIO_BYTES.mp3(B));
    expect(names(book.audio, '.discard-')).toEqual([]);
    expect(names(book.audio, '.next-')).toEqual([]);
  });

  it('a part deleted from outside is recorded in the journal, which survives a later refusal', async () => {
    const book = await seedBook();
    await crashCommit(book, journalWritten('install'));
    rmSync(join(book.audio, `${SLUG}.previous.peaks.json`));
    faults.rename = (from) => (basename(from).includes('.discard-') ? fsError('EBUSY') : undefined);

    await expect(replay(book)).rejects.toBeInstanceOf(take.TakeMoveStepError);

    expect(onlyJournal(book).lost).toEqual([
      expect.objectContaining({ part: 'peaks', take: 'live' }),
    ]);
    faults.rename = null;
    expect(await replay(book)).toEqual({ result: 'rolled-back', gone: true });
    expect(names(book.audio, '.take-journal.')).toEqual([]);
  });
});

/* ---- outcomes -------------------------------------------------------------- */

describe('replaySlugJournals - outcomes and reconcileSlug options', () => {
  it('no journal: none', async () => {
    const book = await seedBook();
    /* A first span may migrate the seeded state.json. */
    await inSpan(book, async () => {});
    const before = wholeBook(book);
    expect(await replay(book)).toEqual({ result: 'none', gone: true });
    expect(wholeBook(book)).toEqual(before);
  });

  it('a stamp that fails: parked, the journal still there', async () => {
    const book = await seedBook();
    await crashCommit(book, journalWritten('installed'));
    faults.stamp = fsError('EROFS');
    expect(await replay(book)).toEqual({ result: 'parked', gone: false, error: faults.stamp });
    expect(names(book.audio, '.take-journal.')).toHaveLength(1);
    faults.stamp = null;
    expect(await replay(book)).toEqual({ result: 'rolled-forward', gone: true });
  });

  it('only the cleanup phase write fails: parked, and the journal is gone', async () => {
    const book = await seedBook();
    await crashCommit(book, journalWritten('installed'));
    const error = fsError('EPERM');
    faults.rename = (from, to) =>
      isJournalName(to) && read(from).includes('"phase": "cleanup"') ? error : undefined;
    expect(await replay(book)).toEqual({ result: 'parked', gone: true, error });
    expect(names(book.audio, '.take-journal.')).toEqual([]);
  });

  it('a rollback whose journal unlink fails throws that error and keeps the journal', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const { staged } = await crashCommit(book, journalWritten('install'));
    faults.unlink = (path) => (isJournalName(path) ? fsError('EISDIR') : undefined);
    await expect(replay(book)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(names(book.audio, '.take-journal.')).toHaveLength(1);
    /* The staged set is swept only once the journal is gone. */
    expect(names(book.audio, '.next-')).toHaveLength(staged.parts.length);
    faults.unlink = null;
    await reconcile(book);
    expectOriginals(book, before, staged);
  });

  it('migrate: false replays the journal and skips the lazy migration', async () => {
    const book = await seedBook({ previous: false });
    await crashCommit(book, journalWritten('install'));
    /* A previous take under the wrong extension, for step 3 to rename. */
    writeFileSync(join(book.audio, `${SLUG}.previous.m4a`), AUDIO_BYTES.ogg('wrong-name'));

    await reconcile(book, { migrate: false });

    expect(names(book.audio, '.take-journal.')).toEqual([]);
    expect(existsSync(join(book.audio, `${SLUG}.previous.m4a`))).toBe(true);
    await reconcile(book);
    expect(existsSync(join(book.audio, `${SLUG}.previous.ogg`))).toBe(true);
  });

  it('uses a listing it is given', async () => {
    const book = await seedBook();
    await crashCommit(book, journalWritten('install'));
    const empty = await inSpan(book, async (h) => ({
      ...(await take.listTakeJournals(h)),
      journals: new Map(),
    }));

    await reconcile(book, { listing: empty, migrate: false });
    expect(names(book.audio, '.take-journal.')).toHaveLength(1);

    const listing = await inSpan(book, (h) => take.listTakeJournals(h));
    await reconcile(book, { listing, migrate: false });
    expect(names(book.audio, '.take-journal.')).toEqual([]);
  });
});

/* ---- chains and conflicts -------------------------------------------------- */

/** Two journals of one slug, both left by real commits: J1 stopped at
    `installed`, then J2 stopped right after `second`. J1 is held aside while J2
    runs, or J2's step 0 would replay it. With `supersede`, J2 names J1, as step
    0 will write it (#4831). */
async function twoJournals(second: After, supersede: boolean) {
  const book = await seedBook();
  const first = await crashCommit(book, journalWritten('installed'));
  const [oneName] = names(book.audio, '.take-journal.');
  const aside = join(book.bookDir, 'held-journal');
  renameSync(join(book.audio, oneName), aside);
  const afterOne = snapshot(book.audio);
  const next = await crashCommit(book, second);
  const [twoName] = names(book.audio, '.take-journal.');
  renameSync(aside, join(book.audio, oneName));
  const one = json<TakeJournal>(book, oneName);
  const two = json<TakeJournal>(book, twoName);
  if (supersede) {
    two.supersedes = [{ jid: one.jid, discards: [], dropEntry: true }];
    writeFileSync(join(book.audio, twoName), JSON.stringify(two, null, 2));
  }
  return { book, first: first.staged, next: next.staged, one, two, oneName, twoName, afterOne };
}

describe('replay of a chain (R9-3, E10)', () => {
  it('J2 whose unlink of J1 failed: replay acts only through J2', async () => {
    const { book, first, next, oneName } = await twoJournals(journalWritten('cleanup'), true);
    faults.revisions.length = 0;

    expect(await replay(book)).toEqual({ result: 'rolled-forward', gone: true });

    expect(names(book.audio, '.take-journal.')).toEqual([]);
    expect(existsSync(join(book.audio, oneName))).toBe(false);
    expect(faults.revisions.filter((v) => v.includes(first.takeId))).toEqual([]);
    expect(pending(book).map((p) => p.id)).toEqual([entryId(next.takeId)]);
    expect(chapterState(book).audioTakeId).toBe(next.takeId);
    expect(orphaned(book)).toEqual({});
    await expectSettled(book);
  });

  it('a superseding journal before installed rolls back unlinking only its own file; J1 is next', async () => {
    const { book, first, next, oneName, afterOne } = await twoJournals(journalWritten('install'), true);

    expect(await replay(book)).toEqual({ result: 'rolled-back', gone: true });

    expect(names(book.audio, '.take-journal.')).toEqual([oneName]);
    const after = snapshot(book.audio);
    delete after[oneName];
    expect(after).toEqual(afterOne);
    expect(chapterState(book).audioTakeId).not.toBe(next.takeId);

    expect(await replay(book)).toEqual({ result: 'rolled-forward', gone: true });
    expect(pending(book).map((p) => p.id)).toEqual([entryId(first.takeId)]);
  });

  it('J2 unreadable (EBUSY): replay throws and touches no file', async () => {
    const { book, twoName } = await twoJournals(journalWritten('cleanup'), true);
    /* An unparseable journal beside them is left too: nothing is acted on until every one reads. */
    writeFileSync(join(book.audio, `${SLUG}.take-journal.aaaaaaaaaaaaaaaa.json`), '{ torn');
    const before = wholeBook(book);
    faults.read = (path) => (basename(path) === twoName ? fsError('EBUSY') : undefined);

    await expect(reconcile(book)).rejects.toMatchObject({ code: 'EBUSY' });

    expect(wholeBook(book)).toEqual(before);
  });

  it('two unsuperseded journals throw TakeJournalConflictError and nothing moves', async () => {
    const { book } = await twoJournals(journalWritten('install'), false);
    const before = wholeBook(book);

    const refused = reconcile(book);

    await expect(refused).rejects.toBeInstanceOf(take.TakeJournalConflictError);
    await expect(refused).rejects.not.toThrow(book.bookDir);
    expect(wholeBook(book)).toEqual(before);
  });

  it('journals that only name each other are a conflict, not a slug with no journal', async () => {
    const { book, one, two, oneName } = await twoJournals(journalWritten('cleanup'), true);
    writeFileSync(
      join(book.audio, oneName),
      JSON.stringify({ ...one, supersedes: [{ jid: two.jid, discards: [], dropEntry: false }] }),
    );

    await expect(replay(book)).rejects.toBeInstanceOf(take.TakeJournalConflictError);
    await inSpan(book, (h) => take.quarantineConflictingJournals(h, SLUG));
    expect(names(book.audio, '.take-journal.')).toEqual([]);
  });

  it('quarantineConflictingJournals moves every unsuperseded journal and its files into one event folder', async () => {
    const { book, one, two, oneName, twoName } = await twoJournals(journalWritten('install'), false);
    const named = readdirSync(book.audio).filter((n) =>
      [`.discard-${one.jid}.`, `.discard-${two.jid}.`, `.next-${two.newTakeId}.`].some((m) => n.includes(m)),
    );
    expect(named.length).toBeGreaterThan(8);
    const expected = Object.fromEntries(
      [...named, oneName, twoName].map((n) => [n, read(join(book.audio, n))]),
    );
    const untouched = Object.entries(snapshot(book.audio)).filter(([n]) => !(n in expected));

    const event = await inSpan(book, (h) => take.quarantineConflictingJournals(h, SLUG));

    const moved = orphaned(book);
    expect(new Set(Object.keys(moved).map((k) => k.split('/')[0]))).toEqual(new Set([basename(event!)]));
    expect(Object.fromEntries(Object.entries(moved).map(([k, v]) => [basename(k), v]))).toEqual(expected);
    expect(Object.entries(snapshot(book.audio))).toEqual(untouched);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(twoName));
    expect(await replay(book)).toEqual({ result: 'none', gone: true });
  });

  it('quarantineConflictingJournals leaves a slug with one journal in charge alone', async () => {
    const { book } = await twoJournals(journalWritten('cleanup'), true);
    const before = wholeBook(book);
    expect(await inSpan(book, (h) => take.quarantineConflictingJournals(h, SLUG))).toBeNull();
    expect(wholeBook(book)).toEqual(before);
  });
});

/* ---- the unparseable journal (R6-3) ---------------------------------------- */

describe('an unparseable journal', () => {
  /* A commit stopped part-way through its install, with its journal then torn. */
  async function torn() {
    const book = await seedBook();
    const { staged } = await crashCommit(book, installRename('mp3'));
    const [name] = names(book.audio, '.take-journal.');
    const { jid } = json<TakeJournal>(book, name);
    writeFileSync(join(book.audio, name), '{ torn');
    return { book, staged, name, jid };
  }

  it('is quarantined with its discards, nothing is unlinked, and the next commit is not blocked', async () => {
    const { book, name, jid } = await torn();
    const moving = [name, ...names(book.audio, `.discard-${jid}.`)].sort();
    expect(moving.length).toBeGreaterThan(1);
    const expected = Object.fromEntries(moving.map((n) => [n, read(join(book.audio, n))]));
    const next = names(book.audio, '.next-');
    const unlinked: string[] = [];
    faults.unlink = (path) => {
      unlinked.push(path);
      return undefined;
    };

    expect(await replay(book)).toEqual({ result: 'none', gone: true });

    const moved = orphaned(book);
    expect(Object.keys(moved).sort()).toEqual(
      moving.map((n) => expect.stringMatching(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${jid}/${esc(n)}$`))),
    );
    expect(Object.fromEntries(Object.entries(moved).map(([k, v]) => [basename(k), v]))).toEqual(expected);
    expect(unlinked).toEqual([]);
    /* Which `.next-*` it staged cannot be known: the sweep's job. */
    expect(names(book.audio, '.next-')).toEqual(next);

    disarm();
    await reconcile(book);
    const staged = await stage(book);
    expect(await commit(book, staged)).toMatchObject({ outcome: 'committed' });
  });

  it('a refused move is a move-step failure and leaves the journal to be found again', async () => {
    const { book, name } = await torn();
    faults.rename = (from) => (basename(from).includes('.discard-') ? fsError('EBUSY') : undefined);

    await expect(replay(book)).rejects.toBeInstanceOf(take.TakeMoveStepError);

    expect(names(book.audio, '.take-journal.')).toEqual([name]);
    faults.rename = null;
    expect(await replay(book)).toEqual({ result: 'none', gone: true });
    expect(names(book.audio, '.take-journal.')).toEqual([]);
  });

  it('is quarantined even when its event folder already holds one of the names', async () => {
    const { book, name, jid } = await torn();
    const earlier = join(book.audio, '.orphaned', `${new Date().toISOString().slice(0, 10)}-${jid}`);
    mkdirSync(earlier, { recursive: true });
    writeFileSync(join(earlier, name), 'an earlier quarantine');

    expect(await replay(book)).toEqual({ result: 'none', gone: true });

    expect(read(join(earlier, name))).toBe('an earlier quarantine');
    expect(Object.values(orphaned(book))).toContain('{ torn');
  });

  it('never reads a read error as unparseable', async () => {
    const { book, name } = await torn();
    const before = wholeBook(book);
    faults.read = (path) => (basename(path) === name ? fsError('EPERM') : undefined);

    await expect(replay(book)).rejects.toMatchObject({ code: 'EPERM' });

    expect(wholeBook(book)).toEqual(before);
  });
});
