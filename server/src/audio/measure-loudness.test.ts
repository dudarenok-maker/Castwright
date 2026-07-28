/* ebur128 summary parsing + one real-ffmpeg integration case. The parser is
   pure so the drift-prone part (ffmpeg's log shape) is pinned without a
   subprocess; the integration case proves the wiring end to end. */
import { describe, it, expect } from 'vitest';
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
