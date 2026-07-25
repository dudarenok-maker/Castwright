/* Pure quality gate for a captured voice sample (spec §4.1). Thresholds are the
   spec's Global Constraints; exact cutoffs are calibratable but committed here so
   the ingest route has a single source of truth. Input is s16le mono PCM. */
export interface CloneQuality {
  durationSeconds: number;
  fatal?: string;
  warnings: string[];
}

const SILENCE_DBFS = -45; // fatal at/below
const CLIP_DBFS = -0.1; // a sample at/above this magnitude counts as clipped
const CLIP_FRACTION = 0.005; // >0.5% clipped → warn
const MIN_FATAL_S = 4;
const MIN_GOOD_S = 8;

const FULL_SCALE = 32768;
const dbfs = (linear: number): number => (linear <= 0 ? -Infinity : 20 * Math.log10(linear / FULL_SCALE));

export function assessCloneSample(pcm: Buffer, sampleRate: number): CloneQuality {
  const n = Math.floor(pcm.length / 2);
  const durationSeconds = n / sampleRate;
  const warnings: string[] = [];

  let sumSq = 0;
  let clipped = 0;
  const clipThreshold = Math.pow(10, CLIP_DBFS / 20) * FULL_SCALE;
  for (let i = 0; i < n; i++) {
    const s = pcm.readInt16LE(i * 2);
    sumSq += s * s;
    if (Math.abs(s) >= clipThreshold) clipped++;
  }
  const rms = n > 0 ? Math.sqrt(sumSq / n) : 0;

  if (durationSeconds < MIN_FATAL_S) {
    return { durationSeconds, fatal: `Sample too short (${durationSeconds.toFixed(1)}s) — need at least ${MIN_FATAL_S}s.`, warnings };
  }
  if (dbfs(rms) <= SILENCE_DBFS) {
    return { durationSeconds, fatal: 'Sample is silent or too quiet — record closer to the mic.', warnings };
  }
  if (durationSeconds < MIN_GOOD_S) {
    warnings.push(`Sample is a little short (${durationSeconds.toFixed(1)}s) — 8s+ clones better.`);
  }
  if (n > 0 && clipped / n > CLIP_FRACTION) {
    warnings.push('Audio is clipping — lower the input level or move back from the mic.');
  }
  return { durationSeconds, warnings };
}
