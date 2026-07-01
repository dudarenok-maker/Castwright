/* POST /api/books/:bookId/cast/create

   Mint a brand-new cast member and append it to the book's cast.json.
   Unlike cast-add-from-roster (which copies an existing character from a
   prior series-mate), this route creates a character from scratch using
   only the supplied name / gender / ageRange / role fields.

   Request body: { name: string, gender?, ageRange?, role? }
   Response:     { character: <full new record> }

   The new character gets:
   - id: a slug derived from the name, suffixed with 6 random hex chars
     if the slug already exists in the cast.
   - voiceState: 'generated'
   - color: 'unset'
   - no matchedFrom (this is a net-new entry, not a reuse)

   409 when the book has no cast.json yet (cast not confirmed). */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { randomBytes } from 'node:crypto';
import { findBookByBookId } from '../workspace/scan.js';
import { castJsonPath } from '../workspace/paths.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castCreateRouter = Router();

type PersistedCharacter = CharacterOutput & {
  voiceState?: 'generated' | 'tuned' | 'reused' | 'locked';
  gender?: 'male' | 'female' | 'neutral';
  ageRange?: 'child' | 'teen' | 'adult' | 'elderly';
};

interface CastFile {
  characters: PersistedCharacter[];
}

function slugify(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|(?<!_)_+$/g, '') || 'character'
  );
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
  let newId = slugify(name);
  if (existingIds.has(newId)) {
    newId = `${newId}_${randomBytes(3).toString('hex')}`;
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
