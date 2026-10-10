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
import type { StateSlice } from '../lib/types';
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
  message: (err: unknown) => string;
  dedupeKey: string;
  /** Optional extra dispatch fired on persist failure — e.g. rolling back an
      optimistic local update. Returns the action to dispatch. */
  rollback?: (bookId: string) => { type: string };
  /** Optional dispatch fired on a SUCCESSFUL flush — e.g. pruning a rollback
      snapshot now that its optimistically-written value is confirmed on disk,
      so the next commit snapshots a fresh baseline. Returns the action. */
  onSuccess?: (bookId: string) => { type: string };
}
const TOAST_ON_PERSIST_FAILURE: Record<string, PersistFailureHandler> = {
  'manuscript/setSentencesCharacterBulk': {
    message: () => 'Line reassignment could not be saved. Check your connection and try again.',
    dedupeKey: 'bulk-reassign-persist-failed',
  },
  'manuscript/undoBulkReassign': {
    message: () => 'Line reassignment could not be saved. Check your connection and try again.',
    dedupeKey: 'bulk-reassign-persist-failed',
  },
  /* #2230 — a refused rename (409: analysis running; or a folder path
     collision) must surface the server's sentence and not leave the persisted
     value claiming a title that never saved. The server message rides on
     err.message (api.putBookState unwraps `{ error }` from the 409 body);
     we strip the api.ts envelope so the toast shows only the refusal sentence,
     degrading gracefully to the raw message if that format ever changes. */
  'bookMeta/commitDraft': {
    message: (err) => {
      const raw = err instanceof Error ? err.message : '';
      const sentence =
        raw.replace(/^Book state PUT failed \(\d+\): /, '') || 'an unknown error occurred';
      return `Book details couldn't be saved: ${sentence}`;
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
   write for the book still in flight has settled (success or failure), or
   `null` when nothing is queued or in flight — so the re-read never sees
   disk from before a write that LANDED. A write that FAILED settles the
   same way, so the re-read still runs and reads disk from before it. Plan
   286 — revisions no longer persists from the client, so the
   write-then-re-read hazard this describes now applies only to the other
   slices. Re-send vs. surface is owed in #3421.
   Not a reducer action: no slice handles it. */
const FLUSH_BOOK = 'persistence/flushBook';
export const flushBookPersistence = (bookId: string) => ({ type: FLUSH_BOOK, payload: bookId });

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
  /* #3395 pass 4, S3 — each key's PUTs still in flight, as settle-never-
     reject promises, so `flushBookPersistence` can await them. */
  const inFlight = new Map<FlushKey, Set<Promise<void>>>();
  /* The book the stage named after the previous action — when it changes,
     that book's queued writes are sent at once (S3). */
  let lastBookId: string | null = bookIdFromState(store.getState() as PersistableRootState);

  /* Send every queued write for `bookId` now instead of at the end of its
     debounce. */
  const flushBookNow = (bookId: string) => {
    for (const [key, timer] of Array.from(timers)) {
      if (!key.startsWith(`${bookId}:`)) continue;
      clearTimeout(timer);
      flush(bookId, key.slice(bookId.length + 1) as StateSlice);
    }
  };

  const flush = (bookId: string, slice: StateSlice) => {
    const key = flushKey(bookId, slice);
    const patch = pending.get(key);
    pending.delete(key);
    timers.delete(key);
    const handler = toastPending.get(key);
    toastPending.delete(key);
    const gen = generation.get(key) ?? 0;
    if (patch === undefined) return;
    const put = api.putBookState(bookId, { slice, patch });
    const settled = put.then(
      () => {},
      () => {},
    );
    const set = inFlight.get(key) ?? new Set<Promise<void>>();
    set.add(settled);
    inFlight.set(key, set);
    void settled.then(() => {
      set.delete(settled);
      if (set.size === 0 && inFlight.get(key) === set) inFlight.delete(key);
    });
    put
      .then(() => {
        /* #2230 — only the LATEST flush prunes the rollback snapshot. If a
           newer write has since been scheduled (gen advanced), a fresh snapshot
           belongs to it and must not be cleared by this older, superseded
           flush. */
        if (handler?.onSuccess && gen === (generation.get(key) ?? 0)) {
          store.dispatch(handler.onSuccess(bookId));
        }
      })
      .catch((err) => {
        console.error(`[persist] PUT /api/books/${bookId}/state slice=${slice} failed`, err);
        /* #2230 — only act on a failure of the LATEST write. An older flush's
           failure is superseded by a newer in-flight write (which owns the
           snapshot and the user's current draft), so don't toast/roll back for
           it — that would wrongly revert the newer edit. */
        if (handler && gen === (generation.get(key) ?? 0)) {
          store.dispatch(
            notificationsActions.pushToast({
              kind: 'error',
              message: handler.message(err),
              dedupeKey: handler.dedupeKey,
            }),
          );
          /* #2230 — a refused rename must not leave the persisted value claiming
             a title the server rejected; roll the optimistic saved update back
             (and restore the draft so the user's text is preserved for retry). */
          if (handler.rollback) store.dispatch(handler.rollback(bookId));
        }
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

    if (type === FLUSH_BOOK && typeof a.payload === 'string') {
      const target = a.payload;
      flushBookNow(target);
      const waits: Promise<void>[] = [];
      for (const [key, set] of inFlight) {
        if (key.startsWith(`${target}:`)) waits.push(...set);
      }
      return waits.length > 0 ? Promise.all(waits).then(() => undefined) : null;
    }

    const rule = PERSIST_RULES[type];
    if (!rule) return result;
    if (!bookId) return result;

    const key = flushKey(bookId, rule.slice);
    pending.set(key, rule.build(after, bookId));
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
