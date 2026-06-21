/* srv-36 — unit tests for the inline SPK embed pass.
   Tests the pure `collectGroupEmbeddings` helper rather than the full
   `synthesiseChapter` pipeline (which requires a live TTS provider). */

import { describe, it, expect, vi } from 'vitest';
import { collectGroupEmbeddings, type SentenceGroup } from './synthesise-chapter.js';

/** Build a minimal SentenceGroup fixture. */
function makeGroup(index: number, characterId: string, sentenceIds: number[]): SentenceGroup {
  return { index, characterId, sentenceIds, text: 'Hello.' };
}

/** Build a PCM Buffer whose byte-length corresponds to exactly `durationSec`
    of 16-bit mono at the given sampleRate. */
function makePcm(durationSec: number, sampleRate = 24000): Buffer {
  // 2 bytes per sample × sampleRate samples/sec × durationSec
  const byteLen = Math.round(durationSec * sampleRate * 2);
  return Buffer.alloc(byteLen);
}

describe('collectGroupEmbeddings', () => {
  it('includes Qwen groups that meet the duration floor', async () => {
    const groups: SentenceGroup[] = [
      makeGroup(0, 'hero', [1, 2]),
    ];
    const sampleRate = 24000;
    const results = [{ pcm: makePcm(4.0, sampleRate), sampleRate }];
    const embedFn = vi.fn().mockResolvedValue(Float32Array.from(Array(192).fill(0.5)));
    const resolvedEngineFor = vi.fn().mockReturnValue('qwen');

    const rows = await collectGroupEmbeddings(groups, results, resolvedEngineFor, embedFn);

    expect(rows).toHaveLength(1);
    expect(rows[0].characterId).toBe('hero');
    expect(rows[0].sentenceIds).toEqual([1, 2]);
    expect(rows[0].vec).toHaveLength(192);
    expect(embedFn).toHaveBeenCalledWith(results[0].pcm, sampleRate);
  });

  it('includes Coqui groups that meet the duration floor', async () => {
    const groups: SentenceGroup[] = [
      makeGroup(0, 'narrator', [10]),
    ];
    const sampleRate = 22050;
    const results = [{ pcm: makePcm(5.0, sampleRate), sampleRate }];
    const embedFn = vi.fn().mockResolvedValue(Float32Array.from(Array(192).fill(0.1)));
    const resolvedEngineFor = vi.fn().mockReturnValue('coqui');

    const rows = await collectGroupEmbeddings(groups, results, resolvedEngineFor, embedFn);

    expect(rows).toHaveLength(1);
    expect(embedFn).toHaveBeenCalledWith(results[0].pcm, sampleRate);
  });

  it('skips Kokoro groups (deterministic engine — stochastic-only filter)', async () => {
    const groups: SentenceGroup[] = [
      makeGroup(0, 'kokoro-char', [5]),
    ];
    const results = [{ pcm: makePcm(4.0, 24000), sampleRate: 24000 }];
    const embedFn = vi.fn();
    const resolvedEngineFor = vi.fn().mockReturnValue('kokoro');

    const rows = await collectGroupEmbeddings(groups, results, resolvedEngineFor, embedFn);

    expect(rows).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('skips groups below the 3-second duration floor', async () => {
    const groups: SentenceGroup[] = [
      makeGroup(0, 'hero', [1]),
    ];
    const sampleRate = 24000;
    // 2.9 seconds — just under the 3.0 s floor
    const results = [{ pcm: makePcm(2.9, sampleRate), sampleRate }];
    const embedFn = vi.fn();
    const resolvedEngineFor = vi.fn().mockReturnValue('qwen');

    const rows = await collectGroupEmbeddings(groups, results, resolvedEngineFor, embedFn);

    expect(rows).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('passes the per-group sampleRate (not a chapter-wide anchor) to embedFn', async () => {
    const qwenSampleRate = 24000;
    const kokoroSampleRate = 22050;
    const groups: SentenceGroup[] = [
      makeGroup(0, 'qwen-char', [1]),
      makeGroup(1, 'kokoro-char', [2]),
    ];
    const results = [
      { pcm: makePcm(4.0, qwenSampleRate), sampleRate: qwenSampleRate },
      { pcm: makePcm(4.0, kokoroSampleRate), sampleRate: kokoroSampleRate },
    ];
    const embedFn = vi.fn().mockResolvedValue(Float32Array.from(Array(192).fill(0.0)));
    const resolvedEngineFor = vi.fn().mockImplementation((index: number) =>
      index === 0 ? 'qwen' : 'kokoro',
    );

    const rows = await collectGroupEmbeddings(groups, results, resolvedEngineFor, embedFn);

    // Only the Qwen group produces a row
    expect(rows).toHaveLength(1);
    expect(rows[0].characterId).toBe('qwen-char');
    // embedFn called with the Qwen group's own sampleRate
    expect(embedFn).toHaveBeenCalledTimes(1);
    expect(embedFn).toHaveBeenCalledWith(results[0].pcm, qwenSampleRate);
  });

  it('skips groups with no result (synthesis hole)', async () => {
    const groups: SentenceGroup[] = [
      makeGroup(0, 'hero', [1]),
    ];
    const results = [undefined]; // hole
    const embedFn = vi.fn();
    const resolvedEngineFor = vi.fn().mockReturnValue('qwen');

    const rows = await collectGroupEmbeddings(groups, results, resolvedEngineFor, embedFn);

    expect(rows).toHaveLength(0);
    expect(embedFn).not.toHaveBeenCalled();
  });

  it('handles mixed Qwen + Kokoro groups: only Qwen gets an embedding row', async () => {
    const sampleRate = 24000;
    const groups: SentenceGroup[] = [
      makeGroup(0, 'qwen-char', [1]),
      makeGroup(1, 'kokoro-char', [2]),
      makeGroup(2, 'qwen-char', [3]),
    ];
    const results = [
      { pcm: makePcm(4.0, sampleRate), sampleRate },
      { pcm: makePcm(4.0, sampleRate), sampleRate },
      { pcm: makePcm(4.0, sampleRate), sampleRate },
    ];
    const embedFn = vi.fn().mockResolvedValue(Float32Array.from(Array(192).fill(0.0)));
    const resolvedEngineFor = vi.fn().mockImplementation((index: number) =>
      index === 1 ? 'kokoro' : 'qwen',
    );

    const rows = await collectGroupEmbeddings(groups, results, resolvedEngineFor, embedFn);

    expect(rows).toHaveLength(2);
    expect(rows[0].sentenceIds).toEqual([1]);
    expect(rows[1].sentenceIds).toEqual([3]);
    expect(embedFn).toHaveBeenCalledTimes(2);
  });
});
