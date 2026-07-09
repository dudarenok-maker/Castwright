import type { SentenceOutput } from '../../handoff/schemas.js';
import type { AlignedSentence, AlignmentResult } from './aligner.js';
import type { EngineReport, SpanEvidence } from './types.js';

/* Task 7 (spec §5.3). The cross-examiner: replays the model's per-sentence
   attribution against the structural evidence Tasks 4-6 derived (tag-name /
   tag-pronoun / alternation / unanchored speech, plus tag/narration spans),
   and replaces the model's self-reported confidence with a DERIVED one on
   EVERY sentence. Pure: no I/O, no model calls.

   Two hard invariants (spec §5.3): a `tag-name` attribution is never
   overridden by anything (model, pronoun, alternation, escalation); and a
   continuation sentence inside a speech span (no leading dash/quote of its
   own) is classified as speech, not narration, because it inherits the
   SPAN's evidence rather than being re-classified from its own bare text
   (the old `isSpokenLine` trap this replaces).

   All confidence values are derived; the ordering below (not the exact
   numbers) is the contract — tunable in this one block. */
export const CONFIDENCE = {
  TAG_CONFIRM: 0.95,
  TAG_CORRECT: 0.9,
  TAG_SPAN: 0.9,
  PRONOUN_CONFIRM: 0.85,
  PRONOUN_CORRECT: 0.8,
  PRONOUN_KEEP_FLAG: 0.6,
  ALT_CONFIRM: 0.8,
  ALT_CORRECT_FLAG: 0.7,
  ALT_KEEP_FLAG: 0.6,
  UNANCH_NAMED_FLAG: 0.65,
  UNANCH_NARR_FLAG: 0.5,
  LUMPED_FLAG: 0.65,
  NARRATION_CONFIRM: 0.95,
  NARRATION_DEMOTE: 0.9,
  UNALIGNED_CAP: 0.74,
} as const;

const NARRATOR_ID = 'narrator';

export interface CrossExamineResult {
  /** new array, corrected ids + derived confidence */
  sentences: SentenceOutput[];
  /** indexes into sentences[] */
  flags: Array<{ index: number; reason: string }>;
  report: EngineReport;
}

export interface CrossExamineOpts {
  rosterIds: Set<string>;
  /** MALE_BUCKET_ID / FEMALE_BUCKET_ID from fold-minor-cast.ts */
  unknownBucketIds: Set<string>;
  /** default 80: below → flagOnly (no corrections) */
  alignmentFloorPct: number;
}

type Bucket = 'confirmed' | 'corrected' | 'flagged' | 'lumped';

interface Decision {
  characterId: string;
  confidence: number;
  reason: string;
  bucket: Bucket;
  flagged: boolean;
}

function modelConfidence(s: SentenceOutput): number {
  return s.confidence ?? 1;
}

function isNarratorOrUnknown(id: string, opts: CrossExamineOpts): boolean {
  return id === NARRATOR_ID || opts.unknownBucketIds.has(id);
}

/** The chapter-wide flag-only fallback (§5.2): below the alignment floor,
    NOTHING is corrected — every sentence passes through with its model id
    unchanged, confidence capped like an unaligned sentence would be. */
function flagOnlyDecision(as: AlignedSentence): Decision {
  return {
    characterId: as.sentence.characterId,
    confidence: Math.min(modelConfidence(as.sentence), CONFIDENCE.UNALIGNED_CAP),
    reason: 'flag-only-floor',
    bucket: 'flagged',
    flagged: true,
  };
}

/** `unanchored` speech (no `speaker` on the span — windows.ts never stamps
    `source: 'unanchored'`, it just leaves `speaker` undefined). */
function decideUnanchoredSpeech(modelId: string, opts: CrossExamineOpts): Decision {
  const named = opts.rosterIds.has(modelId) && !isNarratorOrUnknown(modelId, opts);
  return named
    ? {
        characterId: modelId,
        confidence: CONFIDENCE.UNANCH_NAMED_FLAG,
        reason: `unanchored-named:${modelId}`,
        bucket: 'flagged',
        flagged: true,
      }
    : {
        characterId: modelId,
        confidence: CONFIDENCE.UNANCH_NARR_FLAG,
        reason: 'unanchored-narrator',
        bucket: 'flagged',
        flagged: true,
      };
}

/** A speech span WITH speaker evidence — the `tag-name` / `tag-pronoun` /
    `alternation` rows. `tag-name` is never overridden: model agreement
    confirms, disagreement always auto-corrects (no flag — this is the
    strongest evidence there is). */
function decideAnchoredSpeech(modelId: string, span: SpanEvidence, opts: CrossExamineOpts): Decision {
  const { characterId: x, source } = span.speaker!;

  switch (source) {
    case 'tag-name':
      return modelId === x
        ? { characterId: x, confidence: CONFIDENCE.TAG_CONFIRM, reason: `tag-confirm:${x}`, bucket: 'confirmed', flagged: false }
        : { characterId: x, confidence: CONFIDENCE.TAG_CORRECT, reason: `tag-correct:${x}`, bucket: 'corrected', flagged: false };

    case 'tag-pronoun':
      if (modelId === x) {
        return { characterId: x, confidence: CONFIDENCE.PRONOUN_CONFIRM, reason: `pronoun-confirm:${x}`, bucket: 'confirmed', flagged: false };
      }
      if (isNarratorOrUnknown(modelId, opts)) {
        return { characterId: x, confidence: CONFIDENCE.PRONOUN_CORRECT, reason: `pronoun-correct:${x}`, bucket: 'corrected', flagged: false };
      }
      return {
        characterId: modelId,
        confidence: CONFIDENCE.PRONOUN_KEEP_FLAG,
        reason: `pronoun-keep-flag:${modelId}-vs-${x}`,
        bucket: 'flagged',
        flagged: true,
      };

    case 'alternation':
      if (modelId === x) {
        return { characterId: x, confidence: CONFIDENCE.ALT_CONFIRM, reason: `alt-confirm:${x}`, bucket: 'confirmed', flagged: false };
      }
      if (isNarratorOrUnknown(modelId, opts)) {
        return { characterId: x, confidence: CONFIDENCE.ALT_CORRECT_FLAG, reason: `alt-correct-flag:${x}`, bucket: 'corrected', flagged: true };
      }
      return {
        characterId: modelId,
        confidence: CONFIDENCE.ALT_KEEP_FLAG,
        reason: `alt-keep-flag:${modelId}-vs-${x}`,
        bucket: 'flagged',
        flagged: true,
      };

    case 'unanchored':
      // Defensive: `unanchored` IS a real EvidenceSource member, but windows.ts
      // never actually stamps it when `speaker` is set (it just leaves
      // `speaker` undefined instead — see decideUnanchoredSpeech above). That
      // invariant is enforced two files away with no local guard here. Never
      // auto-correct on evidence this function doesn't recognise: keep the
      // model's id and flag it, so a future regression surfaces as a review
      // stop instead of a silently fabricated correction.
      return {
        characterId: modelId,
        confidence: CONFIDENCE.ALT_KEEP_FLAG,
        reason: 'unexpected-source:unanchored',
        bucket: 'flagged',
        flagged: true,
      };

    default: {
      // Compile-time tripwire: EvidenceSource has exactly 4 members, all
      // cased above, so `source` is `never` here. If the union ever grows a
      // 5th member without a matching `case`, this line fails to compile —
      // forcing a conscious decision instead of a silent fallthrough — while
      // still returning the same safe keep+flag default at runtime.
      const _exhaustive: never = source;
      return {
        characterId: modelId,
        confidence: CONFIDENCE.ALT_KEEP_FLAG,
        reason: `unexpected-source:${String(_exhaustive)}`,
        bucket: 'flagged',
        flagged: true,
      };
    }
  }
}

/** A sentence whose only aligned spans are `tag` (a beat/tag clause itself,
    e.g. "сказал Антон") — never `speech`. The tag/beat text is narrator
    voice, not the character's: demote (Wave A rule, kept), no block-clamp
    (that footnote is scoped to the pure-narration row below). Spec §5.3 row 3
    is a single unconditional line — tag/beat span -> narrator @ TAG_SPAN —
    with no separate confirm sub-case for a model that already said narrator. */
function decideTagSpanOnly(): Decision {
  return { characterId: NARRATOR_ID, confidence: CONFIDENCE.TAG_SPAN, reason: 'tag-span-narrator', bucket: 'corrected', flagged: false };
}

/** A sentence whose only aligned spans are pure `narration` (no `speech`,
    no `tag`). Demote-only, Wave A rule — but the FIRST sentence of a
    contiguous demoted run is clamped to <=0.5 and flagged so the low-
    confidence navigator still gets one review stop per block (mirrors
    `applyNarratorDefault`'s `clampedThisRun`, replicated here via
    structural evidence instead of the old `isSpokenLine` text heuristic).
    An already-narrator sentence neither breaks nor extends the run,
    matching the old code's exact behaviour. */
function decideNarrationOnly(modelId: string, block: { active: boolean }): Decision {
  if (modelId === NARRATOR_ID) {
    return { characterId: NARRATOR_ID, confidence: CONFIDENCE.NARRATION_CONFIRM, reason: 'narration-confirm', bucket: 'confirmed', flagged: false };
  }
  if (!block.active) {
    block.active = true;
    return {
      characterId: NARRATOR_ID,
      confidence: Math.min(CONFIDENCE.NARRATION_DEMOTE, 0.5),
      reason: 'narration-demote:first',
      bucket: 'corrected',
      flagged: true,
    };
  }
  return { characterId: NARRATOR_ID, confidence: CONFIDENCE.NARRATION_DEMOTE, reason: 'narration-demote', bucket: 'corrected', flagged: false };
}

/** Resolve exactly one §5.3 matrix row for a single aligned sentence.
    `block` tracks the pure-narration demote run across the whole chapter;
    every other path (speech of any kind, tag-span, lumped, unaligned)
    resets it — only two consecutive narration-only sentences are ever "the
    same block". */
function decideSentence(as: AlignedSentence, opts: CrossExamineOpts, block: { active: boolean }): Decision {
  const modelId = as.sentence.characterId;

  if (as.spans.length === 0) {
    block.active = false;
    return {
      characterId: modelId,
      confidence: Math.min(modelConfidence(as.sentence), CONFIDENCE.UNALIGNED_CAP),
      reason: 'unaligned',
      bucket: 'flagged',
      flagged: true,
    };
  }

  if (as.lumped) {
    block.active = false;
    // A reattribute-only engine cannot un-lump; retagging the whole entry
    // to the speaker would voice the tag words. Keep the model id, flag.
    return { characterId: modelId, confidence: CONFIDENCE.LUMPED_FLAG, reason: 'lumped', bucket: 'lumped', flagged: true };
  }

  const speechSpan = as.spans.find((s) => s.kind === 'speech');
  if (speechSpan) {
    block.active = false;
    return speechSpan.speaker ? decideAnchoredSpeech(modelId, speechSpan, opts) : decideUnanchoredSpeech(modelId, opts);
  }

  if (as.spans.some((s) => s.kind === 'tag')) {
    block.active = false;
    return decideTagSpanOnly();
  }

  return decideNarrationOnly(modelId, block);
}

/** Cross-examine every aligned sentence against its structural evidence.
    Below the alignment floor, correction is disabled chapter-wide (§5.2) —
    every sentence gets the flag-only pass-through, never a correction. */
export function crossExamine(alignment: AlignmentResult, opts: CrossExamineOpts): CrossExamineResult {
  const flagOnly = alignment.alignedPct < opts.alignmentFloorPct;
  const report: EngineReport = {
    language: null,
    alignedPct: alignment.alignedPct,
    confirmed: 0,
    corrected: 0,
    flagged: 0,
    lumped: 0,
    escalated: 0,
    escalationAccepted: 0,
    flagOnly,
  };

  const sentences: SentenceOutput[] = [];
  const flags: Array<{ index: number; reason: string }> = [];
  const block = { active: false };

  alignment.aligned.forEach((as, index) => {
    const decision = flagOnly ? flagOnlyDecision(as) : decideSentence(as, opts, block);
    report[decision.bucket] += 1;
    if (decision.flagged) flags.push({ index, reason: decision.reason });
    sentences.push({ ...as.sentence, characterId: decision.characterId, confidence: decision.confidence });
  });

  return { sentences, flags, report };
}
