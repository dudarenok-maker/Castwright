/* #3362 pass-7 🟡2 — the embeddings rewrite in finalizeChapterAudioWrite must
   run BEFORE `preserveExistingAsPrevious` moves the live audio aside. A row
   dropped/replaced ahead of its audio only under-scores; a failure AFTER the
   move (and before the new audio is renamed in) left `<slug>.mp3` missing —
   an unplayable chapter. This file injects a failing `writeEmbeddings` and
   asserts the live pair is untouched. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmbeddingRow } from './render-integrity/embeddings-io.js';

const failEmbeddingsWrite = { on: false };

vi.mock('./render-integrity/embeddings-io.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./render-integrity/embeddings-io.js')>();
  return {
    ...real,
    writeEmbeddings: vi.fn(async (...args: Parameters<typeof real.writeEmbeddings>) => {
      if (failEmbeddingsWrite.on) throw new Error('EPERM: injected embeddings write failure');
      return real.writeEmbeddings(...args);
    }),
  };
});

const AUTHOR = 'Order Author';
const SERIES = 'Standalones';
const TITLE = 'Order Story';
const SLUG = 'chapter-one';
const SR = 8_000;

function tone(durationSec: number, amp: number): Buffer {
  const n = Math.round(durationSec * SR);
  const buf = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i += 1) {
    buf.writeInt16LE(Math.round(amp * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  }
  return buf;
}
const vec = (theta: number) => Float32Array.from([Math.cos(theta), Math.sin(theta), 0, 0, 0, 0, 0, 0]);

let workspaceRoot: string;
let bookDir: string;
let audioRoot: string;
let bookId: string;

beforeEach(async () => {
  failEmbeddingsWrite.on = false;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-emb-order-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  const { makeBookId, castJsonPath } = await import('../workspace/paths.js');
  bookId = makeBookId(AUTHOR, SERIES, TITLE);
  bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
  audioRoot = join(bookDir, 'audio');
  mkdirSync(audioRoot, { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId,
      manuscriptId: 'm_test',
      title: TITLE,
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
  writeFileSync(
    castJsonPath(bookDir),
    JSON.stringify({ characters: [{ id: 'mairin', name: 'Mairin', gender: 'female', attributes: [] }] }),
  );
});

afterEach(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('finalizeChapterAudioWrite embeddings rewrite is ordered before the live-audio move (#3362 pass-7 🟡2)', () => {
  it('a failing embeddings write leaves the live audio + segments untouched (no .previous move, chapter still playable)', async () => {
    const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
    const { writeEmbeddings, EMBEDDINGS_VERSION } = await import('./render-integrity/embeddings-io.js');

    const segs = Array.from({ length: 3 }, (_, i) => ({
      groupIndex: i,
      characterId: 'mairin',
      sentenceIds: [i],
      startSec: i,
      endSec: i + 1,
      voiceName: 'v-old',
    }));
    const base = {
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: tone(3.0, 12000),
      sampleRate: SR,
      durationSec: 3.0,
      cast: [{ id: 'mairin', name: 'Mairin', gender: 'female' as const, attributes: [] }],
      castIdHistory: { schema: 1, supersededBy: {} } as const,
      defaultEngine: 'kokoro' as const,
      modelKey: 'kokoro-v1' as const,
      audioFormat: 'mp3' as const,
    };
    const rows: EmbeddingRow[] = segs.map((s, i) => ({ characterId: 'mairin', sentenceIds: s.sentenceIds, vec: vec(0.1 * i) }));
    await finalizeChapterAudioWrite({ ...base, segments: segs, resynthesizedIndices: 'all', embeddings: rows });

    const mp3Path = join(audioRoot, `${SLUG}.mp3`);
    const segPath = join(audioRoot, `${SLUG}.segments.json`);
    expect(existsSync(mp3Path)).toBe(true);
    const mp3Before = readFileSync(mp3Path);
    const segBefore = readFileSync(segPath, 'utf8');
    const embPath = join(audioRoot, `${SLUG}.embeddings.json`);
    const embBefore = readFileSync(embPath, 'utf8');
    expect(writeEmbeddings).toBeDefined();
    expect(EMBEDDINGS_VERSION).toBeTruthy();

    // Re-record line 1 with a DIFFERENT tone; the embeddings rewrite fails.
    failEmbeddingsWrite.on = true;
    const reRecorded = JSON.parse(segBefore).segments.map((s: { voiceName?: string }, i: number) =>
      i === 1 ? { ...s, voiceName: 'v-new' } : s,
    );
    await expect(
      finalizeChapterAudioWrite({
        ...base,
        pcm: tone(3.0, 3000),
        segments: reRecorded,
        resynthesizedIndices: [1],
        reembeddedRows: [{ characterId: 'mairin', sentenceIds: [1], vec: vec(0.9) }],
      }),
    ).rejects.toThrow(/injected embeddings write failure/);

    // Consistent state: the live pair is exactly what it was, nothing was
    // moved aside, and the (unwritten) embeddings file is unchanged.
    expect(existsSync(mp3Path)).toBe(true);
    expect(readFileSync(mp3Path).equals(mp3Before)).toBe(true);
    expect(readFileSync(segPath, 'utf8')).toBe(segBefore);
    expect(existsSync(join(audioRoot, `${SLUG}.previous.mp3`))).toBe(false);
    expect(existsSync(join(audioRoot, `${SLUG}.previous.segments.json`))).toBe(false);
    expect(readFileSync(embPath, 'utf8')).toBe(embBefore);
  });
});
