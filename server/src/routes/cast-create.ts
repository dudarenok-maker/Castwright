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
  // safeId's own collision suffix is a hash of the NAME, checked once — a
  // second character sharing a name gets a distinct id, but a third
  // collides with the second (same name -> same hash, and safeId never
  // re-checks its own output). Guarantee uniqueness here regardless of how
  // many characters share a name.
  let newId = safeId(name, { taken: existingIds });
  if (existingIds.has(newId)) {
    let n = 2;
    while (existingIds.has(`${newId}-${n}`)) n += 1;
    newId = `${newId}-${n}`;
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
