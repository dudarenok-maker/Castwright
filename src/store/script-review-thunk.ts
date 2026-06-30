/* fs-58 — reusable script-review thunk.
   Extracted from handleReviewScript (manuscript.tsx) so the review-progress
   pill in the analysis substage pill ladder can be driven from a single place.

   Dispatches setActive on entry, updateProgress from each onPhase callback,
   and clear in finally (success and error paths alike). */

import type { AppDispatch } from './index';
import { api } from '../lib/api';
import { planApply, type ReviewOp } from '../lib/script-review-apply';
import { scriptReviewActions, type ReviewOpWithChapter } from './script-review-slice';
import { notificationsActions } from './notifications-slice';

/** Minimal sentence shape required for planApply's index-map (matches Sentence from api-types). */
export interface ReviewLiveSentence {
  id: number;
  chapterId: number;
  text: string;
  characterId: string;
  instruct?: string;
  vocalization?: boolean;
}

export interface RunReviewScriptOpts {
  dispatch: AppDispatch;
  wholeBook: boolean;
  chapterId?: number;
  model: string;
  /** Live sentences for index-mapped planApply (caller passes sentencesRef.current). */
  sentences: ReviewLiveSentence[];
  /** Character IDs present in the cast — passed to planApply's roster set. */
  characterIds: Set<string>;
}

export async function runReviewScript(bookId: string, opts: RunReviewScriptOpts): Promise<void> {
  const { dispatch, wholeBook, chapterId, model, sentences, characterIds } = opts;
  const allOps: ReviewOpWithChapter[] = [];
  const failed: Array<{ chapterId: number; message: string }> = [];
  dispatch(scriptReviewActions.setActive({ bookId, progress: 0, label: 'Reviewing' }));
  try {
    await api.reviewScript(bookId, {
      ...(wholeBook ? {} : { chapterId }),
      model,
      onPhase: ({ progress }: { progress: number }) =>
        dispatch(scriptReviewActions.updateProgress({ bookId, progress })),
      onOps: ({ chapterId: chId, ops }: { chapterId: number; ops: ReviewOp[] }) => {
        for (const op of ops) allOps.push({ ...op, chapterId: chId });
      },
      onChapterFailed: (e: { chapterId: number; message: string }) => failed.push(e),
    });
    /* fs-58 Task 11 — run planApply at seed time so ops that can't be
       resolved against the LIVE sentences (stale ids, missing anchors,
       invalid merges) land in `unappliable` rather than appearing as
       selectable no-ops in the diff modal. The Apply-time planApply in
       the modal stays — it's the TOCTOU re-validation for any edits
       that arrived between stream-complete and the user clicking Accept. */
    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    if (appliable.length === 0 && unappliable.length === 0 && failed.length > 0) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'warn',
          message:
            failed.length === 1
              ? failed[0].message
              : `${failed.length} chapters couldn't be reviewed (too large or failed).`,
        }),
      );
    } else {
      if (failed.length > 0) {
        dispatch(
          notificationsActions.pushToast({
            kind: 'warn',
            message: `${failed.length} chapter(s) skipped; showing the rest.`,
          }),
        );
      }
      dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable }));
    }
  } catch (err) {
    dispatch(
      notificationsActions.pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Script review failed.',
      }),
    );
  } finally {
    dispatch(scriptReviewActions.clear({ bookId }));
  }
}
