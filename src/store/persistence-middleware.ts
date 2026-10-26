/* Per-slice persistence middleware.

   Watches a curated set of action types that represent user edits and
   debounces a PUT /api/books/:bookId/state for the touched slice. Each
   (book, slice) pair has its own debounce window so an edit to cast doesn't
   delay a write to the manuscript, and one book's write never cancels another's.
   Leaving a book sends its queued writes at once (#3395 pass 4, S3).
   Opening a different book also clears any unsaved book-meta draft (#3754,
   #3624) so it cannot fold into the wrong book's save.

   Skipped when no bookId is in scope (library browsing, fresh upload
   before confirm), and when the slices hold a different book than the stage
   (the window after openBook, before hydrate — #3624). Under VITE_USE_MOCKS, PUTs still flow — the mock api
   keeps an in-memory state map (MOCK_BOOK_STATES in src/lib/api.ts) so
   the round-trip works for design fixtures and jsdom tests. */

import type { Middleware } from '@reduxjs/toolkit';
import type { CastState } from './cast-slice';
import type { ManuscriptState } from './manuscript-slice';
import type { UiState } from './ui-slice';
import type { ChangeLogState } from './change-log-slice';
import type { BookMetaState } from './book-meta-slice';
import type { PutStateResponse, SliceRevision, StateSlice } from '../lib/types';
import { api } from '../lib/api';
import { notificationsActions } from './notifications-slice';
import { bookMetaActions, type EditableBookMetaField } from './book-meta-slice';

/* Locally-typed shape of the store the middleware reads, declared without
   importing RootState to avoid a circular type reference back through the
   store config. */
interface PersistableRootState {
  ui: UiState;
  cast: CastState;
  manuscript: ManuscriptState;
  changeLog: ChangeLogState;
  bookMeta: BookMetaState;
  /* Optional like `settings`: only the toast title fallback reads it. */
  library?: { books: { bookId: string; title: string }[] };
  /* fe-2 — user-tunable autosave debounce. Optional so this type stays
     decoupled from the settings slice's full shape (and tests that build a
     partial root state don't have to supply it). */
  settings?: { autosaveDebounceMs?: number };
}

const DEFAULT_DEBOUNCE_MS = 500;

/* #1676(c) — action types whose persist failure the user MUST see: a silent
   swallow would leave redux showing the change applied while disk holds the
   prior value. Scoped to the bulk manuscript reassignment and the Listen-view
   book-meta save — the edits where the UI promising persistence while disk
   silently reverts is exactly the failure this sweep exists to close.
   Each entry carries the toast a persist failure should raise.
   `bookMeta/commitDraft` (added #2230) surfaces the server's OWN refusal
   sentence (a 409 rename refused mid-analysis, or a path collision) rather
   than a hardcoded copy, and rolls its optimistic saved[] update back so the
   header stops showing a value the server rejected. */
interface PersistFailureHandler {
  /** `bookTitle` is passed only for a save that was retried and given up on
      (network / 5xx), which can fire seconds after the user left the book —
      so the toast names it. A 4xx refusal is raised at once, on the book the
      user is still on, and gets no title. */
  message: (err: unknown, bookTitle?: string) => string;
  dedupeKey: string;
  /** Optional extra dispatch fired on persist failure — e.g. rolling back an
      optimistic local update. It only runs while the failing book is the
      open one (see the flush's final failure), so it may restore the shared
      draft; `restoreDraft` is false for a 4xx refusal that arrives after the
      book was left, which reverts without touching the draft. Returns the
      action to dispatch. */
  rollback?: (bookId: string, restoreDraft: boolean) => { type: string };
  /** Optional dispatch fired on a SUCCESSFUL flush — e.g. pruning a rollback
      snapshot now that its optimistically-written value is confirmed on disk,
      so the next commit snapshots a fresh baseline. Returns the action. */
  onSuccess?: (bookId: string) => { type: string };
}
/* Plan 289 — the server refused a re-sent save because the book changed since
   it was made (409 `stale_revision`). */
const isStaleRefusal = (err: unknown) => (err as { code?: unknown } | null)?.code === 'stale_revision';
const lineReassignFailedMessage = (err: unknown, bookTitle?: string) =>
  isStaleRefusal(err)
    ? `Line reassignment${bookTitle ? ` in "${bookTitle}"` : ''} wasn't saved: the book was changed elsewhere since you made it.`
    : `Line reassignment${bookTitle ? ` in "${bookTitle}"` : ''} could not be saved. Check your connection and try again.`;
const TOAST_ON_PERSIST_FAILURE: Record<string, PersistFailureHandler> = {
  'manuscript/setSentencesCharacterBulk': {
    message: (err, bookTitle) => lineReassignFailedMessage(err, bookTitle),
    dedupeKey: 'bulk-reassign-persist-failed',
  },
  'manuscript/undoBulkReassign': {
    message: (err, bookTitle) => lineReassignFailedMessage(err, bookTitle),
    dedupeKey: 'bulk-reassign-persist-failed',
  },
  /* #2230 — a refused rename (409: analysis running; or a folder path
     collision) must surface the server's sentence and not leave the persisted
     value claiming a title that never saved. The server message rides on
     err.message (api.putBookState unwraps `{ error }` from the 409 body);
     we strip the api.ts envelope so the toast shows only the refusal sentence,
     degrading gracefully to the raw message if that format ever changes. */
  'bookMeta/commitDraft': {
    message: (err, bookTitle) => {
      const raw = err instanceof Error ? err.message : '';
      const sentence =
        raw.replace(/^Book state PUT failed \(\d+\): /, '') || 'an unknown error occurred';
      return bookTitle
        ? `Book details for "${bookTitle}" couldn't be saved: ${sentence}`
        : `Book details couldn't be saved: ${sentence}`;
    },
    dedupeKey: 'book-meta-persist-failed',
    rollback: (bookId, restoreDraft) => bookMetaActions.rollbackCommitDraft({ bookId, restoreDraft }),
    onSuccess: (bookId) => bookMetaActions.commitDraftSucceeded({ bookId }),
  },
};

/* Read the user-tuned autosave debounce (fe-2) at flush-scheduling time so a
   change in the Account → Device-local panel takes effect on the next edit, with no
   reload. Falls back to the default when the slice is absent (older persisted
   blob / partial test state). */
function debounceMs(s: PersistableRootState): number {
  const v = s.settings?.autosaveDebounceMs;
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_DEBOUNCE_MS;
}

/* Action types that should trigger a persist. Hydration actions
   (hydrateFromAnalysis, hydrateFromBookState, applyPoll for initial load,
   setImportCandidate) are intentionally absent — those are server-driven
   and would create a write-loop if echoed back. Revisions never persist from
   the client at all (plan 286): the server owns revisions.json and refuses a
   revisions PUT. */
const PERSIST_RULES: Record<
  string,
  { slice: StateSlice; build: (s: PersistableRootState, bookId: string) => unknown }
> = {
  'cast/setCharacters': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  'cast/declineMatch': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  'cast/updateCharacter': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  'cast/renameCharacter': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  'cast/applyVoiceMatches': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  /* Manual continuity link (link-prior) must persist the SAME way auto-reuse
     (applyVoiceMatches) does — both stamp `matchedFrom`/`voiceId` on the
     character, so a forced reuse should land the identical durable end-state.
     Without this rule the link-prior endpoint wrote the prior book's alias +
     the source's voiceId but the source's `matchedFrom` lived only in redux
     and was lost on reload — so the "Reused" badge and the merge-picker
     "already linked" suppression (both keyed on `matchedFrom`) silently
     reverted. */
  'cast/applyManualMatch': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  /* Adding an alias goes through a dedicated server endpoint that writes
     cast.json directly; mirror it into a full-cast persist so the LATEST
     redux (which carries the new alias AND any concurrent rename) is the
     authoritative last writer. Otherwise a debounced cast PUT from an earlier
     edit, or the endpoint reading pre-rename disk, could clobber the alias /
     rename (the intermittent "also-known-as / rename didn't save" race). */
  'cast/applyAddAlias': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  /* Repoint mutates TWO characters (strip source + append target); mirror
     add-alias' full-cast persist so the latest redux wins any concurrent
     debounced cast PUT. The route also writes cast.json; this is the race-guard. */
  'cast/applyRepointAlias': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },
  'cast/lockVoice': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },

  'manuscript/setSentenceCharacter': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* #1676(c) — cross-chapter bulk reassignment persists the full manuscript
     patch like every other reassignment. */
  'manuscript/setSentencesCharacterBulk': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* #1676(c) — the undo restore is a committed edit like any reassignment;
     persist the full manuscript patch so the reverted attribution survives a
     reload. */
  'manuscript/undoBulkReassign': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  'manuscript/setSentencesCharacter': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* fs-25 — a hand-set per-quote emotion persists like a reassignment, so the
     manual override survives reload and wins over analyzer/seed emotion. */
  'manuscript/setSentenceEmotion': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* fs-56 — a hand-set per-line instruct persists like the emotion tag, so the
     manual delivery direction survives reload and reaches synth via
     manuscript-edits.json. */
  'manuscript/setSentenceInstruct': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* fs-33 — the bulk emotion backfill persists like a manual tag so detected
     emotions survive reload and reach synth via manuscript-edits.json. */
  'manuscript/applyDetectedEmotions': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* fs-57 — the prosody second pass (detected instruct / vocalization text)
     persists like the detected emotions above; without a rule it reached disk
     only when some later manuscript edit happened to trigger a save (#3435). */
  'manuscript/applyDetectedInstruct': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* #3400 — a chapter restructure re-keys the sentences, and the route has
     already rewritten manuscript-edits.json. A save built before (or during)
     the request carries the old chapter ids and lands after that rewrite, so
     the remap must be the last write queued: this rule replaces any pending
     patch and restarts the debounce. */
  'manuscript/applyChapterRestructure': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  'manuscript/splitSentence': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* fs-58 — a merge is a committed edit; the tombstone must survive reload
     so a re-analysis cannot resurrect the merged-away sentence id.
     Persisted alongside sentences in manuscript-edits.json. */
  'manuscript/mergeSentences': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* 2026-07-01 — sibling to mergeSentences. Deleting the sentence promoted
     into a chapter title must survive reload the same way a merge does. */
  'manuscript/promoteSentenceToTitle': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* fs-58 — text edit (strip_tag review op). Persisted the same way as other
     sentence edits so the corrected text survives reload. */
  'manuscript/setSentenceText': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },
  /* fs-58 Unit B — exclude flag (flag_nonstory review op). Persisted the same
     way as other sentence edits so the exclusion survives reload and is visible
     to the generation pipeline via manuscript-edits.json. */
  'manuscript/setSentenceExcluded': {
    slice: 'manuscript',
    build: (s) => ({ sentences: s.manuscript.sentences, mergedAwayKeys: s.manuscript.mergedAwayKeys }),
  },

  /* Editorial audit trail. Persists the whole `events` array on every
     append — the log is small (one entry per user action) and the server
     route writes the file atomically, so a full rewrite stays cheap. The
     boundary-move aggregator and the reparse wipe both mutate the same
     array, so they share the persistence rule. */
  'changeLog/appendLogEvent': {
    slice: 'changeLog',
    build: (s) => ({ events: s.changeLog.events }),
  },
  'changeLog/bumpBoundaryMove': {
    slice: 'changeLog',
    build: (s) => ({ events: s.changeLog.events }),
  },
  'changeLog/wipeBookShapeEvents': {
    slice: 'changeLog',
    build: (s) => ({ events: s.changeLog.events }),
  },

  'ui/confirmCast': { slice: 'state', build: () => ({ castConfirmed: true }) },

  /* Listen-view metadata editor. Persists the full editable snapshot for the
     currently-open book in a single state-slice PUT, so any field the user
     touched (title / author / series / narratorCredit / genre /
     publicationDate / description / notes) round-trips through state.json.
     The slice's commitDraft folds the draft into saved[bookId] before we
     run, so this read sees the post-commit values. */
  'bookMeta/commitDraft': {
    slice: 'state',
    build: (s) => {
      const bookId = bookIdFromState(s);
      const saved = bookId ? s.bookMeta.saved[bookId] : null;
      if (!saved) return {};
      return {
        title: saved.title,
        author: saved.author,
        series: saved.series,
        narratorCredit: saved.narratorCredit,
        genre: saved.genre,
        publicationDate: saved.publicationDate,
        description: saved.description,
        notes: saved.notes,
      };
    },
  },

};

/* The title `bookId` has on disk, for a toast that can fire after the user left
   it. `lastCommitted` holds the server-accepted baseline while a rename is
   unsaved (`saved` already carries the new, unsaved title then); `saved` is only
   seeded by a full read, so a fresh book on analysing/confirm falls back to its
   library entry. */
function savedTitleOf(s: PersistableRootState, bookId: string): string | undefined {
  return (
    s.bookMeta?.lastCommitted?.[bookId]?.saved?.title ??
    s.bookMeta?.saved?.[bookId]?.title ??
    s.library?.books?.find((b) => b.bookId === bookId)?.title
  );
}

/* Rules whose patch is keyed by the book itself, not by the loaded slices.
   `bookMeta.saved` is a Record<bookId, …> and commitDraft's build indexes it
   with the stage's book, so it can never carry another book's content. Gating
   it would drop a correct edit and leave the optimistic `saved[A]` /
   `lastCommitted` snapshot (#2230) claiming a save that never happened. */
const BOOK_KEYED_RULES = new Set(['bookMeta/commitDraft']);

/* Persisted action types, exported for tests only so a regression suite can
   loop over every rule (including ones added later). */
export const PERSISTED_ACTION_TYPES = Object.keys(PERSIST_RULES);

function bookIdFromState(s: PersistableRootState): string | null {
  const stage = s.ui.stage as { bookId?: string };
  return stage.bookId ?? null;
}

/* S4 (#3395 pass 4) — the debounce/flush maps below are keyed by this
   composite `${bookId}:${slice}` key, not bare `slice`. Keying by slice alone
   meant a write scheduled for book A shared its timer/pending-patch/generation
   slots with a same-slice write for book B: opening B within A's debounce
   window canceled A's queued timer and clobbered its pending patch, so only
   B's PUT ever went out and A's edit was silently lost. Composite keys give
   each book's queued write its own independent slot, so it flushes to its own
   book regardless of what other books do in the meantime. */
type FlushKey = string;
function flushKey(bookId: string, slice: StateSlice): FlushKey {
  return `${bookId}:${slice}`;
}

/* #3395 pass 4, S3 — dispatched by Layout's per-book hydrate before it re-reads a
   book's disk state. The middleware sends that book's queued writes now; the
   promise returned settles once each has landed, been given up on after the
   retries (#3421, already toasted) or been held for the read (#3784 P1), with the
   slices that failed — `null` when nothing was sent — so the re-read never sees
   disk from before a write that LANDED. A given-up save is kept and re-sent first
   by the book's next flush (a chapter restructure waits for it) until
   `dropRetainedSaves`. Plan 286 — revisions never persists from the client. */
/* #3421 — what `flushBookPersistence` resolves with: the slices whose write was
   given up on. Empty when every write landed. */
export interface BookFlushOutcome {
  failedSlices: StateSlice[];
}
/* #3421 — gaps before each resend of a failed book-state PUT: 3 resends after
   the first attempt, sent at about 0 s, 1 s, 3 s and 7 s. Precedent: the
   per-book hydrate's doubling backoff from 1 s (layout.tsx
   REVISIONS_HYDRATE_RETRY_BASE_MS) and the bounded reconnect loop (api.ts
   RECONNECT_MAX_ATTEMPTS / RECONNECT_BACKOFF_MS). Bounded, unlike the
   hydrate's, because a flush has a waiter (the re-read) that must eventually
   run. */
const FLUSH_RETRY_DELAYS_MS = [1000, 2000, 4000];
/* A 4xx is a deliberate refusal (analysis running, path collision, consent);
   it will not change in seven seconds, so it is never re-sent. */
const PUT_REFUSED_RE = /^Book state PUT failed \(4\d\d\)/;
const FLUSH_FAILED_MESSAGE =
  "Some changes to this book couldn't be saved. Check your connection and try again.";
const flushFailedMessage = (title: string) =>
  `Couldn't save your changes to "${title}". Check your connection and try again.`;
/* Plan 289 (D2) — a stale refusal's toast. Never "check your connection": the
   server answered, and the book is being re-read. */
const STALE_MESSAGE =
  "Some changes to this book weren't saved: it was changed elsewhere since you made them.";
const staleMessage = (title: string) =>
  `Your changes to "${title}" weren't saved: the book was changed elsewhere since you made them.`;

const FLUSH_BOOK = 'persistence/flushBook';
export const flushBookPersistence = (bookId: string) => ({ type: FLUSH_BOOK, payload: bookId });

/* #3421 — forget the saves of `bookId` that were given up on. Dispatched where
   that book's slices are re-read in full (Layout's full hydrate, `onFullRead`:
   the user has seen the failure and the revert; a save held for the read, or
   one with a base, stays, as the server refuses it if the book moved: #3784
   P1, P2) and when the book is deleted (hygiene). A re-parse or a manuscript replace
   drops nothing: it rotates the book's edit epoch, so the server refuses every
   kept save (plan 289, D8b). Touches only the kept saves — a newer edit
   already queued for the book is untouched. Not a reducer action. */
const DROP_RETAINED = 'persistence/dropRetained';
export const dropRetainedSaves = (bookId: string, onFullRead = false) => ({ type: DROP_RETAINED, payload: bookId, onFullRead });

/* Plan 289 (D6) — a re-sent save carries the revision it was built against, so
   the server can refuse it if the book changed since. The middleware learns
   each field's token from its own PUT 200s that carried the field and from
   Layout's FULL reads (a revisions-only read re-seeds none of these slices, so
   it teaches nothing). Layout stamps a full read before issuing it: the
   dispatch returns the read's sequence number, and its later
   `learnSliceRevisions` is ignored for a field a PUT has landed on since,
   because the read may predate that write (pass 7, C4). Not reducer actions. */
const BEGIN_FULL_READ = 'persistence/beginFullRead';
export const beginFullRead = (bookId: string) => ({ type: BEGIN_FULL_READ, payload: bookId });
const LEARN_REVISIONS = 'persistence/learnRevisions';
export const learnSliceRevisions = (
  bookId: string,
  revisions: Partial<Record<StateSlice, SliceRevision>> | undefined,
  readSeq: number,
) => ({ type: LEARN_REVISIONS, payload: { bookId, revisions, readSeq } });
const LEARNED_SLICES: StateSlice[] = ['state', 'cast', 'manuscript', 'changeLog'];

/* Plan 289 pass 7 (C1) — a whole-slice build is one outbox unit. */
const WHOLE = '*';

export const persistenceMiddleware: Middleware = (store) => {
  /* Plan 289 pass 7 (C1) — what is still to be saved, per `${bookId}:${slice}`
     key: one entry per field on the partial `state` slice, and ONE entry for
     the whole build (`WHOLE`) on cast, manuscript and changeLog, whose PUT
     replaces the file — a manuscript send without `mergedAwayKeys` would wipe
     the merge tombstones (fs-58). `base` is the revision a failed send of the
     value was made against (C3); `handler` owns the unit's failure toast,
     rollback and success prune. A KEPT save is a key's idle outbox: entries,
     but no debounce timer and no flight (C7). */
  type Entry = { value: unknown; base?: SliceRevision; handler?: PersistFailureHandler };
  const outbox = new Map<FlushKey, Map<string, Entry>>();
  const boxOf = (key: FlushKey) => {
    let box = outbox.get(key);
    if (!box) outbox.set(key, (box = new Map()));
    return box;
  };
  const timers = new Map<FlushKey, ReturnType<typeof setTimeout>>();
  /* C2 — each key's one running send loop, so at most one PUT per key is in
     transit, and `flushBookPersistence` can await it. Settles, never rejects. */
  const flights = new Map<FlushKey, Promise<{ slice: StateSlice; ok: boolean }>>();
  /* Plan 289 (D6, C4) — each key's last-known token per field, learned from the
     fields a PUT 200 carried and from full reads (see `beginFullRead`). An
     absent field is unknown: a failed send of it stays unconditional. */
  const known = new Map<FlushKey, SliceRevision>();
  /* Per field, the `clock` reading of the latest PUT 200 that carried it; a full
     read stamped before that teaches nothing for the field. */
  const landedAt = new Map<FlushKey, Record<string, number>>();
  let clock = 0;
  const waiting = new Set<FlushKey>(); // #3784 P1: `state` keys held for their marked book's full read
  const marked = (id: string) => !!(store.getState() as PersistableRootState).bookMeta?.needsFullRead?.[id];

  /* The token fields a unit's value carries: its own name on `state`, the
     build's defined fields on a whole-slice unit. An undefined value is not
     sent (JSON drops it), so it carries nothing. */
  const fieldsOf = (unit: string, value: unknown): string[] =>
    value === undefined
      ? []
      : unit !== WHOLE
        ? [unit]
        : Object.keys(value as object).filter((f) => (value as Record<string, unknown>)[f] !== undefined);
  const toast = (message: string, dedupeKey: string) =>
    store.dispatch(notificationsActions.pushToast({ kind: 'error', message, dedupeKey }));

  /* The book the stage named after the previous action — when it changes,
     that book's queued writes are sent at once (S3). */
  let lastBookId: string | null = bookIdFromState(store.getState() as PersistableRootState);

  /* #3754 / #3624 — the last NON-NULL book the stage named, for the metadata
     draft clear in the handler below. Unlike `lastBookId` (S3), a trip to the
     library never nulls this, so B -> home -> B still reads as the same book
     and keeps the user's unsaved draft. */
  let lastOpenBookId: string | null = bookIdFromState(store.getState() as PersistableRootState);

  /* C2 — start a key's flight: only a debounce timer, a book flush or a held save's
     release (P1); never a flight's own end, so a give-up cannot restart itself. */
  const pump = (bookId: string, slice: StateSlice) => {
    const key = flushKey(bookId, slice);
    if (flights.has(key) || !outbox.get(key)?.size || (slice === 'state' && marked(bookId) && waiting.add(key))) return;
    flights.set(key, run(bookId, slice));
  };
  /* C7 — send the book's kept saves (idle keys), in slice order. */
  const pumpKept = (bookId: string) => {
    for (const slice of LEARNED_SLICES) {
      const key = flushKey(bookId, slice);
      if (outbox.get(key)?.size && !timers.has(key) && !flights.has(key)) pump(bookId, slice);
    }
  };
  /* Send every queued write for `bookId` now instead of at the end of its
     debounce, kept saves first. A running flight carries what is queued on its
     next attempt or its follow-up. */
  const flushBookNow = (bookId: string) => {
    pumpKept(bookId);
    for (const slice of LEARNED_SLICES) {
      const key = flushKey(bookId, slice);
      const timer = timers.get(key);
      if (!timer) continue;
      clearTimeout(timer);
      timers.delete(key);
      pump(bookId, slice);
    }
  };

  /* C2 / C5 / C6 — one key's send loop. Each attempt re-snapshots the outbox,
     so a value built meanwhile rides it; after a server answer, what is left goes
     at once unless a debounce timer is pending (it sends it: typing coalesces) or
     P1 holds it. A network / 5xx failure is retried at +1 s, +2 s, +4 s, then given up on. */
  const run = async (bookId: string, slice: StateSlice): Promise<{ slice: StateSlice; ok: boolean }> => {
    const key = flushKey(bookId, slice);
    const box = boxOf(key);
    let failures = 0;
    let ok = true;
    for (;;) {
      if (slice === 'state' && marked(bookId) && waiting.add(key)) break; // P1: a retry or follow-up too
      const sent = new Map(Array.from(box, ([u, e]) => [u, { value: e.value, based: !!e.base, handler: e.handler }]));
      const base: SliceRevision = Object.assign({}, ...Array.from(box.values(), (e) => e.base));
      const knownAtSend = { ...known.get(key) };
      const patch =
        slice === 'state'
          ? Object.fromEntries(Array.from(sent).flatMap(([u, s]) => (s.value === undefined ? [] : [[u, s.value]])))
          : sent.get(WHOLE)?.value;
      /* "Holds the sent value": no newer build replaced the unit meanwhile. */
      const holds = (u: string) => box.has(u) && Object.is(box.get(u)!.value, sent.get(u)?.value);
      try {
        const res = (await api.putBookState(
          bookId,
          Object.keys(base).length > 0 ? { slice, patch, baseRevision: base } : { slice, patch },
        )) as PutStateResponse | undefined;
        failures = 0;
        /* C4 — learn only the fields this request carried: the revision also
           covers fields it did not write, which may hold an outside write the
           screen never showed (R1). A 200 with no revision (an older server)
           leaves them unknown. The units still holding the sent value are
           saved; a book-meta commit's rollback baseline is pruned once no
           entry of that handler is left (#2230, N7). */
        const tick = ++clock;
        const kn = { ...known.get(key) };
        const la = landedAt.get(key) ?? {};
        const saved = new Set<PersistFailureHandler>();
        for (const [u, s] of sent) {
          for (const f of fieldsOf(u, s.value)) {
            la[f] = tick;
            if (res?.revision?.[f] !== undefined) kn[f] = res.revision[f];
            else delete kn[f];
          }
          if (!holds(u)) continue;
          const h = box.get(u)!.handler;
          if (h?.onSuccess) saved.add(h);
          box.delete(u);
        }
        known.set(key, kn);
        landedAt.set(key, la);
        for (const h of saved) {
          if (!Array.from(box.values()).some((e) => e.handler === h)) store.dispatch(h.onSuccess!(bookId));
        }
      } catch (err) {
        console.error(`[persist] PUT /api/books/${bookId}/state slice=${slice} failed`, err);
        if (isStaleRefusal(err)) {
          /* Plan 289 (D2, C6) — the server wrote nothing: a field it names was
             changed elsewhere since this unit's base. Only a based unit can be
             stale; a missing or useless `fields` reads as every based unit.
             A refused unit is dropped (a 4xx is final), not rolled back (the
             baseline is older than disk). The book is marked for a full re-read
             (Layout re-reads it now if open), with one toast naming it. A unit a
             newer build replaced is left to that value: no toast, no re-read
             (P6-3, OD-C3). Every other unit follows with its base, after the read (P1). */
          failures = 0;
          const named = (err as { fields?: unknown }).fields;
          const based = Array.from(sent.keys()).filter((u) => sent.get(u)!.based);
          const hit = based.filter(
            (u) => Array.isArray(named) && fieldsOf(u, sent.get(u)!.value).some((f) => named.includes(f)),
          );
          /* No unit carried a base (the server cannot send this): the refusal is
             final for the whole send, or the same send would repeat forever. */
          const dropped = (hit.length > 0 ? hit : based.length > 0 ? based : Array.from(sent.keys())).filter(holds);
          if (dropped.length > 0) {
            const handler = dropped.map((u) => box.get(u)!.handler).find(Boolean);
            for (const u of dropped) box.delete(u);
            const title = savedTitleOf(store.getState() as PersistableRootState, bookId);
            toast(
              handler ? handler.message(err, title) : title ? staleMessage(title) : STALE_MESSAGE,
              `book-persist-stale:${bookId}`,
            );
            store.dispatch(bookMetaActions.markNeedsFullRead({ bookId, refused: slice === 'state' ? dropped : [] }));
            ok = false;
          }
        } else if (PUT_REFUSED_RE.test(err instanceof Error ? err.message : String(err))) {
          /* A deliberate refusal (analysis running, path collision, consent): it
             will not change on a re-send. A book-meta commit whose entries all
             still hold their sent values is rolled back, restoring the draft
             only while its book is open (P6-1, #3782); if a newer commit is
             queued, that one owns the outcome. A unit with no rollback handler
             that rode along stays, and goes in the follow-up (R2). A send with
             no rollback handler is dropped, toasting only a toast handler's
             message (bulk reassign). */
          failures = 0;
          const bookOpen = bookIdFromState(store.getState() as PersistableRootState) === bookId;
          const rollbacks = new Set(Array.from(sent.values(), (s) => s.handler).filter((h) => h?.rollback));
          if (rollbacks.size === 0) {
            const dropped = Array.from(sent.keys()).filter(holds);
            const handler = dropped.map((u) => box.get(u)!.handler).find(Boolean);
            for (const u of dropped) box.delete(u);
            if (handler) toast(handler.message(err), handler.dedupeKey);
            if (dropped.length > 0) ok = false;
          }
          for (const h of rollbacks) {
            const owned = Array.from(box).flatMap(([u, e]) => (e.handler === h ? [u] : []));
            if (!owned.every(holds)) continue;
            for (const u of owned) box.delete(u);
            toast(h!.message(err), h!.dedupeKey);
            store.dispatch(h!.rollback!(bookId, bookOpen));
            ok = false;
          }
        } else {
          /* C3 — a re-send of a value is checked against the revision its first
             failed send was made against, so the server refuses it if the book
             moved on. A unit a newer build replaced is a live edit: no base. */
          for (const [u, s] of sent) {
            const e = box.get(u);
            if (!e || e.base || !holds(u)) continue;
            const b = Object.fromEntries(
              fieldsOf(u, s.value).flatMap((f) => (knownAtSend[f] === undefined ? [] : [[f, knownAtSend[f]]])),
            );
            if (Object.keys(b).length > 0) e.base = b;
          }
          if (++failures <= FLUSH_RETRY_DELAYS_MS.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_RETRY_DELAYS_MS[failures - 1]));
            continue;
          }
          /* Given up on (#3421): the units stay, kept for the book's next
             flush. The rollback restores a shared, book-agnostic draft, and the
             retry window lets the user open another book first, so it only runs
             while this book is open; after leaving, a book-meta save is kept
             and re-sent too (f8871b1a). The toast fires seconds after the user
             may have left, so it names the book. */
          const s = store.getState() as PersistableRootState;
          const title = savedTitleOf(s, bookId);
          const handler = Array.from(sent.values(), (x) => x.handler).find(Boolean);
          toast(
            handler ? handler.message(err, title) : title ? flushFailedMessage(title) : FLUSH_FAILED_MESSAGE,
            handler?.dedupeKey ?? `book-persist-failed:${bookId}`,
          );
          if (bookIdFromState(s) === bookId) {
            for (const h of new Set(Array.from(sent.values(), (x) => x.handler))) {
              if (!h?.rollback) continue;
              for (const [u, e] of Array.from(box)) if (e.handler === h) box.delete(u);
              store.dispatch(h.rollback(bookId, true));
            }
          }
          ok = false;
          break;
        }
      }
      if (box.size === 0 || timers.has(key)) break;
    }
    flights.delete(key);
    if (box.size === 0 && outbox.get(key) === box) outbox.delete(key);
    return { slice, ok };
  };

  return (next) => (action) => {
    const typed = (store.getState() as PersistableRootState).bookMeta?.lastCommitted; // P1, before a hydrate wipes it
    const result = next(action);
    const a = action as { type?: string; payload?: unknown };
    const type = a?.type;
    if (!type) return result;

    const after = store.getState() as PersistableRootState;
    const bookId = bookIdFromState(after);
    /* S3 — scope moved off a book: send its queued writes now, so a quick
       return re-reads disk that already has them (and the re-read awaits
       any still in flight via FLUSH_BOOK below). */
    if (lastBookId !== bookId) {
      if (lastBookId) flushBookNow(lastBookId);
      lastBookId = bookId;
    }

    if (type === BEGIN_FULL_READ) return ++clock;

    if (type === LEARN_REVISIONS) {
      const { bookId: readBook, revisions, readSeq } = a.payload as {
        bookId: string;
        revisions?: Partial<Record<StateSlice, SliceRevision>>;
        readSeq: number;
      };
      /* C4 — every field the read covers, except one a PUT landed on since the
         read was stamped. */
      for (const slice of LEARNED_SLICES) {
        const key = flushKey(readBook, slice);
        const la = landedAt.get(key) ?? {};
        const kn = { ...known.get(key) };
        for (const f of new Set([...Object.keys(kn), ...Object.keys(revisions?.[slice] ?? {})])) {
          if ((la[f] ?? 0) > readSeq) continue;
          const token = revisions?.[slice]?.[f];
          if (token !== undefined) kn[f] = token;
          else delete kn[f];
        }
        known.set(key, kn);
      }
      return result;
    }

    if (type === DROP_RETAINED && typeof a.payload === 'string') {
      for (const slice of LEARNED_SLICES) {
        const key = flushKey(a.payload, slice);
        const onRead = (a as { onFullRead?: boolean }).onFullRead;
        if (timers.has(key) || flights.has(key) || (onRead && waiting.has(key))) continue;
        for (const [u, e] of outbox.get(key) ?? []) if (!(onRead && e.base)) outbox.get(key)!.delete(u);
      }
      return result;
    }

    /* #3754 / #3624 — the unsaved Listen-view metadata draft belongs to the
       book it was typed on. Opening a DIFFERENT book clears it: the draft is
       global (not keyed per book), so left alone it would fold into the
       newly-opened book's `saved` on the next commitDraft — and the #3748
       gate deliberately exempts commitDraft (its build reads the per-book
       `saved[stageBookId]`), so nothing else stops that. It clears only on a
       switch to a different book, not when leaving for the library or
       returning to the same one (B -> home -> B keeps the user's typing), and
       it cannot use `lastBookId` because S3 above nulls that on the library —
       hence the separate `lastOpenBookId`, which only ever holds a book. */
    if (
      bookId !== null &&
      lastOpenBookId !== null &&
      bookId !== lastOpenBookId &&
      Object.keys(after.bookMeta?.draft ?? {}).length > 0
    ) {
      store.dispatch(bookMetaActions.cancelDraft());
    }
    if (bookId !== null) lastOpenBookId = bookId;

    if (type === FLUSH_BOOK && typeof a.payload === 'string') {
      const target = a.payload;
      flushBookNow(target);
      const waits = LEARNED_SLICES.flatMap((slice) => flights.get(flushKey(target, slice)) ?? []);
      return waits.length > 0
        ? Promise.all(waits).then(
            (rs): BookFlushOutcome => ({
              failedSlices: rs.filter((r) => !r.ok).map((r) => r.slice),
            }),
          )
        : null;
    }

    /* P1 — the full read a held save waited for has hydrated (a failed read
       keeps it held; Layout retries the read until it lands). Its unbased
       book-meta entries are rebuilt by re-committing the user's typed fields on
       the read's values, so a value refused as stale is never re-sent; based
       entries go as they are, for the server to judge. */
    const hid = type === bookMetaActions.hydrateFromBookState.type ? (a.payload as { bookId: string }).bookId : '';
    if (!marked(hid) && waiting.delete(flushKey(hid, 'state'))) {
      const box = boxOf(flushKey(hid, 'state'));
      const draft = typed?.[hid]?.draft ?? {};
      const redo = Array.from(box).flatMap(([u, e]) => (!e.base && e.handler?.rollback && box.delete(u) ? [u] : []));
      const retyped = bookId === hid ? redo.filter((u): u is EditableBookMetaField => u in draft) : [];
      retyped.forEach((field) => store.dispatch(bookMetaActions.setDraftField({ field, value: draft[field] ?? null })));
      if (retyped.length > 0) store.dispatch(bookMetaActions.commitDraft({ bookId: hid })); else pump(hid, 'state');
      return result;
    }

    const rule = PERSIST_RULES[type];
    if (!rule) return result;
    if (!bookId) return result;

    /* #3624 — the patch is built from the slices as they are RIGHT NOW, but
       the target comes from the stage. Between `openBook(A)` and A's hydrate
       the stage says A while cast / manuscript / changeLog still hold B, so an
       edit here would write B's content into A's files. `manuscript.bookId` is
       the loaded-book identity (cast and changeLog hydrate in the same tick, so
       it stands in for them — same proxy as preview-thunks, #3594). Drop the
       write silently. A null identity records no other book, so it persists. */
    const held = after.manuscript?.bookId ?? null;
    if (held !== null && held !== bookId && !BOOK_KEYED_RULES.has(type)) {
      console.warn(
        `[persist] dropped ${type}: slices hold book ${held}, stage is ${bookId} (#3624)`,
      );
      return result;
    }

    const key = flushKey(bookId, rule.slice);
    const built = rule.build(after, bookId) as Record<string, unknown>;
    /* C1 — merge the build into the outbox, newest value per unit. A changed
       unit is a live edit: it replaces the entry with no base. An unchanged
       one keeps its entry, base included — `commitDraft` re-sends all eight
       book-meta fields, and a notes-only commit must not strip a kept title's
       base. `confirmCast` and `commitDraft` thereby combine (#3784). The
       failure handler is sticky: a bulk reassignment still unsent owns the
       unit's toast even when a plain edit rode along. */
    const box = boxOf(key);
    const handler = TOAST_ON_PERSIST_FAILURE[type];
    const units: [string, unknown][] = rule.slice === 'state' ? Object.entries(built) : [[WHOLE, built]];
    for (const [unit, value] of units) {
      const prev = box.get(unit);
      const same =
        !!prev &&
        (unit === WHOLE
          ? Object.keys(built).every((f) => Object.is((prev.value as Record<string, unknown>)[f], built[f]))
          : Object.is(prev.value, value));
      box.set(unit, same ? { ...prev!, handler: handler ?? prev!.handler } : { value, handler: handler ?? prev?.handler });
    }
    /* C2 — a timer that fires sends the book's kept saves first, then this key;
       while the key's flight runs it does nothing, and the flight's own end
       sends what is queued. */
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    timers.set(
      key,
      setTimeout(() => {
        pumpKept(bookId);
        timers.delete(key);
        pump(bookId, rule.slice);
      }, debounceMs(after)),
    );
    return result;
  };
};
