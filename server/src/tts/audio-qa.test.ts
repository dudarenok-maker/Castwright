/* srv-27 — post-synthesis audio QA gate (ADVISORY). One crafted case per
   validator: near-silent, clipped, truncated, runaway, healthy, plus an
   env-override case. The verdict is advisory — the chapter still completes; the
   suspect status just drives a badge — so these tests only pin the classifier,
   not any gating behaviour. */

import { describe, it, expect, afterEach } from 'vitest';
import { evaluateChapterQa, DEFAULT_QA_THRESHOLDS } from './audio-qa.js';

afterEach(() => {
  delete process.env.QA_NEAR_SILENT_LUFS;
  delete process.env.QA_CLIP_TP_DB;
  delete process.env.QA_MIN_DUR_RATIO;
  delete process.env.QA_MAX_DUR_RATIO;
});

describe('evaluateChapterQa', () => {
  it('flags near-silent audio (very low LUFS)', () => {
    const v = evaluateChapterQa({ durationSec: 60, expectedSec: 60, lufs: -55, truePeakDb: -3 });
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /silent/i.test(r))).toBe(true);
  });

  it('flags near-silent audio (-Infinity LUFS = dead silence)', () => {
    const v = evaluateChapterQa({
      durationSec: 60,
      expectedSec: 60,
      lufs: -Infinity,
      truePeakDb: -Infinity,
    });
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /silent/i.test(r))).toBe(true);
  });

  it('flags clipped audio (true peak at/above the clip ceiling)', () => {
    const v = evaluateChapterQa({ durationSec: 60, expectedSec: 60, lufs: -16, truePeakDb: -0.05 });
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /clip/i.test(r))).toBe(true);
  });

  it('flags truncated audio (much shorter than expected)', () => {
    const v = evaluateChapterQa({ durationSec: 10, expectedSec: 60, lufs: -16, truePeakDb: -1.5 });
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /short|truncat/i.test(r))).toBe(true);
  });

  it('flags runaway audio (much longer than expected)', () => {
    const v = evaluateChapterQa({ durationSec: 200, expectedSec: 60, lufs: -16, truePeakDb: -1.5 });
    expect(v.status).toBe('suspect');
    expect(v.reasons.some((r) => /long|runaway/i.test(r))).toBe(true);
  });

  it('passes healthy audio (good LUFS, headroom, duration ≈ expected) with no reasons', () => {
    const v = evaluateChapterQa({ durationSec: 62, expectedSec: 60, lufs: -16, truePeakDb: -1.5 });
    expect(v.status).toBe('ok');
    expect(v.reasons).toHaveLength(0);
    expect(v.measuredLufs).toBe(-16);
    expect(v.truePeakDb).toBe(-1.5);
    expect(v.expectedSec).toBe(60);
    expect(typeof v.checkedAt).toBe('string');
  });

  it('does not run the duration checks when expectedSec is null', () => {
    const v = evaluateChapterQa({ durationSec: 10, expectedSec: null, lufs: -16, truePeakDb: -1.5 });
    expect(v.status).toBe('ok');
    expect(v.reasons).toHaveLength(0);
  });

  it('skips loudness checks when lufs/truePeak are null (loudnorm disabled)', () => {
    const v = evaluateChapterQa({ durationSec: 60, expectedSec: 60, lufs: null, truePeakDb: null });
    expect(v.status).toBe('ok');
    expect(v.measuredLufs).toBeNull();
    expect(v.truePeakDb).toBeNull();
  });

  it('honours env-override thresholds (a stricter near-silent gate flags borderline audio)', () => {
    /* Default near-silent is -40; -30 audio passes by default. Tighten the gate
       to -25 via env and the same -30 audio now flags. */
    const def = evaluateChapterQa({ durationSec: 60, expectedSec: 60, lufs: -30, truePeakDb: -3 });
    expect(def.status).toBe('ok');
    process.env.QA_NEAR_SILENT_LUFS = '-25';
    const strict = evaluateChapterQa({
      durationSec: 60,
      expectedSec: 60,
      lufs: -30,
      truePeakDb: -3,
    });
    expect(strict.status).toBe('suspect');
    expect(strict.reasons.some((r) => /silent/i.test(r))).toBe(true);
  });

  it('accepts explicit thresholds argument (overrides env + defaults)', () => {
    const v = evaluateChapterQa(
      { durationSec: 60, expectedSec: 60, lufs: -16, truePeakDb: -1.5 },
      { ...DEFAULT_QA_THRESHOLDS, minDurationRatio: 0.99 },
    );
    /* 60/60 = 1.0 ratio, above 0.99 floor → ok. */
    expect(v.status).toBe('ok');
  });
});
