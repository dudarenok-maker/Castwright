/* Plan 289 — a test-only model of a book's on-disk state behind
   `api.getBookState` / `api.putBookState`, applying the server's revision
   precondition and its edit epoch (server/src/workspace/slice-revision.ts,
   server/src/routes/book-state.ts).

   - Tokens are per top-level field, salted with the book's epoch: an epoch
     change (re-parse, replace, Start fresh, re-import) moves every token.
   - A PUT carrying `baseRevision` is refused with 409 `stale_revision` when a
     field's base token is present, differs from disk, and the write would
     change that field (the no-op rule). Nothing is written.
   - `check` and `epochs` turn the precondition and the epoch off, so a test
     can show it is red without them.
   - `failNext` scripts transport failures (503) for the next matching PUTs.
   - `log` records every PUT in order. */

import type { SliceRevision, StateSlice, PutStateRequest, PutStateResponse } from '../lib/types';

export interface DiskBook {
  epoch: number;
  state: Record<string, unknown>;
  cast: { characters: unknown[] } | null;
  manuscript: { sentences: unknown[]; mergedAwayKeys?: unknown[] } | null;
  changeLog: unknown[] | null;
}

export interface DiskPut {
  bookId: string;
  slice: StateSlice;
  patch: Record<string, unknown>;
  base: boolean;
  outcome: 'ok' | '503' | '409' | '404';
}

const SLICES: StateSlice[] = ['state', 'cast', 'manuscript', 'changeLog'];
/* The fields the server keeps a token for, per slice (D1). */
const FIELDS: Record<StateSlice, readonly string[]> = {
  state: [
    'castConfirmed',
    'title',
    'author',
    'series',
    'seriesPosition',
    'isStandalone',
    'narratorCredit',
    'genre',
    'publicationDate',
    'description',
    'notes',
    'audioFormat',
    'language',
    'tags',
    'prosodyEnabled',
    'prosodyAnnotated',
  ],
  cast: ['characters'],
  manuscript: ['sentences', 'mergedAwayKeys'],
  changeLog: ['events'],
};

export const STALE_SENTENCE =
  'This book was changed elsewhere since your edit was made, so the edit was not saved.';

export function createBookStateDisk() {
  const books = new Map<string, DiskBook>();
  const log: DiskPut[] = [];
  const failures: Array<{ left: number; match: (bookId: string, req: PutStateRequest) => boolean }> = [];
  let nextEpoch = 1;
  const disk = {
    books,
    log,
    /** The precondition. Off: every PUT is unconditional. */
    check: true,
    /** The edit epoch. Off: a wipe or re-import leaves every token in place. */
    epochs: true,

    seed(bookId: string, book: Partial<Omit<DiskBook, 'epoch'>> & { state: Record<string, unknown> }) {
      books.set(bookId, {
        epoch: nextEpoch++,
        cast: null,
        manuscript: null,
        changeLog: null,
        ...book,
      });
    },

    content(bookId: string, slice: StateSlice): Record<string, unknown> | null {
      const b = books.get(bookId);
      if (!b) return null;
      switch (slice) {
        case 'state':
          return b.state;
        case 'cast':
          return b.cast;
        case 'manuscript':
          return b.manuscript;
        case 'changeLog':
          return b.changeLog ? { events: b.changeLog } : null;
      }
    },

    revision(bookId: string, slice: StateSlice): SliceRevision {
      return tokens(disk.epochOf(bookId), disk.content(bookId, slice), slice);
    },

    revisions(bookId: string): Record<StateSlice, SliceRevision> {
      return Object.fromEntries(SLICES.map((s) => [s, disk.revision(bookId, s)])) as Record<
        StateSlice,
        SliceRevision
      >;
    },

    epochOf(bookId: string): number {
      return disk.epochs ? (books.get(bookId)?.epoch ?? 0) : 0;
    },

    /** Fail the next `n` PUTs that match with a 503 (a transport failure). */
    failNext(n: number, match: (bookId: string, req: PutStateRequest) => boolean = () => true) {
      failures.push({ left: n, match });
    },

    put(bookId: string, req: PutStateRequest): PutStateResponse {
      const patch = (req.patch ?? {}) as Record<string, unknown>;
      const entry = (outcome: DiskPut['outcome']) =>
        log.push({ bookId, slice: req.slice, patch, base: !!req.baseRevision, outcome });
      const failure = failures.find((f) => f.left > 0 && f.match(bookId, req));
      if (failure) {
        failure.left -= 1;
        entry('503');
        throw new Error('Book state PUT failed (503): Service Unavailable');
      }
      if (!books.has(bookId)) {
        entry('404');
        throw new Error('Book state PUT failed (404): Book not found');
      }
      const before = disk.content(bookId, req.slice);
      const after = { ...(before ?? {}), ...patch };
      if (disk.check && req.baseRevision) {
        const cur = tokens(disk.epochOf(bookId), before, req.slice);
        const next = tokens(disk.epochOf(bookId), after, req.slice);
        const stale = Object.keys(cur).filter(
          (f) => req.baseRevision![f] !== undefined && req.baseRevision![f] !== cur[f] && next[f] !== cur[f],
        );
        if (stale.length > 0) {
          entry('409');
          throw Object.assign(new Error(`Book state PUT failed (409): ${STALE_SENTENCE}`), {
            code: 'stale_revision',
            fields: stale,
          });
        }
      }
      disk.write(bookId, req.slice, after);
      entry('ok');
      return { revision: disk.revision(bookId, req.slice) };
    },

    /** A writer outside the persistence middleware (another tab, a server route). */
    write(bookId: string, slice: StateSlice, value: Record<string, unknown>) {
      const b = books.get(bookId)!;
      if (slice === 'state') b.state = value;
      else if (slice === 'cast') b.cast = value as DiskBook['cast'];
      else if (slice === 'manuscript') b.manuscript = value as DiskBook['manuscript'];
      else b.changeLog = (value.events as unknown[]) ?? [];
    },

    /** A re-parse: the cast and edits are deleted, the cast un-confirmed, and
        the epoch rotated. */
    reparse(bookId: string) {
      const b = books.get(bookId)!;
      b.state = { ...b.state, castConfirmed: false };
      b.cast = null;
      b.manuscript = null;
      b.epoch = nextEpoch++;
    },

    remove(bookId: string) {
      books.delete(bookId);
    },

    /** An import under `bookId`: a new book with a new epoch. */
    reimport(bookId: string, book: Partial<Omit<DiskBook, 'epoch'>> & { state: Record<string, unknown> }) {
      disk.seed(bookId, book);
    },
  };
  return disk;
}

export type BookStateDisk = ReturnType<typeof createBookStateDisk>;

function tokens(epoch: number, content: Record<string, unknown> | null, slice: StateSlice): SliceRevision {
  const out: SliceRevision = {};
  for (const f of FIELDS[slice]) {
    out[f] =
      content == null
        ? `${epoch}|<absent-file>`
        : `${epoch}|${content[f] === undefined ? '<absent-field>' : JSON.stringify(content[f])}`;
  }
  return out;
}
