/* fs-58 — reusable script-review thunk.
   Extracted from handleReviewScript (manuscript.tsx) so the review-progress
   pill in the analysis substage pill ladder can be driven from a single place.

   Dispatches setActive on entry, updateProgress from each onPhase callback,
   and clear in finally (success and error paths alike). */

import type { AppDispatch, RootState } from './index';
import { api } from '../lib/api';
import { planApply, type ReviewOp } from '../lib/script-review-apply';
import { scriptReviewActions, opKey, type ReviewOpWithChapter } from './script-review-slice';
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
  dispatch(scriptReviewActions.setActive({ bookId, progress: 0, label: 'Reviewing script' }));
  try {
    await api.reviewScript(bookId, {
      ...(wholeBook ? {} : { chapterId }),
      model,
      onPhase: ({ progress, label, chapterIndex, totalChapters, estRemainingMs }) =>
        dispatch(
          scriptReviewActions.updateProgress({
            bookId,
            progress,
            label,
            chapterIndex,
            totalChapters,
            estRemainingMs,
          }),
        ),
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

const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']);

interface ManuscriptCastSnapshot {
  sentences: ReviewLiveSentence[];
  characterIds: Set<string>;
  manuscriptId: string;
}

function snapshotIfReady(getState: () => RootState): ManuscriptCastSnapshot | null {
  const state = getState();
  const manuscriptId = state.manuscript.manuscriptId;
  const characters = state.cast?.characters;
  if (!manuscriptId || !characters) return null;
  return {
    manuscriptId,
    characterIds: new Set(characters.map((c) => c.id)),
    sentences: state.manuscript.sentences.map((s) => ({
      id: s.id,
      chapterId: s.chapterId,
      text: s.text,
      characterId: s.characterId,
      instruct: s.instruct,
      vocalization: s.vocalization,
    })),
  };
}

/** Resolves once the manuscript + cast for the CURRENT book are loaded.
    Guards against the false-zero-badge bug: hydrating before either is
    ready would make planApply mark every op unappliable (design spec §4.3). */
function waitForManuscriptAndCast(
  getState: () => RootState,
  subscribe: (listener: () => void) => () => void,
): Promise<ManuscriptCastSnapshot> {
  return new Promise((resolve) => {
    const immediate = snapshotIfReady(getState);
    if (immediate) {
      resolve(immediate);
      return;
    }
    const unsubscribe = subscribe(() => {
      const snapshot = snapshotIfReady(getState);
      if (snapshot) {
        unsubscribe();
        resolve(snapshot);
      }
    });
  });
}

/** Reconciliation entry point — called on mount (Task 10) to hydrate a
    book's script-review bucket from the persisted server ledger. */
export async function hydrateScriptReview(
  bookId: string,
  opts: { dispatch: AppDispatch; getState: () => RootState; subscribe: (listener: () => void) => () => void },
): Promise<void> {
  const { dispatch, getState, subscribe } = opts;
  const state = await api.getScriptReviewState(bookId);
  if (state.kind === 'running') return; // Task 9 handles this branch.
  const chapterEntries = Object.entries(state.entries);
  if (chapterEntries.length === 0) return;

  const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe);

  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};
  const persistedSelected: Record<string, boolean> = {};
  for (const [chapterKey, entry] of chapterEntries) {
    const chapterId = Number(chapterKey);
    versionByChapter[chapterId] = entry.version;
    for (const op of entry.ops as ReviewOp[]) allOps.push({ ...op, chapterId });
    Object.assign(persistedSelected, entry.selected);
  }

  const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
    appliable: ReviewOpWithChapter[];
    unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
  };
  const selected: Record<string, boolean> = {};
  for (const o of appliable) {
    const key = opKey(o.chapterId, o.id, o.op);
    selected[key] = key in persistedSelected ? persistedSelected[key] : !DEFAULT_OFF.has(o.op);
  }

  dispatch(scriptReviewActions.hydrateBucket({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter, selected }));
}
