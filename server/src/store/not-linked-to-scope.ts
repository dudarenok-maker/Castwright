/** True when `row.notLinkedTo` names `targetId`, in either shape the field is
    written in: a bare string (defensive; nothing mints this shape today) or
    the real on-disk `{ bookId, characterId }` shape `POST /not-linked-to`
    writes (`server/src/routes/cast-not-linked-to.ts`; typed in `voices.ts`
    and `voice-override-linked.ts`).

    Book scoping (#3965, owner decision 2026-10-31): an OBJECT entry whose
    `bookId` names a DIFFERENT book than `currentBookId` is a cross-book
    "not the same person" decision and says nothing about a same-book join,
    so it is ignored. The earlier bookId-blind trade ("a false 'not linked'
    only costs a match a user can still do by hand") failed its own premise:
    the seed copies a prior row's cross-book edge onto its id-drifted twin,
    and honouring it here split that locked character and cost its voice.
    Same-book object entries (the one-sided edge `cast-reject-orphan.ts`
    writes) and bare strings still block. `currentBookId` omitted (a record
    with no `bookId`) keeps the old bookId-blind behaviour as the fail-safe.
    (The same-name dedupe's `groupHasNotLinkedEdge` additionally ignores a
    row's edge naming ITS OWN id, which `main` counted: a self-edge is not a
    decision between two rows. Declared in the PR body.)

    The ONE book-scope predicate shared by every notLinkedTo join gate
    (`merge-analysis-cast.ts` fresh-to-prior match and same-name dedupe,
    `remap-fresh-to-prior.ts`) - a gate with its own copy drifts. */
export function notLinkedToId(
  row: Record<string, unknown>,
  targetId: string,
  currentBookId?: string,
): boolean {
  const nl = row.notLinkedTo;
  if (!Array.isArray(nl)) return false;
  return nl.some((entry) => {
    if (typeof entry === 'string') return entry === targetId;
    if (entry && typeof entry === 'object') {
      const e = entry as { characterId?: unknown; bookId?: unknown };
      if (
        typeof currentBookId === 'string' &&
        typeof e.bookId === 'string' &&
        e.bookId !== currentBookId
      ) {
        return false;
      }
      return e.characterId === targetId;
    }
    return false;
  });
}
