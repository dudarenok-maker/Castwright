/* #3992 — read-only decision helper: must a character's shared `voiceUuid`
   fork before it is redesigned?

   The series linker hands a linked character the source book's `voiceUuid` on
   purpose (series-reuse-link.ts), so both books share one `qwen-<uuid>.pt`.
   When the user declines that link, redux clears `matchedFrom` but the uuid
   survives on disk. A redesign would then overwrite the earlier book's file.
   The server cannot see the click, so the decision is made from disk state:

   A character X (book B, id cX, uuid U) forks when ALL hold:
   1. X has a uuid and NO `matchedFrom` at all (a bookId-less one, as written
      by a manual Assign, still counts as an active link).
   2. At least one character in ANOTHER book has `voiceUuid === U` (a holder).
   3. No other-book holder Y links to X: Y has no `matchedFrom` that is
      bookId-less, or that names B's bookId with a characterId absent or
      resolving to X. This protects the SOURCE side of a live pair.

   Writes nothing and takes no lock. */

import { join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { BOOKS_ROOT, castJsonPath, stateJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import { readStateJsonWithRecovery } from './state-migrate.js';
import { loadCastIdHistory } from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';

interface CastRow {
  id: string;
  voiceUuid?: string | null;
  matchedFrom?: unknown;
}

interface CastFile {
  characters?: CastRow[];
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

const UNREADABLE = Symbol('unreadable');

/* Read ANOTHER book's cast.json for a scan. A parse error or a non-ENOENT read
   error (a truncated file, a transient EBUSY) on a book that is not the one being
   designed must not fail the request, so it is reported as UNREADABLE and the
   caller decides what that means. Never use this for the book being designed:
   its read failing is a real failure and must keep throwing. */
async function readOtherBookCast<T>(dir: string): Promise<T | null | typeof UNREADABLE> {
  try {
    return await readJson<T>(castJsonPath(dir));
  } catch (e) {
    console.warn(`[voice-uuid-fork] skipping unreadable cast.json in ${dir}: ${(e as Error).message}`);
    return UNREADABLE;
  }
}

/* Residual risk of the skip, shared by both fork decisions below: an unreadable
   book is treated as holding nothing. If it does in fact hold the uuid (or the
   legacy key), a redesign of the book being designed overwrites that book's
   `.pt` as it did before #3992. The alternative, treating it as a holder, would
   re-fork the row on every design for as long as the file stays unreadable. */
export async function shouldForkSharedVoiceUuid(
  bookDir: string,
  character: { id: string; voiceUuid?: string | null; matchedFrom?: unknown },
): Promise<boolean> {
  const uuid = character.voiceUuid;
  if (!uuid) return false;
  if (character.matchedFrom) return false;

  const selfDir = resolve(bookDir);
  const linksToSelf = await makeLinksToSelf(bookDir, character);

  let hasHolder = false;
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const otherDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        if (resolve(otherDir) === selfDir) continue;
        const cast = await readOtherBookCast<CastFile>(otherDir);
        if (cast === UNREADABLE || !cast?.characters?.length) continue;
        for (const y of cast.characters) {
          if (y.voiceUuid !== uuid) continue;
          hasHolder = true;
          if (await linksToSelf(y.matchedFrom as MatchedFrom)) return false;
        }
      }
    }
  }
  return hasHolder;
}

/* #3992 — read-only: the no-uuid sibling of shouldForkSharedVoiceUuid. A row
   with NO uuid and no `matchedFrom` that already carries a designed qwen slot
   (the linker denormalised the earlier book's `qwen-<voiceId>` onto it) shares
   that legacy key with the earlier book. The series mint would stamp the earlier
   book too and move ITS render key onto the redesign, so the row must mint a uuid
   of its own instead. True only when ANOTHER book's row has the same
   `voiceId ?? id`, no uuid and a designed qwen slot of its own, and does not
   link back to X. A row whose own slot is empty (nobody designed yet) never
   trips it. */
export async function shouldMintApartFromLegacyKey(
  bookDir: string,
  character: LegacyRow,
): Promise<boolean> {
  if (character.voiceUuid || character.matchedFrom) return false;
  if (!character.overrideTtsVoices?.qwen?.name) return false;
  const linkId = character.voiceId ?? character.id;

  const selfDir = resolve(bookDir);
  const linksToSelf = await makeLinksToSelf(bookDir, character);

  let hasHolder = false;
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const otherDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        if (resolve(otherDir) === selfDir) continue;
        const cast = await readOtherBookCast<{ characters?: LegacyRow[] }>(otherDir);
        if (cast === UNREADABLE) continue;
        for (const y of cast?.characters ?? []) {
          if (y.voiceUuid || (y.voiceId ?? y.id) !== linkId) continue;
          if (!y.overrideTtsVoices?.qwen?.name) continue;
          hasHolder = true;
          if (await linksToSelf(y.matchedFrom as MatchedFrom)) return false;
        }
      }
    }
  }
  return hasHolder;
}

interface LegacyRow {
  id: string;
  voiceId?: string | null;
  voiceUuid?: string | null;
  matchedFrom?: unknown;
  overrideTtsVoices?: { qwen?: { name?: string } } | null;
}

type MatchedFrom = { bookId?: string; characterId?: string } | null | undefined;

/* Does another book's `matchedFrom` link back to X (the character in
   `bookDir`)? A bookId-less one could point at anyone, so it counts; one naming
   X's bookId counts when its characterId is absent or resolves to X. Resolved
   through X's own book (live cast + id history) so a retired id still matches;
   no second id matcher. */
async function makeLinksToSelf(
  bookDir: string,
  character: { id: string },
): Promise<(mf: MatchedFrom) => Promise<boolean>> {
  const selfState = await readStateJsonWithRecovery(stateJsonPath(bookDir));
  const selfBookId: string | undefined = selfState?.bookId || undefined;
  let resolver: ReturnType<typeof buildCastResolver<CastRow>> | undefined;
  const namesSelf = async (characterId: string): Promise<boolean> => {
    if (characterId === character.id) return true;
    if (!resolver) {
      const cast = await readJson<CastFile>(castJsonPath(bookDir));
      const history = await loadCastIdHistory(bookDir);
      resolver = buildCastResolver<CastRow>(cast?.characters ?? [], history);
    }
    return resolver.resolve(characterId)?.character.id === character.id;
  };
  return async (mf) => {
    if (!mf) return false;
    if (!mf.bookId) return true;
    if (selfBookId && mf.bookId === selfBookId) {
      return !mf.characterId || (await namesSelf(mf.characterId));
    }
    return false;
  };
}

/* #3992 — read-only: does some OTHER character, under a DIFFERENT base
   `voiceUuid` than `ownUuid`, still name `variantId` among its
   `overrideTtsVoices.qwen.variants[*].name`? After a fork the declined row keeps
   the shared variant names, so tearing one down would delete the earlier book's
   `.pt`. A still-linked pair shares the base uuid, so it does NOT count (their
   shared variants go stale together and are deleted as before). Scans every
   book under BOOKS_ROOT, takes no lock, writes nothing. */
export async function isVariantUsedByOtherVoiceUuid(
  variantId: string,
  ownUuid: string | null | undefined,
): Promise<boolean> {
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const cast = await readOtherBookCast<VariantCastFile>(dir);
        /* The other way round from the fork scans: this one gates a DELETE, so a
           book it cannot read counts as a possible holder and the file is kept
           (an orphan at worst, never a deleted take). */
        if (cast === UNREADABLE) return true;
        for (const y of cast?.characters ?? []) {
          if (!y.voiceUuid || y.voiceUuid === ownUuid) continue;
          const variants = y.overrideTtsVoices?.qwen?.variants;
          if (!variants) continue;
          for (const v of Object.values(variants)) {
            if (v?.name === variantId) return true;
          }
        }
      }
    }
  }
  return false;
}

interface VariantCastFile {
  characters?: Array<{
    voiceUuid?: string | null;
    overrideTtsVoices?: { qwen?: { variants?: Record<string, { name?: string } | undefined> } };
  }>;
}
