/* Manuscript diff modal (plan 74). Mounted by views/upload.tsx when the
   manuscript slice's `pendingReupload` is non-null. Side-by-side
   sentence-level diff with character-level highlights inside `replace`
   rows. The modal is the only stop between the user's re-upload and
   the slice mutation — Apply commits, Discard rolls back without ever
   touching the live slice fields (see manuscript-slice's preview /
   apply / discard reducers).

   Keyboard shortcuts mirror the standard "destructive vs commit"
   dialog convention: Esc → Discard, Cmd/Ctrl+Enter → Apply.

   Rendering choices:
   - Match-by-index: equal sentences align horizontally so the user
     can scan the changed-vs-unchanged columns at a glance.
   - For `replace`, both columns render the same `charDiff` output —
     the OLD column highlights removed spans, the NEW column
     highlights added spans, shared text stays neutral. */

import { useEffect, useMemo, useRef } from 'react';
import { type SentenceDiff, charDiff, summariseDiff } from '../lib/manuscript-diff';
import { type OverrideConflict } from '../lib/chapter-override-conflict';
import { IconClose } from '../lib/icons';

interface ManuscriptDiffModalProps {
  open: boolean;
  bookTitle: string | null;
  diff: SentenceDiff[];
  /* Plan 84 — renamed-chapter conflicts surfaced by detectOverrideConflicts.
     Optional for older call sites; render a banner when non-empty. */
  overrideConflicts?: OverrideConflict[];
  onApply: () => void;
  onDiscard: () => void;
}

export function ManuscriptDiffModal({
  open,
  bookTitle,
  diff,
  overrideConflicts,
  onApply,
  onDiscard,
}: ManuscriptDiffModalProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const counts = useMemo(() => summariseDiff(diff), [diff]);

  /* Keyboard shortcuts: Esc → Discard, Cmd/Ctrl+Enter → Apply.
     Bound at the document level (not the dialog itself) so focus
     inside the scrollable diff list still surfaces the shortcuts. */
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onDiscard();
        return;
      }
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        onApply();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onApply, onDiscard]);

  if (!open) return null;

  const headerCopy =
    bookTitle != null
      ? `Re-uploading manuscript for "${bookTitle}" — review changes before applying`
      : 'Re-uploading manuscript — review changes before applying';

  return (
    <>
      <div
        onClick={onDiscard}
        className="fixed inset-0 bg-ink/40 z-50 fade-in"
        data-testid="diff-backdrop"
      />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div
          ref={containerRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby="manuscript-diff-title"
          data-testid="manuscript-diff-modal"
          className="bg-white rounded-3xl shadow-float w-full max-w-6xl max-h-[90vh] pointer-events-auto fade-in overflow-hidden flex flex-col"
        >
          {/* Header */}
          <div className="px-6 py-4 border-b border-ink/10 flex items-start gap-4">
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Manuscript diff
              </p>
              <h3
                id="manuscript-diff-title"
                className="text-base font-bold text-ink truncate"
                data-testid="diff-title"
              >
                {headerCopy}
              </h3>
              <p
                className="mt-1 text-xs text-ink/60"
                data-testid="diff-counts"
              >
                <span className="font-semibold text-ink">{counts.changed}</span> changed,{' '}
                <span className="font-semibold text-ink">{counts.added}</span> added,{' '}
                <span className="font-semibold text-ink">{counts.removed}</span> removed
              </p>
              {overrideConflicts && overrideConflicts.length > 0 && (
                <div
                  className="mt-3 rounded-xl border border-amber-300/60 bg-amber-50 px-4 py-3 text-xs text-amber-900"
                  data-testid="diff-override-conflicts"
                >
                  <p className="font-semibold">
                    {overrideConflicts.length} renamed{' '}
                    {overrideConflicts.length === 1 ? 'chapter does' : 'chapters do'} not match
                    the new manuscript
                  </p>
                  <p className="mt-1 leading-relaxed">
                    Your manual chapter rename
                    {overrideConflicts.length === 1 ? ' will be cleared' : 's will be cleared'}{' '}
                    when you apply — the new manuscript&apos;s parsed titles will win. Re-apply
                    the rename
                    {overrideConflicts.length === 1 ? '' : 's'} from the chapter list afterward
                    if you still want{overrideConflicts.length === 1 ? ' it' : ' them'}.
                  </p>
                  <ul className="mt-2 space-y-1 list-disc pl-4">
                    {overrideConflicts.slice(0, 5).map((c) => (
                      <li key={c.oldChapterId}>
                        <span className="font-medium">
                          Chapter {c.oldChapterId}: &ldquo;{c.oldTitle}&rdquo;
                        </span>
                        {c.newChapterId === -1 ? (
                          <> &rarr; removed</>
                        ) : (
                          <> &rarr; now &ldquo;{c.newTitle}&rdquo;</>
                        )}
                      </li>
                    ))}
                    {overrideConflicts.length > 5 && (
                      <li className="text-amber-700">
                        and {overrideConflicts.length - 5} more
                      </li>
                    )}
                  </ul>
                </div>
              )}
            </div>
            <button
              onClick={onDiscard}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60"
              aria-label="Close"
              data-testid="diff-close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          {/* Diff body — scrollable two-column list */}
          <div className="flex-1 overflow-auto px-6 py-4">
            {diff.length === 0 ? (
              <p
                className="text-sm text-ink/60 italic py-8 text-center"
                data-testid="diff-empty"
              >
                Manuscript text matches the existing book exactly. No changes to apply.
              </p>
            ) : (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-4 text-[10px] uppercase tracking-widest text-ink/50 font-semibold pb-2 border-b border-ink/10">
                  <div>Current</div>
                  <div>New</div>
                </div>
                <ul className="space-y-1" data-testid="diff-rows">
                  {diff.map((entry, i) => (
                    <DiffRow key={i} entry={entry} />
                  ))}
                </ul>
              </div>
            )}
          </div>

          {/* Footer — Discard + Apply */}
          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3">
            <p className="text-[11px] text-ink/50">
              <kbd className="px-1.5 py-0.5 rounded bg-ink/5 text-[10px] font-mono">Esc</kbd>{' '}
              discard ·{' '}
              <kbd className="px-1.5 py-0.5 rounded bg-ink/5 text-[10px] font-mono">
                Ctrl+Enter
              </kbd>{' '}
              apply
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={onDiscard}
                className="text-sm font-medium text-ink/60 hover:text-ink"
                data-testid="diff-discard"
              >
                Discard
              </button>
              <button
                onClick={onApply}
                data-testid="diff-apply"
                className="inline-flex items-center gap-2 rounded-full bg-ink text-canvas hover:bg-ink-soft px-5 py-2 text-sm font-semibold"
              >
                Apply changes
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/* Single diff row — renders a two-column entry (equal / insert /
   delete / replace). Insert leaves the OLD column blank; delete
   leaves the NEW column blank; replace runs charDiff to highlight
   the changed spans on both sides. */
function DiffRow({ entry }: { entry: SentenceDiff }) {
  if (entry.type === 'equal') {
    return (
      <li
        className="grid grid-cols-2 gap-4 text-sm text-ink/70 px-3 py-1.5 rounded-lg"
        data-testid="diff-row-equal"
      >
        <p>{entry.oldText}</p>
        <p>{entry.newText}</p>
      </li>
    );
  }
  if (entry.type === 'insert') {
    return (
      <li
        className="grid grid-cols-2 gap-4 text-sm px-3 py-1.5 rounded-lg bg-peach/10"
        data-testid="diff-row-insert"
      >
        <p className="text-ink/30 italic">—</p>
        <p className="text-ink/90">
          <mark className="bg-peach/40 px-1 rounded">{entry.newText}</mark>
        </p>
      </li>
    );
  }
  if (entry.type === 'delete') {
    return (
      <li
        className="grid grid-cols-2 gap-4 text-sm px-3 py-1.5 rounded-lg bg-magenta/[0.06]"
        data-testid="diff-row-delete"
      >
        <p className="text-ink/70">
          <del className="bg-magenta/15 text-ink/60 px-1 rounded no-underline line-through">
            {entry.oldText}
          </del>
        </p>
        <p className="text-ink/30 italic">—</p>
      </li>
    );
  }
  /* replace */
  const spans = charDiff(entry.oldText, entry.newText);
  return (
    <li
      className="grid grid-cols-2 gap-4 text-sm px-3 py-1.5 rounded-lg bg-ink/[0.02]"
      data-testid="diff-row-replace"
    >
      <p className="text-ink/80" data-testid="diff-row-replace-old">
        {spans.map((s, i) =>
          s.type === 'add' ? null : s.type === 'remove' ? (
            <del
              key={i}
              className="bg-magenta/15 text-ink/60 px-0.5 rounded no-underline line-through"
            >
              {s.text}
            </del>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </p>
      <p className="text-ink" data-testid="diff-row-replace-new">
        {spans.map((s, i) =>
          s.type === 'remove' ? null : s.type === 'add' ? (
            <mark key={i} className="bg-peach/40 px-0.5 rounded">
              {s.text}
            </mark>
          ) : (
            <span key={i}>{s.text}</span>
          ),
        )}
      </p>
    </li>
  );
}
