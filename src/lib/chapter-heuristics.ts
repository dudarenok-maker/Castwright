/* Confirm-stage chapter utilities.
   Front/back-matter detection (isLikelyFrontMatter + FRONT_MATTER_RX) has moved
   server-side (seam 3b, fs-41/fs-50): the server now computes a per-chapter
   `isLikelyFrontMatter` flag in POST /api/import and the confirm view consumes it
   directly. The client-side English-only regex mirror is retired.
   This file retains only the slug helpers needed to build the excludedSlugs
   wire payload for POST /api/books. */

/* Match the server’s slug derivation in server/src/workspace/paths.ts so
   confirm-stage exclusion lists reach `/api/books` with slugs the server
   recognises. The combined form is `${id-pad}-${slug(title)}`. */
function slugify(title: string): string {
  return (
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'untitled'
  );
}

export function chapterSlug(id: number, title: string): string {
  return `${String(id).padStart(2, '0')}-${slugify(title)}`;
}
