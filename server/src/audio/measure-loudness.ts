/* Real EBU R128 measurement of a FINISHED audio file (ops-36, finding 10).

   Why this exists: ffmpeg's `loudnorm` filter reports `output_i` / `output_lra`
   / `output_tp`, and the chapter sidecar used to persist those. They are the
   filter's own internal figures, not a measurement of the encoded result —
   `output_tp` in particular is the ceiling that was REQUESTED. On the golden
   fixture the sidecar claimed LRA 0.5 LU and true peak -1.5 dBTP where the
   audio actually measures 1.7 LU and a -1.2 dBFS sample peak (a true peak
   below sample peak is impossible). The Listen view renders those numbers to
   users, so they have to be real.

   Deliberately fails SOFT: the encoded bytes are already on disk by the time
   this runs — at the temp path, before the atomic rename to the chapter's
   final name (plan 274 T1 hoisted the call site to here) — so a measurement
   failure must degrade to "no sidecar values", never break the finalize
   path. */

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
 *  Prior art: `scripts/relufs-existing.mjs` (plan 71) parses this exact same
 *  Summary block for its standalone re-measurement script. Both parsers must
 *  stay compatible with the same log shapes — deliberately UNANCHORED and
 *  label-tolerant: ffmpeg prefixes every summary line with
 *  `[Parsed_ebur128_0 @ 0x...]` (so `^...$`-anchored patterns never match),
 *  and reports the peak label as either `dBFS` or `dBTP` depending on
 *  build/version. Don't narrow these patterns again without checking
 *  relufs-existing.mjs stays in sync.
 *
 *  Returns null unless all three fields are present AND finite — `-inf` on
 *  silent input yields null rather than an Infinity that would poison the
 *  sidecar and the UI that renders it. */
export function parseEbur128Summary(stderr: string): MeasuredLoudness | null {
  const num = (re: RegExp, source: string): number | null => {
    const m = re.exec(source);
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  const i = num(/\bI:\s*(-?[\d.]+|-?inf)\s*LUFS/, stderr);
  const lra = num(/\bLRA:\s*(-?[\d.]+|-?inf)\s*LU\b/, stderr);
  /* Scope the peak match to the `True peak:` section so a future
     `peak=sample+true` doesn't silently start reporting the sample peak
     instead — today's `peak=true` arg emits only the true-peak block, so an
     unscoped match is currently equivalent, but scoping now costs nothing
     and forecloses the drift. Falls back to the whole string if the
     `True peak:` header isn't present, so an unexpected log shape still
     degrades to "try the unscoped match" rather than an unconditional null. */
  const truePeakIdx = stderr.lastIndexOf('True peak:');
  const peakSource = truePeakIdx >= 0 ? stderr.slice(truePeakIdx) : stderr;
  const tp = num(/\bPeak:\s*(-?[\d.]+|-?inf)\s*dB(?:TP|FS)/, peakSource);
  if (i === null || lra === null || tp === null) return null;
  return { i, lra, tp };
}

/* plan 274 T1 hoisted this call to run BEFORE the atomic rename (and before
   `preserveExistingAsPrevious`), not after — so, unlike the original
   post-rename call site this replaced, the render is NOT yet committed to
   its final name when this spawns. A wedged ffmpeg here therefore delays
   the render rather than being free: `finalizeChapterAudioWrite` can't
   proceed to displace the previous take or write `segments.json` until this
   settles. 120 s is ~80x headroom over the ~1.5 s/10-min measured cost, so
   it should never trip on a healthy process; it exists purely to bound how
   long a hang can stall a render, not to protect an already-finished file. */
const MEASURE_TIMEOUT_MS = 120_000;

/** Run one `ebur128` analysis pass over `path`. ~1.5 s per 10 minutes of
 *  audio — about 9 % of the encode step, against a pipeline dominated by
 *  synthesis. Resolves null on any failure, including a timeout. */
export async function measureLoudnessFile(path: string): Promise<MeasuredLoudness | null> {
  return new Promise<MeasuredLoudness | null>((resolve) => {
    const child = spawn(
      'ffmpeg',
      ['-nostats', '-i', path, '-af', 'ebur128=peak=true:framelog=quiet', '-f', 'null', '-'],
      { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true },
    );
    let settled = false;
    const settle = (value: MeasuredLoudness | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(null);
    }, MEASURE_TIMEOUT_MS);
    const chunks: Buffer[] = [];
    child.stderr.on('data', (c) => chunks.push(c));
    child.on('error', () => settle(null));
    child.on('close', (code) => {
      if (code !== 0) return settle(null);
      settle(parseEbur128Summary(Buffer.concat(chunks).toString('utf8')));
    });
  });
}
