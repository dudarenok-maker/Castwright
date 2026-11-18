/* #4339 — `reconcileSlug` at the boot fsck (spec 2026-11-13-chapter-take-lifecycle-design.md
   §6.1 steps 4-5, §7 Phase 1 step 5). Drives the real `fsckAllBooks` over a tempdir
   workspace; audio fixtures are magic-byte stubs (the sniffer reads only the head,
   and a single live file is never decoded). WORKSPACE_DIR is set BEFORE the modules
   load (paths.ts caches it at import). Each test names the mutation that turns it red. */
import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let workspaceRoot: string;
let take: typeof import('./chapter-take.js');
let fsck: typeof import('./fsck-orphan-audio.js');
let paths: typeof import('./paths.js');

const SLUG = 'ch-01';
const MP3 = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(32)]);
let seq = 0;

interface Seeded {
  bookDir: string;
  audio: string;
  state: string;
}

function seedBook(opts: { chapter?: Record<string, unknown>; bookId?: boolean } = {}): Seeded {
  seq += 1;
  const title = `Reconcile Book ${seq}`;
  const bookDir = join(paths.BOOKS_ROOT, 'Reconciler', 'Ser', title);
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  const audio = join(bookDir, 'audio');
  mkdirSync(audio, { recursive: true });
  const state = join(bookDir, '.audiobook', 'state.json');
  writeFileSync(
    state,
    JSON.stringify({
      ...(opts.bookId === false ? {} : { bookId: paths.makeBookId('Reconciler', 'Ser', title) }),
      manuscriptId: `ms-${seq}`,
      title,
      author: 'Reconciler',
      series: 'Ser',
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: false,
      chapters: [{ id: 1, title: 'One', slug: SLUG, ...opts.chapter }],
      createdAt: '2020-01-01T00:00:00.000Z',
      updatedAt: '2020-01-01T00:00:00.000Z',
    }),
  );
  return { bookDir, audio, state };
}

const writeJson = (path: string, v: unknown) => writeFileSync(path, JSON.stringify(v));
const readJson = (path: string) => JSON.parse(readFileSync(path, 'utf8'));
const chapterOf = (b: Seeded) => readJson(b.state).chapters[0] as Record<string, unknown>;

/** Every file under the book folder: relative name -> bytes (hex). */
function snapshot(b: Seeded): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string, rel: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, `${rel}${e.name}/`);
      else out[`${rel}${e.name}`] = readFileSync(p).toString('hex');
    }
  };
  walk(b.bookDir, '');
  return out;
}

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-chapter-take-reconcile-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  [take, fsck, paths] = await Promise.all([
    import('./chapter-take.js'),
    import('./fsck-orphan-audio.js'),
    import('./paths.js'),
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(paths.BOOKS_ROOT, { recursive: true, force: true });
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

describe('boot fsck runs reconcileSlug for every chapter slug', () => {
  it('I1: a legacy book (no takeId anywhere) gets ids on live segments, embeddings, previous segments and state.json', async () => {
    const b = seedBook();
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.segments.json`), { durationSec: 12, modelKey: 'm-live', synthesizedAt: 'T-live' });
    writeJson(join(b.audio, `${SLUG}.embeddings.json`), { version: 1, rows: [] });
    writeFileSync(join(b.audio, `${SLUG}.previous.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.previous.segments.json`), { durationSec: 9, synthesizedAt: 'T-prev' });

    await fsck.fsckAllBooks();

    const live = readJson(join(b.audio, `${SLUG}.segments.json`));
    const prev = readJson(join(b.audio, `${SLUG}.previous.segments.json`));
    expect(take.isTakeId(live.takeId)).toBe(true);
    expect(take.isTakeId(prev.takeId)).toBe(true);
    expect(prev.takeId).not.toBe(live.takeId);
    expect(readJson(join(b.audio, `${SLUG}.embeddings.json`)).takeId).toBe(live.takeId);
    expect(chapterOf(b).audioTakeId).toBe(live.takeId);
  });

  it('I1: the same for a book whose state.json has no bookId (the unaddressed handle)', async () => {
    const b = seedBook({ bookId: false });
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.segments.json`), { durationSec: 12, synthesizedAt: 'T-live' });

    await fsck.fsckAllBooks();

    const live = readJson(join(b.audio, `${SLUG}.segments.json`));
    expect(take.isTakeId(live.takeId)).toBe(true);
    expect(chapterOf(b).audioTakeId).toBe(live.takeId);
  });

  it('I2: a legacy-reject shape re-stamps every member from the live take and clears audioQa (M2 turns this red)', async () => {
    const b = seedBook({
      chapter: {
        audioRenderedAt: 'T-A',
        duration: '00:10',
        audioModelKey: 'm-a',
        audioQa: { score: 0.9 },
      },
    });
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.segments.json`), { durationSec: 20, modelKey: 'm-b', synthesizedAt: 'T-B' });

    await fsck.fsckAllBooks();

    const ch = chapterOf(b);
    const live = readJson(join(b.audio, `${SLUG}.segments.json`));
    expect(ch.audioRenderedAt).toBe('T-B');
    expect(ch.duration).toBe(take.deriveTakeFields({ durationSec: 20 }).duration);
    expect(ch.audioModelKey).toBe('m-b');
    expect('audioQa' in ch).toBe(false);
    expect(ch.audioTakeId).toBe(live.takeId);
  });

  it('I3: a healthy chapter whose segments carry an id gains only audioTakeId; a raw-key audioModelKey and audioQa are untouched (M1 turns this red)', async () => {
    const b = seedBook({
      chapter: {
        audioRenderedAt: 'T-live',
        duration: '00:12',
        audioModelKey: 'raw-key-from-old-heal',
        audioEngines: { kokoro: 1 },
        audioQa: { score: 0.5 },
      },
    });
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    /* The segments already carry an id that state.json lacks (the mirror repairs it, and
       writes nothing else) and derive a DIFFERENT effective model key than the raw one the old heal stamped: a full
       re-stamp would rewrite audioModelKey and audioQa; the fill-only pass leaves both. */
    writeJson(join(b.audio, `${SLUG}.segments.json`), {
      durationSec: 12,
      modelKey: 'raw-key-from-old-heal',
      synthesizedAt: 'T-live',
      qa: { score: 0.1 },
      takeId: take.mintTakeId(),
      characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
    });
    const before = chapterOf(b);
    const liveId = readJson(join(b.audio, `${SLUG}.segments.json`)).takeId;
    expect(take.deriveTakeFields(readJson(join(b.audio, `${SLUG}.segments.json`))).audioModelKey).not.toBe(
      'raw-key-from-old-heal',
    );

    await fsck.fsckAllBooks();

    expect(chapterOf(b)).toEqual({ ...before, audioTakeId: liveId });
  });

  it('the orphan-promote shape: the live segments carry an id state.json lacks, and three boots mirror it (and only it)', async () => {
    const b = seedBook({ chapter: { duration: '0:12', audioRenderedAt: 'T-A', audioModelKey: 'kokoro-v1' } });
    writeJson(join(b.audio, `${SLUG}.segments.json`), { durationSec: 20, synthesizedAt: 'T-B', modelKey: 'qwen3-0.6b' });
    writeFileSync(join(b.audio, `${SLUG}.previous.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.previous.segments.json`), { durationSec: 12, synthesizedAt: 'T-A', modelKey: 'kokoro-v1' });
    const before = chapterOf(b);

    await fsck.fsckAllBooks();
    await fsck.fsckAllBooks();
    await fsck.fsckAllBooks();

    const liveId = readJson(join(b.audio, `${SLUG}.segments.json`)).takeId;
    expect(take.isTakeId(liveId)).toBe(true);
    expect(chapterOf(b)).toEqual({ ...before, audioTakeId: liveId });
  });

  it('a state.json audioTakeId that disagrees with the live segments is overwritten by the next boot', async () => {
    const b = seedBook({ chapter: { duration: '0:12', audioRenderedAt: 'T-A', audioTakeId: take.mintTakeId() } });
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    const liveId = take.mintTakeId();
    writeJson(join(b.audio, `${SLUG}.segments.json`), { durationSec: 12, synthesizedAt: 'T-A', takeId: liveId });

    await fsck.fsckAllBooks();

    expect(chapterOf(b).audioTakeId).toBe(liveId);
  });

  it('I3: a LEGACY chapter (no takeId yet) with a raw-key audioModelKey gains only audioTakeId on the first boot', async () => {
    const b = seedBook({
      chapter: {
        audioRenderedAt: 'T-live',
        duration: '00:12',
        audioModelKey: 'raw-key-from-old-heal',
        audioEngines: { kokoro: 1 },
        audioQa: { score: 0.5 },
      },
    });
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    /* No takeId: the real legacy population, so the identity mirror DOES run. The
       segments derive a different effective key than the raw one in state. */
    writeJson(join(b.audio, `${SLUG}.segments.json`), {
      durationSec: 12,
      modelKey: 'raw-key-from-old-heal',
      synthesizedAt: 'T-live',
      qa: { score: 0.1 },
      characterSnapshots: { narrator: { voiceEngine: 'kokoro' } },
    });
    const before = chapterOf(b);
    expect(take.deriveTakeFields(readJson(join(b.audio, `${SLUG}.segments.json`))).audioModelKey).not.toBe(
      'raw-key-from-old-heal',
    );

    await fsck.fsckAllBooks();

    const live = readJson(join(b.audio, `${SLUG}.segments.json`));
    expect(take.isTakeId(live.takeId)).toBe(true);
    expect(chapterOf(b).audioModelKey).toBe('raw-key-from-old-heal');
    expect(chapterOf(b)).toEqual({ ...before, audioTakeId: live.takeId });
  });

  it('I3: a legacy healthy chapter (no id) gains only audioTakeId when its state already matches the take', async () => {
    const b = seedBook({
      chapter: { audioRenderedAt: 'T-live', duration: '00:12', audioModelKey: 'm-live', audioQa: { score: 0.5 } },
    });
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.segments.json`), {
      durationSec: 12,
      modelKey: 'm-live',
      synthesizedAt: 'T-live',
      qa: { score: 0.5 },
    });
    const before = chapterOf(b);

    await fsck.fsckAllBooks();

    const live = readJson(join(b.audio, `${SLUG}.segments.json`));
    expect(chapterOf(b)).toEqual({ ...before, audioTakeId: live.takeId });
  });

  it('I9: orphan live segments (finalize died at its audio rename): state.json stays at the take the fsck promotes, not the unrenamed segments', async () => {
    const b = seedBook({
      chapter: { audioRenderedAt: 'T-A', duration: '0:12', audioModelKey: 'm-a', audioQa: { score: 0.9 } },
    });
    /* No live audio: preserve ran and the new segments (B) were written, then the rename threw. */
    writeJson(join(b.audio, `${SLUG}.segments.json`), { durationSec: 20, modelKey: 'm-b', synthesizedAt: 'T-B' });
    writeFileSync(join(b.audio, `${SLUG}.previous.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.previous.segments.json`), { durationSec: 12, modelKey: 'm-a', synthesizedAt: 'T-A' });
    const before = chapterOf(b);

    await fsck.fsckAllBooks();

    expect(readJson(join(b.audio, `${SLUG}.segments.json`)).synthesizedAt).toBe('T-A');
    expect(chapterOf(b)).toEqual(before);
  });

  it('I7: logs the .orphaned/ file count and total bytes for a book that has the folder', async () => {
    const b = seedBook();
    mkdirSync(join(b.audio, '.orphaned', 'ev1'), { recursive: true });
    writeFileSync(join(b.audio, '.orphaned', 'ev1', 'a.mp3'), Buffer.alloc(5));
    writeFileSync(join(b.audio, '.orphaned', 'ev1', 'b.json'), Buffer.alloc(3));
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await fsck.fsckAllBooks();

    const lines = log.mock.calls.map((c) => String(c[0]));
    expect(lines.some((l) => l.includes('.orphaned/') && l.includes('2 file(s)') && l.includes('8 bytes'))).toBe(true);
  });

  it('I7: logs nothing about .orphaned/ for a book without the folder', async () => {
    seedBook();
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    await fsck.fsckAllBooks();
    expect(log.mock.calls.some((c) => String(c[0]).includes('.orphaned/'))).toBe(false);
  });

  it('I8: a second boot changes no file (state.json and every audio file byte-identical)', async () => {
    const b = seedBook({ chapter: { audioRenderedAt: 'T-A', duration: '00:10' } });
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.segments.json`), { durationSec: 20, synthesizedAt: 'T-B' });
    writeFileSync(join(b.audio, `${SLUG}.previous.mp3`), MP3);
    writeJson(join(b.audio, `${SLUG}.previous.segments.json`), { durationSec: 9 });

    await fsck.fsckAllBooks();
    const afterFirst = snapshot(b);
    await fsck.fsckAllBooks();

    expect(snapshot(b)).toEqual(afterFirst);
  });

  it('a slug whose reconcile throws is logged and the fsck still resolves', async () => {
    const b = seedBook();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(join(b.audio, `${SLUG}.mp3`), MP3);
    writeFileSync(join(b.audio, `${SLUG}.segments.json`), '{ not json');
    await expect(fsck.fsckAllBooks()).resolves.toBeDefined();
    expect(spy).toHaveBeenCalled();
  });
});
