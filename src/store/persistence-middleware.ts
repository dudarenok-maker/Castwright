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
  'cast/lockVoice': { slice: 'cast', build: (s) => ({ characters: s.cast.characters }) },

  'manuscript/setSentenceCharacter': {
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
  /* fs-58 — text edit (strip_tag review op). Persisted the same way as other
     sentence edits so the corrected text survives reload. */
  'manuscript/setSentenceText': {
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

  /* fs-57 — per-book live-instruct toggle. Persists immediately (no draft
     buffer needed — it's a boolean flip, not an editable field). Lands in
     the `state` slice alongside castConfirmed and the book-meta fields. */
  'bookMeta/setLiveInstruct': {
    slice: 'state',
    build: (s, bookId) => ({ liveInstruct: bookId ? (s.bookMeta.liveInstruct[bookId] ?? false) : false }),
  },
};

function bookIdFromState(s: PersistableRootState): string | null {
  const stage = s.ui.stage as { bookId?: string };
  return stage.bookId ?? null;
}

export const persistenceMiddleware: Middleware = (store) => {
  const timers = new Map<StateSlice, ReturnType<typeof setTimeout>>();
  const pending = new Map<StateSlice, unknown>();

  const flush = (bookId: string, slice: StateSlice) => {
    const patch = pending.get(slice);
    pending.delete(slice);
    timers.delete(slice);
    if (patch === undefined) return;
    api.putBookState(bookId, { slice, patch }).catch((err) => {
      console.error(`[persist] PUT /api/books/${bookId}/state slice=${slice} failed`, err);
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
    const prev = timers.get(rule.slice);
    if (prev) clearTimeout(prev);
    timers.set(
      rule.slice,
      setTimeout(() => flush(bookId, rule.slice), debounceMs(after)),
    );
    return result;
  };
};
