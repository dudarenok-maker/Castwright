/* #4225 — each segments-file entry records the model key its own audio was rendered under. A write
   stamps only the segments it re-synthesised; every other segment keeps its stamp (or its absence)
   verbatim. Driven through the real finalizeChapterAudioWrite. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { finalizeChapterAudioWrite } from './finalize-chapter-write.js';
import { castJsonPath, makeBookId } from '../workspace/paths.js';
import type { TtsModelKey } from '../tts/index.js';
import type { ChapterSegment } from '../tts/synthesise-chapter.js';

const T06: TtsModelKey = 'qwen3-tts-0.6b';
const T17: TtsModelKey = 'qwen3-tts-1.7b';
const SR = 8000;
const tone = (sec: number) => {
  const n = Math.round(sec * SR);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 180 * i) / SR)), i * 2);
  return b;
};

/* Castor is pinned to 1.7B; Bram has no pin and rides the run key. */
const CASTOR = { id: 'castor', name: 'Castor', gender: 'male', attributes: [], ttsModelKey: T17, overrideTtsVoices: { qwen: { name: 'Castor voice', libraryUuid: 'cq' } } };
const BRAM = { id: 'bram', name: 'Bram', gender: 'male', attributes: [], overrideTtsVoices: { qwen: { name: 'Bram voice', libraryUuid: 'bq' } } };
const hist = { schema: 1, supersededBy: {} } as never;

let workspaceRoot: string;
let bookDir: string;
let bookId: string;

beforeEach(() => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'segment-tier-stamp-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  bookId = makeBookId('A', 'S', 'T');
  bookDir = join(workspaceRoot, 'books', 'A', 'S', 'T');
  mkdirSync(join(bookDir, 'audio'), { recursive: true });
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
  writeFileSync(join(bookDir, 'manuscript.txt'), 'x');
  writeFileSync(
    join(bookDir, '.audiobook', 'state.json'),
    JSON.stringify({
      bookId, manuscriptId: 'm', title: 'T', author: 'A', series: 'S', seriesPosition: null, isStandalone: true,
      manuscriptFile: 'manuscript.txt', castConfirmed: true,
      chapters: [{ id: 1, title: 'C1', slug: 'ch1', duration: '0:00' }],
      coverGradient: ['#000', '#fff'], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }),
  );
  writeFileSync(castJsonPath(bookDir), JSON.stringify({ characters: [CASTOR, BRAM] }));
});
afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

const readSegments = (): ChapterSegment[] =>
  JSON.parse(readFileSync(join(bookDir, 'audio', 'ch1.segments.json'), 'utf8')).segments;

/** Alternating lines: Castor on even indices, Bram on odd ones. */
const freshSegments = (): ChapterSegment[] =>
  Array.from({ length: 6 }, (_, i) => ({
    groupIndex: i,
    characterId: i % 2 === 0 ? 'castor' : 'bram',
    sentenceIds: [i],
    startSec: i * 0.1,
    endSec: i * 0.1 + 0.1,
    voiceName: i % 2 === 0 ? 'qwen-cq' : 'qwen-bq',
  }));

async function write(
  segments: ChapterSegment[],
  modelKey: TtsModelKey,
  resynthesizedIndices: number[] | 'all',
  cast: unknown[] = [CASTOR, BRAM],
) {
  await finalizeChapterAudioWrite({
    bookId, bookDir, chapter: { id: 1, slug: 'ch1', title: 'C1' }, pcm: tone(0.6), sampleRate: SR, durationSec: 0.6,
    segments, cast: cast as never, castIdHistory: hist, defaultEngine: 'qwen', modelKey,
    audioFormat: 'mp3', resynthesizedIndices,
  });
}

describe('finalizeChapterAudioWrite — per-segment rendered model key (#4225)', () => {
  it("(a) a full write stamps every segment with its own character's snapshot tier", async () => {
    await write(freshSegments(), T06, 'all');
    expect(readSegments().map((s) => s.renderedModelKey)).toEqual([T17, T06, T17, T06, T17, T06]);
  });

  it('(b) a partial write stamps only the re-recorded segment; untouched stamps stay byte-identical', async () => {
    await write(freshSegments(), T06, 'all');
    const before = readSegments();
    expect(before[1].renderedModelKey).toBe(T06);

    await write(readSegments(), T17, [1]);

    const after = readSegments();
    expect(after[1].renderedModelKey).toBe(T17);
    const untouched = (segments: ChapterSegment[]) =>
      segments.filter((_, i) => i !== 1).map((s) => JSON.stringify(s));
    expect(untouched(after)).toEqual(untouched(before));
  });

  it('(c) an untouched legacy segment stays unstamped after a partial write', async () => {
    await write(freshSegments(), T06, 'all');
    const legacy = readSegments().map(({ renderedModelKey: _stamp, ...rest }) => rest);

    await write(legacy, T17, [1]);

    const after = readSegments();
    expect(after[1].renderedModelKey).toBe(T17);
    for (const i of [0, 2, 3, 4, 5]) expect(after[i]).not.toHaveProperty('renderedModelKey');
  });

  it('(d) a fallback-engine segment is never stamped, even when it carries an earlier stamp', async () => {
    const full = freshSegments();
    full[1].renderedFallbackEngine = 'kokoro';
    await write(full, T06, 'all');
    expect(readSegments()[1]).not.toHaveProperty('renderedModelKey');
    expect(readSegments()[3].renderedModelKey).toBe(T06);

    /* A re-record spreads the fresh verdict over the PRIOR segment (splice-chapter.ts), so a take
       that fell back arrives still carrying the old take's stamp. */
    const rerecorded = readSegments();
    rerecorded[3].renderedFallbackEngine = 'kokoro';
    await write(rerecorded, T17, [3]);
    expect(readSegments()[3]).not.toHaveProperty('renderedModelKey');
  });

  it('(e) a re-recorded segment with no snapshot of its own in this write is not stamped from a carried-forward one', async () => {
    await write(freshSegments(), T06, 'all');

    /* Bram has since left the cast: his snapshot is only carried forward for his untouched lines. */
    await write(readSegments(), T17, [1], [CASTOR]);

    const after = readSegments();
    expect(after[1]).not.toHaveProperty('renderedModelKey');
    expect(after[3].renderedModelKey).toBe(T06);
  });
});
