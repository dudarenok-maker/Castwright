/* fs-58 — ScriptReviewDiff modal.
   Shows the LLM script-review suggestions bucketed by op class (strip_tag,
   fix_emotion, split, etc.), lets the user select/deselect individual ops or
   whole classes, then applies the selected set via planApply +
   dispatchAcceptedOps. Mirrors drift-report.tsx overlay pattern. */

import { useRef, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store';
import {
  scriptReviewActions,
  selectActiveReview,
  opKey,
  type ReviewOpWithChapter,
} from '../store/script-review-slice';
import { planApply, dispatchAcceptedOps } from '../lib/script-review-apply';
import { applyProposedReattributions } from '../lib/apply-proposed';
import { changeLogActions } from '../store/change-log-slice';
import { manuscriptActions } from '../store/manuscript-slice';
import { castActions } from '../store/cast-slice';
import { api } from '../lib/api';
import { CreateCharacterForm } from './create-character-form';
import { IconClose } from '../lib/icons';

/* Human-readable class labels. */
const CLASS_LABELS: Record<string, string> = {
  strip_tag: 'Strip tag',
  split: 'Split sentence',
  extract_dialogue: 'Extract dialogue',
  merge: 'Merge sentences',
  fix_emotion: 'Fix emotion',
  reattribute: 'Reattribute speaker',     // fs-58 Unit B
  flag_nonstory: 'Exclude non-story',     // fs-58 Unit B
};

function classLabel(op: string): string {
  return CLASS_LABELS[op] ?? op;
}

/* Format the before → after preview for a single op row. `before` is the
   live sentence text (the original) when available, so strip_tag shows the
   tagged source struck-through next to the cleaned result. */
function OpPreview({ op, before }: { op: ReviewOpWithChapter; before?: string }) {
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

export function ScriptReviewDiff({ bookId }: { bookId: string }) {
  const dispatch = useAppDispatch();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = useAppSelector((s) => selectActiveReview(s as any, bookId));
  const sentences = useAppSelector((s) => s.manuscript.sentences);
  const cast = useAppSelector((s) => s.cast.characters);
  // Live book id of the active `ready` stage — used by the book-switch guard.
  // Tracked through a ref so the async helper sees the CURRENT value, not the
  // one captured when handleApply was first invoked.
  const stageBookId = useAppSelector((s) =>
    s.ui.stage.kind === 'ready' ? s.ui.stage.bookId : undefined,
  );
  const stageBookIdRef = useRef(stageBookId);
  stageBookIdRef.current = stageBookId;

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

  function handleClose() {
    dispatch(scriptReviewActions.clearReview({ bookId }));
  }

  function handleDismiss() {
    dispatch(scriptReviewActions.clearReview({ bookId }));
  }

  /* Run the finalized off-roster reattributes through the interleaved
     create→reassign helper (dedupe + book-switch guard), then clear the
     review bucket. Called once, after the LAST confirm resolves. */
  async function runProposed(finalized: FinalizedProposed[], startBookId: string) {
    const rosterByName = new Map(cast.map((c) => [c.name.trim().toLowerCase(), { id: c.id }]));
    await applyProposedReattributions(finalized, {
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
    });
    setConfirm(null);
    dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));
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
        // Keep `confirm` populated until runProposed resolves to clearReview;
        // the form unmounts once the bucket is gone.
      }
      return { ...prev, finalized, index: nextIndex };
    });
  }

  /* Cancel mid-confirm: leave the already-applied direct ops in place, do NOT
     create any not-yet-confirmed member, and tear the review bucket down. */
  function cancelConfirm() {
    const startBookId = confirm?.startBookId ?? bookId;
    setConfirm(null);
    dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));
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
    );

    dispatchAcceptedOps(
      dispatch,
      directOps,
      live,
      {
        onBoundaryMove: (chapterId) =>
          dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
      },
      roster,
    );

    if (proposedOps.length > 0) {
      setConfirm({ queue: proposedOps, index: 0, finalized: [], startBookId });
      return; // clearReview happens after the confirm queue resolves
    }

    dispatch(scriptReviewActions.clearReview({ bookId: startBookId }));
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
                    <label className="flex items-center gap-1.5 text-xs text-ink/55 cursor-pointer select-none min-h-[44px] sm:min-h-0">
                      <input
                        type="checkbox"
                        data-testid={`class-toggle-${cls}`}
                        checked={allClassSelected}
                        onChange={() =>
                          dispatch(scriptReviewActions.toggleClass({ bookId, op: cls as ReviewOpWithChapter['op'] }))
                        }
                        className="accent-ink w-4 h-4"
                      />
                      Select all
                    </label>
                  </div>

                  {/* Op rows */}
                  {classOps.map((op) => {
                    const key = opKey(op.chapterId, op.id, op.op);
                    const isSelected = !!selected[key];
                    const liveText = sentences.find(
                      (s) => s.chapterId === op.chapterId && s.id === op.id,
                    )?.text;
                    return (
                      <div
                        key={key}
                        className="flex items-start gap-3 p-3 rounded-2xl border border-ink/10 bg-canvas/50"
                      >
                        <label className="flex items-center min-h-[44px] sm:min-h-0 cursor-pointer">
                          <input
                            type="checkbox"
                            data-testid={`op-toggle-${key}`}
                            checked={isSelected}
                            onChange={() =>
                              dispatch(scriptReviewActions.toggleOp({ bookId, key }))
                            }
                            className="accent-ink w-4 h-4"
                          />
                          <span className="sr-only">Toggle this {op.op} suggestion</span>
                        </label>
                        <div className="flex-1 min-w-0 space-y-1">
                          <OpPreview op={op} before={liveText} />
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
