/* Sentence-merge tombstones (fs-58) applied to a run's sentences — #4155.
 *
 * A tombstone is a `"chapterId:sentenceId"` key in `manuscript-edits.json`
 * (`mergedAwayKeys`). The client records one for every sentence a merge joined
 * into its lowest-id neighbour, and for a chapter's first sentence when it is
 * promoted to the chapter title, so a later re-analysis cannot resurrect it.
 *
 * Fold, not filter: a run's take for a chapter can predate the merge (a cached
 * take replays), so it carries the survivor with its original short text AND
 * the merged-away sentence. Dropping the tombstoned sentence alone would delete
 * its words from the book; appending its text to the nearest earlier kept
 * sentence of the same chapter reproduces the user's merged sentence. The
 * survivor's `instruct` and `vocalization` are deleted, as the client's
 * `mergeSentences` does. When the take already reflects the merge no
 * tombstoned key is present and the fold is a no-op.
 *
 * Promote-to-title: the tombstoned sentence has no earlier kept sentence in its
 * chapter, so it is simply dropped (its text went into the chapter title).
 *
 * Callers apply this to the sentences a run PRODUCED, never to sentences read
 * back from disk. Leaf module with no imports so it cannot close an import
 * cycle. Pure: the input array and its objects are never mutated. */

export function applyMergeTombstones<
  S extends { chapterId: number; id: number; text: string; instruct?: unknown; vocalization?: unknown },
>(sentences: readonly S[], keys: readonly string[]): S[] {
  if (keys.length === 0) return [...sentences];
  const tombstones = new Set(keys);
  const out: S[] = [];
  /** Index in `out` of the nearest kept sentence, per chapter. */
  const lastKept = new Map<number, number>();
  for (const s of sentences) {
    if (!tombstones.has(`${s.chapterId}:${s.id}`)) {
      lastKept.set(s.chapterId, out.length);
      out.push(s);
      continue;
    }
    const at = lastKept.get(s.chapterId);
    if (at === undefined) continue;
    const prev = out[at];
    const merged: S = { ...prev, text: `${prev.text} ${s.text}` };
    delete merged.instruct;
    delete merged.vocalization;
    out[at] = merged;
  }
  return out;
}
