/* #1984 Wave 1 — the attribution-health metric. Pure: no fs, no await, no
   config read (R-6M1). Both file reads the caller needs — the analysis
   cache and the manuscript record — live in attribution-health-io.ts.

   The metric, in one sentence (the whole point of this wave): the
   denominator is the set of `speech` spans `parseChapterStructure` finds in
   `ch.body`; the numerator is those spans whose aligned model sentence
   resolves to a narrator id; the join is `alignSentences`; every count is a
   count of SOURCE SPANS, never of model sentences. A field whose value can
   change when the model re-punctuates its output without changing any
   attribution is wrong — that is exactly the false-recovery #1984 was
   raised to stop (D14). One field is a deliberate, documented exception:
   `lumpedSpeech` measures ALIGNMENT shape — whether a model sentence's own
   matched text straddles a speech/tag(narration) boundary — which is by
   definition a property of how the model chose to sentence-boundary its
   output, not of the source alone. It can move under re-punctuation with no
   attribution change, same as the model's own choice to merge or split a
   turn can. That is exactly why it is a diagnostic only: absent from
   `COLUMNS`, never summed into the share, never gated on (finding 5).

   No new "is this dialogue" predicate is written here, for any reason —
   this module imports `parseChapterStructure` and `alignSentences` rather
   than re-deriving what they already decide (spec F2). `isSpokenLine` is a
   surface this metric MEASURES, not a tool it calls. */

import { conventionsFor } from '../analyzer/dialogue-structure/lang/index.js';
import { buildNameIndex, type RosterEntry } from '../analyzer/dialogue-structure/name-matcher.js';
import { parseChapterStructure } from '../analyzer/dialogue-structure/parser.js';
import { alignSentences, type AlignedSentence } from '../analyzer/dialogue-structure/aligner.js';
import type { SpanEvidence } from '../analyzer/dialogue-structure/types.js';
import { buildCastResolver } from './cast-resolve.js';
import { NARRATOR_CHARACTER_IDS } from '../analyzer/narrator-identity.js';
import type { SentenceOutput } from '../handoff/schemas.js';
import type { CastIdHistory } from './cast-id-history.js';

/** Every count below is a count of SOURCE SPANS (D14), not of model
    sentences. That is the one sentence to carry into every field. */
export interface AttributionMeasurement {
  language: string | null; // resolved BCP-47 primary subtag; null iff 'unknown'
  languageSource: 'declared' | 'detected' | 'unknown';

  // ---- denominator: parsed from ch.body, independent of the model (D14) ----
  spokenTotal: number; // `speech` spans in dialogue paragraphs
  tagTotal: number; // `tag` spans — the D15 sibling column

  // ---- how much of the denominator the model actually answered (D17) ----
  unattributedSpeech: number; // speech spans NO aligned sentence covers
  splitSpeech: number; // >1 aligned sentence, disagreeing ids
  lumpedSpeech: number; // aligned sentence straddles speech + tag/narration —
  // the D14 "count of source spans" exception (finding 5), see header

  // ---- numerator, split by origin (D18) ----
  narratorIdSpoken: number; // speech spans resolving to NARRATOR_CHARACTER_IDS
  modelNarrator: number; // stage-2 returned narrator directly
  demotedNarrator: number; // a post-stage-2 step overwrote it (priorCharacterId present)
  unknownOriginNarrator: number; // cache predates priorCharacterId

  // ---- id drift (D9), re-based on spans — D13 was dropped, not deferred (#2357) ----
  orphanSpoken: number; // unresolvable id; reported, NEVER summed into the share
  orphanIds: string[]; // distinct unresolvable ids

  attributableSpoken: number; // speech spans with EXACTLY ONE resolvable
  // attribution — the denominator of the share. Counted DIRECTLY, never as
  // spokenTotal minus other columns (they overlap; subtraction can go
  // negative — R-9C5).

  // ---- sibling signals ----
  tagNarratorSpan: number; // tag spans attributed to narrator — reported, never alarmed on
  dashOnlySpoken: number; // diagnostic
  castCount: number; // non-narrator cast members, from cast.json

  chapters: Array<{
    chapterId: number;
    spokenTotal: number;
    attributableSpoken: number;
    narratorIdSpoken: number;
    unattributedSpeech: number;
    orphanSpoken: number;
  }>;
}

export interface CastRecordLike {
  id: string;
}

export interface AttributionMeasurementInput {
  /** Resolved BCP-47 code, or null when languageSource is 'unknown'. */
  language: string | null;
  languageSource: 'declared' | 'detected' | 'unknown';
  /** chapterId -> source prose body. Excluded chapters are already dropped
      by the caller (Task 7) — this module receives only what it should
      measure. */
  bodies: Record<number, string>;
  /** Flat sentence list across all chapters (SentenceOutput.chapterId picks
      the chapter). excludeFromSynthesis sentences already dropped by the
      caller. */
  sentences: SentenceOutput[];
  /** ANY roster, including empty — parseChapterStructure's signature needs
      an index, not a specific roster (D14's model-independence proof). */
  roster: RosterEntry[];
  /** cast.json's characters, for buildCastResolver. */
  cast: readonly CastRecordLike[];
  history?: Pick<CastIdHistory, 'supersededBy' | 'rejected' | 'rejectedPairs'>;
  /** Resolved once by the caller from the cache's own metadata (Task 7) —
      NEVER inferred per-sentence. True iff the cache was produced by
      D18-aware code. */
  cacheHasOriginField: boolean;
}

const NARRATOR_IDS = new Set(NARRATOR_CHARACTER_IDS);

function emptyMeasurement(
  language: string | null,
  languageSource: AttributionMeasurement['languageSource'],
  castCount: number,
): AttributionMeasurement {
  return {
    language,
    languageSource,
    spokenTotal: 0,
    tagTotal: 0,
    unattributedSpeech: 0,
    splitSpeech: 0,
    lumpedSpeech: 0,
    narratorIdSpoken: 0,
    modelNarrator: 0,
    demotedNarrator: 0,
    unknownOriginNarrator: 0,
    orphanSpoken: 0,
    orphanIds: [],
    attributableSpoken: 0,
    tagNarratorSpan: 0,
    dashOnlySpoken: 0,
    castCount,
    chapters: [],
  };
}

export function computeAttributionMeasurement(
  input: AttributionMeasurementInput,
): AttributionMeasurement {
  const castCount = input.cast.filter((c) => !NARRATOR_IDS.has(c.id)).length;

  if (input.language === null) {
    return emptyMeasurement(null, input.languageSource, castCount);
  }
  const conv = conventionsFor(input.language);
  if (!conv) {
    return emptyMeasurement(input.language, input.languageSource, castCount);
  }

  const index = buildNameIndex(input.roster, conv);
  const resolver = buildCastResolver(input.cast as { id: string }[], input.history);

  const sentencesByChapter = new Map<number, SentenceOutput[]>();
  for (const s of input.sentences) {
    const list = sentencesByChapter.get(s.chapterId) ?? [];
    list.push(s);
    sentencesByChapter.set(s.chapterId, list);
  }

  const result = emptyMeasurement(input.language, input.languageSource, castCount);
  const orphanIds = new Set<string>();

  const chapterIds = Object.keys(input.bodies)
    .map(Number)
    .sort((a, b) => a - b);

  for (const chapterId of chapterIds) {
    const body = input.bodies[chapterId];
    const paras = parseChapterStructure(body, index);
    const chapterSentences = sentencesByChapter.get(chapterId) ?? [];
    const alignment = alignSentences(chapterSentences, paras, body, conv.dialogueOpen !== null);

    // Map each aligned sentence to the spans it overlaps, per span.
    const alignedBySpan = new Map<SpanEvidence, AlignedSentence[]>();
    for (const as of alignment.aligned) {
      for (const span of as.spans) {
        const list = alignedBySpan.get(span) ?? [];
        list.push(as);
        alignedBySpan.set(span, list);
      }
      if (as.lumped) result.lumpedSpeech += 1;
    }

    let chSpokenTotal = 0;
    let chAttributableSpoken = 0;
    let chNarratorIdSpoken = 0;
    let chUnattributedSpeech = 0;
    let chOrphanSpoken = 0;

    for (const para of paras) {
      // dashOnlySpoken (calibration diagnostic): was THIS PARAGRAPH opened by
      // the language's dash marker at all — not whether an individual span's
      // sliced text happens to start with one (the parser deliberately
      // leaves the opening dash + its trailing space uncovered by any span,
      // per parser.ts's tiling contract).
      const paraText = body.slice(para.start, para.end);
      const dashOpenedPara = !!(conv.dialogueOpen && conv.dialogueOpen.test(paraText));

      for (const span of para.spans) {
        if (span.kind === 'tag') {
          result.tagTotal += 1;
          const alignedForTag = alignedBySpan.get(span) ?? [];
          const idsForTag = new Set(alignedForTag.map((as) => as.sentence.characterId));
          if (alignedForTag.length > 0 && idsForTag.size === 1 && NARRATOR_IDS.has([...idsForTag][0])) {
            result.tagNarratorSpan += 1;
          }
          continue;
        }
        if (span.kind !== 'speech') continue;

        chSpokenTotal += 1;
        const text = body.slice(span.start, span.end);
        // "carries no quote mark at all" — no glyph from the language's own
        // quotePairs anywhere in the span's text.
        if (dashOpenedPara && !conv.quotePairs.some(([o, c]) => text.includes(o) || text.includes(c))) {
          result.dashOnlySpoken += 1;
        }

        const alignedForSpan = alignedBySpan.get(span) ?? [];
        if (alignedForSpan.length === 0) {
          result.unattributedSpeech += 1;
          chUnattributedSpeech += 1;
          continue;
        }
        const idsForSpan = new Set(alignedForSpan.map((as) => as.sentence.characterId));
        if (idsForSpan.size > 1) {
          result.splitSpeech += 1;
          // R-9C5 — orphanSpoken and splitSpeech OVERLAP: a span with two
          // disagreeing sentences, one of them unresolvable, is BOTH. Report
          // every unresolvable id among the disagreeing set (orphanIds), but
          // orphanSpoken itself is a count of SPANS (D14) — increment it AT
          // MOST ONCE for this span, not once per bogus id, else re-splitting
          // one span into more model sentences with more bogus ids inflates
          // it with no attribution change (finding 1). This span never
          // reaches attributableSpoken either way (a direct count, never a
          // subtraction — the overlap can't make it negative).
          let sawOrphan = false;
          for (const id of idsForSpan) {
            if (!resolver.resolve(id)) {
              orphanIds.add(id);
              sawOrphan = true;
            }
          }
          if (sawOrphan) {
            result.orphanSpoken += 1;
            chOrphanSpoken += 1;
          }
          continue;
        }
        // Exactly one distinct id agrees across every aligned sentence.
        const modelId = [...idsForSpan][0];
        const resolution = resolver.resolve(modelId);
        if (!resolution) {
          result.orphanSpoken += 1;
          chOrphanSpoken += 1;
          orphanIds.add(modelId);
          continue;
        }
        // Exactly one resolvable attribution — this span counts toward the share.
        chAttributableSpoken += 1;

        if (NARRATOR_IDS.has(resolution.character.id)) {
          chNarratorIdSpoken += 1;
          result.narratorIdSpoken += 1;

          // #1984 D18 — split by origin. The representative sentence carries
          // priorCharacterId when a post-stage-2 step overwrote it.
          const originSentence = alignedForSpan[0].sentence;
          if (originSentence.priorCharacterId !== undefined) {
            result.demotedNarrator += 1;
          } else if (input.cacheHasOriginField) {
            result.modelNarrator += 1;
          } else {
            result.unknownOriginNarrator += 1;
          }
        }
      }
    }

    result.spokenTotal += chSpokenTotal;
    result.attributableSpoken += chAttributableSpoken;
    result.chapters.push({
      chapterId,
      spokenTotal: chSpokenTotal,
      attributableSpoken: chAttributableSpoken,
      narratorIdSpoken: chNarratorIdSpoken,
      unattributedSpeech: chUnattributedSpeech,
      orphanSpoken: chOrphanSpoken,
    });
  }

  result.orphanIds = [...orphanIds].sort();
  return result;
}

/** The share `scripts/measure-attribution.mjs` prints (Task 8) — never a
    field on AttributionMeasurement itself (no threshold logic ships in
    Wave 1). Null when there is nothing to divide, so a wholly-orphaned or
    wholly-unattributed book reads as "nothing to say", never as a
    confidently-healthy 0% (D9's own failure shape, taking orphans out of
    the numerator alone without also excluding them from the denominator). */
export function attributionShare(m: Pick<AttributionMeasurement, 'narratorIdSpoken' | 'attributableSpoken'>): number | null {
  if (m.attributableSpoken === 0) return null;
  return m.narratorIdSpoken / m.attributableSpoken;
}
