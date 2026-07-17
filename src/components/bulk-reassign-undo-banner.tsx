/* #1676(c) — layout-level, non-dismissing Undo banner for the last bulk line
   reassignment. Rendered once in the shell banner region (joining WhatsNewBanner
   / UpdateNotifierBanner) so it behaves identically regardless of which view
   opened the form and survives cast↔script navigation. Visible exactly while
   manuscript.lastBulkReassign is non-null AND a book is in scope; Undo restores
   prior attribution and appends one revert-audit event (the audit trail stays
   symmetric without rewriting the append-only boundary_move history).

   The book-in-scope gate matters: `lastBulkReassign` is only cleared by a
   reparse/replace or by hydrating a DIFFERENT book — navigating from a book
   back to the library leaves the slot set. persistence-middleware derives its
   bookId the same way (`uiSelectors.bookId`, itself `s.ui.stage.bookId`) and
   short-circuits writes when there's no book in scope, so without this gate
   Undo would revert `manuscript.sentences` in redux but never flush to disk —
   a silent divergence that resurrects the old reassignment on reload. Gating
   on the SAME source keeps the banner visible exactly when Undo can persist. */

import { useAppDispatch, useAppSelector } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { changeLogActions } from '../store/change-log-slice';
import { uiSelectors } from '../store/ui-slice';
import { buildBulkReassignRevertEvent } from '../lib/change-log';

export function BulkReassignUndoBanner() {
  const dispatch = useAppDispatch();
  const slot = useAppSelector((s) => s.manuscript.lastBulkReassign);
  const bookId = useAppSelector(uiSelectors.bookId);
  if (!slot || !bookId) return null;
  const n = slot.moves.length;
  return (
    <div className="mx-auto max-w-3xl px-4 py-2">
      <div className="flex items-center gap-3 rounded-2xl border border-ink/10 bg-peach/40 px-4 py-2.5 text-sm">
        <span className="flex-1 text-ink/80">
          Reassigned {n} line{n === 1 ? '' : 's'} to {slot.targetLabel}.
        </span>
        <button
          onClick={() => {
            dispatch(manuscriptActions.undoBulkReassign());
            dispatch(changeLogActions.appendLogEvent(buildBulkReassignRevertEvent({ count: n })));
          }}
          className="font-semibold underline shrink-0 min-h-[44px] fine-pointer:min-h-0"
        >
          Undo
        </button>
      </div>
    </div>
  );
}
