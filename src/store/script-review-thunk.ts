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
  /** The book's current manuscriptId (design spec §4.2) — stamped onto the
      setReview dispatch at the end of the run, alongside the versions
      accumulated from onCheckpoint below, so the bucket carries the same
      identifiers the ledger does. */
  manuscriptId: string;
}

export async function runReviewScript(bookId: string, opts: RunReviewScriptOpts): Promise<void> {
  const { dispatch, wholeBook, chapterId, model, sentences, characterIds, manuscriptId } = opts;
  const allOps: ReviewOpWithChapter[] = [];
  const failed: Array<{ chapterId: number; message: string }> = [];
  const versionByChapter: Record<number, number> = {};
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
      onCheckpoint: ({ chapterId: chId, version }: { chapterId: number; version: number }) => {
        versionByChapter[chId] = version;
      },
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
      dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter }));
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

// Deliberately narrow — this is NOT the full GET /state running shape
// (that's Task 4's ScriptReviewReplayState, which also carries opsEvents/
// checkpointEvents/result/errorEvent). attachToRunningReview only ever
// reads `lastPhase` (for the progress seed); it must get its ops/versions
// exclusively from the join POST's own replay, never from this snapshot
// (see the comment above attachToRunningReview for why). Only declaring
// the field this function actually uses closes off a future "helpfully"
// reading opsEvents/checkpointEvents here and reintroducing the
// double-count this task exists to fix — the wider server response object
// still satisfies this narrower type structurally, so no caller changes.
interface RunningReviewState {
  kind: 'running';
  chapterId?: number;
  replay: {
    lastPhase: { progress: number; label: string; chapterIndex?: number; totalChapters?: number; estRemainingMs?: number } | null;
  };
}

/** Reattach to a job already running server-side (design spec §4.1/§4.3) —
    e.g. after a reload mid-review. Seeds ONLY the progress pill from the
    replay's lastPhase (never progress:0, which would visibly reset it) —
    it deliberately does NOT seed `allOps`/`versionByChapter` from
    `running.replay` before joining. The join POST below re-subscribes via
    Task 2's join-or-create route, and Task 2's `attachSubscriber` ALREADY
    replays every buffered `ops`/`checkpoint` event to a newly-joining
    subscriber through these same `onOps`/`onCheckpoint` callbacks — so
    seeding from the snapshot AND joining would double-count every
    pre-reattach op (each op ends up in `allOps` twice: once from the GET
    /state snapshot, once from the join's own replay). Relying on the
    join's replay alone is both correct and simpler: by the time
    `api.reviewScript` resolves, `allOps`/`versionByChapter` hold each
    chapter's ops/version exactly once, whether they arrived via replay or
    live streaming after that. */
export async function attachToRunningReview(
  bookId: string,
  running: RunningReviewState,
  opts: { dispatch: AppDispatch; sentences: ReviewLiveSentence[]; characterIds: Set<string>; manuscriptId: string },
): Promise<void> {
  const { dispatch, sentences, characterIds, manuscriptId } = opts;
  const seedProgress = running.replay.lastPhase?.progress ?? 0;
  dispatch(
    scriptReviewActions.setActive({ bookId, progress: seedProgress, label: running.replay.lastPhase?.label ?? 'Reviewing script' }),
  );

  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};

  try {
    await api.reviewScript(bookId, {
      ...(running.chapterId !== undefined ? { chapterId: running.chapterId } : {}),
      onPhase: ({ progress, label, chapterIndex, totalChapters, estRemainingMs }) =>
        dispatch(
          scriptReviewActions.updateProgress({ bookId, progress, label, chapterIndex, totalChapters, estRemainingMs }),
        ),
      onOps: ({ chapterId, ops }: { chapterId: number; ops: ReviewOp[] }) => {
        for (const op of ops) allOps.push({ ...op, chapterId });
      },
      onChapterFailed: () => {},
      onCheckpoint: ({ chapterId, version }: { chapterId: number; version: number }) => {
        versionByChapter[chapterId] = version;
      },
    });
    // The join-or-create route (Task 2) attaches this call as a subscriber
    // to the SAME job (assuming it's still running — see the known TOCTOU
    // caveat below) and Task 2's attachSubscriber replays every buffered
    // event before any live ones, so by the time api.reviewScript resolves
    // allOps/versionByChapter hold every chapter's ops/version exactly once.
    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter }));
  } finally {
    dispatch(scriptReviewActions.clear({ bookId }));
  }
}

// Known, accepted limitation — a narrow reattach race. There's a TOCTOU
// window between hydrateScriptReview's GET /state call (which reports
// kind: 'running') and this function's join POST: if the job finishes in
// that gap, Task 2's registry no longer has an entry to join, and the POST
// falls through to *create* a fresh job — silently starting a full
// re-review instead of attaching. This is a narrow, low-probability race
// (the window is a network round-trip plus waitForManuscriptAndCast, not
// the whole review duration), and its worst case is wasted analyzer time
// on an already-mostly-complete book, not data loss — every chapter that
// job had already checkpointed is still safely in the ledger regardless.
// Building a dedicated attach-only endpoint to close this race entirely is
// out of scope for this plan; call it out explicitly here rather than
// leaving it undiscovered, matching this plan's practice elsewhere (e.g.
// §3's accepted full-server-restart data loss) of naming known gaps
// instead of silently absorbing them.

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

/** Discards the persisted ledger for the given chapters, then removes just
    those chapters from the client-side bucket — NOT the whole bucket, since
    the bucket can hold other chapters' still-unresolved, still-persisted
    findings (e.g. a re-run confirm gate discarding one chapter out of a
    whole-book review's results). See removeChaptersLocally. */
export async function discardReview(
  bookId: string,
  chapterIds: number[],
  opts: { dispatch: AppDispatch },
): Promise<void> {
  await api.discardScriptReview(bookId, chapterIds);
  opts.dispatch(scriptReviewActions.removeChaptersLocally({ bookId, chapterIds }));
}

/** Reconciliation entry point — called on mount (Task 10) to hydrate a
    book's script-review bucket from the persisted server ledger. */
export async function hydrateScriptReview(
  bookId: string,
  opts: { dispatch: AppDispatch; getState: () => RootState; subscribe: (listener: () => void) => () => void },
): Promise<void> {
  const { dispatch, getState, subscribe } = opts;
  const state = await api.getScriptReviewState(bookId);

  // Finding 2 (PR review round 3): hydrate whatever is currently persisted
  // in the ledger FIRST, even when a job is also running — otherwise
  // chapters outside the running job's own scope would be invisible to the
  // client for the job's entire duration (this let a user start a fresh
  // review for a chapter whose findings were still sitting unresolved
  // server-side, silently overwriting them). setReview's own per-chapter
  // merge (see the earlier whole-branch-review fix) means the running
  // job's eventual setReview dispatch below layers cleanly on top of this
  // without disturbing it.
  const chapterEntries = Object.entries(state.entries);
  if (chapterEntries.length > 0) {
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

  if (state.kind === 'running') {
    const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe);
    // state.replay is `unknown` on the wire DTO (api.ts's ScriptReviewStateDTO)
    // — attachToRunningReview's RunningReviewState narrows it to just the
    // `lastPhase` field it actually reads (see the comment above that
    // function for why). The server's actual replay object structurally
    // satisfies this narrower shape; the cast just recovers that at the
    // type level since the DTO itself only guarantees `unknown`.
    await attachToRunningReview(bookId, state as RunningReviewState, { dispatch, sentences, characterIds, manuscriptId });
  }
}
