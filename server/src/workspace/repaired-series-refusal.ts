/* #3713 / PR #4004 -- the series-level half of the repaired-book gate (see repaired-book-gate.ts).

   A fan-out that matches series-mates by voice id or name never names them, so the path/body gate cannot
   see a repaired one. This answers the 409 `book_repaired_reload` BEFORE the fan-out writes anything (or
   a design job starts) when a gated book is in the series and the request lacks the current repair epoch.
   `series` undefined is a workspace-wide walk: any gated book is in scope. It is deliberately series-level,
   not per-match: a stale page reloads once and the repeat carries the epoch. */

import type { Request, Response } from 'express';
import { gatedBookIds, refuseUnreadRepairedBooks } from './repaired-book-gate.js';
import { findAuthorSeriesForBookId } from './series-cast-scan.js';

export async function refuseGatedSeriesFanOut(
  series: { author: string; series: string } | undefined,
  req: Request,
  res: Response,
): Promise<boolean> {
  const gated = gatedBookIds();
  if (gated.length === 0) return false;
  let inScope: string | undefined;
  for (const id of gated) {
    if (!series) {
      inScope = id;
      break;
    }
    try {
      const s = await findAuthorSeriesForBookId(id);
      if (s && s.author === series.author && s.series === series.series) {
        inScope = id;
        break;
      }
    } catch {
      /* Unreadable: fail closed, treat it as in scope. */
      inScope = id;
      break;
    }
  }
  return refuseUnreadRepairedBooks(inScope === undefined ? [] : [inScope], req, res);
}
