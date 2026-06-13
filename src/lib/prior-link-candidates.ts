/* Pure filter for the Profile Drawer's "link to a prior series book" picker.

   A recurring character appears once PER prior book (The Tidewatcher’s Oath's "Dame Linnet",
   The Ebb's "Dame Linnet", Saltgrave's "Councillor Linnet", …). The picker should
   only offer people this book hasn't already pinned to a canonical identity —
   otherwise a user who links one copy still sees the same person listed under
   every other book and concludes the link "didn't take".

   Two suppression rules, OR'd:
     1. Exact link target — a local character's `matchedFrom` already points at
        this (bookId, characterId). The original, narrow rule.
     2. Shared canonical voice — a local character already carries the same
        `voiceId` as the candidate. `voiceId` is the series-wide propagation key
        (cast-link-prior.ts stamps `target.voiceId ?? target.id` onto every
        linked row), so a shared, non-empty voiceId means "same person, already
        in this cast" even when `matchedFrom` happens to point at a different
        volume of the same identity. This is what collapses ALL of a person's
        prior-book copies once any one of them is linked. */

import type { SeriesRosterEntry } from './api';
import type { Character } from './types';

export function filterLinkablePriorCandidates(
  localCharacters: ReadonlyArray<Pick<Character, 'matchedFrom' | 'voiceId'>>,
  priorRoster: ReadonlyArray<SeriesRosterEntry>,
): SeriesRosterEntry[] {
  const linkedKeys = new Set<string>();
  const localVoiceIds = new Set<string>();
  for (const c of localCharacters) {
    const mf = c.matchedFrom;
    if (mf?.bookId && mf?.characterId) linkedKeys.add(`${mf.bookId}::${mf.characterId}`);
    if (c.voiceId) localVoiceIds.add(c.voiceId);
  }
  return priorRoster.filter((p) => {
    if (linkedKeys.has(`${p.bookId}::${p.id}`)) return false;
    if (p.voiceId && localVoiceIds.has(p.voiceId)) return false;
    return true;
  });
}
