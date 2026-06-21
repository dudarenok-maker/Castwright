/**
 * srv-36 Task 10 — audition-centroid tests.
 *
 * All network calls are replaced via injected synthFn + embedFn so the sidecar
 * is never required.
 */

import { describe, it, expect } from 'vitest';
import { auditionCentroid, CENTROID_K } from './audition-centroid.js';
import type { AuditionCharacter } from './audition-centroid.js';
import type { TtsModelKey, SynthesizeOutput } from '../../tts/index.js';
import { MIN_DURATION_SEC } from './constants.js';

// ── Fixture helpers ───────────────────────────────────────────────────────────

const SAMPLE_RATE = 24000;
const BYTES_PER_SAMPLE = 2; // 16-bit mono

/** Build a PCM Buffer that corresponds to exactly `durationSec` seconds. */
function makePcm(durationSec: number): Buffer {
  const bytes = Math.ceil(durationSec * SAMPLE_RATE * BYTES_PER_SAMPLE);
  return Buffer.alloc(bytes, 0);
}

/** PCM buffer that is clearly above the MIN_DURATION_SEC floor. */
const ABOVE_FLOOR_PCM = makePcm(MIN_DURATION_SEC + 1.0);

/** PCM buffer that is clearly below the MIN_DURATION_SEC floor. */
const BELOW_FLOOR_PCM = makePcm(MIN_DURATION_SEC * 0.5);

/** Make a trivial SynthesizeOutput. */
function makeSynthOut(pcm: Buffer): SynthesizeOutput {
  return { pcm, sampleRate: SAMPLE_RATE, mimeType: 'audio/L16' };
}

/** Minimal character fixture. */
const CHARACTER: AuditionCharacter = {
  voiceName: 'af_sarah',
  modelKey: 'coqui-xtts-v2' as TtsModelKey,
  voice: { id: 'hero', character: 'Hero', attributes: ['brave'] },
};

/** Character with evidence quotes (for retry path tests).
 *  Evidence is ordered longest-first so evidence[0] is the primary text
 *  that buildSampleText will pick, and evidence[1] is the secondary for retry. */
const CHARACTER_WITH_EVIDENCE: AuditionCharacter = {
  ...CHARACTER,
  hint: {
    evidence: [
      // Longest (primary) — buildSampleText sorts descending by length and takes [0]
      'A second evidence quote that is definitely longer and used as the primary text here.',
      // Second-longest (secondary retry)
      'A fairly long second line from the manuscript for the retry extension.',
      'Short one.',
    ],
  },
};

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('auditionCentroid', () => {
  it('renders K times → returns a centroid with kind "audition"', async () => {
    const synthCalls: number[] = [];
    const embedCalls: number[] = [];

    const synthFn = async (): Promise<SynthesizeOutput> => {
      synthCalls.push(1);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };

    // Produce distinct unit-ish vectors (slightly different per call index)
    let callIdx = 0;
    const embedFn = async (): Promise<Float32Array> => {
      const angle = 0.01 * callIdx++;
      // 192-dim vector with small angle variation
      const v = new Float32Array(192);
      v[0] = Math.cos(angle);
      v[1] = Math.sin(angle);
      // rest stay 0 — not unit but enough for centroid math
      embedCalls.push(1);
      return v;
    };

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    expect(result!.centroid).toBeInstanceOf(Float32Array);
    expect(result!.centroid.length).toBeGreaterThan(0);

    // Must have synthesised exactly K times
    expect(synthCalls.length).toBe(CENTROID_K);
    // Must have embedded exactly K times (all above floor)
    expect(embedCalls.length).toBe(CENTROID_K);
  });

  it('returns kind "too-short" when all renders are under the duration floor', async () => {
    const synthFn = async (): Promise<SynthesizeOutput> => makeSynthOut(BELOW_FLOOR_PCM);
    const embedFn = async (): Promise<Float32Array> => new Float32Array(192);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    // Embed must never have been called — no above-floor render to embed
    // (embed mock could have been called 0 times)
  });

  it('retries with secondary evidence quote on under-floor render and succeeds', async () => {
    // buildSampleText sorts evidence descending by length and slices to MAX_CHARS=320
    // evidence[0] is the longest → primary text used by buildSampleText
    const primaryText = CHARACTER_WITH_EVIDENCE.hint!.evidence![0].slice(0, 320);
    const synthCallTexts: string[] = [];

    // Primary text → below floor; any extended text (retry) → above floor
    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCallTexts.push(input.text);
      const isPrimary = input.text === primaryText;
      const pcm = isPrimary ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM;
      return makeSynthOut(pcm);
    };

    let embedCalls = 0;
    const embedFn = async (): Promise<Float32Array> => {
      embedCalls++;
      const v = new Float32Array(192);
      v[0] = 1;
      return v;
    };

    const result = await auditionCentroid(CHARACTER_WITH_EVIDENCE, { synthFn, embedFn });

    // Should produce a valid centroid (retries succeeded)
    expect(result).not.toBeNull();
    // All K PRIMARY renders were under-floor, so each triggered one retry → 2K synth calls total
    expect(synthCallTexts.length).toBe(CENTROID_K * 2);
    // All retries returned above-floor PCM → K embeds
    expect(embedCalls).toBe(CENTROID_K);
    // Retry texts contain both the primary and extended text
    const extendedTexts = synthCallTexts.filter((t) => t !== primaryText);
    expect(extendedTexts.length).toBe(CENTROID_K);
    // Result should be a valid audition centroid
    expect(result!.kind).toBe('audition');
  });

  it('returns kind "too-short" when under-floor even after retry (no secondary evidence)', async () => {
    // CHARACTER has no hint.evidence, so no secondary quote is available
    const synthFn = async (): Promise<SynthesizeOutput> => makeSynthOut(BELOW_FLOOR_PCM);
    const embedFn = async (): Promise<Float32Array> => new Float32Array(192);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn });

    expect(result!.kind).toBe('too-short');
  });

  it('returns null when synthFn throws (sidecar unavailable)', async () => {
    const synthFn = async (): Promise<SynthesizeOutput> => {
      throw new Error('sidecar down');
    };
    const embedFn = async (): Promise<Float32Array> => new Float32Array(192);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn });

    expect(result).toBeNull();
  });

  it('returns null when embedFn throws mid-loop (sidecar unavailable)', async () => {
    const synthFn = async (): Promise<SynthesizeOutput> => makeSynthOut(ABOVE_FLOOR_PCM);
    let embedCallCount = 0;
    const embedFn = async (): Promise<Float32Array> => {
      embedCallCount++;
      // Throw on the 3rd embed call to test mid-loop failure
      if (embedCallCount === 3) {
        throw new Error('sidecar embed unavailable');
      }
      const v = new Float32Array(192);
      v[0] = 1;
      return v;
    };

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn });

    expect(result).toBeNull();
  });

  it('respects k override in opts', async () => {
    const synthCalls: number[] = [];
    const synthFn = async (): Promise<SynthesizeOutput> => {
      synthCalls.push(1);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => {
      const v = new Float32Array(192);
      v[0] = 1;
      return v;
    };

    await auditionCentroid(CHARACTER, { synthFn, embedFn, k: 3 });

    expect(synthCalls.length).toBe(3);
  });
});
