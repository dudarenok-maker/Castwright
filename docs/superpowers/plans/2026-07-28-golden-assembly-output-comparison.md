# golden-assembly output comparison (ops-36) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the golden-audio assembly tier (Suite B) able to fail for an audio reason, by comparing the produced MP3 against a recorded, ffmpeg-stamped baseline across four independent layers.

**Architecture:** One pipeline run in a `beforeAll` (first pass → synth → finalize → decode) feeds four independent `it` blocks: L1 pins ffmpeg's loudnorm *measurement*, L2 pins the `.lufs.json` sidecar including a newly-persisted `normalizationType`, L3 pins the decoded byte count and a per-100 ms RMS envelope, L4 pins the encoded MP3 (MD5 on a byte-identical ffmpeg build, RMS-error otherwise). A `GOLDEN_BLESS=1` branch writes the baseline instead of asserting.

**Tech Stack:** TypeScript, Vitest (node env), real ffmpeg subprocesses, Node `node:crypto` md5, `node:test` for the runner script.

**Spec:** [`docs/superpowers/specs/2026-07-28-golden-assembly-output-comparison-design.md`](../specs/2026-07-28-golden-assembly-output-comparison-design.md) (revision 3)
**Issue:** [ops-36 / #1880](https://github.com/dudarenok-maker/Castwright/issues/1880)
**Regression plan:** `docs/features/272-golden-assembly-comparison.md` (created in Task 11)

## Global Constraints

- **Branch:** all work lands on `docs/docs-ops36-golden-comparison` in the worktree `.claude/worktrees/docs+ops36-golden-comparison`. Do not commit to the primary checkout.
- **The golden tier stays opt-in.** Never add `test:golden-audio` (or `:assembly`) to `test:all`, `verify`, `verify:fast*`, or any CI workflow. `server/vitest.config.ts` must keep excluding `src/**/*.golden.test.ts`.
- **Every number in the spec is measured.** Do not round, re-derive, or "improve" a tolerance. The exact values: L1 `±0.1`, L2 `±0.3`, L3 envelope `±10 %` relative with a `-50 dBFS` skip floor, L4-loose `rmse < 16 %`.
- **Baseline literals** (ffmpeg `8.1.1-full_build-www.gyan.dev`): `input_i -21.70`, `input_lra 3.00`, `input_tp -4.15`, `input_thresh -31.75`; sidecar `i -16.28`, `lra 0.50`, `normalizationType "dynamic"`; decoded `274432` bytes, `2` quiet windows skipped, `57` full windows; `mp3Md5 d7d6d0aa41ca947da5465dfd289f0f15`; mp3 `55749` bytes. **These are this box's values — Task 7 regenerates them by blessing, and the committed baseline is whatever bless produces.** They are listed so a wildly different value is recognised as a bug rather than accepted.
- **OpenAPI is the type source of truth.** Never hand-edit `src/lib/api-types.ts`; regenerate with `npm run openapi:types`. Never hand-edit `src/lib/types.ts:56` — it is a re-export of the generated type.
- **Commit convention:** `<type>(<scope>): <subject>`. Scopes used here: `server`, `scripts`, `docs`. Never `--no-verify`.
- **Do not fix** the `linear` → `dynamic` fallback or the LRA 3.00 → 0.50 compression. That is a separate issue filed in Task 11.

---

### Task 1: Comparison math module

The pure statistics the golden tier compares with. No ffmpeg, no I/O — so it is unit-testable in the ordinary `test:server` tier that gates every push. This matters: the golden tier is opt-in and may go a year between runs, so its math must be proven by a suite that runs continuously.

**Files:**
- Create: `server/src/tts/golden-baseline.ts`
- Test: `server/src/tts/golden-baseline.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `AssemblyBaseline`, `TOL`, `EnvelopeVerdict`, `rmsEnvelope(samples, sampleRate, windowMs?) → number[]`, `pcmRms(samples) → number`, `rmsError(a, b) → number` (a ratio: `0.0808` means 8.08 %), `compareEnvelope(baseline, actual, windowMs?) → EnvelopeVerdict`, `selectMode(runBanner, baselineBanner) → 'TIGHT' | 'LOOSE'`, `md5(buf) → string`, `dbfs(rms) → number`, `toInt16(buf) → Int16Array`.

> **`compareEnvelope` takes no `sampleRate`.** It derives `worstAtSec` from
> `windowMs` alone, and `server/tsconfig.json:11` sets `noUnusedParameters: true`
> — an unused parameter is a `typecheck` failure, and Vitest does not typecheck,
> so it would pass here and only surface three commits later.

- [ ] **Step 1: Write the failing test**

Create `server/src/tts/golden-baseline.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --run golden-baseline`
Expected: FAIL — `Failed to resolve import "./golden-baseline.js"`.

- [ ] **Step 3: Write minimal implementation**

Create `server/src/tts/golden-baseline.ts`:

```ts
/* Comparison math for the golden-assembly output baseline (ops-36).

   Pure: no ffmpeg, no I/O, no clock. That is deliberate — this module is
   unit-tested in the ordinary `test:server` tier (`golden-baseline.test.ts`,
   NOT `*.golden.test.ts`), so the opt-in golden tier's statistics are proven
   on every push rather than only when someone remembers to run the tier.

   Tolerances are DERIVED from a measured perturbation curve, not picked —
   see the spec's finding 6. Do not adjust them without re-deriving. */

import { createHash } from 'node:crypto';

/** Shape of `server/src/tts/__fixtures__/golden-chapter.baseline.json`. */
export interface AssemblyBaseline {
  recordedAt: string;
  /** Full first line of `ffmpeg -version`. Exact equality selects TIGHT mode. */
  ffmpegBanner: string;
  /** Parsed MAJOR.MINOR, for the failure message only. */
  ffmpegVersion: string | null;
  /** Encode parameters the baseline was taken under. PROVENANCE ONLY — no
   *  layer asserts it, because `finalizeChapterAudioWrite` hardcodes `-q:a`
   *  internally and the test cannot observe it. What actually guards a changed
   *  encode parameter is L4-tight's md5, which a `-q:a` change moves. This
   *  block exists so a human reading a failure knows what the baseline was
   *  recorded under; do not mistake it for an assertion. */
  encode: { format: string; quality: number; sampleRate: number; writeXing: boolean };
  /** Loudnorm knobs, so a failure separates "ffmpeg changed" from "someone
   *  moved audio.loudnorm.targetLufs". */
  loudnorm: { target: number; lra: number; tp: number };
  firstPass: { input_i: number; input_lra: number; input_tp: number; input_thresh: number };
  sidecar: { i: number; lra: number; normalizationType: 'linear' | 'dynamic' };
  decoded: { bytes: number; quietWindowsSkipped: number };
  envelope100ms: number[];
  mp3Md5: string;
}

/** Derived tolerances. See the spec's finding 6 for the curve each came from. */
export const TOL = {
  /** L1 — first-pass loudnorm stats, LU/dB. Measurement is bit-stable on one
   *  build; this band covers formatting, not drift. */
  firstPassLu: 0.1,
  /** L2 — persisted sidecar loudness, LU. */
  sidecarLu: 0.3,
  /** L3 — per-window relative RMS delta. Noise floor under the skip rule is
   *  1.6–2.0 %; fires at ~0.6 LU of drift. Separation ~5-6x. */
  envelopeRel: 0.1,
  /** L3 — windows quieter than this on EITHER side are skipped. At -67 dBFS a
   *  10 % relative band is a fraction of one int16 quantisation step. */
  quietFloorDbfs: -50,
  /** L4-loose — relative RMS-error. Geometric mean of a 2.35x-wide separation
   *  (noise floor 10.55 %, target signal 24.79 %): sqrt(.1055 * .2479) = .1617.
   *  This is the WEAKEST layer — see the spec's §1. */
  rmseLoose: 0.16,
  /** L3 — envelope window width. */
  windowMs: 100,
} as const;

export interface EnvelopeVerdict {
  ok: boolean;
  /** Index of the worst non-skipped window, or -1 when every window skipped. */
  worstIndex: number;
  /** Relative delta at that window (0.15 == 15 %). */
  worstRelDelta: number;
  /** Start time of that window, for a human-readable failure message. */
  worstAtSec: number;
  /** How many windows the -50 dBFS floor excluded. Asserted by the caller. */
  skipped: number;
}

/** dBFS of a normalised RMS value. -Infinity for digital silence. */
export function dbfs(rms: number): number {
  return rms > 0 ? 20 * Math.log10(rms) : -Infinity;
}

/** Copy `buf` into a fresh ArrayBuffer and view it as little-endian int16.
 *
 *  The copy is NOT wasteful defensiveness: `readFileSync` returns pooled
 *  Buffers whose `byteOffset` is frequently odd, and `new Int16Array(ab,
 *  oddOffset, n)` throws "start offset of Int16Array should be a multiple
 *  of 2". Node is little-endian on every platform we ship to, so the raw
 *  reinterpret is correct. */
export function toInt16(buf: Buffer): Int16Array {
  const copy = new Uint8Array(buf.length);
  copy.set(buf);
  return new Int16Array(copy.buffer, 0, Math.floor(buf.length / 2));
}

/** Normalised RMS (0..1) of an int16 sample array. */
export function pcmRms(samples: Int16Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i += 1) {
    const v = samples[i] / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / samples.length);
}

/** Per-window normalised RMS. Full windows only — a trailing partial window is
 *  dropped, identically on both sides of a comparison. */
export function rmsEnvelope(
  samples: Int16Array,
  sampleRate: number,
  windowMs: number = TOL.windowMs,
): number[] {
  const w = Math.round((sampleRate * windowMs) / 1000);
  const out: number[] = [];
  for (let i = 0; i + w <= samples.length; i += w) {
    out.push(pcmRms(samples.subarray(i, i + w)));
  }
  return out;
}

/** Relative RMS-error between two sample arrays: the RMS of their difference
 *  over the RMS of `a`. Returns a ratio (0.0808 == 8.08 %).
 *
 *  Truncates to the shorter input so unequal lengths cannot produce NaN. The
 *  caller asserts the length delta separately — truncation is about keeping
 *  the math defined, NOT about tolerating a length change. */
export function rmsError(a: Int16Array, b: Int16Array): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let err = 0;
  let sig = 0;
  for (let i = 0; i < n; i += 1) {
    const d = a[i] - b[i];
    err += d * d;
    sig += a[i] * a[i];
  }
  if (sig === 0) return err === 0 ? 0 : Infinity;
  return Math.sqrt(err / n) / Math.sqrt(sig / n);
}

/** Compare two RMS envelopes window-by-window.
 *
 *  A window is skipped when EITHER side falls below `TOL.quietFloorDbfs`.
 *  Skipping on the baseline side alone would let a regression that SILENCES a
 *  loud window escape; the union rule closes that, and the caller asserts the
 *  skipped count so the excluded set cannot silently grow. */
export function compareEnvelope(
  baseline: number[],
  actual: number[],
  windowMs: number = TOL.windowMs,
): EnvelopeVerdict {
  const floor = 10 ** (TOL.quietFloorDbfs / 20);
  const n = Math.min(baseline.length, actual.length);
  let worstIndex = -1;
  let worstRelDelta = 0;
  let skipped = 0;
  for (let i = 0; i < n; i += 1) {
    if (baseline[i] < floor || actual[i] < floor) {
      skipped += 1;
      continue;
    }
    const rel = Math.abs(actual[i] - baseline[i]) / baseline[i];
    if (rel > worstRelDelta) {
      worstRelDelta = rel;
      worstIndex = i;
    }
  }
  return {
    ok: worstRelDelta <= TOL.envelopeRel,
    worstIndex,
    worstRelDelta,
    worstAtSec: worstIndex < 0 ? 0 : (worstIndex * windowMs) / 1000,
    skipped,
  };
}

/** Hex md5 of a buffer. Used for the TIGHT-path MP3 comparison, which is exact
 *  because the encode is byte-identical across runs on one ffmpeg build. */
export function md5(buf: Buffer): string {
  return createHash('md5').update(buf).digest('hex');
}

/** TIGHT only when the running ffmpeg banner is byte-identical to the one the
 *  baseline was recorded under.
 *
 *  Deliberately exact-string, not MAJOR.MINOR: two 8.1 builds can ship
 *  different LAME, so a version match does not promise identical output. Lives
 *  here rather than in the golden test file so the branch is unit-testable —
 *  on any single box one of the two arms never executes, and an untested arm
 *  that only runs on someone else's machine is the worst kind. */
export function selectMode(
  runBanner: string | null,
  baselineBanner: string | null,
): 'TIGHT' | 'LOOSE' {
  if (!runBanner || !baselineBanner) return 'LOOSE';
  return runBanner === baselineBanner ? 'TIGHT' : 'LOOSE';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- --run golden-baseline`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck before committing**

Run: `npm run typecheck`
Expected: clean. Vitest does **not** typecheck, so a green Step 4 proves nothing about `noUnusedLocals` / `noUnusedParameters` (`server/tsconfig.json:10-11`). Catching it here rather than at Task 4 keeps the branch from carrying three commits that don't compile.

- [ ] **Step 6: Commit**

```bash
git add server/src/tts/golden-baseline.ts server/src/tts/golden-baseline.test.ts
git commit -m "test(server): add golden-assembly comparison math with derived tolerances"
```

---

### Task 2: File-input PCM decode helper

L3 must decode the written `.mp3` from a **seekable** input. `decodeAudioToPcm` feeds `pipe:0`, and on a non-seekable input ffmpeg skips the LAME tag's end-padding trim — 275 422 bytes instead of 274 432. Nothing in `server/src` decodes audio from a path, so this helper is new.

**Files:**
- Modify: `server/src/tts/mp3.ts` (add beside `decodeAudioToPcm` at `:501`)
- Test: `server/src/tts/decode-audio-to-pcm.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `decodeAudioFileToPcm(inputPath: string, sampleRate: number) → Promise<Buffer>`.

- [ ] **Step 1: Write the failing test**

Append to `server/src/tts/decode-audio-to-pcm.test.ts` (inside the existing file, after the existing `describe`). The `sine` helper and `SR` const already exist at the top of that file — reuse them, do not redefine:

```ts
describe('decodeAudioFileToPcm', () => {
  it('round-trips an encode to the EXACT input length, unlike the pipe decode', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { decodeAudioFileToPcm, decodeAudioToPcm } = await import('./mp3.js');

    const original = sine(1.0, SR);
    const mp3 = await encodePcmToAudio(original, SR, { format: 'mp3', quality: 2 });
    const dir = mkdtempSync(join(tmpdir(), 'decode-file-'));
    try {
      const path = join(dir, 'a.mp3');
      writeFileSync(path, mp3);

      const fromFile = await decodeAudioFileToPcm(path, SR);
      const fromPipe = await decodeAudioToPcm(mp3, SR);

      /* The seekable input lets ffmpeg honour the LAME gapless tag, so the
         round-trip is exact. The pipe decode appends untrimmed padding — this
         is the difference L3 depends on, so it is pinned here. */
      expect(fromFile.length).toBe(original.length);
      expect(fromPipe.length).toBeGreaterThan(fromFile.length);

      // The pipe decode contains the file decode as an exact leading prefix.
      expect(fromPipe.subarray(0, fromFile.length).equals(fromFile)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('forces the output onto the requested sample grid', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { decodeAudioFileToPcm } = await import('./mp3.js');

    const mp3 = await encodePcmToAudio(sine(1.0, SR), SR, { format: 'mp3', quality: 2 });
    const dir = mkdtempSync(join(tmpdir(), 'decode-file-rate-'));
    try {
      const path = join(dir, 'a.mp3');
      writeFileSync(path, mp3);
      const pcm16k = await decodeAudioFileToPcm(path, 16_000);
      expect(pcmDurationSec(pcm16k.length, 16_000)).toBeGreaterThan(0.95);
      expect(pcmDurationSec(pcm16k.length, 16_000)).toBeLessThan(1.05);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects with a readable error when the file does not exist', async () => {
    const { decodeAudioFileToPcm } = await import('./mp3.js');
    await expect(decodeAudioFileToPcm('no-such-file.mp3', SR)).rejects.toThrow(/decode/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --run decode-audio-to-pcm`
Expected: FAIL — `decodeAudioFileToPcm is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/tts/mp3.ts`, immediately **after** the closing brace of `decodeAudioToPcm` (`:541`) and before the `audioExtForFormat` doc comment, add:

```ts
/** Decode an encoded audio FILE to raw s16le mono PCM at `sampleRate`.

    Deliberately separate from `decodeAudioToPcm`, which feeds `pipe:0`. On a
    NON-SEEKABLE input ffmpeg does not apply the LAME tag's end-padding trim,
    so a pipe decode returns ~495 samples more than the source PCM. A seekable
    file input round-trips to the exact input length. The golden-assembly tier
    (ops-36) pins the decoded byte count, so it needs the file form.

    Same subprocess handling as its pipe sibling: friendly spawn-failure hint,
    reject on non-zero exit. */
export async function decodeAudioFileToPcm(
  inputPath: string,
  sampleRate: number,
): Promise<Buffer> {
  const args = [
    '-loglevel',
    'error',
    '-i',
    inputPath,
    '-f',
    's16le',
    '-acodec',
    'pcm_s16le',
    '-ac',
    '1',
    '-ar',
    String(sampleRate),
    'pipe:1',
  ];
  return new Promise<Buffer>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    child.stdout.on('data', (c) => stdoutChunks.push(c));
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', (err) => {
      reject(
        new Error(
          `Failed to spawn ffmpeg (decode file): ${err.message}. ` +
            `Install ffmpeg and ensure it is on PATH (winget install Gyan.FFmpeg).`,
        ),
      );
    });
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code === 0) resolve(Buffer.concat(stdoutChunks));
      else
        reject(
          new Error(
            `ffmpeg (decode file ${inputPath}) exited with code ${code}: ` +
              `${stderr.trim() || '(no stderr)'}`,
          ),
        );
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- --run decode-audio-to-pcm`
Expected: PASS, 3 new cases plus the pre-existing ones.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/mp3.ts server/src/tts/decode-audio-to-pcm.test.ts
git commit -m "feat(server): add decodeAudioFileToPcm for exact-length decode from a seekable input"
```

---

### Task 3: ffmpeg banner accessor

The TIGHT/LOOSE gate needs the **full** `ffmpeg -version` first line. `FfmpegProbe` exposes only the parsed `MAJOR.MINOR`, so two different `8.1` builds would claim a match and then fail an exact MP3 comparison.

**Files:**
- Modify: `server/src/diagnostics/ffmpeg.ts`
- Test: `server/src/diagnostics/ffmpeg.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `ffmpegBannerLine(): string | null`.

- [ ] **Step 1: Write the failing test**

**This file mocks `node:child_process`** (`ffmpeg.test.ts:15-17`) and resets the mock in `beforeEach` (`:37`), so `ffmpegBannerLine()` will never see a real ffmpeg here. Drive the existing `bins(present, banner)` helper at `:32` instead — which is better coverage anyway, since a multi-line stub actually exercises the "first line only" split that a real single-line check cannot.

Add `ffmpegBannerLine` to the existing import at `:20`, then append:

```ts
describe('ffmpegBannerLine', () => {
  const MULTILINE =
    'ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers\n' +
    'built with gcc 14.2.0 (Rev1, Built by MSYS2 project)\n' +
    'configuration: --enable-gpl --enable-libmp3lame\n';

  it('returns the FIRST line only, trimmed', () => {
    bins({ ffmpeg: true, ffprobe: true }, MULTILINE);
    expect(ffmpegBannerLine()).toBe(
      'ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright (c) 2000-2026 the FFmpeg developers',
    );
  });

  it('handles CRLF line endings', () => {
    bins({ ffmpeg: true, ffprobe: true }, 'ffmpeg version 8.1\r\nbuilt with gcc\r\n');
    expect(ffmpegBannerLine()).toBe('ffmpeg version 8.1');
  });

  it('carries more than the parsed MAJOR.MINOR, so two builds are distinguishable', () => {
    bins({ ffmpeg: true, ffprobe: true }, MULTILINE);
    const line = ffmpegBannerLine()!;
    /* This is the whole point: parseFfmpegVersion collapses both the Gyan and
       the Ubuntu 8.1 builds to "8.1", but they can ship different LAME. */
    expect(parseFfmpegVersion(line)).toBe('8.1');
    expect(line.length).toBeGreaterThan('8.1'.length);
  });

  it('returns null when ffmpeg is absent', () => {
    bins({ ffmpeg: false, ffprobe: false });
    expect(ffmpegBannerLine()).toBeNull();
  });

  it('returns null when ffmpeg is present but silent', () => {
    bins({ ffmpeg: true, ffprobe: true }, '');
    expect(ffmpegBannerLine()).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --run diagnostics/ffmpeg`
Expected: FAIL — `ffmpegBannerLine is not a function`.

- [ ] **Step 3: Write minimal implementation**

In `server/src/diagnostics/ffmpeg.ts`, after `probeFfmpeg` (ends `:111`), add:

```ts
/** First line of `ffmpeg -version` — the full banner including build and
 *  compiler, e.g. "ffmpeg version 8.1.1-full_build-www.gyan.dev Copyright …".
 *
 *  `FfmpegProbe.version` deliberately carries only MAJOR.MINOR, which is the
 *  right granularity for a floor check but NOT for deciding whether two
 *  installs will produce byte-identical output: two 8.1 builds can ship
 *  different LAME. The golden-assembly tier (ops-36) gates its exact MP3
 *  comparison on this string.
 *
 *  Spawns afresh — `probeFfmpeg` is deliberately uncached (see the block
 *  comment above it), so there is no captured stdout to reuse. Null when
 *  ffmpeg is absent or produced no output. */
export function ffmpegBannerLine(): string | null {
  const ff = present('ffmpeg');
  if (!ff.ok) return null;
  const first = ff.stdout.split(/\r?\n/, 1)[0]?.trim();
  return first ? first : null;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix server run test -- --run diagnostics/ffmpeg`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add server/src/diagnostics/ffmpeg.ts server/src/diagnostics/ffmpeg.test.ts
git commit -m "feat(server): expose ffmpegBannerLine for build-exact ffmpeg identity"
```

---

### Task 4: Persist `normalizationType` in the loudness sidecar

L2 wants to pin loudnorm's mode. Today `mp3.ts:440` parses `normalization_type` and `:442-449` drops it — the type's own comment says *"Not surfaced to the UI today."* This task carries the already-parsed value to disk.

**Critical constraint:** the mode is set **only** on the success branch. Three fallback branches (`mp3.ts:450`, `:457`, `:466`) leave the provisional sidecar untouched — it was stamped `twoPass: true` at `:296-304` *before* the encode — so `twoPass === true` does **not** imply a mode is present. Do not "fix" that by stamping a mode in the fallback (there is none) or by flipping `twoPass` to `false` (a behaviour change across `loudness-report.tsx`'s drift gating). Absence is meaningful, and L2 diagnoses it separately in Task 8.

**Files:**
- Modify: `server/src/tts/loudnorm.ts:73-86` (the `LoudnormSidecarJson` interface)
- Modify: `server/src/tts/mp3.ts:442-449` (the success branch)
- Modify: `openapi.yaml:5254` (`ChapterLoudness`) and `:5266-5269` (a wrong description)
- Regenerate: `src/lib/api-types.ts`
- Test: `server/src/tts/mp3-spawn-args.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `LoudnormSidecarJson.normalizationType?: 'linear' | 'dynamic'`.

- [ ] **Step 1: Write the failing test**

In `server/src/tts/mp3-spawn-args.test.ts`, extend the existing success-path case at `:242` (`'writes output_i to the sidecar when the second-pass stderr is parseable'`). Its `secondPassStderr` fixture already contains `"normalization_type" : "linear"`. Widen the local `sidecar` type annotation at `:248-249` to include the field, then add this assertion after the existing `expect(sidecar!.tp).toBe(-1.51);`:

```ts
    /* ops-36: the parsed mode now survives to disk. L2 in the golden-assembly
       tier pins it, because a silent dynamic->linear flip changes how the
       chapter sounds while leaving integrated loudness near target. */
    expect(sidecar!.normalizationType).toBe('linear');
```

Then add a new case immediately after the existing `'falls back to input_i when the second-pass stderr lacks a JSON block'` test:

```ts
  it('leaves normalizationType undefined on the second-pass fallback path', async () => {
    /* The provisional sidecar is stamped twoPass:true BEFORE the encode
       (mp3.ts:296-304) and the fallback branches leave it untouched, so
       `twoPass === true` does NOT imply a mode is present. Consumers must
       treat absence as "the second-pass JSON was not parsed", which is a
       DIFFERENT bug from a mode flip. */
    spawnMock
      .mockImplementationOnce(() => fakeFfmpegChild({ stderr: firstPassStderr }))
      .mockImplementationOnce(() => fakeFfmpegChild({ stderr: 'no json here' }));

    /* The fallback path warns on console. Silence it as the sibling fallback
       test in this file does, so the suite output stays readable. */
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const { encodePcmToAudio } = await import('./mp3.js');
      let sidecar: { twoPass: boolean; normalizationType?: 'linear' | 'dynamic' } | null = null;
      await encodePcmToAudio(Buffer.alloc(2), 24_000, {
        quality: 2,
        loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: true },
        onLoudnessMeasured: (s) => {
          sidecar = s;
        },
      });

      expect(sidecar).not.toBeNull();
      expect(sidecar!.twoPass).toBe(true);
      expect(sidecar!.normalizationType).toBeUndefined();
    } finally {
      warn.mockRestore();
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix server run test -- --run mp3-spawn-args`
Expected: FAIL — `expected undefined to be 'linear'` on the success-path case. (The new fallback case passes already; that is fine — it is pinning behaviour this task must not break.)

- [ ] **Step 3: Write minimal implementation**

**3a.** In `server/src/tts/loudnorm.ts`, add to the `LoudnormSidecarJson` interface (after `twoPass`, before `measuredAt`):

```ts
  /** Which mode loudnorm's second pass actually used. `linear` applies a single
   *  gain offset and preserves the source envelope; `dynamic` compresses on the
   *  fly, which ffmpeg falls back to when the linear gain would breach the
   *  true-peak ceiling.
   *
   *  OPTIONAL, and absence is meaningful in two ways: single-pass mode never
   *  has one, and a two-pass encode whose second-pass JSON failed to parse
   *  falls back WITHOUT one while still reporting `twoPass: true`. Do NOT infer
   *  presence from `twoPass`. Sidecars written by
   *  `scripts/relufs-existing.mjs` also omit it (ebur128 has no mode). */
  normalizationType?: 'linear' | 'dynamic';
```

**3b.** In `server/src/tts/mp3.ts`, in the success branch at `:442-449`, add the field to the replacement object (after `twoPass: true,`):

```ts
            normalizationType:
              secondPass.normalization_type === 'linear'
                ? 'linear'
                : secondPass.normalization_type === 'dynamic'
                  ? 'dynamic'
                  : undefined,
```

**3c.** In `openapi.yaml`, add the property to `ChapterLoudness`. The `twoPass` property ends at `:5290` and `measuredAt` begins at `:5291` — insert between them. **Do not add it to the `required:` list at `:5256`** — existing sidecars on disk lack it:

```yaml
        normalizationType:
          type: string
          enum: [linear, dynamic]
          description: |
            Which mode loudnorm's second pass used. Absent for single-pass
            output, for sidecars written by scripts/relufs-existing.mjs, and
            for a two-pass encode whose second-pass JSON failed to parse —
            so consumers MUST NOT infer presence from `twoPass`.
```

**3d.** In `openapi.yaml`, fix the factually wrong description at `:5266-5269`. Replace:

```
            Measured integrated loudness (LUFS). In two-pass mode this is
            the FIRST-pass measurement of the source PCM; in single-pass
            mode it is the nominal target (no re-measurement is done).
```

with:

```
            Measured integrated loudness (LUFS). In two-pass mode this is the
            POST-normalisation value ffmpeg's second pass reports as
            `output_i` — what the chapter actually sounds like. In single-pass
            mode it is the nominal target (no re-measurement is done). If the
            second-pass JSON fails to parse, the encoder falls back to
            persisting the first-pass input-side measurement here.
```

- [ ] **Step 4: Regenerate the client types and run the tests**

```bash
npm run openapi:types
```

Run: `npm --prefix server run test -- --run mp3-spawn-args` → Expected: PASS.
Run: `npm run typecheck` → Expected: clean.
Run: `git diff --stat src/lib/api-types.ts` → Expected: a small diff touching only `ChapterLoudness`. If the diff is large, stop — something else regenerated and needs investigating before committing.

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/loudnorm.ts server/src/tts/mp3.ts server/src/tts/mp3-spawn-args.test.ts openapi.yaml src/lib/api-types.ts
git commit -m "feat(server): persist loudnorm normalizationType in the chapter sidecar"
```

---

### Task 5: Suite-scoped `--bless`

`--bless` currently reaches only Suite A, so `--assembly-only --bless` is a silent no-op for blessing. Make bless follow suite selection.

**Files:**
- Modify: `scripts/run-golden-audio.mjs:60-63` (the Suite B `run(...)` call) and the header comment
- Test: `scripts/tests/run-golden-audio.test.mjs` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `GOLDEN_BLESS=1` in the Suite B child environment when `--bless` is passed and Suite B is selected.

**Note on the alias:** `npm run test:golden-audio:assembly` calls `npm --prefix server run test:golden` directly (root `package.json:65`), bypassing this runner — so that alias can never bless. **Leave the alias as-is.** It must keep working as a plain assert-only invocation, because the owed on-box acceptance row prescribes running exactly that alias against a second ffmpeg build. Blessing is documented as the full-runner form in Task 11.

- [ ] **Step 1: Write the failing test**

Create `scripts/tests/run-golden-audio.test.mjs`:

```js
// Runs under `npm run test:hooks` (node --test over scripts/tests/*.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync('scripts/run-golden-audio.mjs', 'utf8');

test('Suite B receives GOLDEN_BLESS when --bless is passed', () => {
  // The Suite B run(...) call must pass a bless-conditional env object.
  const suiteB = src.slice(src.indexOf("run('assembly (Suite B)'"));
  const call = suiteB.slice(0, suiteB.indexOf('\n}'));
  assert.match(call, /GOLDEN_BLESS/, 'Suite B run() must forward GOLDEN_BLESS');
  assert.match(call, /bless \?/, 'forwarding must be conditional on the bless flag');
});

test('Suite A still receives GOLDEN_BLESS — existing behaviour is preserved', () => {
  const suiteA = src.slice(src.indexOf("run(\n    'sidecar (Suite A)'"));
  assert.match(suiteA, /bless \? \{ GOLDEN_BLESS: '1' \}/);
});

test('the header documents that --bless follows suite selection', () => {
  assert.match(src, /--bless[\s\S]{0,400}suite selection/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test scripts/tests/run-golden-audio.test.mjs`
Expected: FAIL on case 1 ("Suite B run() must forward GOLDEN_BLESS") and case 3 (the header case). Case 2 passes already — it pins Suite A's existing behaviour, which this task must not break.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `scripts/run-golden-audio.mjs`, replace the Suite B block (currently at `:60-63`):

```js
if (!sidecarOnly) {
  // Suite B — GPU-free assembly golden (real ffmpeg, recorded PCM fixture).
  run('assembly (Suite B)', 'npm', ['--prefix', 'server', 'run', 'test:golden'], {
    shell: true,
    env: bless ? { GOLDEN_BLESS: '1' } : {},
  });
}
```

**3b.** In the header comment, replace the `--bless` line:

```js
//   --bless                bless the SELECTED suites — bless follows suite selection.
//                          Bare --bless records both baselines,
//                          `--assembly-only --bless` records only Suite B's
//                          golden-chapter.baseline.json + .decoded.pcm, and
//                          `--sidecar-only --bless` records only Suite A's
//                          kokoro-baseline.json. To re-capture the Suite B
//                          INPUT fixture (not its baseline), run
//                          server/tts-sidecar/tests/golden/capture_assembly_fixture.py.
//                          NOTE: `npm run test:golden-audio:assembly` bypasses
//                          this runner, so it can never bless — use the full
//                          `npm run test:golden-audio -- --assembly-only --bless`.
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test scripts/tests/run-golden-audio.test.mjs` → Expected: PASS, 3 cases.
Run: `npm run test:hooks` → Expected: PASS (the whole scripts-test battery).

- [ ] **Step 5: Commit**

```bash
git add scripts/run-golden-audio.mjs scripts/tests/run-golden-audio.test.mjs
git commit -m "fix(scripts): make --bless follow golden-audio suite selection"
```

---

### Task 6: Restructure the golden test to a single pipeline run

Pure refactor — no assertion changes. Moves the pipeline into `beforeAll` so four layers can read one artifact set rather than four different encodes, and deletes an env-set that has never worked.

**Why the env-set is deleted, not moved:** `workspace/paths.ts:35-39` computes `WORKSPACE_ROOT` at module-eval time, and this file statically imports `synthesise-chapter.js` → `paths.js`. So `paths.js` is fully evaluated before `process.env.WORKSPACE_DIR = …` runs, and the dynamic `import()` returns the cached module. The test has never been workspace-isolated; it is harmless only because `finalizeChapterAudioWrite` takes an explicit `bookDir`. Relocating it would perpetuate a false belief.

**Files:**
- Modify: `server/src/tts/golden-assembly.golden.test.ts` (whole-file restructure)

**Interfaces:**
- Consumes: `decodeAudioFileToPcm` (Task 2), `ffmpegBannerLine` (Task 3), `rmsEnvelope`/`md5`/`toInt16` (Task 1).
- Produces: a module-scoped `art` object consumed by Tasks 7-9 — fields `synth`, `firstPass`, `sidecar`, `mp3`, `mp3Md5`, `decoded` (`Int16Array`), `envelope` (`number[]`), `banner`, `audioRoot`.

- [ ] **Step 1: Replace the file body**

Replace everything in `server/src/tts/golden-assembly.golden.test.ts` from the `import` block down to the end with the following. Keep the existing file-top block comment, and extend it with a line naming ops-36.

```ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync, mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { synthesiseChapter, type CastCharacter } from './synthesise-chapter.js';
import { evaluateSegmentPcm } from './segment-qa.js';
import { pcmDurationSec } from './pcm.js';
import { decodeAudioFileToPcm } from './mp3.js';
import {
  runLoudnormFirstPass,
  resolveLoudnormOptions,
  type LoudnormFirstPassStats,
  type LoudnormSidecarJson,
} from './loudnorm.js';
import { ffmpegBannerLine } from '../diagnostics/ffmpeg.js';
import { rmsEnvelope, md5, toInt16 } from './golden-baseline.js';
import type { SynthesizeInput, SynthesizeOutput, TtsProvider } from './index.js';
import type { SentenceOutput } from '../handoff/schemas.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = join(HERE, '__fixtures__');

const AUTHOR = 'Golden Author';
const SERIES = 'Standalones';
const TITLE = 'Golden Story';
const SLUG = 'golden-chapter';

interface FixtureSegment {
  characterId: string;
  text: string;
  voiceName: string;
  byteLength: number;
}
interface FixtureMeta {
  sampleRate: number;
  segments: FixtureSegment[];
}

const meta: FixtureMeta = JSON.parse(
  readFileSync(join(FIXTURE_DIR, 'golden-chapter.json'), 'utf8'),
);
const fixturePcm = readFileSync(join(FIXTURE_DIR, 'golden-chapter.pcm'));

/** Slice the concatenated fixture PCM into its per-segment buffers, keyed by the
    EXACT text each segment was synthesized from (the lines are caps/dash-free so
    `normaliseForTts` is identity — the stub keys on the post-normalisation text
    the provider receives). */
function sliceByText(): Map<string, Buffer> {
  const byText = new Map<string, Buffer>();
  let off = 0;
  for (const seg of meta.segments) {
    byText.set(seg.text, fixturePcm.subarray(off, off + seg.byteLength));
    off += seg.byteLength;
  }
  return byText;
}

/** Stub provider that returns the recorded PCM for the requested text. */
function makeRecordedProvider(): TtsProvider & { calls: SynthesizeInput[] } {
  const byText = sliceByText();
  const calls: SynthesizeInput[] = [];
  return {
    calls,
    async synthesize(input: SynthesizeInput): Promise<SynthesizeOutput> {
      calls.push(input);
      const pcm = byText.get(input.text);
      if (!pcm) throw new Error(`no recorded PCM for text: ${input.text}`);
      return { pcm: Buffer.from(pcm), sampleRate: meta.sampleRate, mimeType: 'audio/pcm' };
    },
  };
}

const cast: CastCharacter[] = meta.segments.map((s, i) => ({
  id: s.characterId,
  name: s.characterId,
  gender: (i === 1 ? 'female' : 'male') as 'female' | 'male',
  attributes: [],
}));

const sentences: SentenceOutput[] = meta.segments.map((s, i) => ({
  id: i + 1,
  chapterId: 1,
  characterId: s.characterId,
  text: s.text,
}));

interface Artifacts {
  synth: Awaited<ReturnType<typeof synthesiseChapter>>;
  /** The finalize call's own return value. Kept because it is this repo's only
      coverage of `segmentCount` / `durationSec` on that result. */
  finalized: { segmentCount: number; durationSec: number };
  firstPass: LoudnormFirstPassStats;
  sidecar: LoudnormSidecarJson | null;
  mp3: Buffer;
  mp3Md5: string;
  decoded: Int16Array;
  envelope: number[];
  banner: string | null;
  audioRoot: string;
}

let art: Artifacts;
let workspaceRoot: string;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'audiobook-golden-assembly-'));
  try {
    const [{ finalizeChapterAudioWrite }, { makeBookId }] = await Promise.all([
      import('../audio/finalize-chapter-write.js'),
      import('../workspace/paths.js'),
    ]);
    const bookId = makeBookId(AUTHOR, SERIES, TITLE);
    const bookDir = join(workspaceRoot, 'books', AUTHOR, SERIES, TITLE);
    const audioRoot = join(bookDir, 'audio');
    mkdirSync(audioRoot, { recursive: true });
    mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
    writeFileSync(join(bookDir, 'manuscript.txt'), 'placeholder');
    writeFileSync(
      join(bookDir, '.audiobook', 'state.json'),
      JSON.stringify({
        bookId,
        manuscriptId: 'm_golden',
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

    const synth = await synthesiseChapter({
      sentences,
      cast,
      provider: makeRecordedProvider(),
      modelKey: 'kokoro-v1',
      engine: 'kokoro',
      groupHeartbeatMs: 0,
    });

    /* L1's source: the raw fixture measured directly. This is a SEPARATE
       ffmpeg spawn from the one finalizeChapterAudioWrite runs internally —
       `encodePcmToAudio` does not expose its own first-pass stats. */
    const firstPass = await runLoudnormFirstPass(
      synth.pcm,
      synth.sampleRate,
      resolveLoudnormOptions(),
    );

    const finalized = await finalizeChapterAudioWrite({
      bookId,
      bookDir,
      chapter: { id: 1, slug: SLUG, title: 'Chapter 1' },
      pcm: synth.pcm,
      sampleRate: synth.sampleRate,
      durationSec: synth.durationSec,
      segments: synth.segments,
      cast,
      defaultEngine: 'kokoro',
      modelKey: 'kokoro-v1',
      audioFormat: 'mp3',
    });

    const mp3Path = join(audioRoot, `${SLUG}.mp3`);
    const mp3 = readFileSync(mp3Path);
    /* Decode from the FILE, not via decodeAudioToPcm: a pipe input skips the
       LAME gapless trim and appends ~495 samples of padding. */
    const decoded = toInt16(await decodeAudioFileToPcm(mp3Path, meta.sampleRate));

    const lufsPath = join(audioRoot, `${SLUG}.lufs.json`);
    const sidecar = existsSync(lufsPath)
      ? (JSON.parse(readFileSync(lufsPath, 'utf8')) as LoudnormSidecarJson)
      : null;

    art = {
      synth,
      finalized,
      firstPass,
      sidecar,
      mp3,
      mp3Md5: md5(mp3),
      decoded,
      envelope: rmsEnvelope(decoded, meta.sampleRate),
      banner: ffmpegBannerLine(),
      audioRoot,
    };
  } catch (e) {
    /* A hook failure kills every `it` at once, so it must not read as a layer
       verdict. Name it for what it is. */
    throw new Error(
      `golden assembly: the PIPELINE did not complete — this is NOT a layer ` +
        `verdict and says nothing about audio drift. Cause: ${(e as Error).message}`,
    );
  }
  /* Four ffmpeg spawns (raw first pass, finalize's internal first pass, encode,
     decode) on ~5.7s of audio. The config's hookTimeout is 30s; this explicit
     budget documents the headroom rather than relying on it. */
}, 60_000);

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
});

describe('golden assembly (GPU-free)', () => {
  it('synthesiseChapter concatenates recorded PCM into deterministic segments', () => {
    expect(art.synth.segments).toHaveLength(meta.segments.length);
    expect(art.synth.sampleRate).toBe(meta.sampleRate);

    let cumBytes = 0;
    art.synth.segments.forEach((seg, i) => {
      const startSec = pcmDurationSec(cumBytes, meta.sampleRate);
      cumBytes += meta.segments[i].byteLength;
      const endSec = pcmDurationSec(cumBytes, meta.sampleRate);
      expect(seg.startSec).toBeCloseTo(startSec, 6);
      expect(seg.endSec).toBeCloseTo(endSec, 6);
      expect(seg.voiceSubstitutedFrom).toBeUndefined();
    });

    const totalBytes = meta.segments.reduce((a, s) => a + s.byteLength, 0);
    expect(art.synth.durationSec).toBeCloseTo(pcmDurationSec(totalBytes, meta.sampleRate), 6);
    expect(art.synth.pcm.length).toBe(totalBytes);

    art.synth.segments.forEach((seg, i) => {
      const segPcm = art.synth.pcm.subarray(
        Math.round(seg.startSec * meta.sampleRate) * 2,
        Math.round(seg.endSec * meta.sampleRate) * 2,
      );
      const verdict = evaluateSegmentPcm(segPcm, meta.sampleRate, meta.segments[i].text);
      expect(verdict.status, verdict.reasons.join('; ')).toBe('ok');
    });
  });

  it('finalizeChapterAudioWrite writes the audio and its sidecars', () => {
    /* Carried over from the pre-ops-36 test: this is the repo's only coverage
       of the finalize result's segmentCount / durationSec. */
    expect(art.finalized.segmentCount).toBe(meta.segments.length);
    expect(art.finalized.durationSec).toBeCloseTo(art.synth.durationSec, 1);

    expect(existsSync(join(art.audioRoot, `${SLUG}.mp3`))).toBe(true);
    expect(existsSync(join(art.audioRoot, `${SLUG}.segments.json`))).toBe(true);
    expect(existsSync(join(art.audioRoot, `${SLUG}.lufs.json`))).toBe(true);

    const segFile = JSON.parse(
      readFileSync(join(art.audioRoot, `${SLUG}.segments.json`), 'utf8'),
    ) as { segments: unknown[] };
    expect(segFile.segments).toHaveLength(meta.segments.length);

    /* Superseded by L2 in a later task — kept here only so this refactor
       changes no assertions. */
    expect(art.sidecar).not.toBeNull();
    expect(art.sidecar!.i).toBeGreaterThan(-30);
    expect(art.sidecar!.i).toBeLessThan(-10);
  });
});
```

- [ ] **Step 2: Run the tier to verify it still passes**

Run: `npm run test:golden-audio:assembly`
Expected: PASS, 2 tests. Note the reported duration of the `beforeAll` hook — if it exceeds ~15 s, raise the explicit budget and say so in the commit message.

- [ ] **Step 3: Confirm the tier is still excluded from the gating suite**

Run: `npm --prefix server run test -- --run golden-assembly`
Expected: **`No test files found, exiting with code 1`**, and the printed `exclude:` list contains `src/**/*.golden.test.ts`.

> **Exit code 1 IS the pass condition here**, and npm will print an `ERR!`
> block. That is vitest reporting that its own filter matched nothing because
> the config excludes the file — exactly what this step verifies. Do not
> "fix" it.

- [ ] **Step 4: Commit**

```bash
git add server/src/tts/golden-assembly.golden.test.ts
git commit -m "refactor(server): run the golden-assembly pipeline once in beforeAll"
```

---

### Task 7: Baseline load, bless branch, and the recorded artifacts

Adds the baseline plumbing and produces the two committed artifacts. **Ordering is load-bearing:** under bless, the baseline is never loaded and no layer asserts — otherwise the first bless would hard-fail on the missing file it is about to write, and a bless that still asserted would compare a run against a baseline derived from that same run and pass vacuously.

**Files:**
- Modify: `server/src/tts/golden-assembly.golden.test.ts`
- Create (by blessing): `server/src/tts/__fixtures__/golden-chapter.baseline.json`
- Create (by blessing): `server/src/tts/__fixtures__/golden-chapter.decoded.pcm`

**Interfaces:**
- Consumes: `art` (Task 6), `AssemblyBaseline` (Task 1).
- Produces: module-scoped `baseline: AssemblyBaseline | null`, `BLESS: boolean`, `tight: boolean`, and `modeLine(): string` used by every layer's failure message.

- [ ] **Step 1: Add the baseline plumbing**

Add after the `art`/`workspaceRoot` declarations in `golden-assembly.golden.test.ts`:

```ts
const BASELINE_PATH = join(FIXTURE_DIR, 'golden-chapter.baseline.json');
const DECODED_PATH = join(FIXTURE_DIR, 'golden-chapter.decoded.pcm');
const BLESS = process.env.GOLDEN_BLESS === '1';
const BLESS_CMD = 'npm run test:golden-audio -- --assembly-only --bless';

let baseline: AssemblyBaseline | null = null;

/** Thin delegate — the branch logic lives in `golden-baseline.ts` so it can be
    unit-tested. On any one box only one arm ever runs, and the other arm would
    otherwise ship having never executed anywhere. */
function isTight(): boolean {
  return selectMode(art.banner, baseline?.ffmpegBanner ?? null) === 'TIGHT';
}

/** Suffix every failure message carries, so a cold reader knows which mode
    produced the verdict and how to re-record deliberately. */
function modeLine(): string {
  return (
    `\n  run: ffmpeg ${art.banner ?? '(absent)'}` +
    `\n  baseline: ffmpeg ${baseline?.ffmpegBanner ?? '(none)'}` +
    `\n  mode: ${isTight() ? 'TIGHT' : 'LOOSE'}` +
    `\n  If intended, re-bless: ${BLESS_CMD}`
  );
}

function loadBaseline(): AssemblyBaseline {
  if (!existsSync(BASELINE_PATH)) {
    throw new Error(
      `golden assembly: baseline missing at ${BASELINE_PATH}.\n` +
        `  Both baseline artifacts are committed, so absence means one was deleted.\n` +
        `  To record a new baseline: ${BLESS_CMD}`,
    );
  }
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8')) as AssemblyBaseline;
}

function writeBaseline(): void {
  /* Refuse to record a baseline whose mode is missing. If the second-pass JSON
     failed to parse at bless time, `normalizationType` is undefined,
     JSON.stringify drops the key, and L2 would then compare undefined to
     undefined and pass forever — defeating the exact absence-diagnosis L2
     exists for. A poisoned baseline is worse than no baseline. */
  if (!art.sidecar || art.sidecar.normalizationType === undefined) {
    throw new Error(
      `golden assembly BLESS: refusing to record a baseline without ` +
        `sidecar.normalizationType. The second-pass loudnorm JSON was not ` +
        `parsed (sidecar ${art.sidecar ? `i=${art.sidecar.i}` : 'absent'}). ` +
        `Fix that first — recording now would bake in a hole.`,
    );
  }
  const { target, lra, tp } = resolveLoudnormOptions();
  const floor = 10 ** (-50 / 20);
  const recorded: AssemblyBaseline = {
    recordedAt: new Date().toISOString().slice(0, 10),
    ffmpegBanner: art.banner ?? '',
    ffmpegVersion: parseFfmpegVersion(art.banner ?? ''),
    encode: { format: 'mp3', quality: 2, sampleRate: meta.sampleRate, writeXing: true },
    loudnorm: { target, lra, tp },
    firstPass: {
      input_i: art.firstPass.input_i,
      input_lra: art.firstPass.input_lra,
      input_tp: art.firstPass.input_tp,
      input_thresh: art.firstPass.input_thresh,
    },
    sidecar: {
      i: art.sidecar.i,
      lra: art.sidecar.lra,
      normalizationType: art.sidecar.normalizationType,
    },
    decoded: {
      bytes: art.decoded.length * 2,
      quietWindowsSkipped: art.envelope.filter((v) => v < floor).length,
    },
    envelope100ms: art.envelope,
    mp3Md5: art.mp3Md5,
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(recorded, null, 2)}\n`);
  writeFileSync(DECODED_PATH, Buffer.from(art.decoded.buffer, 0, art.decoded.length * 2));
  console.log(
    `\n[golden-assembly BLESS] wrote:\n` +
      `  ${BASELINE_PATH}\n` +
      `  ${DECODED_PATH} (${art.decoded.length * 2} B)\n` +
      `  ffmpeg: ${art.banner}\n` +
      `  NO assertions ran. Review the diff before committing.\n`,
  );
}
```

Add `parseFfmpegVersion` to the existing `../diagnostics/ffmpeg.js` import, and `selectMode` plus `type AssemblyBaseline` to the `./golden-baseline.js` import.

At the **end** of the `beforeAll` body (after `art = {...}`, still inside the hook but **outside** the `try`/`catch`), add:

```ts
  if (BLESS) {
    writeBaseline();
  } else {
    baseline = loadBaseline();
    /* Announce LOOSE on a PASSING run too. Every other mention of the mode
       lives inside a failure message, so without this an operator running the
       tier on a second ffmpeg build — the owed on-box acceptance — would get
       a green run and no way to tell whether the LOOSE path was even taken. */
    if (!isTight()) {
      console.warn(
        `\n[golden-assembly] LOOSE mode — the ffmpeg banner differs from the ` +
          `baseline's.\n` +
          `  run:      ${art.banner ?? '(absent)'}\n` +
          `  baseline: ${baseline.ffmpegBanner}\n` +
          `  L4 compares decoded RMS-error instead of the MP3 md5. A mismatch ` +
          `here means the comparison is CONFOUNDED, not that anything ` +
          `regressed.\n`,
      );
    }
  }
```

Then guard both existing `it` blocks by adding this as their first line:

```ts
    if (BLESS) return;
```

- [ ] **Step 2: Verify bless writes and asserts nothing**

Run: `npm run test:golden-audio -- --assembly-only --bless`
Expected: PASS with the `[golden-assembly BLESS] wrote:` banner. Then:

```bash
git status --short server/src/tts/__fixtures__/
```
Expected: two new untracked files, `golden-chapter.baseline.json` and `golden-chapter.decoded.pcm`.

- [ ] **Step 3: Sanity-check the recorded values**

```bash
cat server/src/tts/__fixtures__/golden-chapter.baseline.json | head -20
```

Confirm against the Global Constraints: `input_i` ≈ `-21.70`, `sidecar.i` ≈ `-16.28`, `normalizationType` `"dynamic"`, `decoded.bytes` `274432`, `quietWindowsSkipped` `2`, `envelope100ms` length `57`. A wildly different value means a bug in an earlier task — stop and investigate rather than committing it.

- [ ] **Step 4: Verify the assert path works and the missing-baseline guard fires**

Run: `npm run test:golden-audio:assembly` → Expected: PASS (2 tests, baseline now loaded).

Use `git stash` rather than a temp path — it is shell-agnostic (this repo's primary shell is PowerShell, where `/tmp` resolves to `C:\tmp`) and cannot lose the file:

```bash
git stash push -- server/src/tts/__fixtures__/golden-chapter.baseline.json
npm run test:golden-audio:assembly   # Expected: FAIL, "baseline missing at ..." naming the bless command
git stash pop
npm run test:golden-audio:assembly   # Expected: PASS again
```

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/golden-assembly.golden.test.ts server/src/tts/__fixtures__/golden-chapter.baseline.json server/src/tts/__fixtures__/golden-chapter.decoded.pcm
git commit -m "test(server): record the golden-assembly baseline and add the bless branch"
```

---

### Task 8: Layers 1 and 2

**Files:**
- Modify: `server/src/tts/golden-assembly.golden.test.ts`

**Interfaces:**
- Consumes: `art`, `baseline`, `modeLine()`, `TOL`.
- Produces: nothing consumed later.

- [ ] **Step 1: Add the L1 and L2 tests**

Add `TOL` to the `./golden-baseline.js` import, then add these two `it` blocks inside the existing `describe`:

```ts
  it('L1 — ffmpeg first-pass loudnorm measurement matches the baseline', () => {
    if (BLESS) return;
    const b = baseline!.firstPass;
    const a = art.firstPass;
    const fields: [string, number, number][] = [
      ['input_i', a.input_i, b.input_i],
      ['input_lra', a.input_lra, b.input_lra],
      ['input_tp', a.input_tp, b.input_tp],
      ['input_thresh', a.input_thresh, b.input_thresh],
    ];
    for (const [name, actual, expected] of fields) {
      const delta = actual - expected;
      expect(
        Math.abs(delta),
        `L1 first-pass drift: ${name} ${actual} (baseline ${expected}, ` +
          `delta ${delta.toFixed(2)} LU, tol ${TOL.firstPassLu})${modeLine()}`,
      ).toBeLessThanOrEqual(TOL.firstPassLu);
    }
  });

  it('L2 — the persisted loudness sidecar matches the baseline', () => {
    if (BLESS) return;
    expect(
      art.sidecar,
      `L2: no ${SLUG}.lufs.json was written at all. The encoder skips the ` +
        `sidecar when the FIRST pass is unusable (silent/near-silent input), ` +
        `so this points at the fixture or at loudnorm, not at a mode ` +
        `change.${modeLine()}`,
    ).not.toBeNull();

    const b = baseline!.sidecar;
    const s = art.sidecar!;

    /* Knob check first: a moved target produces the same symptom as ffmpeg
       drift, and the two are different bugs. */
    const knobs = resolveLoudnormOptions();
    expect(
      { target: knobs.target, lra: knobs.lra, tp: knobs.tp },
      `L2: the loudnorm knobs differ from the baseline's. This is a CONFIG ` +
        `change, not ffmpeg drift — re-bless deliberately.${modeLine()}`,
    ).toEqual(baseline!.loudnorm);

    for (const [name, actual, expected] of [
      ['i', s.i, b.i],
      ['lra', s.lra, b.lra],
    ] as [string, number, number][]) {
      const delta = actual - expected;
      expect(
        Math.abs(delta),
        `L2 sidecar drift: ${name} ${actual} (baseline ${expected}, ` +
          `delta ${delta.toFixed(2)} LU, tol ${TOL.sidecarLu})${modeLine()}`,
      ).toBeLessThanOrEqual(TOL.sidecarLu);
    }

    /* Asserted UNCONDITIONALLY — `twoPass === true` does NOT imply a mode is
       present (mp3.ts stamps twoPass before the encode and the fallback
       branches leave it untouched), so gating on twoPass would silently skip
       this. Absence is a DIFFERENT bug from a flip, and gets its own text. */
    expect(
      s.normalizationType,
      s.normalizationType === undefined
        ? `L2: normalizationType is absent (baseline "${b.normalizationType}").\n` +
          `  This is NOT a mode flip. The sidecar fell back to the input-side ` +
          `measurement, which means the second-pass loudnorm stderr JSON was ` +
          `not parsed — most likely an ffmpeg log-format change. Check \`i\`: ` +
          `it will read ~${baseline!.firstPass.input_i} (input side) rather ` +
          `than ~${b.i} (output side).${modeLine()}`
        : `L2: loudnorm mode changed — "${s.normalizationType}" vs baseline ` +
          `"${b.normalizationType}". A dynamic->linear flip alters how the ` +
          `chapter sounds while leaving integrated loudness near ` +
          `target.${modeLine()}`,
    ).toBe(b.normalizationType);
  });
```

- [ ] **Step 2: Run the tier**

Run: `npm run test:golden-audio:assembly`
Expected: PASS, 4 tests.

- [ ] **Step 3: Prove L2 can fail**

Temporarily edit `server/src/tts/__fixtures__/golden-chapter.baseline.json`, changing `sidecar.i` from `-16.28` to `-14.00`, then:

Run: `npm run test:golden-audio:assembly`
Expected: FAIL with `L2 sidecar drift: i -16.28 (baseline -14, delta -2.28 LU, tol 0.3)` plus the mode/bless lines.

Revert the edit: `git checkout server/src/tts/__fixtures__/golden-chapter.baseline.json`, and re-run to confirm PASS.

- [ ] **Step 4: Commit**

```bash
git add server/src/tts/golden-assembly.golden.test.ts
git commit -m "test(server): assert golden-assembly layers 1 and 2 against the baseline"
```

---

### Task 9: Layers 3 and 4

**Files:**
- Modify: `server/src/tts/golden-assembly.golden.test.ts`

**Interfaces:**
- Consumes: `art`, `baseline`, `modeLine()`, `isTight()`, `TOL`, `compareEnvelope`, `rmsError`, `toInt16`.
- Produces: nothing consumed later.

- [ ] **Step 1: Add the L3 and L4 tests, and drop the superseded band**

Add `compareEnvelope` and `rmsError` to the `./golden-baseline.js` import. **Delete** the three superseded lines from the `finalizeChapterAudioWrite writes the audio and its sidecars` test (the `expect(art.sidecar).not.toBeNull()` / `toBeGreaterThan(-30)` / `toBeLessThan(-10)` block and its comment) — L2 supersedes them. Then add:

```ts
  it('L3 — decoded length is exact and the RMS envelope matches', () => {
    if (BLESS) return;
    const bytes = art.decoded.length * 2;
    expect(
      bytes,
      `L3: decoded length ${bytes} B vs baseline ${baseline!.decoded.bytes} B. ` +
        `The encode/decode round-trip is length-preserving from a seekable ` +
        `input, so a change here is a duration/resampler change, not codec ` +
        `noise.${modeLine()}`,
    ).toBe(baseline!.decoded.bytes);

    const v = compareEnvelope(baseline!.envelope100ms, art.envelope);

    /* The skipped set must not silently grow: a regression that quietens a
       loud window would otherwise escape through the -50 dBFS floor. */
    expect(
      v.skipped,
      `L3: ${v.skipped} window(s) fell below ${TOL.quietFloorDbfs} dBFS on one ` +
        `side or the other; the baseline recorded ` +
        `${baseline!.decoded.quietWindowsSkipped}. A changed count means the ` +
        `audio got quieter or louder somewhere, which is itself the ` +
        `regression.${modeLine()}`,
    ).toBe(baseline!.decoded.quietWindowsSkipped);

    expect(
      v.ok,
      `L3 envelope drift: ${(v.worstRelDelta * 100).toFixed(1)} % at window ` +
        `${v.worstIndex} (t=${v.worstAtSec.toFixed(1)}s), tol ` +
        `${TOL.envelopeRel * 100} %. ${v.skipped} quiet window(s) ` +
        `skipped.${modeLine()}`,
    ).toBe(true);
  });

  it('L4 — the encoded MP3 matches the baseline', () => {
    if (BLESS) return;
    if (isTight()) {
      /* Same ffmpeg build: the encode is byte-identical across runs, so this
         is exact. Strongest assertion in the tier. */
      expect(
        art.mp3Md5,
        `L4 (TIGHT): MP3 md5 ${art.mp3Md5} vs baseline ${baseline!.mp3Md5}. ` +
          `The ffmpeg banner matches the baseline exactly, so the encode ` +
          `should be byte-identical — this is a real output change.${modeLine()}`,
      ).toBe(baseline!.mp3Md5);
      return;
    }

    /* Different build: LAME framing legitimately varies, so compare the
       decoded audio instead. This is the WEAKEST layer — its threshold is
       calibrated on encoder-quality steps as a proxy for a build change, and
       its noise floor (10.55 %) and target signal (24.79 %) are only 2.35x
       apart. L3's envelope is the sound LOOSE instrument. */
    const ref = toInt16(readFileSync(DECODED_PATH));
    /* L3 owns the length assertion, but L3 and L4 are deliberately independent
       `it`s — so if L3 failed, L4 would silently compare truncated arrays and
       report a reassuring number. Assert it here too. */
    expect(
      ref.length,
      `L4 (LOOSE): the reference PCM is ${ref.length} samples but this run ` +
        `decoded ${art.decoded.length}. RMS-error over a truncated overlap is ` +
        `meaningless — see L3 for the real verdict.${modeLine()}`,
    ).toBe(art.decoded.length);
    const err = rmsError(ref, art.decoded);
    expect(
      err,
      `L4 (LOOSE): decoded RMS-error ${(err * 100).toFixed(2)} % vs tol ` +
        `${TOL.rmseLoose * 100} %. Note this layer cannot see drift below ` +
        `~1.2 LU — L1 covers that range at +/-0.1 LU.${modeLine()}`,
    ).toBeLessThan(TOL.rmseLoose);
  });
```

- [ ] **Step 2: Run the tier**

Run: `npm run test:golden-audio:assembly`
Expected: PASS, 6 tests. On this box the banner matches the baseline, so L4 takes the TIGHT path.

- [ ] **Step 3: Prove L3 and L4 can fail**

Force the LOOSE path and a real audio change at once by editing the baseline's `ffmpegBanner` to `"ffmpeg version 0.0-fake"` **and** `loudnorm.target` stays as-is while you temporarily set `AUDIO_LOUDNORM_TARGET_LUFS=-14` in the environment:

```bash
# L4 LOOSE + L3 envelope, via a 2 LU loudnorm drift.
# The env key is AUDIO_LOUDNORM_TARGET (registry.ts:905) — NOT ..._TARGET_LUFS.
AUDIO_LOUDNORM_TARGET=-14 npm run test:golden-audio:assembly
```

Expected: FAIL on L2 (knob check), L3 (`~38.7 %` at some window) and L4 LOOSE or TIGHT (`~24.8 %` / md5 mismatch). Confirm each message is readable and names the bless command.

Revert: `git checkout server/src/tts/__fixtures__/golden-chapter.baseline.json` and re-run clean → PASS.

- [ ] **Step 4: Confirm the tier is still opt-in**

```bash
# Expected: "No test files found, exiting with code 1" — exit 1 is the PASS
# condition (the config excludes the file), so npm's ERR! block is expected.
npm --prefix server run test -- --run golden-assembly
# Expected: hits only the three test:golden-audio* script definitions, no CI.
grep -rn "test:golden" .github/workflows/ package.json
```

- [ ] **Step 5: Commit**

```bash
git add server/src/tts/golden-assembly.golden.test.ts
git commit -m "test(server): assert golden-assembly layers 3 and 4 against the baseline"
```

---

### Task 10: Prove the suite can fail — the demonstration

A green run proves nothing here; passing is what the tier already did. This task produces the evidence table for the PR body.

**Files:** none committed. Output is the PR-body table.

- [ ] **Step 1: Run each perturbation and record the actual output**

For each row: apply the perturbation, run `npm run test:golden-audio:assembly`, copy the failure message, then revert.

| layer | perturbation | expected |
|---|---|---|
| L1 | `-3 dB` gain applied to a scratch copy of `golden-chapter.pcm` (**not** a single flipped byte — one sample in 137 216 moves `input_i` far below ±0.1 LU, so the demo would show L1 *passing*) | `input_i` moves ≈3 LU |
| L2 | move the `audio.loudnorm.targetLufs` knob | knob-check message fires, naming it as a config change |
| L2 | hand-edit the baseline's `sidecar.normalizationType` to `"linear"` | the mode-flip message, not the absence message |
| L3 | 2.0 LU loudnorm drift | worst window ≈38.7 % > 10 % |
| L4-tight | re-encode at `-q:a 3` (temporarily change the `quality` in `finalizeChapterAudioWrite`'s call) | md5 differs |
| L4-loose | baseline `ffmpegBanner` faked + 2.0 LU drift | rmse ≈24.8 % > 16 % |

- [ ] **Step 2: Verify the tree is clean afterwards**

```bash
git status --short
```
Expected: empty. Every perturbation must be reverted.

- [ ] **Step 3: Save the table**

Write the six captured failure messages into the PR body draft. No commit.

---

### Task 11: Documentation, backlog, and the follow-up issue

**Files:**
- Create: `docs/features/272-golden-assembly-comparison.md` (from `docs/features/TEMPLATE.md`)
- Modify: `docs/features/INDEX.md` (entry under ops)
- Modify: `docs/features/269-ffmpeg-version-floor.md` (cross-link to 272; **fix the dead link at line 28** — `archive/185-golden-audio.md` does not exist, the file is `archive/185-golden-audio-regression.md`)
- Modify: `docs/features/archive/185-golden-audio-regression.md` (pointer to 272)
- Modify: `CLAUDE.md` (Commands section — `--bless` is suite-scoped; note the `:assembly` alias cannot bless)
- Modify: `docs/release-notes-next.md` (one line for the `--bless` behaviour change)
- Modify: `docs/testing/onbox-acceptance-register.md` (one row)
- Modify: `docs/BACKLOG.md` (thin row for the follow-up issue)

- [ ] **Step 1: Write plan 272**

Copy `docs/features/TEMPLATE.md`, set `status: active`, and document: the four layers with their derived tolerances and the curve they came from; the TIGHT/LOOSE version gate and the **unproven bet** that L1–L3 stay hard across builds; the bless recipe (full-runner form only); the `normalizationType` migration including that absence is meaningful and `relufs-existing.mjs` legitimately omits it; and the pin risk — `dynamic` is locked in as the baseline, which is correct for a regression harness but must not become the specification.

- [ ] **Step 2: The four cross-link edits**

**`docs/features/INDEX.md`** — add under the ops area, matching the surrounding row format:

> `272-golden-assembly-comparison.md` — golden-audio assembly tier compares real output against a recorded, ffmpeg-stamped baseline (ops-36)

**`docs/features/269-ffmpeg-version-floor.md`** — two edits. Add `272` to the `Related:` line, and **fix the dead link at `:27-28`**: `archive/185-golden-audio.md` does not exist; the file is `archive/185-golden-audio-regression.md`. Both the link text and the target need correcting.

**`docs/features/archive/185-golden-audio-regression.md`** — one line under its status block:

> **Follow-up (2026-07-28):** Suite B's assembly tier compared no output bytes until ops-36; the four-layer comparison and its baseline live in [`272-golden-assembly-comparison.md`](../272-golden-assembly-comparison.md).

**`CLAUDE.md`** — in the Commands section, the `test:golden-audio` bullet currently describes `--bless` as "re-records `kokoro-baseline.json` after a fixture/model change". Replace that clause with:

> `--bless` (re-records the baselines of the **selected** suites — bare `--bless` does both, `--assembly-only --bless` records Suite B's `golden-chapter.baseline.json` + `.decoded.pcm`, `--sidecar-only --bless` records `kokoro-baseline.json`; note `npm run test:golden-audio:assembly` bypasses the runner and so can never bless)

- [ ] **Step 3: Release notes**

Append one line to `docs/release-notes-next.md` under the current in-progress section, in the file's existing PR-refed style:

> - `golden-audio`: the assembly tier now compares its output against a recorded, ffmpeg-stamped baseline across four layers instead of a 20-LU tolerance band; `--bless` is now suite-scoped (#PR)

**Do not** add anything to `RELEASE_NOTES.md`, and say so explicitly in the PR body: golden-audio is a dev-only opt-in tier absent from the release artifact, so there is no user-facing delta. (Before-shipping step 5 requires the skip be stated, not silently taken.)

- [ ] **Step 4: Add the on-box acceptance row**

In `docs/testing/onbox-acceptance-register.md`, add:

> **ops-36 — golden-assembly on a second ffmpeg build.** Run `npm run test:golden-audio:assembly` on a box whose `ffmpeg -version` banner differs from the baseline's. Record: which of L1/L2/L3 fire and their deltas; whether L4 took the LOOSE path; and L4-loose's actual RMS-error. **Why owed:** the entire cross-build half of the design — the LOOSE branch, the mismatch warning, and whether L1–L3's hard assertions survive another build — cannot be exercised on a box with one ffmpeg, and the tier sits outside `verify.yml`, so CI never runs it. The LOOSE path ships having never executed. Criteria: `docs/features/272-golden-assembly-comparison.md`.

- [ ] **Step 5: File the follow-up issue and its backlog row**

```bash
gh issue create --title "srv-NN — loudnorm falls back to dynamic mode and compresses LRA 3.00 -> 0.50" --label "type:chore,area:srv" --body "..."
```

Body must record: `linear=true` is requested (`loudnorm.ts:293`) but the fixture's `-4.15` dBTP true peak means the +5.70 dB to reach `-16` LUFS would breach the `-1.5` ceiling, so ffmpeg falls back to `dynamic` and compresses **LRA 3.00 → 0.50**; that ops-36 **pins this as the baseline**, locking in behaviour that may be wrong; and that settling it needs listening, not arithmetic. Then add the thin row to `docs/BACKLOG.md` linking the issue.

- [ ] **Step 6: Run the branch battery**

Run: `npm run verify:fast:branch`
Expected: PASS. (The golden tier is not in it — by design.)

- [ ] **Step 7: Commit**

```bash
git add docs/ CLAUDE.md
git commit -m "docs(docs): add plan 272 for the golden-assembly output comparison"
```

---

## Self-review notes

**Spec coverage.** L1/L2/L3/L4 → Tasks 8-9; derived tolerances → Task 1 (`TOL`); the file-decode decision → Task 2; `ffmpegBannerLine` → Task 3; the sidecar widening with its four verified surfaces and the OpenAPI description fix → Task 4; suite-scoped bless → Task 5; the `beforeAll` restructure, the hook-failure wrapper, the timeout budget, and deleting the inert `WORKSPACE_DIR` pair → Task 6; bless ordering and the missing-baseline hard fail → Task 7; the `twoPass` trap and the absence diagnosis → Tasks 4 and 8; the demonstration → Task 10; all eight doc surfaces plus the follow-up issue and its BACKLOG row → Task 11.

**Deliberately not done:** the `linear`→`dynamic` fallback (filed in Task 11); routing `test:golden-audio:assembly` through the runner (Task 5 leaves the alias alone so the on-box acceptance recipe keeps working).

**Verified while writing:** the `audio.loudnorm.targetLufs` env key is `AUDIO_LOUDNORM_TARGET` (`server/src/config/registry.ts:905`); `scripts/tests/*.test.mjs` run under `npm run test:hooks` via `node --test`; `server/vitest.config.ts` excludes `src/**/*.golden.test.ts` so `golden-baseline.test.ts` gates on every push while the golden tier stays opt-in; and `mp3-spawn-args.test.ts`'s existing second-pass fixture already carries `"normalization_type" : "linear"`, so Task 4's success-path assertion needs no new fixture.

**Fixed after an adversarial review of this plan** — each was a real defect, not a style note:

- `compareEnvelope` took an unused `sampleRate`, which `noUnusedParameters` (`server/tsconfig.json:11`) rejects. Vitest does not typecheck, so Task 1 would have gone green and the failure would have surfaced three commits later. Parameter dropped; a typecheck step added to Task 1.
- Task 3's test assumed real ffmpeg, but `ffmpeg.test.ts:15` mocks `node:child_process` and resets it per-test — the test could never have passed. Rewritten onto the file's existing `bins()` helper, which also exercises the multi-line split a real banner check cannot.
- Task 5's header regex could not match the header Task 5 itself writes (`suite` and `selection` fell on different lines). Header reflowed.
- The spec's "TIGHT/LOOSE branch selection is unit-tested" was implemented nowhere: `isTight` was local to the opt-in golden file, so on any one box the other arm never runs. Extracted to `selectMode()` in `golden-baseline.ts` with unit cases.
- The spec's LOOSE-path `console.warn` existed only inside failure messages, so a **passing** LOOSE run printed nothing — which would have silently defeated the owed on-box acceptance row. Added to `beforeAll`.
- Task 6 claimed "no assertion changes" while dropping the `finalizeChapterAudioWrite` result binding and with it the repo's only coverage of `segmentCount`/`durationSec`. Binding kept and both re-asserted.
- Two verification steps expected "no test files matched" from a command that exits **1**; a subagent would read that as a failed step. Stated that exit 1 is the pass condition.
- Task 11 listed eight doc surfaces and gave steps for three. All eight now have concrete wording.
- `writeBaseline` would have recorded `normalizationType: undefined` on a parse failure, and L2 would then compare `undefined === undefined` and pass forever — defeating the exact diagnosis L2 exists for. It now throws.
- Smaller: a `console.warn` spy on Task 4's fallback test, `git stash` instead of a bash-only `/tmp` round-trip, an L4-loose length guard (L3 and L4 are independent `it`s, so a length change would otherwise let L4 compare truncated arrays), a time-shifted envelope case, and corrected `openapi.yaml` / `mp3.ts` anchors.
- The `encode` baseline block was described as guarding a changed encode parameter; it cannot, since `finalizeChapterAudioWrite` hardcodes `-q:a` internally. Re-labelled provenance-only, with L4-tight's md5 named as the actual guard.
