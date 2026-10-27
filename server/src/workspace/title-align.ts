/* Pairing a book's chapters with a fresh parse's chapters BY BODY (#3828).

   A title refresh used to pair them by position, which only holds while the book
   is in the parser's order: a reorder moves bodies, a merge or split changes the
   count. A chapter body is the one thing a restructure carries along verbatim, so
   it identifies the chapter. Pure: no I/O, no lock. */

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
