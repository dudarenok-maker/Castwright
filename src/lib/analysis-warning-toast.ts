/* #3084 — the non-fatal "front-matter detection fell back for the whole run"
   advisory (server: NONSTORY_OVERFLOW_WARNING_CODE in routes/analysis.ts).

   The Analysing view surfaces every `warning` frame itself; this handler
   exists for the stream owners that are NOT that view — the analysis-stream
   middleware (user navigated away) and the Generate view's subset
   Re-analyse / Include calls. Without it the advisory is dropped whenever
   the Analysing view is not mounted. It pushes the SAME toast (kind 'warn',
   dedupeKey = the code) the view pushes, so a view + middleware double
   delivery collapses to one toast. Other warning codes are deliberately
   left to the view. */

import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';
import { notificationsActions } from '../store/notifications-slice';

export const NONSTORY_OVERFLOW_WARNING_CODE = 'analyzer-reasoning-overflow-nonstory';

export function deliverNonStoryOverflowWarning(
  dispatch: Dispatch<UnknownAction>,
  { code, message }: { code: string; message: string },
): void {
  if (code !== NONSTORY_OVERFLOW_WARNING_CODE) return;
  dispatch(notificationsActions.pushToast({ kind: 'warn', message, dedupeKey: code }));
}
