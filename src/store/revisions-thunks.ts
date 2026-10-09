/* Plan 286 (#3400) — revisions operations: confirm with the server, then
   apply its state. The client never writes revisions.json. */
import type { AppDispatch, RootState } from './index';
import { api } from '../lib/api';
import { RevisionOpFailure, type RevisionOpCode } from '../lib/revision-op-failure';
import type { RevisionsState } from '../lib/types';
import { revisionsActions } from './revisions-slice';
import { uiActions } from './ui-slice';
import { notificationsActions } from './notifications-slice';

export type RevisionOpOutcome = { ok: true } | { ok: false; code: RevisionOpCode | 'network' };

export const REVISION_COPY = {
  gone: 'This take was replaced by a newer render',
  busy: 'This chapter is busy — try again when it finishes',
  noPrevious: 'Original audio not preserved',
  liveMissing: "This chapter's current audio is missing. Reject restores the earlier take; re-rendering the chapter replaces it",
  restoreFailed: "Couldn't restore the earlier take — try Reject again",
  unexpected: "Couldn't update the revision — try again",
  hasRevision: "This chapter has an older pending review — resolve it from the chapter's review first",
} as const;

/* Typed against the one slice it reads, not RootState (pass 4 #7): the
   generation middleware calls it with its own StreamableRootState
   (generation-stream-middleware.ts ~:44-55), which is not a RootState. Same
   shape as the revisions selectors' ActiveRoot (Task 12). */
export const activeBookId = (s: { ui: { stage: unknown } }): string | null => (s.ui.stage as { bookId?: string }).bookId ?? null;

export function refetchActiveRevisions(bookId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<'ok' | 'failed' | 'skipped'> => {
    if (activeBookId(getState()) !== bookId) return 'skipped';
    try {
      const res = await api.pollRevisions({ bookId });
      if (activeBookId(getState()) === bookId) dispatch(revisionsActions.applyPoll({ ...res, bookId }));
      return 'ok';
    } catch {
      return 'failed';
    }
  };
}

function runOp(bookId: string, chapterId: number, call: () => Promise<RevisionsState>) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<RevisionOpOutcome> => {
    const applyIfActive = (state: RevisionsState | undefined): boolean => {
      if (!state || activeBookId(getState()) !== bookId) return false;
      dispatch(revisionsActions.applyServerState(state));
      return true;
    };
    const toast = (kind: 'warn' | 'error', message: string, key: string) =>
      dispatch(notificationsActions.pushToast({ kind, message, dedupeKey: `revision-op-${key}` }));
    dispatch(uiActions.setRevisionOpInFlight(true));
    try {
      applyIfActive(await call());
      dispatch(uiActions.setOpenRevision(null));
      return { ok: true };
    } catch (err) {
      const f = err instanceof RevisionOpFailure ? err : null;
      const code: RevisionOpCode | 'network' = f ? f.code : 'network';
      switch (code) {
        case 'revision_not_found':
        case 'revision_gone': {
          if (!applyIfActive(f?.state)) void dispatch(refetchActiveRevisions(bookId));
          dispatch(uiActions.setOpenRevision(null));
          const preview = getState().ui.previewRegen;
          if (preview && preview.bookId === bookId && preview.previewChapterId === chapterId) {
            dispatch(uiActions.setPreviewRegen(null));
          }
          toast('warn', REVISION_COPY.gone, 'gone');
          break;
        }
        case 'chapter_busy':
          applyIfActive(f?.state);
          toast('warn', REVISION_COPY.busy, code);
          break;
        case 'no_previous_audio':
          applyIfActive(f?.state);
          toast('warn', REVISION_COPY.noPrevious, code);
          break;
        case 'live_audio_missing':
          applyIfActive(f?.state);
          toast('error', REVISION_COPY.liveMissing, code);
          break;
        case 'restore_failed':
          void dispatch(refetchActiveRevisions(bookId));
          toast('error', REVISION_COPY.restoreFailed, code);
          break;
        default:
          console.error('[revisions] op failed', err);
          toast('error', REVISION_COPY.unexpected, 'unexpected');
      }
      return { ok: false, code };
    } finally {
      dispatch(uiActions.setRevisionOpInFlight(false));
    }
  };
}

export function acceptRevisionOp({ bookId, revisionId, chapterId, selection }: { bookId: string; revisionId: string; chapterId: number; selection?: Record<number, 'A' | 'B'> }) {
  return runOp(bookId, chapterId, () => api.acceptRevision(selection ? { bookId, revisionId, selection } : { bookId, revisionId }));
}

export function rejectRevisionOp({ bookId, revisionId, chapterId }: { bookId: string; revisionId: string; chapterId: number }) {
  return runOp(bookId, chapterId, () => api.rejectRevision({ bookId, revisionId }));
}

export function dismissDriftOp(driftId: string) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    const s = getState();
    const bookId = s.revisions.drift.find((d) => d.id === driftId)?.bookId ?? activeBookId(s);
    if (!bookId) return;
    try {
      const state = await api.dismissDrift({ bookId, driftId });
      dispatch(revisionsActions.applyDismiss({ driftId, state: activeBookId(getState()) === bookId ? state : undefined }));
    } catch (err) {
      console.error('[revisions] dismiss failed', err);
      dispatch(notificationsActions.pushToast({ kind: 'error', message: "Couldn't dismiss the drift event — try again", dedupeKey: 'drift-dismiss-failed' }));
    }
  };
}
