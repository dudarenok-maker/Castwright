/* GET /state `paragraphsMergedChapters` (#2254, spec §3.2 "Data path" item 1).

   Which non-excluded chapters of a notice-language book have a degraded
   (merged-turn) hydrated body. A derived read only: nothing is written.

   The expensive part (measuring every chapter body) is memoised once per
   hydrated record in a WeakMap, UNFILTERED (excluded chapters included). The
   cheap parts that depend on state.json, which changes without replacing the
   record, run on every request and are never memoised: the hints/state pairing
   check (R5-7) and the exclusion filter against the CURRENT `state.chapters`
   (R6-8). */

import type { ManuscriptRecord } from '../store/manuscripts.js';
import { isParagraphDegraded, NOTICE_LANGUAGES } from '../analyzer/dialogue-structure/legibility.js';
import { HintsOutOfSyncError, assertHintsPairWithState } from './restructure.js';
import { bookStateLanguageOrNull, type BookStateJson } from './scan.js';

const memo = new WeakMap<ManuscriptRecord, { language: string; ids: number[] }>();

/** The ids to emit as `paragraphsMergedChapters`, or `undefined` to omit the key
    (not measured, paired wrongly, or nothing flagged). */
export function paragraphsMergedChapterIds(
  state: BookStateJson,
  rec: ManuscriptRecord | undefined,
): number[] | undefined {
  if (!rec) return undefined;
  const language = bookStateLanguageOrNull(state);
  if (!language) return undefined;
  const base = language.toLowerCase().split(/[-_]/u)[0];
  if (!NOTICE_LANGUAGES.includes(base)) return undefined;

  let entry = memo.get(rec);
  if (!entry || entry.language !== language) {
    const ids: number[] = [];
    for (const hint of rec.chapterHints) {
      if (isParagraphDegraded(hint.body, language) === true) ids.push(hint.id);
    }
    entry = { language, ids };
    memo.set(rec, entry);
  }

  if (rec.hintsSource === 'parse') {
    try {
      assertHintsPairWithState(state, rec.chapterHints, rec.parseTitles);
    } catch (e) {
      if (e instanceof HintsOutOfSyncError) return undefined;
      throw e;
    }
  }

  const excluded = new Set(state.chapters.filter((c) => c.excluded === true).map((c) => c.id));
  const ids = entry.ids.filter((id) => !excluded.has(id));
  return ids.length > 0 ? ids : undefined;
}
