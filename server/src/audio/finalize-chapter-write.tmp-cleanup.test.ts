/* #4167 — finalizeChapterAudioWrite must remove its `<slug>.<ext>.tmp-<pid>-<ts>`
   temp audio file when anything between the temp write and the rename throws,
   best-effort, never masking the original error. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { EmbeddingRow } from './render-integrity/embeddings-io.js';

const failEmbeddingsWrite = { on: false };
const failRm = { on: false };
const failRename = { on: false };

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

vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...real,
    rm: vi.fn(async (...args: Parameters<typeof real.rm>) => {
      if (failRm.on && String(args[0]).includes('.tmp-')) throw new Error('EPERM: injected rm failure');
      return real.rm(...args);
    }),
    rename: vi.fn(async (...args: Parameters<typeof real.rename>) => {
      if (failRename.on && String(args[0]).includes('.tmp-')) throw new Error('EPERM: injected rename failure');
      return real.rename(...args);
    }),
  };
});

const AUTHOR = 'Tmp Author';
const SERIES = 'Standalones';
const TITLE = 'Tmp Story';
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
  failRm.on = false;
  failRename.on = false;
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-tmp-cleanup-test-'));
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


const leftovers = () => readdirSync(audioRoot).filter((f) => f.includes('.tmp-'));

function baseInput() {
  const segs = Array.from({ length: 3 }, (_, i) => ({
    groupIndex: i,
    characterId: 'mairin',
    sentenceIds: [i],
    startSec: i,
    endSec: i + 1,
    voiceName: 'v-old',
  }));
  const rows: EmbeddingRow[] = segs.map((s, i) => ({ characterId: 'mairin', sentenceIds: s.sentenceIds, vec: vec(0.1 * i) }));
  return {
    bookId,
    bookDir,
    chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
    pcm: tone(3.0, 12000),
    sampleRate: SR,
    durationSec: 3.0,
    segments: segs,
    cast: [{ id: 'mairin', name: 'Mairin', gender: 'female' as const, attributes: [] }],
    castIdHistory: { schema: 1, supersededBy: {} } as const,
    defaultEngine: 'kokoro' as const,
    modelKey: 'kokoro-v1' as const,
    audioFormat: 'mp3' as const,
    resynthesizedIndices: 'all' as const,
    embeddings: rows,
  };
}

describe('finalizeChapterAudioWrite temp audio cleanup (#4167)', () => {
  it('T1: a throw after the temp write leaves no .tmp- file and no finalized audio', async () => {
    const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
    failEmbeddingsWrite.on = true;
    await expect(finalizeChapterAudioWrite(baseInput())).rejects.toThrow(/injected embeddings write failure/);
    expect(leftovers()).toEqual([]);
    expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(false);
  });

  it('T2: a failing cleanup never masks the original error and is warned about', async () => {
    const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    failEmbeddingsWrite.on = true;
    failRm.on = true;
    try {
      let caught: Error | undefined;
      try {
        await finalizeChapterAudioWrite(baseInput());
      } catch (e) {
        caught = e as Error;
      }
      expect(caught).toBeDefined();
      expect(caught!.message).toMatch(/injected embeddings write failure/);
      expect(caught!.message).not.toContain('injected rm failure');
      expect(warn.mock.calls.some((c) => String(c[0]).includes(SLUG) && String(c[0]).includes('injected rm failure'))).toBe(true);
      failRm.on = false;
      expect(leftovers().length).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it('T3: success path is unchanged: live audio exists, no leftovers, result shape intact', async () => {
    const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
    const result = await finalizeChapterAudioWrite(baseInput());
    expect(existsSync(join(audioRoot, `${SLUG}.mp3`))).toBe(true);
    expect(leftovers()).toEqual([]);
    expect(result.segmentCount).toBe(3);
    expect(result.durationSec).toBeGreaterThan(0);
    expect(result).toHaveProperty('audioQa');
    expect(result).toHaveProperty('audioModelKey');
    expect(result).toHaveProperty('audioEngines');
  });

  it('T4: a failing rename also removes the temp file', async () => {
    const { finalizeChapterAudioWrite } = await import('./finalize-chapter-write.js');
    failRename.on = true;
    await expect(finalizeChapterAudioWrite(baseInput())).rejects.toThrow(/injected rename failure/);
    expect(leftovers()).toEqual([]);
  });
});
