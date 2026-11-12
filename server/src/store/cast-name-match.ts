/* Name/decline comparators shared by the cast merge and the single re-analysis
   matcher (#4031). A leaf: imports nothing from store/. */

/** Surname-tolerant name comparison for the name-fallback (#2536). Two
    normalised names match when identical (unchanged exact behaviour) OR one is
    a strict token-superset of the other by exactly one TRAILING token — same
    leading token(s), the longer side carrying exactly one extra trailing token.
    That is the shape of a character gaining or losing a surname token between
    analyzer runs ("бранн уир" vs "бранн"): `normaliseForMatch` already
    lowercase/whitespace-collapses, so `split(' ')` yields the token sequence.

    Deliberately token-count-only, never general edit-distance/similarity: a
    similarity measure could weld two genuinely different characters whose names
    merely resemble each other, and token-count + strict-leading-prefix keeps
    that from happening (#2536 decision — surname-aware, not fuzzy). */
export function surnameTolerantMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const ta = a.split(' ');
  const tb = b.split(' ');
  const shorter = ta.length < tb.length ? ta : tb;
  const longer = ta.length < tb.length ? tb : ta;
  if (longer.length !== shorter.length + 1) return false;
  for (let i = 0; i < shorter.length; i++) {
    if (shorter[i] !== longer[i]) return false;
  }
  return true;
}

/** True when `c` declined, in its notLinkedTo, the series link `other` carries
    in matchedFrom. That decline is cross-book, so the id-keyed
    `notLinkedToId` check cannot see it; but a collapse keeps one row and would hand the declined link
    to the survivor, for the next run's linker to land (#3965). Matched on the
    link's own (bookId, characterId); a bare string matches by characterId. */
export function declinesLinkOf(c: Record<string, unknown>, other: Record<string, unknown>): boolean {
  const mf = other.matchedFrom as { bookId?: unknown; characterId?: unknown } | undefined;
  if (!mf || typeof mf.characterId !== 'string' || !Array.isArray(c.notLinkedTo)) return false;
  return (c.notLinkedTo as unknown[]).some((entry) => {
    if (typeof entry === 'string') return entry === mf.characterId;
    if (!entry || typeof entry !== 'object') return false;
    const e = entry as { bookId?: unknown; characterId?: unknown };
    return e.characterId === mf.characterId && (e.bookId === undefined || e.bookId === mf.bookId);
  });
}

/** `a` plus the entries of `b` it lacks, deduped by (bookId, characterId); a
    bare-string entry dedupes by its value. Never mutates either input. */
export function unionNotLinkedTo(a: unknown[] | undefined, b: unknown[]): unknown[] {
  const keyOf = (e: unknown): string =>
    e && typeof e === 'object'
      ? JSON.stringify([(e as { bookId?: unknown }).bookId, (e as { characterId?: unknown }).characterId])
      : `s:${String(e)}`;
  const out = [...(a ?? [])];
  const seen = new Set(out.map(keyOf));
  for (const e of b) {
    const k = keyOf(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
  }
  return out;
}
