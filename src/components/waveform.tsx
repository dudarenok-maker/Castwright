import { formatTime } from '../lib/time';
import type { IssueRegion } from '../lib/chapter-issues';

interface WaveformProps {
  progress: number;
  active: boolean;
  /** Real per-chapter loudness envelope (server's 240-bin RMS peaks, plan 56).
      When present and non-empty the bars are derived from it; otherwise the
      seeded `BARS` fallback below keeps the decorative shape for loading /
      not-yet-generated rows. */
  peaks?: number[];
  /** issue-waveform — padded/merged regions to paint amber. */
  issues?: IssueRegion[];
}

const BAR_COUNT = 48;

// Deterministic seeded bar heights, computed once at module load so every
// Waveform mount renders the identical 48-bar profile when no real peaks are
// available (fe-6, #413).
const BARS: number[] = (() => {
  let s = 42;
  const out: number[] = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    s = (s * 9301 + 49297) % 233280;
    out.push(0.25 + (s / 233280) * 0.75);
  }
  return out;
})();

/* Map each in-issue bar index to the region that covers it, so an amber bar can
   carry that region's reasons in a hover `title` (the sr-only list alone left
   sighted users with no way to read what the markers mean). First region wins on
   the rare overlap — the same index-coverage as the previous Set. */
function issueBarMap(
  issues: IssueRegion[] | undefined,
  count: number,
): Map<number, IssueRegion> {
  const map = new Map<number, IssueRegion>();
  for (const r of issues ?? []) {
    const lo = Math.max(0, Math.floor(r.startFrac * count));
    const hi = Math.min(count - 1, Math.ceil(r.endFrac * count) - 1);
    for (let i = lo; i <= hi; i += 1) if (!map.has(i)) map.set(i, r);
  }
  return map;
}

/* Reduce the server's variable-length RMS envelope (240 bins in practice) to
   `count` bar heights in [floor, 1]. Chunked mean, then re-normalised so the
   loudest bar fills the track, with a small floor so quiet/silent bins still
   render a visible sliver — matching the seeded bars' visual weight. Returns
   null for an empty/undefined input so the caller can fall back to BARS. */
export function peaksToBars(peaks: number[] | undefined, count = BAR_COUNT): number[] | null {
  if (!peaks || peaks.length === 0) return null;
  const floor = 0.12;
  const means: number[] = [];
  for (let i = 0; i < count; i++) {
    const lo = Math.floor((i * peaks.length) / count);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) * peaks.length) / count));
    let sum = 0;
    for (let j = lo; j < hi; j++) sum += peaks[j];
    means.push(sum / (hi - lo));
  }
  const max = Math.max(...means);
  // All-silent envelope → uniform floor (avoids divide-by-zero / NaN).
  if (max <= 0) return means.map(() => floor);
  return means.map((m) => floor + (1 - floor) * (m / max));
}

export function Waveform({ progress, active, peaks, issues }: WaveformProps) {
  const bars = peaksToBars(peaks) ?? BARS;
  const amber = issueBarMap(issues, bars.length);
  const hasIssues = (issues?.length ?? 0) > 0;

  const barRow = (
    <div className="flex items-end gap-[2px] h-7 w-full" aria-hidden={hasIssues || undefined}>
      {bars.map((h, i) => {
        const region = amber.get(i);
        const filled = i / bars.length <= progress;
        const cls = region
          ? 'bg-amber-400'
          : active && filled
            ? 'bg-magenta'
            : active
              ? 'bg-ink/15'
              : 'bg-ink/20';
        return (
          <span
            key={i}
            // flex-1 (not a fixed pixel width) so the 48 bars span the full
            // container — a fixed width under-fills the wide mini-player scrubber,
            // leaving a flat tail (the "waveform not rendering" report).
            className={`flex-1 min-w-[2px] rounded-sm transition-colors ${cls}`}
            style={{ height: `${h * 100}%` }}
            title={
              region
                ? `Issue at ${formatTime(region.seekSec)}: ${region.reasons.join('; ')}`
                : undefined
            }
          />
        );
      })}
    </div>
  );

  if (!hasIssues) return barRow;

  return (
    <>
      {barRow}
      <ul className="sr-only">
        {issues!.map((r, i) => (
          <li key={i}>{`Issue at ${formatTime(r.seekSec)}: ${r.reasons.join('; ')}`}</li>
        ))}
      </ul>
    </>
  );
}
