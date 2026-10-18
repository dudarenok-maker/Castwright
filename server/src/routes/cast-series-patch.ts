/* POST /api/books/:bookId/cast/:characterId/series-patch

   Cross-book Compare save propagation (BACKLOG #7). When the user edits a
   cast member from inside the voice-library Compare modal, this route
   applies the patch to the source character AND to every series-sibling
   character that the plan-94 dedup rule recognises as the same person
   (case- + punctuation-insensitive name or alias match).

   Body shape — narrow on purpose, accepts only the fields the Compare
   modal exposes:

     { gender?: 'male'|'female'|'neutral',
       ageRange?: 'child'|'teen'|'adult'|'elderly',
       tone?: { warmth?, pace?, authority?, emotion? }   // 0-100 ints }

   Voice-override and audio-affecting fields are NOT accepted here — those
   are book-specific decisions and propagating them silently across the
   series would invalidate already-rendered audio in books the user isn't
   looking at. Unknown body keys return 400.

   Response shape:

     { updated: Array<{ bookId, bookTitle, characterId }>,
       failed:  Array<{ bookId, bookTitle, error }> }

   `updated` always contains the source book on success (even for a
   standalone — `failed` is empty in that case). HTTP 207 (Multi-Status)
   when `failed.length > 0`; 200 otherwise. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { z } from 'zod';
import { BOOK_GONE, withBookOp } from '../workspace/book-op-lock.js';
import { castJsonPath } from '../workspace/paths.js';
import { normaliseNameKey } from '../util/safe-id.js';
import { readJson, writeJsonAtomic } from '../workspace/state-io.js';
import { withCastLock } from '../workspace/cast-lock.js';
import { itemFailureReason } from '../workspace/file-lock.js';
import { scanSeriesCharactersForBookId } from '../workspace/series-cast-scan.js';
import type { LibraryCastCharacter } from '../workspace/library-cast-scan.js';
import type { CharacterOutput } from '../handoff/schemas.js';

export const castSeriesPatchRouter = Router();

/* cast.json on disk carries voiceId — widen the schema-derived shape here
   so the round-trip read/write preserves the field. */
type PersistedCharacter = CharacterOutput & { voiceId?: string };
interface CastFile {
  characters: PersistedCharacter[];
}

const patchSchema = z
  .object({
    gender: z.enum(['male', 'female', 'neutral']).optional(),
    ageRange: z.enum(['child', 'teen', 'adult', 'elderly']).optional(),
    tone: z
      .object({
        warmth: z.number().int().min(0).max(100).optional(),
        pace: z.number().int().min(0).max(100).optional(),
        authority: z.number().int().min(0).max(100).optional(),
        emotion: z.number().int().min(0).max(100).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type SeriesPatch = z.infer<typeof patchSchema>;

interface UpdatedEntry {
  bookId: string;
  bookTitle: string;
  characterId: string;
}
interface FailedEntry {
  bookId: string;
  bookTitle: string;
  error: string;
}

castSeriesPatchRouter.post(
  '/:bookId/cast/:characterId/series-patch',
  async (req: Request, res: Response) => {
    const { bookId, characterId } = req.params;
    if (!bookId || !characterId) {
      return res.status(400).json({ error: 'bookId and characterId are required.' });
    }

    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid patch body — expected { gender?, ageRange?, tone? }.',
        details: parsed.error.flatten(),
      });
    }
    const patch = parsed.data;
    if (
      patch.gender === undefined &&
      patch.ageRange === undefined &&
      patch.tone === undefined
    ) {
      return res.status(400).json({ error: 'Patch body must include at least one field.' });
    }

    const updated: UpdatedEntry[] = [];
    const failed: FailedEntry[] = [];
    const patchOne = async (
      bookDir: string,
      t: { bookId: string; bookTitle: string; characterId: string },
    ): Promise<void> => {
      await applyPatchToCastFile(bookDir, t.characterId, patch);
      updated.push({ bookId: t.bookId, bookTitle: t.bookTitle, characterId: t.characterId });
    };

    /* #3711 -- one book-op per book, never nested: the source's span resolves it,
       reads its row, discovers the siblings and writes the source; each sibling
       is then resolved AND written inside its OWN step (never a resolve in the
       loop body), so a rename of any one book lands before or after its write,
       never between. */
    const sourceStep = await withBookOp(bookId, async (source) => {
      const sourceCast = await readJson<CastFile>(castJsonPath(source.bookDir));
      if (!sourceCast?.characters?.length) {
        return res
          .status(409)
          .json({ error: 'Source book has no cast on disk yet — run analysis before editing.' });
      }
      const sourceChar = sourceCast.characters.find((c) => c.id === characterId);
      if (!sourceChar) {
        return res
          .status(404)
          .json({ error: `Character "${characterId}" not found in book "${bookId}".` });
      }

      /* Collect every (book, character) row we'll write to. Always includes
         the source; for series books, anything whose name/alias collides
         with the source character's name/aliases under the plan-94 dedup
         rule. Standalones produce an empty siblings list — the source-only
         write still happens. */
      const siblingTargets: Array<{ bookId: string; bookTitle: string; characterId: string }> = [];
      const siblings = await scanSeriesCharactersForBookId(bookId);
      if (siblings.length > 0) {
        const sourceTokens = tokensFor(sourceChar);
        /* Group siblings by bookId so we make at most one read+write per
           book even if a book has multiple cast rows colliding with the
           source (unlikely but technically possible). */
        const byBook = new Map<string, { bookTitle: string; characters: LibraryCastCharacter[] }>();
        for (const rec of siblings) {
          const entry = byBook.get(rec.bookId) ?? {
            bookTitle: rec.bookTitle,
            characters: [],
          };
          entry.characters.push(rec.character);
          byBook.set(rec.bookId, entry);
        }
        for (const [otherBookId, { bookTitle, characters }] of byBook) {
          const matching = characters.find((c) => intersects(tokensFor(c), sourceTokens));
          if (!matching) continue;
          siblingTargets.push({ bookId: otherBookId, bookTitle, characterId: matching.id });
        }
      }

      try {
        await patchOne(source.bookDir, { bookId, bookTitle: source.state.title, characterId });
      } catch (err) {
        /* Same per-book `failed` shape as a sibling (see the loop below). */
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ bookId, bookTitle: source.state.title, error: itemFailureReason(err, message) });
      }
      return { siblingTargets, series: { author: source.state.author, series: source.state.series } };
    });
    if (sourceStep === BOOK_GONE) return res.status(404).json({ error: `Book "${bookId}" not found.` });
    if (!('siblingTargets' in sourceStep)) return sourceStep;

    for (const t of sourceStep.siblingTargets) {
      try {
        /* BOOK_GONE (deleted since the scan) is skipped, as before. */
        await withBookOp(t.bookId, async (sibling) => {
          /* Re-apply the scope on the FRESH state: a sibling renamed out of the
             series since the scan is skipped. */
          if (
            sibling.state.isStandalone === true ||
            sibling.state.author !== sourceStep.series.author ||
            sibling.state.series !== sourceStep.series.series
          ) {
            return;
          }
          await patchOne(sibling.bookDir, t);
        });
      } catch (err) {
        /* #2292 (owner decision) — `applyPatchToCastFile` runs inside that
           book's cast lock, so a `LockAcquisitionTimeoutError` is reachable by
           ordinary contention on ONE series-mate. It stays a per-book `failed`
           entry (207) rather than failing the propagation to the others, but
           the reason names contention instead of implying that book's cast is
           broken. */
        const message = err instanceof Error ? err.message : String(err);
        failed.push({ bookId: t.bookId, bookTitle: t.bookTitle, error: itemFailureReason(err, message) });
      }
    }

    console.log(
      `[cast-series-patch] source=${bookId}/${characterId} updated=${updated.length} failed=${failed.length}`,
    );

    if (failed.length > 0) {
      return res.status(207).json({ updated, failed });
    }
    return res.status(200).json({ updated, failed });
  },
);

/* Apply the patch (gender / ageRange / tone) to a single character row
   in a single book's cast.json. Throws when the file is unreadable, the
   character is missing, or the atomic write fails — caller turns that
   into a `failed` response entry. */
async function applyPatchToCastFile(
  bookDir: string,
  characterId: string,
  patch: SeriesPatch,
): Promise<void> {
  /* #1981 — the read is inside the lock; the 404-equivalent throws and the
     merged fields are all decisions derived from it. */
  return withCastLock(bookDir, async () => {
    const cast = await readJson<CastFile>(castJsonPath(bookDir));
    if (!cast?.characters?.length) {
      throw new Error('Cast on disk is empty');
    }
    const idx = cast.characters.findIndex((c) => c.id === characterId);
    if (idx < 0) {
      throw new Error(`Character "${characterId}" not present in this book's cast`);
    }
    const current = cast.characters[idx];
    const merged: PersistedCharacter = { ...current };
    if (patch.gender !== undefined) merged.gender = patch.gender;
    if (patch.ageRange !== undefined) merged.ageRange = patch.ageRange;
    if (patch.tone !== undefined) {
      /* Field-level merge — patch carries only the fields the user edited;
         unspecified tone axes preserve the existing value. */
      merged.tone = { ...(current.tone ?? {}), ...patch.tone };
    }
    const nextCharacters = cast.characters.map((c, i) => (i === idx ? merged : c));
    await writeJsonAtomic(castJsonPath(bookDir), { ...cast, characters: nextCharacters });
  });
}

/* Cross-book match rule shared with plan-94's series-prior dedup
   (server/src/workspace/series-prior-dedup.ts). Two records "match" if any of
   their tokens collide. Plan 219 moved the key to the Unicode-exact
   `normaliseNameKey` (was `[^a-z0-9]`, which erased Cyrillic). */
function normaliseToken(s: string | undefined): string {
  return normaliseNameKey(s);
}

function tokensFor(c: LibraryCastCharacter | CharacterOutput): Set<string> {
  const out = new Set<string>();
  const nameTok = normaliseToken(c.name);
  if (nameTok) out.add(nameTok);
  for (const a of c.aliases ?? []) {
    const t = normaliseToken(a);
    if (t) out.add(t);
  }
  return out;
}

function intersects(a: Set<string>, b: Set<string>): boolean {
  for (const t of a) {
    if (b.has(t)) return true;
  }
  return false;
}
