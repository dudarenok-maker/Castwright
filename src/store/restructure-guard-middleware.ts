/* #3400 pass 6 — while a book's chapter restructure is in flight, nothing but
   the restructure (and its remap save) writes that book. The restructure
   re-keys every sentence server-side; an edit made meanwhile is built from the
   old chapter ids and would land on disk after the route's rewrite. Refusing
   the ACTION (not just its save) keeps the in-memory manuscript from diverging
   from disk. First in the chain, so the persistence middleware never sees a
   refused action. The remap (`applyChapterRestructure`) and the hydrate / upload
   / reset actions are not edits and pass. */

import type { Middleware } from '@reduxjs/toolkit';
import type { RootState } from './index';

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
    if (bookId && s.ui?.restructuringBooks?.[bookId]) return undefined;
  }
  return next(action);
};
