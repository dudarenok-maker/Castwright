/* fs-58 — ScriptReviewDiff modal.
   Shows the LLM script-review suggestions bucketed by op class (strip_tag,
   fix_emotion, split, etc.), lets the user select/deselect individual ops or
   whole classes, then applies the selected set via planApply +
   dispatchAcceptedOps. Mirrors drift-report.tsx overlay pattern. */

import { useEffect, useRef, useState } from 'react';
import type { Dispatch } from '@reduxjs/toolkit';
import { Checkbox } from './primitives';
import { useAppDispatch, useAppSelector } from '../store';
import {
  scriptReviewActions,
  selectActiveReview,
  opKey,
  type ReviewOpWithChapter,
} from '../store/script-review-slice';
import { planApply, dispatchAcceptedOps } from '../lib/script-review-apply';
import { discardReview } from '../store/script-review-thunk';
import { applyProposedReattributions } from '../lib/apply-proposed';
import { changeLogActions } from '../store/change-log-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { castActions } from '../store/cast-slice';
import { notificationsActions } from '../store/notifications-slice';
import { api } from '../lib/api';
import { CreateCharacterForm } from './create-character-form';
import { IconClose } from '../lib/icons';
import { engineForModelKey } from '../lib/tts-models';
import { sampleModelKeyForEngine } from '../lib/tts-voice-mapping';
import type { TtsModelKey } from '../lib/types';

/* Human-readable class labels. */
const CLASS_LABELS: Record<string, string> = {
  strip_tag: 'Strip tag',
  split: 'Split sentence',
  extract_dialogue: 'Extract dialogue',
  merge: 'Merge sentences',
  fix_emotion: 'Fix emotion',
  validate_instruct: 'Instruct',          // fs-58 validate_instruct
  reattribute: 'Reattribute speaker',     // fs-58 Unit B
  flag_nonstory: 'Exclude non-story',     // fs-58 Unit B
};

function classLabel(op: string): string {
  return CLASS_LABELS[op] ?? op;
}

/** fs-63 — push the off-roster "Design now" nudge, gated to a Qwen project.
    Exported (and pure-ish: side effect is the single dispatch) so it's unit
    testable without driving the confirm UI. No-op on preset engines or an
    empty batch. */
export function maybePushVoiceNudge(
  dispatch: Dispatch,
  args: { ttsModelKey: TtsModelKey; startBookId: string; createdCharacters: { id: string; name: string }[] },
): void {
  const { ttsModelKey, startBookId, createdCharacters } = args;
  if (createdCharacters.length === 0) return;
  if (engineForModelKey(ttsModelKey) !== 'qwen') return;
  dispatch(
    notificationsActions.pushToast({
      kind: 'info',
      message:
        createdCharacters.length > 1
          ? `${createdCharacters.length} new characters need voices`
          : `New character «${createdCharacters[0].name}» needs a voice`,
      dedupeKey: `off-roster-voice-nudge:${startBookId}`,
      nudge: {
        bookId: startBookId,
        characterIds: createdCharacters.map((c) => c.id),
        modelKey: sampleModelKeyForEngine('qwen', ttsModelKey),
        names: createdCharacters.map((c) => c.name),
      },
    }),
  );
}

/* Format the before → after preview for a single op row. `before` is the
   live sentence text (the original) when available, so strip_tag shows the
   tagged source struck-through next to the cleaned result. */
function OpPreview({
  op,
  before,
  liveInstruct,
  liveVocalization,
}: {
  op: ReviewOpWithChapter;
  before?: string;
  liveInstruct?: string;
  liveVocalization?: boolean;
}) {
  void liveVocalization;
  if (op.op === 'validate_instruct') {
    if (op.newInstruct !== undefined) {
      const after = op.newInstruct.trim() === '' ? '(stripped)' : op.newInstruct;
      return (
        <span className="text-xs text-ink/70 min-w-0 truncate">
          instruct: <span className="line-through text-ink/45">{liveInstruct ?? '(none)'}</span>
          {' → '}
          <span className="text-ink font-medium">{after}</span>
        </span>
      );
    }
    if (op.newVocalizationText !== undefined) {
      return (
        <span className="text-xs text-ink/70 min-w-0 truncate">
          {before !== undefined && before !== op.newVocalizationText && (
            <>
              <span className="line-through text-ink/45">{before}</span>
              {' → '}
            </>
          )}
          <span className="text-ink font-medium">{op.newVocalizationText}</span>
        </span>
      );
    }
    return null;
  }
  if (op.op === 'strip_tag' && op.newText !== undefined) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        {before !== undefined && before !== op.newText && (
          <>
            <span className="line-through text-ink/45">{before}</span>
            {' → '}
          </>
        )}
        <span className="text-ink font-medium">{op.newText}</span>
      </span>
    );
  }
  if (op.op === 'fix_emotion' && op.emotion) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        emotion → <span className="font-semibold text-ink">{op.emotion}</span>
      </span>
    );
  }
  if (op.op === 'merge' && op.mergeIds) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        merge sentences {op.mergeIds.join(', ')}
      </span>
    );
  }
  if ((op.op === 'split' || op.op === 'extract_dialogue') && op.anchor) {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        split at: <span className="font-medium text-ink">{op.anchor}</span>
      </span>
    );
  }
  if (op.op === 'reattribute') {
    const target = op.characterId ?? (op.proposed ? `+ new: «${op.proposed.name}»` : '?');
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        reassign → <span className="font-semibold text-ink">{target}</span>
      </span>
    );
  }
  if (op.op === 'flag_nonstory') {
    return (
      <span className="text-xs text-ink/70 min-w-0 truncate">
        exclude: {before !== undefined && <span className="line-through text-ink/45">{before}</span>}
      </span>
    );
  }
  return null;
}

/* fs-58 Unit B — one entry in the per-op confirm queue. We carry the ORIGINAL
   proposed op plus the operator's final decision so the helper sees either a
   (possibly edited) proposed name OR a rewrite to an existing roster member. */
type FinalizedProposed = ReviewOpWithChapter;

/* fs-58 persistence Task 13 — mirror a batch of already-applied ops into the
   server ledger (design spec §4.2's per-chapter /resolve) and, on success,
   remove exactly those ops from the local bucket via resolveOpsLocally. This
   is what replaced the old handleApply tail's whole-bucket `clearReview` —
   that call deleted every op in the bucket, including ones the user left
   unchecked, which is the silent-data-loss bug this plan exists to fix. A
   chapter missing from `versionByChapter` (no ledger entry to resolve
   against) is skipped rather than resolved — nothing local changes for it. */
async function resolveAppliedOps(
  dispatch: Dispatch,
  bookId: string,
  bucket: { versionByChapter: Record<number, number> },
  appliedOps: ReviewOpWithChapter[],
): Promise<void> {
  const byChapter = new Map<number, string[]>();
  for (const op of appliedOps) {
    const key = opKey(op.chapterId, op.id, op.op);
    byChapter.set(op.chapterId, [...(byChapter.get(op.chapterId) ?? []), key]);
  }
  for (const [chapterId, opKeys] of byChapter) {
    const version = bucket.versionByChapter[chapterId];
    if (version === undefined) continue;
    const result = await api.resolveScriptReviewOps(bookId, { chapterId, version, appliedOpKeys: opKeys });
    if (result.ok) dispatch(scriptReviewActions.resolveOpsLocally({ bookId, opKeys }));
  }
}

export function ScriptReviewDiff({ bookId }: { bookId: string }) {
  const dispatch = useAppDispatch();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = useAppSelector((s) => selectActiveReview(s as any, bookId));
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const cast = useAppSelector((s) => s.cast?.characters ?? []);
  // Live book id of the active `ready` stage — used by the book-switch guard.
  // Tracked through a ref so the async helper sees the CURRENT value, not the
  // one captured when handleApply was first invoked.
  const stageBookId = useAppSelector((s) =>
    s.ui.stage.kind === 'ready' ? s.ui.stage.bookId : undefined,
  );
  const stageBookIdRef = useRef(stageBookId);
  stageBookIdRef.current = stageBookId;
  const ttsModelKey = useAppSelector((s) => s.ui.ttsModelKey);

  /* The confirm queue. While `confirm` is non-null we overlay a
     CreateCharacterForm for `confirm.queue[confirm.index]`. Direct ops are
     already applied by the time this is set; only the off-roster reattributes
     are pending here. */
  const [confirm, setConfirm] = useState<{
    queue: ReviewOpWithChapter[];
    index: number;
    finalized: FinalizedProposed[];
    startBookId: string;
  } | null>(null);

  /* fs-58 persistence Task 12 — "Dismiss all" is destructive (discards the
     persisted ledger via discardReview), so it requires this confirm step
     before firing. Close/backdrop stay non-destructive (handleClose below)
     and never touch this state. */
  const [confirmDismiss, setConfirmDismiss] = useState(false);

  /* fs-58 persistence Task 13 — debounce the selection PATCH per chapter so a
     burst of checkbox toggles collapses into one network call. Keyed by
     chapterId (not a single timer) so toggles across different chapters
     don't cancel each other's pending sync. */
  const selectionSyncTimers = useRef<Record<number, ReturnType<typeof setTimeout>>>({});

  /* Clear any pending debounced-PATCH timers on unmount — otherwise a
     scheduled selection sync can fire after the modal has closed (e.g. the
     user hides it right after toggling a checkbox), which combined with
     mount-time re-hydration could cause a brief selection flicker. */
  useEffect(() => {
    const timers = selectionSyncTimers.current;
    return () => {
      for (const id of Object.values(timers)) clearTimeout(id);
    };
  }, []);

  if (!bucket) return null;

  const { ops, selected, unappliable } = bucket;

  /* Group ops by their class. Preserve insertion order so the class list is
     deterministic. */
  const classes = [...new Set(ops.map((o) => o.op))];
  const byClass = new Map<string, ReviewOpWithChapter[]>();
  for (const cls of classes) {
    byClass.set(cls, ops.filter((o) => o.op === cls));
  }

  const selectedCount = ops.filter((o) => selected[opKey(o.chapterId, o.id, o.op)]).length;

  /* fs-58 persistence Task 13 — mirror the operator's checkbox state to the
     server (design spec §6.5's selection PATCH) 500ms after the last toggle
     for that chapter, so the persisted ledger stays in sync with what the
     modal shows without a round-trip on every click. */
  function scheduleSelectionSync(chapterId: number, currentSelected: Record<string, boolean>) {
    clearTimeout(selectionSyncTimers.current[chapterId]);
    selectionSyncTimers.current[chapterId] = setTimeout(() => {
      const version = bucket?.versionByChapter[chapterId];
      if (version === undefined) return;
      const chapterSelected: Record<string, boolean> = {};
      for (const op of ops) {
        if (op.chapterId !== chapterId) continue;
        chapterSelected[opKey(op.chapterId, op.id, op.op)] = !!currentSelected[opKey(op.chapterId, op.id, op.op)];
      }
      void api.patchScriptReviewSelection(bookId, { chapterId, version, selected: chapterSelected });
    }, 500);
  }

  function handleClose() {
    dispatch(scriptReviewActions.hideReview({ bookId }));
  }

  function handleDismiss() {
    setConfirmDismiss(true);
  }

  async function confirmDismissAll() {
    const chapterIds = [...new Set(ops.map((o) => o.chapterId))];
    setConfirmDismiss(false);
    await discardReview(bookId, chapterIds, { dispatch });
  }

  /* Run the finalized off-roster reattributes through the interleaved
     create→reassign helper (dedupe + book-switch guard); each applied op is
     resolved server-side one at a time via onOpApplied as it happens (fs-58
     persistence Task 14) — no whole-bucket clear at the end. Called once,
     after the LAST confirm resolves. */
  async function runProposed(finalized: FinalizedProposed[], startBookId: string) {
    const rosterByName = new Map(cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id }]));
    try {
      const { createdCharacters, aborted } = await applyProposedReattributions(finalized, {
        rosterByName,
        createCharacter: async (p) => {
          // api.createCharacter resolves to a { character } envelope — unwrap it.
          // `p` widens gender/ageRange to string (the proposed shape); the API's
          // narrower enum tolerates the values the form's <select>s produce.
          const { character } = await api.createCharacter(startBookId, p as never);
          return character;
        },
        addCharacter: (c) => dispatch(castActions.addCharacter(c as never)),
        setSentenceCharacter: (chapterId, sentenceId, characterId) =>
          dispatch(manuscriptActions.setSentenceCharacter({ chapterId, sentenceId, characterId })),
        onBoundaryMove: (chapterId) =>
          dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
        isSameBook: () => stageBookIdRef.current === startBookId,
        onOpApplied: (op) => {
          if (!bucket) return;
          void resolveAppliedOps(dispatch, startBookId, bucket, [op]);
        },
      });
      if (aborted) {
        // Book-switch guard tripped mid-batch (silent, no throw) — whatever
        // was already resolved via onOpApplied above stays resolved; hide,
        // don't discard the rest (design spec §6.5).
        setConfirm(null);
        dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
        return;
      }
      // fs-63 — on success, nudge to auto-voice any newly-created off-roster
      // character (qwen-only; no-op otherwise). Inside the try so a failed
      // create falls to the catch and never nudges.
      maybePushVoiceNudge(dispatch, { ttsModelKey, startBookId, createdCharacters });
    } catch {
      // A create failed mid-batch. Reset the confirm machine and surface a toast,
      // but DON'T clearReview — the operator can re-trigger. Re-run is safe because
      // setSentenceCharacter is idempotent for an already-applied reattribute.
      setConfirm(null);
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: "Couldn't create character",
          dedupeKey: 'create-character',
        }),
      );
      return;
    }
    setConfirm(null);
    // fs-58 persistence Task 14 — no clearReview/discard here: every applied
    // op was already resolved per-op via onOpApplied as it happened; any op
    // left in the bucket (unselected, or never reached because an earlier op
    // failed) stays, unresolved.
  }

  /* Advance the confirm queue by one finalized op. A "create new" decision is
     queued into `finalized` for the dedupe-aware helper; a "reattribute to an
     existing roster member" decision is an on-roster reassign, so it dispatches
     immediately and never enters the helper batch (the helper only handles
     proposed-name creates). When the queue is exhausted, hand the collected
     proposed batch to the helper exactly once. */
  function advanceConfirm(finalizedOp: FinalizedProposed) {
    if (finalizedOp.characterId) {
      // Reattribute-to-existing: apply directly, like an on-roster reattribute.
      dispatch(
        manuscriptActions.setSentenceCharacter({
          chapterId: finalizedOp.chapterId,
          sentenceId: finalizedOp.id,
          characterId: finalizedOp.characterId,
        }),
      );
      dispatch(changeLogActions.bumpBoundaryMove({ chapterId: finalizedOp.chapterId, count: 1 }));
    }
    setConfirm((prev) => {
      if (!prev) return prev;
      const finalized = finalizedOp.characterId
        ? prev.finalized
        : [...prev.finalized, finalizedOp];
      const nextIndex = prev.index + 1;
      if (nextIndex >= prev.queue.length) {
        void runProposed(finalized, prev.startBookId);
        // Keep `confirm` populated until runProposed resolves — every applied
        // op is resolved per-op via onOpApplied as it happens, so there's no
        // whole-bucket action to wait on; runProposed itself calls
        // setConfirm(null) once it's done (success, abort, or failure).
      }
      return { ...prev, finalized, index: nextIndex };
    });
  }

  /* Cancel mid-confirm: leave the already-applied direct ops in place, do NOT
     create any not-yet-confirmed member, and hide (not discard) the review
     bucket — whatever's left (including ops from this batch that were never
     confirmed) survives, reachable again via the badge/"Review existing"
     path (fs-58 persistence Task 14). */
  function cancelConfirm() {
    const startBookId = confirm?.startBookId ?? bookId;
    setConfirm(null);
    dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
  }

  function handleApply() {
    const startBookId = bookId;
    // Gather only the ops the user selected
    const selectedOps = ops.filter((o) => selected[opKey(o.chapterId, o.id, o.op)]);

    // Build the live snapshot for planApply
    const live = sentences.map((s) => ({
      id: s.id,
      chapterId: s.chapterId,
      text: s.text,
      characterId: s.characterId,
      instruct: s.instruct,
      vocalization: s.vocalization,
    }));

    const roster = new Set(cast.map((c) => c.id));
    const { appliable } = planApply(selectedOps, live, roster);

    // Off-roster reattributes (a proposed new name, no characterId) defer to
    // the create→reassign confirm queue; everything else applies synchronously.
    const proposedOps = appliable.filter(
      (o) => o.op === 'reattribute' && o.proposed && !o.characterId,
    ) as ReviewOpWithChapter[];
    const directOps = appliable.filter(
      (o) => !(o.op === 'reattribute' && o.proposed && !o.characterId),
    ) as ReviewOpWithChapter[];

    dispatchAcceptedOps(
      dispatch,
      directOps,
      live,
      {
        onBoundaryMove: (chapterId) =>
          dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
      },
    );
    // fs-58 persistence Task 13 — resolve directOps server-side UNCONDITIONALLY
    // whenever there are any, before the proposedOps early-return below. A
    // mixed batch (some direct ops + some off-roster proposed ops) would
    // otherwise skip past the old tail entirely and never resolve directOps.
    if (bucket && directOps.length > 0) {
      void resolveAppliedOps(dispatch, startBookId, bucket, directOps);
    }

    if (proposedOps.length > 0) {
      setConfirm({ queue: proposedOps, index: 0, finalized: [], startBookId });
      return; // the confirm queue's own cleanup (Task 14) handles this path
    }

    // fs-58 persistence Task 13 — hide the modal, don't wipe the bucket.
    // clearReview deleted the WHOLE bucket, including any op the user left
    // unchecked — the exact silent-data-loss bug this plan exists to fix.
    // hideReview only flips `visible`; anything resolveOpsLocally hasn't
    // (yet, or ever) removed stays reachable via the badge/"Review existing"
    // path (Task 11). resolveAppliedOps above is fire-and-forget (`void`), so
    // it may still be in flight here; once it resolves, resolveOpsLocally's
    // own empty-bucket cleanup (Task 6) deletes the bucket if every op ended
    // up resolved — hideReview on an already- or soon-to-be-deleted bucket is
    // a documented no-op (Task 6's reducer guards on `if (bucket)`).
    dispatch(scriptReviewActions.hideReview({ bookId: startBookId }));
  }

  // fs-58 Unit B — the active confirm-queue op (off-roster reattribute), if any.
  const confirmOp =
    confirm && confirm.index < confirm.queue.length ? confirm.queue[confirm.index] : null;
  const confirmRosterByName = new Map(
    cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id, name: c.name }]),
  );

  return (
    <>
      {/* fs-58 Unit B — per-op confirm step for off-roster reattributes. The
          operator can edit the proposed name (→ create) or, if the typed name
          matches a roster member, reattribute to the existing one instead. */}
      {confirmOp && (
        <>
          <div className="fixed inset-0 bg-ink/50 z-[60]" aria-hidden="true" />
          <div className="fixed inset-0 z-[60] grid place-items-center p-4 pointer-events-none">
            <div
              data-testid="confirm-reattribute"
              className="bg-white rounded-3xl shadow-float w-full max-w-md pointer-events-auto p-6 space-y-4"
            >
              <div>
                <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                  Confirm new speaker ({(confirm?.index ?? 0) + 1} of {confirm?.queue.length})
                </p>
                <h3 className="text-base font-bold text-ink leading-tight">
                  Reattribute ch{confirmOp.chapterId} · #{confirmOp.id}
                </h3>
              </div>
              <CreateCharacterForm
                initial={confirmOp.proposed}
                rosterByName={confirmRosterByName}
                onSubmit={(f) =>
                  advanceConfirm({ ...confirmOp, characterId: undefined, proposed: f })
                }
                onReattributeExisting={(characterId) =>
                  advanceConfirm({ ...confirmOp, proposed: undefined, characterId })
                }
                onCancel={cancelConfirm}
              />
            </div>
          </div>
        </>
      )}

      {/* fs-58 persistence Task 12 — "Dismiss all" confirm step. This is the
          sole destructive action left in this modal; close/backdrop
          (handleClose) never reach here. */}
      {confirmDismiss && (
        <>
          <div className="fixed inset-0 bg-ink/50 z-[60]" aria-hidden="true" />
          <div className="fixed inset-0 z-[60] grid place-items-center p-4 pointer-events-none">
            <div
              data-testid="dismiss-confirm"
              className="bg-white rounded-3xl shadow-float w-full max-w-sm pointer-events-auto p-6 space-y-4"
            >
              <p className="text-sm text-ink/80">
                Discard {ops.length} unresolved suggestion{ops.length === 1 ? '' : 's'}? This can&apos;t be undone.
              </p>
              <div className="flex items-center gap-3">
                <button
                  data-testid="dismiss-confirm-yes"
                  onClick={() => void confirmDismissAll()}
                  className="px-4 min-h-[44px] sm:min-h-0 py-2 rounded-full bg-ink text-canvas text-sm font-semibold"
                >
                  Discard
                </button>
                <button
                  data-testid="dismiss-confirm-cancel"
                  onClick={() => setConfirmDismiss(false)}
                  className="px-4 min-h-[44px] sm:min-h-0 py-2 rounded-full border border-ink/20 text-ink text-sm font-semibold"
                >
                  Cancel
                </button>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Backdrop */}
      <div
        onClick={handleClose}
        className="fixed inset-0 bg-ink/40 z-50"
        aria-hidden="true"
      />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 grid place-items-center p-4 sm:p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-2xl pointer-events-auto overflow-hidden max-h-[90vh] flex flex-col">
          {/* Header */}
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                LLM script review
              </p>
              <h3 className="text-base font-bold text-ink leading-tight">
                Script review suggestions
                <span className="ml-2 text-sm font-normal text-ink/50">
                  ({ops.length} suggestion{ops.length === 1 ? '' : 's'})
                </span>
              </h3>
            </div>
            <button
              data-testid="close-button"
              onClick={handleClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60 min-h-[44px] sm:min-h-0 min-w-[44px] sm:min-w-0 flex items-center justify-center"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          {/* Body */}
          <div className="p-6 space-y-6 overflow-y-auto scrollbar-thin">
            {unappliable.length > 0 && (
              <div
                data-testid="unappliable-notice"
                className="rounded-2xl border border-ink/10 bg-canvas/50 px-4 py-3 text-xs text-ink/60"
              >
                <span className="font-semibold text-ink/70">
                  {unappliable.length} suggestion{unappliable.length === 1 ? '' : 's'} couldn&apos;t be applied
                </span>
                {' '}(stale text or invalid)
              </div>
            )}
            {classes.length === 0 && (
              <div
                data-testid="script-review-empty"
                className="rounded-2xl border border-ink/10 bg-canvas/50 px-6 py-10 text-center"
              >
                <p className="text-sm font-medium text-ink/70">No suggestions found</p>
                <p className="mt-1 text-xs text-ink/50">
                  {unappliable.length > 0
                    ? "All suggestions were stale or invalid and couldn't be applied."
                    : "The reviewer didn't find anything to change in this scope."}
                </p>
              </div>
            )}
            {classes.map((cls) => {
              const classOps = byClass.get(cls) ?? [];
              const allClassSelected = classOps.every(
                (o) => selected[opKey(o.chapterId, o.id, o.op)],
              );

              return (
                <section key={cls} className="space-y-2">
                  {/* Class header */}
                  <div className="flex items-center gap-3 pb-1 border-b border-ink/10">
                    <h4 className="text-xs font-bold uppercase tracking-wider text-ink/60 flex-1">
                      {classLabel(cls)}
                    </h4>
                    <label
                      htmlFor={`class-toggle-${cls}`}
                      className="flex items-center gap-1.5 text-xs text-ink/55 cursor-pointer select-none min-h-[44px] sm:min-h-0"
                    >
                      <Checkbox
                        id={`class-toggle-${cls}`}
                        data-testid={`class-toggle-${cls}`}
                        checked={allClassSelected}
                        accent="ink"
                        onChange={() => {
                          dispatch(scriptReviewActions.toggleClass({ bookId, op: cls as ReviewOpWithChapter['op'] }));
                          const nextSelected = { ...selected };
                          for (const o of classOps) nextSelected[opKey(o.chapterId, o.id, o.op)] = !allClassSelected;
                          for (const chapterId of new Set(classOps.map((o) => o.chapterId))) {
                            scheduleSelectionSync(chapterId, nextSelected);
                          }
                        }}
                      />
                      Select all
                    </label>
                  </div>

                  {/* Op rows */}
                  {classOps.map((op) => {
                    const key = opKey(op.chapterId, op.id, op.op);
                    const isSelected = !!selected[key];
                    const liveSentence = sentences.find(
                      (s) => s.chapterId === op.chapterId && s.id === op.id,
                    );
                    return (
                      <div
                        key={key}
                        className="flex items-start gap-3 p-3 rounded-2xl border border-ink/10 bg-canvas/50"
                      >
                        <label
                          htmlFor={`op-toggle-${key}`}
                          className="flex items-center min-h-[44px] sm:min-h-0 cursor-pointer"
                        >
                          <Checkbox
                            id={`op-toggle-${key}`}
                            data-testid={`op-toggle-${key}`}
                            checked={isSelected}
                            accent="ink"
                            onChange={() => {
                              dispatch(scriptReviewActions.toggleOp({ bookId, key }));
                              scheduleSelectionSync(op.chapterId, { ...selected, [key]: !selected[key] });
                            }}
                            aria-label={`Toggle this ${op.op} suggestion`}
                          />
                        </label>
                        <div className="flex-1 min-w-0 space-y-1">
                          <OpPreview
                            op={op}
                            before={liveSentence?.text}
                            liveInstruct={liveSentence?.instruct}
                            liveVocalization={liveSentence?.vocalization}
                          />
                          <p className="text-xs text-ink/55 leading-relaxed">{op.rationale}</p>
                          {op.confidence !== undefined && (
                            <p className="text-[10px] text-ink/40 tabular-nums">
                              Confidence: {Math.round(op.confidence * 100)}%
                            </p>
                          )}
                        </div>
                        <span className="text-[10px] text-ink/35 tabular-nums shrink-0 mt-0.5">
                          ch{op.chapterId} · #{op.id}
                        </span>
                      </div>
                    );
                  })}
                </section>
              );
            })}
          </div>

          {/* Footer */}
          <div className="px-6 py-3 border-t border-ink/10 flex items-center gap-3 flex-wrap">
            <button
              data-testid="apply-button"
              onClick={handleApply}
              disabled={selectedCount === 0}
              className="shrink-0 inline-flex items-center gap-2 px-5 min-h-[44px] sm:min-h-0 py-2 rounded-full bg-ink text-canvas text-sm font-semibold hover:bg-ink/90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Apply {selectedCount} selected
            </button>
            <button
              data-testid="dismiss-button"
              onClick={handleDismiss}
              className="text-sm font-medium text-ink/50 hover:text-ink/80 min-h-[44px] sm:min-h-0"
            >
              Dismiss all
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
