/* Real EBU R128 measurement of a FINISHED audio file (ops-36, finding 10).

   Why this exists: ffmpeg's `loudnorm` filter reports `output_i` / `output_lra`
   / `output_tp`, and the chapter sidecar used to persist those. They are the
   filter's own internal figures, not a measurement of the encoded result —
   `output_tp` in particular is the ceiling that was REQUESTED. On the golden
   fixture the sidecar claimed LRA 0.5 LU and true peak -1.5 dBTP where the
   audio actually measures 1.7 LU and a -1.2 dBFS sample peak (a true peak
   below sample peak is impossible). The Listen view renders those numbers to
   users, so they have to be real.

   Deliberately fails SOFT: the audio is already on disk by the time this runs,
   so a measurement failure must degrade to "no sidecar values", never break
   the finalize path. */

import { spawn } from 'node:child_process';

export interface MeasuredLoudness {
  /** Integrated loudness (LUFS) of the finished file. */
  i: number;
  /** Loudness range (LU) — a real EBU R128 LRA, not loudnorm's estimate. */
  lra: number;
  /** True peak (dBFS/dBTP) as measured, not as targeted. */
  tp: number;
}

/** Parse ffmpeg's `ebur128` end-of-run Summary block.
 *
 *  Returns null unless all three fields are present AND finite — `-inf` on
 *  silent input yields null rather than an Infinity that would poison the
 *  sidecar and the UI that renders it. */
export function parseEbur128Summary(stderr: string): MeasuredLoudness | null {
  const num = (re: RegExp): number | null => {
    const m = re.exec(stderr);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const i = num(/^\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/m);
  const lra = num(/^\s*LRA:\s*(-?[\d.]+|-inf)\s*LU\s*$/m);
  const tp = num(/^\s*Peak:\s*(-?[\d.]+|-inf)\s*dBFS/m);
  if (i === null || lra === null || tp === null) return null;
  return { i, lra, tp };
}

/** Run one `ebur128` analysis pass over `path`. ~1.5 s per 10 minutes of
 *  audio — about 9 % of the encode step, against a pipeline dominated by
 *  synthesis. Resolves null on any failure. */
export async function measureLoudnessFile(path: string): Promise<MeasuredLoudness | null> {
  return new Promise<MeasuredLoudness | null>((resolve) => {
    const child = spawn(
      'ffmpeg',
      ['-nostats', '-i', path, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    const chunks: Buffer[] = [];
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      if (code !== 0) return resolve(null);
      resolve(parseEbur128Summary(Buffer.concat(chunks).toString('utf8')));
    });
  });
}
