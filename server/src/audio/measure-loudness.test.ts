/* ebur128 summary parsing + one real-ffmpeg integration case. The parser is
   pure so the drift-prone part (ffmpeg's log shape) is pinned without a
   subprocess; the integration case proves the wiring end to end. */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { parseEbur128Summary, measureLoudnessFile } from './measure-loudness.js';

/* Captured verbatim from ffmpeg 8.1.1 running ebur128 over the golden fixture's
   encoded output — not hand-written. Note `LRA low:` / `LRA high:` share a
   prefix with `LRA:` and must NOT be picked up by the LRA pattern. */
const SUMMARY = `[Parsed_ebur128_0 @ 0000] Summary:

  Integrated loudness:
    I:         -16.2 LUFS
    Threshold: -26.3 LUFS

  Loudness range:
    LRA:         1.7 LU
    Threshold: -35.8 LUFS
    LRA low:   -16.9 LUFS
    LRA high:  -15.2 LUFS

  True peak:
    Peak:       -1.2 dBFS
`;

/* Per-line-prefixed form — documented verbatim as "Format (real example)" in
   scripts/relufs-existing.mjs (plan 71): every summary line carries its own
   `[Parsed_ebur128_0 @ 0x...]` prefix, rather than one banner line before an
   unprefixed block. ffmpeg emits both shapes depending on build/log
   plumbing; the unprefixed SUMMARY above must not be the only one covered. */
const PREFIXED_SUMMARY = `[Parsed_ebur128_0 @ 0x55] Summarizing
[Parsed_ebur128_0 @ 0x55]   Integrated loudness:
[Parsed_ebur128_0 @ 0x55]     I:         -16.0 LUFS
[Parsed_ebur128_0 @ 0x55]     Threshold: -26.1 LUFS
[Parsed_ebur128_0 @ 0x55]   Loudness range:
[Parsed_ebur128_0 @ 0x55]     LRA:        8.4 LU
[Parsed_ebur128_0 @ 0x55]     Threshold: -36.1 LUFS
[Parsed_ebur128_0 @ 0x55]     LRA low:   -21.0 LUFS
[Parsed_ebur128_0 @ 0x55]     LRA high:  -12.6 LUFS
[Parsed_ebur128_0 @ 0x55]   True peak:
[Parsed_ebur128_0 @ 0x55]     Peak:      -1.5 dBFS
`;

describe('parseEbur128Summary', () => {
  it('extracts I, LRA and true peak from a real summary block', () => {
    expect(parseEbur128Summary(SUMMARY)).toEqual({ i: -16.2, lra: 1.7, tp: -1.2 });
  });

  it('returns null when the summary is absent rather than throwing', () => {
    // A failed/short render must degrade to "no measurement", never crash the
    // finalize path — the audio is already on disk by then.
    expect(parseEbur128Summary('ffmpeg version 8.1\nno summary here')).toBeNull();
  });

  it('returns null on a partial summary', () => {
    expect(parseEbur128Summary('  I:  -16.2 LUFS\n')).toBeNull();
  });

  it('does not mistake "LRA low:" / "LRA high:" for the LRA value', () => {
    const noLra = SUMMARY.replace(/^\s*LRA:\s*1\.7 LU\s*$/m, '');
    expect(parseEbur128Summary(noLra)).toBeNull();
  });

  it('handles -inf on silent input', () => {
    const silent = SUMMARY.replace('-16.2 LUFS', '-inf LUFS');
    expect(parseEbur128Summary(silent)).toBeNull();
  });

  it('parses the per-line-prefixed summary shape (finding F1)', () => {
    // Anchored `^...$` patterns never match this shape — every line carries
    // its own `[Parsed_ebur128_0 @ 0x...]` prefix, so `^\s*I:` never lands
    // at the start of a line. This is the exact defect ops-36 exists to fix:
    // an ffmpeg emitting this shape must not silently fall back to
    // loudnorm's self-reported (pre-fix) figures.
    expect(parseEbur128Summary(PREFIXED_SUMMARY)).toEqual({ i: -16.0, lra: 8.4, tp: -1.5 });
  });

  it('parses a dBTP-labelled peak, not just dBFS', () => {
    const dbtp = SUMMARY.replace('-1.2 dBFS', '-1.2 dBTP');
    expect(parseEbur128Summary(dbtp)).toEqual({ i: -16.2, lra: 1.7, tp: -1.2 });
  });

  it('scopes the peak match to the True-peak section, not an earlier Sample-peak block', () => {
    // Today's `peak=true` arg emits only the true-peak block, but a summary
    // with `peak=sample+true` would emit a "Sample peak:" block first. The
    // parser must report the TRUE peak, not the sample peak that precedes it.
    const withSamplePeak = SUMMARY.replace(
      '\n  True peak:',
      '\n  Sample peak:\n    Peak:       -3.4 dBFS\n\n  True peak:',
    );
    expect(parseEbur128Summary(withSamplePeak)).toEqual({ i: -16.2, lra: 1.7, tp: -1.2 });
  });
});

describe('measureLoudnessFile', () => {
  it('measures a real encoded file', async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { encodePcmToAudio } = await import('../tts/mp3.js');
    const { resolveLoudnormOptions } = await import('../tts/loudnorm.js');

    const SR = 24_000;
    const n = SR * 2;
    const pcm = Buffer.alloc(n * 2);
    for (let i = 0; i < n; i += 1) {
      pcm.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * 220 * i) / SR)), i * 2);
    }
    const dir = mkdtempSync(join(tmpdir(), 'measure-'));
    try {
      const mp3 = await encodePcmToAudio(pcm, SR, {
        format: 'mp3',
        loudnorm: resolveLoudnormOptions(),
      });
      const p = join(dir, 'a.mp3');
      writeFileSync(p, mp3);
      const m = await measureLoudnessFile(p);
      expect(m).not.toBeNull();
      /* Normalised toward the -16 target, so a wide sanity band only — the
         golden tier is where exact values get pinned. */
      expect(m!.i).toBeGreaterThan(-30);
      expect(m!.i).toBeLessThan(-5);
      expect(m!.lra).toBeGreaterThanOrEqual(0);
      expect(m!.tp).toBeLessThan(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file rather than throwing', async () => {
    expect(await measureLoudnessFile('no-such-file.mp3')).toBeNull();
  });
});

describe('measureLoudnessFile timeout (finding F4)', () => {
  /* Mocked-spawn isolation must not leak into the real-ffmpeg integration
     tests above, which import measureLoudnessFile statically at module load
     time (before this test runs). vi.doMock + vi.resetModules() + a dynamic
     import get this test its own mocked module instance; the cleanup here
     restores the real node:child_process for any test that runs after. */
  afterEach(() => {
    vi.doUnmock('node:child_process');
    vi.resetModules();
    vi.useRealTimers();
  });

  it('resolves null and kills the child rather than hanging past the 120s budget', async () => {
    vi.useFakeTimers();
    const killMock = vi.fn();
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      spawn: () => ({
        stderr: { on: vi.fn() },
        // Never fires 'close' or 'error' — simulates a wedged ffmpeg.
        on: vi.fn(),
        kill: killMock,
      }),
    }));

    const { measureLoudnessFile: measure } = await import('./measure-loudness.js');
    const resultPromise = measure('irrelevant.mp3');

    await vi.advanceTimersByTimeAsync(120_000);

    await expect(resultPromise).resolves.toBeNull();
    expect(killMock).toHaveBeenCalledTimes(1);
  });
});
