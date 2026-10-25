/* Per-slice persistence middleware.

   Watches a curated set of action types that represent user edits and
   debounces a PUT /api/books/:bookId/state for the touched slice. Each
   (book, slice) pair has its own debounce window so an edit to cast doesn't
   delay a write to the manuscript, and one book's write never cancels another's.
   Leaving a book sends its queued writes at once (#3395 pass 4, S3).

   Skipped when no bookId is in scope (library browsing, fresh upload
   before confirm). Under VITE_USE_MOCKS, PUTs still flow — the mock api
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
import { bookMetaActions } from './book-meta-slice';

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
      optimistic local update. Returns the action to dispatch. */
  rollback?: (bookId: string) => { type: string };
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
    rollback: (bookId) => bookMetaActions.rollbackCommitDraft({ bookId }),
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

/* #3395 pass 4, S3 — dispatched by Layout's per-book hydrate before it
   re-reads a book's disk state. The middleware sends that book's queued
   writes now and the dispatch returns a promise that settles once every
   write for the book has landed or been given up on after the retries
   (#3421), or `null` when nothing is queued or in flight — so the re-read
   never sees disk from before a write that LANDED. It resolves with the
   slices that still failed; a write that was given up on has already raised
   a toast. A given-up save is kept and re-sent first by the book's next
   flush (#3421), so this promise also covers that re-send, and a chapter
   restructure waits for it. It is let go (`dropRetainedSaves`) once the book's
   slices are re-read from disk or wiped. Plan 286 — revisions
   no longer persists from the client, so the write-then-re-read hazard this
   describes now applies only to the other slices.
   Not a reducer action: no slice handles it. */
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
   that book's slices are re-read from disk or wiped (Layout's full hydrate, a
   re-parse, a manuscript replace, a delete): the user has seen the failure and
   the revert, so a kept save landing later would contradict what they see (or
   re-send a pre-reparse roster). Touches only the kept and parked (superseded)
   saves — a newer edit already queued for the book is untouched. Only a wipe's
   own success passes `{ wipeSettled: true }`, which also ends that wipe's
   pending count (see `restoreSupersededSaves`); Layout's re-read drops plain,
   since it never started a wipe and must not settle one. Not a reducer action. */
const DROP_RETAINED = 'persistence/dropRetained';
export const dropRetainedSaves = (bookId: string, opts?: { wipeSettled?: boolean }) => ({
  type: DROP_RETAINED,
  payload: bookId,
  wipeSettled: opts?.wipeSettled === true,
});

/* #3421 — cancel everything of `bookId` that has not landed yet, ahead of a
   destructive server call (re-parse, manuscript replace, delete): its kept
   saves, its debounced writes, and any send-and-retry sequence already running
   (which would otherwise PUT the pre-wipe roster into the wiped book seconds
   later). Unlike `dropRetainedSaves` it bumps the generation, so a running
   sequence reads as superseded: it ends quietly, with no toast, exactly as when
   a newer write overtakes it. What it cancels is PARKED, not discarded: the
   call may fail and leave the book untouched, so the handler either lets go of
   the parked saves on success (`dropRetainedSaves`) or gives them back with
   `restoreSupersededSaves`. Layout's re-read must NOT use this — it would
   cancel a newer edit. Not a reducer action. */
const SUPERSEDE_BOOK = 'persistence/supersedeBook';
export const supersedeBookSaves = (bookId: string) => ({ type: SUPERSEDE_BOOK, payload: bookId });

/* #3421 — the wipe call failed: move what `supersedeBookSaves` parked back into
   the kept saves, minus the fields a write made since the park carried, so the
   book's next flush re-sends only what is still owed.
   Not a reducer action. */
const RESTORE_SUPERSEDED = 'persistence/restoreSuperseded';
export const restoreSupersededSaves = (bookId: string) => ({
  type: RESTORE_SUPERSEDED,
  payload: bookId,
});

/* Plan 289 (D6) — a re-sent save carries the revision it was built against, so
   the server can refuse it if the book changed since. The middleware learns
   each slice's revision from its own PUT 200s and from Layout's FULL reads
   (a revisions-only read re-seeds none of these slices, so it teaches
   nothing). Layout stamps a full read before issuing it: the dispatch returns
   the read's sequence number, and its later `learnSliceRevisions` is ignored
   for a slice a PUT has landed on since, because the read may predate that
   write. Not reducer actions. */
const BEGIN_FULL_READ = 'persistence/beginFullRead';
export const beginFullRead = (bookId: string) => ({ type: BEGIN_FULL_READ, payload: bookId });
const LEARN_REVISIONS = 'persistence/learnRevisions';
export const learnSliceRevisions = (
  bookId: string,
  revisions: Partial<Record<StateSlice, SliceRevision>> | undefined,
  readSeq: number,
) => ({ type: LEARN_REVISIONS, payload: { bookId, revisions, readSeq } });
const LEARNED_SLICES: StateSlice[] = ['state', 'cast', 'manuscript', 'changeLog'];

export const persistenceMiddleware: Middleware = (store) => {
  const timers = new Map<FlushKey, ReturnType<typeof setTimeout>>();
  const pending = new Map<FlushKey, unknown>();
  /* Slices whose currently-pending write was (at least once this debounce
     window) triggered by a toast-worthy action. Last-wins on the patch means
     the flush persists the latest slice state regardless, so if it fails that
     action didn't land — toasting with the matching handler is correct even if
     an unrelated edit also rode along in the same window. Carries the handler
     so the toast text can be per-action (bulk-reassign copy vs the server's own
     refused-rename sentence) and any rollback can fire. */
  const toastPending = new Map<FlushKey, PersistFailureHandler>();
  /* #2230 — monotonically-increasing counter per key, bumped every time a
     write is (re)scheduled. A flush captures the counter at fire time; its
     success/failure effects (snapshot prune / rollback / toast) only run if it
     is still the LATEST flush for the key. This prevents an OLDER in-flight
     PUT from prematurely pruning or rolling back the shared rollback snapshot
     that a NEWER in-flight PUT (started while the first was still pending) still
     needs — closing the overlapping-in-flight-PUT data-loss race. */
  const generation = new Map<FlushKey, number>();
  /* #3395 pass 4, S3 — each key's writes still in flight, as settle-never-
     reject promises, so `flushBookPersistence` can await them. Each entry
     covers a whole send-and-retry sequence (#3421), not one PUT. */
  const inFlight = new Map<FlushKey, Set<Promise<{ slice: StateSlice; ok: boolean }>>>();
  /* #3421 — saves given up on after their retries, kept until the next flush of
     their book re-sends them first, or until that book's slices are re-read
     from disk or wiped (`dropRetainedSaves`). A newer edit for the same key
     merges over the kept patch when it is queued.
     Plan 289 — each record carries the revision its write was built against
     (`base`), which every re-send of it sends, and the success handler (D8a),
     so a re-send that lands clears the rollback snapshot like a first-try
     success would. Only `onSuccess` is kept: a re-send that fails again
     behaves as a plain kept save, not a rename. */
  type KeptSave = {
    patch: Record<string, unknown>;
    base?: SliceRevision;
    onSuccess?: PersistFailureHandler['onSuccess'];
  };
  const kept = new Map<FlushKey, KeptSave>();
  /* Plan 289 (D6) — the kept save a queued patch carries (re-sent as it is, or
     merged into a newer build), so that send carries the kept base: without
     it, the merge would carry the kept fields past the server's check. Taken
     by the key's next `flush`; a later build of the key that replaces the
     queued patch keeps it, since that build is made from a screen that still
     shows the kept edit. */
  const carriedKept = new Map<FlushKey, KeptSave>();
  /* Plan 289 (D6) — each key's last-known revision, learned from PUT 200s and
     full reads (see `beginFullRead`). Absent = unknown: the send is
     unconditional. */
  const known = new Map<FlushKey, SliceRevision>();
  /* The `clock` reading of the key's latest PUT 200; a full read stamped
     before it teaches nothing for the key. */
  const landedAt = new Map<FlushKey, number>();
  let clock = 0;
  /* Plan 289 (D6) — every running send-and-retry sequence's generation and
     base. An older sequence's 200 replaces the base of the newer ones, whose
     patches were built after it and already include it. */
  type Sequence = { gen: number; base?: SliceRevision; refreshable: boolean };
  const sequences = new Map<FlushKey, Set<Sequence>>();
  /* #3421 — the generation the kept save's write was made at. */
  const retainedGen = new Map<FlushKey, number>();
  /* #3421 — a send-and-retry sequence's captured patch (and success handler)
     while it runs, so `supersedeBookSaves` can park what it is still sending. */
  type SavedPatch = {
    patch: Record<string, unknown>;
    onSuccess?: PersistFailureHandler['onSuccess'];
    /* The `generation` its write was made at; orders the layers of a park. */
    gen?: number;
    /* Plan 289 — the revision it was built against (see `kept`); a running
       sequence's lives on its `seq`, which a landed older write can refresh. */
    base?: SliceRevision;
    seq?: Sequence;
  };
  const sending = new Map<FlushKey, Set<SavedPatch>>();
  /* #3421 — what `supersedeBookSaves` cancelled, until the wipe call resolves
     (`dropRetainedSaves`) or fails (`restoreSupersededSaves`). */
  const parked = new Map<
    FlushKey,
    SavedPatch & { newerFields: Set<string>; landedFields: Set<string> }
  >();
  /* #3421 S4 — wipes of a book still running. The parked saves are shared, so
     only the last wipe to fail gives them back; one that succeeded dropped them.
     Only a wipe's own outcome (a `wipeSettled` drop or a restore) decrements. */
  const pendingWipes = new Map<string, number>();
  const endWipe = (bookId: string) => {
    const left = Math.max(0, (pendingWipes.get(bookId) ?? 0) - 1);
    if (left > 0) pendingWipes.set(bookId, left);
    else pendingWipes.delete(bookId);
    return left;
  };
  /* The book the stage named after the previous action — when it changes,
     that book's queued writes are sent at once (S3). */
  let lastBookId: string | null = bookIdFromState(store.getState() as PersistableRootState);

  /* Send every queued write for `bookId` now instead of at the end of its
     debounce. */
  const flushBookNow = (bookId: string) => {
    resendRetained(bookId);
    for (const [key, timer] of Array.from(timers)) {
      if (!key.startsWith(`${bookId}:`)) continue;
      clearTimeout(timer);
      flush(bookId, key.slice(bookId.length + 1) as StateSlice);
    }
  };

  /* #3421 — re-send, now, every save of `bookId` that was given up on, ahead
     of whatever the caller is about to send. Deleting from `kept` first
     keeps `flush` from re-entering for the same key; an entry the nested
     `flush` already sent is skipped, so each is sent once. */
  const resendRetained = (bookId: string, exceptKey?: FlushKey) => {
    for (const [key, save] of Array.from(kept)) {
      if (!key.startsWith(`${bookId}:`) || key === exceptKey) continue;
      /* The loop walks a snapshot, and the nested `flush` below has already
         re-sent (and deleted) the later entries of this book. */
      if (!kept.has(key)) continue;
      kept.delete(key);
      carriedKept.set(key, save);
      if (!pending.has(key)) pending.set(key, save.patch);
      const timer = timers.get(key);
      if (timer) clearTimeout(timer);
      flush(bookId, key.slice(bookId.length + 1) as StateSlice);
    }
  };

  const flush = (bookId: string, slice: StateSlice) => {
    const key = flushKey(bookId, slice);
    resendRetained(bookId, key);
    const patch = pending.get(key);
    pending.delete(key);
    timers.delete(key);
    const handler = toastPending.get(key);
    toastPending.delete(key);
    const carried = carriedKept.get(key);
    carriedKept.delete(key);
    const onSuccess = handler?.onSuccess ?? carried?.onSuccess;
    const gen = generation.get(key) ?? 0;
    if (patch === undefined) return;
    /* Plan 289 (D6) — the base is captured as the sequence's first attempt is
       made: the kept save's own base when this send carries one, else the
       key's last-known revision. Only a re-send carries it: every retry, and
       a send carrying a kept save even on its first attempt. A plain first
       attempt is a live edit built from the current screen, sent
       unconditionally as before. */
    const seq: Sequence = { gen, base: carried ? carried.base : known.get(key), refreshable: !carried };
    const seqs = sequences.get(key) ?? new Set<Sequence>();
    seqs.add(seq);
    sequences.set(key, seqs);
    const attemptSend = async (): Promise<{ slice: StateSlice; ok: boolean }> => {
      /* #3421 — a failed PUT is re-sent with the patch captured above, never
         one rebuilt from the store: by the time it fails the stage may name
         another book (or none). */
      for (let attempt = 0; ; attempt++) {
        try {
          const conditional = (attempt > 0 || !!carried) && seq.base !== undefined;
          const res = (await api.putBookState(
            bookId,
            conditional ? { slice, patch, baseRevision: seq.base } : { slice, patch },
          )) as PutStateResponse | undefined;
          /* Plan 289 (D6) — learn the slice's revision after this write. A
             200 with no revision (an older server) leaves it unknown. The
             newer running sequences of the key had their patch built after
             this one, so they include it: their base becomes this revision,
             or their retries would be refused for this very write. A sequence
             carrying a kept save keeps the kept base, which must still refuse
             the kept fields if the book changed since they were made. */
          landedAt.set(key, ++clock);
          if (res?.revision) known.set(key, res.revision);
          else known.delete(key);
          for (const other of sequences.get(key) ?? []) {
            if (other.gen > gen && other.refreshable) other.base = res?.revision;
          }
          /* #2230 — only the LATEST flush prunes the rollback snapshot. If a
             newer write has since been scheduled (gen advanced), a fresh snapshot
             belongs to it and must not be cleared by this older, superseded
             flush. */
          if (onSuccess && gen === (generation.get(key) ?? 0)) {
            store.dispatch(onSuccess(bookId));
          }
          /* #3421 — the server has these fields now; a restore must not re-send them. */
          const parkedHere = parked.get(key);
          if (parkedHere) for (const field of Object.keys(patch as object)) parkedHere.landedFields.add(field);
          return { slice, ok: true };
        } catch (err) {
          console.error(`[persist] PUT /api/books/${bookId}/state slice=${slice} failed`, err);
          const refused = PUT_REFUSED_RE.test(err instanceof Error ? err.message : String(err));
          const superseded = gen !== (generation.get(key) ?? 0);
          /* Plan 289 (D2) — the book changed since this save was made, so the
             server refused it and wrote nothing. It is not kept or re-sent
             (it is a 4xx), and not rolled back: the rollback baseline is older
             than disk, so restoring it would show the user neither value. The
             book is marked for a full re-read instead, so the screen shows what
             is on disk (Layout re-reads it now if it is open). The toast names
             the book, once per book, unless a newer write overtook this one. */
          if (isStaleRefusal(err)) {
            if (!superseded) {
              const title = savedTitleOf(store.getState() as PersistableRootState, bookId);
              store.dispatch(
                notificationsActions.pushToast({
                  kind: 'error',
                  message: handler
                    ? handler.message(err, title)
                    : title
                      ? staleMessage(title)
                      : STALE_MESSAGE,
                  dedupeKey: `book-persist-stale:${bookId}`,
                }),
              );
            }
            store.dispatch(bookMetaActions.markNeedsFullRead({ bookId }));
            return { slice, ok: superseded };
          }
          /* A newer full-slice write for this key owns the outcome (and the
             user's current draft); don't re-send the stale patch over it. */
          if (superseded) return { slice, ok: true };
          if (!refused && attempt < FLUSH_RETRY_DELAYS_MS.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_RETRY_DELAYS_MS[attempt]));
            if (gen !== (generation.get(key) ?? 0)) return { slice, ok: true };
            continue;
          }
          /* Final failure of the LATEST write (#2230). The rollback restores a
             shared, book-agnostic draft, and the retry window (#3421) lets the
             user open another book first — applying it then would overlay this
             book's text on that one, so it only runs while this book is open. */
          const rolledBack =
            !!handler?.rollback && bookIdFromState(store.getState() as PersistableRootState) === bookId;
          /* Keep the patch for the book's next flush (#3421) — except a 4xx
             (the server's answer, so re-sending repeats a refused write) and a
             save that rolled back (the user's draft is restored for them to
             save again). A save that gave up WITHOUT rolling back has no draft
             left, so it is kept and re-sent. */
          if (!refused && !rolledBack) {
            kept.set(key, { patch: patch as Record<string, unknown>, base: seq.base, onSuccess });
            retainedGen.set(key, gen);
          }
          if (handler) {
            const bookTitle = refused
              ? undefined
              : savedTitleOf(store.getState() as PersistableRootState, bookId);
            store.dispatch(
              notificationsActions.pushToast({
                kind: 'error',
                message: handler.message(err, bookTitle),
                dedupeKey: handler.dedupeKey,
              }),
            );
            /* #2230 — a refused rename must not leave the persisted value claiming
               a title the server rejected; roll the optimistic saved update back
               (and restore the draft so the user's text is preserved for retry). */
            if (rolledBack) store.dispatch(handler.rollback!(bookId));
          } else if (!refused) {
            /* Only a save that was retried and given up on (network / 5xx) gets
               the generic toast; a 4xx is the server's deliberate refusal, which
               stayed silent before #3421. It fires seconds after the user may
               have left, so it names the book rather than saying "this book". */
            const title = savedTitleOf(store.getState() as PersistableRootState, bookId);
            store.dispatch(
              notificationsActions.pushToast({
                kind: 'error',
                message: title ? flushFailedMessage(title) : FLUSH_FAILED_MESSAGE,
                dedupeKey: `book-persist-failed:${bookId}`,
              }),
            );
          }
          return { slice, ok: false };
        }
      }
    };
    const mine: SavedPatch = { patch: patch as Record<string, unknown>, onSuccess, gen, seq };
    const mineSet = sending.get(key) ?? new Set<SavedPatch>();
    mineSet.add(mine);
    sending.set(key, mineSet);
    const settled = attemptSend();
    const set = inFlight.get(key) ?? new Set<Promise<{ slice: StateSlice; ok: boolean }>>();
    set.add(settled);
    inFlight.set(key, set);
    void settled.then(() => {
      seqs.delete(seq);
      if (seqs.size === 0 && sequences.get(key) === seqs) sequences.delete(key);
      mineSet.delete(mine);
      if (mineSet.size === 0 && sending.get(key) === mineSet) sending.delete(key);
      set.delete(settled);
      if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
    });
  };

  return (next) => (action) => {
    const result = next(action);
    const a = action as { type?: string; payload?: unknown; wipeSettled?: boolean };
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
      for (const slice of LEARNED_SLICES) {
        const key = flushKey(readBook, slice);
        if ((landedAt.get(key) ?? 0) > readSeq) continue;
        const revision = revisions?.[slice];
        if (revision) known.set(key, revision);
        else known.delete(key);
      }
      return result;
    }

    if (type === DROP_RETAINED && typeof a.payload === 'string') {
      if (a.wipeSettled === true) endWipe(a.payload);
      for (const key of Array.from(kept.keys())) {
        if (key.startsWith(`${a.payload}:`)) {
          kept.delete(key);
          retainedGen.delete(key);
        }
      }
      for (const key of Array.from(parked.keys())) {
        if (key.startsWith(`${a.payload}:`)) parked.delete(key);
      }
      return result;
    }

    if (type === RESTORE_SUPERSEDED && typeof a.payload === 'string') {
      if (endWipe(a.payload) > 0) return result;
      for (const [key, saved] of Array.from(parked)) {
        if (!key.startsWith(`${a.payload}:`)) continue;
        parked.delete(key);
        /* A write made after the park (book reopened, edited, flushed) carried
           its own value for every field it built and has gone out or is going
           out; putting the parked value back would re-send over it. Only the
           fields it did not carry are still owed (the `state` slice's
           confirmCast and commitDraft patch different fields of one key). */
        const owed = Object.fromEntries(
          Object.entries(saved.patch).filter(([field]) => !saved.newerFields.has(field)),
        );
        if (Object.keys(owed).length === 0) continue;
        const newer = kept.get(key);
        /* Plan 289 — the older base of the two, so the server still refuses the
           parked fields if the book changed since they were made. */
        kept.set(key, {
          patch: { ...owed, ...newer?.patch },
          base: saved.base ?? newer?.base,
          onSuccess: newer?.onSuccess ?? saved.onSuccess,
        });
      }
      return result;
    }

    if (type === SUPERSEDE_BOOK && typeof a.payload === 'string') {
      pendingWipes.set(a.payload, (pendingWipes.get(a.payload) ?? 0) + 1);
      const prefix = `${a.payload}:`;
      for (const key of new Set([
        ...generation.keys(),
        ...inFlight.keys(),
        ...pending.keys(),
        ...kept.keys(),
        ...sending.keys(),
      ])) {
        if (!key.startsWith(prefix)) continue;
        /* Oldest first, newest on top: the kept and running saves ordered by the
           generation their writes were made at (a hung older PUT can still be
           running when a newer one was given up on and kept), then the queued
           one. A second supersede before the first resolves merges under what
           the first already parked. */
        const keptHere = kept.get(key);
        const made = [
          ...(keptHere
            ? [
                {
                  patch: keptHere.patch,
                  onSuccess: keptHere.onSuccess,
                  gen: retainedGen.get(key) ?? generation.get(key) ?? 0,
                  base: keptHere.base,
                },
              ]
            : []),
          ...(sending.get(key) ?? []),
        ].sort((x, y) => (x.gen ?? 0) - (y.gen ?? 0));
        const queuedKept = carriedKept.get(key);
        const layers: SavedPatch[] = [
          ...(parked.has(key) ? [parked.get(key)!] : []),
          ...made,
          ...(pending.has(key)
            ? [
                {
                  patch: pending.get(key) as Record<string, unknown>,
                  onSuccess: toastPending.get(key)?.onSuccess,
                  base: queuedKept ? queuedKept.base : known.get(key),
                },
              ]
            : []),
        ];
        if (layers.length > 0) {
          const before = parked.get(key);
          const newerFields = before?.newerFields ?? new Set<string>();
          const landedFields = before?.landedFields ?? new Set<string>();
          /* A write this park cancels was never delivered, so its fields are owed
             again — unless another post-park write carrying them landed. */
          for (const l of layers) {
            if (l === before) continue;
            for (const field of Object.keys(l.patch)) {
              if (!landedFields.has(field)) newerFields.delete(field);
            }
          }
          parked.set(key, {
            patch: Object.assign({}, ...layers.map((l) => l.patch)),
            onSuccess: [...layers].reverse().find((l) => l.onSuccess)?.onSuccess,
            /* Plan 289 — the oldest layer's base guards every field merged here. */
            base: layers.map((l) => l.seq?.base ?? l.base).find((b) => b !== undefined),
            newerFields,
            landedFields,
          });
        }
        generation.set(key, (generation.get(key) ?? 0) + 1);
        const timer = timers.get(key);
        if (timer) clearTimeout(timer);
        timers.delete(key);
        pending.delete(key);
        toastPending.delete(key);
        carriedKept.delete(key);
        kept.delete(key);
        retainedGen.delete(key);
      }
      return result;
    }

    if (type === FLUSH_BOOK && typeof a.payload === 'string') {
      const target = a.payload;
      flushBookNow(target);
      const waits: Promise<{ slice: StateSlice; ok: boolean }>[] = [];
      for (const [key, set] of inFlight) {
        if (key.startsWith(`${target}:`)) waits.push(...set);
      }
      return waits.length > 0
        ? Promise.all(waits).then(
            (rs): BookFlushOutcome => ({
              failedSlices: rs.filter((r) => !r.ok).map((r) => r.slice),
            }),
          )
        : null;
    }

    const rule = PERSIST_RULES[type];
    if (!rule) return result;
    if (!bookId) return result;

    const key = flushKey(bookId, rule.slice);
    const built = rule.build(after, bookId);
    /* #3421 — a write made after a park supersedes the parked fields it carries. */
    const parkedHere = parked.get(key);
    if (parkedHere) for (const field of Object.keys(built as object)) parkedHere.newerFields.add(field);
    /* #3421 — a save given up on is re-sent with this one: the newer fields win.
       Plan 289 (D6) — the send carries the kept base (`carriedKept`). */
    const keptHere = kept.get(key);
    if (keptHere) {
      kept.delete(key);
      carriedKept.set(key, keptHere);
    }
    pending.set(key, keptHere ? { ...keptHere.patch, ...(built as Record<string, unknown>) } : built);
    /* #2230 — bump the per-(book, slice) generation so this becomes the LATEST
       write; in-flight older flushes keep their captured (lower) generation
       and are therefore gated out of prune/rollback in flush. */
    generation.set(key, (generation.get(key) ?? 0) + 1);
    const failHandler = TOAST_ON_PERSIST_FAILURE[type];
    if (failHandler) {
      toastPending.set(key, failHandler);
    } else if (rule.slice === 'state' && type !== 'bookMeta/commitDraft') {
      /* #2230 — the `state` slice is shared by ui/confirmCast and
         bookMeta/commitDraft (PERSIST_RULES above). When a non-bookMeta `state`
         write (confirmCast) lands in the same debounce window it REPLACES the
         pending patch, so a later failure concerns THAT write, not the
         superseded book-meta rename. Drop the stale handler so we neither toast
         nor roll back book-meta for an op that isn't book-meta. (Manuscript's
         ride-along semantics are intentionally left untouched — only the shared
         `state` slice has the cross-action mismatch.) */
      toastPending.delete(key);
    }
    const prev = timers.get(key);
    if (prev) clearTimeout(prev);
    timers.set(
      key,
      setTimeout(() => flush(bookId, rule.slice), debounceMs(after)),
    );
    return result;
  };
};
