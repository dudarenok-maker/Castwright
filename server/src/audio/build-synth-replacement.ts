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
  /** fs-51 — the freshly-computed QA/ASR verdict for this re-recorded
      segment, when the caller's synth ran the gates. Absent when the
      caller didn't run QA/ASR for this call (legacy behavior). */
  qa?: ChapterSegment['qa'];
  suspect?: ChapterSegment['suspect'];
  asr?: ChapterSegment['asr'];
  asrSuspect?: ChapterSegment['asrSuspect'];
  qaRetries?: ChapterSegment['qaRetries'];
  asrRetries?: ChapterSegment['asrRetries'];
  /** Did the signal-QA gate actually EXECUTE for this specific call — not
      "is signal-QA enabled globally," but "did this call evaluate a verdict
      at all." False (or absent) means `qa`/`suspect`/`qaRetries` above are
      meaningless placeholders (the gate never ran), NOT "ran clean" — so
      `buildSynthReplacements` must not let them overwrite a segment's prior,
      still-valid verdict. */
  signalQaRan?: boolean;
  /** Same distinction as `signalQaRan`, for the ASR gate: did ASR verification
      actually run for this call, gating whether `asr`/`asrSuspect`/`asrRetries`
      are meaningful. */
  asrRan?: boolean;
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
    /* Only let a gate's fields overwrite the segment's prior verdict when that
       gate actually RAN for this call — a gate that's configured off never
       populates its fields, and an omitted key here (not `key: undefined`) is
       what makes `spliceChapterSegments`'s `{...segment, ...freshVerdict}`
       spread leave the segment's prior value alone (see the module doc on
       `SegmentReplacement.freshVerdict` in splice-chapter.ts). */
    const freshVerdict: NonNullable<SegmentReplacement['freshVerdict']> = {
      ...(out.signalQaRan ? { qa: out.qa, suspect: out.suspect, qaRetries: out.qaRetries } : {}),
      ...(out.asrRan ? { asr: out.asr, asrSuspect: out.asrSuspect, asrRetries: out.asrRetries } : {}),
    };
    replacements.push({
      startSegmentIndex: i,
      endSegmentIndex: i,
      pcm,
      freshVerdict,
    });
  }
  return replacements;
}
