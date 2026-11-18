/* #4338 — lazy migration steps 1-3 (spec 2026-11-13-chapter-take-lifecycle-design.md
   §6.1 steps 1-3, OD8): `quarantineToOrphaned`, `decodeDurationSec` and
   `migrateSlugFiles`. Fixtures are real ffmpeg sine sources (CLAUDE.md,
   "real-ffmpeg integration where relevant"). WORKSPACE_DIR is pointed at a
   tempdir BEFORE the modules load (paths.ts caches it at import). Handles come
   from a real `withBookOp`. Each test's name states the mutation that turns it
   red. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, utimesSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

/* G6: pin the event id so a test can plant a file at the exact quarantine
   target. Pass-through unless a test arms it. */
const fault = vi.hoisted(() => ({ takeId: null as null | string }));
vi.mock('./take-fields.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./take-fields.js')>();
  return { ...actual, mintTakeId: () => fault.takeId ?? actual.mintTakeId() };
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

function seedBook(): Seeded {
  seq += 1;
  const title = `Migrate Book ${seq}`;
  const bookId = paths.makeBookId('Migrator', 'Ser', title);
  const bookDir = join(paths.BOOKS_ROOT, 'Migrator', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `ms-${seq}`,
      title,
      author: 'Migrator',
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

async function withHandle<T>(book: Seeded, fn: (h: import('./book-op-lock.js').BookHandle) => Promise<T>): Promise<T> {
  const out = await lock.withBookOp(book.bookId, fn);
  if (out === lock.BOOK_GONE) throw new Error('book gone');
  return out;
}

const CODECS = {
  mp3: ['-c:a', 'libmp3lame', '-b:a', '64k'],
  m4a: ['-c:a', 'aac', '-b:a', '64k'],
  ogg: ['-c:a', 'libopus', '-b:a', '32k'],
} as const;

/* Fixture cache: one generated file per (ext, seconds), copied into each test. */
const fixtureDir = () => join(workspaceRoot, 'fixtures');
function fixture(ext: 'mp3' | 'm4a' | 'ogg', sec: number): string {
  const out = join(fixtureDir(), `sine-${sec}.${ext}`);
  if (existsSync(out)) return out;
  mkdirSync(fixtureDir(), { recursive: true });
  const r = spawnSync(
    'ffmpeg',
    ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=440:duration=${sec}`, ...CODECS[ext], out],
    { windowsHide: true },
  );
  if (r.status !== 0) throw new Error(`ffmpeg fixture failed: ${r.stderr?.toString()}`);
  return out;
}
function place(book: Seeded, name: string, src: string): string {
  const dest = join(book.audio, name);
  copyFileSync(src, dest);
  return dest;
}
function writeSegments(book: Seeded, durationSec: number): void {
  writeFileSync(join(book.audio, `${SLUG}.segments.json`), JSON.stringify({ chapterId: 1, durationSec }));
}
function setMtime(path: string, whenSec: number): void {
  utimesSync(path, whenSec, whenSec);
}
/** Sorted recursive listing of `audio/`, files only, relative with `/`. */
function listing(book: Seeded): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else out.push(relative(book.audio, p).split('\\').join('/'));
    }
  };
  walk(book.audio);
  return out.sort();
}
function orphaned(book: Seeded): string[] {
  return listing(book).filter((f) => f.startsWith('.orphaned/'));
}
const EMPTY = { kept: [], renamed: [], madePrevious: [], quarantined: [] };

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-chapter-take-migration-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [take, lock, paths] = await Promise.all([
    import('./chapter-take.js'),
    import('./book-op-lock.js'),
    import('./paths.js'),
  ]);
  /* Generate every fixture once, up front. */
  for (const [ext, sec] of [['mp3', 3], ['m4a', 5], ['ogg', 4], ['mp3', 5]] as const) fixture(ext, sec);
}, 60_000);

afterEach(() => {
  fault.takeId = null;
  vi.restoreAllMocks();
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('quarantineToOrphaned', () => {
  it('G6: refuses to overwrite a planted quarantine target (M2: quarantine overwrites), both files survive', async () => {
    const book = seedBook();
    const src = join(book.audio, 'stray.mp3');
    writeFileSync(src, 'incoming');
    fault.takeId = 'aaaaaaaaaaaaaaaa';
    const eventDir = join(book.audio, '.orphaned', `${new Date().toISOString().slice(0, 10)}-aaaaaaaaaaaaaaaa`);
    mkdirSync(eventDir, { recursive: true });
    writeFileSync(join(eventDir, 'stray.mp3'), 'planted');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(withHandle(book, (h) => take.quarantineToOrphaned(h, [src], 'test'))).rejects.toThrow(/refusing to overwrite/);
    expect(readFileSync(src, 'utf8')).toBe('incoming');
    expect(readFileSync(join(eventDir, 'stray.mp3'), 'utf8')).toBe('planted');
  });

  it('G10: throws ENOENT and never recreates the book folder when audio/ is gone (M6: recursive mkdir)', async () => {
    const book = seedBook();
    rmSync(book.audio, { recursive: true, force: true });
    await expect(withHandle(book, (h) => take.quarantineToOrphaned(h, [join(book.audio, 'x.mp3')], 'test'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect(existsSync(book.audio)).toBe(false);
  });

  it('moves the file into its own dated event folder and returns it', async () => {
    const book = seedBook();
    const src = join(book.audio, 'stray.mp3');
    writeFileSync(src, 'bytes');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const dir = await withHandle(book, (h) => take.quarantineToOrphaned(h, [src], 'test'));
    expect(dir).toMatch(/[\\/]\.orphaned[\\/]\d{4}-\d{2}-\d{2}-[a-z2-7]{16}$/);
    expect(existsSync(src)).toBe(false);
    expect(readFileSync(join(dir, 'stray.mp3'), 'utf8')).toBe('bytes');
  });

  it('refuses a hand-built handle', async () => {
    const book = seedBook();
    const fake = { bookId: book.bookId, bookDir: book.bookDir, held: true } as unknown as import('./book-op-lock.js').BookHandle;
    await expect(take.migrateSlugFiles(fake, SLUG)).rejects.toThrow();
    await expect(take.quarantineToOrphaned(fake, [], 'x')).rejects.toThrow();
  });
});

describe('decodeDurationSec', () => {
  it('G9: measures a full decode, not the header estimate (M5: ffprobe format=duration)', async () => {
    const out = join(workspaceRoot, 'vbr-noxing.mp3');
    const r = spawnSync(
      'ffmpeg',
      [
        '-y', '-v', 'error',
        '-filter_complex', 'anullsrc=r=44100:cl=mono:d=20[a];sine=frequency=440:sample_rate=44100:duration=5[b];[a][b]concat=n=2:v=0:a=1',
        '-c:a', 'libmp3lame', '-q:a', '9', '-write_xing', '0', out,
      ],
      { windowsHide: true },
    );
    expect(r.status, r.stderr?.toString()).toBe(0);
    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', out], {
      windowsHide: true,
    });
    const header = Number(probe.stdout.toString().trim());
    const decoded = await take.decodeDurationSec(out);
    console.info(`[G9] true length 25 s; ffprobe format=duration ${header}; decodeDurationSec ${decoded}`);
    expect(decoded).not.toBeNull();
    expect(Math.abs((decoded as number) - 25)).toBeLessThan(0.2);
  });

  it('resolves null for a file that is not audio', async () => {
    const bad = join(workspaceRoot, 'not-audio.mp3');
    writeFileSync(bad, 'this is not audio');
    expect(await take.decodeDurationSec(bad)).toBeNull();
  });
});

describe('migrateSlugFiles', () => {
  it('G1: one match keeps the m4a live and makes the mp3 the previous take (M1: target-absent check dropped)', async () => {
    const book = seedBook();
    place(book, `${SLUG}.mp3`, fixture('mp3', 3));
    place(book, `${SLUG}.m4a`, fixture('m4a', 5));
    writeSegments(book, 5);
    const report = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    expect(listing(book)).toEqual([`${SLUG}.m4a`, `${SLUG}.previous.mp3`, `${SLUG}.segments.json`]);
    expect(report.kept).toEqual([`${SLUG}.m4a`]);
    expect(report.madePrevious).toEqual([{ from: `${SLUG}.mp3`, to: `${SLUG}.previous.mp3` }]);
    expect(report.quarantined).toEqual([]);
  });

  it('G2: one match with a previous take present quarantines the non-match and leaves the previous untouched (M1)', async () => {
    const book = seedBook();
    place(book, `${SLUG}.mp3`, fixture('mp3', 3));
    place(book, `${SLUG}.m4a`, fixture('m4a', 5));
    const prev = place(book, `${SLUG}.previous.ogg`, fixture('ogg', 4));
    const prevBytes = readFileSync(prev);
    writeSegments(book, 5);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    const files = listing(book);
    expect(files).toContain(`${SLUG}.m4a`);
    expect(files).not.toContain(`${SLUG}.mp3`);
    expect(files).not.toContain(`${SLUG}.previous.mp3`);
    expect(orphaned(book)).toHaveLength(1);
    expect(orphaned(book)[0]).toMatch(new RegExp(`/${SLUG}\\.mp3$`));
    expect(readFileSync(prev).equals(prevBytes)).toBe(true);
    expect(report.quarantined).toHaveLength(1);
    expect(report.madePrevious).toEqual([]);
  });

  it('G3: zero matches keeps the newest by mtime and quarantines the other, and logs it (M4: keeps the oldest)', async () => {
    const book = seedBook();
    const mp3 = place(book, `${SLUG}.mp3`, fixture('mp3', 3));
    const m4a = place(book, `${SLUG}.m4a`, fixture('m4a', 5));
    writeSegments(book, 60);
    setMtime(mp3, 1_600_000_000);
    setMtime(m4a, 1_700_000_000);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    expect(report.kept).toEqual([`${SLUG}.m4a`]);
    expect(listing(book).filter((f) => !f.startsWith('.orphaned/'))).toEqual([`${SLUG}.m4a`, `${SLUG}.segments.json`]);
    expect(orphaned(book)).toHaveLength(1);
    expect(orphaned(book)[0]).toMatch(new RegExp(`/${SLUG}\\.mp3$`));
    expect(warn.mock.calls.some((c) => String(c[0]).includes('0 match'))).toBe(true);
  });

  it('G3b: with no segments at all, nothing matches: newest by mtime stays live (M4)', async () => {
    const book = seedBook();
    const mp3 = place(book, `${SLUG}.mp3`, fixture('mp3', 3));
    const m4a = place(book, `${SLUG}.m4a`, fixture('m4a', 5));
    setMtime(mp3, 1_700_000_000);
    setMtime(m4a, 1_600_000_000);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    expect(report.kept).toEqual([`${SLUG}.mp3`]);
    expect(listing(book).filter((f) => !f.startsWith('.orphaned/'))).toEqual([`${SLUG}.mp3`]);
  });

  it('G4: a wrong-name live and previous file are renamed to their real extension (M3: renames by name only)', async () => {
    const book = seedBook();
    place(book, `${SLUG}.mp3`, fixture('m4a', 5)); // AAC bytes behind .mp3
    place(book, `${SLUG}.previous.mp3`, fixture('ogg', 4)); // Opus bytes behind .mp3
    const report = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    expect(listing(book)).toEqual([`${SLUG}.m4a`, `${SLUG}.previous.ogg`]);
    expect(report.renamed).toEqual([
      { from: `${SLUG}.mp3`, to: `${SLUG}.m4a` },
      { from: `${SLUG}.previous.mp3`, to: `${SLUG}.previous.ogg` },
    ]);
  });

  it('G5: a wrong-name file whose real-extension target exists is quarantined, never renamed over (M1)', async () => {
    const book = seedBook();
    place(book, `${SLUG}.mp3`, fixture('mp3', 3));
    writeSegments(book, 3);
    place(book, `${SLUG}.previous.mp3`, fixture('m4a', 5)); // AAC bytes behind .mp3
    const real = place(book, `${SLUG}.previous.m4a`, fixture('m4a', 5));
    const realBytes = readFileSync(real);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const report = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    const files = listing(book);
    expect(files).not.toContain(`${SLUG}.previous.mp3`);
    expect(readFileSync(real).equals(realBytes)).toBe(true);
    expect(orphaned(book)).toHaveLength(1);
    expect(orphaned(book)[0]).toMatch(new RegExp(`/${SLUG}\\.previous\\.mp3$`));
    expect(report.renamed).toEqual([]);
  });

  it('G7: running the G1 fixture twice changes nothing the second time (idempotent)', async () => {
    const book = seedBook();
    place(book, `${SLUG}.mp3`, fixture('mp3', 3));
    place(book, `${SLUG}.m4a`, fixture('m4a', 5));
    writeSegments(book, 5);
    await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    const after1 = listing(book);
    const report2 = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    expect(report2).toEqual(EMPTY);
    expect(listing(book)).toEqual(after1);
  });

  it('G8: a clean mp3 slug with a previous.mp3 is left unchanged', async () => {
    const book = seedBook();
    place(book, `${SLUG}.mp3`, fixture('mp3', 3));
    place(book, `${SLUG}.previous.mp3`, fixture('mp3', 5));
    writeSegments(book, 3);
    const before = listing(book);
    const report = await withHandle(book, (h) => take.migrateSlugFiles(h, SLUG));
    expect(report).toEqual(EMPTY);
    expect(listing(book)).toEqual(before);
  });
});
