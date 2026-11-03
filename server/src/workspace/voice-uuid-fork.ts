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
   B's bookId with a characterId that resolves to X (through B's live cast and id
   history), or that names an already-found follower the same way, so a chain Book
   Three -> Book Two -> X is found end to end. A `matchedFrom` with a bookId but no
   characterId names the row with the SAME id as the follower in that book, here
   and in the walk up (findDeclinedAncestor). A bookId-less
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
import { declinesVoice } from '../store/declined-voice.js';

interface CastRow {
  id: string;
  voiceId?: string | null;
  voiceUuid?: string | null;
  overrideTtsVoices?: { qwen?: { name?: string } } | null;
  matchedFrom?: unknown;
  declinedVoiceFrom?: string[] | null;
  declinedVoiceUuids?: string[] | null;
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

/* A failure whose message is a fixed, path-free sentence telling the user a retry
   can work (a book was unreadable or changed under a fork). The design route
   answers its message instead of the generic "Voice design failed.". */
export class RetryableForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableForkError';
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

interface OtherBooks {
  books: OtherBook[];
  /** Some other book's cast.json could not be read, so what it holds is unknown. */
  unreadable: boolean;
  /** Those books' folders. */
  unreadableDirs: string[];
}

/* Every OTHER book's readable cast, with its bookId. An unreadable cast.json is
   not in `books` (it can be neither a follower nor named by a link we can see),
   and is reported in `unreadable` so each caller decides what not knowing means:
   the fork decisions read it as a possible HOLDER (see shouldForkSharedVoiceUuid). */
async function loadOtherBooks(selfDir: string): Promise<OtherBooks> {
  const out: OtherBook[] = [];
  const unreadableDirs: string[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        if (resolve(dir) === selfDir) continue;
        const cast = await readOtherBookCast<CastFile>(dir);
        if (cast === UNREADABLE) {
          unreadableDirs.push(resolve(dir));
          continue;
        }
        if (!cast?.characters?.length) continue;
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
  return { books: out, unreadable: unreadableDirs.length > 0, unreadableDirs };
}

export interface LinkFollower {
  dir: string;
  bookId: string;
  characterId: string;
}

const rowKey = (dir: string, id: string): string => `${resolve(dir)}|${id}`;

/* What "holds the shared voice" means for a walk: a row on the uuid, or (for a row
   that never got a uuid) a row on the same legacy key `qwen-<voiceId ?? id>`. */
export type VoiceHolds = (row: CastRow) => boolean;
const holdsUuid = (uuid: string): VoiceHolds => (y) => y.voiceUuid === uuid;
export const holdsLegacyKey =
  (linkId: string): VoiceHolds =>
  (y) =>
    !y.voiceUuid && (y.voiceId ?? y.id) === linkId;

/* Breadth-first walk from X over `matchedFrom` links, among rows holding `uuid`.
   A row already visited (X itself, one reached by another path, or one that names
   its own book) is never revisited, so a cycle ends. */
async function walkFollowers(
  selfDir: string,
  character: { id: string },
  holds: VoiceHolds,
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
        if (!holds(y)) continue;
        const key = rowKey(book.dir, y.id);
        if (visited.has(key)) continue;
        const mf = y.matchedFrom as MatchedFrom;
        if (!mf?.bookId || mf.bookId !== node.bookId) continue;
        /* A link with a bookId but no characterId names the row with the SAME id in
           that book (series books share character ids): the walk up reads it the
           same way (findDeclinedAncestor). */
        if (!(await namesNode(mf.characterId ?? y.id))) continue;
        visited.add(key);
        followers.push({ dir: book.dir, bookId: book.bookId, characterId: y.id });
        queue.push({ dir: book.dir, bookId: book.bookId, characterId: y.id, rows: book.rows });
      }
    }
  }
  return followers;
}

/* Every row in another book that follows X (see the header), transitively, and
   the folders of the books that could not be read (a follower there would be
   invisible). Read-only and lock-free; qwen-voice.ts re-runs it inside the locks
   it takes and fails the fork when a book it already locked as a follower has
   become unreadable. */
export async function scanLinkFollowers(
  bookDir: string,
  character: { id: string },
  voice: string | VoiceHolds,
): Promise<{ followers: LinkFollower[]; unreadableDirs: string[] }> {
  const selfDir = resolve(bookDir);
  const { books, unreadableDirs } = await loadOtherBooks(selfDir);
  const holds = typeof voice === 'string' ? holdsUuid(voice) : voice;
  return { followers: await walkFollowers(selfDir, character, holds, books), unreadableDirs };
}

export async function findLinkFollowers(
  bookDir: string,
  character: { id: string },
  voice: string | VoiceHolds,
): Promise<LinkFollower[]> {
  return (await scanLinkFollowers(bookDir, character, voice)).followers;
}

/* #3992 — read-only: the declined row a LINKED row's voice really belongs to.
   A row X with a `matchedFrom` never forks itself (the link says it shares by
   design), but its source may be a declined row that has not forked yet (Book
   Three linked to Book Two, which declined Book One's voice): designing X under
   the shared uuid would overwrite Book One. Walks X's link chain UP, among rows
   holding `uuid`, following each `matchedFrom` through the target book's live cast
   and id history, and returns the first row `shouldForkSharedVoiceUuid` says must
   fork, or null when the chain ends, leaves `uuid` or loops.

   A source that already forked is the other half: it holds a different uuid and
   lists X's uuid in its `declinedVoiceUuids`, so X is a follower the fork never
   reached (its book was unreadable, or the link landed after the fork). It is
   STRANDED on a voice its source left, and is returned as `{ voiceUuid }`, the
   uuid the source holds now, for the caller to move it onto (the follow rule).
   The walk keeps going up through a linked source on a third uuid, so a row left
   behind by an earlier move still finds the declined row above it. A walker with
   no uuid whose source holds one takes that uuid the same way.

   A link whose target cannot be told apart from an unreadable book THROWS: the
   unreadable book may be that target, and designing under the shared uuid would
   then overwrite the earlier book. A target that is simply absent (a deleted
   book, with every other book readable) ends the walk as it always did. Writes
   nothing and takes no lock. */
async function couldBeUnreadable(dirs: string[], bookId: string): Promise<boolean> {
  for (const dir of dirs) {
    try {
      if ((await readBookId(dir)) === bookId) return true;
    } catch {
      return true;
    }
  }
  return false;
}

/* `forkUuid` names the uuid the row at `dir` must fork off when it is NOT the
   uuid the asking row holds: a legacy walker (no uuid) whose source is a declined
   row still on the earlier book's uuid. Absent, the row holds the asking row's own
   voice (the uuid fork, or the legacy-key mint for a legacy source). */
export type DeclinedAncestor =
  | { dir: string; characterId: string; forkUuid?: string }
  | { voiceUuid: string }
  | null;

/* A source row that holds a uuid the asking row does not (a legacy walker's
   source; a source on a third uuid that declined the walker's): the asking row may
   take that uuid only once it BELONGS to the source. Decided in uuid mode first: a
   source that must fork off the uuid it shares (or has a row above it on that uuid
   that must) is returned to be forked, carrying its followers, and the asker then
   takes the uuid the source ends on. Otherwise the uuid is the source's own. */
async function resolveSourceUuid(dir: string, row: CastRow): Promise<DeclinedAncestor> {
  const uuid = row.voiceUuid as string;
  if (await shouldForkSharedVoiceUuid(dir, row as Parameters<typeof shouldForkSharedVoiceUuid>[1])) {
    return { dir, characterId: row.id, forkUuid: uuid };
  }
  if (row.matchedFrom) {
    const above = await findDeclinedAncestor(dir, row);
    if (above && 'dir' in above) return { ...above, forkUuid: uuid };
    if (above) return above;
  }
  return { voiceUuid: uuid };
}

export async function findDeclinedAncestor(
  bookDir: string,
  character: {
    id: string;
    voiceId?: string | null;
    voiceUuid?: string | null;
    matchedFrom?: unknown;
  },
): Promise<DeclinedAncestor> {
  /* A row with no uuid shares the earlier book's LEGACY key instead, and the same
     walk applies with the legacy reading of "holds" and of "must mint apart". */
  const uuid = character.voiceUuid;
  const holds = uuid ? holdsUuid(uuid) : holdsLegacyKey(character.voiceId ?? character.id);
  const { books, unreadable, unreadableDirs } = await loadOtherBooks(resolve(bookDir));
  const visited = new Set<string>([rowKey(bookDir, character.id)]);
  let mf = character.matchedFrom as MatchedFrom;
  let walkerId = character.id;
  while (mf?.bookId) {
    const target = books.find((b) => b.bookId === mf?.bookId);
    if (!target) {
      /* Only an unreadable book that could BE the target refuses: one whose
         state.json names another bookId (or has none) cannot be it. A state.json
         that cannot be read either leaves the book unidentified, so it might be. */
      if (unreadable && (await couldBeUnreadable(unreadableDirs, mf.bookId))) {
        throw new RetryableForkError('A book in this series could not be read; try again once it can.');
      }
      return null;
    }
    const rows = target.rows;
    const resolver = buildCastResolver<CastRow>(rows, await loadCastIdHistory(target.dir));
    const row: CastRow | undefined = resolver.resolve(mf.characterId ?? walkerId)?.character;
    if (!row) return null;
    if (!holds(row)) {
      if (!row.voiceUuid) return null;
      /* A legacy walker (no uuid) whose source holds one takes it: the source left
         the shared legacy key, and the link says this row shares with the source. */
      if (!uuid) return resolveSourceUuid(target.dir, row);
      /* The source that declined the voice, already forked off it (unless it is
         itself still sharing the uuid it forked to). */
      if (declinesVoice(row, { voiceUuid: uuid })) return resolveSourceUuid(target.dir, row);
      /* A linked source on yet another uuid (an earlier move carried it off U): the
         declined row may be further up, so keep walking. Moving a row also carries
         its followers (qwen-voice.ts moveStrandedFollower), but a row left behind
         must not depend on that having happened. */
      const key = rowKey(target.dir, row.id);
      if (visited.has(key) || !(row.matchedFrom as MatchedFrom)?.bookId) return null;
      visited.add(key);
      mf = row.matchedFrom as MatchedFrom;
      walkerId = row.id;
      continue;
    }
    const key = rowKey(target.dir, row.id);
    if (visited.has(key)) return null;
    visited.add(key);
    const mustFork = uuid
      ? await shouldForkSharedVoiceUuid(target.dir, row as Parameters<typeof shouldForkSharedVoiceUuid>[1])
      : await shouldMintApartFromLegacyKey(target.dir, row as LegacyRow);
    if (mustFork) return { dir: target.dir, characterId: row.id };
    mf = row.matchedFrom as MatchedFrom;
    walkerId = row.id;
  }
  return null;
}

/* An unreadable other book is treated as a possible HOLDER of the uuid (and, in
   shouldMintApartFromLegacyKey, of the legacy key), but only by a row that could
   still be sharing it. The two outcomes are not symmetric: assuming it holds the
   voice for a row that DOES still share a declined voice costs one extra fork (a
   copy of the base family and a fresh uuid), while assuming it holds nothing lets
   the redesign overwrite that book's `.pt` with no way to get it back. So a row
   whose uuid is on its own `declinedVoiceUuids` (it still holds the voice it
   declined) forks. A row whose uuid is NOT on that list has already left the
   declined voice (a fork gives it a uuid no decline names): no unreadable book,
   anywhere in the library, can be the earlier book for it, and re-forking it on
   every design would drop its own variants and orphan its own files for as long as
   some unrelated cast.json stays unreadable. It is decided from the readable
   books alone. The other direction, a book that could be a FOLLOWER we cannot
   see, is NOT covered at write time: a follower the first scan found that became unreadable, or a link that
   landed after it, fails the fork (qwen-voice.ts), but one that was already
   unreadable at the first scan is simply not in the set, so the fork leaves it on
   U. It is caught later, when ITS design comes: findDeclinedAncestor walks up its
   chain to the source that holds a different uuid and lists U as declined, and
   moves the row onto it TOGETHER WITH the rows that follow it (qwen-voice.ts
   moveStrandedFollower), so the rows below it are not left on U in turn. A row
   left behind anyway still finds the declined row by walking up. */
export async function shouldForkSharedVoiceUuid(
  bookDir: string,
  character: {
    id: string;
    voiceUuid?: string | null;
    matchedFrom?: unknown;
    declinedVoiceFrom?: string[] | null;
    declinedVoiceUuids?: string[] | null;
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
  const { books, unreadable } = await loadOtherBooks(selfDir);
  if (unreadable && character.declinedVoiceUuids?.includes(uuid)) return true;
  const followed = new Set(
    (await walkFollowers(selfDir, character, holdsUuid(uuid), books)).map((f) => rowKey(f.dir, f.characterId)),
  );
  return books.some((b) =>
    b.rows.some((y) => y.voiceUuid === uuid && !followed.has(rowKey(b.dir, y.id))),
  );
}

/* #3992 — read-only: the no-uuid sibling of shouldForkSharedVoiceUuid. A row
   with NO uuid and no `matchedFrom` that already carries a designed qwen slot
   (the linker denormalised the earlier book's `qwen-<voiceId>` onto it) shares
   that legacy key with the earlier book. The series mint would stamp the earlier
   book too and move ITS render key onto the redesign, so the row must mint a uuid
   of its own instead. True only when ANOTHER book's row has the same
   `voiceId ?? id`, no uuid and a designed qwen slot of its own, and is not a
   FOLLOWER of X (links to it by bookId, transitively: same reading as the uuid
   fork, so a bookId-less link is a holder). A row whose own slot is empty (nobody
   designed yet) never trips it. */
export async function shouldMintApartFromLegacyKey(
  bookDir: string,
  character: LegacyRow,
): Promise<boolean> {
  if (character.voiceUuid || character.matchedFrom) return false;
  if (!character.declinedVoiceFrom?.length) return false; // not declined: shares by design
  if (!character.overrideTtsVoices?.qwen?.name) return false;

  const selfDir = resolve(bookDir);
  const holds = holdsLegacyKey(character.voiceId ?? character.id);
  const { books, unreadable } = await loadOtherBooks(selfDir);
  if (unreadable) return true; // unknown, so a possible holder (see shouldForkSharedVoiceUuid)
  /* The followers of X (rows linking to it, transitively) move with it, so they are
     not the earlier book. Any OTHER designed holder of the key is, and the earlier
     book's render key must not move. */
  const followed = new Set(
    (await walkFollowers(selfDir, character, holds, books)).map((f) => rowKey(f.dir, f.characterId)),
  );
  return books.some((b) =>
    b.rows.some(
      (y) => holds(y) && !!y.overrideTtsVoices?.qwen?.name && !followed.has(rowKey(b.dir, y.id)),
    ),
  );
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
