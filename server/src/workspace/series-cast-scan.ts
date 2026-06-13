/* Series-scoped slice of scanLibraryCharacters. Returns every confirmed
   character whose owning book shares the supplied (author, series) pair,
   optionally excluding a specific bookId (typically the book about to
   run analysis — its own cast shouldn't pre-seed itself).

   Consumed by Phase 0a's per-chapter detection prompt (C2): the analyzer
   gets a "Known characters from prior books in this series" section so
   The Floodmark's per-chapter detector recognises Wren / Marlow / Oduvan /
   Maerin etc. from the confirmed characters across the Hollow Tide +
   the Coalfall Commission rather than re-detecting them as fresh entities.

   Single-series scoped on purpose: cross-series carry-over (e.g. Wren
   appearing in the Hollow Tide + a spinoff in a different series) is a bigger
   product question -- needs explicit user-driven linking or a per-author
   scan -- tracked as a TBD follow-up in plan 32. */

import type { LibraryCharacterRecord } from './library-cast-scan.js';
import { scanLibraryCharacters } from './library-cast-scan.js';
import { BOOKS_ROOT, stateJsonPath } from './paths.js';
import { join } from 'node:path';
import { readJson } from './state-io.js';
import type { BookStateJson } from './scan.js';

export interface ScanSeriesOptions {
  /** Optional bookId to exclude from the scan (the book about to use
      the prior). A book never seeds its own per-chapter prompt with
      its own characters — that's a tautology and would distort the
      live-detection roster the model returns. */
  excludeBookId?: string;
}

/* Resolve a book's (author, series) by walking its state.json. Done via
   a fresh read rather than threading state through the existing scan
   because library-cast-scan flattens away the (author, series) levels
   in its output shape. Worth the extra IO — series-cast scans run once
   per analysis (not per chapter) and the cache is tiny.

   Returns null when the bookId isn't in the library (e.g. a brand-new
   book whose state.json was just written but state.castConfirmed is
   still false — already excluded by scanLibraryCharacters but caller
   may still pass us its bookId). */
export async function findAuthorSeriesForBookId(
  targetBookId: string,
): Promise<{ author: string; series: string } | null> {
  const { existsSync, readdirSync } = await import('node:fs');
  if (!existsSync(BOOKS_ROOT)) return null;
  const authors = readdirSync(BOOKS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
  for (const authorName of authors) {
    const seriesNames = readdirSync(join(BOOKS_ROOT, authorName), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const seriesName of seriesNames) {
      const titles = readdirSync(join(BOOKS_ROOT, authorName, seriesName), { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
      for (const titleName of titles) {
        const state = await readJson<BookStateJson>(
          stateJsonPath(join(BOOKS_ROOT, authorName, seriesName, titleName)),
        );
        if (state?.bookId === targetBookId) {
          return { author: state.author, series: state.series };
        }
      }
    }
  }
  return null;
}

/* Filter scanLibraryCharacters to a single (author, series) slice.
   Standalones (state.isStandalone === true) are intentionally excluded
   from the series scope even when they happen to live under the
   synthetic 'Standalones' folder -- a standalone's cast is not part
   of any series's continuity.

   Resolution: walks each LibraryCharacterRecord's bookId back through
   state.json to find its author + series. Yes, this re-reads every
   book's state.json -- in exchange we don't need to re-flatten the
   tree manually, and library-cast-scan stays the single source of
   truth for "what counts as a confirmed character." Acceptable cost:
   a series scan runs ONCE per analysis, not per chapter. */
export async function scanSeriesCharacters(
  author: string,
  series: string,
  options: ScanSeriesOptions = {},
): Promise<LibraryCharacterRecord[]> {
  const all = await scanLibraryCharacters();
  if (all.length === 0) return [];

  /* Build a bookId → (author, series, isStandalone) index in one pass
     so the filter below is O(n) over the flat library output. */
  const { existsSync, readdirSync } = await import('node:fs');
  if (!existsSync(BOOKS_ROOT)) return [];
  const lookup = new Map<string, { author: string; series: string; isStandalone: boolean }>();
  for (const authorName of readdirSync(BOOKS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)) {
    for (const seriesName of readdirSync(join(BOOKS_ROOT, authorName), { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)) {
      for (const titleName of readdirSync(join(BOOKS_ROOT, authorName, seriesName), {
        withFileTypes: true,
      })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)) {
        const state = await readJson<BookStateJson>(
          stateJsonPath(join(BOOKS_ROOT, authorName, seriesName, titleName)),
        );
        if (!state?.bookId) continue;
        lookup.set(state.bookId, {
          author: state.author,
          series: state.series,
          isStandalone: state.isStandalone === true,
        });
      }
    }
  }

  return all.filter((record) => {
    if (options.excludeBookId && record.bookId === options.excludeBookId) return false;
    const meta = lookup.get(record.bookId);
    if (!meta) return false;
    if (meta.isStandalone) return false;
    return meta.author === author && meta.series === series;
  });
}

/* Convenience: resolve (author, series) for a given bookId and return
   its series-mates' characters in one call. Used at the analyzer route
   entry where we have the source book's bookId but not its
   (author, series) yet. Returns [] when the bookId isn't in the
   library or its book is a standalone. */
export async function scanSeriesCharactersForBookId(
  bookId: string,
): Promise<LibraryCharacterRecord[]> {
  const resolved = await findAuthorSeriesForBookId(bookId);
  if (!resolved) return [];
  return scanSeriesCharacters(resolved.author, resolved.series, { excludeBookId: bookId });
}
