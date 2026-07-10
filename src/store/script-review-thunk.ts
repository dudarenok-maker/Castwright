/* fs-58 — reusable script-review thunk.
   Extracted from handleReviewScript (manuscript.tsx) so the review-progress
   pill in the analysis substage pill ladder can be driven from a single place.

   Dispatches setActive on entry, updateProgress from each onPhase callback,
   and clear in finally (success and error paths alike). */

import type { AppDispatch, RootState } from './index';
import { api, ReviewScriptError, type LedgerEntryDTO } from '../lib/api';
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
    if (!(err instanceof ReviewScriptError && err.code === 'cancelled')) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Script review failed.',
        }),
      );
    }
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
  chapterId?: number;
  replay: {
    lastPhase: { progress: number; label: string; chapterIndex?: number; totalChapters?: number; estRemainingMs?: number } | null;
  };
}

/** Transform+dispatch a book's ledger entries into its scriptReview bucket.
    Pure — takes the entries and an already-resolved manuscript/cast
    snapshot as plain arguments, and does no fetching of its own. This is
    what makes it callable from both hydrateScriptReview's top block
    (which already has both in scope from its own GET /state +
    waitForManuscriptAndCast calls) and attachToRunningReview's 404
    fallback below (which has no getState/subscribe in scope, but already
    receives sentences/characterIds/manuscriptId directly in its own opts
    — see design spec §4.2). No-ops on an empty entries map. */
function hydrateLedgerIntoBucket(
  bookId: string,
  entries: Record<string, LedgerEntryDTO>,
  snapshot: { dispatch: AppDispatch; sentences: ReviewLiveSentence[]; characterIds: Set<string>; manuscriptId: string },
): void {
  const { dispatch, sentences, characterIds, manuscriptId } = snapshot;
  const chapterEntries = Object.entries(entries);
  if (chapterEntries.length === 0) return;

  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};
  const persistedSelected: Record<string, boolean> = {};
  for (const [chapterKey, entry] of chapterEntries) {
    const chapterId = Number(chapterKey);
    versionByChapter[chapterId] = entry.version;
    for (const op of entry.ops as unknown as ReviewOp[]) allOps.push({ ...op, chapterId });
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
  const allOps: ReviewOpWithChapter[] = [];
  const versionByChapter: Record<number, number> = {};

  try {
    const result = await api.attachScriptReview(bookId, {
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
    if (result === null) {
      // TOCTOU: the job finished between GET /state and this join — fall
      // back to a plain ledger re-read instead of silently starting a
      // fresh review (design spec §4.2).
      const freshState = await api.getScriptReviewState(bookId);
      hydrateLedgerIntoBucket(bookId, freshState.entries, { dispatch, sentences, characterIds, manuscriptId });
      return;
    }
    const { appliable, unappliable } = planApply(allOps, sentences, characterIds) as {
      appliable: ReviewOpWithChapter[];
      unappliable: Array<{ op: ReviewOpWithChapter; reason: string }>;
    };
    dispatch(scriptReviewActions.setReview({ bookId, ops: appliable, unappliable, manuscriptId, versionByChapter }));
  } catch (err) {
    // Cancellation (fs-58 follow-up #1481) is a normal, silent terminal
    // state, not a failure — mirrors detect-emotions-button.tsx's silent
    // AbortError handling and analysis-stream-middleware.ts's
    // code==='aborted' handling. Deliberately NO finally/clear here — see
    // the module-level comment above this function for why.
    if (err instanceof ReviewScriptError && err.code === 'cancelled') return;
    dispatch(
      notificationsActions.pushToast({
        kind: 'error',
        message: err instanceof Error ? err.message : 'Script review failed.',
      }),
    );
  }
}

const DEFAULT_OFF = new Set(['reattribute', 'flag_nonstory']);

interface ManuscriptCastSnapshot {
  sentences: ReviewLiveSentence[];
  characterIds: Set<string>;
  manuscriptId: string;
}

function snapshotIfReady(getState: () => RootState, bookId: string): ManuscriptCastSnapshot | null {
  const state = getState();
  const manuscriptId = state.manuscript.manuscriptId;
  const characters = state.cast?.characters;
  if (!manuscriptId || !characters) return null;
  // Cross-book race guard (PR review round 4): manuscript/cast are global
  // slices, not book-scoped. If the caller's book was switched away from
  // while this hydration was waiting, state.manuscript could now belong to
  // a DIFFERENT book entirely — mirror the same manuscript.bookId===bookId
  // guard src/routes/index.tsx already uses for this identical race,
  // rather than risk stamping this book's script-review bucket with
  // another book's live sentences/cast.
  if (state.manuscript.bookId !== bookId) return null;
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
  bookId: string,
): Promise<ManuscriptCastSnapshot> {
  return new Promise((resolve) => {
    const immediate = snapshotIfReady(getState, bookId);
    if (immediate) {
      resolve(immediate);
      return;
    }
    const unsubscribe = subscribe(() => {
      const snapshot = snapshotIfReady(getState, bookId);
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
    const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe, bookId);
    hydrateLedgerIntoBucket(bookId, state.entries, { dispatch, sentences, characterIds, manuscriptId });
  }

  if (state.kind === 'running') {
    // Finding 6 (PR review round 4): two different chapters' single-chapter
    // reviews can legitimately run concurrently for the same book — the
    // server now reports every currently-running job in `state.running`
    // rather than just the first match. Attach to ALL of them, in parallel.
    // Each call is independently scoped to its own chapter/job with its own
    // local allOps/versionByChapter accumulator and its own eventual
    // setReview dispatch, which already correctly MERGES by chapter rather
    // than replacing — running them concurrently does not reintroduce the
    // double-counting risk the single-job version was written to avoid.
    //
    // Findings 1/2 (PR review round 5): setActive/clear and
    // waitForManuscriptAndCast used to live INSIDE attachToRunningReview
    // (dispatched once per job), which broke on 2+ concurrent jobs for the
    // same book — activeStreams is keyed only by bookId, so the FASTEST job
    // to finish cleared the shared "review in progress" flag while a
    // sibling job was still genuinely streaming, silently re-enabling the
    // Review Script button mid-run. Both are hoisted here so they run
    // exactly ONCE per hydration batch: setActive is dispatched before any
    // job starts (seeded from the first job's replay — a reasonable initial
    // value; onPhase from whichever job fires next keeps it live),
    // waitForManuscriptAndCast's snapshot is shared by every job in the
    // batch instead of being re-subscribed/re-mapped per job, and clear
    // only fires once ALL jobs in the batch have settled (Promise.all),
    // not after the first one to finish.
    // running.replay is `{[key: string]: unknown}` on the generated
    // ScriptReviewRunningJob schema (openapi.yaml deliberately keeps it
    // permissive rather than modeling its actual shape — see the ops/replay
    // additionalProperties comments in openapi.yaml) —
    // attachToRunningReview's RunningReviewState narrows it to just the
    // `lastPhase` field it actually reads (see the comment above that
    // function for why). The server's actual replay object structurally
    // satisfies this narrower shape; the cast just recovers that at the
    // type level since the generated schema itself only guarantees an
    // unknown-valued object.
    const seedPhase = (state.running[0] as RunningReviewState | undefined)?.replay.lastPhase;
    dispatch(
      scriptReviewActions.setActive({
        bookId,
        progress: seedPhase?.progress ?? 0,
        label: seedPhase?.label ?? 'Reviewing script',
      }),
    );
    const { sentences, characterIds, manuscriptId } = await waitForManuscriptAndCast(getState, subscribe, bookId);
    try {
      await Promise.all(
        state.running.map((running) =>
          attachToRunningReview(bookId, running as RunningReviewState, { dispatch, sentences, characterIds, manuscriptId }),
        ),
      );
    } finally {
      dispatch(scriptReviewActions.clear({ bookId }));
    }
  }
}
