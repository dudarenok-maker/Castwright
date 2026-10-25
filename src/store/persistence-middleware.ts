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
   slices are re-read in full, or the book is deleted. Plan 286 — revisions
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
   that book's slices are re-read in full (Layout's full hydrate: the user has
   seen the failure and the revert, so a kept save landing later would
   contradict what they see) and when the book is deleted (hygiene: nothing is
   left for a gone book). A re-parse or a manuscript replace drops nothing:
   it rotates the book's edit epoch, so the server refuses every kept save
   (plan 289, D8b). Touches only the kept saves — a newer edit already queued
   for the book is untouched. Not a reducer action. */
const DROP_RETAINED = 'persistence/dropRetained';
export const dropRetainedSaves = (bookId: string) => ({ type: DROP_RETAINED, payload: bookId });

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
  /* #3784 — the fields the pending write's rollback handler restores (the
     book-meta fields of a `commitDraft`). A save that rolls back keeps the
     rest of its patch — a `confirmCast` combined into it, or a kept save it
     carried — for the book's next flush. */
  const rollbackFields = new Map<FlushKey, Set<string>>();
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
     in full or it is deleted (`dropRetainedSaves`). A newer edit for the same key
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
     by the key's next `flush`; a later build of the key that merges over the
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
     patches were built after it and already include it.
     P6-4 (#3784) — `covered` holds the fields of every build of the key made
     since the sequence started. The `state` slice is partial, so a newer
     build supersedes only the fields it carries; the rest of a superseded
     sequence's patch is left behind for a later send (`leaveBehind`). Every
     other slice builds its whole content, so a newer build covers it all. */
  type Sequence = { gen: number; base?: SliceRevision; refreshable: boolean; covered: Set<string> };
  const sequences = new Map<FlushKey, Set<Sequence>>();

  /* P6-4 — a kept save's base is read for its own fields: each field is checked
     against the revision it was built against. Two saves of a key combine with
     `newer`'s values winning; the send's other fields are checked against the
     key's last-known revision (`sendBase`). */
  const mergeSaves = (older: KeptSave | undefined, newer: KeptSave): KeptSave => {
    if (!older) return newer;
    const base: SliceRevision = {};
    for (const [save, skip] of [
      [older, newer.patch],
      [newer, {}],
    ] as const) {
      for (const f of Object.keys(save.patch)) {
        const token = save.base?.[f];
        if (!(f in skip) && token !== undefined) base[f] = token;
      }
    }
    return {
      patch: { ...older.patch, ...newer.patch },
      base: Object.keys(base).length > 0 ? base : undefined,
      onSuccess: newer.onSuccess ?? older.onSuccess,
    };
  };
  const sendBase = (carried: KeptSave, latest: SliceRevision | undefined): SliceRevision | undefined => {
    if (!carried.base) return undefined;
    const base: SliceRevision = { ...latest };
    for (const f of Object.keys(carried.patch)) {
      const token = carried.base[f];
      if (token !== undefined) base[f] = token;
      else delete base[f];
    }
    return base;
  };
  /* The book the stage named after the previous action — when it changes,
     that book's queued writes are sent at once (S3). */
  let lastBookId: string | null = bookIdFromState(store.getState() as PersistableRootState);

  /* #3754 / #3624 — the last NON-NULL book the stage named, for the metadata
     draft clear in the handler below. Unlike `lastBookId` (S3), a trip to the
     library never nulls this, so B -> home -> B still reads as the same book
     and keeps the user's unsaved draft. */
  let lastOpenBookId: string | null = bookIdFromState(store.getState() as PersistableRootState);

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
    const ownFields = rollbackFields.get(key);
    rollbackFields.delete(key);
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
       unconditionally as before. The kept base applies to the kept fields;
       the live fields merged with them are checked against the last-known
       revision (P6-4). */
    const seq: Sequence = {
      gen,
      base: carried ? sendBase(carried, known.get(key)) : known.get(key),
      refreshable: !carried,
      covered: new Set<string>(),
    };
    const seqs = sequences.get(key) ?? new Set<Sequence>();
    seqs.add(seq);
    sequences.set(key, seqs);
    /* P6-4 — the fields of this patch no newer build of the key carries. */
    const uncovered = () =>
      Object.fromEntries(Object.entries(patch as Record<string, unknown>).filter(([f]) => !seq.covered.has(f)));
    /* P6-4 — a superseded sequence's uncovered fields are not superseded: they
       ride the newer send if it is still queued, else they are kept for the
       book's next flush, with the base they were sent with either way, so the
       server refuses them if the book moved on. The book-meta handler goes
       with them when they include its fields. */
    const leaveBehind = () => {
      const rest = uncovered();
      if (Object.keys(rest).length === 0) return;
      const own = Object.keys(rest).filter((f) => ownFields?.has(f));
      const save: KeptSave = {
        patch: rest,
        base: seq.base,
        onSuccess: own.length > 0 ? onSuccess : carried?.onSuccess,
      };
      const queued = pending.get(key) as Record<string, unknown> | undefined;
      if (!queued) {
        kept.set(key, mergeSaves(kept.get(key), save));
        return;
      }
      pending.set(key, { ...queued, ...rest });
      carriedKept.set(key, mergeSaves(carriedKept.get(key), save));
      if (handler && own.length > 0) {
        if (!toastPending.has(key)) toastPending.set(key, handler);
        const fields = rollbackFields.get(key) ?? new Set<string>();
        for (const f of own) fields.add(f);
        rollbackFields.set(key, fields);
      }
    };
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
          return { slice, ok: true };
        } catch (err) {
          console.error(`[persist] PUT /api/books/${bookId}/state slice=${slice} failed`, err);
          const refused = PUT_REFUSED_RE.test(err instanceof Error ? err.message : String(err));
          /* P6-4 — superseded only when the newer builds carry every field of
             this patch; on the partial `state` slice they may not. */
          const superseded = gen !== (generation.get(key) ?? 0);
          const overtaken = superseded && Object.keys(uncovered()).length === 0;
          /* Plan 289 (D2) — the book changed since this save was made, so the
             server refused it and wrote nothing. It is not kept or re-sent
             (it is a 4xx), and not rolled back: the rollback baseline is older
             than disk, so restoring it would show the user neither value. The
             book is marked for a full re-read instead, so the screen shows what
             is on disk (Layout re-reads it now if it is open). The toast names
             the book, once per book. A newer write that overtook this one owns
             the outcome: no toast, and no re-read, which would discard the
             draft and re-hydrate over edits the screen already shows (P6-3). */
          if (isStaleRefusal(err)) {
            if (!overtaken) {
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
              store.dispatch(bookMetaActions.markNeedsFullRead({ bookId }));
            }
            return { slice, ok: overtaken };
          }
          /* A newer write for this key owns the outcome (and the user's
             current draft); don't re-send the stale patch over it. The fields
             it does not carry are left behind (P6-4). */
          if (superseded) {
            if (!refused) leaveBehind();
            return { slice, ok: true };
          }
          if (!refused && attempt < FLUSH_RETRY_DELAYS_MS.length) {
            await new Promise<void>((resolve) => setTimeout(resolve, FLUSH_RETRY_DELAYS_MS[attempt]));
            if (gen !== (generation.get(key) ?? 0)) {
              leaveBehind();
              return { slice, ok: true };
            }
            continue;
          }
          /* Final failure of the LATEST write (#2230). The rollback restores a
             shared, book-agnostic draft, and the retry window (#3421) lets the
             user open another book first — applying it then would overlay this
             book's text on that one, so it only runs while this book is open. */
          const bookOpen = bookIdFromState(store.getState() as PersistableRootState) === bookId;
          const rolledBack = !!handler?.rollback && bookOpen;
          /* Keep the patch for the book's next flush (#3421) — except a 4xx
             (the server's answer, so re-sending repeats a refused write) and
             the fields a rollback restores (the user's draft is restored for
             them to save again). A save that gave up WITHOUT rolling back has
             no draft left, so it is kept and re-sent. A save that rolled back
             keeps its other fields (#3784), with the base they were sent with
             and the carried kept save's success handler: the screen still
             shows them, and the server refuses them if the book moved on. */
          /* A field an older superseded send left behind (P6-4) is kept with it. */
          if (!refused && !rolledBack) {
            kept.set(
              key,
              mergeSaves(kept.get(key), { patch: patch as Record<string, unknown>, base: seq.base, onSuccess }),
            );
          } else if (!refused) {
            const rest = Object.fromEntries(
              Object.entries(patch as Record<string, unknown>).filter(([f]) => !ownFields?.has(f)),
            );
            if (Object.keys(rest).length > 0) {
              kept.set(key, mergeSaves(kept.get(key), { patch: rest, base: seq.base, onSuccess: carried?.onSuccess }));
            }
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
            /* A 4xx is final, so even after the book was left `saved` must stop
               claiming the refused value: reverted, without the draft. */
            if (rolledBack) store.dispatch(handler.rollback!(bookId, true));
            else if (refused && handler.rollback) store.dispatch(handler.rollback(bookId, false));
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
    const settled = attemptSend();
    const set = inFlight.get(key) ?? new Set<Promise<{ slice: StateSlice; ok: boolean }>>();
    set.add(settled);
    inFlight.set(key, set);
    void settled.then(() => {
      seqs.delete(seq);
      if (seqs.size === 0 && sequences.get(key) === seqs) sequences.delete(key);
      set.delete(settled);
      if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
    });
  };

  return (next) => (action) => {
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
      for (const key of Array.from(kept.keys())) {
        if (key.startsWith(`${a.payload}:`)) kept.delete(key);
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
    const built = rule.build(after, bookId);
    /* #3421 — a save given up on is re-sent with this one: the newer fields win.
       Plan 289 (D6) — the send carries the kept base (`carriedKept`). */
    const keptHere = kept.get(key);
    if (keptHere) {
      kept.delete(key);
      carriedKept.set(key, keptHere);
    }
    /* #3784 — a later build of the key in the same window merges over the
       queued patch, newest value per field: `confirmCast` and `commitDraft`
       combine. Every other slice builds its whole content, so the merge is a
       replace there. A kept patch is merged in by the build that takes it;
       later builds find its fields in the queued patch. */
    pending.set(key, {
      ...keptHere?.patch,
      ...(pending.get(key) as Record<string, unknown> | undefined),
      ...(built as Record<string, unknown>),
    });
    /* #2230 — bump the per-(book, slice) generation so this becomes the LATEST
       write; in-flight older flushes keep their captured (lower) generation
       and are therefore gated out of prune/rollback in flush. */
    generation.set(key, (generation.get(key) ?? 0) + 1);
    /* P6-4 — the running sequences of the key are superseded only in the
       fields this build carries. */
    for (const s of sequences.get(key) ?? []) {
      for (const f of Object.keys(built as Record<string, unknown>)) s.covered.add(f);
    }
    const failHandler = TOAST_ON_PERSIST_FAILURE[type];
    /* #3784 — a `confirmCast` merged after a `commitDraft` keeps the book-meta
       handler: the send still carries the book-meta fields, so its failure
       rolls them back and its success prunes their rollback baseline. */
    if (failHandler) toastPending.set(key, failHandler);
    if (failHandler?.rollback) {
      const own = rollbackFields.get(key) ?? new Set<string>();
      for (const f of Object.keys(built as Record<string, unknown>)) own.add(f);
      rollbackFields.set(key, own);
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
