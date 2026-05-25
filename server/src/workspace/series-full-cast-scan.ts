/* Full-fidelity series cast scan (plan 108 follow-up — the rebaseline
   modal's "aggregate the WHOLE series, not just one book" enhancement).

   Distinct from `series-cast-scan.ts`, which projects every confirmed
   character down to the thin `LibraryCastCharacter` shape (id / name /
   role / voiceId / aliases / attributes / gender / ageRange) for the
   analyzer prompt + the continuity-link picker. The rebaseline modal
   needs the SAME fields `getBookState` returns for the open book —
   `lines` (principal-cast selection), `voiceStyle` (persona reuse),
   `overrideTtsVoices` + `ttsEngine` (skip-already-approved), `voiceId`
   (the series-override write key), `color`/`attributes` (avatar + hint).
   So this scan passes each cast.json character through VERBATIM rather
   than narrowing it; the cast.json on disk is the contract, not us.

   Single-series scoped exactly like `scanSeriesCharacters`: confirmed
   casts only, standalones excluded (a standalone's cast isn't series
   continuity), and a different series under the same author is excluded.
   The target book is excluded by `scanSeriesFullCharactersForBookId` so
   the caller can merge these SIBLING characters onto the anchor book's
   own cast without double-counting it. */

import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { BOOKS_ROOT, castJsonPath, ensureWorkspace, stateJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import type { BookStateJson } from './scan.js';
import { findAuthorSeriesForBookId } from './series-cast-scan.js';

/* A cast.json character carried through with every field intact. Typed
   open (a record with a required id) because the fields the modal reads
   live in the OpenAPI `Character` schema on the frontend, not here —
   re-declaring them would just drift from cast.json. */
export type FullCastCharacter = Record<string, unknown> & { id: string };

export interface SeriesFullCastEntry {
  bookId: string;
  bookTitle: string;
  character: FullCastCharacter;
}

interface CastJson {
  characters?: FullCastCharacter[];
}

function listDirs(path: string): string[] {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch {
    return [];
  }
}

/* Walk the books/ tree and return every confirmed character whose owning
   book shares the supplied (author, series) pair — full cast.json fidelity.
   `excludeBookId` drops one book (typically the anchor the caller already
   holds). Standalones are skipped. */
export async function scanSeriesFullCharacters(
  author: string,
  series: string,
  opts: { excludeBookId?: string } = {},
): Promise<SeriesFullCastEntry[]> {
  ensureWorkspace();
  const out: SeriesFullCastEntry[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const bookDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const state = await readJson<BookStateJson>(stateJsonPath(bookDir));
        if (!state || !state.castConfirmed) continue;
        if (state.isStandalone === true) continue;
        if (state.author !== author || state.series !== series) continue;
        if (opts.excludeBookId && state.bookId === opts.excludeBookId) continue;
        const cast = await readJson<CastJson>(castJsonPath(bookDir));
        if (!cast?.characters?.length) continue;
        for (const c of cast.characters) {
          if (!c.id) continue;
          out.push({ bookId: state.bookId, bookTitle: state.title, character: c });
        }
      }
    }
  }
  return out;
}

/* Convenience: resolve (author, series) for a bookId and return its
   series-mates' full casts, excluding the book itself. Returns [] when
   the bookId isn't in the library or its book is a standalone (a
   standalone is in no series, so it has no series-mates to aggregate). */
export async function scanSeriesFullCharactersForBookId(
  bookId: string,
): Promise<SeriesFullCastEntry[]> {
  const resolved = await findAuthorSeriesForBookId(bookId);
  if (!resolved) return [];
  return scanSeriesFullCharacters(resolved.author, resolved.series, { excludeBookId: bookId });
}
