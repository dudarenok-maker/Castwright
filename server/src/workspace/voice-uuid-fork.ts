/* #3992 — read-only decision helper: may a character's voice be designed as it
   is, must it fork first, or must the design be refused?

   The series linker hands a linked character the source book's `voiceUuid` on
   purpose (series-reuse-link.ts), so both books share one `qwen-<uuid>.pt`.
   When the user declines that link, redux clears `matchedFrom` but the uuid
   survives on disk. A redesign would then overwrite the earlier book's file.
   The decline is recorded server-side as `declinedVoiceFrom` (and the voice it
   declined as `declinedVoiceUuids`, which only lets the linker skip a link), so
   every decision is made from disk state.

   THE TWO-BOOK FORK. A character X (book B, id cX, uuid U) forks when ALL hold:
   1. X has a uuid, NO `matchedFrom` at all (a bookId-less one, as written
      by a manual Assign, still counts as an active link) AND a non-empty
      `declinedVoiceFrom` (the durable "Don't reuse" marker, #3992). A row
      declined before the marker shipped has none and never forks (it behaves as
      it did before #3992); a row nobody declined never forks.
   2. A readable book whose bookId is in `declinedVoiceFrom` holds U right now (read
      from disk at decide time; the stored `declinedVoiceUuids` is never trusted
      to fork, it can be stale). A declined book that cannot be read, and that no
      readable book carries the id of, refuses the design instead.
   3. At least one character in ANOTHER book has `voiceUuid === U` and is NOT a
      DIRECT follower of X (below). That is the earlier book whose bytes must be
      kept.
   A DIRECT follower of X is a row, in another book, holding U whose `matchedFrom`
   names B's bookId with a characterId that resolves to X (through B's live cast and
   id history). A `matchedFrom` with a bookId but no characterId names the row with
   the SAME id. One hop only: a row linking to a follower is NOT carried. Followers
   move to the new uuid together with X, in one locked write (qwen-voice.ts
   forkSharedVoiceUuid); everything else holding U stays.

   THE FAIL-CLOSED RULE (decideSharedVoiceDesign). Any other design that would
   write a voice another book holds, while a decline of that voice is in play, is
   refused unless the row is provably on the earlier book's side. Nothing walks a
   link chain: each decision reads the library ONCE and looks at most one hop up
   from the row being designed, so a cycle or a long chain cannot loop or reach a
   book the fork did not lock. See decideSharedVoiceDesign for the exact rule.

   Writes nothing and takes no lock. */

import { join, resolve, basename } from 'node:path';
import { existsSync, readdirSync } from 'node:fs';
import { BOOKS_ROOT, castJsonPath, stateJsonPath } from './paths.js';
import { readJson } from './state-io.js';
import { readStateJsonWithRecovery } from './state-migrate.js';
import { loadCastIdHistory } from '../store/cast-id-history.js';
import { buildCastResolver } from '../store/cast-resolve.js';

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
   OTHER books catches it, the book being designed does not. */
async function readBookMeta(dir: string): Promise<{ bookId?: string; title?: string }> {
  const state = await readStateJsonWithRecovery(stateJsonPath(dir));
  return { bookId: state?.bookId || undefined, title: state?.title || undefined };
}

/* Also exported for the fork write, which needs the designed book's id to take
   its book-op. */
export async function readBookId(dir: string): Promise<string | undefined> {
  return (await readBookMeta(dir)).bookId;
}

interface OtherBook {
  dir: string;
  bookId?: string;
  title?: string;
  rows: CastRow[];
}

interface OtherBooks {
  books: OtherBook[];
  /** Some other book could not be identified, so what it holds is unknown. */
  unreadable: boolean;
  /** Those books' folders. */
  unreadableDirs: string[];
}

/* Every OTHER book's readable cast, with its bookId and title: one bounded pass
   over the library. A book whose cast.json OR state.json cannot be read is not in
   `books` (without its bookId no link can be matched to it, so it could be any
   link's target) and is reported in `unreadable` so each caller decides what not
   knowing means (#4025: a torn state.json used to leave the book in `books` with
   no id, where a link to it read as "deleted book"). */
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
        let meta: { bookId?: string; title?: string };
        try {
          meta = await readBookMeta(dir);
        } catch (e) {
          console.warn(`[voice-uuid-fork] skipping unreadable state.json in ${dir}: ${(e as Error).message}`);
          unreadableDirs.push(resolve(dir));
          continue;
        }
        out.push({ dir, bookId: meta.bookId, title: meta.title, rows: cast.characters });
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

/* What "holds the shared voice" means: a row on the uuid, or (for a row that never
   got a uuid) a row on the same legacy key `qwen-<voiceId ?? id>`. */
export type VoiceHolds = (row: CastRow) => boolean;
const holdsUuid = (uuid: string): VoiceHolds => (y) => y.voiceUuid === uuid;
export const holdsLegacyKey =
  (linkId: string): VoiceHolds =>
  (y) =>
    !y.voiceUuid && (y.voiceId ?? y.id) === linkId;

/* The rows in other books that link DIRECTLY to X (one hop, never further), among
   rows holding the voice. A row that links to one of these is not a follower. */
async function directFollowers(
  selfDir: string,
  character: { id: string },
  holds: VoiceHolds,
  others: OtherBook[],
): Promise<LinkFollower[]> {
  const selfBookId = await readBookId(selfDir);
  if (!selfBookId) return []; // a book with no id cannot be named by a link
  let resolver: ReturnType<typeof buildCastResolver<CastRow>> | undefined;
  const namesX = async (characterId: string): Promise<boolean> => {
    if (characterId === character.id) return true;
    if (!resolver) {
      const rows = (await readJson<CastFile>(castJsonPath(selfDir)))?.characters ?? [];
      resolver = buildCastResolver<CastRow>(rows, await loadCastIdHistory(selfDir));
    }
    return resolver.resolve(characterId)?.character.id === character.id;
  };
  const followers: LinkFollower[] = [];
  for (const book of others) {
    /* A book with no bookId cannot be locked by id (no route can move it either),
       so it cannot be moved with X: it stays on U. */
    if (!book.bookId) continue;
    for (const y of book.rows) {
      if (!holds(y)) continue;
      const mf = y.matchedFrom as MatchedFrom;
      if (!mf?.bookId || mf.bookId !== selfBookId) continue;
      if (!(await namesX(mf.characterId ?? y.id))) continue;
      followers.push({ dir: book.dir, bookId: book.bookId, characterId: y.id });
    }
  }
  return followers;
}

/* Every row in another book that follows X directly (see the header), and the
   folders of the books that could not be read (a follower there would be
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
  return { followers: await directFollowers(selfDir, character, holds, books), unreadableDirs };
}

export async function findLinkFollowers(
  bookDir: string,
  character: { id: string },
  voice: string | VoiceHolds,
): Promise<LinkFollower[]> {
  return (await scanLinkFollowers(bookDir, character, voice)).followers;
}

/* Could an unreadable book be the one with this bookId? One whose state.json
   names another bookId cannot be; one whose state.json cannot be read is
   unidentified, so it might be. */
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

interface DesignRow {
  id: string;
  voiceId?: string | null;
  voiceUuid?: string | null;
  matchedFrom?: unknown;
  declinedVoiceFrom?: string[] | null;
  declinedVoiceUuids?: string[] | null;
  overrideTtsVoices?: { qwen?: { name?: string } } | null;
}

/* What the design may do with the voice the row holds now. */
export type SharedVoiceDesign =
  /** Design under the row's current voice, as before #3992. */
  | { kind: 'proceed' }
  /** A declined, unlinked row: the two-book fork (uuid) or the legacy-key mint
      apart runs first, then the design writes a voice nobody else holds. */
  | { kind: 'separate' }
  /** Writing would put this design on a voice another book still keeps. */
  | { kind: 'refuse'; message: string };

export const UNREADABLE_BOOK_MESSAGE = 'A book in this series could not be read; try again once it can.';
export const redesignFirstMessage = (title: string): string =>
  `Redesign "${title}" first. This voice is shared with it.`;
export const sharedThroughChainMessage = (title: string): string =>
  `Redesign "${title}" to change this shared voice, or choose "Don't reuse" to give this character its own.`;

export const dontReuseMessage = `This voice is shared with an earlier book. Choose "Don't reuse" to give this character its own.`;

const titleOf = (book: OtherBook): string => book.title || basename(book.dir);

/* #3992 — the fail-closed rule, checked under the design lock before any write or
   sidecar call (qwen-voice.ts). Reads the library ONCE and never walks a link
   chain. V is the voice the design would write: the uuid U, or, for a row with no
   uuid, the legacy key `qwen-<voiceId ?? id>` (whose design takes the series mint
   and so moves every series row on that key onto the redesign).

   1. An UNLINKED row (no `matchedFrom`): it is the earlier book itself, a row the
      series mint put on V, or a declined row. Only the declined row whose voice
      another book holds is separated (the two-book fork, or the legacy-key mint
      apart), and that writes a voice nobody else holds. Everything else proceeds.
   2. A LINKED row whose voice no other readable book holds, with every book
      readable, proceeds: nothing else can be written.
   3. Otherwise it proceeds only when no decline of V is in play: no readable row
      declined V (by `declinedVoiceUuids`, or by naming a book that holds V), and no
      holder of V links to a book that could be an unreadable one (which could hide
      a decline). Then V is shared by design.
   4. With a decline in play it proceeds only when it is provably on the earlier
      book's side: its ONE-hop link target holds V, has no link of its own, and did
      not decline V. Every other shape is refused, never walked: a longer chain, a
      link target that left V (a stranded row), a cycle, a target that cannot be
      read, a legacy row whose source holds a uuid. A target that is an UNFORKED
      decliner on V names itself ("Redesign <it> first"): its own design forks and
      carries this row with it, after which this design is free. The rest name a
      book still on V: redesign that book, or "Don't reuse", which makes the row an
      unlinked decliner of its own (case 1).

   Writes nothing and takes no lock. */
export async function decideSharedVoiceDesign(
  bookDir: string,
  character: DesignRow,
): Promise<SharedVoiceDesign> {
  const selfDir = resolve(bookDir);
  const lib = await loadOtherBooks(selfDir);
  const uuid = character.voiceUuid || undefined;
  const linkId = character.voiceId ?? character.id;
  const holds = uuid ? holdsUuid(uuid) : holdsLegacyKey(linkId);

  if (!character.matchedFrom) {
    if (uuid) {
      const verdict = await mustForkUuid(selfDir, character, lib);
      if (verdict === 'refuse') return { kind: 'refuse', message: UNREADABLE_BOOK_MESSAGE };
      return verdict === 'fork' ? { kind: 'separate' } : { kind: 'proceed' };
    }
    return (await mustMintApart(selfDir, character, lib)) ? { kind: 'separate' } : { kind: 'proceed' };
  }

  const holders = lib.books.flatMap((book) => book.rows.filter(holds).map((row) => ({ book, row })));
  if (!holders.length && !lib.unreadable) return { kind: 'proceed' };

  const linkedBookIds = new Set(lib.books.map((b) => b.bookId).filter(Boolean));
  const mightBeUnreadable = async (mf: MatchedFrom): Promise<boolean> =>
    !!mf?.bookId && lib.unreadable && !linkedBookIds.has(mf.bookId) && (await couldBeUnreadable(lib.unreadableDirs, mf.bookId));

  /* The row this one links to: one hop, never further. */
  const mf = character.matchedFrom as MatchedFrom;
  if (await mightBeUnreadable(mf)) return { kind: 'refuse', message: UNREADABLE_BOOK_MESSAGE };
  let target: { book: OtherBook; row: CastRow } | undefined;
  const targetBook = mf?.bookId ? lib.books.find((b) => b.bookId === mf.bookId) : undefined;
  if (targetBook) {
    const resolver = buildCastResolver<CastRow>(targetBook.rows, await loadCastIdHistory(targetBook.dir));
    const row = resolver.resolve(mf?.characterId ?? character.id)?.character;
    if (row) target = { book: targetBook, row };
  }

  /* Did this row decline V? By its uuid, or, on a row of the same `voiceId ?? id`,
     by naming a book that holds V (a decline recorded before the row had a uuid
     names only the book). A declined row still on V with no link is the unforked
     decliner. A legacy key has no uuid to name, so a declined row on the same
     `voiceId ?? id` declined it too (a row that minted apart keeps that voiceId and
     its marker). */
  const holderBookIds = new Set(holders.map((h) => h.book.bookId).filter((id): id is string => !!id));
  const selfBookId = await readBookId(selfDir);
  if (selfBookId) holderBookIds.add(selfBookId);
  const declines = (row: CastRow): boolean =>
    ((row.voiceId ?? row.id) === linkId && !!row.declinedVoiceFrom?.some((id) => holderBookIds.has(id))) ||
    (uuid
      ? !!row.declinedVoiceUuids?.includes(uuid)
      : (row.voiceId ?? row.id) === linkId && !!row.declinedVoiceFrom?.length);

  let inPlay = declines(character) || lib.books.some((b) => b.rows.some(declines));
  if (!inPlay) {
    for (const h of holders) {
      if (await mightBeUnreadable(h.row.matchedFrom as MatchedFrom)) {
        inPlay = true;
        break;
      }
    }
  }
  if (!inPlay) return { kind: 'proceed' };

  if (target && holds(target.row) && !target.row.matchedFrom) {
    if (!declines(target.row)) return { kind: 'proceed' };
    return { kind: 'refuse', message: redesignFirstMessage(titleOf(target.book)) };
  }
  /* Name a book only when redesigning it changes this voice: the link target holds
     V and the book named is an unlinked row that did not decline it (the earlier
     book itself). Every other shape (a follower stranded on V, an earlier book that
     cannot be read) gets the sentence that is true there. */
  const earlier = holders.find((h) => !h.row.matchedFrom && !declines(h.row));
  if (target && holds(target.row) && earlier) {
    return { kind: 'refuse', message: sharedThroughChainMessage(titleOf(earlier.book)) };
  }
  return { kind: 'refuse', message: lib.unreadable ? UNREADABLE_BOOK_MESSAGE : dontReuseMessage };
}

/* Is the row's current uuid a voice it declined? Decided from DISK at decide time,
   never from the stored `declinedVoiceUuids`, which can be stale: link-prior moves
   no uuid, so a re-decline records the row's own forked uuid, and a decline made
   while the row had no uuid records none. The row forks only when a readable book
   whose bookId is in its `declinedVoiceFrom` holds its uuid right now. A declined id
   no readable book carries may be an unidentified book (its state.json is
   unreadable) or an unreadable cast.json: that could hide the holder, so the design
   is refused (a retry sentence), never forked. `declinedVoiceUuids` is not read
   here; it only lets the linker, the merge and voice-match skip a link. */
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
  const selfDir = resolve(bookDir);
  return (await mustForkUuid(selfDir, character, await loadOtherBooks(selfDir))) === 'fork';
}

async function mustForkUuid(
  selfDir: string,
  character: {
    id: string;
    voiceUuid?: string | null;
    matchedFrom?: unknown;
    declinedVoiceFrom?: string[] | null;
  },
  { books, unreadable, unreadableDirs }: OtherBooks,
): Promise<'fork' | 'refuse' | 'proceed'> {
  const uuid = character.voiceUuid;
  if (!uuid) return 'proceed';
  if (character.matchedFrom) return 'proceed';
  /* Only a row the user DECLINED forks. `declinedVoiceFrom` is the durable
     record; "no matchedFrom" alone is also what a never-linked row looks like
     (a book confirmed before the earlier one, a null seriesPosition), and a
     series-minted shared uuid on such a row is intentional. */
  if (!character.declinedVoiceFrom?.length) return 'proceed';
  const declinedBooks = new Set(character.declinedVoiceFrom);
  const readableDeclined = books.filter((b) => !!b.bookId && declinedBooks.has(b.bookId));
  if (!readableDeclined.some((b) => b.rows.some(holdsUuid(uuid)))) {
    /* No readable book it declined holds its uuid. A row that already forked sits
       here for good and never forks again, however long the chain below it grows: it
       would drop its variants and split the chain. Unless a declined book cannot be
       read: it may hold the uuid, and a design would overwrite its .pt. */
    if (unreadable) {
      const carried = new Set(readableDeclined.map((b) => b.bookId));
      for (const id of declinedBooks) {
        if (!carried.has(id) && (await couldBeUnreadable(unreadableDirs, id))) return 'refuse';
      }
    }
    return 'proceed';
  }
  const followed = new Set(
    (await directFollowers(selfDir, character, holdsUuid(uuid), books)).map((f) => rowKey(f.dir, f.characterId)),
  );
  return books.some((b) => b.rows.some((y) => y.voiceUuid === uuid && !followed.has(rowKey(b.dir, y.id))))
    ? 'fork'
    : 'proceed';
}

/* Does a readable book with this bookId hold the uuid right now? The decline route
   records a uuid only when it does (see mustForkUuid: the record is advisory, the
   fork is decided from disk). */
export async function bookHoldsVoiceUuid(bookDir: string, bookId: string, uuid: string): Promise<boolean> {
  const { books } = await loadOtherBooks(resolve(bookDir));
  return books.some((b) => b.bookId === bookId && b.rows.some(holdsUuid(uuid)));
}

/* #3992 — read-only: the no-uuid sibling of shouldForkSharedVoiceUuid. A row
   with NO uuid and no `matchedFrom` shares the legacy key `qwen-<voiceId ?? id>`
   with the earlier book. The series mint would stamp the earlier book too and move
   ITS render key onto the redesign, so a declined row must mint a uuid of its own
   instead. True only when ANOTHER book's row has the same `voiceId ?? id`, no uuid
   and a designed qwen slot of its own, and is not a DIRECT follower of X (same
   reading as the uuid fork). A key nobody else designed never trips it. */
export async function shouldMintApartFromLegacyKey(
  bookDir: string,
  character: LegacyRow,
): Promise<boolean> {
  const selfDir = resolve(bookDir);
  return mustMintApart(selfDir, character, await loadOtherBooks(selfDir));
}

async function mustMintApart(
  selfDir: string,
  character: LegacyRow,
  { books, unreadable }: OtherBooks,
): Promise<boolean> {
  if (character.voiceUuid || character.matchedFrom) return false;
  if (!character.declinedVoiceFrom?.length) return false; // not declined: shares by design
  const holds = holdsLegacyKey(character.voiceId ?? character.id);
  if (unreadable) return true; // unknown, so a possible holder (see shouldForkSharedVoiceUuid)
  /* The direct followers of X move with it, so they are not the earlier book. Any
     OTHER designed holder of the key is, and the earlier book's render key must
     not move. */
  const followed = new Set(
    (await directFollowers(selfDir, character, holds, books)).map((f) => rowKey(f.dir, f.characterId)),
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
