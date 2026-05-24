/* Plan 108 Wave 3 — resolve the TTS engine set a queued chapter requires.
 *
 * A queue entry should indicate whether a chapter is multi-TTS (needs >1
 * engine) or single-model, and NAME the engines it needs, so the operator sees
 * this before the chapter runs. We compute it SERVER-side at enqueue time the
 * same way generation derives speakers: cast.json gives each character's
 * per-character `ttsEngine`; the analysis cache gives who actually speaks in
 * the chapter; the book default (from user settings) fills characters with no
 * override.
 *
 * Robust by design — every lookup can come back empty (unknown book, cast not
 * confirmed, analysis not cached, chapter has no analysed sentences). In every
 * such case we return `null` so the enqueue stays a success with the fields
 * simply omitted (= legacy / unknown), rather than failing the enqueue. */

import { castJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import { findBookByBookId } from './scan.js';
import { loadAnalysisCache } from '../store/analysis-cache.js';
import { engineForModelKey, type TtsEngine } from '../tts/index.js';
import { chapterEngineSet, isMultiTts } from '../tts/chapter-engine-set.js';
import { getCachedUserSettings } from './user-settings.js';
import type { HasTtsEngine } from '../tts/per-character-engine.js';

interface CastCharacterLike extends HasTtsEngine {
  id: string;
}

export interface ChapterEngineStamp {
  requiredEngines: TtsEngine[];
  multiTts: boolean;
}

/** The book's default TTS engine — derived from the user-wide default model
    key (there is no per-book override today; `selectEnginesInUse` makes the
    same assumption on the frontend). */
function bookDefaultEngine(): TtsEngine {
  return engineForModelKey(getCachedUserSettings().defaultTtsModelKey);
}

/** Resolve the engine set for one queued chapter. Returns `null` whenever the
    inputs aren't available so the caller omits the fields. */
export async function resolveChapterEngineStamp(
  bookId: string,
  chapterId: number,
): Promise<ChapterEngineStamp | null> {
  const located = await findBookByBookId(bookId);
  if (!located?.state.manuscriptId) return null;
  const { bookDir, state } = located;

  const cast = await readJson<{ characters: CastCharacterLike[] }>(castJsonPath(bookDir));
  if (!cast?.characters?.length) return null;

  const analysis = await loadAnalysisCache(state.manuscriptId);
  const sentences = analysis.chapters?.[chapterId];
  if (!sentences?.length) return null;

  /* Which characters actually speak in this chapter (analysis cache), narrowed
     to the confirmed cast (a sentence may reference an id the cast doesn't
     carry after edits — skip those rather than invent an engine). */
  const speakingIds = new Set(sentences.map((s) => s.characterId));
  const speakers = cast.characters.filter((c) => speakingIds.has(c.id));
  if (speakers.length === 0) return null;

  const requiredEngines = chapterEngineSet(speakers, bookDefaultEngine());
  if (requiredEngines.length === 0) return null;
  return { requiredEngines, multiTts: isMultiTts(requiredEngines) };
}
