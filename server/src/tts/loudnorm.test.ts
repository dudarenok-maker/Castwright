/* Real-ffmpeg integration test for the EBU R128 two-pass loudnorm path
   (plan 71). Skips when ffmpeg is missing, mirroring `mp3.test.ts` so a
   CI box without ffmpeg gets a loud SKIP banner rather than a red suite.

   Unit tests for `parseLoudnormFirstPassJson` + `buildSecondPassFilterString`
   run unconditionally — they're pure parsing / string-building. */

import { spawn, spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import {
  buildSecondPassFilterString,
  buildSinglePassFilterString,
  isMeasurementUseable,
  parseLoudnormFirstPassJson,
  runLoudnormFirstPass,
  DEFAULT_LOUDNORM_OPTIONS,
  type LoudnormFirstPassStats,
  type LoudnormOptions,
} from './loudnorm.js';
import { encodePcmToAudio } from './mp3.js';

const ffmpegPresent = (() => {
  try {
    const result = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return result.status === 0;
  } catch {
    return false;
  }
})();

const describeIfFfmpeg = ffmpegPresent ? describe : describe.skip;

/* Build a sine-wave PCM buffer at a given amplitude. Two-segment concatenation
   (loud + quiet) lets us force a non-trivial loudness range so the two-pass
   measurement has something to work with. */
function sinePcm(sampleRate: number, seconds: number, freq: number, amp: number): Buffer {
  const sampleCount = Math.floor(sampleRate * seconds);
  const buf = Buffer.alloc(sampleCount * 2);
  for (let i = 0; i < sampleCount; i += 1) {
    const sample = Math.round(amp * Math.sin((2 * Math.PI * freq * i) / sampleRate));
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, sample)), i * 2);
  }
  return buf;
}

/* Decode an MP3 buffer back to int16 LE mono PCM via ffmpeg, then run
   ffmpeg's `ebur128` filter on it and parse the integrated-loudness line
   from the summary. Used to verify the loudnorm output actually lands near
   the target after a round-trip through the encoder. */
async function measureMp3Loudness(mp3: Buffer): Promise<number> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    'pipe:0',
    '-filter_complex',
    'ebur128=peak=true',
    '-f',
    'null',
    '-',
  ];
  return await new Promise<number>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    const stderrChunks: Buffer[] = [];
    child.stderr.on('data', (c) => stderrChunks.push(c));
    child.on('error', reject);
    child.on('close', (code) => {
      const stderr = Buffer.concat(stderrChunks).toString('utf8');
      if (code !== 0) {
        reject(new Error(`ffmpeg ebur128 measurement failed: ${stderr.trim()}`));
        return;
      }
      /* ffmpeg's ebur128 emits per-frame "I: <value> LUFS" lines AND a
         summary block at the end containing the integrated loudness. The
         per-frame values are intermediate (and can be -inf / extreme during
         the gate ramp-up) — we want the final summary value, which lives
         under "Integrated loudness:" then "I: <value> LUFS" on the next
         line. Scope the regex to that block so we don't accidentally pick
         up an early frame's measurement. */
      const summaryIdx = stderr.lastIndexOf('Integrated loudness:');
      if (summaryIdx < 0) {
        reject(new Error(`ebur128 output had no "Integrated loudness:" block. stderr: ${stderr}`));
        return;
      }
      const summary = stderr.slice(summaryIdx);
      const match = summary.match(/I:\s*(-?[0-9.]+)\s*LUFS/);
      if (!match) {
        reject(
          new Error(`ebur128 summary block had no "I:" line. summary: ${summary.slice(0, 400)}`),
        );
        return;
      }
      resolve(Number(match[1]));
    });
    child.stdin.on('error', (err) => {
      if ((err as NodeJS.ErrnoException).code !== 'EPIPE') reject(err);
    });
    child.stdin.end(mp3);
  });
}

describe('parseLoudnormFirstPassJson', () => {
  it('parses a real-shape ffmpeg JSON block (string-encoded numbers)', () => {
    /* Verbatim shape ffmpeg emits — every field is a string, leading/trailing
       whitespace, optional "+inf" / "-inf" we coerce as needed. */
    const json = `{
        "input_i" : "-22.50",
        "input_tp" : "-2.13",
        "input_lra" : "9.40",
        "input_thresh" : "-32.50",
        "output_i" : "-16.00",
        "output_tp" : "-1.50",
        "output_lra" : "5.20",
        "output_thresh" : "-26.00",
        "normalization_type" : "dynamic",
        "target_offset" : "6.45"
    }`;
    const stats = parseLoudnormFirstPassJson(json);
    expect(stats).toEqual<LoudnormFirstPassStats>({
      input_i: -22.5,
      input_lra: 9.4,
      input_tp: -2.13,
      input_thresh: -32.5,
      target_offset: 6.45,
    });
  });

  it('throws on missing fields rather than silently producing NaN', () => {
    const json = `{ "input_i": "-22.5", "input_lra": "9.4" }`;
    expect(() => parseLoudnormFirstPassJson(json)).toThrow(/input_tp/);
  });

  it('coerces "-inf" / "+inf" to -Infinity / Infinity (silent-input case)', () => {
    /* ffmpeg emits "-inf" for input_i / input_tp when the source is dead
       silent. Parse passes the non-finite values through so the caller
       can detect the silent case via `isMeasurementUseable` rather than
       eating an unrelated parse error. */
    const json = `{
      "input_i": "-inf",
      "input_lra": "0.0",
      "input_tp": "-inf",
      "input_thresh": "-70.0",
      "target_offset": "0.0"
    }`;
    const stats = parseLoudnormFirstPassJson(json);
    expect(stats.input_i).toBe(-Infinity);
    expect(stats.input_tp).toBe(-Infinity);
    expect(stats.input_lra).toBe(0);
  });

  it('throws on non-numeric string values that are not inf/Infinity', () => {
    const json = `{
      "input_i": "not-a-number",
      "input_lra": "9.4",
      "input_tp": "-2.1",
      "input_thresh": "-30",
      "target_offset": "1.0"
    }`;
    expect(() => parseLoudnormFirstPassJson(json)).toThrow(/input_i/);
  });
});

describe('isMeasurementUseable', () => {
  it('returns true when every field is finite', () => {
    expect(
      isMeasurementUseable({
        input_i: -22.5,
        input_lra: 9.4,
        input_tp: -2.1,
        input_thresh: -32.5,
        target_offset: 6.45,
      }),
    ).toBe(true);
  });

  it('returns false when input_i is -Infinity (silent source)', () => {
    expect(
      isMeasurementUseable({
        input_i: -Infinity,
        input_lra: 0,
        input_tp: -Infinity,
        input_thresh: -70,
        target_offset: 0,
      }),
    ).toBe(false);
  });
});

describe('buildSecondPassFilterString', () => {
  it('threads first-pass measurements + target opts into a single -af string', () => {
    const stats: LoudnormFirstPassStats = {
      input_i: -22.5,
      input_lra: 9.4,
      input_tp: -2.13,
      input_thresh: -32.5,
      target_offset: 6.45,
    };
    const opts: LoudnormOptions = { target: -16, lra: 11, tp: -1.5, twoPass: true };
    const filter = buildSecondPassFilterString(stats, opts);
    expect(filter).toBe(
      'loudnorm=I=-16:LRA=11:TP=-1.5' +
        ':measured_I=-22.5:measured_LRA=9.4:measured_TP=-2.13' +
        ':measured_thresh=-32.5:offset=6.45:linear=true:print_format=summary',
    );
  });
});

describe('buildSinglePassFilterString', () => {
  it('omits measured_* fields (single-pass needs no analysis)', () => {
    const filter = buildSinglePassFilterString({
      target: -16,
      lra: 11,
      tp: -1.5,
      twoPass: false,
    });
    expect(filter).toBe('loudnorm=I=-16:LRA=11:TP=-1.5:linear=true');
    expect(filter).not.toContain('measured_');
  });
});

describeIfFfmpeg('runLoudnormFirstPass (real ffmpeg)', () => {
  it('returns finite stats for a non-silent input', async () => {
    /* 1 s of moderately-loud 440 Hz tone — louder than the -16 LUFS target
       so the measurement clearly isn't degenerate (ffmpeg emits "-inf" for
       silent inputs which we surface as a parse error). */
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 1.5, 440, 16000);
    const stats = await runLoudnormFirstPass(pcm, sampleRate, DEFAULT_LOUDNORM_OPTIONS);
    expect(Number.isFinite(stats.input_i)).toBe(true);
    expect(Number.isFinite(stats.input_lra)).toBe(true);
    expect(Number.isFinite(stats.input_tp)).toBe(true);
    expect(Number.isFinite(stats.input_thresh)).toBe(true);
    expect(Number.isFinite(stats.target_offset)).toBe(true);
    /* A 16000-amplitude sine at 24 kHz lands somewhere in the -9 to -3 LUFS
       range — definitely above the -16 target and definitely below 0. */
    expect(stats.input_i).toBeLessThan(0);
    expect(stats.input_i).toBeGreaterThan(-20);
  }, 30_000);
});

describeIfFfmpeg('encodePcmToAudio with two-pass loudnorm (real ffmpeg)', () => {
  it('shifts a non-normalised input significantly toward the target', async () => {
    /* Concatenate a loud + quiet segment so the source has both a non-trivial
       integrated loudness and some loudness range. We don't assert tight
       convergence on ±0.5 LU because the gated EBU R128 integration window
       (3 s blocks, 75 % overlap) needs longer / more realistic content than
       a synthetic sine-pair to settle precisely on target. Instead, assert
       the LOUDNORM PASS NUDGED THE OUTPUT TOWARD -16: a never-normalised
       baseline encode of the same PCM lands well above -16 (the loud half
       dominates), and the loudnormed encode must land closer to -16 than
       that baseline by a clear margin. */
    const sampleRate = 24_000;
    const loud = sinePcm(sampleRate, 2.5, 440, 24000);
    const quiet = sinePcm(sampleRate, 2.5, 660, 3000);
    const pcm = Buffer.concat([loud, quiet]);

    const baseline = await encodePcmToAudio(pcm, sampleRate, { quality: 2 });
    const normalised = await encodePcmToAudio(pcm, sampleRate, {
      quality: 2,
      loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: true },
    });
    expect(normalised.length).toBeGreaterThan(1024);
    expect(baseline.length).toBeGreaterThan(1024);

    const baselineLoudness = await measureMp3Loudness(baseline);
    const normalisedLoudness = await measureMp3Loudness(normalised);

    /* The baseline (un-normalised) is louder than the target (a -6 dBFS sine
       integrates well above -16 LUFS); the normalised encode must be CLOSER
       to -16 than the baseline. We allow a generous ±3 LU window for the
       normalised path — synthetic sine-pair material with a near-zero LRA
       confuses the loudnorm gain estimator more than real speech does. */
    expect(Math.abs(normalisedLoudness - -16)).toBeLessThan(
      Math.abs(baselineLoudness - -16),
    );
    expect(Math.abs(normalisedLoudness - -16)).toBeLessThan(3);
  }, 60_000);

  it('fires onLoudnessMeasured AFTER a successful encode with two-pass stats', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 1.0, 440, 16000);
    const captured: unknown[] = [];
    await encodePcmToAudio(pcm, sampleRate, {
      quality: 2,
      loudnorm: DEFAULT_LOUDNORM_OPTIONS,
      onLoudnessMeasured: (stats) => {
        captured.push(stats);
      },
    });
    expect(captured).toHaveLength(1);
    const stats = captured[0] as {
      i: number;
      lra: number;
      tp: number;
      target: number;
      twoPass: boolean;
      measuredAt: string;
    };
    expect(stats.target).toBe(-16);
    expect(stats.twoPass).toBe(true);
    expect(Number.isFinite(stats.i)).toBe(true);
    expect(Number.isFinite(stats.lra)).toBe(true);
    expect(Number.isFinite(stats.tp)).toBe(true);
    expect(typeof stats.measuredAt).toBe('string');
    expect(stats.measuredAt).toMatch(/\dT\d/);
  }, 60_000);
});

describeIfFfmpeg('encodePcmToAudio with silent PCM + two-pass loudnorm (real ffmpeg)', () => {
  it('falls back to a plain encode + skips the sidecar when input is silent', async () => {
    /* Dead silence — ffmpeg's first pass returns input_i = -inf. The
       encoder must NOT pass that into the second-pass filter (which would
       fail) and must NOT fire onLoudnessMeasured (no real measurement to
       record). Confirms the silent-input fallthrough path is wired. */
    const sampleRate = 24_000;
    const pcm = Buffer.alloc(sampleRate * 1.0 * 2); // 1 s of silence
    let callbackFired = false;
    const mp3 = await encodePcmToAudio(pcm, sampleRate, {
      quality: 2,
      loudnorm: DEFAULT_LOUDNORM_OPTIONS,
      onLoudnessMeasured: () => {
        callbackFired = true;
      },
    });
    expect(mp3.length).toBeGreaterThan(0);
    expect(callbackFired).toBe(false);
  }, 30_000);
});

describeIfFfmpeg('encodePcmToAudio with single-pass loudnorm (real ffmpeg)', () => {
  it('produces a valid MP3 and reports nominal target as the measurement', async () => {
    const sampleRate = 24_000;
    const pcm = sinePcm(sampleRate, 1.0, 440, 16000);
    let received: { i: number; twoPass: boolean; target: number } | null = null;
    const mp3 = await encodePcmToAudio(pcm, sampleRate, {
      quality: 2,
      loudnorm: { target: -16, lra: 11, tp: -1.5, twoPass: false },
      onLoudnessMeasured: (stats) => {
        received = stats;
      },
    });
    expect(mp3.length).toBeGreaterThan(1024);
    expect(received).not.toBeNull();
    /* Single-pass: we don't re-measure, so the sidecar carries the target
       as the (assumed-achieved) i; consumers know it's nominal via twoPass=false. */
    expect(received!.twoPass).toBe(false);
    expect(received!.i).toBe(-16);
    expect(received!.target).toBe(-16);
  }, 30_000);
});

if (!ffmpegPresent) {
  // eslint-disable-next-line no-console
  console.warn(
    '[loudnorm.test.ts] ffmpeg not found on PATH — skipping loudnorm integration tests. ' +
      'Install: winget install Gyan.FFmpeg',
  );
}
