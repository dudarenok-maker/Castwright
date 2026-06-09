/* Edit book metadata modal — exposed from the library card "…" menu so
   users can fix import-time typos in title/author, move a book between
   series, set its position, or toggle the standalone flag. Title/author/
   series changes also move the on-disk folder server-side; the modal
   itself just collects the diff and hands it to the route's onSave
   callback.

   Plan 73 — also owns the per-book tag chip editor. Tags round-trip
   through the same `slice: 'state'` PUT path as the other fields. */

import { useMemo, useRef, useState } from 'react';
import { IconClose, IconPencil } from '../lib/icons';
import { PrimaryButton } from '../components/primitives';
import { useAppSelector } from '../store';
import type { LibraryBook } from '../lib/types';

export interface EditBookMetaPatch {
  title: string;
  author: string;
  series: string;
  seriesPosition: number | null;
  isStandalone: boolean;
  /* Plan 73 — full replacement of the book's tag set on save. Always
     present (never undefined) so the server-side picker can distinguish
     "user cleared the list" from "user didn't touch tags". */
  tags: string[];
}

interface Props {
  open: boolean;
  book: LibraryBook;
  onClose: () => void;
  onSave: (patch: EditBookMetaPatch) => void;
}

/* Parse a chip editor token — splits comma-separated input, trims
   whitespace, drops empties. Lets the user paste `priority, draft`
   in one go and get two chips. */
function parseTagInput(raw: string): string[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

export function EditBookMetaModal({ open, book, onClose, onSave }: Props) {
  /* Seed every field from the book the menu was opened against. State is
     keyed by `book.bookId` (via the `key` prop on the caller) so flipping
     between two cards re-mounts the form rather than carrying over stale
     edits. */
  const initial = useMemo<EditBookMetaPatch>(
    () => ({
      title: book.title,
      author: book.author,
      series: book.series,
      seriesPosition: book.seriesPosition,
      isStandalone: book.isStandalone,
      tags: [...(book.tags ?? [])],
    }),
    [book],
  );

  const [title, setTitle] = useState(initial.title);
  const [author, setAuthor] = useState(initial.author);
  const [series, setSeries] = useState(initial.series);
  /* seriesPosition is kept as a string in the input so an empty input
     round-trips cleanly to null without flashing 0 / NaN. The submit
     handler parses it. */
  const [positionInput, setPositionInput] = useState(
    initial.seriesPosition == null ? '' : String(initial.seriesPosition),
  );
  const [isStandalone, setIsStandalone] = useState(initial.isStandalone);
  const [tags, setTags] = useState<string[]>(initial.tags);
  const [tagInput, setTagInput] = useState('');
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const tagInputRef = useRef<HTMLInputElement | null>(null);

  /* Suggest tags from every other book in the library. Reading via the
     selector keeps the modal in sync if the library hydrates while open
     (rare — but it's free given the slice is already populated). The
     active book's own tags are kept in the union so an autocomplete
     after a removal still proposes a re-add.

     We pull the raw books array out of the slice and derive the sorted
     tag union with useMemo — selector returning a fresh array each
     render trips React 18's "selector returned a different result"
     warning. */
  const libraryBooks = useAppSelector((s) => s.library.books);
  const allTagsAcrossLibrary = useMemo(() => {
    const set = new Set<string>();
    for (const b of libraryBooks) {
      for (const t of b.tags ?? []) set.add(t);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [libraryBooks]);
  const suggestions = useMemo(() => {
    const query = tagInput.trim().toLowerCase();
    return allTagsAcrossLibrary.filter((t) => {
      if (tags.includes(t)) return false;
      if (!query) return true;
      return t.toLowerCase().includes(query);
    });
  }, [allTagsAcrossLibrary, tagInput, tags]);

  const addTags = (incoming: string[]) => {
    if (incoming.length === 0) return;
    setTags((prev) => {
      const next = [...prev];
      const seen = new Set(next);
      for (const t of incoming) {
        if (!seen.has(t)) {
          seen.add(t);
          next.push(t);
        }
      }
      return next;
    });
  };
  const removeTag = (target: string) => {
    setTags((prev) => prev.filter((t) => t !== target));
  };
  const commitTagInput = () => {
    const parsed = parseTagInput(tagInput);
    if (parsed.length === 0) return;
    addTags(parsed);
    setTagInput('');
  };
  const handleTagKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitTagInput();
    } else if (e.key === 'Backspace' && tagInput === '' && tags.length > 0) {
      /* Empty input + backspace pops the last chip — matches the
         convention every chip editor on the web (GitHub labels, Gmail
         to-field, etc.) shares. */
      e.preventDefault();
      setTags((prev) => prev.slice(0, -1));
    } else if (e.key === ',') {
      /* Comma also commits — feels natural when typing a list. */
      e.preventDefault();
      commitTagInput();
    }
  };

  const parsedPosition = positionInput.trim() === '' ? null : Number(positionInput);
  const positionIsValid =
    parsedPosition === null || (Number.isFinite(parsedPosition) && parsedPosition >= 1);

  const titleClean = title.trim();
  const authorClean = author.trim();
  const seriesClean = series.trim();
  const requiredOk = titleClean !== '' && authorClean !== '';

  const tagsChanged =
    tags.length !== initial.tags.length ||
    tags.some((t, i) => t !== initial.tags[i]);
  /* A pending-but-uncommitted tag in the input is also "dirty" — the
     Save handler commits it before invoking onSave, so the form is
     materially different from its seed state. Without this, Save sits
     disabled while the user has typed a tag but not hit Enter, then
     does nothing if they click it. */
  const tagInputHasPending = parseTagInput(tagInput).length > 0;

  /* Dirty check: at least one user-visible field has changed. When
     standalone is on, series + position changes are ignored (the server
     overrides them anyway). */
  const isDirty =
    titleClean !== initial.title.trim() ||
    authorClean !== initial.author.trim() ||
    isStandalone !== initial.isStandalone ||
    (!isStandalone &&
      (seriesClean !== initial.series.trim() ||
        (parsedPosition ?? null) !== (initial.seriesPosition ?? null))) ||
    tagsChanged ||
    tagInputHasPending;

  const canSave = isDirty && requiredOk && positionIsValid;

  if (!open) return null;
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
                Edit details
              </p>
              <h3 className="text-base font-bold text-ink truncate">{initial.title}</h3>
            </div>
            <button
              onClick={onClose}
              className="p-2 rounded-full hover:bg-ink/5 text-ink/60"
              aria-label="Close"
            >
              <IconClose className="w-4 h-4" />
            </button>
          </div>

          <div className="px-6 py-5 grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-5">
            <Field label="Title">
              <input
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                aria-label="Title"
                className={inputClasses}
              />
            </Field>
            <Field label="Author">
              <input
                value={author}
                onChange={(e) => setAuthor(e.target.value)}
                aria-label="Author"
                className={inputClasses}
              />
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
              <input
                value={isStandalone ? '' : series}
                disabled={isStandalone}
                placeholder={isStandalone ? 'Standalone' : undefined}
                onChange={(e) => setSeries(e.target.value)}
                aria-label="Series"
                className={`${inputClasses} disabled:opacity-50 disabled:cursor-not-allowed`}
              />
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

            <div className="md:col-span-2">
              <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
                Tags
              </span>
              <div
                className="mt-1 flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-xl bg-canvas border border-ink/10 focus-within:border-ink/30"
                data-testid="tag-editor"
              >
                {tags.map((tag) => (
                  <span
                    key={tag}
                    data-testid={`tag-chip-${tag}`}
                    className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-medium bg-purple-deep/6 text-purple-deep border border-purple-deep/15"
                  >
                    {tag}
                    <button
                      type="button"
                      onClick={() => removeTag(tag)}
                      aria-label={`Remove tag ${tag}`}
                      className="hover:text-magenta"
                    >
                      <IconClose className="w-3 h-3" />
                    </button>
                  </span>
                ))}
                <input
                  ref={tagInputRef}
                  value={tagInput}
                  onChange={(e) => setTagInput(e.target.value)}
                  onKeyDown={handleTagKeyDown}
                  onFocus={() => setSuggestionsOpen(true)}
                  /* Defer close so a mouse-down on a suggestion still
                     fires its onMouseDown handler before blur clears
                     the dropdown. */
                  onBlur={() => setTimeout(() => setSuggestionsOpen(false), 120)}
                  aria-label="Add tag"
                  placeholder={tags.length === 0 ? 'Add tags (Enter or comma to add)' : ''}
                  className="flex-1 min-w-[120px] bg-transparent text-sm text-ink focus:outline-hidden py-0.5"
                />
              </div>
              {suggestionsOpen && suggestions.length > 0 && (
                <ul
                  data-testid="tag-suggestions"
                  className="mt-1 max-h-32 overflow-y-auto scrollbar-thin rounded-xl bg-white border border-ink/10 shadow-card"
                  style={{ ['--scrollbar-thin-radius' as string]: '12px' } as React.CSSProperties}
                >
                  {suggestions.slice(0, 8).map((s) => (
                    <li key={s}>
                      <button
                        type="button"
                        data-testid={`tag-suggestion-${s}`}
                        /* onMouseDown so the click registers BEFORE the
                           input's blur fires — otherwise the dropdown
                           closes before the click lands. */
                        onMouseDown={(e) => {
                          e.preventDefault();
                          addTags([s]);
                          setTagInput('');
                          tagInputRef.current?.focus();
                        }}
                        className="w-full text-left px-3 py-1.5 text-sm text-ink hover:bg-ink/4"
                      >
                        {s}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              <p className="mt-1 text-[11px] text-ink/50">
                Use tags to filter the library view. Press Enter or comma to add.
              </p>
            </div>
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
                onClick={() => {
                  /* Last-chance commit of any uncommitted typed input so
                     a "Save" click while a tag is mid-typed doesn't
                     discard it. */
                  const pendingParsed = parseTagInput(tagInput);
                  const finalTags = [...tags];
                  const seen = new Set(finalTags);
                  for (const t of pendingParsed) {
                    if (!seen.has(t)) {
                      seen.add(t);
                      finalTags.push(t);
                    }
                  }
                  onSave({
                    title: titleClean,
                    author: authorClean,
                    series: isStandalone ? initial.series : seriesClean,
                    seriesPosition: isStandalone ? null : parsedPosition,
                    isStandalone,
                    tags: finalTags,
                  });
                }}
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
  'mt-1 w-full px-3 py-2 rounded-xl bg-canvas border border-ink/10 text-sm text-ink focus:outline-hidden focus:border-ink/30';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-[11px] uppercase tracking-wider text-ink/50 font-semibold">
        {label}
      </span>
      {children}
    </label>
  );
}
