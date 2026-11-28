/* #4320 step 4 (#4828) — `commitTake`, Commit steps 1-8 and "Failure handling"
   (spec 2026-11-13-chapter-take-lifecycle-design.md §5.A "Commit"; R3-1, D2,
   D4, E2, E6, OD2, OD4). WORKSPACE_DIR is pointed at a tempdir BEFORE the
   modules load (paths.ts caches it at import). Handles come from a real
   `withBookOp` over a seeded book. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import type { CommitTakeOptions, PrepareTakeInput, StagedTake } from './chapter-take.js';

/* Fault injection, pass-through unless a test arms it.
   - `rename`: called before every `renameWithRetry`; a returned error is thrown
     in its place.
   - `unlink`: the same for `unlink`.
   - `stamp`: thrown by `updateStateAtDir` once a take journal sits at
     `installed` (step 7's stamp; step 0's own state writes pass).
   - `revisions`: every version of revisions.json that reached disk. */
const faults = vi.hoisted(() => ({
  rename: null as null | ((from: string, to: string) => Error | undefined),
  unlink: null as null | ((path: string) => Error | undefined),
  stamp: null as null | Error,
  revisions: [] as string[],
}));
vi.mock('./atomic-rename.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./atomic-rename.js')>();
  const fs = await import('node:fs');
  return {
    ...actual,
    renameWithRetry: async (from: string, to: string) => {
      const error = faults.rename?.(from, to);
      if (error) throw error;
      if (to.endsWith('revisions.json')) faults.revisions.push(fs.readFileSync(from, 'utf8'));
      return actual.renameWithRetry(from, to);
    },
  };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const unlink = (async (...args: Parameters<typeof actual.unlink>) => {
    const error = faults.unlink?.(String(args[0]));
    if (error) throw error;
    return actual.unlink(...args);
  }) as typeof actual.unlink;
  return { ...actual, unlink, default: { ...actual, unlink } };
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
      .some((n) => (JSON.parse(fs.readFileSync(path.join(audio, n), 'utf8')) as { phase: string }).phase === 'installed');
  };
  return {
    ...actual,
    updateStateAtDir: async (...args: Parameters<typeof actual.updateStateAtDir>) => {
      if (faults.stamp && installed(args[0])) throw faults.stamp;
      return actual.updateStateAtDir(...args);
    },
  };
});

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');
let embeddingsIo: typeof import('../audio/render-integrity/embeddings-io.js');

const SLUG = 'ch-01';
const CHAPTER_ID = 3;
const A = 'aaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbb';
const SIDECARS = [
  'segments.json',
  'peaks.json',
  'lufs.json',
  'embeddings.json',
  'render-integrity.json',
  'render-integrity-attempted.json',
];
type Ext = 'mp3' | 'm4a';
const AUDIO_BYTES: Record<Ext, (tag: string) => Buffer> = {
  mp3: (tag) => Buffer.from(`ID3${tag}`),
  m4a: (tag) => Buffer.from(`\0\0\0\x18ftyp${tag}`),
};
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'take-commit-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  take = await import('./chapter-take.js');
  lock = await import('./book-op-lock.js');
  paths = await import('./paths.js');
  embeddingsIo = await import('../audio/render-integrity/embeddings-io.js');
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

afterEach(() => {
  faults.rename = null;
  faults.unlink = null;
  faults.stamp = null;
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
const SEGMENTS = [seg('narrator', 1), seg('amy', 2), seg('amy', 3)];

function segmentsFile(synthesizedAt: string, durationSec: number, takeId?: string) {
  return {
    chapterId: CHAPTER_ID,
    durationSec,
    modelKey: 'kokoro-v1',
    synthesizedAt,
    segments: SEGMENTS,
    characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
    qa: {
      status: 'ok' as const,
      reasons: [],
      measuredLufs: -18,
      truePeakDb: -2,
      durationSec,
      expectedSec: durationSec,
      checkedAt: synthesizedAt,
    },
    ...(takeId ? { takeId } : {}),
  };
}

const verdictRow = (characterId: string, sentenceId: number, cosine: number) => ({
  characterId,
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

/** Write one whole take (`which`) under its live or previous names. */
async function seedTake(
  book: Seeded,
  which: 'live' | 'previous',
  takeId: string,
  opts: { ext?: Ext; synthesizedAt: string; durationSec: number },
): Promise<void> {
  const prefix = join(book.audio, which === 'live' ? SLUG : `${SLUG}.previous`);
  const ext = opts.ext ?? 'mp3';
  writeFileSync(`${prefix}.${ext}`, AUDIO_BYTES[ext](takeId));
  writeFileSync(
    `${prefix}.segments.json`,
    JSON.stringify(segmentsFile(opts.synthesizedAt, opts.durationSec, takeId)),
  );
  writeFileSync(`${prefix}.peaks.json`, JSON.stringify({ peaks: [takeId] }));
  writeFileSync(`${prefix}.lufs.json`, JSON.stringify({ i: -18, of: takeId }));
  await embeddingsIo.writeEmbeddings(
    `${prefix}.embeddings.json`,
    SEGMENTS.map((s, i) => ({ characterId: s.characterId, sentenceIds: s.sentenceIds, vec: vec(i + 1) })),
    'v-live',
  );
  writeFileSync(
    `${prefix}.render-integrity.json`,
    JSON.stringify([verdictRow('narrator', 1, 0.91), verdictRow('amy', 2, 0.42), verdictRow('amy', 3, 0.43)]),
  );
  writeFileSync(`${prefix}.render-integrity-attempted.json`, JSON.stringify({ attemptedAt: takeId }));
}

const LIVE_AT = '2026-02-02T00:00:00.000Z';
const PREV_AT = '2026-01-01T00:00:00.000Z';
const NEW_AT = '2026-03-03T00:00:00.000Z';

const OLD_ENTRY = {
  id: `revision:${CHAPTER_ID}:old`,
  chapterId: CHAPTER_ID,
  characterId: 'amy',
  playable: true,
  hasPreviousAudio: true,
  segments: [],
  origin: 'server',
};

/** A book with live take B and previous take A, unless told otherwise. */
async function seedBook(
  opts: { ext?: Ext; live?: string | null; previous?: string | null; pending?: boolean } = {},
): Promise<Seeded> {
  seq += 1;
  const title = `Commit Book ${seq}`;
  const bookId = paths.makeBookId('Taker', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Taker', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  const live = opts.live === undefined ? B : opts.live;
  const previous = opts.previous === undefined ? A : opts.previous;
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-commit-${seq}`,
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
          ...(live ? { duration: '00:20', audioRenderedAt: LIVE_AT, audioTakeId: live } : {}),
          generationState: 'failed',
          generationError: 'boom',
          generationErrorCode: 'x',
          generationRemediation: 'y',
        },
      ],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  const book = { bookId, bookDir, audio };
  if (live) await seedTake(book, 'live', live, { ext: opts.ext, synthesizedAt: LIVE_AT, durationSec: 20 });
  if (previous) {
    await seedTake(book, 'previous', previous, { ext: opts.ext, synthesizedAt: PREV_AT, durationSec: 10 });
  }
  if (opts.pending) {
    writeFileSync(
      join(bookDir, '.audiobook', 'revisions.json'),
      JSON.stringify({ schema: 1, fileId: null, rev: 0, pending: [OLD_ENTRY] }),
    );
  }
  return book;
}

function newTakeInput(over: Partial<PrepareTakeInput> = {}): PrepareTakeInput {
  return {
    slug: SLUG,
    ext: 'mp3',
    audio: AUDIO_BYTES[(over.ext ?? 'mp3') as Ext]('new'),
    segments: segmentsFile(NEW_AT, 65),
    peaks: { peaks: ['new'] },
    lufs: { i: -18, of: 'new' },
    ...over,
  };
}

const stage = (book: Seeded, over: Partial<PrepareTakeInput> = {}): Promise<StagedTake> =>
  take.prepareTake({ bookDir: book.bookDir }, newTakeInput(over), new AbortController().signal);

async function commit(book: Seeded, staged: StagedTake, over: Partial<CommitTakeOptions> = {}) {
  const out = await lock.withBookOp(book.bookId, (h) =>
    take.commitTake(h, staged, {
      base: undefined,
      startTakeId: null,
      signal: new AbortController().signal,
      review: { characterId: 'amy', triggeredBy: 'voice-change' },
      ...over,
    }),
  );
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out;
}

const committedNow = async (book: Seeded, takeId: string): Promise<boolean> => {
  const out = await lock.withBookOp(book.bookId, (h) => take.takeCommitted(h, SLUG, takeId));
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out;
};

/* ---- observers ------------------------------------------------------------- */

/** Every file in `audio/` that is not a staged part, by name -> bytes. */
function snapshot(audio: string): Record<string, string> {
  return Object.fromEntries(
    readdirSync(audio)
      .filter((n) => !n.includes('.next-'))
      .sort()
      .map((n) => [n, readFileSync(join(audio, n), 'base64')]),
  );
}
const names = (audio: string, marker: string): string[] =>
  readdirSync(audio)
    .filter((n) => n.includes(marker))
    .sort();
const json = <T = Record<string, unknown>>(book: Seeded, name: string): T =>
  JSON.parse(readFileSync(join(book.audio, name), 'utf8')) as T;
const chapterState = (book: Seeded): Record<string, unknown> =>
  (
    JSON.parse(readFileSync(join(book.bookDir, '.audiobook', 'state.json'), 'utf8')) as {
      chapters: Record<string, unknown>[];
    }
  ).chapters[0];
function pending(book: Seeded): Record<string, unknown>[] {
  const path = join(book.bookDir, '.audiobook', 'revisions.json');
  if (!existsSync(path)) return [];
  return (JSON.parse(readFileSync(path, 'utf8')) as { pending: Record<string, unknown>[] }).pending;
}
const fsError = (code: string): Error => Object.assign(new Error(`injected ${code}`), { code });

/* A step-5 rename moves a live name away; a step-6 rename moves a staged part
   in, or a leftover live audio to `.stale.`. Rollback renames match neither. */
const isStep5 = (from: string, to: string): boolean =>
  !from.includes('.previous.') &&
  !from.includes('.next-') &&
  !from.includes('.discard-') &&
  (to.includes('.previous.') || /\.discard-[a-z2-7]{16}\.live\./.test(to));
const isStep6 = (from: string, to: string): boolean =>
  (from.includes('.next-') && !to.includes('.next-') && !from.includes('.tmp-')) || to.includes('.stale.');

/* ---- happy path ------------------------------------------------------------ */

describe('commitTake - the committed take', () => {
  it.each(['mp3', 'm4a'] as const)(
    'installs every part, moves the live take to .previous with its real %s extension and stamps state',
    async (ext) => {
      const book = await seedBook({ ext });
      const oldLive = snapshot(book.audio);
      const staged = await stage(book, {
        ext,
        embeddings: { version: 'v-new', rows: [{ characterId: 'narrator', sentenceIds: [1], vec: vec(9) }] },
        verdicts: [verdictRow('narrator', 1, 0.99)],
      });

      const result = await commit(book, staged);

      expect(result).toMatchObject({
        outcome: 'committed',
        newTakeId: staged.takeId,
        reviewOutcome: 'recorded',
        durationSec: 65,
        audioModelKey: 'kokoro-v1',
        audioEngines: { kokoro: 1 },
        audioQa: { status: 'ok', durationSec: 65 },
        segmentCount: 3,
      });
      const after = snapshot(book.audio);
      /* The new take is live with every part it staged, and nothing else live. */
      expect(readFileSync(join(book.audio, `${SLUG}.${ext}`))).toEqual(AUDIO_BYTES[ext]('new'));
      expect(json(book, `${SLUG}.segments.json`).takeId).toBe(staged.takeId);
      expect(json(book, `${SLUG}.peaks.json`)).toEqual({ peaks: ['new'] });
      expect(json(book, `${SLUG}.lufs.json`)).toEqual({ i: -18, of: 'new' });
      expect(json(book, `${SLUG}.embeddings.json`).takeId).toBe(staged.takeId);
      expect(json(book, `${SLUG}.render-integrity.json`)).toEqual([verdictRow('narrator', 1, 0.99)]);
      expect(existsSync(join(book.audio, `${SLUG}.render-integrity-attempted.json`))).toBe(false);
      /* The old live take is the previous take, byte for byte; the old previous is gone. */
      for (const suffix of [ext, ...SIDECARS]) {
        expect(after[`${SLUG}.previous.${suffix}`], suffix).toBe(oldLive[`${SLUG}.${suffix}`]);
      }
      expect(Object.keys(after).filter((n) => n.includes('.previous.'))).toHaveLength(7);
      for (const marker of ['.next-', '.discard-', '.take-journal.']) {
        expect(names(book.audio, marker), marker).toEqual([]);
      }
      const chapter = chapterState(book);
      expect(chapter).toMatchObject({
        duration: '01:05',
        audioModelKey: 'kokoro-v1',
        audioEngines: { kokoro: 1 },
        audioRenderedAt: NEW_AT,
        audioQa: { status: 'ok', durationSec: 65 },
        audioTakeId: staged.takeId,
      });
      for (const field of ['generationState', 'generationError', 'generationErrorCode', 'generationRemediation']) {
        expect(chapter, field).not.toHaveProperty(field);
      }
      expect(pending(book)).toEqual([
        expect.objectContaining({
          id: `revision:${CHAPTER_ID}:${staged.takeId}`,
          chapterId: CHAPTER_ID,
          characterId: 'amy',
          triggeredBy: 'voice-change',
          oldDuration: '00:20',
          newDuration: '01:05',
          chapterUuid: 'uuid-3',
          renderedAt: NEW_AT,
          origin: 'server',
        }),
      ]);
      expect(take.liveStaging.has(staged.takeId)).toBe(false);
    },
  );

  it('a first render makes nothing previous: no .previous.*, no entry', async () => {
    const book = await seedBook({ live: null, previous: null });
    const staged = await stage(book);
    const result = await commit(book, staged);
    expect(result).toMatchObject({ outcome: 'committed', reviewOutcome: 'none' });
    expect(readdirSync(book.audio).sort()).toEqual(
      ['lufs.json', 'mp3', 'peaks.json', 'segments.json'].map((s) => `${SLUG}.${s}`),
    );
    expect(pending(book)).toEqual([]);
  });

  it('a first render over orphan live sidecars discards them; they never become previous', async () => {
    const book = await seedBook({ live: null, previous: null });
    writeFileSync(join(book.audio, `${SLUG}.peaks.json`), 'orphan');
    writeFileSync(join(book.audio, `${SLUG}.lufs.json`), 'orphan');
    await commit(book, await stage(book));
    expect(readdirSync(book.audio).sort()).toEqual(
      ['lufs.json', 'mp3', 'peaks.json', 'segments.json'].map((s) => `${SLUG}.${s}`),
    );
    expect(json(book, `${SLUG}.peaks.json`)).toEqual({ peaks: ['new'] });
  });

  it('review null drops the pending entry; review absent leaves revisions.json alone', async () => {
    const dropped = await seedBook({ pending: true });
    expect(await commit(dropped, await stage(dropped), { review: null })).toMatchObject({ reviewOutcome: 'none' });
    expect(pending(dropped)).toEqual([]);

    const left = await seedBook({ pending: true });
    const result = await commit(left, await stage(left), { review: undefined });
    expect(result).toMatchObject({ outcome: 'committed' });
    expect(result).not.toHaveProperty('reviewOutcome');
    expect(faults.revisions.filter((v) => v.includes(left.bookId))).toEqual([]);
    expect(pending(left)).toEqual([OLD_ENTRY]);
  });

  it('a revisions write failure is swallowed as reviewOutcome failed and the journal is still unlinked', async () => {
    const book = await seedBook();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    faults.rename = (_from, to) => (to.endsWith('revisions.json') ? fsError('ENOSPC') : undefined);
    const result = await commit(book, await stage(book));
    expect(result).toMatchObject({ outcome: 'committed', reviewOutcome: 'failed' });
    expect(names(book.audio, '.take-journal.')).toEqual([]);
  });

  it('moves a leftover live audio of another extension out of the way (N4)', async () => {
    const book = await seedBook();
    let planted = false;
    faults.rename = (_from, to) => {
      /* After step 0 resolved the live names, an outside writer drops a second audio file. */
      if (!planted && to.includes('.previous.')) {
        planted = true;
        writeFileSync(join(book.audio, `${SLUG}.ogg`), 'OggSleftover');
      }
      return undefined;
    };
    await commit(book, await stage(book));
    expect(existsSync(join(book.audio, `${SLUG}.ogg`))).toBe(false);
    expect(take.liveAudioFiles(book.audio, SLUG).map((f) => f.ext)).toEqual(['mp3']);
    expect(names(book.audio, '.discard-')).toEqual([]);
  });

  it('removes a previous audio of another extension along with the old previous take', async () => {
    const book = await seedBook();
    writeFileSync(join(book.audio, `${SLUG}.previous.m4a`), AUDIO_BYTES.m4a('older'));
    await commit(book, await stage(book));
    expect(existsSync(join(book.audio, `${SLUG}.previous.m4a`))).toBe(false);
    expect(readFileSync(join(book.audio, `${SLUG}.previous.mp3`))).toEqual(AUDIO_BYTES.mp3(B));
  });
});

/* ---- step 4: what becomes previous ----------------------------------------- */

describe('commitTake - what becomes previous', () => {
  it('R3-1: another render committed meanwhile, so the previous take stays and the live one is discarded', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const staged = await stage(book);

    await commit(book, staged, { startTakeId: A });

    const after = snapshot(book.audio);
    for (const suffix of ['mp3', ...SIDECARS]) {
      expect(after[`${SLUG}.previous.${suffix}`], suffix).toBe(before[`${SLUG}.previous.${suffix}`]);
    }
    expect(Object.values(after)).not.toContain(before[`${SLUG}.mp3`]);
    expect(json(book, `${SLUG}.segments.json`).takeId).toBe(staged.takeId);
    expect(names(book.audio, '.discard-')).toEqual([]);
    expect(pending(book)).toEqual([expect.objectContaining({ id: `revision:${CHAPTER_ID}:${staged.takeId}` })]);
  });

  it.each([
    ['the live take is still the one the render started from', { startTakeId: B }],
    ['the render has no startTakeId', { startTakeId: null }],
    ['the write is partial (it carries a base)', { startTakeId: A, base: B }],
  ])('R3-1 does not apply when %s', async (_label, over) => {
    const book = await seedBook();
    await commit(book, await stage(book, { resynthesizedIndices: 'all' }), over);
    expect(json(book, `${SLUG}.previous.segments.json`).takeId).toBe(B);
  });

  it('interim only-copy rule: no live audio and a previous take present keeps the previous take', async () => {
    const book = await seedBook({ live: null });
    const before = snapshot(book.audio);
    /* A live segments file with no audio is not a take; it must not displace the previous one. */
    writeFileSync(join(book.audio, `${SLUG}.segments.json`), JSON.stringify(segmentsFile(LIVE_AT, 20, B)));
    const staged = await stage(book);

    await commit(book, staged);

    const after = snapshot(book.audio);
    for (const suffix of ['mp3', ...SIDECARS]) {
      expect(after[`${SLUG}.previous.${suffix}`], suffix).toBe(before[`${SLUG}.previous.${suffix}`]);
    }
    expect(json(book, `${SLUG}.segments.json`).takeId).toBe(staged.takeId);
    expect(names(book.audio, '.discard-')).toEqual([]);
  });

  it('journals the review inputs, the entry stamps and every present part with its size before it moves anything', async () => {
    const book = await seedBook();
    let journal: Record<string, unknown> | undefined;
    faults.rename = (from, to) => {
      if (!journal && isStep5(from, to)) {
        const [name] = names(book.audio, '.take-journal.').filter((n) => !n.includes('.tmp-'));
        journal = json(book, name);
      }
      return undefined;
    };
    const staged = await stage(book);
    await commit(book, staged);
    expect(journal).toMatchObject({
      op: 'commit',
      phase: 'preserve',
      newTakeId: staged.takeId,
      liveTakeId: B,
      prevTakeId: A,
      keepPrevious: false,
      preserved: true,
      oldDuration: '00:20',
      newDuration: '01:05',
      chapter: { id: CHAPTER_ID, slug: SLUG, uuid: 'uuid-3' },
      review: { characterId: 'amy', triggeredBy: 'voice-change' },
      entry: { takeId: staged.takeId, renderedAt: NEW_AT, previousTakeId: B, previousRenderedAt: LIVE_AT },
      supersedes: [],
      lost: [],
    });
    const parts = journal!.parts as Record<string, Array<{ part: string; size: number }>>;
    expect(parts.live[0]).toEqual({ part: 'audio', ext: 'mp3', size: AUDIO_BYTES.mp3(B).length });
    expect(parts.live).toHaveLength(7);
    expect(parts.previous).toHaveLength(7);
    expect(parts.staged.map((p) => p.part).sort()).toEqual(['audio', 'lufs', 'peaks', 'segments']);
  });
});

/* ---- steps 1 and 2 --------------------------------------------------------- */

describe('commitTake - refusals before the journal', () => {
  it('CAS: a base that is not the live takeId answers changed, sweeps the staged set and leaves the live take', async () => {
    const book = await seedBook({ pending: true });
    const before = snapshot(book.audio);
    const staged = await stage(book, { resynthesizedIndices: [1] });

    expect(await commit(book, staged, { base: A })).toEqual({ outcome: 'changed' });

    expect(snapshot(book.audio)).toEqual(before);
    expect(names(book.audio, '.next-')).toEqual([]);
    expect(take.liveStaging.has(staged.takeId)).toBe(false);
    expect(pending(book)).toEqual([OLD_ENTRY]);
  });

  it('refuses an aborted signal and sweeps the staged set', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const staged = await stage(book);
    const controller = new AbortController();
    controller.abort();

    await expect(commit(book, staged, { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' });

    expect(snapshot(book.audio)).toEqual(before);
    expect(names(book.audio, '.next-')).toEqual([]);
    expect(take.liveStaging.has(staged.takeId)).toBe(false);
  });

  it('refuses a partial write that does not say which segments it re-synthesised', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    await expect(commit(book, await stage(book), { base: B })).rejects.toThrow(/resynthesizedIndices/);
    expect(snapshot(book.audio)).toEqual(before);
    expect(names(book.audio, '.next-')).toEqual([]);
  });

  it('refuses a staged part that is no longer on disk, before anything moves', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const staged = await stage(book);
    rmSync(staged.parts[0].path);
    await expect(commit(book, staged)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(snapshot(book.audio)).toEqual(before);
    expect(names(book.audio, '.next-')).toEqual([]);
  });

  it('refuses a stale handle', async () => {
    const book = await seedBook();
    let leaked!: import('./book-op-lock.js').BookHandle;
    await lock.withBookOp(book.bookId, async (h) => {
      leaked = h;
    });
    await expect(
      take.commitTake(leaked, await stage(book), {
        base: undefined,
        startTakeId: null,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow();
  });
});

/* ---- failure before `installed` -------------------------------------------- */

const STEP5_TARGETS = ['mp3', ...SIDECARS].map((s) => `${SLUG}.previous.${s}`);
const STEP6_TARGETS = ['mp3', 'peaks.json', 'lufs.json', 'embeddings.json', 'render-integrity.json', 'segments.json'].map(
  (s) => `${SLUG}.${s}`,
);

describe('commitTake - rollback before installed', () => {
  const fullStage = (book: Seeded) =>
    stage(book, {
      embeddings: { version: 'v-new', rows: [] },
      verdicts: [verdictRow('narrator', 1, 0.99)],
    });

  const cases = [
    ...STEP5_TARGETS.map((target) => ({ step: 5, target, match: isStep5 })),
    ...STEP6_TARGETS.map((target) => ({ step: 6, target, match: isStep6 })),
  ];

  it.each(cases)(
    'step $step, EBUSY at the rename onto $target: both takes whole, no journal, retry with the staged set kept',
    async ({ target, match }) => {
      const book = await seedBook({ pending: true });
      const before = snapshot(book.audio);
      const staged = await fullStage(book);
      const stagedBefore = names(book.audio, '.next-');
      let injected = 0;
      faults.rename = (from, to) => {
        if (!match(from, to) || basename(to) !== target) return undefined;
        injected += 1;
        return fsError('EBUSY');
      };

      expect(await commit(book, staged)).toEqual({ outcome: 'retry', cause: 'held-file' });

      expect(injected).toBe(1);
      expect(snapshot(book.audio)).toEqual(before);
      expect(names(book.audio, '.next-')).toEqual(stagedBefore);
      /* Kept for the retry, so the sweep must still see it as this process's. */
      expect(take.liveStaging.has(staged.takeId)).toBe(true);
      expect(pending(book)).toEqual([OLD_ENTRY]);
      expect(chapterState(book).audioTakeId).toBe(B);

      faults.rename = null;
      expect(await commit(book, staged)).toMatchObject({ outcome: 'committed', newTakeId: staged.takeId });
      expect(json(book, `${SLUG}.segments.json`).takeId).toBe(staged.takeId);
      expect(names(book.audio, '.next-')).toEqual([]);
      expect(take.liveStaging.has(staged.takeId)).toBe(false);
    },
  );

  it.each(cases)(
    'step $step, EIO at the rename onto $target: both takes whole, no journal, staged set swept, error thrown',
    async ({ target, match }) => {
      const book = await seedBook();
      const before = snapshot(book.audio);
      const staged = await fullStage(book);
      faults.rename = (from, to) => (match(from, to) && basename(to) === target ? fsError('EIO') : undefined);

      await expect(commit(book, staged)).rejects.toMatchObject({ code: 'EIO' });

      expect(snapshot(book.audio)).toEqual(before);
      expect(names(book.audio, '.next-')).toEqual([]);
      expect(take.liveStaging.has(staged.takeId)).toBe(false);
      expect(await committedNow(book, staged.takeId)).toBe(false);
    },
  );

  it('EPERM on the leftover-audio move rolls back and retries', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    const staged = await stage(book);
    faults.rename = (_from, to) => {
      if (to.includes('.previous.')) writeFileSync(join(book.audio, `${SLUG}.ogg`), 'OggSleftover');
      return to.includes('.stale.') ? fsError('EPERM') : undefined;
    };
    expect(await commit(book, staged)).toEqual({ outcome: 'retry', cause: 'held-file' });
    rmSync(join(book.audio, `${SLUG}.ogg`));
    expect(snapshot(book.audio)).toEqual(before);
  });

  it('the live audio moves first (D4): when its rename fails, no live part has moved', async () => {
    const book = await seedBook();
    const livePartNames = ['mp3', ...SIDECARS].map((s) => `${SLUG}.${s}`);
    const moved: string[] = [];
    let presentAtFailure: string[] = [];
    faults.rename = (from, to) => {
      if (!isStep5(from, to)) return undefined;
      if (basename(from) === `${SLUG}.mp3`) {
        presentAtFailure = livePartNames.filter((n) => existsSync(join(book.audio, n)));
        return fsError('EBUSY');
      }
      moved.push(basename(from));
      return undefined;
    };

    expect(await commit(book, await stage(book))).toEqual({ outcome: 'retry', cause: 'held-file' });

    expect(moved).toEqual([]);
    expect(presentAtFailure).toEqual(livePartNames);
  });

  it('an old-previous discard failure rolls back and is not retried', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    faults.rename = (_from, to) => (to.endsWith('.prev.lufs.json') ? fsError('EBUSY') : undefined);
    await expect(commit(book, await stage(book))).rejects.toMatchObject({ code: 'EBUSY' });
    expect(snapshot(book.audio)).toEqual(before);
    expect(names(book.audio, '.next-')).toEqual([]);
  });

  it('a journal write that fails after the moves rolls everything back', async () => {
    const book = await seedBook();
    const before = snapshot(book.audio);
    faults.rename = (from, to) =>
      to.includes('.take-journal.') && readFileSync(from, 'utf8').includes('"phase": "installed"')
        ? fsError('EPERM')
        : undefined;
    const staged = await stage(book);
    await expect(commit(book, staged)).rejects.toMatchObject({ code: 'EPERM' });
    expect(snapshot(book.audio)).toEqual(before);
    expect(names(book.audio, '.next-')).toEqual([]);
  });

  it('never installs onto a live name refilled from outside, and keeps the journal when rollback cannot finish', async () => {
    const book = await seedBook();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const foreign = join(book.audio, `${SLUG}.peaks.json`);
    faults.rename = (from, to) => {
      if (isStep6(from, to) && !existsSync(foreign)) writeFileSync(foreign, 'foreign');
      return undefined;
    };
    const staged = await stage(book);

    await expect(commit(book, staged)).rejects.toThrow(/already exists/);

    expect(readFileSync(foreign, 'utf8')).toBe('foreign');
    const [journalName] = names(book.audio, '.take-journal.');
    expect(json(book, journalName).phase).toBe('install');
    /* The old live peaks stay under their previous name for replay. */
    expect(json(book, `${SLUG}.previous.peaks.json`)).toEqual({ peaks: [B] });
    expect(names(book.audio, '.next-').length).toBeGreaterThan(0);
    expect(take.liveStaging.has(staged.takeId)).toBe(false);
  });

  it('a clean rollback follows a refilled name the old take did not have', async () => {
    const book = await seedBook();
    rmSync(join(book.audio, `${SLUG}.peaks.json`));
    const before = snapshot(book.audio);
    const foreign = join(book.audio, `${SLUG}.peaks.json`);
    faults.rename = (from, to) => {
      if (isStep6(from, to) && !existsSync(foreign)) writeFileSync(foreign, 'foreign');
      return undefined;
    };
    await expect(commit(book, await stage(book))).rejects.toThrow(/already exists/);
    expect(readFileSync(foreign, 'utf8')).toBe('foreign');
    rmSync(foreign);
    expect(snapshot(book.audio)).toEqual(before);
  });
});

/* ---- at and after `installed` ---------------------------------------------- */

describe('commitTake - after installed (D2)', () => {
  it('a failed stamp records no entry, drops the old one, unlinks the discards, keeps the journal and rethrows last', async () => {
    const book = await seedBook({ pending: true });
    faults.stamp = fsError('EROFS');
    const staged = await stage(book);

    await expect(commit(book, staged)).rejects.toBe(faults.stamp);

    /* No version of revisions.json ever held an entry for the new take. */
    expect(faults.revisions.filter((v) => v.includes(staged.takeId))).toEqual([]);
    expect(pending(book)).toEqual([]);
    expect(names(book.audio, '.discard-')).toEqual([]);
    const [journalName, ...more] = names(book.audio, '.take-journal.');
    expect(more).toEqual([]);
    expect(journalName).toBeDefined();
    expect(json(book, journalName).phase).toBe('installed');
    expect(json(book, `${SLUG}.segments.json`).takeId).toBe(staged.takeId);
    expect(chapterState(book).audioTakeId).toBe(B);
    expect(names(book.audio, '.next-')).toEqual([]);
    expect(take.liveStaging.has(staged.takeId)).toBe(false);
    expect(await committedNow(book, staged.takeId)).toBe(true);
  });

  it('a failed discard unlink is parked: the take is committed and the journal is kept', async () => {
    const book = await seedBook();
    faults.unlink = (path) => (path.endsWith('.prev.mp3') ? fsError('EISDIR') : undefined);
    const staged = await stage(book);

    await expect(commit(book, staged)).rejects.toMatchObject({ code: 'EISDIR' });

    expect(chapterState(book).audioTakeId).toBe(staged.takeId);
    expect(pending(book)).toHaveLength(1);
    /* Every other discard was still tried; the journal still names the one left. */
    expect(names(book.audio, '.discard-')).toEqual([expect.stringMatching(/\.prev\.mp3$/)]);
    const [journalName] = names(book.audio, '.take-journal.');
    expect(json(book, journalName).phase).toBe('cleanup');
  });

  it('a failed journal unlink is parked and rethrown', async () => {
    const book = await seedBook();
    faults.unlink = (path) => (path.includes('.take-journal.') ? fsError('EISDIR') : undefined);
    const staged = await stage(book);
    await expect(commit(book, staged)).rejects.toMatchObject({ code: 'EISDIR' });
    expect(names(book.audio, '.take-journal.')).toHaveLength(1);
    expect(await committedNow(book, staged.takeId)).toBe(true);
  });
});

describe('takeCommitted', () => {
  it('is false before the commit, true after it, and never decided from state.json', async () => {
    const book = await seedBook();
    const staged = await stage(book);
    expect(await committedNow(book, staged.takeId)).toBe(false);
    await commit(book, staged);
    expect(await committedNow(book, staged.takeId)).toBe(true);
    expect(await committedNow(book, B)).toBe(false);
  });

  it('is true for a journal at installed even when the live segments are gone, false for one before it', async () => {
    const book = await seedBook();
    faults.stamp = fsError('EROFS');
    const staged = await stage(book);
    await expect(commit(book, staged)).rejects.toThrow();
    rmSync(join(book.audio, `${SLUG}.segments.json`));
    expect(await committedNow(book, staged.takeId)).toBe(true);

    const [journalName] = names(book.audio, '.take-journal.');
    writeFileSync(
      join(book.audio, journalName),
      JSON.stringify({ ...json(book, journalName), phase: 'install' }),
    );
    expect(await committedNow(book, staged.takeId)).toBe(false);
  });
});

/* ---- OD4 ------------------------------------------------------------------- */

describe('commitTake - OD4 carry-forward for a partial write', () => {
  const partial = (book: Seeded) =>
    stage(book, {
      /* Lines 2 and 3 re-synthesised; line 2 carries a verdict patch. The fresh
         rows name the merge target, as the analysis cache does after a merge. */
      /* An iterator, walkable once: a retried commit must still see it. */
      resynthesizedIndices: [1, 2].values(),
      embeddings: {
        version: 'v-new',
        rows: [
          { characterId: 'amelia', sentenceIds: [2], vec: vec(20) },
          { characterId: 'amelia', sentenceIds: [3], vec: vec(30) },
          { characterId: 'amelia', sentenceIds: [99], vec: vec(99) },
        ],
      },
      verdictPatches: [
        { sentenceIds: [2], cosine: 0.88, verdict: 'voice-mismatch', severity: 'severe', fixable: true },
      ],
    });

  const expectCarried = async (book: Seeded, takeId: string) => {
    const emb = await embeddingsIo.readEmbeddings(join(book.audio, `${SLUG}.embeddings.json`));
    expect(emb!.version).toBe('v-live');
    expect(emb!.rows.map((r) => [r.characterId, r.sentenceIds, Array.from(r.vec)])).toEqual([
      ['narrator', [1], Array.from(vec(1))],
      ['amy', [2], Array.from(vec(20))],
      ['amy', [3], Array.from(vec(30))],
    ]);
    expect(json(book, `${SLUG}.embeddings.json`).takeId).toBe(takeId);
    expect(json(book, `${SLUG}.render-integrity.json`)).toEqual([
      verdictRow('narrator', 1, 0.91),
      { ...verdictRow('amy', 2, 0.88), verdict: 'voice-mismatch', severity: 'severe', fixable: true },
    ]);
  };

  it('keeps untouched rows, drops re-synthesised ones, uses the fresh embeddings and patches the named verdict row', async () => {
    const book = await seedBook();
    const staged = await partial(book);
    expect(await commit(book, staged, { base: B, review: null })).toMatchObject({ outcome: 'committed' });
    await expectCarried(book, staged.takeId);
    /* The live files the rows were copied from are the previous take's, unchanged. */
    expect(json<unknown[]>(book, `${SLUG}.previous.render-integrity.json`)).toHaveLength(3);
  });

  it('gives the same rows when the commit is retried over the already-written staged files', async () => {
    const book = await seedBook();
    const staged = await partial(book);
    faults.rename = (from, to) => (isStep6(from, to) ? fsError('EBUSY') : undefined);
    expect(await commit(book, staged, { base: B, review: null })).toEqual({ outcome: 'retry', cause: 'held-file' });
    faults.rename = null;
    expect(await commit(book, staged, { base: B, review: null })).toMatchObject({ outcome: 'committed' });
    await expectCarried(book, staged.takeId);
  });

  it('sweeps the files the carry-forward created when the commit fails for good', async () => {
    const book = await seedBook();
    faults.rename = (from, to) => (isStep6(from, to) ? fsError('EIO') : undefined);
    await expect(commit(book, await partial(book), { base: B })).rejects.toThrow();
    expect(names(book.audio, '.next-')).toEqual([]);
  });

  it('a remix (nothing re-synthesised, no base) carries every row forward', async () => {
    const book = await seedBook();
    await commit(book, await stage(book, { resynthesizedIndices: [] }));
    const emb = await embeddingsIo.readEmbeddings(join(book.audio, `${SLUG}.embeddings.json`));
    expect(emb!.rows).toHaveLength(3);
    expect(json<unknown[]>(book, `${SLUG}.render-integrity.json`)).toHaveLength(3);
  });

  it('writes no verdict file when no row survives', async () => {
    const book = await seedBook();
    await commit(book, await stage(book, { resynthesizedIndices: [0, 1, 2] }), { base: B });
    expect(existsSync(join(book.audio, `${SLUG}.render-integrity.json`))).toBe(false);
  });

  it('a full render carries nothing', async () => {
    const book = await seedBook();
    await commit(book, await stage(book, { resynthesizedIndices: 'all' }));
    expect(existsSync(join(book.audio, `${SLUG}.embeddings.json`))).toBe(false);
    expect(existsSync(join(book.audio, `${SLUG}.render-integrity.json`))).toBe(false);
  });
});
