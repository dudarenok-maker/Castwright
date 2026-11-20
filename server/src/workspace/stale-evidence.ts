/* Plan 290 (#3837, round 10) — when a whole-state swap (the bundle overwrite,
   a backup restore) stamps the stale-evidence marker `sentencesPredateChapters`.

   Both swaps replace state.json and leave the local manuscript-edits.json in
   place. Those saved sentences are stale only if the incoming chapter list is
   not the one they are keyed to: so the marker is stamped when the edits hold
   sentences (or cannot be read — unknown content is treated as stale) AND the
   incoming chapter list differs from the book's current one, the extractor
   stamp differs (#4217), or the current state is already marked. A same-chapters restore leaves it absent, so the
   overlay callers apply the saved corrections as main does. Pure: the callers
   read both inputs under their own existing locks. */

import { sentencesOf, type EditsForCheck } from './hints-proof-io.js';
import { extractorVersionOf } from '../parsers/version.js';
import type { BookStateJson } from './scan.js';

type ChapterKey = Pick<BookStateJson['chapters'][number], 'id' | 'title'>;

/** Same ids and titles, in the same order. A missing list (a hand-edited or
    malformed state) matches nothing. */
export function chaptersMatchForEvidence(a: readonly ChapterKey[], b: readonly ChapterKey[]): boolean {
  if (!Array.isArray(a) || !Array.isArray(b)) return false;
  return a.length === b.length && a.every((c, i) => c.id === b[i]!.id && c.title === b[i]!.title);
}

/** Whether a swap to `incoming` leaves `edits` keyed to an older chapter list or
    an older extraction. The saved sentences are keyed to the extractor version
    as well (#4217): the v1 and v2 bodies of the same chapters split into
    different sentences, so a differing stamp is stale too. `current` is the
    book's live state before the swap; null (absent or unreadable) counts as a
    different list. */
export function swapLeavesStaleEvidence(
  edits: EditsForCheck,
  incoming: Pick<BookStateJson, 'chapters' | 'manuscriptExtractorVersion'>,
  current: Pick<BookStateJson, 'chapters' | 'sentencesPredateChapters' | 'manuscriptExtractorVersion'> | null,
): boolean {
  const editsMayHoldSentences =
    edits.kind === 'corrupt' ||
    edits.kind === 'unreadable' ||
    (edits.kind === 'ok' && sentencesOf(edits.value).length > 0);
  if (!editsMayHoldSentences) return false;
  if (current === null || current.sentencesPredateChapters === true) return true;
  if (extractorVersionOf(incoming) !== extractorVersionOf(current)) return true;
  return !chaptersMatchForEvidence(incoming.chapters, current.chapters);
}
