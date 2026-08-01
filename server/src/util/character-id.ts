/** Collapse the separator/case differences that distinguish two ids minted for
    the SAME name by different code paths (#2040 RC2: cast-create.ts minted
    `the_torment` while the analyzer minted `the-torment`). This is an ENCODING
    difference, not a semantic guess — it never merges two ids whose letters
    differ, so `mairin` and `mayrin` stay distinct. Unicode-preserving, matching
    `safe-id.ts`'s `unicodeKebab` policy: a Cyrillic or CJK id must survive. */
export function normaliseIdKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-_\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
