/* Plan 78 — chapter rename modal. Mirrors edit-book-meta.tsx visually
   so the rename surface feels consistent with the existing per-book
   metadata editor. Opened from a pencil-icon button on the chapter row
   in the Listen / Restructure / Generation views.

   The modal owns the API call (api.renameChapter) and dispatches the
   slice action on success. Errors surface via the global notifications
   toast — same pattern as restructure.tsx for chapter-restructure ops.

   The server is the source of truth: it writes state.json atomically,
   renames the on-disk audio file if any exists, and flips
   titleOverridden so subsequent heuristic refresh-titles passes leave
   the title alone. */

import { useEffect, useRef, useState } from 'react';
import { IconClose, IconPencil } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { useAppDispatch } from '../store';
import { chaptersActions } from '../store/chapters-slice';
import { notificationsActions } from '../store/notifications-slice';
import { api } from '../lib/api';
import type { Chapter } from '../lib/types';
import { stripChapterPrefix } from '../lib/format-chapter-title';
import { MAX_TITLE_LEN } from '../lib/chapter-title';

/* Re-exported so any existing import of MAX_TITLE_LEN from this module keeps
   working (PR-gate review finding 3 moved the constant to lib/chapter-title
   so it can be imported without pulling in this modal's chunk). */
export { MAX_TITLE_LEN };

interface Props {
  open: boolean;
  bookId: string;
  chapter: Chapter | null;
  onClose: () => void;
}

export function EditChapterTitleModal({ open, bookId, chapter, onClose }: Props) {
  /* Seed the input from the chapter the pencil was clicked against.
     Keyed by chapter.id at the caller via the `key` prop so flipping
     between two rows re-mounts the form rather than carrying over a
     stale draft from the previous chapter. */
  const [draft, setDraft] = useState(chapter?.title ?? '');
  const [busy, setBusy] = useState(false);
  const dispatch = useAppDispatch();
  /* Imperative focus on mount — lint forbids the JSX `autoFocus`
     prop. Mirrors how other modals get the input focused without
     tripping the a11y rule. */
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (open && chapter) inputRef.current?.focus();
  }, [open, chapter]);

  if (!open || !chapter) return null;

  const trimmed = draft.trim();
  const isDirty = trimmed !== chapter.title;
  const isValid = trimmed.length > 0 && trimmed.length <= MAX_TITLE_LEN;
  const canSave = isDirty && isValid && !busy;

  async function handleSave() {
    if (!canSave || !chapter) return;
    setBusy(true);
    try {
      await api.renameChapter(bookId, chapter.id, trimmed);
      dispatch(chaptersActions.renameChapter({ chapterId: chapter.id, title: trimmed }));
      onClose();
    } catch (err) {
      dispatch(
        notificationsActions.pushToast({
          kind: 'error',
          message: (err as Error).message || 'Could not rename the chapter.',
          dedupeKey: `chapter-rename-${chapter.id}`,
        }),
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in" />
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-lg pointer-events-auto fade-in overflow-hidden">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta">
              <IconPencil className="w-4 h-4" />
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">
                Edit chapter title
              </p>
              <h3 className="text-base font-bold text-ink truncate">
                {stripChapterPrefix(chapter.title)}
              </h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5">
            <label className="block">
              <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                Title
              </span>
              <input
                ref={inputRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                aria-label="Chapter title"
                data-testid="edit-chapter-title-input"
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && canSave) {
                    e.preventDefault();
                    void handleSave();
                  } else if (e.key === 'Escape') {
                    e.preventDefault();
                    onClose();
                  }
                }}
                maxLength={MAX_TITLE_LEN}
                className="mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-hidden focus:border-ink/30"
              />
            </label>
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3">
            <p className="text-[11px] text-ink/50">
              Overrides the auto-derived title for this chapter.
            </p>
            <div className="flex items-center gap-3">
              <button
                onClick={onClose}
                className="text-sm font-medium text-ink/60 hover:text-ink"
              >
                Cancel
              </button>
              <PrimaryButton
                variant="dark"
                onClick={() => void handleSave()}
                disabled={!canSave}
              >
                {busy ? 'Saving…' : 'Save'}
              </PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
