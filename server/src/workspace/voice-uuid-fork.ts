/* #3992 — read-only helpers for "Don't reuse": who else holds a character's
   voice, and must the character be separated from it?

   The series linker hands a linked character the source book's `voiceUuid` on
   purpose (series-reuse-link.ts), so both books share one `qwen-<uuid>.pt`.
   When the user declines that link, a later redesign must not overwrite the
   earlier book's file. The decline route therefore establishes ONE invariant,
   at decline time, so a design never has to decide anything:

     After "Don't reuse" succeeds, the declining row is on its own voice that no
     other book's row holds, other than its FOLLOWERS, which move with it.

   The separation (qwen-voice.ts separateVoiceLocked) mints a fresh uuid, copies
   the base family of the shared voice to it, and stamps it onto the row and its
   followers, all under the decline's locks. A design then writes the row's own
   key, whatever it is.

   A row Y, in another book, links to Z when Y's `matchedFrom` names Z's bookId
   with a characterId that resolves to Z (through Z's book's live cast and id
   history); a `matchedFrom` with a bookId but no characterId names the row with
   the SAME id. X's FOLLOWERS are the whole chain that leads down to it (Three
   links to X, Four links to Three, ...) among rows that still hold X's voice: a
   row that left the voice, or links elsewhere, or sits in a book X declined, is
   not one, and neither is what links to it. One library scan builds the graph; a breadth-first walk with a
   visited set computes the set, so a cycle terminates.

   The one place a design still separates is a row declined BEFORE the decline
   route did this (its voice is still a declined one): mustSeparateOnDesign.

   Writes nothing and takes no lock. */

import { join, resolve } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { BOOKS_ROOT, castJsonPath, stateJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import { readStateJsonWithRecovery } from './state-migrate.js';
import { loadCastIdHistory } from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';

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
   can work (a book was unreadable or changed under a separation). Routes answer
   its message instead of their generic one. */
export class RetryableForkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RetryableForkError';
  }
}

const UNREADABLE = Symbol('unreadable');

/* Read ANOTHER book's cast.json for a scan. A parse error or a non-ENOENT read
   error (a truncated file, a transient EBUSY) on a book that is not the one being
   separated must not fail the request, so it is reported as UNREADABLE and the
   caller decides what that means. Never use this for the row's own book: its
   read failing is a real failure and must keep throwing. */
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
   OTHER books catches it, the row's own book does not. */
export async function readBookId(dir: string): Promise<string | undefined> {
  return (await readBookIdentity(dir)).bookId;
}
async function readBookIdentity(dir: string): Promise<{ bookId?: string; series?: { author: string; series: string } }> {
  const state = await readStateJsonWithRecovery(stateJsonPath(dir));
  const inSeries = state && state.isStandalone !== true && state.author && state.series;
  return {
    bookId: state?.bookId || undefined,
    series: inSeries ? { author: state.author as string, series: state.series as string } : undefined,
  };
}

interface OtherBook {
  dir: string;
  bookId?: string;
  /** The book's author and series (none: a standalone book). */
  series?: { author: string; series: string };
  rows: CastRow[];
}

/* Every OTHER book's readable cast, with its bookId: one bounded pass over the
   library. A book whose cast.json OR state.json cannot be read is not in `books`
   (without its bookId no link can be matched to it) and is reported in
   `unreadableDirs` so each caller decides what not knowing means. */
async function loadOtherBooks(selfDir: string): Promise<{ books: OtherBook[]; unreadableDirs: string[] }> {
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
        let identity: Awaited<ReturnType<typeof readBookIdentity>>;
        try {
          identity = await readBookIdentity(dir);
        } catch (e) {
          console.warn(`[voice-uuid-fork] skipping unreadable state.json in ${dir}: ${(e as Error).message}`);
          unreadableDirs.push(resolve(dir));
          continue;
        }
        out.push({ dir, bookId: identity.bookId, series: identity.series, rows: cast.characters });
      }
    }
  }
  return { books: out, unreadableDirs };
}

export interface LinkFollower {
  dir: string;
  bookId: string;
  characterId: string;
}

const rowKey = (dir: string, id: string): string => `${resolve(dir)}|${id}`;

/* What "holds the voice" means: a row on the uuid, or (for a row that never got a
   uuid) a row on the same legacy key `qwen-<voiceId ?? id>`. */
export type VoiceHolds = (row: CastRow) => boolean;
export const holdsUuid =
  (uuid: string): VoiceHolds =>
  (y) =>
    y.voiceUuid === uuid;
export const holdsLegacyKey =
  (linkId: string): VoiceHolds =>
  (y) =>
    !y.voiceUuid && (y.voiceId ?? y.id) === linkId;

/* The voice a row holds right now: its uuid, or its legacy key. */
export const voiceHeldBy = (row: CastRow): VoiceHolds =>
  row.voiceUuid ? holdsUuid(row.voiceUuid) : holdsLegacyKey(row.voiceId ?? row.id);

type MatchedFrom = { bookId?: string; characterId?: string } | null | undefined;

/* The rows in other books whose `matchedFrom` chain leads down to X (Three links
   to X, Four links to Three, ...), among rows holding the voice, in breadth-first
   order. The graph is the one library scan in `others`; a visited set makes a
   cycle terminate. A row off the voice is no node, so it cuts the chain: what
   links to it stays. Each hop resolves the link's characterId through the linked
   book's live cast and id history.
   P10-1 (owner decision: stop at the declined book): a row in a book X declined
   (`declined`: the decline's `fromBookId` plus X's `declinedVoiceFrom`) is never a
   follower, however a link cycle reaches it (Confirm's auto-match links an earlier
   book to a later one too). It cuts the chain there, and it holds the voice. */
async function chainFollowers(
  selfDir: string,
  character: { id: string },
  holds: VoiceHolds,
  others: OtherBook[],
  declined: ReadonlySet<string>,
): Promise<LinkFollower[]> {
  const selfBookId = await readBookId(selfDir);
  if (!selfBookId) return []; // a book with no id cannot be named by a link
  type Resolver = ReturnType<typeof buildCastResolver<CastRow>>;
  const resolvers = new Map<string, Resolver>();
  const resolverFor = async (dir: string, rows: () => Promise<CastRow[]>): Promise<Resolver> => {
    let r = resolvers.get(dir);
    if (!r) {
      r = buildCastResolver<CastRow>(await rows(), await loadCastIdHistory(dir));
      resolvers.set(dir, r);
    }
    return r;
  };
  interface Node {
    dir: string;
    bookId: string;
    id: string;
    rows: () => Promise<CastRow[]>;
  }
  const names = async (z: Node, characterId: string): Promise<boolean> =>
    characterId === z.id || (await resolverFor(z.dir, z.rows)).resolve(characterId)?.character.id === z.id;

  const selfRows = async () => (await readJson<CastFile>(castJsonPath(selfDir)))?.characters ?? [];
  const queue: Node[] = [{ dir: selfDir, bookId: selfBookId, id: character.id, rows: selfRows }];
  const visited = new Set([rowKey(selfDir, character.id)]);
  const followers: LinkFollower[] = [];
  for (let z = queue.shift(); z; z = queue.shift()) {
    for (const book of others) {
      /* A book with no bookId cannot be locked by id (no route can move it either),
         so it cannot be moved with X: it stays on the voice. */
      if (!book.bookId || declined.has(book.bookId)) continue;
      for (const y of book.rows) {
        if (!holds(y)) continue;
        const key = rowKey(book.dir, y.id);
        if (visited.has(key)) continue;
        const mf = y.matchedFrom as MatchedFrom;
        if (!mf?.bookId || mf.bookId !== z.bookId) continue;
        if (!(await names(z, mf.characterId ?? y.id))) continue;
        visited.add(key);
        followers.push({ dir: book.dir, bookId: book.bookId, characterId: y.id });
        const rows = book.rows;
        queue.push({ dir: book.dir, bookId: book.bookId, id: y.id, rows: async () => rows });
      }
    }
  }
  return followers;
}

export interface VoiceScan {
  /** Rows in other books whose link chain leads down to X and that hold its voice: they move with it. */
  followers: LinkFollower[];
  /** A row in another readable book that is NOT a follower holds X's voice. */
  heldElsewhere: boolean;
  /** Readable bookIds with a row on X's voice that is NOT a follower. */
  holderBookIds: Set<string>;
  /** Folders of the other books that could not be read (anything could be in them). */
  unreadableDirs: string[];
}

/* One bounded pass over the library: who else holds X's voice, split into X's
   followers (the whole chain) and everyone else. Read-only and lock-free; the separation
   re-runs it inside the locks it takes. `fromBookId` is the book a decline is
   declining (not yet on X's `declinedVoiceFrom`); it and X's declined books are
   never followers (chainFollowers). */
export async function scanVoiceHolders(
  bookDir: string,
  character: { id: string; declinedVoiceFrom?: string[] | null },
  holds: VoiceHolds,
  fromBookId?: string,
): Promise<VoiceScan> {
  const selfDir = resolve(bookDir);
  const { books, unreadableDirs } = await loadOtherBooks(selfDir);
  const declined = new Set([...(character.declinedVoiceFrom ?? []), ...(fromBookId ? [fromBookId] : [])]);
  const followers = await chainFollowers(selfDir, character, holds, books, declined);
  const followed = new Set(followers.map((f) => rowKey(f.dir, f.characterId)));
  const holderBookIds = new Set<string>();
  let heldElsewhere = false;
  for (const b of books) {
    for (const y of b.rows) {
      if (!holds(y) || followed.has(rowKey(b.dir, y.id))) continue;
      heldElsewhere = true;
      if (b.bookId) holderBookIds.add(b.bookId);
    }
  }
  return { followers, heldElsewhere, holderBookIds, unreadableDirs };
}

/* PR #4007 pass 11 (owner decision: share a first design) — the bookIds of the
   OTHER readable books with a row still on the never-designed legacy key
   `qwen-<linkId>`: the books a first design of that key may share its new voice
   with. Planning only; the landing (qwen-voice.ts) locks them and re-decides
   every row on a fresh read. PR #4007 pass 12, Y1 — given `seriesFilter`, only
   that series' books: the share writes no other book, so locking one (a narrator
   row is in every book) only widens the fan-out, and one of them gone by the lock
   would drop the whole share. */
export async function legacyKeyHolderBookIds(
  bookDir: string,
  linkId: string,
  seriesFilter?: { author: string; series: string },
): Promise<string[]> {
  const { books } = await loadOtherBooks(resolve(bookDir));
  const holds = holdsLegacyKey(linkId);
  const inScope = (b: OtherBook): boolean =>
    !seriesFilter || (b.series?.author === seriesFilter.author && b.series?.series === seriesFilter.series);
  return [...new Set(books.filter((b) => b.bookId && inScope(b) && b.rows.some(holds)).map((b) => b.bookId as string))];
}

interface MarkedRow {
  voiceUuid?: string | null;
  declinedVoiceFrom?: string[] | null;
  declinedVoiceUuids?: string[] | null;
}

/* The decline route's rule (the invariant in the header). A row with no uuid
   always gets one of its own: a series mint would otherwise stamp the earlier
   book on the same legacy key and move its render key onto this row's design.
   A row with a uuid separates when another book's row that is not a follower
   holds it, or when a book cannot be read: copying writes no other
   book's file, so separating on not knowing is safe.
   A REPEATED decline is a no-op: a row that already declined `fromBookId` and is
   not on a voice it declined was separated by the first one, so a double click or
   a stale tab never separates it again (which would drop its variants and leave
   the rows a later analysis linked to it behind). A row with no uuid is checked
   first: it cannot have been separated. */
export function mustSeparateOnDecline(row: MarkedRow, scan: VoiceScan, fromBookId: string): boolean {
  if (!row.voiceUuid) return true;
  const alreadySeparated =
    !!row.declinedVoiceFrom?.includes(fromBookId) && !row.declinedVoiceUuids?.includes(row.voiceUuid);
  if (alreadySeparated) return false;
  return scan.heldElsewhere || scan.unreadableDirs.length > 0;
}

/* A row declined before the decline route separated it, still on the voice it
   declined: its next design separates it once, with the same helper and locks as
   the route, before designing. Decided on POSITIVE evidence only, so a row the
   route (or an earlier design) already separated never separates again, however
   its chain grows: the old uuid recorded on `declinedVoiceUuids` is never the
   row's own after a separation, and a declined book never acquires the row's
   new uuid.
   - No uuid and a marker: separate (the series mint would move the earlier
     book's legacy key).
   - A uuid on its own `declinedVoiceUuids`: separate while another book holds it
     (or a book cannot be read: it may be the holder).
   - Otherwise: separate only when a readable book it declined holds its uuid. */
export function mustSeparateOnDesign(row: MarkedRow, scan: VoiceScan): boolean {
  const declined = row.declinedVoiceFrom ?? [];
  if (!declined.length) return false;
  if (!row.voiceUuid) return true;
  if (row.declinedVoiceUuids?.includes(row.voiceUuid)) {
    return scan.heldElsewhere || scan.unreadableDirs.length > 0;
  }
  return declined.some((id) => scan.holderBookIds.has(id));
}

/* #3992 — read-only: does some OTHER character, under a DIFFERENT base voice
   than `ownKey` (its storage key, `qwen-<uuid>` or the legacy
   `qwen-<voiceId ?? id>`), still name `variantId` among its
   `overrideTtsVoices.qwen.variants[*].name`? After a fork the declined row keeps
   the shared variant names, so tearing one down would delete the earlier book's
   `.pt`. A still-linked pair shares the base key, so it does NOT count (their
   shared variants go stale together and are deleted as before). A row with no
   uuid counts by its legacy key (P10-2: a legacy earlier book's variant). Scans
   every book under BOOKS_ROOT, takes no lock, writes nothing. */
export async function isVariantUsedByOtherVoiceUuid(variantId: string, ownKey: string): Promise<boolean> {
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        const cast = await readOtherBookCast<VariantCastFile>(dir);
        /* The other way round from the holder scans: this one gates a DELETE, so a
           book it cannot read counts as a possible holder and the file is kept
           (an orphan at worst, never a deleted take). */
        if (cast === UNREADABLE) return true;
        for (const y of cast?.characters ?? []) {
          if (qwenStorageKey(y, y.id ?? '') === ownKey) continue;
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
    id?: string;
    voiceId?: string | null;
    voiceUuid?: string | null;
    overrideTtsVoices?: { qwen?: { variants?: Record<string, { name?: string } | undefined> } };
  }>;
}
