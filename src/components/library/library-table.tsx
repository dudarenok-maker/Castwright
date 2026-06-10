/* Book-library table region — dense alternative to <LibraryGrid />.

   Series-grouped layout (one collapsible <table> body per series, plus a
   trailing "Standalones" pseudo-section for `isStandalone` books across
   every author). Each row is clickable → `onOpenBook`; the per-row kebab
   menu wires the same Edit / Reparse / Delete / Cover callbacks the
   card view uses, so behaviour parity is total — the toggle in
   `LibraryChrome` swaps the visual shell without changing what's
   wired up underneath.

   v1 deliberately omits column sort, column resize, density toggle,
   and per-series collapse persistence — those are explicit follow-ups
   in plan 76. Collapse state lives in component-local
   `useState<Record<string, boolean>>` (per-session only), keyed by
   the synthetic `<author>::<series>` id used by the section headers.

   Cover thumb reuses `computeCoverStyle` from `cover-framing.ts`, so
   pan + zoom set in the picker carry into the table. */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconArrowDn,
  IconChevR,
  IconImage,
  IconMore,
  IconPencil,
  IconRefresh,
  IconStar,
  IconTrash,
} from '../../lib/icons';
import { Pill } from '../primitives';
import { ConfirmDialog } from '../../modals/confirm-dialog';
import { EditBookMetaModal, type EditBookMetaPatch } from '../../modals/edit-book-meta';
import { CoverPicker } from '../../modals/cover-picker';
import { computeCoverStyle } from '../../lib/cover-framing';
import type { LibraryAuthor, LibraryBook } from '../../lib/types';
import { STATUS_UI } from './library-status-ui';
import { EmptyLibrary, LibrarySkeleton, NoFilterMatch } from './library-empty-states';

interface Props {
  loaded: boolean;
  /** `true` when the underlying library has no books at all (pre-filter). */
  isLibraryEmpty: boolean;
  /** Authors are pre-filtered by the orchestrator — table just renders. */
  authors: LibraryAuthor[];
  activeBookId: string | null;
  onOpenBook: (book: LibraryBook) => void;
  onDeleteBook: (book: LibraryBook) => void;
  onReparseBook: (book: LibraryBook) => void;
  onReplaceManuscript: (book: LibraryBook, file: File) => void | Promise<void>;
  onEditBook: (book: LibraryBook, patch: EditBookMetaPatch) => Promise<void>;
  onCoverChanged?: (book: LibraryBook) => Promise<void> | void;
  onStartNew: () => void;
}

interface SeriesGroup {
  /** Synthetic id for per-session collapse state — author + series so two
      different authors with same series name don't collide. */
  id: string;
  /** Display label: "Standalones" for the synthetic group, else the
      author's series name. */
  label: string;
  /** Author name to render under the title column when the group spans
      multiple authors (i.e. the Standalones group). When `null`, the row
      hides the author cell to avoid duplicating it after a series header
      that already names one author. */
  authorOverride: string | null;
  books: LibraryBook[];
}

export function LibraryTable({
  loaded,
  isLibraryEmpty,
  authors,
  activeBookId,
  onOpenBook,
  onDeleteBook,
  onReparseBook,
  onReplaceManuscript,
  onEditBook,
  onCoverChanged,
  onStartNew,
}: Props) {
  /* Group the post-filter authors into the renderable series list, then
     append a synthetic Standalones group at the bottom (no header dupe
     when no standalones survived the filter). Authors with multiple
     series stay separate; standalones are collected ACROSS all authors
     into one pseudo-section so the user sees them in one place. */
  const { groups, hasAnyBooks } = useMemo(() => {
    const out: SeriesGroup[] = [];
    const standalones: LibraryBook[] = [];
    for (const author of authors) {
      for (const series of author.series) {
        const groupBooks: LibraryBook[] = [];
        for (const b of series.books) {
          if (b.isStandalone) standalones.push(b);
          else groupBooks.push(b);
        }
        if (groupBooks.length > 0) {
          out.push({
            id: `${author.name}::${series.name}`,
            label: `${author.name} — ${series.name}`,
            authorOverride: null,
            books: groupBooks,
          });
        }
      }
    }
    if (standalones.length > 0) {
      out.push({
        id: '__standalones__',
        label: 'Standalones',
        /* Standalones span every author with at least one standalone —
           keep the author column in the table to disambiguate. */
        authorOverride: 'show',
        books: standalones,
      });
    }
    const total = out.reduce((s, g) => s + g.books.length, 0);
    return { groups: out, hasAnyBooks: total > 0 };
  }, [authors]);

  /* Per-session collapse state. Initial value lazily reads "all
     expanded" — `false` means NOT collapsed, omitted means same.
     v1 doesn't persist this; the regression plan calls out the
     follow-up. */
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  if (!loaded) return <LibrarySkeleton />;
  if (isLibraryEmpty) return <EmptyLibrary onStartNew={onStartNew} />;
  if (!hasAnyBooks) return <NoFilterMatch onStartNew={onStartNew} />;

  return (
    <div className="space-y-8">
      {groups.map((group) => {
        const isCollapsed = collapsed[group.id] === true;
        return (
          <section key={group.id} data-testid={`library-table-section-${group.id}`}>
            <button
              type="button"
              onClick={() => setCollapsed((m) => ({ ...m, [group.id]: !isCollapsed }))}
              aria-expanded={!isCollapsed}
              aria-controls={`library-table-body-${group.id}`}
              className="w-full flex items-center justify-between gap-3 mb-3 px-1 py-1 rounded-lg hover:bg-ink/3 transition-colors"
            >
              <span className="inline-flex items-center gap-2">
                {isCollapsed ? (
                  <IconChevR className="w-3.5 h-3.5 text-ink/60" />
                ) : (
                  <IconArrowDn className="w-3.5 h-3.5 text-ink/60" />
                )}
                <span className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink/55">
                  {group.label}
                </span>
              </span>
              <span className="text-[11px] text-ink/40">
                {group.books.length} {group.books.length === 1 ? 'book' : 'books'}
              </span>
            </button>
            {!isCollapsed && (
              <div
                id={`library-table-body-${group.id}`}
                className="rounded-2xl border border-ink/10 bg-white overflow-hidden shadow-card"
              >
                <table className="w-full text-sm">
                  <thead className="bg-ink/2 text-[11px] uppercase tracking-wider text-ink/55">
                    <tr>
                      <th scope="col" className="w-[60px] py-2 pl-3 text-left font-semibold">
                        <span className="sr-only">Cover</span>
                      </th>
                      <th scope="col" className="py-2 px-2 text-left font-semibold">
                        Title
                      </th>
                      {group.authorOverride === 'show' && (
                        <th scope="col" className="py-2 px-2 text-left font-semibold">
                          Author
                        </th>
                      )}
                      <th scope="col" className="py-2 px-2 text-left font-semibold">
                        Status
                      </th>
                      <th scope="col" className="py-2 px-2 text-right font-semibold">
                        Runtime
                      </th>
                      <th scope="col" className="py-2 px-2 text-right font-semibold">
                        Characters
                      </th>
                      <th scope="col" className="py-2 px-2 text-right font-semibold">
                        Voices
                      </th>
                      <th scope="col" className="py-2 px-2 text-left font-semibold">
                        Last worked on
                      </th>
                      <th scope="col" className="w-[44px] py-2 pr-3 text-right font-semibold">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {group.books.map((book) => (
                      <BookRow
                        key={book.bookId}
                        book={book}
                        showAuthor={group.authorOverride === 'show'}
                        active={book.bookId === activeBookId}
                        onOpen={() => onOpenBook(book)}
                        onDelete={() => onDeleteBook(book)}
                        onReparse={() => onReparseBook(book)}
                        onReplace={(file) => onReplaceManuscript(book, file)}
                        onEdit={(patch) => onEditBook(book, patch)}
                        onCoverChanged={() => onCoverChanged?.(book)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function BookRow({
  book,
  showAuthor,
  active,
  onOpen,
  onDelete,
  onReparse,
  onReplace,
  onEdit,
  onCoverChanged,
}: {
  book: LibraryBook;
  showAuthor: boolean;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onReparse: () => void;
  onReplace: (file: File) => void;
  onEdit: (patch: EditBookMetaPatch) => Promise<void> | void;
  onCoverChanged?: () => Promise<void> | void;
}) {
  const meta = STATUS_UI[book.status];
  const [from, to] = book.coverGradient;
  const coverGrad = `linear-gradient(135deg, ${from}, ${to})`;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmReparse, setConfirmReparse] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [pendingReplaceFile, setPendingReplaceFile] = useState<File | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  /* Locally-overridden cover URL after the picker resolves. Mirrors the
     grid's cache-bust pattern so a fresh fetch from the same URL still
     paints new bytes. */
  const [coverOverride, setCoverOverride] = useState<string | null>(null);
  const [coverLoadFailed, setCoverLoadFailed] = useState(false);
  const effectiveCoverUrl =
    coverOverride !== null ? coverOverride || null : (book.coverImageUrl ?? null);

  const menuRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [menuOpen]);

  /* Title column copy: standalone → bare title; series → "#N  Title"
     prefix to make the series position scannable down the column. */
  const titleColumn = book.isStandalone ? (
    <span className="font-semibold text-ink">{book.title}</span>
  ) : (
    <span className="font-semibold text-ink">
      {book.seriesPosition != null && (
        <span className="text-ink/45 tabular-nums mr-2">#{book.seriesPosition}</span>
      )}
      {book.title}
    </span>
  );

  return (
    <tr
      data-testid={`library-table-row-${book.bookId}`}
      onClick={onOpen}
      className={`border-t border-ink/5 cursor-pointer transition-colors ${active ? 'bg-peach/6' : 'hover:bg-ink/2'}`}
    >
      <td className="py-2 pl-3 align-middle">
        <span
          className="block w-8 h-12 rounded-md overflow-hidden relative ring-1 ring-ink/10"
          style={{ background: coverGrad }}
        >
          {effectiveCoverUrl && !coverLoadFailed && (
            <img
              data-testid={`book-table-cover-${book.bookId}`}
              src={effectiveCoverUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              style={computeCoverStyle(book.coverFraming)}
              onError={() => setCoverLoadFailed(true)}
            />
          )}
        </span>
      </td>
      <td className="py-2 px-2 align-middle">
        <span className="inline-flex items-center gap-2">
          {titleColumn}
          {book.pinned && <IconStar className="w-3 h-3 text-ink/55" />}
          {active && (
            <span className="px-1.5 py-0.5 rounded-full bg-peach text-ink text-[9px] font-bold uppercase tracking-wider">
              Open
            </span>
          )}
        </span>
      </td>
      {showAuthor && (
        <td className="py-2 px-2 align-middle text-ink/70 text-xs">{book.author}</td>
      )}
      <td className="py-2 px-2 align-middle">
        <Pill color={meta.color}>
          <span className="inline-flex items-center gap-1.5">
            {meta.icon}
            {meta.label}
          </span>
        </Pill>
      </td>
      <td className="py-2 px-2 align-middle text-right text-ink/75 tabular-nums">
        {book.runtime ?? '—'}
      </td>
      <td className="py-2 px-2 align-middle text-right text-ink/75 tabular-nums">
        {book.characterCount || '—'}
      </td>
      <td className="py-2 px-2 align-middle text-right text-ink/75 tabular-nums">
        {book.voiceCount || '—'}
      </td>
      <td className="py-2 px-2 align-middle text-ink/60 text-xs whitespace-nowrap">
        {book.lastWorkedOn}
      </td>
      <td className="py-2 pr-3 align-middle text-right">
        <div ref={menuRef} className="relative inline-block">
          <button
            type="button"
            aria-label={`Actions for ${book.title}`}
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            className="w-7 h-7 grid place-items-center rounded-full text-ink/55 hover:text-ink hover:bg-ink/6 transition-colors"
          >
            <IconMore className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 mt-1.5 w-56 rounded-xl bg-white border border-ink/10 shadow-float overflow-hidden z-10 text-left"
              onClick={(e) => e.stopPropagation()}
            >
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setEditOpen(true);
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/4 inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconPencil className="w-4 h-4" /> Edit details
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setCoverPickerOpen(true);
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/4 inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconImage className="w-4 h-4" /> Find cover image
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmReparse(true);
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/4 inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconRefresh className="w-4 h-4" /> Re-parse manuscript
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  replaceInputRef.current?.click();
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/4 inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconRefresh className="w-4 h-4" /> Replace manuscript…
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmDelete(true);
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-red-700 hover:bg-red-50 inline-flex items-center gap-2"
              >
                <IconTrash className="w-4 h-4" /> Delete book
              </button>
            </div>
          )}
        </div>

        {/* Modals share the row's click-stop scope so they don't fire
            the row's onOpen handler when the user interacts. */}
        <div onClick={(e) => e.stopPropagation()}>
          <EditBookMetaModal
            open={editOpen}
            book={book}
            onClose={() => setEditOpen(false)}
            onSave={async (patch) => {
              setEditOpen(false);
              await onEdit(patch);
            }}
          />
          <CoverPicker
            open={coverPickerOpen}
            bookId={book.bookId}
            bookTitle={book.title}
            bookAuthor={book.author}
            currentCoverUrl={effectiveCoverUrl ?? undefined}
            currentFraming={book.coverFraming}
            onClose={() => setCoverPickerOpen(false)}
            onPicked={(newUrl) => {
              setCoverLoadFailed(false);
              setCoverOverride(newUrl ? `${newUrl}?t=${Date.now()}` : '');
              void onCoverChanged?.();
            }}
          />
          <ConfirmDialog
            open={confirmReparse}
            eyebrow="Re-parse"
            title={book.title}
            icon={<IconRefresh className="w-4 h-4" />}
            body={
              <div className="space-y-2">
                <p>
                  This re-detects chapters from the manuscript file using the current parser rules.
                </p>
                <p className="text-ink/60">
                  The manuscript file on disk stays as-is. Cached analysis, cast, and any generated
                  audio are discarded — you'll need to confirm the cast again before generating.
                </p>
              </div>
            }
            confirmLabel="Re-parse manuscript"
            onConfirm={() => {
              setConfirmReparse(false);
              onReparse();
            }}
            onClose={() => setConfirmReparse(false)}
          />
          <input
            ref={replaceInputRef}
            data-testid="replace-manuscript-input"
            type="file"
            accept=".txt,.md,.epub,.pdf"
            aria-hidden="true"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null;
              e.target.value = '';
              if (f) {
                setPendingReplaceFile(f);
                setConfirmReplace(true);
              }
            }}
          />
          <ConfirmDialog
            open={confirmReplace}
            eyebrow="Replace"
            title={book.title}
            icon={<IconRefresh className="w-4 h-4" />}
            body={
              <div className="space-y-2">
                <p>This replaces the manuscript file and re-detects chapters from the new file.</p>
                <p className="text-ink/60">
                  Cached analysis and any generated audio are discarded. Designed voices are
                  preserved where characters still match — you'll confirm the cast again before
                  generating.
                </p>
              </div>
            }
            confirmLabel="Replace manuscript"
            onConfirm={() => {
              setConfirmReplace(false);
              const f = pendingReplaceFile;
              setPendingReplaceFile(null);
              if (f) onReplace(f);
            }}
            onClose={() => {
              setConfirmReplace(false);
              setPendingReplaceFile(null);
            }}
          />
          <ConfirmDialog
            open={confirmDelete}
            eyebrow="Delete"
            title={book.title}
            icon={<IconTrash className="w-4 h-4" />}
            variant="danger"
            body={
              <div className="space-y-2">
                <p>This removes the book directory from disk and discards any cached analysis.</p>
                <p className="text-red-700/80 font-medium">Can't be undone.</p>
              </div>
            }
            confirmLabel="Delete book"
            onConfirm={() => {
              setConfirmDelete(false);
              onDelete();
            }}
            onClose={() => setConfirmDelete(false)}
          />
        </div>
      </td>
    </tr>
  );
}
