/* #1984 Wave 1 — the impure caller for the attribution-health metric.
   `computeAttributionMeasurement` (attribution-health.ts) is pure: no fs, no
   await, no config read. Every file read the metric needs lives here instead
   — the two-read split (analysis cache + manuscript record) that R-6M1
   already caught once for the language chain alone. */

import { existsSync } from 'node:fs';
import { stateJsonPath, castJsonPath } from '../workspace/paths.js';
import { readStateJsonWithRecovery } from '../workspace/state-migrate.js';
import { readJson } from '../workspace/state-io.js';
import {
  detectManuscriptLanguageFromChapters,
  detectManuscriptLanguage,
  type DetectionResult,
} from '../tts/detect-language.js';
import { loadAnalysisCache, cachePath, type AnalysisCache } from './analysis-cache.js';
import { readAnalysisState } from './analysis-state.js';
import { getOrHydrateManuscript } from './manuscripts.js';
import { loadCastIdHistory, type CastIdHistory } from './cast-id-history.js';
import { conventionsFor } from '../analyzer/dialogue-structure/lang/index.js';
import {
  computeAttributionMeasurement,
  type AttributionMeasurement,
  type AttributionMeasurementInput,
  type CastRecordLike,
} from './attribution-health.js';
import type { SentenceOutput, CharacterOutput } from '../handoff/schemas.js';

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

/** True iff the cache carries evidence it was written by D18-aware code —
    any sentence, anywhere, has an OWN `priorCharacterId` key with a defined
    value (a real demotion/correction was recorded). Resolved ONCE per book,
    from the cache's own metadata — never inferred per-sentence, which is
    the D18 trap: an individual narrator sentence with no prior is
    ambiguous between "the model said so" and "this cache predates D18". A
    cache with zero recorded overwrites (rare but possible even post-D18)
    is conservatively treated as unknown-origin — the same "I don't know"
    default the per-sentence trap exists to enforce, one level up. */
function cacheHasOriginFieldEvidence(cache: AnalysisCache): boolean {
  for (const sentences of Object.values(cache.chapters ?? {})) {
    for (const s of sentences) {
      if (s.priorCharacterId !== undefined) return true;
    }
  }
  return false;
}

export interface MeasurementInputs {
  manuscriptId: string | null;
  cacheCorrupt: boolean;
  hasManuscript: boolean;
  hasCacheFile: boolean;
  language: string | null;
  languageSource: 'declared' | 'detected' | 'unknown';
  bodies: Record<number, string>;
  sentences: SentenceOutput[];
  cast: CastRecordLike[];
  history: CastIdHistory;
  cacheHasOriginField: boolean;
  cacheHasSentences: boolean;
}

/** The two-file read (analysis cache + manuscript record), plus cast.json
    and cast-id-history.json, plus the excluded-chapter and
    excludeFromSynthesis filters. This is where R-6M1's split is drawn: the
    pure module (attribution-health.ts) never touches fs directly. */
export async function loadMeasurementInputs(bookDir: string): Promise<MeasurementInputs> {
  const state = await readStateJsonWithRecovery(stateJsonPath(bookDir));
  const manuscriptId = state?.manuscriptId ?? null;

  const hasCacheFile = manuscriptId !== null && existsSync(cachePath(manuscriptId));
  let cache: AnalysisCache = { chapters: {} };
  let cacheCorrupt = false;
  if (manuscriptId) {
    try {
      cache = await loadAnalysisCache(manuscriptId);
    } catch {
      cacheCorrupt = true;
    }
  }

  const manuscript = manuscriptId ? await getOrHydrateManuscript(manuscriptId) : undefined;
  const hasManuscript = manuscript !== undefined;

  const excludedIds = new Set<number>();
  for (const c of state?.chapters ?? []) {
    if (c.excluded) excludedIds.add(c.id);
  }
  // Excluded chapters are dropped from BOTH halves here — the pure module
  // receives only the bodies (and their sentences) it should measure.
  const bodies: Record<number, string> = {};
  if (manuscript) {
    for (const ch of manuscript.chapterHints) {
      if (excludedIds.has(ch.id) || ch.excluded) continue;
      bodies[ch.id] = ch.body;
    }
  }

  const sentences: SentenceOutput[] = [];
  for (const [chapterIdStr, chSentences] of Object.entries(cache.chapters ?? {})) {
    const chapterId = Number(chapterIdStr);
    if (excludedIds.has(chapterId)) continue;
    for (const s of chSentences) {
      if (s.excludeFromSynthesis) continue; // fs-58 Unit B soft-exclude
      sentences.push(s);
    }
  }

  const { language, languageSource } = await resolveBookLanguage(
    bookDir,
    manuscript ? manuscript.chapterHints : [],
  );

  const castJson = await readJson<{ characters?: CharacterOutput[] }>(castJsonPath(bookDir));
  const cast: CastRecordLike[] = castJson?.characters ?? [];
  const history = await loadCastIdHistory(bookDir);

  const cacheHasSentences = Object.values(cache.chapters ?? {}).some((list) => list.length > 0);
  const cacheHasOriginField = cacheHasOriginFieldEvidence(cache);

  return {
    manuscriptId,
    cacheCorrupt,
    hasManuscript,
    hasCacheFile,
    language,
    languageSource,
    bodies,
    sentences,
    cast,
    history,
    cacheHasOriginField,
    cacheHasSentences,
  };
}

export type AttributionState = 'ok' | 'missing' | 'unmeasurable';

export interface AttributionStateResult {
  state: AttributionState;
  /** Human-readable, for the script's display — distinguishes "not
      analysed" / "no manuscript" / "cache corrupt" / "no language" /
      "healthy" rather than letting several different states render as the
      same blank-looking row (spec R-7M4). */
  reason: string;
  measurement: AttributionMeasurement | null;
}

/** Wave 1 ships steps 1-4 and 7 of the state sequence only (spec
    §Failure modes) — 4d/5/6 (`unanswered`/`drifted`/`collapsed`) have no
    threshold yet and are Wave 2's. */
export async function resolveAttributionState(bookDir: string): Promise<AttributionStateResult> {
  const inputs = await loadMeasurementInputs(bookDir);

  // Step 2: cache corrupt (loadAnalysisCache threw INSIDE the load, not at
  // measure time).
  if (inputs.cacheCorrupt) {
    return { state: 'unmeasurable', reason: 'cache corrupt', measurement: null };
  }

  // Step 2b (new in revision 8, D14): no source prose at all.
  if (!inputs.hasManuscript) {
    return { state: 'unmeasurable', reason: 'no manuscript', measurement: null };
  }

  const castCount = inputs.cast.filter((c) => c.id !== 'narrator' && c.id !== 'char-narrator').length;

  // Step 3: conventionsFor(resolvedLanguage) === null.
  if (inputs.language === null || !conventionsFor(inputs.language)) {
    return {
      state: 'unmeasurable',
      reason: inputs.language === null ? 'no language' : 'unsupported language',
      measurement: null,
    };
  }

  const measurement = computeAttributionMeasurement({
    language: inputs.language,
    languageSource: inputs.languageSource,
    bodies: inputs.bodies,
    sentences: inputs.sentences,
    roster: [],
    cast: inputs.cast,
    history: inputs.history,
    cacheHasOriginField: inputs.cacheHasOriginField,
  } satisfies AttributionMeasurementInput);

  // Step 4: castCount > 0 && spokenTotal === 0 && readAnalysisState() === null.
  // readAnalysisState is ASYNC — awaited here, not compared to null unawaited
  // (spec R-5M5: the literal comparison is never true and makes `missing`
  // silently unreachable).
  if (castCount > 0 && measurement.spokenTotal === 0) {
    const analysisState = await readAnalysisState(bookDir);
    if (analysisState === null) {
      // 4a: no source-prose sentences at all — nothing to corroborate. This
      // carve-out is D11's own motivating book (Night Watch): corroborating
      // over an empty sample would surrender (letters === 0) and silently
      // downgrade the canonical `missing` case to `unmeasurable`.
      if (!inputs.cacheHasSentences) {
        return { state: 'missing', reason: 'no sentences in cache', measurement };
      }
      // 4b: corroborate a DECLARED language against the cache's own text —
      // only meaningful when a declaration exists to be wrong.
      if (inputs.languageSource === 'declared') {
        const sampleText = Object.values(
          (await loadAnalysisCache(inputs.manuscriptId!)).chapters ?? {},
        )
          .flat()
          .map((s) => s.text)
          .join(' ');
        const corroboration = detectManuscriptLanguage(sampleText);
        if (corroboration.fallback || corroboration.language !== inputs.language) {
          return { state: 'unmeasurable', reason: 'language not corroborated', measurement };
        }
      }
      // 4c: otherwise.
      return { state: 'missing', reason: 'cast built, nothing attributed', measurement };
    }
  }

  // Steps 4d/5/6 (unanswered/drifted/collapsed) are Wave 2 — no threshold
  // ships in Wave 1.

  // Step 7: otherwise.
  return {
    state: 'ok',
    reason: inputs.hasCacheFile ? 'healthy' : 'not analysed',
    measurement,
  };
}
