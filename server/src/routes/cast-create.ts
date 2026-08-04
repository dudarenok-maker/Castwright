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
import { normaliseIdKey } from '../util/character-id.js';

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
     that reason.

     Review round 1 (Critical) — the check must be NORMALISED, not raw. A
     mint is always a `normaliseIdKey` fixed point (`safeId`'s output, and
     both its own and this route's collision suffixes are already in
     normal form), but a history key — or a pre-RC2 live id — is whatever
     string was on disk, e.g. an underscore slug (`the_torment`) or LLM
     free text. A raw-only check leaves the gap open in exactly the
     dangerous direction: cast.json has `the_torment`, frozen segments
     carry `the-torment` (tier-4 normalised match); merging `the_torment`
     into some other character records `{the_torment: <target>}`;
     re-creating "The Torment" mints `the-torment` (safeId's normal form),
     which isn't a raw match for `the_torment` in either `existingIds` or
     `historyKeys` — so the raw-only check would have let it through, tier
     1 would then beat the tier-4 history redirect, and every segment
     carrying the drifted spelling would hijack onto the new, empty
     character. This is the exact `Unknown_Male`-vs-normalised defect
     shape `repair-cast-id-drift.mjs`'s guard was already fixed for
     (#2040 Wave 3 review) — carried over here.

     This also closes a pre-existing SIBLING bug with no history involved
     at all: a live `the_torment` with nothing retired, re-created as "The
     Torment", used to mint `the-torment` — tier 1 then beats tier 4 for
     the drifted-spelling segments AND collapses `byNormId` for both
     spellings to `undefined` (two live rows sharing a normalised key),
     killing tier 3 resolution for both. The normalised taken-check below
     covers this case too, since it also normalises `existingIds`, not
     only `historyKeys`. */
  const history = await loadCastIdHistory(located.bookDir);
  const historyKeys = new Set(Object.keys(history.supersededBy));
  const takenIds = new Set([...existingIds, ...historyKeys]);
  const takenNorm = new Set([...takenIds].map(normaliseIdKey));
  const isTaken = (id: string) => takenIds.has(id) || takenNorm.has(normaliseIdKey(id));

  // safeId's own collision suffix is a hash of the NAME, checked once — a
  // second character sharing a name gets a distinct id, but a third
  // collides with the second (same name -> same hash, and safeId never
  // re-checks its own output). Guarantee uniqueness here regardless of how
  // many characters share a name (or how many retired/live ids share a
  // normalised name).
  let newId = safeId(name, { taken: takenIds });
  if (isTaken(newId)) {
    let n = 2;
    while (isTaken(`${newId}-${n}`)) n += 1;
    newId = `${newId}-${n}`;
  }

  /* Report, not silent (issue acceptance) — mirrors the operator-visible
     log line Wave 2 added around `dropSupersededIdsReclaimedByLiveCast`,
     though nothing is dropped here: the history entry survives untouched
     and keeps protecting the retired id's segments. Only the id this NEW
     character receives differs from what an unprotected mint would have
     picked. Computed against `existingIds` alone (not `takenIds`) so this
     reports exactly the case the bug describes: the id a pre-fix mint
     would have produced collided with a history entry — matched by
     NORMALISED key (review round 1), so the report doesn't go silent in
     exactly the new case the fix above now catches. */
  const unprotectedId = safeId(name, { taken: existingIds });
  const unprotectedNorm = normaliseIdKey(unprotectedId);
  const collidingHistoryKey = [...historyKeys].find((k) => normaliseIdKey(k) === unprotectedNorm);
  if (collidingHistoryKey && unprotectedId !== newId) {
    console.log(
      `[cast-create] ${bookId} avoided re-minting "${unprotectedId}" (collides with ` +
        `history-protected "${collidingHistoryKey}") — cast-id-history still redirects it to ` +
        `"${history.supersededBy[collidingHistoryKey]}"; minted "${newId}" instead.`,
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
