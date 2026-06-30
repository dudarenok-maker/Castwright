/* Per-sentence pre-assembly QA. One crafted case per signal: dead/near-silent
   PCM, a long internal silence run (mid-sentence dropout), runaway and
   truncated duration drift, a healthy sentence, plus env-override + null-text
   handling. These pin the classifier on raw int16 mono PCM — no sidecar, no
   ffmpeg; fixtures are synthesised in-memory. */

import { describe, it, expect, afterEach } from 'vitest';
import { evaluateSegmentPcm, DEFAULT_SEGMENT_QA_THRESHOLDS } from './segment-qa.js';

const SR = 24000;

/** A sine tone of `seconds` at `freq` Hz, amplitude `amp` of full scale. */
function tone(seconds: number, amp = 0.3, freq = 200): Buffer {
  const samples = Math.round(seconds * SR);
  const buf = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    const v = Math.sin((2 * Math.PI * freq * i) / SR) * amp * 32767;
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), i * 2);
  }
  return buf;
}

/** `seconds` of digital silence (all-zero samples). */
function silence(seconds: number): Buffer {
  return Buffer.alloc(Math.round(seconds * SR) * 2);
}

/** Text whose 14-chars/sec estimate is ~`seconds`. */
function textForSeconds(seconds: number): string {
  return 'x'.repeat(Math.round(seconds * 14));
}

afterEach(() => {
  delete process.env.SEG_QA_SILENCE_RMS;
  delete process.env.SEG_QA_NOISE_FLOOR;
  delete process.env.SEG_QA_MAX_INTERNAL_SILENCE_SEC;
  delete process.env.SEG_QA_MIN_RATIO;
  delete process.env.SEG_QA_MAX_RATIO;
  delete process.env.SEG_QA_MIN_RUNAWAY_SEC;
});

describe('evaluateSegmentPcm', () => {
  it('passes a healthy sentence (steady audio, length ≈ text) with no reasons', () => {
    const v = evaluateSegmentPcm(tone(3), SR, textForSeconds(3));
    expect(v.status).toBe('ok');
    expect(v.reasons).toHaveLength(0);
    expect(v.durationSec).toBeCloseTo(3, 1);
    expect(v.rms).toBeGreaterThan(0.1);
  });

  it('flags a dead/near-silent generation (all-zero PCM)', () => {
    const v = evaluateSegmentPcm(silence(3), SR, textForSeconds(3));
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /silent|silence/i.test(r))).toBe(true);
    expect(v.rms).toBeLessThan(0.001);
  });

  it('flags a long internal silence run (mid-sentence dropout)', () => {
    // tone, 2s of dead air, tone — overall RMS stays audible so it is NOT
    // flagged near-silent, but the 2s gap exceeds the 1.5s internal-silence cap.
    const pcm = Buffer.concat([tone(1), silence(2), tone(1)]);
    const v = evaluateSegmentPcm(pcm, SR, textForSeconds(4));
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /silence/i.test(r))).toBe(true);
    expect(v.longestSilenceSec).toBeGreaterThan(1.5);
    expect(v.rms).toBeGreaterThan(0.05);
  });

  it('flags a runaway generation (far longer than the text predicts)', () => {
    // ~10s of audio for ~1s of text → ratio ~10, well over the 2.5 cap.
    const v = evaluateSegmentPcm(tone(10), SR, textForSeconds(1));
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /long|runaway/i.test(r))).toBe(true);
  });

  it('flags a truncated generation (far shorter than the text predicts)', () => {
    // ~1s of audio for ~10s of text → ratio ~0.1, under the 0.4 floor.
    const v = evaluateSegmentPcm(tone(1), SR, textForSeconds(10));
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /short|truncat/i.test(r))).toBe(true);
  });

  it('skips the duration check when text is empty (no estimate)', () => {
    const v = evaluateSegmentPcm(tone(3), SR, '   ');
    expect(v.expectedSec).toBeNull();
    expect(v.status).toBe('ok');
  });

  it('honours an env-override that tightens the internal-silence cap', () => {
    const pcm = Buffer.concat([tone(1), silence(1), tone(1)]); // 1.0s gap
    const def = evaluateSegmentPcm(pcm, SR, textForSeconds(3));
    expect(def.status).toBe('ok'); // 1.0s < default 1.5s cap
    process.env.SEG_QA_MAX_INTERNAL_SILENCE_SEC = '0.5';
    const strict = evaluateSegmentPcm(pcm, SR, textForSeconds(3));
    expect(strict.status).toBe('suspect');
    expect(strict.reasons.some((r) => /silence/i.test(r))).toBe(true);
  });

  it('accepts an explicit thresholds argument (overrides env + defaults)', () => {
    const v = evaluateSegmentPcm(tone(10), SR, textForSeconds(1), {
      ...DEFAULT_SEGMENT_QA_THRESHOLDS,
      maxDurationRatio: 20,
    });
    expect(v.status).toBe('ok'); // ratio ~10 now under the 20 cap
  });

  it('A1: does NOT flag a 1.0s render of a one-word line as runaway (RED→GREEN)', () => {
    // "Oh." → 3 chars → expectedSec ≈ 0.21s → ratio ≈ 4.7 > 2.5, but 1.0s is a
    // normal short utterance under the 3s absolute floor. FAILS before A1 (flagged
    // "runaway"), passes after. All 51 real FPs in the Scepter corpus were < 2.5s.
    const v = evaluateSegmentPcm(tone(1.0), SR, 'Oh.');
    expect(v.status).toBe('ok');
    expect(v.reasons).toHaveLength(0);
  });

  it('A1: still flags a genuine runaway — long absolute duration (invariant guard)', () => {
    // 6s of audio for "Oh." is over the ratio cap AND the 3s floor. Green before & after.
    const v = evaluateSegmentPcm(tone(6), SR, 'Oh.');
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /runaway/i.test(r))).toBe(true);
  });

  it('A1: truncation branch is unmoved — a fast short line stays ok (invariant guard)', () => {
    // 0.25s "Oh." → ratio ≈ 1.17, between minRatio(0.4) and maxRatio(2.5): ok before & after.
    const v = evaluateSegmentPcm(tone(0.25), SR, 'Oh.');
    expect(v.status).toBe('ok');
  });

  it('A1: minRunawaySec knob lowers the floor (post-impl wiring check)', () => {
    // NOTE [rev]: green BOTH before and after the impl (pre-A1 there is no floor, so
    // the line flags regardless). It is NOT the regression guard — it only proves the
    // knob is wired once the floor exists. Keep it as a wiring check.
    process.env.SEG_QA_MIN_RUNAWAY_SEC = '0.5';
    const v = evaluateSegmentPcm(tone(1.0), SR, 'Oh.');
    expect(v.reasons.some((r) => /runaway/i.test(r))).toBe(true);
  });
});
