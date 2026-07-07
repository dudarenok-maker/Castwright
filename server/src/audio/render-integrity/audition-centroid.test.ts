/**
 * srv-36 Task 10 — audition-centroid tests (redesigned per
 * docs/superpowers/specs/2026-07-07-srv36-audition-centroid-reference-design.md).
 *
 * All network calls are replaced via injected synthFn + embedFn so the sidecar
 * is never required.
 */

import { describe, it, expect } from 'vitest';
import {
  auditionCentroid,
  AUDITION_POOL_TARGET_N,
  AUDITION_POOL_MARGIN,
} from './audition-centroid.js';
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

/** Minimal character fixture — no evidence, so buildSampleText's canned
 *  fallback line is the only text available. */
const CHARACTER: AuditionCharacter = {
  voiceName: 'af_sarah',
  modelKey: 'coqui-xtts-v2' as TtsModelKey,
  voice: { id: 'hero', character: 'Hero', attributes: ['brave'] },
};

/** Character with 3 distinct evidence quotes (for retry + cycling tests). */
const CHARACTER_WITH_EVIDENCE: AuditionCharacter = {
  ...CHARACTER,
  hint: {
    evidence: [
      'A second evidence quote that is definitely longer and used as the primary text here.',
      'A fairly long second line from the manuscript for the retry extension.',
      'Short one.',
    ],
  },
};

// A unit vector in a given axis direction, dim=8, with tiny deterministic jitter
// on the next axis over so a cluster isn't a single repeated point. Mirrors the
// proven bimodal fixture in centroid.test.ts (orthogonal directions reliably
// clear BIMODAL_GAP_THRESHOLD regardless of pool size).
function axisVec(axis: number, i: number, dim = 8): Float32Array {
  const dir = new Array(dim).fill(0);
  dir[axis] = 1;
  dir[(axis + 1) % dim] = (i % 3) * 0.005;
  let norm = 0;
  for (const v of dir) norm += v * v;
  norm = Math.sqrt(norm);
  return Float32Array.from(dir.map((v) => v / norm));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('auditionCentroid', () => {
  it('exports the target/margin constants at their spec\'d values', () => {
    expect(AUDITION_POOL_TARGET_N).toBe(6);
    expect(AUDITION_POOL_MARGIN).toBe(2);
  });

  it('zero anchors, all renders succeed → stops early at exactly targetN synth calls', async () => {
    const synthCalls: string[] = [];
    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCalls.push(input.text);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let callIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, callIdx++);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 3, margin: 1 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // Stops as soon as the pool reaches target — doesn't burn the margin
    // when nothing fails the floor.
    expect(synthCalls.length).toBe(3);
    expect(result!.embeddings.length).toBe(3);
  });

  it('zero anchors, one under-floor render with no evidence (no retry) → margin absorbs it, still reaches target', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      const isFirst = callIdx === 0;
      callIdx++;
      return makeSynthOut(isFirst ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 3, margin: 1 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // Slot 0 fails the floor (no evidence → no retry), slots 1-3 succeed:
    // 4 synth calls total, using the full deficit(3)+margin(1) budget.
    expect(callIdx).toBe(4);
    expect(result!.embeddings.length).toBe(3);
  });

  it('zero anchors, budget exhausted before reaching target → too-short', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      // First 2 of 4 attempts fail the floor; only 2 succeed — short of target(3).
      const isBelow = callIdx < 2;
      callIdx++;
      return makeSynthOut(isBelow ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 3, margin: 1 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    expect(callIdx).toBe(4); // budget (deficit 3 + margin 1) fully consumed
  });

  it('anchors alone already meet target → zero new renders', async () => {
    const synthCalls: number[] = [];
    const synthFn = async (): Promise<SynthesizeOutput> => {
      synthCalls.push(1);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const existingAnchors = [axisVec(0, 0), axisVec(0, 1), axisVec(0, 2)];
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 3,
      margin: 1,
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    expect(synthCalls.length).toBe(0);
    expect(result!.embeddings.length).toBe(3);
  });

  it('partial anchors → tops up only the deficit, not the full margin', async () => {
    const synthCalls: number[] = [];
    const synthFn = async (): Promise<SynthesizeOutput> => {
      synthCalls.push(1);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    const existingAnchors = [axisVec(0, 0)];
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 3,
      margin: 1,
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // deficit = 2 (target 3 - 1 anchor); all succeed → stops at 2, not the
    // deficit+margin=3 ceiling.
    expect(synthCalls.length).toBe(2);
    expect(result!.embeddings.length).toBe(3); // 1 anchor + 2 new
  });

  it('retries an under-floor render by appending the NEXT distinct evidence quote', async () => {
    const synthCallTexts: string[] = [];
    // cleaned quotes are sorted longest-first; slot 0's text is cleaned[0].
    // The retry for slot 0 appends cleaned[1] (the next quote in the cycle).
    const cleaned = [...CHARACTER_WITH_EVIDENCE.hint!.evidence!].sort((a, b) => b.length - a.length);
    const primaryText = cleaned[0];
    const expectedRetryText = `${primaryText} ${cleaned[1]}`;

    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCallTexts.push(input.text);
      return makeSynthOut(input.text === primaryText ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER_WITH_EVIDENCE, {
      synthFn,
      embedFn,
      targetN: 1,
      margin: 0,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    expect(synthCallTexts).toEqual([primaryText, expectedRetryText]);
  });

  it('no retry when there is no evidence at all (canned fallback, cleaned.length===0)', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      return makeSynthOut(BELOW_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 2, margin: 0 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    // No retries attempted — exactly 2 primary calls (targetN + margin=2), not 4.
    expect(callIdx).toBe(2);
  });

  it('no retry when there is exactly one distinct evidence quote (cleaned.length===1)', async () => {
    const oneQuoteCharacter: AuditionCharacter = {
      ...CHARACTER,
      hint: { evidence: ['The only quote this character has.'] },
    };
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      return makeSynthOut(BELOW_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(oneQuoteCharacter, { synthFn, embedFn, targetN: 2, margin: 0 });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    expect(callIdx).toBe(2); // no doubled retry calls
  });

  it('cycles through fewer-than-target distinct evidence quotes', async () => {
    const synthCallTexts: string[] = [];
    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCallTexts.push(input.text);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    await auditionCentroid(CHARACTER_WITH_EVIDENCE, { synthFn, embedFn, targetN: 5, margin: 0 });

    const cleaned = [...CHARACTER_WITH_EVIDENCE.hint!.evidence!].sort((a, b) => b.length - a.length);
    // 5 slots cycling through 3 distinct quotes: q0, q1, q2, q0, q1.
    expect(synthCallTexts).toEqual([cleaned[0], cleaned[1], cleaned[2], cleaned[0], cleaned[1]]);
  });

  it('falls back to the canned buildSampleText line when there is no evidence at all', async () => {
    const synthCallTexts: string[] = [];
    const synthFn = async (input: { text: string }): Promise<SynthesizeOutput> => {
      synthCallTexts.push(input.text);
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 2, margin: 0 });

    expect(synthCallTexts.length).toBe(2);
    expect(synthCallTexts[0]).toBe(synthCallTexts[1]);
    expect(synthCallTexts[0].length).toBeGreaterThan(0);
  });

  it('returns null when synthFn throws (sidecar unavailable)', async () => {
    const synthFn = async (): Promise<SynthesizeOutput> => {
      throw new Error('sidecar down');
    };
    const embedFn = async (): Promise<Float32Array> => axisVec(0, 0);

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn });

    expect(result).toBeNull();
  });

  it('returns null when embedFn throws mid-loop (sidecar unavailable)', async () => {
    const synthFn = async (): Promise<SynthesizeOutput> => makeSynthOut(ABOVE_FLOOR_PCM);
    let embedCallCount = 0;
    const embedFn = async (): Promise<Float32Array> => {
      embedCallCount++;
      if (embedCallCount === 3) throw new Error('sidecar embed unavailable');
      return axisVec(0, embedCallCount);
    };

    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 5, margin: 0 });

    expect(result).toBeNull();
  });

  it('bimodal blend discards anchors and tops up the ALREADY-RENDERED synthetics within the shared 8-render cap (round-2 cost-blowup regression)', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      return makeSynthOut(ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    // Every synthetic render embeds into axis-1's cluster — orthogonal to the
    // axis-0 anchor below, guaranteed to trip BIMODAL_GAP_THRESHOLD. A 1
    // anchor : 3 synthetic split is deliberately ASYMMETRIC — an even split
    // (e.g. 2:2) can leave the weighted centroid equidistant from both
    // clusters, producing near-identical cosines-to-centroid on both sides
    // and no detectable gap. The proven fixture this mirrors (centroid.test.ts,
    // "detects bimodality when two clear clusters are present") is itself
    // asymmetric (12 vs 8) for the same reason.
    const embedFn = async (): Promise<Float32Array> => axisVec(1, embedIdx++);

    const existingAnchors = [axisVec(0, 0)]; // 1 anchor, axis 0
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 4,
      margin: 2, // budget = 6
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('audition');
    // Phase A: deficit=3 (target 4 - 1 anchor), reaches target at 3 synth
    // calls (1 anchor + 3 synthetics = 4 = target). Blend comes back bimodal
    // (1:3 split) → anchor dropped, phase B tops up the 3 already-rendered
    // synthetics with 1 more (3+1=4=target). Total 4 synth calls — well
    // inside the 6-call cap, and the regression invariant: NEVER exceeds
    // targetN+margin.
    expect(callIdx).toBe(4);
    expect(callIdx).toBeLessThanOrEqual(6);
    expect(result!.embeddings.length).toBe(4);
  });

  it('a resulting synthetic-only pool is used as-is with no second bimodal check (documented, pre-existing limitation)', async () => {
    // Same setup as the regression test above — the fallback pool built from
    // ONLY axis-1 synthetics is internally uniform (not bimodal), so this
    // just confirms the call succeeds and returns 'audition' without a
    // second buildCentroid-on-the-fallback bimodal branch to fall into.
    let embedIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => makeSynthOut(ABOVE_FLOOR_PCM);
    const embedFn = async (): Promise<Float32Array> => axisVec(1, embedIdx++);
    const existingAnchors = [axisVec(0, 0)];

    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 4,
      margin: 2,
      existingAnchors,
    });

    expect(result!.kind).toBe('audition');
  });

  it('bimodal fallback that still falls short after exhausting the shared cap → too-short, cap never exceeded (round-3 regression)', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      callIdx++;
      // Calls 1-2 fail the floor (phase A), 3-4 succeed (phase A), 5-7
      // succeed (phase B top-up), call 8 fails (phase B) — leaving the
      // fallback pool 1 short of target once the 8-call cap is hit.
      const isBelow = callIdx <= 2 || callIdx === 8;
      return makeSynthOut(isBelow ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(1, embedIdx++);

    const existingAnchors = [axisVec(0, 0), axisVec(0, 1), axisVec(0, 2), axisVec(0, 3)]; // 4 anchors
    const result = await auditionCentroid(CHARACTER, {
      synthFn,
      embedFn,
      targetN: 6,
      margin: 2, // budget = 8
      existingAnchors,
    });

    expect(result).not.toBeNull();
    expect(result!.kind).toBe('too-short');
    // Exactly the 8-call cap — never exceeded chasing the unreachable target.
    expect(callIdx).toBe(8);
  });

  it('respects targetN/margin overrides — a wider margin absorbs more floor failures before giving up', async () => {
    let callIdx = 0;
    const synthFn = async (): Promise<SynthesizeOutput> => {
      const isFirst = callIdx === 0;
      callIdx++;
      return makeSynthOut(isFirst ? BELOW_FLOOR_PCM : ABOVE_FLOOR_PCM);
    };
    let embedIdx = 0;
    const embedFn = async (): Promise<Float32Array> => axisVec(0, embedIdx++);

    // targetN=2, margin=1: slot 0 fails, slots 1-2 succeed → reaches target
    // using the full deficit(2)+margin(1)=3 budget.
    const result = await auditionCentroid(CHARACTER, { synthFn, embedFn, targetN: 2, margin: 1 });

    expect(result!.kind).toBe('audition');
    expect(callIdx).toBe(3);
  });
});
