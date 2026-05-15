/* Edit book metadata modal — exposed from the library card "…" menu so
   users can fix import-time typos in title/author, move a book between
   series, set its position, or toggle the standalone flag. Title/author/
   series changes also move the on-disk folder server-side; the modal
   itself just collects the diff and hands it to the route's onSave
   callback. */

import { useMemo, useState } from 'react';
import { IconClose, IconPencil } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import type { LibraryBook } from '../lib/types';

export interface EditBookMetaPatch {
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
}

interface Props {
  open: boolean;
  book: LibraryBook;
  onClose: () => void;
  onSave: (patch: EditBookMetaPatch) => void;
}

export function EditBookMetaModal({ open, book, onClose, onSave }: Props) {
  /* Seed every field from the book the menu was opened against. State is
     keyed by `book.bookId` (via the `key` prop on the caller) so flipping
     between two cards re-mounts the form rather than carrying over stale
     edits. */
  const initial = useMemo<EditBookMetaPatch>(() => ({
    title:          book.title,
    author:         book.author,
    series:         book.series,
    seriesPosition: book.seriesPosition,
    isStandalone:   book.isStandalone,
  }), [book]);

  const [title,          setTitle]          = useState(initial.title);
  const [author,         setAuthor]         = useState(initial.author);
  const [series,         setSeries]         = useState(initial.series);
  /* seriesPosition is kept as a string in the input so an empty input
     round-trips cleanly to null without flashing 0 / NaN. The submit
     handler parses it. */
  const [positionInput,  setPositionInput]  = useState(initial.seriesPosition == null ? '' : String(initial.seriesPosition));
  const [isStandalone,   setIsStandalone]   = useState(initial.isStandalone);

  const parsedPosition = positionInput.trim() === '' ? null : Number(positionInput);
  const positionIsValid = parsedPosition === null || (Number.isFinite(parsedPosition) && parsedPosition >= 1);

  const titleClean = title.trim();
  const authorClean = author.trim();
  const seriesClean = series.trim();
  const requiredOk = titleClean !== '' && authorClean !== '';

  /* Dirty check: at least one user-visible field has changed. When
     standalone is on, series + position changes are ignored (the server
     overrides them anyway). */
  const isDirty =
    titleClean !== initial.title.trim() ||
    authorClean !== initial.author.trim() ||
    isStandalone !== initial.isStandalone ||
    (!isStandalone && (
      seriesClean !== initial.series.trim() ||
      (parsedPosition ?? null) !== (initial.seriesPosition ?? null)
    ));

  const canSave = isDirty && requiredOk && positionIsValid;

  if (!open) return null;
  return (
    <>
      <div onClick={onClose} className="fixed inset-0 bg-ink/40 z-50 fade-in"/>
      <div className="fixed inset-0 z-50 grid place-items-center p-6 pointer-events-none">
        <div className="bg-white rounded-3xl shadow-float w-full max-w-lg pointer-events-auto fade-in overflow-hidden">
          <div className="px-6 py-4 border-b border-ink/10 flex items-center gap-3">
            <span className="w-9 h-9 rounded-full bg-peach/15 grid place-items-center text-magenta">
              <IconPencil className="w-4 h-4"/>
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-[10px] uppercase tracking-widest text-ink/50 font-semibold">Edit details</p>
              <h3 className="text-base font-bold text-ink truncate">{initial.title}</h3>
            </div>
            <button onClick={onClose} className="p-2 rounded-full hover:bg-ink/5 text-ink/60" aria-label="Close">
              <IconClose className="w-4 h-4"/>
            </button>
          </div>

          <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <Field label="Title">
              <input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Title"
                     className={inputClasses}/>
            </Field>
            <Field label="Author">
              <input value={author} onChange={(e) => setAuthor(e.target.value)} aria-label="Author"
                     className={inputClasses}/>
            </Field>

            <div className="md:col-span-2 flex items-center gap-2">
              <input
                id="edit-book-standalone"
                type="checkbox"
                checked={isStandalone}
                onChange={(e) => setIsStandalone(e.target.checked)}
                className="w-4 h-4 rounded border-ink/30 text-magenta focus:ring-magenta"
              />
              <label htmlFor="edit-book-standalone" className="text-sm text-ink select-none">
                Standalone (not part of a series)
              </label>
            </div>

            <Field label="Series">
              <input value={isStandalone ? '' : series}
                     disabled={isStandalone}
                     placeholder={isStandalone ? 'Standalone' : undefined}
                     onChange={(e) => setSeries(e.target.value)}
                     aria-label="Series"
                     className={`${inputClasses} disabled:opacity-50 disabled:cursor-not-allowed`}/>
            </Field>
            <Field label="Position in series">
              <input
                type="number"
                min={1}
                step={1}
                value={isStandalone ? '' : positionInput}
                disabled={isStandalone}
                onChange={(e) => setPositionInput(e.target.value)}
                aria-label="Position in series"
                placeholder={isStandalone ? '—' : 'e.g. 1'}
                className={`${inputClasses} disabled:opacity-50 disabled:cursor-not-allowed`}
              />
            </Field>
            {!positionIsValid && (
              <p className="md:col-span-2 text-xs text-red-700 -mt-3">
                Position must be a whole number ≥ 1, or empty.
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-ink/10 flex items-center justify-between gap-3">
            <p className="text-[11px] text-ink/50">
              Renames also move the folder on disk so the layout stays in sync.
            </p>
            <div className="flex items-center gap-3">
              <button onClick={onClose} className="text-sm font-medium text-ink/60 hover:text-ink">
                Cancel
              </button>
              <PrimaryButton
                variant="dark"
                onClick={() => onSave({
                  title:          titleClean,
                  author:         authorClean,
                  series:         isStandalone ? initial.series : seriesClean,
                  seriesPosition: isStandalone ? null : parsedPosition,
                  isStandalone,
                })}
                disabled={!canSave}
              >
                Save changes
              </PrimaryButton>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

const inputClasses =
  'mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-none focus:border-ink/30';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">{label}</span>
      {children}
    </label>
  );
}
