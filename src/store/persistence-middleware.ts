/* Per-slice persistence middleware.

   Watches a curated set of action types that represent user edits and
   debounces a PUT /api/books/:bookId/state for the touched slice. Each
   slice has its own debounce window so an edit to cast doesn't delay a
   write to revisions.

   Skipped when VITE_USE_MOCKS=true (mock api has no disk) or when no
   bookId is in scope (library browsing, fresh upload before confirm). */

import type { Middleware } from '@reduxjs/toolkit';
import type { CastState } from './cast-slice';
import type { ManuscriptState } from './manuscript-slice';
import type { RevisionsState } from './revisions-slice';
import type { UiState } from './ui-slice';
import type { ChangeLogState } from './change-log-slice';
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
}

const USE_MOCKS = import.meta.env.VITE_USE_MOCKS === 'true';
const DEBOUNCE_MS = 500;

/* Action types that should trigger a persist. Hydration actions
   (hydrateFromAnalysis, hydrateFromBookState, applyPoll for initial load,
   setImportCandidate) are intentionally absent — those are server-driven
   and would create a write-loop if echoed back. */
const PERSIST_RULES: Record<string, { slice: StateSlice; build: (s: PersistableRootState) => unknown }> = {
  'cast/setCharacters':       { slice: 'cast',       build: (s) => ({ characters: s.cast.characters }) },
  'cast/declineMatch':        { slice: 'cast',       build: (s) => ({ characters: s.cast.characters }) },
  'cast/updateCharacter':     { slice: 'cast',       build: (s) => ({ characters: s.cast.characters }) },
  'cast/applyVoiceMatches':   { slice: 'cast',       build: (s) => ({ characters: s.cast.characters }) },

  'manuscript/setSentenceCharacter':  { slice: 'manuscript', build: (s) => ({ sentences: s.manuscript.sentences }) },
  'manuscript/setSentencesCharacter': { slice: 'manuscript', build: (s) => ({ sentences: s.manuscript.sentences }) },
  'manuscript/splitSentence':         { slice: 'manuscript', build: (s) => ({ sentences: s.manuscript.sentences }) },

  'revisions/acceptAllPending': { slice: 'revisions', build: (s) => ({ pending: s.revisions.pending, drift: s.revisions.drift }) },
  'revisions/rejectAllPending': { slice: 'revisions', build: (s) => ({ pending: s.revisions.pending, drift: s.revisions.drift }) },
  'revisions/dismissDrift':     { slice: 'revisions', build: (s) => ({ pending: s.revisions.pending, drift: s.revisions.drift }) },

  /* Editorial audit trail. Persists the whole `events` array on every
     append — the log is small (one entry per user action) and the server
     route writes the file atomically, so a full rewrite stays cheap. */
  'changeLog/appendLogEvent': { slice: 'changeLog', build: (s) => ({ events: s.changeLog.events }) },

  'ui/confirmCast': { slice: 'state', build: () => ({ castConfirmed: true }) },
};

function bookIdFromState(s: PersistableRootState): string | null {
  const stage = s.ui.stage as { bookId?: string };
  return stage.bookId ?? null;
}

export const persistenceMiddleware: Middleware = (store) => {
  if (USE_MOCKS) return (next) => (action) => next(action);

  const timers = new Map<StateSlice, ReturnType<typeof setTimeout>>();
  const pending = new Map<StateSlice, unknown>();

  const flush = (bookId: string, slice: StateSlice) => {
    const patch = pending.get(slice);
    pending.delete(slice);
    timers.delete(slice);
    if (patch === undefined) return;
    api.putBookState(bookId, { slice, patch }).catch(err => {
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

    pending.set(rule.slice, rule.build(after));
    const prev = timers.get(rule.slice);
    if (prev) clearTimeout(prev);
    timers.set(rule.slice, setTimeout(() => flush(bookId, rule.slice), DEBOUNCE_MS));
    return result;
  };
};
