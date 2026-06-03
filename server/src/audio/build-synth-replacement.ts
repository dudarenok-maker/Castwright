/* fs-26 re-record path — turn a set of target segments into freshly-synthesised
   SegmentReplacements for the splice engine.

   Each target segment is re-rendered INDEPENDENTLY (one synth call per segment,
   one single-segment replacement) rather than as a multi-segment run. That
   sidesteps any mismatch between how synthesis groups sentences and how the
   original segments were split: a single-segment replacement may be any length,
   so the engine retimes it without needing an inner byte-split. The synth call
   is injected so this stays unit-testable without a live sidecar. */

import type { ChapterSegment } from '../tts/synthesise-chapter.js';
import type { SegmentReplacement } from './splice-chapter.js';
import { resamplePcm16 } from '../tts/resample-pcm16.js';

/** A segment can be re-recorded only if it's backed by manuscript sentences.
    The synthetic chapter-title beat (`kind:'title'`, empty `sentenceIds`) has
    no text to re-synthesise — re-recording it would feed empty input to the
    synth and splice silence over the title narration. The title carries the
    narrator's characterId, so without this filter picking the narrator for a
    re-record would sweep the title beat in and wipe it. */
export function isRerecordableSegment(seg: ChapterSegment): boolean {
  return seg.kind !== 'title' && seg.sentenceIds.length > 0;
}

export interface SynthOutput {
  pcm: Buffer;
  sampleRate: number;
}

export interface BuildSynthReplacementsOpts {
  /** The chapter's segments (from segments.json), in narrative order. */
  segments: ChapterSegment[];
  /** Indices into `segments` to re-record. */
  targetIndices: number[];
  /** The chapter's sample rate; replacements are resampled onto this grid so
      the splice engine's sec↔byte maths stay drift-free. */
  chapterSampleRate: number;
  /** Re-synthesise one segment from its sentence ids → raw PCM + its rate. */
  synth: (segment: ChapterSegment) => Promise<SynthOutput>;
}

export async function buildSynthReplacements(
  opts: BuildSynthReplacementsOpts,
): Promise<SegmentReplacement[]> {
  const replacements: SegmentReplacement[] = [];
  for (const i of [...opts.targetIndices].sort((a, b) => a - b)) {
    const seg = opts.segments[i];
    const out = await opts.synth(seg);
    const pcm =
      out.sampleRate === opts.chapterSampleRate
        ? out.pcm
        : resamplePcm16(out.pcm, out.sampleRate, opts.chapterSampleRate);
    replacements.push({ startSegmentIndex: i, endSegmentIndex: i, pcm });
  }
  return replacements;
}
