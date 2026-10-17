/* #3400 pass 6 — while a book's chapter restructure is in flight, nothing but
   the restructure (and its remap save) writes that book. The restructure
   re-keys every sentence server-side; an edit made meanwhile is built from the
   old chapter ids and would land on disk after the route's rewrite. Refusing
   the ACTION (not just its save) keeps the in-memory manuscript from diverging
   from disk. First in the chain, so the persistence middleware never sees a
   refused action. The remap (`applyChapterRestructure`) and the hydrate / upload
   / reset actions are not edits and pass.

   A refusal is a BACKSTOP, not the UX: the surfaces that dispatch these actions
   disable themselves and check `selectEditsLocked` before their side writes
   (restructure-lock.ts). If one still gets here, it toasts rather than vanish. */

import type { Middleware } from '@reduxjs/toolkit';
import type { RootState } from './index';
import { notificationsActions } from './notifications-slice';
import { RESTRUCTURING_TOAST_KEY, RESTRUCTURING_TOAST_MESSAGE } from './restructure-lock';

export const REFUSED_WHILE_RESTRUCTURING: ReadonlySet<string> = new Set(
  [
    'setSentenceCharacter',
    'setSentencesCharacterBulk',
    'undoBulkReassign',
    'setSentenceExcluded',
    'setSentenceText',
    'setSentenceEmotion',
    'setSentenceInstruct',
    'applyDetectedEmotions',
    'applyDetectedInstruct',
    'setSentencesCharacter',
    'splitSentence',
    'mergeSentences',
    'promoteSentenceToTitle',
    'applyReupload',
  ].map((name) => `manuscript/${name}`),
);

export const restructureGuardMiddleware: Middleware = (store) => (next) => (action) => {
  const type = (action as { type?: string } | null)?.type;
  if (type && REFUSED_WHILE_RESTRUCTURING.has(type)) {
    const s = store.getState() as RootState;
    const bookId = s.manuscript?.bookId;
    if (bookId && s.ui?.restructuringBooks?.[bookId]) {
      store.dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message: RESTRUCTURING_TOAST_MESSAGE,
          dedupeKey: RESTRUCTURING_TOAST_KEY,
        }),
      );
      return undefined;
    }
  }
  return next(action);
};
