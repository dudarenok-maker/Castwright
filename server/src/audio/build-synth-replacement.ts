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
import { buildCastResolver } from '../store/cast-resolve.js';
import type { CastIdHistory } from '../store/cast-id-history.js';

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
  /** #1888 — the voice this re-recorded segment REQUESTED, set only when
      the sidecar substituted a fallback for THIS specific take
      (`ChapterSegment['voiceSubstitutedFrom']`). UNLIKE `voiceName` above,
      a re-record always has a definite answer for "did this take
      substitute" — `undefined` here is a meaningful, current "no", not "the
      caller hasn't wired this through." `buildSynthReplacements` must
      therefore always set this key on `freshVerdict` (never omit it), or a
      clean re-record would leave a stale substitution flag from the
      segment's prior render in place.

      #2034 — REQUIRED (not `?:`), unlike every other field on this
      interface: an optional key lets a caller's returned object literal
      omit it with no compile error, and `buildSynthReplacements` would then
      read `undefined` off a genuinely-absent property indistinguishably
      from a genuine "no substitution" — silently wiping a real prior
      substitution flag. Requiring the key (its value still permits
      `undefined`) forces every caller to make that choice explicitly. */
  voiceSubstitutedFrom: ChapterSegment['voiceSubstitutedFrom'];
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
      // #1888 — UNCONDITIONAL, unlike the fields above: a re-record always
      // synthesises and always has a definite substitution answer, so this
      // key must always be set (even to `undefined`) so a clean take clears
      // any stale substitution flag the segment's prior render carried.
      voiceSubstitutedFrom: out.voiceSubstitutedFrom,
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
    `segmentIndex`.

    #2040 — the segFile's characterId and the current analysis's characterId
    can each independently be a RETIRED id (a superseded-id rename can land
    on either side of a stale render). Comparing the two raw strings then
    reads a merely-renamed character as a genuine reattribution — exactly
    the false-positive this wave exists to fix (spec §4.3): QA repair would
    quarantine every one of that character's segments into `stillSuspect`,
    and a splice would refuse outright. `cast` + `castIdHistory` (the same
    loaded `CastIdHistory` object `synthesise-chapter.ts` threads through,
    see `loadCastIdHistory`) resolve both sides through `buildCastResolver`
    before comparing. The fallback is deliberately asymmetric: two ids only
    count as the same person when BOTH resolve AND resolve to the same cast
    id — two unresolvable ids that merely look alike are still a divergence.
    Guessing here can destroy correct audio (#1972's lesson).

    #2040 Task 17 fix round 1 — `castIdHistory` takes the whole
    `{ supersededBy, rejected }` shape (not just `supersededBy`) so a
    user-rejected reconciliation is honoured here too: without this, a
    rejected match still counted as "the same person" for divergence
    purposes, silently protecting a wrong id from ever being flagged as
    diverged/re-recorded. #2092/#2089 task 3 — widened to also carry
    `rejectedPairs` (both call sites already pass the whole loaded
    `CastIdHistory` object through a variable, so this was already reaching
    `buildCastResolver` intact at runtime; the narrower Pick here was
    self-documentation drift, not a functional gap — but a stale, narrower
    annotation on a `buildCastResolver` wrapper is exactly the shape that
    invites a future caller to "fix" itself into passing a genuinely
    truncated object). */
export function findDivergentSentences(
  segments: ChapterSegment[],
  targetIndices: number[],
  currentSentences: Pick<SentenceOutput, 'id' | 'characterId' | 'text' | 'excludeFromSynthesis'>[],
  cast: readonly { id: string }[],
  castIdHistory: Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'> = {
    supersededBy: {},
  },
): DivergentSentence[] {
  const byId = new Map(currentSentences.map((s) => [s.id, s]));
  const resolver = buildCastResolver(cast, castIdHistory);
  const sameCharacter = (a: string, b: string): boolean => {
    if (a === b) return true;
    const ra = resolver.resolve(a)?.character.id;
    const rb = resolver.resolve(b)?.character.id;
    return Boolean(ra && rb && ra === rb);
  };
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
      if (!sameCharacter(current.characterId, seg.characterId)) {
        out.push({ segmentIndex: idx, sentenceId: id, newOwner: current.characterId });
      }
    }
  }
  return out;
}
