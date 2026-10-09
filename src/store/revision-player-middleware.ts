/* Plan 286 (D6, spec §4; pass 3 #1/#11; OD28) — the A/B player shows one
   server entry or the preview stub. Three rules, in order:
   1. a server entry for the preview's chapter supersedes its stub (Approve
      must accept that entry, not fan out around it);
   2. the stub is shown only on its own book — leaving hides it, never clears it;
   3. a server entry that leaves the cache while no op of the user's own is in
      flight (another tab resolved it, or a poll dropped it) closes the player,
      and clears a preview tied to that chapter with one toast. */
import type { Middleware } from '@reduxjs/toolkit';
import { uiActions, selectActivePreviewStub, type UiState } from './ui-slice';
import { selectActivePending, type RevisionsState } from './revisions-slice';
import { notificationsActions } from './notifications-slice';

type Root = { ui: UiState; revisions: RevisionsState };

export const revisionPlayerMiddleware: Middleware = (store) => (next) => (action) => {
  const result = next(action);
  const s = store.getState() as Root;
  const open = s.ui.openRevision;
  const preview = s.ui.previewRegen;
  const active = (s.ui.stage as { bookId?: string }).bookId ?? null;

  if (preview?.stub && preview.bookId === active) {
    const entry = selectActivePending(s).find((p) => p.chapterId === preview.previewChapterId);
    if (entry) {
      /* Switch the player first: rule 2 would otherwise hide a stub player
         the moment the stub is dropped. The re-entry this dispatch causes
         runs rule 1 again and drops the stub; `now` below sees that. */
      if (open?.kind === 'preview-stub') {
        store.dispatch(uiActions.setOpenRevision({ kind: 'server', revisionId: entry.id, chapterId: entry.chapterId }));
      }
      const now = (store.getState() as Root).ui.previewRegen;
      if (now?.stub) {
        store.dispatch(uiActions.setPreviewRegen({
          ...now,
          stub: undefined,
          ...(now.completed ? { completed: { ...now.completed, stubFallback: false } } : {}),
        }));
      }
      return result;
    }
  }

  if (!open) return result;
  if (open.kind === 'preview-stub') {
    if (!selectActivePreviewStub(s)) store.dispatch(uiActions.setOpenRevision(null));
    return result;
  }

  if (s.ui.revisionOpInFlight) return result;
  if (selectActivePending(s).some((p) => p.id === open.revisionId)) return result;
  store.dispatch(uiActions.setOpenRevision(null));
  if (preview && preview.bookId === active && preview.previewChapterId === open.chapterId) {
    store.dispatch(uiActions.setPreviewRegen(null));
    store.dispatch(notificationsActions.pushToast({ kind: 'info', message: 'This preview was resolved elsewhere', dedupeKey: 'preview-resolved-elsewhere' }));
  }
  return result;
};
