/* #1984 Wave 1 — the impure caller for the attribution-health metric.
   `computeAttributionMeasurement` (attribution-health.ts) is pure: no fs, no
   await, no config read. Every file read the metric needs lives here instead
   — the two-read split (analysis cache + manuscript record) that R-6M1
   already caught once for the language chain alone. */

import { stateJsonPath } from '../workspace/paths.js';
import { readStateJsonWithRecovery } from '../workspace/state-migrate.js';
import {
  detectManuscriptLanguageFromChapters,
  type DetectionResult,
} from '../tts/detect-language.js';

export interface BookLanguageResolution {
  /** null only when languageSource === 'unknown' and nothing was resolved. */
  language: string | null;
  languageSource: 'declared' | 'detected' | 'unknown';
}

/** Resolve a book's language for the attribution-health metric.
    `state.json`'s `language` field is read RAW — this is the one place that
    needs the difference between "declared English" and "nothing declared".
    The in-tree accessor `bookStateLanguage` (scan.ts:314) defaults an absent
    value to `'en'` via `normaliseBookLanguage`, which is right for every
    other caller and wrong here: it would make detection (step 2) never run
    for any of the 7 live books with no declared language. */
export async function resolveBookLanguage(
  bookDir: string,
  chapters: Array<{ title: string; body: string }>,
): Promise<BookLanguageResolution> {
  const state = await readStateJsonWithRecovery(stateJsonPath(bookDir));
  const declared = state?.language;
  if (declared) {
    return { language: declared, languageSource: 'declared' };
  }

  // #2263 — detectManuscriptLanguageFromChapters already applies
  // selectBodyChapters internally (drops front/back matter from the voting
  // pool) and keys on { title, body }, which the analysis cache does not
  // carry — a second reason the metric needs the manuscript record.
  const detection: DetectionResult = detectManuscriptLanguageFromChapters(chapters);
  if (detection.fallback) {
    // A surrender (no letters to sample, or franc found no Latin match) is
    // NOT a decision — `language: 'en'` there is a confidence-floor guess,
    // not evidence. Report 'unknown', never silently 'en'.
    return { language: null, languageSource: 'unknown' };
  }
  return { language: detection.language, languageSource: 'detected' };
}
