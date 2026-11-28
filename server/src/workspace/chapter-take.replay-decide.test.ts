/* #4320 step 5 (#4829) — the per-part decider of a per-slug journal replay:
   the idempotence table by name kind (R9-1), the two-slug-names rule (E15),
   the lost row and its one shared re-probe schedule (R8-1, R9-2), and
   decide-all-before-rename (spec 2026-11-13-chapter-take-lifecycle-design.md
   §5.A "Journal rules"). WORKSPACE_DIR is pointed at a tempdir BEFORE the
   modules load (paths.ts caches it at import). Real files, real handles. */
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { PartMove, TakeJournal } from './chapter-take.js';

/* Pass-through unless a test arms it. `rename` is called before every
   `renameWithRetry` (the quarantine's included): a returned error is thrown in
   its place, as the one left after the helper's own retries. */
const faults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Error | undefined),
  renames: [] as Array<{ from: string; to: string }>,
}));
vi.mock('./atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-rename.js')>();
  return {
    ...actual,
    renameWithRetry: async (from: string, to: string) => {
      faults.renames.push({ from, to });
      const error = faults.rename?.(from, to);
      if (error) throw error;
      return actual.renameWithRetry(from, to);
    },
  };
});

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let retry: typeof import('./atomic-rename.js');

const SLUG = 'ch-01';
const JID = 'jjjjjjjjjjjjjjjj';
const NEW = 'nnnnnnnnnnnnnnnn';
const LIVE = 'bbbbbbbbbbbbbbbb';
const PREV = 'aaaaaaaaaaaaaaaa';
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'take-decide-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  take = await import('./chapter-take.js');
  lock = await import('./book-op-lock.js');
  paths = await import('./paths.js');
  retry = await import('./atomic-rename.js');
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  faults.rename = null;
  faults.renames.length = 0;
  vi.restoreAllMocks();
});

/* ---- fixtures -------------------------------------------------------------- */

interface Seeded {
  bookId: string;
  bookDir: string;
  audio: string;
}

function seedBook(): Seeded {
  seq += 1;
  const title = `Decide Book ${seq}`;
  const bookId = paths.makeBookId('Taker', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Taker', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-decide-${seq}`,
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

const journal: TakeJournal = {
  op: 'commit',
  jid: JID,
  phase: 'preserve',
  newTakeId: NEW,
  liveTakeId: LIVE,
  prevTakeId: PREV,
  keepPrevious: false,
  parts: { live: [], previous: [], staged: [] },
  chapter: { id: 1, slug: SLUG },
  clearGenerationState: true,
  preserved: true,
  oldDuration: '00:20',
  newDuration: '00:30',
  entry: null,
  supersedes: [],
  lost: [],
};

/* The names a commit journal's moves use. */
const live = (book: Seeded, suffix: string) => join(book.audio, `${SLUG}.${suffix}`);
const previous = (book: Seeded, suffix: string) => join(book.audio, `${SLUG}.previous.${suffix}`);
const staged = (book: Seeded, suffix: string) => join(book.audio, `${SLUG}.next-${NEW}.${suffix}`);
const discard = (book: Seeded, suffix: string) =>
  join(book.audio, `${SLUG}.discard-${JID}.prev.${suffix}`);

/* A move of the live take's audio, `size` as recorded by the journal. */
const audioMove = (from: string, to: string, size = 0): PartMove => ({
  part: 'audio',
  ext: 'mp3',
  take: 'live',
  takeId: LIVE,
  size,
  from,
  to,
});
const sidecarMove = (
  part: 'segments' | 'embeddings' | 'peaks' | 'lufs',
  from: string,
  to: string,
  size = 0,
): PartMove => ({ part, take: 'live', takeId: LIVE, size, from, to });

const put = (path: string, text: string): void => writeFileSync(path, text);
const read = (path: string): string => readFileSync(path, 'utf8');
const size = (text: string): number => Buffer.byteLength(text);
const fsError = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

/** Everything under `audio/.orphaned/`, as `<event>/<name>` -> text. */
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
/** The same with the event folder's date dropped, and the folder asserted to be
    the journal's own. */
function quarantinedFiles(book: Seeded): Record<string, string> {
  return Object.fromEntries(
    Object.entries(orphaned(book)).map(([key, text]) => {
      const match = new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${JID}/(.+)$`).exec(key);
      expect(match, `not in the journal's event folder: ${key}`).not.toBeNull();
      return [match![1], text];
    }),
  );
}

async function apply(
  book: Seeded,
  moves: PartMove[],
  sleep: (ms: number) => Promise<void> = async () => {},
) {
  const out = await lock.withBookOp(book.bookId, (h) =>
    take.applyPartMoves(h, journal, moves, { sleep }),
  );
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out;
}

/* ---- the pure row decision -------------------------------------------------- */

describe('decidePartRow - the idempotence table by name kind (R9-1)', () => {
  const at = (name: string) => join('book', 'audio', name);
  const slugLive = at(`${SLUG}.mp3`);
  const slugPrev = at(`${SLUG}.previous.mp3`);
  const next = at(`${SLUG}.next-${NEW}.mp3`);
  const discarded = at(`${SLUG}.discard-${JID}.prev.mp3`);

  it.each([
    ['present/absent', true, false, slugLive, slugPrev, 'rename'],
    ['absent/present', false, true, slugLive, slugPrev, 'done'],
    ['absent/absent', false, false, slugLive, slugPrev, 'absent'],
    ['both, target a discard name', true, true, slugPrev, discarded, 'foreign-source'],
    ['both, target a staged name', true, true, slugLive, next, 'foreign-source'],
    ['both, source a discard name', true, true, discarded, slugPrev, 'foreign-target'],
    ['both, source a staged name', true, true, next, slugLive, 'foreign-target'],
    ['both slug names, live to previous', true, true, slugLive, slugPrev, 'two-slug-names'],
    ['both slug names, previous to live', true, true, slugPrev, slugLive, 'two-slug-names'],
  ] as const)('%s', (_label, source, target, from, to, row) => {
    expect(take.decidePartRow({ source, target }, audioMove(from, to), journal)).toBe(row);
  });

  it('only this journal makes a name journal-unique: another id is no evidence', () => {
    const other = at(`${SLUG}.discard-zzzzzzzzzzzzzzzz.prev.mp3`);
    expect(
      take.decidePartRow({ source: true, target: true }, audioMove(slugPrev, other), journal),
    ).toBe('two-slug-names');
  });
});

/* ---- the table on real files ------------------------------------------------ */

describe('applyPartMoves - one row each, on real files', () => {
  it('present/absent: renames', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'take');
    const out = await apply(book, [audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4)]);
    expect(out).toEqual({ lost: [], quarantined: [] });
    expect(existsSync(live(book, 'mp3'))).toBe(false);
    expect(read(previous(book, 'mp3'))).toBe('take');
  });

  it('absent/present: done, nothing renamed', async () => {
    const book = seedBook();
    put(previous(book, 'mp3'), 'take');
    const out = await apply(book, [audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4)]);
    expect(out).toEqual({ lost: [], quarantined: [] });
    expect(faults.renames).toEqual([]);
    expect(read(previous(book, 'mp3'))).toBe('take');
  });

  it('both present, target journal-unique: the source copy is foreign and quarantined; done', async () => {
    const book = seedBook();
    put(previous(book, 'mp3'), 'planted');
    put(discard(book, 'mp3'), 'ours');
    const out = await apply(book, [audioMove(previous(book, 'mp3'), discard(book, 'mp3'), 4)]);
    expect(out.lost).toEqual([]);
    expect(out.quarantined.map((p) => basename(p))).toEqual([`${SLUG}.previous.mp3`]);
    expect(read(out.quarantined[0])).toBe('planted');
    expect(quarantinedFiles(book)).toEqual({ [`${SLUG}.previous.mp3`]: 'planted' });
    expect(existsSync(previous(book, 'mp3'))).toBe(false);
    expect(read(discard(book, 'mp3'))).toBe('ours');
  });

  it('install undone onto a staged name: the planted live copy is quarantined; done (R10-1)', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'planted');
    put(staged(book, 'mp3'), 'the new take');
    const out = await apply(book, [audioMove(live(book, 'mp3'), staged(book, 'mp3'), 12)]);
    expect(out.lost).toEqual([]);
    expect(quarantinedFiles(book)).toEqual({ [`${SLUG}.mp3`]: 'planted' });
    expect(existsSync(live(book, 'mp3'))).toBe(false);
    expect(read(staged(book, 'mp3'))).toBe('the new take');
  });

  it('both present, source journal-unique: the target copy is quarantined, then renamed', async () => {
    const book = seedBook();
    put(discard(book, 'mp3'), 'ours');
    put(previous(book, 'mp3'), 'planted, and as long as recorded');
    const out = await apply(book, [
      audioMove(
        discard(book, 'mp3'),
        previous(book, 'mp3'),
        size('planted, and as long as recorded'),
      ),
    ]);
    expect(out.lost).toEqual([]);
    expect(quarantinedFiles(book)).toEqual({
      [`${SLUG}.previous.mp3`]: 'planted, and as long as recorded',
    });
    expect(read(previous(book, 'mp3'))).toBe('ours');
    expect(existsSync(discard(book, 'mp3'))).toBe(false);
  });
});

describe('applyPartMoves - two slug names (E15)', () => {
  /* In each case the FOREIGN copy has the recorded size, so only the id can
     give the right answer. */
  const withId = (takeId: string) => JSON.stringify({ takeId });
  const foreign = JSON.stringify({ takeId: 'ffffffffffffffff', padding: 'xxxxxxxx' });

  it.each(['segments', 'embeddings'] as const)(
    '%s: the copy carrying the id at the source is renamed over the quarantined target',
    async (part) => {
      const book = seedBook();
      const from = previous(book, `${part}.json`);
      const to = live(book, `${part}.json`);
      put(from, withId(LIVE));
      put(to, foreign);
      const out = await apply(book, [sidecarMove(part, from, to, size(foreign))]);
      expect(out.lost).toEqual([]);
      expect(read(to)).toBe(withId(LIVE));
      expect(existsSync(from)).toBe(false);
      expect(quarantinedFiles(book)).toEqual({ [basename(to)]: foreign });
    },
  );

  it('segments: the copy carrying the id at the target stays, the source is quarantined', async () => {
    const book = seedBook();
    const from = live(book, 'segments.json');
    const to = previous(book, 'segments.json');
    put(from, foreign);
    put(to, withId(LIVE));
    const out = await apply(book, [sidecarMove('segments', from, to, size(foreign))]);
    expect(out.lost).toEqual([]);
    expect(read(to)).toBe(withId(LIVE));
    expect(quarantinedFiles(book)).toEqual({ [basename(from)]: foreign });
  });

  it('segments: when both copies carry the id, the recorded size decides', async () => {
    const book = seedBook();
    const from = previous(book, 'segments.json');
    const to = live(book, 'segments.json');
    const edited = JSON.stringify({ takeId: LIVE, edited: true });
    put(from, withId(LIVE));
    put(to, edited);
    await apply(book, [sidecarMove('segments', from, to, size(withId(LIVE)))]);
    expect(read(to)).toBe(withId(LIVE));
    expect(quarantinedFiles(book)).toEqual({ [basename(to)]: edited });
  });

  it('segments: when neither copy carries the id, the recorded size decides', async () => {
    const book = seedBook();
    const from = previous(book, 'segments.json');
    const to = live(book, 'segments.json');
    put(from, '{"ours":1}');
    put(to, 'not json at all, and longer');
    await apply(book, [sidecarMove('segments', from, to, size('{"ours":1}'))]);
    expect(read(to)).toBe('{"ours":1}');
    expect(quarantinedFiles(book)).toEqual({ [basename(to)]: 'not json at all, and longer' });
  });

  it('a part without an id is never decided by one', async () => {
    const book = seedBook();
    const from = previous(book, 'peaks.json');
    const to = live(book, 'peaks.json');
    const lookalike = withId(LIVE);
    put(from, '[1]');
    put(to, lookalike);
    await apply(book, [sidecarMove('peaks', from, to, 3)]);
    expect(read(to)).toBe('[1]');
    expect(quarantinedFiles(book)).toEqual({ [basename(to)]: lookalike });
  });

  it('size, protocol copy at the source: the planted audio of another size is quarantined', async () => {
    const book = seedBook();
    const from = previous(book, 'mp3');
    const to = live(book, 'mp3');
    put(from, 'ID3 the take');
    put(to, 'ID3 planted, another size');
    const out = await apply(book, [audioMove(from, to, size('ID3 the take'))]);
    expect(out.lost).toEqual([]);
    expect(read(to)).toBe('ID3 the take');
    expect(existsSync(from)).toBe(false);
    expect(quarantinedFiles(book)).toEqual({ [basename(to)]: 'ID3 planted, another size' });
  });

  it('size, protocol copy at the target: done, the planted source is quarantined', async () => {
    const book = seedBook();
    const from = live(book, 'mp3');
    const to = previous(book, 'mp3');
    put(from, 'ID3 planted, another size');
    put(to, 'ID3 the take');
    const out = await apply(book, [audioMove(from, to, size('ID3 the take'))]);
    expect(out.lost).toEqual([]);
    expect(read(to)).toBe('ID3 the take');
    expect(quarantinedFiles(book)).toEqual({ [basename(from)]: 'ID3 planted, another size' });
  });

  it('identical bytes: the copy at the target counts, the other is quarantined, nothing lost', async () => {
    const book = seedBook();
    const from = live(book, 'mp3');
    const to = previous(book, 'mp3');
    put(from, 'ID3 same');
    put(to, 'ID3 same');
    const stamp = new Date('2001-02-03T04:05:06.000Z');
    utimesSync(to, stamp, stamp);
    const out = await apply(book, [audioMove(from, to, size('ID3 same'))]);
    expect(out.lost).toEqual([]);
    expect(statSync(to).mtimeMs).toBe(stamp.getTime());
    expect(existsSync(from)).toBe(false);
    expect(quarantinedFiles(book)).toEqual({ [basename(from)]: 'ID3 same' });
  });

  it.each([
    ['a tie: the recorded size, different bytes', 'ID3 one', 'ID3 two', size('ID3 one')],
    ['neither copy has the recorded size', 'ID3 one', 'ID3 the other', 999],
    ['identical copies, neither of the recorded size', 'ID3 same', 'ID3 same', 999],
  ])('%s: BOTH quarantined, lost with both basenames, no throw', async (_label, a, b, recorded) => {
    const book = seedBook();
    const from = previous(book, 'mp3');
    const to = live(book, 'mp3');
    put(from, a);
    put(to, b);
    put(previous(book, 'peaks.json'), '[1]');
    const out = await apply(book, [
      audioMove(from, to, recorded),
      sidecarMove('peaks', previous(book, 'peaks.json'), live(book, 'peaks.json'), 3),
    ]);
    expect(out.lost).toEqual([
      { part: 'audio', ext: 'mp3', take: 'live', basenames: [basename(from), basename(to)] },
    ]);
    expect(existsSync(from)).toBe(false);
    expect(existsSync(to)).toBe(false);
    expect(quarantinedFiles(book)).toEqual({ [basename(from)]: a, [basename(to)]: b });
    expect(out.quarantined).toHaveLength(2);
    /* The slug is not blocked: the step's other part still moves. */
    expect(read(live(book, 'peaks.json'))).toBe('[1]');
  });

  it('a tie whose target copy is held moves neither, so the next replay decides the same tie', async () => {
    const book = seedBook();
    const from = previous(book, 'mp3');
    const to = live(book, 'mp3');
    put(from, 'ID3 one');
    put(to, 'ID3 two');
    faults.rename = (source) => (source === to ? fsError('EBUSY') : undefined);
    await expect(apply(book, [audioMove(from, to, size('ID3 one'))])).rejects.toBeInstanceOf(
      take.TakeMoveStepError,
    );
    expect(read(from)).toBe('ID3 one');
    expect(read(to)).toBe('ID3 two');

    faults.rename = null;
    const out = await apply(book, [audioMove(from, to, size('ID3 one'))]);
    expect(out.lost).toHaveLength(1);
    expect(quarantinedFiles(book)).toEqual({
      [basename(from)]: 'ID3 one',
      [basename(to)]: 'ID3 two',
    });
  });

  it('a name already in the event folder is never overwritten, and never blocks the part', async () => {
    const book = seedBook();
    const move = audioMove(previous(book, 'mp3'), discard(book, 'mp3'), 4);
    put(discard(book, 'mp3'), 'ours');
    put(previous(book, 'mp3'), 'planted once');
    await apply(book, [move]);
    put(previous(book, 'mp3'), 'planted twice');
    const second = await apply(book, [move]);
    put(previous(book, 'mp3'), 'planted thrice');
    await apply(book, [move]);
    expect(read(second.quarantined[0])).toBe('planted twice');
    const kept = orphaned(book);
    expect(Object.values(kept).sort()).toEqual(['planted once', 'planted thrice', 'planted twice']);
    for (const key of Object.keys(kept)) {
      expect(key).toMatch(new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${JID}(-\\d+)?/`));
    }
  });
});

/* ---- lost parts and the re-probe (R8-1, R9-2) -------------------------------- */

describe('applyPartMoves - lost parts', () => {
  it('THREE absent parts share one schedule: five sleeps for the step, then all lost', async () => {
    const book = seedBook();
    put(live(book, 'lufs.json'), '{}');
    const delays: number[] = [];
    const moves = [
      audioMove(live(book, 'mp3'), previous(book, 'mp3')),
      sidecarMove('segments', live(book, 'segments.json'), previous(book, 'segments.json')),
      sidecarMove('peaks', live(book, 'peaks.json'), previous(book, 'peaks.json')),
      sidecarMove('lufs', live(book, 'lufs.json'), previous(book, 'lufs.json'), 2),
    ];
    const out = await apply(book, moves, async (ms) => {
      delays.push(ms);
    });
    expect(delays).toHaveLength(5);
    delays.forEach((ms, i) => {
      expect(ms).toBeGreaterThanOrEqual(retry.RENAME_RETRY_DELAYS_MS[i]);
      expect(ms).toBeLessThan(2 * retry.RENAME_RETRY_DELAYS_MS[i]);
    });
    expect(out.lost).toEqual([
      {
        part: 'audio',
        ext: 'mp3',
        take: 'live',
        basenames: [`${SLUG}.mp3`, `${SLUG}.previous.mp3`],
      },
      {
        part: 'segments',
        take: 'live',
        basenames: [`${SLUG}.segments.json`, `${SLUG}.previous.segments.json`],
      },
      {
        part: 'peaks',
        take: 'live',
        basenames: [`${SLUG}.peaks.json`, `${SLUG}.previous.peaks.json`],
      },
    ]);
    expect(read(previous(book, 'lufs.json'))).toBe('{}');
  });

  it('a healthy step never sleeps', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'take');
    const sleep = vi.fn(async () => {});
    await apply(book, [audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4)], sleep);
    expect(sleep).not.toHaveBeenCalled();
  });

  it('a part absent at the first probe and present at the second is renamed, not lost', async () => {
    const book = seedBook();
    const sleep = vi.fn(async () => {
      put(live(book, 'mp3'), 'dropped back');
    });
    const out = await apply(book, [audioMove(live(book, 'mp3'), previous(book, 'mp3'), 12)], sleep);
    expect(out.lost).toEqual([]);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(read(previous(book, 'mp3'))).toBe('dropped back');
  });

  it('a rename throwing ENOENT is re-probed and ends lost, without a TakeMoveStepError', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'take');
    put(live(book, 'peaks.json'), '[1]');
    /* Deleted between the probe and the rename. */
    faults.rename = (from) => {
      if (from !== live(book, 'mp3')) return undefined;
      rmSync(from);
      return fsError('ENOENT');
    };
    const sleep = vi.fn(async () => {});
    const out = await apply(
      book,
      [
        audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4),
        sidecarMove('peaks', live(book, 'peaks.json'), previous(book, 'peaks.json'), 3),
      ],
      sleep,
    );
    expect(out.lost).toEqual([
      {
        part: 'audio',
        ext: 'mp3',
        take: 'live',
        basenames: [`${SLUG}.mp3`, `${SLUG}.previous.mp3`],
      },
    ]);
    expect(sleep).toHaveBeenCalledTimes(5);
    expect(read(previous(book, 'peaks.json'))).toBe('[1]');
  });

  it('a rename throwing ENOENT once, with the part still there, is renamed', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'take');
    let thrown = 0;
    faults.rename = () => (thrown++ === 0 ? fsError('ENOENT') : undefined);
    const out = await apply(book, [audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4)]);
    expect(out.lost).toEqual([]);
    expect(read(previous(book, 'mp3'))).toBe('take');
  });

  it('ENOENT again with the part still present ends in a TakeMoveStepError, not a loop', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'take');
    faults.rename = () => fsError('ENOENT');
    await expect(
      apply(book, [audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4)]),
    ).rejects.toBeInstanceOf(take.TakeMoveStepError);
    expect(faults.renames).toHaveLength(2);
    expect(read(live(book, 'mp3'))).toBe('take');
  });

  it('a foreign copy that vanishes before its quarantine is re-probed, not a failure', async () => {
    const book = seedBook();
    put(previous(book, 'mp3'), 'planted');
    put(discard(book, 'mp3'), 'ours');
    faults.rename = (from) => {
      if (from !== previous(book, 'mp3')) return undefined;
      rmSync(from);
      return fsError('ENOENT');
    };
    const out = await apply(book, [audioMove(previous(book, 'mp3'), discard(book, 'mp3'), 4)]);
    expect(out).toEqual({ lost: [], quarantined: [] });
    expect(read(discard(book, 'mp3'))).toBe('ours');
  });
});

/* ---- move-step failures and ordering ----------------------------------------- */

describe('applyPartMoves - move-step failures and ordering', () => {
  it.each(['EBUSY', 'EPERM', 'EACCES', 'ENOSPC'])(
    'a rename refused with %s throws TakeMoveStepError carrying the slug',
    async (code) => {
      const book = seedBook();
      put(live(book, 'mp3'), 'take');
      const refused = fsError(code);
      faults.rename = () => refused;
      const error = await apply(book, [
        audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4),
      ]).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(take.TakeMoveStepError);
      expect(error).toMatchObject({ slug: SLUG, cause: refused });
      expect(read(live(book, 'mp3'))).toBe('take');
    },
  );

  it('decides every part before renaming any: a refused quarantine of a LATER part leaves the first unmoved', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'take');
    put(live(book, 'peaks.json'), 'planted');
    const discarded = join(book.audio, `${SLUG}.discard-${JID}.live.peaks.json`);
    put(discarded, 'ours');
    faults.rename = (from) => (from === live(book, 'peaks.json') ? fsError('EBUSY') : undefined);
    await expect(
      apply(book, [
        audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4),
        sidecarMove('peaks', live(book, 'peaks.json'), discarded, 4),
      ]),
    ).rejects.toBeInstanceOf(take.TakeMoveStepError);
    expect(read(live(book, 'mp3'))).toBe('take');
    expect(existsSync(previous(book, 'mp3'))).toBe(false);
    expect(faults.renames.map((r) => basename(r.from))).toEqual([`${SLUG}.peaks.json`]);
  });

  it('quarantines first, then renames in the order given', async () => {
    const book = seedBook();
    put(discard(book, 'mp3'), 'audio');
    put(discard(book, 'segments.json'), '{}');
    put(discard(book, 'peaks.json'), '[1]');
    put(previous(book, 'peaks.json'), 'planted');
    await apply(book, [
      audioMove(discard(book, 'mp3'), previous(book, 'mp3'), 5),
      sidecarMove('segments', discard(book, 'segments.json'), previous(book, 'segments.json'), 2),
      sidecarMove('peaks', discard(book, 'peaks.json'), previous(book, 'peaks.json'), 3),
    ]);
    expect(faults.renames.map((r) => basename(r.from))).toEqual([
      `${SLUG}.previous.peaks.json`,
      basename(discard(book, 'mp3')),
      basename(discard(book, 'segments.json')),
      basename(discard(book, 'peaks.json')),
    ]);
  });

  it('a target refilled after the decision is quarantined, never overwritten', async () => {
    const book = seedBook();
    put(discard(book, 'mp3'), 'audio');
    put(discard(book, 'peaks.json'), '[1]');
    faults.rename = (from) => {
      if (from === discard(book, 'mp3')) put(previous(book, 'peaks.json'), 'refilled');
      return undefined;
    };
    await apply(book, [
      audioMove(discard(book, 'mp3'), previous(book, 'mp3'), 5),
      sidecarMove('peaks', discard(book, 'peaks.json'), previous(book, 'peaks.json'), 3),
    ]);
    expect(read(previous(book, 'peaks.json'))).toBe('[1]');
    expect(quarantinedFiles(book)).toEqual({ [`${SLUG}.previous.peaks.json`]: 'refilled' });
  });

  it('refuses a hand-built handle', async () => {
    const book = seedBook();
    put(live(book, 'mp3'), 'take');
    const fake = {
      bookId: book.bookId,
      bookDir: book.bookDir,
      held: true,
    } as unknown as import('./book-op-lock.js').BookHandle;
    await expect(
      take.applyPartMoves(fake, journal, [audioMove(live(book, 'mp3'), previous(book, 'mp3'), 4)]),
    ).rejects.toThrow();
    expect(read(live(book, 'mp3'))).toBe('take');
  });
});
