/* #3992 — the "Don't reuse" marker, read in one place.

   A row that declined a series voice link carries two server-owned lists:
   `declinedVoiceFrom` (the books whose voice it declined) and
   `declinedVoiceUuids` (the voiceUuids that were declined). "Not THIS voice" is
   about the voice, so a candidate is declined when EITHER its book or its voice
   uuid is on the list: a three-book series where Book Two shares Book One's uuid
   must not let a decline of Book Two re-link the row to Book One, which holds the
   same voice. Pure, no I/O, so the linker, the voice-match route, the analysis
   merge and the client reducer all read the marker the same way. */

const asList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

export function declinesVoice(
  row: object | null | undefined,
  candidate: { bookId?: string | null; voiceUuid?: string | null },
): boolean {
  if (!row) return false;
  const { declinedVoiceFrom, declinedVoiceUuids } = row as Record<string, unknown>;
  if (candidate.bookId && asList(declinedVoiceFrom).includes(candidate.bookId)) return true;
  return !!candidate.voiceUuid && asList(declinedVoiceUuids).includes(candidate.voiceUuid);
}
