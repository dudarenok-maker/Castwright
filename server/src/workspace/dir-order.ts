/* Deterministic directory order for the book-tree walks (#3713).
   A leaf module: it imports nothing from the workspace, so both book-op-lock.ts
   and scan.ts can share it without adding an import cycle.

   Raw `readdirSync` order is the filesystem's: NTFS sorts case-insensitively,
   ext4 uses hash order. Sorting here makes "the first match" for a duplicated
   bookId the same on every platform. */

/** Compare two directory names the way NTFS lists them (case-insensitive by
 *  UTF-16 code unit), breaking case-only ties on the raw name. Deliberately NOT
 *  `localeCompare`: that depends on the machine's ICU data and would differ
 *  between hosts. Keeps the first match on an existing Windows workspace unchanged. */
export function compareDirNames(a: string, b: string): number {
  const ua = a.toUpperCase();
  const ub = b.toUpperCase();
  if (ua < ub) return -1;
  if (ua > ub) return 1;
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** A sorted copy of `names`, in `compareDirNames` order. */
export function sortDirNames(names: string[]): string[] {
  return [...names].sort(compareDirNames);
}
