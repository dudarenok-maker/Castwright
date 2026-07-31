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
import type { SentenceOutput } from '../handoff/schemas.js';
import { normaliseForTts } from '../tts/text-normalize.js';

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
  /** #1972 — the voice ACTUALLY sent to the provider for this re-record
      (`ChapterSegment['voiceName']`). Absent only for a caller that hasn't
      wired it through; when present it always overwrites the segment's prior
      value (unlike the gated QA fields above, a re-record always synthesises,
      so there's no "gate didn't run" state to protect against). */
  voiceName?: ChapterSegment['voiceName'];
  /** M1 (#1972 follow-up) — the PRE-emotion-variant voice name for this
      re-record (`ChapterSegment['baseVoiceName']`). Same "always overwrites
      when present" rule as `voiceName`. Threaded separately so a re-recorded
      quote that happens to carry an emotion variant doesn't stamp its
      `__<emotion>`-suffixed voiceName onto the character-level snapshot. */
  baseVoiceName?: ChapterSegment['baseVoiceName'];
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
       `SegmentReplacement.freshVerdict` in splice-chapter.ts).

       `suspect` is bucketed separately from `qa`/`qaRetries`: it's a UNION
       signal (synthesise-chapter.ts stamps it from `quarantined ||
       qa?.status === 'suspect'`, where `quarantined` comes from ASR-driven
       calibration-bleed detection — independent of the signal-QA gate), so it
       must be included whenever EITHER gate ran, not gated on signalQaRan
       alone — otherwise an ASR-only re-record (signal-QA off) whose ASR gate
       quarantines the take never surfaces that as `suspect`, silently
       preserving the segment's stale prior verdict over genuinely bad audio. */
    const freshVerdict: NonNullable<SegmentReplacement['freshVerdict']> = {
      ...(out.signalQaRan ? { qa: out.qa, qaRetries: out.qaRetries } : {}),
      ...(out.asrRan ? { asr: out.asr, asrSuspect: out.asrSuspect, asrRetries: out.asrRetries } : {}),
      ...(out.signalQaRan || out.asrRan ? { suspect: out.suspect } : {}),
      // #1972 — only set the key when the caller actually reports a voice, so
      // an un-migrated caller can't wipe a segment's prior voiceName with an
      // explicit `undefined` (same "omit, don't overwrite" rule as above).
      ...(out.voiceName ? { voiceName: out.voiceName } : {}),
      // M1 — same omit-don't-overwrite rule for the base (pre-emotion-variant)
      // voice name.
      ...(out.baseVoiceName ? { baseVoiceName: out.baseVoiceName } : {}),
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

export interface DivergentSentence {
  /** Index into `segments[]` (the source array passed to
      `findDivergentSentences`, matching `targetIndices`). */
  segmentIndex: number;
  sentenceId: number;
  /** The characterId the CURRENT analysis attributes this sentence id to.
      `null` when re-recording this id today would splice SILENCE, not
      merely the wrong voice: the id no longer exists in the current
      analysis (re-segmentation renumbered ids), it's `excludeFromSynthesis`
      (fs-58), or it normalises to empty text — `buildSentenceGroups`
      (synthesise-chapter.ts) silently drops all three, so a "re-record"
      targeting one produces no audio for that slot at all. */
  newOwner: string | null;
}

/** #1972 — target SELECTION for a re-record comes from `segments.json` (the
    chapter's last render: "which segments belong to this character?");
    sentence + voice resolution comes from the CURRENT analysis cache
    ("who speaks sentence N, and what's its text, today?"). When analysis has
    run since the render, the two can disagree, and blindly re-recording
    under the segment's `characterId` either (a) renders a DIFFERENT
    character's line in this character's voice — the original #1972 defect —
    or (b) targets a sentence id the current analysis would never actually
    synthesise, splicing SILENCE over the segment's slot — audio deletion,
    not re-voicing.

    Shared by `chapter-splice.ts` (refuses the whole splice on any hit) and
    `chapter-qa-repair.ts` (drops just the diverged indices into
    `stillSuspect`) so the two callers can't drift on what counts as unsafe
    to re-record. Returns one entry per diverged SENTENCE — a segment
    spanning several sentence ids can contribute more than one entry; a
    caller that only needs "which segments" should dedupe by
    `segmentIndex`. */
export function findDivergentSentences(
  segments: ChapterSegment[],
  targetIndices: number[],
  currentSentences: Pick<SentenceOutput, 'id' | 'characterId' | 'text' | 'excludeFromSynthesis'>[],
): DivergentSentence[] {
  const byId = new Map(currentSentences.map((s) => [s.id, s]));
  const out: DivergentSentence[] = [];
  for (const idx of targetIndices) {
    const seg = segments[idx];
    for (const id of seg.sentenceIds) {
      const current = byId.get(id);
      if (!current) {
        out.push({ segmentIndex: idx, sentenceId: id, newOwner: null });
        continue;
      }
      const wouldSynthesiseSilence =
        !!current.excludeFromSynthesis || normaliseForTts(current.text).trim() === '';
      if (wouldSynthesiseSilence) {
        out.push({ segmentIndex: idx, sentenceId: id, newOwner: null });
        continue;
      }
      if (current.characterId !== seg.characterId) {
        out.push({ segmentIndex: idx, sentenceId: id, newOwner: current.characterId });
      }
    }
  }
  return out;
}
