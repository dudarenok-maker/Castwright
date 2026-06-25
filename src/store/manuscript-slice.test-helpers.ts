/* Shared test helpers for manuscript-slice tests.
   Extracted from manuscript-slice.test.ts so Task 2+ can reuse start()
   without duplicating the scaffold. */

import { manuscriptSlice, manuscriptActions } from './manuscript-slice';

/** Build a real ManuscriptState with manuscriptId set + the given sentences
 *  present. `manuscriptId: 'm1'` ensures hydrateFromAnalysis takes the
 *  merge/append branch (not the wholesale-replace branch). */
export function start(
  sentencesArray: Array<{
    id: number;
    chapterId: number;
    characterId: string;
    text: string;
    emotion?: string;
    instruct?: string;
    vocalization?: boolean;
  }>,
) {
  return manuscriptSlice.reducer(
    {
      ...manuscriptSlice.reducer(undefined, manuscriptActions.reset()),
      manuscriptId: 'm1',
      bookId: 'b1',
      sentences: sentencesArray,
    } as never,
    { type: '@@noop' } as never,
  );
}
