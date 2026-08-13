/* Per-slice persistence middleware.

   Watches a curated set of action types that represent user edits and
   debounces a PUT /api/books/:bookId/state for the touched slice. Each
   slice has its own debounce window so an edit to cast doesn't delay a
   write to revisions.

   Skipped when no bookId is in scope (library browsing, fresh upload
   before confirm). Under VITE_USE_MOCKS, PUTs still flow — the mock api
   keeps an in-memory state map (MOCK_BOOK_STATES in src/lib/api.ts) so
   the round-trip works for design fixtures and jsdom tests. */

import type { Middleware } from '@reduxjs/toolkit';
import type { CastState } from './cast-slice';
import type { ManuscriptState } from './manuscript-slice';
import type { RevisionsState } from './revisions-slice';
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
  revisions: RevisionsState;
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
   change in the Account → Advanced panel takes effect on the next edit, with no
   reload. Falls back to the default when the slice is absent (older persisted
   blob / partial test state). */
function debounceMs(s: PersistableRootState): number {
  const v = s.settings?.autosaveDebounceMs;
  return typeof v === 'number' && Number.isFinite(v) ? v : DEFAULT_DEBOUNCE_MS;
}

/* Action types that should trigger a persist. Hydration actions
   (hydrateFromAnalysis, hydrateFromBookState, applyPoll for initial load,
   setImportCandidate) are intentionally absent — those are server-driven
   and would create a write-loop if echoed back. */
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

  /* dismissed ids ride with every revisions persist so the backend drift
     detector can filter ids the user has waved off (read in
     server/src/routes/revisions.ts). Without it, the slice's in-memory
     dismissals would be lost on reload and previously-dismissed events
     would resurface on the next poll. */
  'revisions/acceptAllPending': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      timeline: s.revisions.timeline,
    }),
  },
  'revisions/rejectAllPending': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      timeline: s.revisions.timeline,
    }),
  },
  'revisions/dismissDrift': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      timeline: s.revisions.timeline,
    }),
  },
  /* Per-item accept also persists acceptedSelections — the slice records
     the user's per-segment A/B choices at accept time and this patch is
     the only way they survive a reload. Reject doesn't capture selection
     (see revisions-slice.rejectRevision), so its patch is the same as the
     bulk variants. */
  'revisions/acceptRevision': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      acceptedSelections: s.revisions.acceptedSelections,
      timeline: s.revisions.timeline,
    }),
  },
  'revisions/rejectRevision': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      timeline: s.revisions.timeline,
    }),
  },
  /* Plan 55 rollback. Reducer flips status + appends a `rolled-back` entry;
     this rule fans the timeline back out to revisions.json so a reload
     reflects the rollback. (The matching server-side audio restore is
     dispatched separately by the timeline view's click handler — plan 20's
     POST /audio/previous/restore endpoint.) */
  'revisions/rolledBack': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      acceptedSelections: s.revisions.acceptedSelections,
      timeline: s.revisions.timeline,
    }),
  },
  /* enqueuePending is fired by the generation-stream middleware when a
     profile-change preview chapter completes (plan 114). Persist `pending`
     so a reload rehydrates the in-flight revision stub. markRevisionPlayable
     similarly persists so the playable flip survives a reload after the
     chapter completed but before the user opened the diff. */
  'revisions/enqueuePending': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      timeline: s.revisions.timeline,
    }),
  },
  'revisions/markRevisionPlayable': {
    slice: 'revisions',
    build: (s, bookId) => ({
      pending: s.revisions.pending,
      drift: s.revisions.drift.filter((d) => d.bookId === bookId),
      dismissed: s.revisions.dismissed,
      timeline: s.revisions.timeline,
    }),
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

export const persistenceMiddleware: Middleware = (store) => {
  const timers = new Map<StateSlice, ReturnType<typeof setTimeout>>();
  const pending = new Map<StateSlice, unknown>();
  /* Slices whose currently-pending write was (at least once this debounce
     window) triggered by a toast-worthy action. Last-wins on the patch means
     the flush persists the latest slice state regardless, so if it fails that
     action didn't land — toasting with the matching handler is correct even if
     an unrelated edit also rode along in the same window. Carries the handler
     so the toast text can be per-action (bulk-reassign copy vs the server's own
     refused-rename sentence) and any rollback can fire. */
  const toastPending = new Map<StateSlice, PersistFailureHandler>();
  /* #2230 — monotonically-increasing counter per slice, bumped every time a
     write is (re)scheduled. A flush captures the counter at fire time; its
     success/failure effects (snapshot prune / rollback / toast) only run if it
     is still the LATEST flush for the slice. This prevents an OLDER in-flight
     PUT from prematurely pruning or rolling back the shared rollback snapshot
     that a NEWER in-flight PUT (started while the first was still pending) still
     needs — closing the overlapping-in-flight-PUT data-loss race. */
  const generation = new Map<StateSlice, number>();

  const flush = (bookId: string, slice: StateSlice) => {
    const patch = pending.get(slice);
    pending.delete(slice);
    timers.delete(slice);
    const handler = toastPending.get(slice);
    toastPending.delete(slice);
    const gen = generation.get(slice) ?? 0;
    if (patch === undefined) return;
    api
      .putBookState(bookId, { slice, patch })
      .then(() => {
        /* #2230 — only the LATEST flush prunes the rollback snapshot. If a
           newer write has since been scheduled (gen advanced), a fresh snapshot
           belongs to it and must not be cleared by this older, superseded
           flush. */
        if (handler?.onSuccess && gen === (generation.get(slice) ?? 0)) {
          store.dispatch(handler.onSuccess(bookId));
        }
      })
      .catch((err) => {
        console.error(`[persist] PUT /api/books/${bookId}/state slice=${slice} failed`, err);
        /* #2230 — only act on a failure of the LATEST write. An older flush's
           failure is superseded by a newer in-flight write (which owns the
           snapshot and the user's current draft), so don't toast/roll back for
           it — that would wrongly revert the newer edit. */
        if (handler && gen === (generation.get(slice) ?? 0)) {
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
    const a = action as { type?: string };
    const type = a?.type;
    if (!type) return result;
    const rule = PERSIST_RULES[type];
    if (!rule) return result;

    const after = store.getState() as PersistableRootState;
    const bookId = bookIdFromState(after);
    if (!bookId) return result;

    pending.set(rule.slice, rule.build(after, bookId));
    /* #2230 — bump the per-slice generation so this becomes the LATEST write;
       in-flight older flushes keep their captured (lower) generation and are
       therefore gated out of prune/rollback in flush. */
    generation.set(rule.slice, (generation.get(rule.slice) ?? 0) + 1);
    const failHandler = TOAST_ON_PERSIST_FAILURE[type];
    if (failHandler) {
      toastPending.set(rule.slice, failHandler);
    } else if (rule.slice === 'state' && type !== 'bookMeta/commitDraft') {
      /* #2230 — the `state` slice is shared by ui/confirmCast and
         bookMeta/commitDraft (PERSIST_RULES above). When a non-bookMeta `state`
         write (confirmCast) lands in the same debounce window it REPLACES the
         pending patch, so a later failure concerns THAT write, not the
         superseded book-meta rename. Drop the stale handler so we neither toast
         nor roll back book-meta for an op that isn't book-meta. (Manuscript's
         ride-along semantics are intentionally left untouched — only the shared
         `state` slice has the cross-action mismatch.) */
      toastPending.delete(rule.slice);
    }
    const prev = timers.get(rule.slice);
    if (prev) clearTimeout(prev);
    timers.set(
      rule.slice,
      setTimeout(() => flush(bookId, rule.slice), debounceMs(after)),
    );
    return result;
  };
};
