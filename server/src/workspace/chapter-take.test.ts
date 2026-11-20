/* #4327 — unit tests for the chapter take module's sniffer, state stamp and
   lazy identity (spec 2026-11-13-chapter-take-lifecycle-design.md §4.1, §4.4,
   §6.1 step 1, §5.A). WORKSPACE_DIR is pointed at a tempdir BEFORE the modules
   load (paths.ts caches it at import). Handles come from a real `withBookOp`
   over a seeded book; only the refusal test hand-builds one. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* S7 fault injection: pass-through unless a test arms it. */
const faults = vi.hoisted(() => ({ stateWriteError: null as null | Error }));
vi.mock('./book-state-update.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./book-state-update.js')>();
  return {
    ...actual,
    updateStateAtDir: async (...args: Parameters<typeof actual.updateStateAtDir>) => {
      if (faults.stateWriteError) throw faults.stateWriteError;
      return actual.updateStateAtDir(...args);
    },
  };
});

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let lock: typeof import('./book-op-lock.js');
let paths: typeof import('./paths.js');

const SLUG = 'ch-01';
let seq = 0;

interface Seeded {
  bookId: string;
  bookDir: string;
  audio: string;
}

function seedBook(chapterExtra: Record<string, unknown> = {}): Seeded {
  seq += 1;
  const title = `Take Book ${seq}`;
  const bookId = paths.makeBookId('Taker', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Taker', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-${seq}`,
      title,
      author: 'Taker',
      series: 'Ser',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'One', slug: SLUG, ...chapterExtra }],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  return { bookId, bookDir, audio };
}

const QA = {
  status: 'ok' as const,
  reasons: [],
  measuredLufs: -19,
  truePeakDb: -3,
  durationSec: 61,
  expectedSec: 60,
  checkedAt: '2026-01-01T00:00:00.000Z',
};

const SEGMENTS = {
  chapterId: 1,
  modelKey: 'kokoro-v1',
  durationSec: 61,
  synthesizedAt: '2026-02-02T00:00:00.000Z',
  characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
};

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value));
}
function readJsonFile(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}
function stateChapter(book: Seeded): Record<string, unknown> {
  const state = readJsonFile(join(book.bookDir, '.audiobook', 'state.json'));
  return (state.chapters as Array<Record<string, unknown>>)[0];
}
function liveTake(book: Seeded, segments: Record<string, unknown> = SEGMENTS): void {
  writeFileSync(join(book.audio, `${SLUG}.mp3`), Buffer.from('ID3....'));
  writeJson(join(book.audio, `${SLUG}.segments.json`), segments);
}
async function withHandle<T>(book: Seeded, fn: (h: import('./book-op-lock.js').BookHandle) => Promise<T>): Promise<T> {
  const out = await lock.withBookOp(book.bookId, fn);
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-chapter-take-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [take, lock, paths] = await Promise.all([
    import('./chapter-take.js'),
    import('./book-op-lock.js'),
    import('./paths.js'),
  ]);
});

afterEach(() => {
  faults.stateWriteError = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('S1: sniffAudioFormat', () => {
  const dir = () => mkdtempSync(join(workspaceRoot, 'sniff-'));
  async function sniff(bytes: Buffer): Promise<string | null> {
    const p = join(dir(), 'f.bin');
    writeFileSync(p, bytes);
    return take.sniffAudioFormat(p);
  }

  it('reads an ID3 header as mp3', async () => {
    expect(await sniff(Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 0]))).toBe('mp3');
  });
  it('reads an MPEG frame sync as mp3', async () => {
    expect(await sniff(Buffer.from([0xff, 0xfb, 0x90, 0x00, 0, 0, 0, 0]))).toBe('mp3');
  });
  it('reads ftyp at offset 4 as m4a', async () => {
    expect(await sniff(Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from('ftypM4A '), Buffer.alloc(4)]))).toBe('m4a');
  });
  it('reads OggS at offset 0 as ogg', async () => {
    expect(await sniff(Buffer.concat([Buffer.from('OggS'), Buffer.alloc(8)]))).toBe('ogg');
  });
  it('returns null for ftyp at offset 0', async () => {
    expect(await sniff(Buffer.concat([Buffer.from('ftyp'), Buffer.alloc(8)]))).toBeNull();
  });
  it('returns null for random bytes', async () => {
    expect(await sniff(Buffer.from([0x12, 0x34, 0x56, 0x78, 0x9a, 0xbc, 0xde, 0xf0, 0x11, 0x22]))).toBeNull();
  });
  it('returns null for an empty file', async () => {
    expect(await sniff(Buffer.alloc(0))).toBeNull();
  });
});

describe('S2/S3/S4: stampStateFromLiveTake', () => {
  it('S2: the same take sets every derived member and keeps a non-derivable audioQa', async () => {
    const book = seedBook({ audioQa: QA });
    liveTake(book);
    await withHandle(book, (h) => take.stampStateFromLiveTake(h, SLUG, { takeChanged: false }));
    const ch = stateChapter(book);
    expect(ch.duration).toBe('01:01');
    expect(ch.audioModelKey).toBe('kokoro-v1');
    expect(ch.audioEngines).toEqual({ kokoro: 1 });
    expect(ch.audioRenderedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(ch.audioQa).toEqual(QA);
  });

  it('S3: takeChanged clears every member the segments lack', async () => {
    const book = seedBook({ audioQa: QA });
    liveTake(book);
    await withHandle(book, (h) => take.stampStateFromLiveTake(h, SLUG, { takeChanged: true }));
    const ch = stateChapter(book);
    expect(ch.audioRenderedAt).toBe('2026-02-02T00:00:00.000Z');
    expect(ch).not.toHaveProperty('audioQa');
  });

  it('S3: with no live segments, takeChanged clears everything except duration', async () => {
    const book = seedBook({
      duration: '12:34',
      audioModelKey: 'kokoro-v1',
      audioEngines: { kokoro: 1 },
      audioRenderedAt: '2026-01-01T00:00:00.000Z',
      audioQa: QA,
      audioTakeId: 'abcdefghijklmnop',
    });
    writeFileSync(join(book.audio, `${SLUG}.mp3`), Buffer.from('ID3....'));
    await withHandle(book, (h) => take.stampStateFromLiveTake(h, SLUG, { takeChanged: true }));
    const ch = stateChapter(book);
    expect(ch.duration).toBe('12:34');
    for (const f of ['audioModelKey', 'audioEngines', 'audioRenderedAt', 'audioQa', 'audioTakeId']) {
      expect(ch).not.toHaveProperty(f);
    }
  });

  it('S4: stamps the EFFECTIVE audioModelKey, not the raw modelKey', async () => {
    const book = seedBook();
    liveTake(book, {
      ...SEGMENTS,
      modelKey: 'qwen3-tts-0.6b',
      characterSnapshots: {
        a: { voiceEngine: 'qwen', renderedFallbackEngine: 'kokoro' },
        b: { voiceEngine: 'kokoro' },
      },
    });
    await withHandle(book, (h) => take.stampStateFromLiveTake(h, SLUG, { takeChanged: false }));
    const ch = stateChapter(book);
    expect(ch.audioModelKey).toBe('kokoro-v1');
    expect(ch.audioEngines).toEqual({ kokoro: 2 });
  });
});

describe('S5/S6/S7: ensureTakeIdentity', () => {
  it('S5: mints one id into segments, embeddings and state.json, and a second call is a no-op', async () => {
    const book = seedBook();
    liveTake(book);
    const rows = [{ characterId: 'n', sentenceIds: [1], vec: 'AAAA' }];
    writeJson(join(book.audio, `${SLUG}.embeddings.json`), { version: 'v1', rows });
    const rowsBefore = JSON.stringify(rows);

    await withHandle(book, (h) => take.ensureTakeIdentity(h, SLUG));
    const seg = readJsonFile(join(book.audio, `${SLUG}.segments.json`));
    const emb = readJsonFile(join(book.audio, `${SLUG}.embeddings.json`));
    expect(take.isTakeId(seg.takeId)).toBe(true);
    expect(emb.takeId).toBe(seg.takeId);
    expect(JSON.stringify(emb.rows)).toBe(rowsBefore);
    expect(stateChapter(book).audioTakeId).toBe(seg.takeId);

    const files = ['segments', 'embeddings'].map((p) => join(book.audio, `${SLUG}.${p}.json`));
    const stateFile = join(book.bookDir, '.audiobook', 'state.json');
    const before = [...files, stateFile].map((f) => readFileSync(f));
    await withHandle(book, (h) => take.ensureTakeIdentity(h, SLUG));
    const after = [...files, stateFile].map((f) => readFileSync(f));
    after.forEach((buf, i) => expect(buf.equals(before[i])).toBe(true));
  });

  it('S5b: the state.json mirror writes audioTakeId ONLY; every other member, a raw audioModelKey included, is left as it is', async () => {
    const book = seedBook({ audioRenderedAt: 'old', duration: '0:01', audioModelKey: 'raw-key', audioEngines: { kokoro: 1 }, audioQa: { score: 0.5 } });
    liveTake(book);
    const before = stateChapter(book);

    await withHandle(book, (h) => take.ensureTakeIdentity(h, SLUG));

    const seg = readJsonFile(join(book.audio, `${SLUG}.segments.json`));
    expect(stateChapter(book)).toEqual({ ...before, audioTakeId: seg.takeId });
  });

  it('S6: a previous take with no id gains one; with no live take no live file appears', async () => {
    const book = seedBook();
    writeFileSync(join(book.audio, `${SLUG}.previous.mp3`), Buffer.from('ID3....'));
    writeJson(join(book.audio, `${SLUG}.previous.segments.json`), SEGMENTS);
    writeJson(join(book.audio, `${SLUG}.previous.embeddings.json`), { version: 'v1', rows: [] });
    await withHandle(book, (h) => take.ensureTakeIdentity(h, SLUG));
    const prev = readJsonFile(join(book.audio, `${SLUG}.previous.segments.json`));
    expect(take.isTakeId(prev.takeId)).toBe(true);
    expect(readJsonFile(join(book.audio, `${SLUG}.previous.embeddings.json`)).takeId).toBe(prev.takeId);
    expect(existsSync(join(book.audio, `${SLUG}.segments.json`))).toBe(false);
    expect(existsSync(join(book.audio, `${SLUG}.embeddings.json`))).toBe(false);
    expect(stateChapter(book)).not.toHaveProperty('audioTakeId');
  });

  it('S7: a failing state.json mirror is swallowed and the segments still carry the id', async () => {
    const book = seedBook();
    liveTake(book);
    faults.stateWriteError = new Error('state.json write failed');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await expect(withHandle(book, (h) => take.ensureTakeIdentity(h, SLUG))).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    const seg = readJsonFile(join(book.audio, `${SLUG}.segments.json`));
    expect(take.isTakeId(seg.takeId)).toBe(true);
    expect(stateChapter(book)).not.toHaveProperty('audioTakeId');
  });
});

describe('S8: stale and hand-built handles are refused', () => {
  it('refuses a handle used after its withBookOp callback returned', async () => {
    const book = seedBook();
    liveTake(book);
    let captured!: import('./book-op-lock.js').BookHandle;
    await withHandle(book, async (h) => {
      captured = h;
    });
    await expect(take.ensureTakeIdentity(captured, SLUG)).rejects.toThrow(/not held/);
    await expect(take.stampStateFromLiveTake(captured, SLUG, { takeChanged: false })).rejects.toThrow(/not held/);
  });

  it('refuses a hand-built { held: true } handle', async () => {
    const book = seedBook();
    liveTake(book);
    const fake = { bookId: book.bookId, bookDir: book.bookDir, held: true } as unknown as import('./book-op-lock.js').BookHandle;
    await expect(take.ensureTakeIdentity(fake, SLUG)).rejects.toThrow(/not held/);
    await expect(take.stampStateFromLiveTake(fake, SLUG, { takeChanged: false })).rejects.toThrow(/not held/);
    expect(readJsonFile(join(book.audio, `${SLUG}.segments.json`))).not.toHaveProperty('takeId');
  });
});
