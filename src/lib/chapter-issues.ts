import type { ChapterAudio } from './types';

/** Lead-in / lead-out seconds so a jump lands BEFORE the flagged audio and the
    amber band bounds the issue with margin (you hear context on both sides). */
export const ISSUE_CONTEXT_PAD_SEC = 2;

export interface IssueRegion {
  /** Padded + clamped start, as a fraction of the chapter [0,1]. */
  startFrac: number;
  /** Padded + clamped end, as a fraction of the chapter [0,1]. */
  endFrac: number;
  /** Seconds to seek to (region start − pad, clamped ≥ 0). */
  seekSec: number;
  /** Concatenated QA reasons across merged segments. */
  reasons: string[];
}

/** Turn a chapter's flagged segments into padded, merged, clamped issue regions.
    Overlapping/abutting padded ranges coalesce into one band (one jump-stop);
    a band that would cover the whole track is dropped (the chapter-level
    fallback surface handles that case instead). */
export function deriveIssues(
  audio: Pick<ChapterAudio, 'segments' | 'durationSec'>,
): IssueRegion[] {
  const dur = audio.durationSec;
  if (!dur || dur <= 0 || !audio.segments?.length) return [];
  const PAD = ISSUE_CONTEXT_PAD_SEC;

  const padded = audio.segments
    .filter((s) => s.suspect)
    .map((s) => ({
      start: Math.max(0, s.start - PAD),
      end: Math.min(dur, s.end + PAD),
      reasons: s.reasons ?? [],
    }))
    .sort((a, b) => a.start - b.start);
  if (!padded.length) return [];

  const merged: typeof padded = [];
  for (const cur of padded) {
    const last = merged[merged.length - 1];
    if (last && cur.start <= last.end) {
      last.end = Math.max(last.end, cur.end);
      last.reasons = [...last.reasons, ...cur.reasons];
    } else {
      merged.push({ ...cur });
    }
  }

  return merged
    .map((m) => ({
      startFrac: m.start / dur,
      endFrac: m.end / dur,
      seekSec: m.start,
      reasons: m.reasons,
    }))
    .filter((r) => !(r.startFrac <= 0 && r.endFrac >= 1));
}
