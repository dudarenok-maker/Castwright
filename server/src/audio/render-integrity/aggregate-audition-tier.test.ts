/* Regression: the Option-B audition centroid (srv-36 Task 10) must render the
   character's consistency audition under the SAME tier the chapter's audio was
   ACTUALLY rendered in — read from the stamped segments.json `modelKey` — NOT a
   hardcoded 'qwen3-tts-0.6b' placeholder.

   The old code did `canonicalModelKeyForEngine(engine, 'qwen3-tts-0.6b')`. For
   Qwen that helper returns the request key verbatim, so EVERY too-thin/bimodal
   Qwen character's audition rendered 12× on the 0.6B base — co-resident with a
   1.7B render (8GB-card OOM) AND embedded under a model whose speaker space is
   not comparable to the 1.7B-rendered anchors (a corrupt centroid). */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Capture the AuditionCharacter passed into auditionCentroid without touching a
// sidecar. importOriginal keeps CENTROID_K etc. intact; only the fn is swapped.
const { auditionSpy } = vi.hoisted(() => ({
  auditionSpy: vi.fn(async (_character: { modelKey: string }) => null),
}));
vi.mock('./audition-centroid.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./audition-centroid.js')>()),
  auditionCentroid: auditionSpy,
}));

import { scoreBook } from './aggregate.js';
import { writeEmbeddings, EMBEDDINGS_VERSION } from './embeddings-io.js';

// A 2-d unit vector at angle θ, padded to length 8 (matches aggregate.test.ts).
const vec = (θ: number) => Float32Array.from([Math.cos(θ), Math.sin(θ), 0, 0, 0, 0, 0, 0]);

describe('scoreBook — audition renders under the chapter render tier, not a hardcoded 0.6B', () => {
  beforeEach(() => auditionSpy.mockClear());

  it('passes the segments.json render tier (1.7B) as the audition modelKey', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-audition-tier-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      characterId: 'thurid',
      sentenceIds: [i],
      vec: vec(0.02 * i),
    }));
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-1.7b', // finalize-chapter-write stamps the render tier
        segments: rows.map((r) => ({
          characterId: 'thurid',
          sentenceIds: r.sentenceIds,
          renderedFallbackEngine: null,
        })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
      }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const arg = auditionSpy.mock.calls[0][0] as unknown as { modelKey: string };
    expect(arg.modelKey).toBe('qwen3-tts-1.7b');
  });

  it('THE FIX: per-character snapshot tier wins over a non-Qwen chapter run-default (mixed-engine book)', async () => {
    // Mixed-engine book: the chapter's run-default is a Kokoro key, but Thurid
    // (a per-character Qwen 1.7B override) rendered on 1.7B. Using the chapter
    // top-level 'kokoro-v1' would collapse to 0.6B for Qwen (the OOM). The
    // per-character snapshot modelKey must win.
    const dir = mkdtempSync(join(tmpdir(), 'spk-audition-perchar-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      characterId: 'thurid',
      sentenceIds: [i],
      vec: vec(0.02 * i),
    }));
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'kokoro-v1', // chapter run-default is a non-Qwen engine
        segments: rows.map((r) => ({
          characterId: 'thurid',
          sentenceIds: r.sentenceIds,
          renderedFallbackEngine: null,
        })),
        characterSnapshots: {
          thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid', modelKey: 'qwen3-tts-1.7b' },
        },
      }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const arg = auditionSpy.mock.calls[0][0] as unknown as { modelKey: string };
    expect(arg.modelKey).toBe('qwen3-tts-1.7b');
  });

  it('falls back to 0.6B only for a legacy segments file with no stamped modelKey', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-audition-legacy-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      characterId: 'thurid',
      sentenceIds: [i],
      vec: vec(0.02 * i),
    }));
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        // no modelKey — a render that predates the stamp
        segments: rows.map((r) => ({
          characterId: 'thurid',
          sentenceIds: r.sentenceIds,
          renderedFallbackEngine: null,
        })),
        characterSnapshots: { thurid: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-thurid' } },
      }),
    );

    await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);

    expect(auditionSpy).toHaveBeenCalledTimes(1);
    const arg = auditionSpy.mock.calls[0][0] as unknown as { modelKey: string };
    expect(arg.modelKey).toBe('qwen3-tts-0.6b');
  });
});

describe('scoreBook — returns the render tiers used (reconcile without re-reading segments)', () => {
  async function writeChapter(dir: string, slug: string, chapterId: number, modelKey: string): Promise<void> {
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      characterId: 'x',
      sentenceIds: [i],
      vec: vec(0.02 * i),
    }));
    await writeEmbeddings(join(dir, 'audio', `${slug}.embeddings.json`), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', `${slug}.segments.json`),
      JSON.stringify({
        chapterId,
        modelKey,
        segments: rows.map((r) => ({ characterId: 'x', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
        characterSnapshots: { x: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-x', modelKey } },
      }),
    );
  }

  it('reports keep17 only for a pure-1.7B book (so reconcile evicts a stray 0.6B)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-tiers-17-'));
    await writeChapter(dir, 'ch1', 1, 'qwen3-tts-1.7b');
    const keep = await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    expect(keep).toEqual({ keep06: false, keep17: true });
  });

  it('keeps BOTH tiers for a genuinely mixed-tier book', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'spk-tiers-mixed-'));
    await writeChapter(dir, 'ch1', 1, 'qwen3-tts-0.6b');
    await writeChapter(dir, 'ch2', 2, 'qwen3-tts-1.7b');
    const keep = await scoreBook(dir, [
      { id: 1, slug: 'ch1' },
      { id: 2, slug: 'ch2' },
    ]);
    expect(keep).toEqual({ keep06: true, keep17: true });
  });

  it('flags an ELEVATED per-character tier even when the chapter run-default is lower', async () => {
    // Run default 0.6B, but a per-character 1.7B pin → that char rendered on 1.7B.
    // keep17 MUST be true or the post-scoring reconcile evicts a warm in-use tier.
    const dir = mkdtempSync(join(tmpdir(), 'spk-tiers-elevated-'));
    mkdirSync(join(dir, 'audio'), { recursive: true });
    const rows = Array.from({ length: 3 }, (_, i) => ({
      characterId: 'x',
      sentenceIds: [i],
      vec: vec(0.02 * i),
    }));
    await writeEmbeddings(join(dir, 'audio', 'ch1.embeddings.json'), rows, EMBEDDINGS_VERSION);
    writeFileSync(
      join(dir, 'audio', 'ch1.segments.json'),
      JSON.stringify({
        chapterId: 1,
        modelKey: 'qwen3-tts-0.6b', // run default
        segments: rows.map((r) => ({ characterId: 'x', sentenceIds: r.sentenceIds, renderedFallbackEngine: null })),
        characterSnapshots: {
          x: { voiceEngine: 'qwen', resolvedVoiceName: 'qwen-x', modelKey: 'qwen3-tts-1.7b' }, // elevated
        },
      }),
    );
    const keep = await scoreBook(dir, [{ id: 1, slug: 'ch1' }]);
    expect(keep).toEqual({ keep06: false, keep17: true });
  });
});
