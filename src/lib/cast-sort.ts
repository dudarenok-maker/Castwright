import type { Character } from './types';

/* Cast table ordering (display only — sorts a filtered copy, never the store
   order). Rows sort by line count descending so the most-spoken characters
   lead; the two generic minor-cast buckets (`unknown-male` / `unknown-female`,
   see server/src/analyzer/fold-minor-cast.ts) always sink to the bottom
   regardless of their pooled line count. Ties break by name for stability.

   fe-46: extracted out of `views/cast.tsx` so the store-eager
   `voice-readiness-selectors.ts` can share it without importing the
   lazy-loaded cast view. Stays free of React/store imports. */
export const UNKNOWN_BUCKET_IDS = new Set(['unknown-male', 'unknown-female']);

/** Collapse the separator/case differences that distinguish two ids minted
    for the SAME slot by different code paths (#2040's `the_torment`/
    `the-torment` drift class). Twin of the server's `normaliseIdKey`
    (`server/src/util/character-id.ts`) — keep both in sync. Unicode-
    preserving: a Cyrillic or CJK id must survive. */
export function normaliseIdKey(id: string): string {
  return id
    .toLowerCase()
    .replace(/[-_\s]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function compareCastRows(a: Character, b: Character): number {
  const aBucket = UNKNOWN_BUCKET_IDS.has(a.id);
  const bBucket = UNKNOWN_BUCKET_IDS.has(b.id);
  if (aBucket !== bBucket) return aBucket ? 1 : -1;
  const byLines = (b.lines ?? 0) - (a.lines ?? 0);
  if (byLines !== 0) return byLines;
  return a.name.localeCompare(b.name);
}
