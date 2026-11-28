/* #4320 step 3 (#4827) — `prepareTake`, the staging half of the take commit
   (spec 2026-11-13-chapter-take-lifecycle-design.md §5.A "Prepare", "Sweep";
   N14, N15). WORKSPACE_DIR is pointed at a tempdir BEFORE the modules load
   (paths.ts caches it at import). `prepareTake` holds no lock, so each test
   passes a plain `{ bookDir }`. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
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
import type { PrepareTakeInput, StagedTake } from './chapter-take.js';

/* Staging fault injection: pass-through unless a test arms a hook. `opened`
   fires after a `wx` open has created its file. */
const faults = vi.hoisted(() => ({
  beforeOpen: null as null | ((path: string) => void),
  opened: null as null | ((path: string) => void),
  writeError: null as null | { suffix: string; error: Error },
  unlinkError: null as null | { suffix: string; error: Error },
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const open = (async (...args: Parameters<typeof actual.open>) => {
    const path = String(args[0]);
    if (args[1] === 'wx') faults.beforeOpen?.(path);
    const fh = await actual.open(...args);
    if (args[1] === 'wx') {
      const fault = faults.writeError;
      if (fault && path.endsWith(fault.suffix)) {
        /* Half a file lands, then the disk refuses the rest. */
        fh.writeFile = (async () => {
          await fh.write('half');
          throw fault.error;
        }) as typeof fh.writeFile;
      }
      faults.opened?.(path);
    }
    return fh;
  }) as typeof actual.open;
  const unlink = (async (...args: Parameters<typeof actual.unlink>) => {
    const fault = faults.unlinkError;
    if (fault && String(args[0]).endsWith(fault.suffix)) throw fault.error;
    return actual.unlink(...args);
  }) as typeof actual.unlink;
  return { ...actual, open, unlink, default: { ...actual, open, unlink } };
});

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let embeddingsIo: typeof import('../audio/render-integrity/embeddings-io.js');

const SLUG = 'ch-01';
const OLD_ID = 'aaaaaaaaaaaaaaaa';
let seq = 0;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'take-prepare-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  take = await import('./chapter-take.js');
  embeddingsIo = await import('../audio/render-integrity/embeddings-io.js');
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

afterEach(() => {
  faults.beforeOpen = null;
  faults.opened = null;
  faults.writeError = null;
  faults.unlinkError = null;
  vi.restoreAllMocks();
});

function seedBook(opts: { audio?: boolean } = {}): { bookDir: string; audio: string } {
  seq += 1;
  const bookDir = join(workspaceRoot, `book-${seq}`);
  mkdirSync(bookDir, { recursive: true });
  const audio = join(bookDir, 'audio');
  if (opts.audio !== false) mkdirSync(audio);
  return { bookDir, audio };
}

const LIVE_SUFFIXES = [
  'mp3',
  'segments.json',
  'peaks.json',
  'lufs.json',
  'embeddings.json',
  'render-integrity.json',
  'render-integrity-attempted.json',
];

/** A complete live take with an mtime far in the past, so any rewrite shows. */
function seedLiveTake(audio: string): void {
  const past = new Date('2020-01-01T00:00:00.000Z');
  for (const suffix of LIVE_SUFFIXES) {
    const path = join(audio, `${SLUG}.${suffix}`);
    writeFileSync(path, JSON.stringify({ live: suffix, takeId: OLD_ID }));
    utimesSync(path, past, past);
  }
}

/** Every file in `audio/` with its bytes and mtime. */
function snapshot(audio: string): Record<string, { bytes: string; mtimeMs: number }> {
  return Object.fromEntries(
    readdirSync(audio).map((name) => {
      const path = join(audio, name);
      return [name, { bytes: readFileSync(path, 'base64'), mtimeMs: statSync(path).mtimeMs }];
    }),
  );
}

const stagedNames = (audio: string): string[] =>
  readdirSync(audio)
    .filter((name) => name.includes('.next-'))
    .sort();

const readStaged = (staged: StagedTake, suffix: string): unknown => {
  const part = staged.parts.find((p) => p.suffix === suffix);
  if (!part) throw new Error(`no staged ${suffix}`);
  return JSON.parse(readFileSync(part.path, 'utf8'));
};

/** Every part a take can stage, as finalize computes the payloads. */
function fullInput(over: Partial<PrepareTakeInput> = {}): PrepareTakeInput {
  const segments = {
    bookId: 'b1',
    chapterId: 1,
    chapterTitle: 'One — «первая»',
    durationSec: 12.5,
    modelKey: 'kokoro-v1',
    synthesizedAt: '2026-03-03T00:00:00.000Z',
    segments: [{ characterId: 'narrator', sentenceIds: [1], startSec: 0, endSec: 12.5 }],
  };
  return {
    slug: SLUG,
    ext: 'mp3',
    audio: Buffer.from([0x49, 0x44, 0x33, 0x00, 0xff, 0xfe]),
    segments,
    peaks: { peaks: [0.1, 0.2, 0.3] },
    lufs: { i: -18.2, lra: 4, tp: -1.5, measurementSource: 'ebur128' },
    embeddings: {
      version: 'v-test',
      rows: [
        { characterId: 'narrator', sentenceIds: [1], vec: new Float32Array([0.25, -1, 3.5]) },
      ],
    },
    verdicts: [
      {
        characterId: 'narrator',
        sentenceIds: [1],
        verdict: 'voice-match',
        cosine: 0.9,
        severity: null,
        fixable: false,
        expectedEngine: 'kokoro',
        renderedEngine: 'kokoro',
        referenceKind: 'in-book',
        windowed: false,
      },
    ],
    ...over,
  };
}

const ALL_SUFFIXES = [
  'mp3',
  'segments.json',
  'peaks.json',
  'lufs.json',
  'embeddings.json',
  'render-integrity.json',
];

const signal = (): AbortSignal => new AbortController().signal;

describe('staged take names', () => {
  const ID = 'bcdefghij234567a';

  it('builds <slug>.next-<takeId>.<suffix> inside audio/', () => {
    expect(take.stagedPartPath('root', SLUG, ID, 'segments.json')).toBe(
      join('root', `${SLUG}.next-${ID}.segments.json`),
    );
    expect(take.stagedAudioPath('root', SLUG, ID, 'm4a')).toBe(join('root', `${SLUG}.next-${ID}.m4a`));
  });

  it('parses the slug, take id and suffix back out of a staged name', () => {
    for (const suffix of ALL_SUFFIXES) {
      expect(take.parseStagedName(`01.a.chapter.next-${ID}.${suffix}`)).toEqual({
        slug: '01.a.chapter',
        takeId: ID,
        suffix,
      });
    }
  });

  it('answers null for a name that is not a staged part', () => {
    for (const name of [
      `${SLUG}.mp3`,
      `${SLUG}.previous.segments.json`,
      `${SLUG}.discard-${ID}.mp3`,
      `${SLUG}.next-tooshort.mp3`,
      `${SLUG}.next-${ID}`,
      `.next-${ID}.mp3`,
      `${SLUG}.take-journal.${ID}.json`,
    ]) {
      expect(take.parseStagedName(name), name).toBeNull();
    }
  });

  it('a staged audio name never makes a take live', () => {
    const { audio } = seedBook();
    writeFileSync(take.stagedAudioPath(audio, SLUG, ID, 'mp3'), 'x');
    expect(take.chapterAudioExists(audio, SLUG)).toBe(false);
  });
});

describe('prepareTake', () => {
  it('writes every given part to its .next-<takeId> name and touches no live name', async () => {
    const { bookDir, audio } = seedBook();
    seedLiveTake(audio);
    const before = snapshot(audio);

    const staged = await take.prepareTake({ bookDir }, fullInput(), signal());

    expect(take.isTakeId(staged.takeId)).toBe(true);
    expect(staged.takeId).not.toBe(OLD_ID);
    expect(staged.parts.map((p) => p.suffix)).toEqual(ALL_SUFFIXES);
    for (const part of staged.parts) {
      expect(part.path).toBe(join(audio, `${SLUG}.next-${staged.takeId}.${part.suffix}`));
      expect(part.size).toBe(statSync(part.path).size);
    }
    const after = snapshot(audio);
    expect(Object.keys(after).sort()).toEqual(
      [...Object.keys(before), ...staged.parts.map((p) => basename(p.path))].sort(),
    );
    for (const name of Object.keys(before)) expect(after[name], name).toEqual(before[name]);
    take.releaseStaging(staged.takeId);
  });

  it('writes the given bytes and payloads, and describes the take', async () => {
    const { bookDir } = seedBook();
    const input = fullInput({ ext: 'm4a' });

    const staged = await take.prepareTake({ bookDir }, input, signal());

    const audioPart = staged.parts[0];
    expect(audioPart.suffix).toBe('m4a');
    expect(readFileSync(audioPart.path).equals(Buffer.from(input.audio))).toBe(true);
    expect(readStaged(staged, 'peaks.json')).toEqual(input.peaks);
    expect(readStaged(staged, 'lufs.json')).toEqual(input.lufs);
    expect(readStaged(staged, 'segments.json')).toEqual({ ...input.segments, takeId: staged.takeId });
    expect(staged).toMatchObject({
      slug: SLUG,
      ext: 'm4a',
      durationSec: 12.5,
      synthesizedAt: '2026-03-03T00:00:00.000Z',
    });
    expect(staged.segments).toEqual(readStaged(staged, 'segments.json'));
    expect(staged.verdictPatches).toBeUndefined();
    take.releaseStaging(staged.takeId);
  });

  it('stamps one new takeId into segments and embeddings, and none into the verdicts', async () => {
    const { bookDir } = seedBook();
    /* An id carried in from the payload (a partial writer rewriting the prior
       file) must not survive onto the new take. */
    const base = fullInput();
    const input = { ...base, segments: { ...base.segments, takeId: OLD_ID } };

    const staged = await take.prepareTake({ bookDir }, input, signal());

    expect(staged.segments.takeId).toBe(staged.takeId);
    expect(staged.takeId).not.toBe(OLD_ID);
    expect((readStaged(staged, 'segments.json') as { takeId: string }).takeId).toBe(staged.takeId);
    expect((readStaged(staged, 'embeddings.json') as { takeId: string }).takeId).toBe(staged.takeId);
    expect(readStaged(staged, 'render-integrity.json')).toEqual(input.verdicts);
    expect(input.segments.takeId).toBe(OLD_ID); // the caller's object is not mutated
    take.releaseStaging(staged.takeId);
  });

  it('stages embeddings in the format writeEmbeddings writes and readEmbeddings reads', async () => {
    const { bookDir, audio } = seedBook();
    const input = fullInput();
    const reference = join(audio, 'reference.json');
    await embeddingsIo.writeEmbeddings(reference, [...input.embeddings!.rows], 'v-test');

    const staged = await take.prepareTake({ bookDir }, input, signal());

    expect(readStaged(staged, 'embeddings.json')).toEqual({
      ...JSON.parse(readFileSync(reference, 'utf8')),
      takeId: staged.takeId,
    });
    const part = staged.parts.find((p) => p.suffix === 'embeddings.json')!;
    expect(await embeddingsIo.readEmbeddings(part.path)).toEqual({
      version: 'v-test',
      rows: input.embeddings!.rows,
    });
    take.releaseStaging(staged.takeId);
  });

  it('stages only the parts it is given, and keeps verdict patches in memory', async () => {
    const { bookDir, audio } = seedBook();
    const { slug, ext, audio: bytes, segments } = fullInput();
    const verdictPatches = [
      {
        sentenceIds: [1],
        cosine: 0.42,
        verdict: 'voice-mismatch' as const,
        severity: 'severe' as const,
        fixable: true,
      },
    ];

    const staged = await take.prepareTake(
      { bookDir },
      { slug, ext, audio: bytes, segments, verdictPatches },
      signal(),
    );

    expect(staged.parts.map((p) => p.suffix)).toEqual(['mp3', 'segments.json']);
    expect(stagedNames(audio)).toEqual(staged.parts.map((p) => basename(p.path)).sort());
    expect(staged.verdictPatches).toEqual(verdictPatches);
    take.releaseStaging(staged.takeId);
  });

  it('refuses a pre-existing file at a staged name, removes what it staged and keeps that file', async () => {
    const { bookDir, audio } = seedBook();
    let foreign = '';
    faults.beforeOpen = (path) => {
      if (!path.endsWith('.peaks.json')) return;
      foreign = path;
      writeFileSync(path, 'foreign');
    };
    const heldBefore = take.liveStaging.size;

    await expect(take.prepareTake({ bookDir }, fullInput(), signal())).rejects.toMatchObject({
      code: 'EEXIST',
    });

    expect(stagedNames(audio)).toEqual([basename(foreign)]);
    expect(readFileSync(foreign, 'utf8')).toBe('foreign');
    expect(take.liveStaging.size).toBe(heldBefore);
  });

  it('removes a half-written part along with the earlier ones when a write fails', async () => {
    const { bookDir, audio } = seedBook();
    faults.writeError = {
      suffix: '.segments.json',
      error: Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    };
    const heldBefore = take.liveStaging.size;

    await expect(take.prepareTake({ bookDir }, fullInput(), signal())).rejects.toMatchObject({
      code: 'ENOSPC',
    });

    expect(readdirSync(audio)).toEqual([]);
    expect(take.liveStaging.size).toBe(heldBefore);
  });

  it('throws the original error when removing a staged part also fails', async () => {
    const { bookDir, audio } = seedBook();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    faults.writeError = {
      suffix: '.peaks.json',
      error: Object.assign(new Error('disk full'), { code: 'ENOSPC' }),
    };
    faults.unlinkError = {
      suffix: '.mp3',
      error: Object.assign(new Error('refused'), { code: 'EINVAL' }),
    };
    const heldBefore = take.liveStaging.size;

    await expect(take.prepareTake({ bookDir }, fullInput(), signal())).rejects.toMatchObject({
      code: 'ENOSPC',
    });

    /* The part that would not go is left for the sweep; the rest are removed. */
    expect(stagedNames(audio)).toEqual([expect.stringMatching(/\.mp3$/)]);
    expect(take.liveStaging.size).toBe(heldBefore);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('staged part removal failed'));
  });

  it('never creates a directory: with audio/ gone it throws ENOENT and leaves it gone', async () => {
    const { bookDir, audio } = seedBook({ audio: false });
    const heldBefore = take.liveStaging.size;

    await expect(take.prepareTake({ bookDir }, fullInput(), signal())).rejects.toMatchObject({
      code: 'ENOENT',
    });

    expect(existsSync(audio)).toBe(false);
    expect(readdirSync(bookDir)).toEqual([]);
    expect(take.liveStaging.size).toBe(heldBefore);
  });

  it('writes nothing for a signal that is already aborted', async () => {
    const { bookDir, audio } = seedBook();
    const ctrl = new AbortController();
    ctrl.abort();

    await expect(take.prepareTake({ bookDir }, fullInput(), ctrl.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });

    expect(readdirSync(audio)).toEqual([]);
  });

  /* One case per boundary: the check runs before EACH part, not once. */
  it.each(ALL_SUFFIXES.slice(0, -1).map((suffix, i) => [suffix, i + 1] as const))(
    'an abort after the %s part stops before the next one and leaves nothing staged',
    async (suffix, written) => {
      const { bookDir, audio } = seedBook();
      const ctrl = new AbortController();
      const created: string[] = [];
      faults.opened = (path) => {
        created.push(path);
        if (path.endsWith(`.${suffix}`)) ctrl.abort();
      };
      const heldBefore = take.liveStaging.size;

      await expect(take.prepareTake({ bookDir }, fullInput(), ctrl.signal)).rejects.toMatchObject({
        name: 'AbortError',
      });

      expect(created).toHaveLength(written);
      expect(readdirSync(audio)).toEqual([]);
      expect(take.liveStaging.size).toBe(heldBefore);
    },
  );

  it('holds the take id in liveStaging from before the first part until releaseStaging', async () => {
    const { bookDir } = seedBook();
    const heldAtOpen: boolean[] = [];
    faults.beforeOpen = (path) => {
      const parsed = take.parseStagedName(basename(path));
      heldAtOpen.push(parsed !== null && take.liveStaging.has(parsed.takeId));
    };

    const staged = await take.prepareTake({ bookDir }, fullInput(), signal());

    expect(heldAtOpen).toEqual(ALL_SUFFIXES.map(() => true));
    expect(take.liveStaging.has(staged.takeId)).toBe(true);
    take.releaseStaging(staged.takeId);
    expect(take.liveStaging.has(staged.takeId)).toBe(false);
    take.releaseStaging(staged.takeId); // a second release is harmless
  });
});

describe('discardStaged', () => {
  it('unlinks every staged part, leaves the live take, and is idempotent', async () => {
    const { bookDir, audio } = seedBook();
    seedLiveTake(audio);
    const before = snapshot(audio);
    const staged = await take.prepareTake({ bookDir }, fullInput(), signal());

    await take.discardStaged(staged);
    expect(snapshot(audio)).toEqual(before);

    await expect(take.discardStaged(staged)).resolves.toBeUndefined();
    expect(snapshot(audio)).toEqual(before);
    take.releaseStaging(staged.takeId);
  });

  it('removes the other parts and reports the failure when one cannot be unlinked', async () => {
    const { bookDir, audio } = seedBook();
    const staged = await take.prepareTake({ bookDir }, fullInput(), signal());
    faults.unlinkError = {
      suffix: '.mp3',
      error: Object.assign(new Error('refused'), { code: 'EINVAL' }),
    };

    await expect(take.discardStaged(staged)).rejects.toMatchObject({ code: 'EINVAL' });

    expect(stagedNames(audio)).toEqual([basename(staged.parts[0].path)]);
    take.releaseStaging(staged.takeId);
  });
});
