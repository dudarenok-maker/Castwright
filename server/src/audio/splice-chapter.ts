/* Pure chapter-splice engine (fs-26).

   Given a chapter's decoded PCM, its `segments` (the per-group timing map from
   `<slug>.segments.json`), and a set of `replacements` — each carrying fresh
   PCM for a contiguous run of segments — this reassembles the chapter by
   byte-range surgery and recomputes every segment's timing.

   Design contract: *everything not inside a replaced segment's byte range is
   copied verbatim from the decoded PCM*. So the chapter's lead silence, the
   title beat, inter-sentence breaths/gaps, and the tail all ride along
   untouched — the engine never needs to know they exist. Only the targeted
   segments' byte ranges are substituted.

   This module is pure: no fs, no ffmpeg, no network. The route around it
   decodes the MP3 (→ PCM), builds the replacement PCM (gain filter or fresh
   synthesis), then re-encodes + loudnorms the result. All timing/gap/drift
   invariants are unit-tested in `./splice-chapter.test.ts`. */

import type { ChapterSegment } from '../tts/synthesise-chapter.js';
import { pcmDurationSec } from '../tts/pcm.js';

const BYTES_PER_SAMPLE = 2; // 16-bit mono

export interface SegmentReplacement {
  /** Index into `segments[]` of the FIRST segment in this contiguous run. */
  startSegmentIndex: number;
  /** Inclusive index of the LAST segment in this run. */
  endSegmentIndex: number;
  /** New PCM for the whole `[seg[start].startSec, seg[end].endSec)` span,
      already at the chapter sample rate, 16-bit mono. */
  pcm: Buffer;
  /** Per-inner-segment byte split of `pcm` (length === run size). Present for a
      re-record (fresh synthesis packs segments back-to-back, dropping the
      original inner gaps). Omit for a gain re-mix, where `pcm` is the original
      span with a volume filter applied — same byte length, so each inner
      segment keeps its original relative offset (inner gaps preserved). */
  innerSegmentByteLengths?: number[];
}

export interface SpliceInput {
  /** The full chapter, decoded at `sampleRate`, 16-bit mono. */
  decodedPcm: Buffer;
  sampleRate: number;
  /** Segments in narrative order, exactly as read from the segments file. */
  segments: ChapterSegment[];
  /** Sorted ascending by `startSegmentIndex`, non-overlapping runs. */
  replacements: SegmentReplacement[];
}

export interface SpliceResult {
  pcm: Buffer;
  segments: ChapterSegment[];
  durationSec: number;
  sampleRate: number;
}

/** Convert a chapter timestamp to a byte offset in 16-bit mono PCM.

    `round` (not `floor`) is mandatory: synthesis stamped `endSec` as
    `runningBytes / (sampleRate * 2)`, so `round(sec * sampleRate) * 2` recovers
    the exact original byte boundary with zero accumulated drift. The result is
    clamped to `[0, pcmLen]` and even-aligned (never splits a 16-bit frame). */
export function secToByteOffset(sec: number, sampleRate: number, pcmLen: number): number {
  const sample = Math.round(sec * sampleRate);
  let byte = sample * BYTES_PER_SAMPLE;
  if (byte < 0) byte = 0;
  if (byte > pcmLen) byte = pcmLen;
  return byte - (byte % 2);
}

function validate(input: SpliceInput): void {
  const { segments, replacements } = input;
  let prevEnd = -1;
  for (const r of replacements) {
    if (
      !Number.isInteger(r.startSegmentIndex) ||
      !Number.isInteger(r.endSegmentIndex) ||
      r.startSegmentIndex < 0 ||
      r.endSegmentIndex >= segments.length ||
      r.startSegmentIndex > r.endSegmentIndex
    ) {
      throw new Error(
        `splice: replacement segment index out of range [${r.startSegmentIndex}, ${r.endSegmentIndex}] for ${segments.length} segments`,
      );
    }
    if (r.startSegmentIndex <= prevEnd) {
      throw new Error(
        `splice: replacements must be sorted ascending and non-overlapping (run at ${r.startSegmentIndex} overlaps/precedes previous run ending at ${prevEnd})`,
      );
    }
    prevEnd = r.endSegmentIndex;
    const runSize = r.endSegmentIndex - r.startSegmentIndex + 1;
    if (r.innerSegmentByteLengths) {
      if (r.innerSegmentByteLengths.length !== runSize) {
        throw new Error(
          `splice: innerSegmentByteLengths length ${r.innerSegmentByteLengths.length} ≠ run size ${runSize}`,
        );
      }
      const sum = r.innerSegmentByteLengths.reduce((a, b) => a + b, 0);
      if (sum !== r.pcm.length) {
        throw new Error(`splice: innerSegmentByteLengths sum ${sum} ≠ replacement pcm length ${r.pcm.length}`);
      }
    }
  }
}

export function spliceChapterSegments(input: SpliceInput): SpliceResult {
  const { decodedPcm, sampleRate, segments, replacements } = input;
  validate(input);

  if (replacements.length === 0) {
    return {
      pcm: decodedPcm,
      segments,
      durationSec: pcmDurationSec(decodedPcm.length, sampleRate),
      sampleRate,
    };
  }

  const pcmLen = decodedPcm.length;
  const startByte = (i: number) => secToByteOffset(segments[i].startSec, sampleRate, pcmLen);
  const endByte = (i: number) => secToByteOffset(segments[i].endSec, sampleRate, pcmLen);

  // Map each segment index → the replacement run it belongs to (if any).
  const runByStartIndex = new Map<number, SegmentReplacement>();
  const replacedIndices = new Set<number>();
  for (const r of replacements) {
    runByStartIndex.set(r.startSegmentIndex, r);
    for (let i = r.startSegmentIndex; i <= r.endSegmentIndex; i += 1) replacedIndices.add(i);
  }

  const pieces: Buffer[] = [];
  const newSegments: ChapterSegment[] = [];
  let oldBytes = 0; // cursor in decodedPcm
  let newBytes = 0; // cursor in the reassembled buffer

  /** Copy a verbatim span [oldBytes, target) from decodedPcm and advance both
      cursors equally. Covers the head, inter-segment gaps, and the tail. */
  const copyVerbatimUpTo = (target: number) => {
    if (target > oldBytes) {
      pieces.push(decodedPcm.subarray(oldBytes, target));
      newBytes += target - oldBytes;
      oldBytes = target;
    }
  };

  let i = 0;
  while (i < segments.length) {
    const run = runByStartIndex.get(i);
    if (run) {
      const a = run.startSegmentIndex;
      const b = run.endSegmentIndex;
      const spanStart = startByte(a);
      const spanEnd = endByte(b);

      // Lead-in (head or gap) before the run is verbatim.
      copyVerbatimUpTo(spanStart);

      const runNewStart = newBytes;
      pieces.push(run.pcm);
      newBytes += run.pcm.length;

      if (run.innerSegmentByteLengths) {
        // Re-record: inner segments packed back-to-back; original inner gaps dropped.
        let cursor = runNewStart;
        for (let j = a; j <= b; j += 1) {
          const len = run.innerSegmentByteLengths[j - a];
          newSegments.push({
            ...segments[j],
            startSec: pcmDurationSec(cursor, sampleRate),
            endSec: pcmDurationSec(cursor + len, sampleRate),
          });
          cursor += len;
        }
      } else {
        // Gain: length-preserving, so each inner segment keeps its original
        // relative offset within the run (inner gaps preserved verbatim).
        const originalSpan = spanEnd - spanStart;
        if (run.pcm.length !== originalSpan) {
          if (a === b) {
            // single-segment run: the whole replacement is that one segment
            newSegments.push({
              ...segments[a],
              startSec: pcmDurationSec(runNewStart, sampleRate),
              endSec: pcmDurationSec(runNewStart + run.pcm.length, sampleRate),
            });
            oldBytes = spanEnd;
            i = b + 1;
            continue;
          }
          throw new Error(
            `splice: gain replacement length ${run.pcm.length} ≠ original span ${originalSpan}; multi-segment runs need innerSegmentByteLengths`,
          );
        }
        for (let j = a; j <= b; j += 1) {
          const offIn = startByte(j) - spanStart;
          const offEnd = endByte(j) - spanStart;
          newSegments.push({
            ...segments[j],
            startSec: pcmDurationSec(runNewStart + offIn, sampleRate),
            endSec: pcmDurationSec(runNewStart + offEnd, sampleRate),
          });
        }
      }

      oldBytes = spanEnd;
      i = b + 1;
      continue;
    }

    // Kept segment: lead-in (head/gap) verbatim, then the segment bytes verbatim.
    copyVerbatimUpTo(startByte(i));
    const segLen = endByte(i) - startByte(i);
    const newStart = newBytes;
    pieces.push(decodedPcm.subarray(oldBytes, oldBytes + segLen));
    newBytes += segLen;
    oldBytes += segLen;
    newSegments.push({
      ...segments[i],
      startSec: pcmDurationSec(newStart, sampleRate),
      endSec: pcmDurationSec(newBytes, sampleRate),
    });
    i += 1;
  }

  // Tail after the last segment is verbatim.
  copyVerbatimUpTo(pcmLen);

  const pcm = Buffer.concat(pieces);
  // Integrity invariant: the reassembled buffer and the byte cursor agree.
  if (pcm.length !== newBytes) {
    throw new Error(`splice: reassembly mismatch — pcm ${pcm.length} bytes, expected ${newBytes}`);
  }

  return { pcm, segments: newSegments, durationSec: pcmDurationSec(pcm.length, sampleRate), sampleRate };
}
