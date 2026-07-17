/* #1676(c) — layout-level, non-dismissing Undo banner for the last bulk line
   reassignment. Rendered once in the shell banner region (joining WhatsNewBanner
   / UpdateNotifierBanner) so it behaves identically regardless of which view
   opened the form and survives cast↔script navigation. Visible exactly while
   manuscript.lastBulkReassign is non-null; Undo restores prior attribution and
   appends one revert-audit event (the audit trail stays symmetric without
   rewriting the append-only boundary_move history). */

import { useAppDispatch, useAppSelector } from '../store';
import { manuscriptActions } from '../store/manuscript-slice';
import { changeLogActions } from '../store/change-log-slice';
import { buildBulkReassignRevertEvent } from '../lib/change-log';

export function BulkReassignUndoBanner() {
  const dispatch = useAppDispatch();
  const slot = useAppSelector((s) => s.manuscript.lastBulkReassign);
  if (!slot) return null;
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
