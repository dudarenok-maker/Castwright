/* Pairing a book's chapters with a fresh parse's chapters (#3828).

   A title refresh used to pair them by position, which only holds while the book
   is in the parser's order: a reorder moves bodies, a merge or split changes the
   count. A restructured book's hints record which parse chapter each body came
   from (`parseIndex`), which is the key (`pairWithParse`); a hints file written
   before that was recorded falls back to exact body equality
   (`parseIndexByBody`). Pure: no I/O, no lock. */

/** For each body in `bodies`, the index of the parse chapter whose body is
    IDENTICAL (exact string equality: a reorder keeps each body verbatim and the
    persisted file stores it as parsed), or `null` when none or several match --
    two chapters with the same text cannot be told apart, so neither is paired.
    A `undefined` body (no hint for that chapter) is `null`. */
export function parseIndexByBody(
  bodies: ReadonlyArray<string | undefined>,
  parsedBodies: ReadonlyArray<string>,
): Array<number | null> {
  const indexesByBody = new Map<string, number[]>();
  parsedBodies.forEach((body, i) => {
    const seen = indexesByBody.get(body);
    if (seen) seen.push(i);
    else indexesByBody.set(body, [i]);
  });
  return bodies.map((body) => {
    if (body === undefined) return null;
    const seen = indexesByBody.get(body);
    return seen?.length === 1 ? seen[0]! : null;
  });
}

/** How a book's chapters pair with a fresh parse's chapters (#3828), per chapter
    in the book's order: the parse index, or `null` for a chapter with no pairing.
    - `origin`: the hints recorded the parse index each body came from
      (`parseChapterCount` is set). Text-independent, so it survives a parser change
      that moves text between a title and its body. It only holds while the parse
      has the same chapter count as when the hints were recorded; otherwise the
      split logic itself changed and the answer is `skip`.
    - `body`: a hints file written before origins existed; exact body equality.
    `hints` is one entry per book chapter (`undefined`: no hint for it). */
export function pairWithParse(
  hints: ReadonlyArray<{ body: string; parseIndex?: number } | undefined>,
  parsedBodies: ReadonlyArray<string>,
  parseChapterCount: number | undefined,
): { mode: 'origin' | 'body'; index: Array<number | null> } | { mode: 'skip' } {
  if (parseChapterCount === undefined) {
    return { mode: 'body', index: parseIndexByBody(hints.map((h) => h?.body), parsedBodies) };
  }
  if (parsedBodies.length !== parseChapterCount) return { mode: 'skip' };
  return {
    mode: 'origin',
    index: hints.map((h) =>
      h?.parseIndex !== undefined && h.parseIndex < parsedBodies.length ? h.parseIndex : null,
    ),
  };
}
