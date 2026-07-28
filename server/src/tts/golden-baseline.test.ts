/* Unit coverage for the golden-assembly comparison math (ops-36). Deliberately
   NOT named *.golden.test.ts — this runs in the ordinary `test:server` tier so
   the opt-in golden tier's statistics are proven on every push. */

import { describe, it, expect } from 'vitest';
import {
  rmsEnvelope,
  pcmRms,
  rmsError,
  compareEnvelope,
  selectMode,
  md5,
  dbfs,
  toInt16,
  TOL,
} from './golden-baseline.js';

const SR = 24_000;

/** `n` samples at a constant absolute amplitude (square wave: |x| == amp). */
function constant(n: number, amp: number): Int16Array {
  const out = new Int16Array(n);
  for (let i = 0; i < n; i += 1) out[i] = i % 2 === 0 ? amp : -amp;
  return out;
}

function scaled(x: Int16Array, factor: number): Int16Array {
  const out = new Int16Array(x.length);
  for (let i = 0; i < x.length; i += 1) out[i] = Math.round(x[i] * factor);
  return out;
}

describe('pcmRms', () => {
  it('is 0 for silence and ~1 for full-scale', () => {
    expect(pcmRms(new Int16Array(2400))).toBe(0);
    expect(pcmRms(constant(2400, 32767))).toBeCloseTo(1, 3);
  });
});

describe('dbfs', () => {
  it('maps full scale to 0 dBFS and half scale to about -6 dBFS', () => {
    expect(dbfs(1)).toBeCloseTo(0, 6);
    expect(dbfs(0.5)).toBeCloseTo(-6.02, 2);
  });
});

describe('rmsEnvelope', () => {
  it('emits one window per full windowMs and drops the trailing partial', () => {
    // 2.5 windows of 100ms at 24kHz = 2400 samples/window.
    const env = rmsEnvelope(constant(6000, 16000), SR, 100);
    expect(env).toHaveLength(2);
    expect(env[0]).toBeCloseTo(16000 / 32768, 6);
  });

  it('reports each window independently', () => {
    const x = new Int16Array(4800);
    x.set(constant(2400, 32767), 0);
    // second window left silent
    const env = rmsEnvelope(x, SR, 100);
    expect(env[0]).toBeCloseTo(1, 3);
    expect(env[1]).toBe(0);
  });
});

describe('rmsError', () => {
  it('is 0 for identical input', () => {
    const a = constant(2400, 12000);
    expect(rmsError(a, a)).toBe(0);
  });

  it('is 2.0 for a phase-inverted copy — the case that justifies L4', () => {
    // The envelope is IDENTICAL under inversion; only a sample-wise metric sees it.
    const a = constant(2400, 12000);
    const inverted = scaled(a, -1);
    expect(rmsError(a, inverted)).toBeCloseTo(2, 3);
    expect(rmsEnvelope(a, SR)).toEqual(rmsEnvelope(inverted, SR));
  });

  it('equals the relative gain change for a scaled copy', () => {
    const a = constant(2400, 10000);
    expect(rmsError(a, scaled(a, 0.9))).toBeCloseTo(0.1, 3);
  });

  it('truncates to the shorter input rather than throwing', () => {
    const a = constant(4800, 10000);
    const b = constant(2400, 10000);
    expect(rmsError(a, b)).toBe(0);
  });
});

describe('compareEnvelope', () => {
  const loud = 0.2; // ~-14 dBFS
  const quiet = 0.0004; // ~-68 dBFS, below the -50 dBFS floor

  it('passes identical envelopes and reports the skipped count', () => {
    const base = [loud, loud, quiet, loud];
    const v = compareEnvelope(base, [...base]);
    expect(v.ok).toBe(true);
    expect(v.skipped).toBe(1);
  });

  it('fails a window past the relative tolerance and names where', () => {
    const base = [loud, loud, loud, loud];
    const actual = [loud, loud, loud * 1.15, loud];
    const v = compareEnvelope(base, actual);
    expect(v.ok).toBe(false);
    expect(v.worstIndex).toBe(2);
    expect(v.worstRelDelta).toBeCloseTo(0.15, 3);
    expect(v.worstAtSec).toBeCloseTo(0.2, 6);
  });

  it('passes a window inside the relative tolerance', () => {
    const base = [loud, loud];
    const v = compareEnvelope(base, [loud, loud * 1.05]);
    expect(v.ok).toBe(true);
  });

  it('skips a window quiet on EITHER side, not just the baseline side', () => {
    // A regression that silences a loud window must not escape via the floor.
    const base = [loud, loud];
    const actual = [loud, quiet];
    const v = compareEnvelope(base, actual);
    expect(v.skipped).toBe(1);
    // Skipped, so the huge relative delta at index 1 is NOT reported...
    expect(v.ok).toBe(true);
    // ...which is exactly why the caller asserts the skipped COUNT separately.
    expect(v.loudInQuietIndex).toBe(-1);
  });

  it('flags an artifact injected into a window the baseline recorded as silent', () => {
    /* The skip rule is asymmetric: quiet -> LOUD keeps `skipped` unchanged and
       is skipped by the relative check, so without the absolute ceiling a beep
       or hum in the trailing silence passes L3 — and, on the LOOSE path, every
       other layer too. */
    const beep = 0.1; // ~-20 dBFS
    const v = compareEnvelope([loud, quiet], [loud, beep]);
    expect(v.skipped).toBe(1);
    expect(v.ok).toBe(true); // the RELATIVE check still says nothing
    expect(v.loudInQuietIndex).toBe(1);
    expect(v.loudInQuietDbfs).toBeCloseTo(-20, 0);
  });

  it('tolerates codec silence-reconstruction noise below the audibility ceiling', () => {
    // -55 dBFS in a baseline-silent window: below -45, so not flagged. A
    // cross-build MP3 decode legitimately produces noise at this level.
    const v = compareEnvelope([loud, quiet], [loud, 0.0018]);
    expect(v.loudInQuietIndex).toBe(-1);
  });

  it('detects a time-shifted copy — the envelope moves even when the samples do not', () => {
    // A resampler or padding change shifts content between windows.
    const base = [loud, loud, loud * 0.2, loud];
    const shifted = [loud, loud * 0.2, loud, loud];
    expect(compareEnvelope(base, shifted).ok).toBe(false);
  });
});

describe('selectMode', () => {
  const BANNER = 'ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026';

  it('is TIGHT only for a byte-identical banner', () => {
    expect(selectMode(BANNER, BANNER)).toBe('TIGHT');
  });

  it('is LOOSE for a different build of the SAME version', () => {
    // The whole reason the gate is not MAJOR.MINOR: same 8.1, different LAME.
    expect(selectMode('ffmpeg version 8.1.1-ubuntu Copyright (c) 2000-2026', BANNER)).toBe(
      'LOOSE',
    );
  });

  it('is LOOSE for a different version and when either side is absent', () => {
    expect(selectMode('ffmpeg version 9.0 Copyright (c) 2000-2027', BANNER)).toBe('LOOSE');
    expect(selectMode(null, BANNER)).toBe('LOOSE');
    expect(selectMode(BANNER, null)).toBe('LOOSE');
  });
});

describe('md5', () => {
  it('matches the known digest of the empty buffer', () => {
    expect(md5(Buffer.alloc(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
  });
});

describe('toInt16', () => {
  it('decodes little-endian pairs regardless of the buffer byteOffset', () => {
    // readFileSync returns pooled Buffers whose byteOffset is often odd, which
    // would make `new Int16Array(buf.buffer, buf.byteOffset, …)` throw.
    const pooled = Buffer.alloc(5);
    const view = pooled.subarray(1); // odd byteOffset into the same ArrayBuffer
    view.writeInt16LE(-2, 0);
    view.writeInt16LE(300, 2);
    expect(Array.from(toInt16(view))).toEqual([-2, 300]);
  });
});

describe('TOL', () => {
  it('carries the spec-derived constants', () => {
    expect(TOL.firstPassLu).toBe(0.1);
    expect(TOL.sidecarLu).toBe(0.3);
    expect(TOL.envelopeRel).toBe(0.1);
    expect(TOL.quietFloorDbfs).toBe(-50);
    expect(TOL.rmseLoose).toBe(0.16);
    expect(TOL.windowMs).toBe(100);
  });
});
