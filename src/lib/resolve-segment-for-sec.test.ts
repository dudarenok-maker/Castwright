/* fs-26 (#480) — the Listen-view playhead → chapter segment resolver. Used to
   scope a per-line re-record to exactly the segment under a re-record marker. */

import { describe, it, expect } from 'vitest';
import { resolveSegmentForSec, type ChapterSegment } from './resolve-segment-for-sec';

const SEGMENTS: ChapterSegment[] = [
  { start: 0, end: 10, characterId: 'narrator', sentenceId: 1 },
  { start: 10, end: 20, characterId: 'halloran', sentenceId: 2 },
  { start: 20, end: 30, characterId: 'narrator', sentenceId: 3 },
];

describe('resolveSegmentForSec', () => {
  it('returns the segment whose [start, end) contains sec', () => {
    expect(resolveSegmentForSec(5, SEGMENTS)).toEqual({ characterId: 'narrator', segmentIndex: 0 });
    expect(resolveSegmentForSec(15, SEGMENTS)).toEqual({ characterId: 'halloran', segmentIndex: 1 });
    expect(resolveSegmentForSec(25, SEGMENTS)).toEqual({ characterId: 'narrator', segmentIndex: 2 });
  });

  it('treats the start edge as inclusive and the end edge as the next segment', () => {
    // sec === 10 falls in segment 1 ([10,20)), not segment 0 ([0,10)).
    expect(resolveSegmentForSec(10, SEGMENTS)).toEqual({ characterId: 'halloran', segmentIndex: 1 });
  });

  it('clamps to the nearest segment when sec is past the last segment', () => {
    expect(resolveSegmentForSec(100, SEGMENTS)).toEqual({ characterId: 'narrator', segmentIndex: 2 });
  });

  it('clamps to the nearest segment when sec falls in a gap', () => {
    const gapped: ChapterSegment[] = [
      { start: 0, end: 5, characterId: 'narrator' },
      { start: 12, end: 20, characterId: 'halloran' },
    ];
    // sec=7 is closer to segment 0's end (5) than segment 1's start (12).
    expect(resolveSegmentForSec(7, gapped)).toEqual({ characterId: 'narrator', segmentIndex: 0 });
    // sec=11 is closer to segment 1's start (12).
    expect(resolveSegmentForSec(11, gapped)).toEqual({ characterId: 'halloran', segmentIndex: 1 });
  });

  it('returns null when there are no segments', () => {
    expect(resolveSegmentForSec(5, [])).toBeNull();
    expect(resolveSegmentForSec(5, undefined)).toBeNull();
  });

  it('skips segments that carry no characterId', () => {
    const partial: ChapterSegment[] = [
      { start: 0, end: 10 },
      { start: 10, end: 20, characterId: 'halloran' },
    ];
    // sec=5 lands in the character-less segment 0 → clamp to the next usable one.
    expect(resolveSegmentForSec(5, partial)).toEqual({ characterId: 'halloran', segmentIndex: 1 });
  });
});
