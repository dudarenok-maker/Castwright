/* fs-58 — ScriptReviewDiff modal.
   Shows the LLM script-review suggestions bucketed by op class (strip_tag,
   fix_emotion, split, etc.), lets the user select/deselect individual ops or
   whole classes, then applies the selected set via planApply +
   dispatchAcceptedOps. Mirrors drift-report.tsx overlay pattern. */

import { useAppDispatch, useAppSelector } from '../store';
import {
  scriptReviewActions,
  selectActiveReview,
  opKey,
  type ReviewOpWithChapter,
} from '../store/script-review-slice';
import { planApply, dispatchAcceptedOps } from '../lib/script-review-apply';
import { changeLogActions } from '../store/change-log-slice';
import { IconClose } from '../lib/icons';

/* Human-readable class labels. */
const CLASS_LABELS: Record<string, string> = {
  strip_tag: 'Strip tag',
  split: 'Split sentence',
  extract_dialogue: 'Extract dialogue',
  merge: 'Merge sentences',
  fix_emotion: 'Fix emotion',
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
  return null;
}

export function ScriptReviewDiff({ bookId }: { bookId: string }) {
  const dispatch = useAppDispatch();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const bucket = useAppSelector((s) => selectActiveReview(s as any, bookId));
  const sentences = useAppSelector((s) => s.manuscript.sentences);

  if (!bucket) return null;

  const { ops, selected } = bucket;

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

  function handleApply() {
    // Gather only the ops the user selected
    const selectedOps = ops.filter((o) => selected[opKey(o.chapterId, o.id, o.op)]);

    // Build the live snapshot for planApply
    const live = sentences.map((s) => ({
      id: s.id,
      chapterId: s.chapterId,
      text: s.text,
      characterId: s.characterId,
    }));

    const { appliable } = planApply(selectedOps, live);

    dispatchAcceptedOps(dispatch, appliable, live, {
      onBoundaryMove: (chapterId) =>
        dispatch(changeLogActions.bumpBoundaryMove({ chapterId, count: 1 })),
    });

    dispatch(scriptReviewActions.clearReview({ bookId }));
  }

  return (
    <>
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
