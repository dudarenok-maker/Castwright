/* Char-level scorer for review-op evaluation — succeeds scorer.ts's
   line-level scoreAttribution, which keys truth/predicted lines by
   normalised TEXT, so any segmentation change (a split, an extract) makes a
   truth line look like it simply vanished. Scoring character positions
   instead lets a correct split/extract/reattribute op register as an honest
   recall lift with harmed === 0 — exactly the case the old line scorer
   misread as a regression. */
import type { CharProjection } from './char-project.js';

export interface CharScore {
  charRecall: number; // char-weighted: correctChars / truthChars
  lineRecall: number; // per-truth-line-averaged char-correctness (perceived-quality headline)
  truthChars: number;
}

/** aliasMap is the rosterAliasMap seam (character id -> canonicalId). null
    never aliases — it means "not attributed here", not a speaker id. */
function resolveId(id: string | null, aliasMap?: Map<string, string>): string | null {
  if (id === null) return null;
  return aliasMap?.get(id) ?? id;
}

export function scoreCharRecall(
  truth: CharProjection,
  predicted: CharProjection,
  aliasMap?: Map<string, string>
): CharScore {
  let truthChars = 0;
  let correctChars = 0;
  for (let i = 0; i < truth.speakerByChar.length; i++) {
    const truthId = truth.speakerByChar[i]!;
    if (truthId === null) continue; // denominator: only truth-attributed chars
    truthChars++;
    const resolvedTruth = resolveId(truthId, aliasMap);
    const resolvedPredicted = resolveId(predicted.speakerByChar[i] ?? null, aliasMap);
    if (resolvedPredicted === resolvedTruth) correctChars++;
  }
  const charRecall = truthChars > 0 ? correctChars / truthChars : 1;

  // lineRecall averages each truth span's OWN char-correctness fraction, so a
  // long narration span and a short dialogue line weigh equally — a
  // mis-attributed short line drops lineRecall far more than its char share.
  let lineRecall = 1;
  if (truth.spans.length > 0) {
    let sumFractions = 0;
    for (const span of truth.spans) {
      const length = span.end - span.start;
      let spanCorrect = 0;
      for (let i = span.start; i < span.end; i++) {
        const resolvedTruth = resolveId(truth.speakerByChar[i]!, aliasMap);
        const resolvedPredicted = resolveId(predicted.speakerByChar[i] ?? null, aliasMap);
        if (resolvedPredicted === resolvedTruth) spanCorrect++;
      }
      sumFractions += length > 0 ? spanCorrect / length : 1;
    }
    lineRecall = sumFractions / truth.spans.length;
  }

  return { charRecall, lineRecall, truthChars };
}

export function diffHelpedHarmed(
  finalByChar: Array<string | null>,
  reviewedByChar: Array<string | null>,
  truthByChar: Array<string | null>,
  aliasMap?: Map<string, string>
): { helped: number; harmed: number; churn: number } {
  let helped = 0;
  let harmed = 0;
  let churn = 0;

  for (let i = 0; i < truthByChar.length; i++) {
    const truthId = truthByChar[i]!;
    if (truthId === null) continue; // denominator: only truth-attributed chars

    const resolvedTruth = resolveId(truthId, aliasMap);
    const resolvedFinal = resolveId(finalByChar[i] ?? null, aliasMap);
    const resolvedReviewed = resolveId(reviewedByChar[i] ?? null, aliasMap);

    const finalCorrect = resolvedFinal === resolvedTruth;
    const reviewedCorrect = resolvedReviewed === resolvedTruth;

    if (!finalCorrect && reviewedCorrect) {
      helped++;
    } else if (finalCorrect && !reviewedCorrect) {
      harmed++;
    } else if (!finalCorrect && !reviewedCorrect && resolvedFinal !== resolvedReviewed) {
      churn++; // still wrong, but changed
    }
  }

  return { helped, harmed, churn };
}
