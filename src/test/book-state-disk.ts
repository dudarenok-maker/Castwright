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
   - `failNext` scripts transport failures (503) for the next matching PUTs;
     `loseResponse` writes and then fails with a 503 (a lost 200);
     `refuseNext` scripts a non-stale 4xx (`book_path_taken`, `book_busy`).
   - Like the server, `state` merges a partial patch (an `undefined` field is
     not sent), while cast, manuscript and changeLog REPLACE the whole file
     (`writeJsonAtomic(path, patch)`, book-state.ts); a manuscript patch with
     no `sentences` array is a 400. The precondition checks only the fields
     the request carries, as the server's `carriedFields` does.
   - `serve` is the async face of `put`: `hold` keeps a matching PUT in transit
     until released, and `maxInTransit` reports the most PUTs ever in transit
     at once per `${bookId}:${slice}`. A PUT that matches a registered hold
     but is made through `put` throws: `put` cannot keep it in transit, so the
     hold would otherwise silently do nothing (#3784 pass 13, C1).
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
  outcome: 'ok' | '503' | '409' | '404' | '400' | 'lost' | 'refused';
}

type Match = (bookId: string, req: PutStateRequest) => boolean;
const always: Match = () => true;

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
const REFUSAL_SENTENCE: Record<string, string> = {
  book_path_taken: 'A book already exists at that Author/Series/Title path.',
  book_busy: 'This book is busy. Wait for it to finish, then try again.',
};

export function createBookStateDisk() {
  const books = new Map<string, DiskBook>();
  const log: DiskPut[] = [];
  const failures: Array<{ left: number; match: Match }> = [];
  const lost: Array<{ left: number; match: Match }> = [];
  const refusals: Array<{ code: string; match: Match }> = [];
  const holds: Array<{ match: Match; afterWrite: boolean; gate: Promise<void> }> = [];
  const inTransit = new Map<string, number>();
  const peak = new Map<string, number>();
  let nextEpoch = 1;
  /* True while `serve` lands a PUT through `put`, which then skips the hold check. */
  let serving = false;
  const land = (bookId: string, req: PutStateRequest): PutStateResponse => {
    serving = true;
    try {
      return disk.put(bookId, req);
    } finally {
      serving = false;
    }
  };
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
    failNext(n: number, match: Match = always) {
      failures.push({ left: n, match });
    },

    /** Write the next `n` matching PUTs, then fail them with a 503: the server
        landed the write and the response was lost. */
    loseResponse(n: number, match: Match = always) {
      lost.push({ left: n, match });
    },

    /** Refuse the next matching PUT with a non-stale 409 carrying `code`. */
    refuseNext(code: 'book_path_taken' | 'book_busy', match: Match = always) {
      refusals.push({ code, match });
    },

    /** Keep the next matching PUT made through `serve` in transit until the
        returned function is called. `afterWrite`: the write lands at once and
        only the response waits. */
    hold(match: Match = always, { afterWrite = false } = {}): () => void {
      let release!: () => void;
      const gate = new Promise<void>((r) => (release = r));
      holds.push({ match, afterWrite, gate });
      return () => release();
    },

    /** The most PUTs made through `serve` ever in transit at once for the key. */
    maxInTransit(bookId: string, slice: StateSlice): number {
      return peak.get(`${bookId}:${slice}`) ?? 0;
    },

    /** `put`, asynchronously, honouring `hold` and counting PUTs in transit. */
    async serve(bookId: string, req: PutStateRequest): Promise<PutStateResponse> {
      const key = `${bookId}:${req.slice}`;
      const now = (inTransit.get(key) ?? 0) + 1;
      inTransit.set(key, now);
      peak.set(key, Math.max(peak.get(key) ?? 0, now));
      try {
        const i = holds.findIndex((h) => h.match(bookId, req));
        if (i < 0) return land(bookId, req);
        const [h] = holds.splice(i, 1);
        if (!h.afterWrite) {
          await h.gate;
          return land(bookId, req);
        }
        let answer: () => PutStateResponse;
        try {
          const res = land(bookId, req);
          answer = () => res;
        } catch (err) {
          answer = () => {
            throw err;
          };
        }
        await h.gate;
        return answer();
      } finally {
        inTransit.set(key, (inTransit.get(key) ?? 1) - 1);
      }
    },

    put(bookId: string, req: PutStateRequest): PutStateResponse {
      if (!serving && holds.some((h) => h.match(bookId, req))) {
        throw new Error(
          `disk.hold matches this ${bookId}:${req.slice} PUT, but it was made through disk.put, which cannot hold it; route it through disk.serve`,
        );
      }
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
      if (req.slice === 'manuscript' && !Array.isArray(patch.sentences)) {
        entry('400');
        throw new Error('Book state PUT failed (400): Malformed manuscript patch');
      }
      const refusal = refusals.findIndex((r) => r.match(bookId, req));
      if (refusal >= 0) {
        const [{ code }] = refusals.splice(refusal, 1);
        entry('refused');
        throw Object.assign(new Error(`Book state PUT failed (409): ${REFUSAL_SENTENCE[code]}`), { code });
      }
      const before = disk.content(bookId, req.slice);
      /* The server merges a partial state patch (JSON drops an `undefined`
         field) and writes every other slice's patch as the whole file. */
      const sent = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
      const after = req.slice === 'state' ? { ...(before ?? {}), ...sent } : sent;
      /* The server's `carriedFields`: a cast check covers its one field, every
         other slice only the fields the request carries. */
      const carried = req.slice === 'cast' ? FIELDS.cast : FIELDS[req.slice].filter((f) => f in sent);
      if (disk.check && req.baseRevision) {
        const cur = tokens(disk.epochOf(bookId), before, req.slice);
        const next = tokens(disk.epochOf(bookId), after, req.slice);
        const stale = carried.filter(
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
      const lose = lost.find((l) => l.left > 0 && l.match(bookId, req));
      if (lose) {
        lose.left -= 1;
        entry('lost');
        throw new Error('Book state PUT failed (503): Service Unavailable');
      }
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
