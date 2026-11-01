/* #3992 — read-only decision helper: must a character's shared `voiceUuid`
   fork before it is redesigned?

   The series linker hands a linked character the source book's `voiceUuid` on
   purpose (series-reuse-link.ts), so both books share one `qwen-<uuid>.pt`.
   When the user declines that link, redux clears `matchedFrom` but the uuid
   survives on disk. A redesign would then overwrite the earlier book's file.
   The decline is recorded server-side as `declinedVoiceFrom`, so the decision is
   made from disk state:

   A character X (book B, id cX, uuid U) forks when ALL hold:
   1. X has a uuid, NO `matchedFrom` at all (a bookId-less one, as written
      by a manual Assign, still counts as an active link) AND a non-empty
      `declinedVoiceFrom` (the durable "Don't reuse" marker, #3992). A row
      declined before the marker shipped has none and never forks (it behaves as
      it did before #3992); a row nobody declined never forks.
   2. At least one character in ANOTHER book has `voiceUuid === U` and is NOT a
      follower of X (below). That is the earlier book whose bytes must be kept.

   A FOLLOWER of X is a row, in another book, holding U whose `matchedFrom` names
   B's bookId with a characterId that is absent or resolves to X (through B's live
   cast and id history), or that names an already-found follower the same way, so
   a chain Book Three -> Book Two -> X is found end to end. A bookId-less
   `matchedFrom` could point at anyone, so it is NOT a follower: it stays on U (and
   so counts as a holder), and neither is a row in a book with no bookId (it cannot
   be locked by id). Followers move to the new uuid together with X, in one
   locked write (qwen-voice.ts forkSharedVoiceUuid); everything else holding U is
   the earlier book and stays. A visited set makes a link cycle terminate.

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

/* The ONE read of a book's state.json in this module (the state-json lock guard
   pins its stateJsonPath( count per file). Throws like any state read; the scan of
   OTHER books catches it, the book being designed does not. Also exported for the
   fork write, which needs the designed book's id to take its book-op. */
export async function readBookId(dir: string): Promise<string | undefined> {
  return (await readStateJsonWithRecovery(stateJsonPath(dir)))?.bookId || undefined;
}

interface OtherBook {
  dir: string;
  bookId?: string;
  rows: CastRow[];
}

/* Every OTHER book's readable cast, with its bookId. An unreadable cast.json is
   skipped (see readOtherBookCast), so it holds nothing and follows nothing. */
async function loadOtherBooks(selfDir: string): Promise<OtherBook[]> {
  const out: OtherBook[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        if (resolve(dir) === selfDir) continue;
        const cast = await readOtherBookCast<CastFile>(dir);
        if (cast === UNREADABLE || !cast?.characters?.length) continue;
        let bookId: string | undefined;
        try {
          bookId = await readBookId(dir);
        } catch {
          bookId = undefined;
        }
        out.push({ dir, bookId, rows: cast.characters });
      }
    }
  }
  return out;
}

export interface LinkFollower {
  dir: string;
  bookId: string;
  characterId: string;
}

const rowKey = (dir: string, id: string): string => `${resolve(dir)}|${id}`;

/* Breadth-first walk from X over `matchedFrom` links, among rows holding `uuid`.
   A row already visited (X itself, one reached by another path, or one that names
   its own book) is never revisited, so a cycle ends. */
async function walkFollowers(
  selfDir: string,
  character: { id: string },
  uuid: string,
  others: OtherBook[],
): Promise<LinkFollower[]> {
  const selfBookId = await readBookId(selfDir);
  const followers: LinkFollower[] = [];
  const visited = new Set<string>([rowKey(selfDir, character.id)]);
  interface Node {
    dir: string;
    bookId: string | undefined;
    characterId: string;
    rows?: CastRow[];
  }
  const queue: Node[] = [
    { dir: selfDir, bookId: selfBookId, characterId: character.id },
  ];
  while (queue.length) {
    const node = queue.shift()!;
    if (!node.bookId) continue; // a book with no id cannot be named by a link
    let resolver: ReturnType<typeof buildCastResolver<CastRow>> | undefined;
    const namesNode = async (characterId: string): Promise<boolean> => {
      if (characterId === node.characterId) return true;
      if (!resolver) {
        const rows = node.rows ?? (await readJson<CastFile>(castJsonPath(node.dir)))?.characters ?? [];
        resolver = buildCastResolver<CastRow>(rows, await loadCastIdHistory(node.dir));
      }
      return resolver.resolve(characterId)?.character.id === node.characterId;
    };
    for (const book of others) {
      /* A book with no bookId cannot be locked by id (no route can move it either),
         so it cannot be moved with X: it stays on U. */
      if (!book.bookId) continue;
      for (const y of book.rows) {
        if (y.voiceUuid !== uuid) continue;
        const key = rowKey(book.dir, y.id);
        if (visited.has(key)) continue;
        const mf = y.matchedFrom as MatchedFrom;
        if (!mf?.bookId || mf.bookId !== node.bookId) continue;
        if (mf.characterId && !(await namesNode(mf.characterId))) continue;
        visited.add(key);
        followers.push({ dir: book.dir, bookId: book.bookId, characterId: y.id });
        queue.push({ dir: book.dir, bookId: book.bookId, characterId: y.id, rows: book.rows });
      }
    }
  }
  return followers;
}

/* Every row in another book that follows X (see the header), transitively.
   Read-only and lock-free; qwen-voice.ts re-runs it inside the locks it takes. */
export async function findLinkFollowers(
  bookDir: string,
  character: { id: string },
  uuid: string,
): Promise<LinkFollower[]> {
  const selfDir = resolve(bookDir);
  return walkFollowers(selfDir, character, uuid, await loadOtherBooks(selfDir));
}

/* Residual risk of the skip, shared by the fork decisions below: an unreadable
   book is treated as holding nothing. If it does in fact hold the uuid (or the
   legacy key), a redesign of the book being designed overwrites that book's
   `.pt` as it did before #3992. The alternative, treating it as a holder, would
   re-fork the row on every design for as long as the file stays unreadable. */
export async function shouldForkSharedVoiceUuid(
  bookDir: string,
  character: {
    id: string;
    voiceUuid?: string | null;
    matchedFrom?: unknown;
    declinedVoiceFrom?: string[] | null;
  },
): Promise<boolean> {
  const uuid = character.voiceUuid;
  if (!uuid) return false;
  if (character.matchedFrom) return false;
  /* Only a row the user DECLINED forks. `declinedVoiceFrom` is the durable
     record; "no matchedFrom" alone is also what a never-linked row looks like
     (a book confirmed before the earlier one, a null seriesPosition), and a
     series-minted shared uuid on such a row is intentional. */
  if (!character.declinedVoiceFrom?.length) return false;

  const selfDir = resolve(bookDir);
  const others = await loadOtherBooks(selfDir);
  const followed = new Set(
    (await walkFollowers(selfDir, character, uuid, others)).map((f) => rowKey(f.dir, f.characterId)),
  );
  return others.some((b) =>
    b.rows.some((y) => y.voiceUuid === uuid && !followed.has(rowKey(b.dir, y.id))),
  );
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
  if (!character.declinedVoiceFrom?.length) return false; // not declined: shares by design
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
  declinedVoiceFrom?: string[] | null;
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
  const selfBookId = await readBookId(bookDir);
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
