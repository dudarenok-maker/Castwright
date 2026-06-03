/* Unit coverage for the pure chapter-splice engine (fs-26). The engine does
   byte-range surgery on a decoded chapter PCM: it substitutes the PCM for a
   set of target segments, copies every other byte verbatim, and recomputes
   every segment's timing against the reassembled buffer. It is pure — no fs,
   no ffmpeg — so all the timing/gap/drift invariants live here. The HTTP
   wiring, real decode, and gain filter are covered separately (mp3 +
   chapter-splice route tests).

   Sample-rate convention used throughout: sr = 1000 Hz, 16-bit mono, so
   1 second = 1000 samples = 2000 bytes. Every boundary in these tests lands
   on a whole sample, which keeps the sec↔byte maths exact and the assertions
   readable. */

import { describe, it, expect } from 'vitest';
import {
  spliceChapterSegments,
  secToByteOffset,
  type SegmentReplacement,
} from './splice-chapter.js';
import type { ChapterSegment } from '../tts/synthesise-chapter.js';
import { pcmDurationSec } from '../tts/pcm.js';

const SR = 1000;
const BYTES_PER_SEC = SR * 2;

/** Build int16 LE mono PCM of `byteLen` bytes; sample value = `valueAt(i)`.
    Default ramps `(i % 1000) - 500` so any verbatim-preserved slice is
    distinguishable from a sentinel-filled replacement. */
function pcm(byteLen: number, valueAt: (sampleIndex: number) => number = (i) => (i % 1000) - 500): Buffer {
  const buf = Buffer.alloc(byteLen);
  for (let i = 0; i < byteLen / 2; i += 1) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(valueAt(i)))), i * 2);
  }
  return buf;
}

/** A replacement buffer filled with a constant sentinel so it can never be
    confused with the ramp content of the source PCM. */
function sentinelPcm(byteLen: number, value = 7777): Buffer {
  return pcm(byteLen, () => value);
}

function seg(
  groupIndex: number,
  characterId: string,
  startSec: number,
  endSec: number,
  extra: Partial<ChapterSegment> = {},
): ChapterSegment {
  return { groupIndex, characterId, sentenceIds: [groupIndex], startSec, endSec, ...extra };
}

/* A chapter with: 0.5s lead silence, seg0(A) [0.5,1.5), 0.1s gap, seg1(B)
   [1.6,2.6), 0.1s gap, seg2(A) [2.7,3.7), 0.3s tail. Total 4.0s = 8000 bytes.
   Byte map: head[0,1000) seg0[1000,3000) gap[3000,3200) seg1[3200,5200)
   gap2[5200,5400) seg2[5400,7400) tail[7400,8000). */
function fixture() {
  const decodedPcm = pcm(4.0 * BYTES_PER_SEC);
  const segments = [
    seg(0, 'A', 0.5, 1.5),
    seg(1, 'B', 1.6, 2.6),
    seg(2, 'A', 2.7, 3.7),
  ];
  return { decodedPcm, segments };
}

describe('secToByteOffset', () => {
  it('rounds sec→sample (not floor) so synthesis boundaries round-trip exactly', () => {
    // synthesis stamped endSec = bytes / (sr*2); recover the EXACT byte offset.
    for (const bytes of [0, 2, 1998, 2000, 5200, 7999 - (7999 % 2)]) {
      const sec = pcmDurationSec(bytes, SR);
      expect(secToByteOffset(sec, SR, 1_000_000)).toBe(bytes);
    }
  });

  it('clamps to [0, pcmLen] and stays even-aligned', () => {
    expect(secToByteOffset(-1, SR, 8000)).toBe(0);
    expect(secToByteOffset(99, SR, 8000)).toBe(8000);
    // an odd cap clamps down to the even frame boundary
    expect(secToByteOffset(99, SR, 8001)).toBe(8000);
  });
});

describe('spliceChapterSegments', () => {
  it('no replacements → pcm + segments unchanged, duration from buffer length', () => {
    const { decodedPcm, segments } = fixture();
    const out = spliceChapterSegments({ decodedPcm, sampleRate: SR, segments, replacements: [] });
    expect(out.pcm.equals(decodedPcm)).toBe(true);
    expect(out.segments).toEqual(segments);
    expect(out.durationSec).toBeCloseTo(4.0, 10);
    expect(out.sampleRate).toBe(SR);
  });

  it('same-length replacement (gain) leaves all timings + duration unchanged', () => {
    const { decodedPcm, segments } = fixture();
    const repl: SegmentReplacement = {
      startSegmentIndex: 1,
      endSegmentIndex: 1,
      pcm: sentinelPcm(2000), // seg1 is 1.0s = 2000 bytes
    };
    const out = spliceChapterSegments({ decodedPcm, sampleRate: SR, segments, replacements: [repl] });
    expect(out.durationSec).toBeCloseTo(4.0, 10);
    expect(out.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0.5, 1.5],
      [1.6, 2.6],
      [2.7, 3.7],
    ]);
    // seg1 bytes are the sentinel; everything else is verbatim source.
    expect(out.pcm.subarray(3200, 5200).equals(sentinelPcm(2000))).toBe(true);
    expect(out.pcm.subarray(0, 3200).equals(decodedPcm.subarray(0, 3200))).toBe(true);
    expect(out.pcm.subarray(5200, 8000).equals(decodedPcm.subarray(5200, 8000))).toBe(true);
  });

  it('longer replacement shifts every downstream segment + grows duration; gaps preserved verbatim', () => {
    const { decodedPcm, segments } = fixture();
    const repl: SegmentReplacement = {
      startSegmentIndex: 1,
      endSegmentIndex: 1,
      pcm: sentinelPcm(3000), // +1000 bytes = +0.5s vs the original 2000
    };
    const out = spliceChapterSegments({ decodedPcm, sampleRate: SR, segments, replacements: [repl] });
    expect(out.durationSec).toBeCloseTo(4.5, 10);
    expect(out.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0.5, 1.5], // seg0 untouched
      [1.6, 3.1], // seg1 now 1.5s long
      [3.2, 4.2], // seg2 shifted forward by exactly +0.5s
    ]);
    // head + seg0 + gap preserved verbatim
    expect(out.pcm.subarray(0, 3200).equals(decodedPcm.subarray(0, 3200))).toBe(true);
    // the replacement
    expect(out.pcm.subarray(3200, 6200).equals(sentinelPcm(3000))).toBe(true);
    // gap2 + seg2 + tail preserved verbatim, just shifted to [6200, 9000)
    expect(out.pcm.subarray(6200, 9000).equals(decodedPcm.subarray(5200, 8000))).toBe(true);
    expect(out.pcm.length).toBe(9000);
  });

  it('shorter replacement shifts downstream backward + shrinks duration', () => {
    const { decodedPcm, segments } = fixture();
    const repl: SegmentReplacement = {
      startSegmentIndex: 1,
      endSegmentIndex: 1,
      pcm: sentinelPcm(1000), // -1000 bytes = -0.5s
    };
    const out = spliceChapterSegments({ decodedPcm, sampleRate: SR, segments, replacements: [repl] });
    expect(out.durationSec).toBeCloseTo(3.5, 10);
    expect(out.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0.5, 1.5],
      [1.6, 2.1],
      [2.2, 3.2],
    ]);
  });

  it('innerSegmentByteLengths splits a multi-segment re-record run back-to-back', () => {
    const { decodedPcm, segments } = fixture();
    // Re-record the run [seg0, seg1] (indices 0..1) as 1200 + 800 = 2000 bytes.
    const repl: SegmentReplacement = {
      startSegmentIndex: 0,
      endSegmentIndex: 1,
      pcm: sentinelPcm(2000),
      innerSegmentByteLengths: [1200, 800],
    };
    const out = spliceChapterSegments({ decodedPcm, sampleRate: SR, segments, replacements: [repl] });
    // head [0,1000) is the lead-in for seg0; run is packed back-to-back from byte 1000:
    //   seg0 → [1000,2200) = [0.5,1.1); seg1 → [2200,3000) = [1.1,1.5).
    // The original inner gap [3000,3200) is dropped (re-record packs tight); the
    // run's trailing original span ended at byte 5200, so seg2's lead-in gap2
    // [5200,5400) is preserved → seg2 lands at [3200,5200) = [1.6,2.6).
    expect(out.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0.5, 1.1],
      [1.1, 1.5],
      [1.6, 2.6],
    ]);
    expect(out.durationSec).toBeCloseTo(2.9, 10);
    // characterId preserved on the re-split segments
    expect(out.segments[0].characterId).toBe('A');
    expect(out.segments[1].characterId).toBe('B');
    // gap2 + seg2 + tail preserved verbatim, shifted to [3000,5800)
    expect(out.pcm.subarray(3000, 5800).equals(decodedPcm.subarray(5200, 8000))).toBe(true);
  });

  it('handles multiple non-adjacent replacements with cumulative downstream shift', () => {
    const { decodedPcm, segments } = fixture();
    const replacements: SegmentReplacement[] = [
      { startSegmentIndex: 0, endSegmentIndex: 0, pcm: sentinelPcm(3000, 111) }, // +1000
      { startSegmentIndex: 2, endSegmentIndex: 2, pcm: sentinelPcm(3000, 222) }, // +1000
    ];
    const out = spliceChapterSegments({ decodedPcm, sampleRate: SR, segments, replacements });
    // seg0 grows +0.5s; seg1 shifts +0.5s; seg2 shifts +0.5s then grows +0.5s.
    expect(out.segments.map((s) => [s.startSec, s.endSec])).toEqual([
      [0.5, 2.0], // seg0 [0.5, 0.5+1.5)
      [2.1, 3.1], // seg1 shifted +0.5
      [3.2, 4.7], // seg2 shifted +0.5 then 1.5s long
    ]);
    expect(out.durationSec).toBeCloseTo(5.0, 10); // 4.0 + 0.5 + 0.5
  });

  it('invariant: durationSec always equals pcmDurationSec(out.pcm.length)', () => {
    const { decodedPcm, segments } = fixture();
    const out = spliceChapterSegments({
      decodedPcm,
      sampleRate: SR,
      segments,
      replacements: [{ startSegmentIndex: 1, endSegmentIndex: 1, pcm: sentinelPcm(2500) }],
    });
    expect(out.durationSec).toBeCloseTo(pcmDurationSec(out.pcm.length, SR), 10);
  });

  it('preserves the title segment + its lead silence verbatim when not targeted', () => {
    // title beat as segment 0 (kind:'title'), then a body segment.
    const decodedPcm = pcm(3.0 * BYTES_PER_SEC);
    const segments = [
      seg(-1, 'narrator', 1.5, 2.0, { kind: 'title' }), // 1.5s lead silence then title beat
      seg(0, 'A', 2.2, 2.8), // post-title silence is the gap [2.0,2.2)
    ];
    const out = spliceChapterSegments({
      decodedPcm,
      sampleRate: SR,
      segments,
      replacements: [{ startSegmentIndex: 1, endSegmentIndex: 1, pcm: sentinelPcm(0.6 * BYTES_PER_SEC) }],
    });
    // title segment timing untouched; lead silence + title + post-title gap verbatim.
    expect(out.segments[0]).toEqual(segments[0]);
    const bodyStartByte = secToByteOffset(2.2, SR, decodedPcm.length); // 4400
    expect(out.pcm.subarray(0, bodyStartByte).equals(decodedPcm.subarray(0, bodyStartByte))).toBe(true);
  });

  describe('validation', () => {
    const base = fixture();
    it('rejects unsorted replacements', () => {
      expect(() =>
        spliceChapterSegments({
          ...base,
          sampleRate: SR,
          replacements: [
            { startSegmentIndex: 2, endSegmentIndex: 2, pcm: sentinelPcm(100) },
            { startSegmentIndex: 0, endSegmentIndex: 0, pcm: sentinelPcm(100) },
          ],
        }),
      ).toThrow(/sorted|order/i);
    });

    it('rejects overlapping replacement runs', () => {
      expect(() =>
        spliceChapterSegments({
          ...base,
          sampleRate: SR,
          replacements: [
            { startSegmentIndex: 0, endSegmentIndex: 1, pcm: sentinelPcm(100) },
            { startSegmentIndex: 1, endSegmentIndex: 2, pcm: sentinelPcm(100) },
          ],
        }),
      ).toThrow(/overlap/i);
    });

    it('rejects out-of-range segment indices', () => {
      expect(() =>
        spliceChapterSegments({
          ...base,
          sampleRate: SR,
          replacements: [{ startSegmentIndex: 0, endSegmentIndex: 9, pcm: sentinelPcm(100) }],
        }),
      ).toThrow(/range|index/i);
    });

    it('rejects innerSegmentByteLengths whose sum ≠ replacement pcm length', () => {
      expect(() =>
        spliceChapterSegments({
          ...base,
          sampleRate: SR,
          replacements: [
            { startSegmentIndex: 0, endSegmentIndex: 1, pcm: sentinelPcm(2000), innerSegmentByteLengths: [1000, 500] },
          ],
        }),
      ).toThrow(/sum|length/i);
    });

    it('rejects a gain (no innerSegmentByteLengths) replacement whose length ≠ original span', () => {
      // multi-segment run with no inner split must preserve the original byte span
      expect(() =>
        spliceChapterSegments({
          ...base,
          sampleRate: SR,
          replacements: [{ startSegmentIndex: 0, endSegmentIndex: 1, pcm: sentinelPcm(1234) }],
        }),
      ).toThrow(/length|span|innerSegmentByteLengths/i);
    });
  });
});
