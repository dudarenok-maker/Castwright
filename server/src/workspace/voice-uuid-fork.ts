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

export async function shouldForkSharedVoiceUuid(
  bookDir: string,
  character: { id: string; voiceUuid?: string | null; matchedFrom?: unknown },
): Promise<boolean> {
  const uuid = character.voiceUuid;
  if (!uuid) return false;
  if (character.matchedFrom) return false;

  const selfDir = resolve(bookDir);
  const selfState = await readStateJsonWithRecovery(stateJsonPath(bookDir));
  const selfBookId: string | undefined = selfState?.bookId || undefined;

  /* Does Y's characterId name X? Resolved through X's own book (live cast +
     id history) so a retired id still matches; no second id matcher. */
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

  let hasHolder = false;
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const otherDir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        if (resolve(otherDir) === selfDir) continue;
        const cast = await readJson<CastFile>(castJsonPath(otherDir));
        if (!cast?.characters?.length) continue;
        for (const y of cast.characters) {
          if (y.voiceUuid !== uuid) continue;
          hasHolder = true;
          const mf = y.matchedFrom as { bookId?: string; characterId?: string } | null | undefined;
          if (!mf) continue;
          if (!mf.bookId) return false; // bookId-less link: could point at anyone
          if (selfBookId && mf.bookId === selfBookId) {
            if (!mf.characterId || (await namesSelf(mf.characterId))) return false;
          }
        }
      }
    }
  }
  return hasHolder;
}
