/* POST /api/books/:bookId/cast/create

   Mint a brand-new cast member and append it to the book's cast.json.
   Unlike cast-add-from-roster (which copies an existing character from a
   prior series-mate), this route creates a character from scratch using
   only the supplied name / gender / ageRange / role fields.

   Request body: { name: string, gender?, ageRange?, role? }
   Response:     { character: <full new record> }

   The new character gets:
   - id: minted via safeId (server/src/util/safe-id.ts) — the same
     Unicode-preserving-kebab minter every other id-minting path uses
     (#2040 RC2), disambiguated against the existing cast ids.
   - voiceState: 'generated'
   - color: 'unset'
   - no matchedFrom (this is a net-new entry, not a reuse)

   409 when the book has no cast.json yet (cast not confirmed). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import { safeId } from '../util/safe-id.js';
import { loadCastIdHistory } from '../store/cast-id-history.js';

export const castCreateRouter = Router();

type PersistedCharacter = CharacterOutput & {
  voiceState?: 'generated' | 'tuned' | 'reused' | 'locked';
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
};

interface CastFile {
  characters: PersistedCharacter[];
}

castCreateRouter.post('/:bookId/cast/create', async (req: Request, res: Response) => {
  const bookId = req.params.bookId;
  const body = (req.body ?? {}) as {
    name?: unknown;
    gender?: unknown;
    ageRange?: unknown;
    role?: unknown;
  };

  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'name is required.' });

  const located = await findBookByBookId(bookId);
  if (!located) return res.status(404).json({ error: `Book "${bookId}" not found.` });

  const cast = await readJson<CastFile>(castJsonPath(located.bookDir));
  if (!cast?.characters) {
    return res.status(409).json({ error: 'Book has no cast.json yet. Confirm cast before adding.' });
  }

  const existingIds = new Set(cast.characters.map((c) => c.id));

  /* srv-86 (#2040 follow-up) — an id retired by a merge (cast-id-history.json's
     `supersededBy`) is still actively protecting every segment the retired
     character rendered: resolution is exact-id-first (spec §4.3), so a LIVE
     row minted with that exact id always wins over the history redirect,
     silently, with no tie and no warning. This route mints ids from
     user-supplied names, so a merge followed by an ordinary re-create (the
     issue's repro: merge "anton" into "антон", then create a new "Anton")
     would otherwise re-mint the retired id for a brand-new, unrelated
     character and hijack the original's recorded audio.
     Unlike the analyzer paths (`dropSupersededIdsReclaimedByLiveCast`),
     which don't control the mint — the LLM produces the id, and a fresh
     roster has legitimately reclaimed it — THIS route does control the
     mint, and already has a collision-suffix path (below) for live-id
     collisions. So the fix here is to never mint a history-protected id in
     the first place, rather than drop the history entry that is actively
     guarding real rendered segments to hand the id to an empty new
     character. Treat history keys as additional "taken" ids for exactly
     that reason. */
  const history = await loadCastIdHistory(located.bookDir);
  const historyKeys = new Set(Object.keys(history.supersededBy));
  const takenIds = new Set([...existingIds, ...historyKeys]);

  // safeId's own collision suffix is a hash of the NAME, checked once — a
  // second character sharing a name gets a distinct id, but a third
  // collides with the second (same name -> same hash, and safeId never
  // re-checks its own output). Guarantee uniqueness here regardless of how
  // many characters share a name (or how many retired ids share a name).
  let newId = safeId(name, { taken: takenIds });
  if (takenIds.has(newId)) {
    let n = 2;
    while (takenIds.has(`${newId}-${n}`)) n += 1;
    newId = `${newId}-${n}`;
  }

  /* Report, not silent (issue acceptance) — mirrors the operator-visible
     log line Wave 2 added around `dropSupersededIdsReclaimedByLiveCast`,
     though nothing is dropped here: the history entry survives untouched
     and keeps protecting the retired id's segments. Only the id this NEW
     character receives differs from what an unprotected mint would have
     picked. Computed against `existingIds` alone (not `takenIds`) so this
     reports exactly the case the bug describes: the id a pre-fix mint would
     have produced collided with a history entry. */
  const unprotectedId = safeId(name, { taken: existingIds });
  if (historyKeys.has(unprotectedId) && unprotectedId !== newId) {
    console.log(
      `[cast-create] ${bookId} avoided re-minting "${unprotectedId}" — cast-id-history ` +
        `still redirects it to "${history.supersededBy[unprotectedId]}"; minted "${newId}" instead.`,
    );
  }

  const newCharacter: PersistedCharacter = {
    id: newId,
    name,
    role: typeof body.role === 'string' && body.role.trim() ? body.role.trim() : 'character',
    color: 'unset',
    gender:
      body.gender === 'male' || body.gender === 'female' || body.gender === 'neutral'
        ? body.gender
        : undefined,
    ageRange: ['child', 'teen', 'adult', 'elderly'].includes(body.ageRange as string)
      ? (body.ageRange as PersistedCharacter['ageRange'])
      : undefined,
    voiceState: 'generated',
  };

  await writeJsonAtomic(castJsonPath(located.bookDir), {
    characters: [...cast.characters, newCharacter],
  });

  console.log(`[cast-create] ${bookId} + "${newId}"`);
  return res.json({ character: newCharacter });
});
