/* Plan 286 — the profile-regen preview's side effects, as thunks (moved out
   of layout.tsx so they run only after a confirmed accept, under the
   preview's own bookId). */
import type { AppDispatch, RootState } from './index';
import { api } from '../lib/api';
import { RevisionOpFailure } from '../lib/revision-op-failure';
import { uiActions, type PreviewRegenCtx } from './ui-slice';
import { changeLogActions } from './change-log-slice';
import { notificationsActions } from './notifications-slice';
import { enqueueQueueEntries } from './queue-thunks';
import { buildCharacterRegenEvent } from '../lib/change-log';
import { REVISION_COPY, activeBookId } from './revisions-thunks';

const rand = () => Math.random().toString(36).slice(2, 8);

export function startPreviewRegen(args: { bookId: string; characterId: string; characterName: string; chapterIds: number[]; reason: string; note: string }) {
  return async (dispatch: AppDispatch): Promise<void> => {
    const [previewChapterId, ...remainingChapterIds] = args.chapterIds;
    if (previewChapterId === undefined) return;
    dispatch(uiActions.setPreviewRegen({ bookId: args.bookId, characterId: args.characterId, previewChapterId, remainingChapterIds, reason: args.reason, note: args.note }));
    await dispatch(enqueueQueueEntries([{
      id: `regen-preview-${args.bookId}-${args.characterId}-${previewChapterId}-${rand()}`,
      bookId: args.bookId,
      chapterId: previewChapterId,
      scope: 'this',
      review: { characterId: args.characterId, triggeredBy: `${args.characterName} voice change` },
    }]));
  };
}

export function approvePreviewSideEffects(preview: PreviewRegenCtx) {
  return async (dispatch: AppDispatch, getState: () => RootState): Promise<void> => {
    dispatch(uiActions.setPreviewRegen(null));
    const character = getState().cast.characters.find((c) => c.id === preview.characterId);
    if (character) {
      dispatch(changeLogActions.appendLogEvent(buildCharacterRegenEvent({
        character, chapterIds: [preview.previewChapterId, ...preview.remainingChapterIds], reason: preview.reason, note: preview.note,
      })));
    }
    if (preview.remainingChapterIds.length === 0) return;
    const r = rand();
    await dispatch(enqueueQueueEntries(preview.remainingChapterIds.map((chId) => ({
      id: `regen-rest-${preview.bookId}-${preview.characterId}-${chId}-${r}`, bookId: preview.bookId, chapterId: chId, scope: 'this' as const,
    }))));
    if (activeBookId(getState()) === preview.bookId) dispatch(uiActions.changeView('generate'));
  };
}

export function restoreUnrecordedPreview(preview: PreviewRegenCtx) {
  return async (dispatch: AppDispatch): Promise<void> => {
    const close = () => { dispatch(uiActions.setPreviewRegen(null)); dispatch(uiActions.setOpenRevision(null)); };
    if (!preview.stub?.hasPreviousAudio) return close();
    dispatch(uiActions.setRevisionOpInFlight(true));
    try {
      await api.restorePreviousUnrecorded({ bookId: preview.bookId, chapterId: preview.previewChapterId });
      close();
    } catch (err) {
      const code = err instanceof RevisionOpFailure ? err.code : 'network';
      const [kind, message] =
        code === 'has_revision' ? (['warn', REVISION_COPY.hasRevision] as const)
        : code === 'chapter_busy' ? (['warn', REVISION_COPY.busy] as const)
        : (['error', REVISION_COPY.restoreFailed] as const);
      dispatch(notificationsActions.pushToast({ kind, message, dedupeKey: `preview-restore-${code}` }));
    } finally {
      dispatch(uiActions.setRevisionOpInFlight(false));
    }
  };
}
