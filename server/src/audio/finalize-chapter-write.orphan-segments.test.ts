/* #4319 review pass 3, H6 — a re-render whose preserve AND install renames both
   fail leaves the NEW `segments.json` beside the OLD live audio, with state.json
   still describing the old take. The boot reconcile must not read that as a
   legacy reject: before step 5 stamps state.json, or step 4 mints and mirrors
   an id, it full-decodes the live audio and compares it with the segments'
   `durationSec` (±0.5 s, the multi-live rule's tolerance). A mismatch means the
   segments do not describe this audio: no stamp, no id, state left as `main`
   leaves it. A genuine legacy reject (the durations match) is still re-stamped.
   Real `finalizeChapterAudioWrite`, real ffmpeg; the rename failure is injected
   (`EXDEV`, non-retryable) so it runs on every OS. */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const failRenames = { on: false };
/* The gate's lock-free `state.json` read: `throw` fails it once (what the reader throws for
   EBUSY / EPERM / EIO); `swap` lets it succeed, then writes `body` over the live segments, a
   finalize's segments write landing between the gate and step 5's locked read. */
const gate = vi.hoisted(() => ({
  mode: 'off' as 'off' | 'throw' | 'swap',
  calls: 0,
  segPath: '',
  body: '',
}));

vi.mock('../workspace/book-op-lock.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../workspace/book-op-lock.js')>();
  return {
    ...orig,
    readBookStateOrThrow: async (dir: string) => {
      if (gate.mode === 'throw') {
        gate.mode = 'off';
        gate.calls += 1;
        throw new orig.BookStateUnreadableError();
      }
      const r = await orig.readBookStateOrThrow(dir);
      if (gate.mode === 'swap') {
        gate.mode = 'off';
        gate.calls += 1;
        writeFileSync(gate.segPath, gate.body);
      }
      return r;
    },
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rename: vi.fn(async (...args: Parameters<typeof real.rename>) => {
      const src = String(args[0]).replace(/\\/g, '/');
      if (failRenames.on && /\/chapter-one\.mp3(\.tmp-.*)?$/.test(src)) {
        throw Object.assign(new Error('EXDEV: injected rename failure'), { code: 'EXDEV' });
      }
      return real.rename(...args);
    }),
  };
});

const AUTHOR = 'H6 Author';
const SERIES = 'Standalones';
const SLUG = 'chapter-one';
const SR = 8_000;

let workspaceRoot: string;
let seq = 0;

function tone(sec: number): Buffer {
  const n = Math.round(sec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) buf.writeInt16LE(Math.round(12000 * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  return buf;
}

beforeAll(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-h6-orphan-segments-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
});

beforeEach(() => {
  failRenames.on = false;
  gate.mode = 'off';
  gate.calls = 0;
});

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.WORKSPACE_DIR;
});

async function seedBook() {
  seq += 1;
  const title = `H6 Story ${seq}`;
  const { makeBookId } = await import('../workspace/paths.js');
  const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
  const bookId = makeBookId(AUTHOR, SERIES, title);
  const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, title);
  const audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: `m_${seq}`,
      title,
      author: AUTHOR,
      series: SERIES,
      seriesPosition: null,
      isStandalone: true,
      manuscriptFile: 'manuscript.txt',
      castConfirmed: true,
      chapters: [{ id: 1, title: 'Chapter 1', slug: SLUG, duration: '0:00' }],
      coverGradient: ['#000', '#fff'],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
  );
  const render = (sec: number) =>
    finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(sec),
      sampleRate: SR,
      durationSec: sec,
      segments: [{ groupIndex: 0, characterId: 'amy', sentenceIds: [1], startSec: 0, endSec: sec }],
      cast: [{ id: 'amy', name: 'Amy', gender: 'female' as const, attributes: [] }],
      castIdHistory: { schema: 1 as const, supersededBy: {} },
      defaultEngine: 'kokoro' as const,
      modelKey: 'kokoro-v1' as const,
      audioFormat: 'mp3' as const,
      resynthesizedIndices: 'all' as const,
    });
  const chapter = () =>
    JSON.parse(readFileSync(join(bookDir, '.audiobook', 'state.json'), 'utf8')).chapters[0] as Record<string, unknown>;
  const segments = () =>
    JSON.parse(readFileSync(join(audioRoot, `${SLUG}.segments.json`), 'utf8')) as Record<string, unknown>;
  return { bookDir, audioRoot, render, chapter, segments };
}

describe('H6: the boot reconcile with orphan segments beside the old live audio', () => {
  it('a failed re-render (preserve and install renames both fail) leaves state.json at the live take, and mints no id from the orphan segments', async () => {
    const fsck = await import('../workspace/fsck-orphan-audio.js');
    const b = await seedBook();

    await b.render(1.0);
    const afterA = b.chapter();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    failRenames.on = true;
    await expect(b.render(2.0)).rejects.toThrow(/EXDEV/);
    failRenames.on = false;
    expect(b.segments().durationSec).toBe(2); // the orphan B segments are live beside A's audio
    expect(b.chapter()).toEqual(afterA); // finalize died before its state write
    const orphanBefore = b.segments();

    await fsck.fsckAllBooks();
    warn.mockRestore();

    expect(b.chapter()).toEqual(afterA); // neither a stamp nor a mirrored id read B into state.json
    expect(b.segments()).toEqual(orphanBefore); // and no id was minted into the orphan segments
  }, 30_000);

  it('the static shape: live A audio, live segments of a different length, state at A: one boot leaves state.json and the segments untouched', async () => {
    const fsck = await import('../workspace/fsck-orphan-audio.js');
    const b = await seedBook();
    await b.render(1.0);
    const afterA = b.chapter();
    const orphan = { durationSec: 20, synthesizedAt: 'T-B', modelKey: 'qwen3-0.6b' };
    writeFileSync(join(b.audioRoot, `${SLUG}.segments.json`), JSON.stringify(orphan));

    await fsck.fsckAllBooks();

    expect(b.chapter()).toEqual(afterA);
    expect(b.segments()).toEqual(orphan); // no id minted into them
  }, 30_000);

  it('a genuine legacy reject (the live audio matches the live segments) is still re-stamped from them', async () => {
    const fsck = await import('../workspace/fsck-orphan-audio.js');
    const { restorePreviousAudio } = await import('../workspace/chapter-take.js');
    const b = await seedBook();

    await b.render(1.0);
    const segA = b.segments();
    await new Promise((r) => setTimeout(r, 20));
    await b.render(2.0);
    const afterB = b.chapter();
    expect(afterB.audioRenderedAt).not.toBe(segA.synthesizedAt);
    // A route-less Reject: A's audio and segments are live again, state.json still names B.
    expect(await restorePreviousAudio(b.audioRoot, SLUG)).toBe('restored');
    expect(b.segments().synthesizedAt).toBe(segA.synthesizedAt);

    await fsck.fsckAllBooks();

    const ch = b.chapter();
    expect(ch.audioRenderedAt).toBe(segA.synthesizedAt);
    expect(ch.duration).not.toBe(afterB.duration);
    expect(ch.audioTakeId).toBe(b.segments().takeId);
  }, 30_000);
});

describe('H6 pass 4: the gate does not fail open', () => {
  /* One book, not `fsckAllBooks`: an injected read failure must hit THIS book's gate, not an
     earlier test's book. */
  async function reconcileOne(bookDir: string) {
    const { withBookOpAtDir } = await import('../workspace/book-op-lock.js');
    const { reconcileSlug } = await import('../workspace/chapter-take.js');
    await withBookOpAtDir(bookDir, (h) => reconcileSlug(h, SLUG));
  }

  /* The static shape of the H6 describe above: state at A (T-A), live A audio, orphan segments of
     another length. Seeded from a real render so the audio decodes. */
  async function staticShape() {
    const b = await seedBook();
    await b.render(1.0);
    const orphan = { durationSec: 20, synthesizedAt: 'T-B', modelKey: 'qwen3-0.6b' };
    writeFileSync(join(b.audioRoot, `${SLUG}.segments.json`), JSON.stringify(orphan));
    return { b, orphan };
  }

  it('an unreadable state.json at the gate leaves state.json and the segments alone', async () => {
    const { b, orphan } = await staticShape();
    const before = b.chapter();
    gate.mode = 'throw';
    await reconcileOne(b.bookDir);
    expect(gate.calls).toBe(1); // the injected failure really hit the gate's read
    expect(b.chapter()).toEqual(before);
    expect(b.segments()).toEqual(orphan);
  }, 30_000);

  it('segments written between the gate and the locked read are not stamped (gate saw a matching take)', async () => {
    const b = await seedBook();
    await b.render(1.0);
    const matching = b.segments();
    const before = b.chapter();
    gate.segPath = join(b.audioRoot, `${SLUG}.segments.json`);
    gate.body = JSON.stringify({ durationSec: 20, synthesizedAt: 'T-B', modelKey: 'qwen3-0.6b' });
    gate.mode = 'swap';
    await reconcileOne(b.bookDir);
    expect(gate.calls).toBe(1);
    expect(matching.synthesizedAt).toBe(before.audioRenderedAt);
    expect(b.chapter()).toEqual(before);
    expect(b.segments()).toEqual(JSON.parse(gate.body)); // and no id was minted into them
  }, 30_000);

  it('segments swapped after the gate VERIFIED a genuine legacy reject are not stamped either', async () => {
    const b = await seedBook();
    await b.render(1.0);
    const statePath = join(b.bookDir, '.audiobook', 'state.json');
    const st = JSON.parse(readFileSync(statePath, 'utf8'));
    st.chapters[0].audioRenderedAt = 'T-OLD'; // state names a take the live segments do not: legacy shape
    writeFileSync(statePath, JSON.stringify(st));
    const before = b.chapter();
    gate.segPath = join(b.audioRoot, `${SLUG}.segments.json`);
    gate.body = JSON.stringify({ durationSec: 1, synthesizedAt: 'T-NEW', modelKey: 'qwen3-0.6b' });
    gate.mode = 'swap';
    await reconcileOne(b.bookDir);
    expect(gate.calls).toBe(1);
    expect(b.chapter()).toEqual(before);
    expect(b.segments()).toEqual(JSON.parse(gate.body));
  }, 30_000);
});
