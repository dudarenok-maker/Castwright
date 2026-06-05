/* fs-26 (#480) — resolve a Listen-view playhead second to the chapter audio
   segment that contains it, so a re-record marker can be scoped to exactly the
   line under the marker. Segments carry start/end seconds + characterId; the
   segment index is its position in the chapter's `segments` array (the same
   index the splice route's `segmentIndices` addresses). */

import type { ChapterAudio } from './types';

export type ChapterSegment = NonNullable<ChapterAudio['segments']>[number];

export interface ResolvedSegment {
  characterId: string;
  segmentIndex: number;
}

/** Find the segment whose [start, end) range contains `sec`. When `sec` falls
    in a gap between segments (or past the last one), clamp to the nearest
    segment by edge distance. Returns null only when there are no usable
    segments (none carry a characterId). */
export function resolveSegmentForSec(
  sec: number,
  segments: ChapterSegment[] | undefined,
): ResolvedSegment | null {
  if (!segments || segments.length === 0) return null;

  let best: { index: number; characterId: string; distance: number } | null = null;
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg.characterId) continue;
    const start = seg.start ?? 0;
    const end = seg.end ?? start;
    // Direct hit: [start, end) contains sec — distance 0 wins immediately.
    if (sec >= start && sec < end) {
      return { characterId: seg.characterId, segmentIndex: i };
    }
    // Otherwise track the nearest edge so a gap/out-of-range sec clamps.
    const distance = sec < start ? start - sec : sec - end;
    if (!best || distance < best.distance) {
      best = { index: i, characterId: seg.characterId, distance };
    }
  }

  if (!best) return null;
  return { characterId: best.characterId, segmentIndex: best.index };
}
