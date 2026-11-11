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
import { BOOKS_ROOT, castJsonPath, castReuseCarryoverJsonPath, stateJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import { readStateJsonWithRecovery } from './state-migrate.js';
import { loadCastIdHistory } from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';
import { qwenStorageKey } from '../tts/voice-mapping.js';
import { dropStaleVariants } from './variant-base-rev.js';

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
async function readBookIdentity(
  dir: string,
): Promise<{ bookId?: string; series?: { author: string; series: string }; castConfirmed: boolean }> {
  const state = await readStateJsonWithRecovery(stateJsonPath(dir));
  const inSeries = state && state.isStandalone !== true && state.author && state.series;
  return {
    bookId: state?.bookId || undefined,
    series: inSeries ? { author: state.author as string, series: state.series as string } : undefined,
    castConfirmed: state?.castConfirmed === true,
  };
}

/* F8 (owner decision: "not until confirmed") — is this book's cast confirmed? A
   design in a book whose cast is not shares nothing with the series. Throws like
   any state read. */
export async function readBookCastConfirmed(dir: string): Promise<boolean> {
  return (await readBookIdentity(dir)).castConfirmed;
}

/* A book whose cast.json (or state.json) could not be read, with what its
   state.json still says about it, if anything (`known`: it was read), and its cast
   rows when only its state.json could not be read. */
interface UnreadableBook {
  dir: string;
  known: boolean;
  bookId?: string;
  series?: { author: string; series: string };
  rows?: CastRow[];
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
async function loadOtherBooks(
  selfDir: string,
): Promise<{ books: OtherBook[]; unreadableDirs: string[]; unreadable: UnreadableBook[] }> {
  const out: OtherBook[] = [];
  const unreadableDirs: string[] = [];
  const unreadable: UnreadableBook[] = [];
  for (const authorName of listDirs(BOOKS_ROOT)) {
    for (const seriesName of listDirs(join(BOOKS_ROOT, authorName))) {
      for (const titleName of listDirs(join(BOOKS_ROOT, authorName, seriesName))) {
        const dir = join(BOOKS_ROOT, authorName, seriesName, titleName);
        if (resolve(dir) === selfDir) continue;
        const cast = await readOtherBookCast<CastFile>(dir);
        if (cast === UNREADABLE) {
          unreadableDirs.push(resolve(dir));
          /* F1 — its state.json may still say which book and series it is. */
          try {
            const id = await readBookIdentity(dir);
            unreadable.push({ dir: resolve(dir), known: true, bookId: id.bookId, series: id.series });
          } catch {
            unreadable.push({ dir: resolve(dir), known: false });
          }
          continue;
        }
        if (!cast?.characters?.length) continue;
        let identity: Awaited<ReturnType<typeof readBookIdentity>>;
        try {
          identity = await readBookIdentity(dir);
        } catch (e) {
          console.warn(`[voice-uuid-fork] skipping unreadable state.json in ${dir}: ${(e as Error).message}`);
          unreadableDirs.push(resolve(dir));
          unreadable.push({ dir: resolve(dir), known: false, rows: cast.characters });
          continue;
        }
        out.push({ dir, bookId: identity.bookId, series: identity.series, rows: cast.characters });
      }
    }
  }
  return { books: out, unreadableDirs, unreadable };
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
  /** F1 — a book that could not be read may be in X's follower chain: it is in X's
      series (or its series cannot be told), and it is not a book X declines. */
  chainUnreadable?: boolean;
  /** Review pass 3 (C) — a book that could not be read may hold X's voice: it is in X's
      series (or its series cannot be told) and its rows, when they read, include one
      on the voice. An unconfirmed design isolates on this (never refuses). */
  unreadableMayHold?: boolean;
  /** F1 — rows a decline LEFT BEHIND: the chain that leads down to X among rows
      still on the voice X left (a uuid on X's `declinedVoiceUuids`, or, for a
      legacy decline, X's legacy key). Only for a row that carries the marker. */
  stranded?: LinkFollower[];
}

/* One bounded pass over the library: who else holds X's voice, split into X's
   followers (the whole chain) and everyone else. Read-only and lock-free; the separation
   re-runs it inside the locks it takes. `fromBookId` is the book a decline is
   declining (not yet on X's `declinedVoiceFrom`); it and X's declined books are
   never followers (chainFollowers). */
export async function scanVoiceHolders(
  bookDir: string,
  character: {
    id: string;
    voiceId?: string | null;
    voiceUuid?: string | null;
    declinedVoiceFrom?: string[] | null;
    declinedVoiceUuids?: string[] | null;
  },
  holds: VoiceHolds,
  fromBookId?: string,
): Promise<VoiceScan> {
  const selfDir = resolve(bookDir);
  const { books, unreadableDirs, unreadable } = await loadOtherBooks(selfDir);
  const declined = new Set([...(character.declinedVoiceFrom ?? []), ...(fromBookId ? [fromBookId] : [])]);
  const followers = await chainFollowers(selfDir, character, holds, books, declined);
  /* F1 (owner decision: refuse while unreadable) — every link is series-scoped
     (link-prior, the linker and Confirm's matcher all are), so only a book of X's
     own series can be in its chain. A declined book is never a follower (P10-1),
     and a book with no bookId cannot be one either. A book whose state.json cannot
     be read is judged by its cast rows when those read (review pass 1: does a row
     on X's voice link to X or a follower's book?); one whose cast.json cannot be
     read either counts. */
  const selfIdentity = await readBookIdentity(selfDir);
  const selfSeries = selfIdentity.series;
  const sameSeries = (s?: { author: string; series: string }): boolean =>
    !!s && !!selfSeries && s.author === selfSeries.author && s.series === selfSeries.series;
  const unreadableMayHold = unreadable.some((b) =>
    b.known ? sameSeries(b.series) : b.rows ? b.rows.some(holds) : true,
  );
  /* F1 — the rows a decline left behind (before this rule, a decline went through
     with a chain member unreadable): linked down to X, on the voice X left. */
  const leftUuids = character.declinedVoiceUuids ?? [];
  const linkId = character.voiceId ?? character.id;
  const leftBehind: VoiceHolds = (y) =>
    y.voiceUuid ? y.voiceUuid !== character.voiceUuid && leftUuids.includes(y.voiceUuid) : !leftUuids.length && (y.voiceId ?? y.id) === linkId;
  const chainBookIds = new Set([selfIdentity.bookId, ...followers.map((f) => f.bookId)].filter(Boolean) as string[]);
  const linksIntoChain = (rows: CastRow[]): boolean =>
    rows.some((y) => (holds(y) || leftBehind(y)) && chainBookIds.has((y.matchedFrom as MatchedFrom)?.bookId ?? ''));
  const chainUnreadable = unreadable.some((b) =>
    b.known ? !!b.bookId && !declined.has(b.bookId) && sameSeries(b.series) : b.rows ? linksIntoChain(b.rows) : true,
  );
  const stranded =
    character.declinedVoiceFrom?.length && character.voiceUuid ? await chainFollowers(selfDir, character, leftBehind, books, declined) : [];
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
  return { followers, heldElsewhere, holderBookIds, unreadableDirs, chainUnreadable, unreadableMayHold, stranded };
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

/* #4026 — the directories under `path`, or null when it cannot be listed (a
   missing `path` is an empty list). The orphan-variant sweep fails closed on a
   library it cannot see whole; listDirs' silent [] would hide a book. */
function listDirsOrNull(path: string): string[] | null {
  if (!existsSync(path)) return [];
  try {
    return readdirSync(path, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (e) {
    console.warn(`[voice-uuid-fork] cannot list ${path}: ${(e as Error).message}`);
    return null;
  }
}

/* #4026 — the cast rows of one book that can name a variant: cast.json's, or,
   when it is absent or has no characters (a reparse deletes it and the next
   analysis restores the slots from the carryover), the reuse carryover's: the
   same either-or as readPriorCastForMerge (routes/analysis.ts), the only reader
   that restores a cast-shaped file into cast.json. No other file under
   .audiobook/ holds voice slots (PR #4038 pass 4). UNREADABLE when either file
   that decides cannot be read. */
async function readCastRowsForVariants(dir: string): Promise<NonNullable<VariantCastFile['characters']> | typeof UNREADABLE> {
  const cast = await readOtherBookCast<VariantCastFile>(dir);
  if (cast === UNREADABLE) return UNREADABLE;
  if (cast?.characters?.length) return cast.characters;
  try {
    return (await readJson<VariantCastFile>(castReuseCarryoverJsonPath(dir)))?.characters ?? [];
  } catch (e) {
    console.warn(`[voice-uuid-fork] skipping unreadable cast-reuse-carryover.json in ${dir}: ${(e as Error).message}`);
    return UNREADABLE;
  }
}

/* #4026 — read-only: every qwen voice name a cast row in the library names, for
   the startup sweep of variant files nothing names (sweepOrphanVariantFiles). A
   row names a variant by a slot's stored `name`, or by the key the render path
   derives (`<qwenStorageKey>__<emotion>`, which for a row with no uuid is its
   legacy `qwen-<voiceId ?? id>` key, P10-2; a row with a uuid never reads the
   legacy key). Its base names (the slot's `name` and its storage key) are in the
   set too, so a base whose key happens to end in `__<emotion>` is never taken for
   a variant. No marker, link or uuid comparison decides it: a file a row names is
   kept, unless the slot naming it is stale (#4040: its base was redesigned since,
   variant-base-rev.ts). null when a library folder cannot be listed or a cast.json cannot be read:
   the caller then deletes nothing (an orphan at worst, never a deleted take).
   Scans every book under BOOKS_ROOT, takes no lock, writes nothing. */
export async function namedQwenVoices(): Promise<Set<string> | null> {
  const named = new Set<string>();
  const authors = listDirsOrNull(BOOKS_ROOT);
  if (!authors) return null;
  for (const authorName of authors) {
    const series = listDirsOrNull(join(BOOKS_ROOT, authorName));
    if (!series) return null;
    for (const seriesName of series) {
      const titles = listDirsOrNull(join(BOOKS_ROOT, authorName, seriesName));
      if (!titles) return null;
      for (const titleName of titles) {
        const cast = await readCastRowsForVariants(join(BOOKS_ROOT, authorName, seriesName, titleName));
        if (cast === UNREADABLE) return null;
        /* #4040 — a stale variant slot (its base was redesigned) names nothing:
           the render no longer uses it, so its files go too. */
        for (const y of await dropStaleVariants(cast)) {
          const qwen = y.overrideTtsVoices?.qwen;
          /* The render path's key: a uuid row's own, or (no uuid) the legacy one. */
          const key = qwenStorageKey(y, y.id ?? '');
          named.add(key);
          if (qwen?.name) named.add(qwen.name);
          for (const [emotion, v] of Object.entries(qwen?.variants ?? {})) {
            if (!v) continue;
            if (v.name) named.add(v.name);
            named.add(`${key}__${emotion}`);
          }
        }
      }
    }
  }
  return named;
}

interface VariantCastFile {
  characters?: Array<{
    id?: string;
    voiceId?: string | null;
    voiceUuid?: string | null;
    overrideTtsVoices?: { qwen?: { name?: string; variants?: Record<string, { name?: string } | undefined> } };
  }>;
}
