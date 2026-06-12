/* Book-library grid region — pure presentational lift from
   book-library.tsx. Owns: the three render branches (skeleton when
   library.loaded is false, empty-state when there are no authors,
   populated author→series→BookCard grid otherwise), the per-book
   `BookCard` (cover art, status pill, action menu, edit/cover/
   re-parse/delete modals, paused-snapshot badge), the `NewBookCard`
   trailing tile, and the `EmptyLibrary` / `LibrarySkeleton`
   placeholders.

   Behaviour-neutral lift — every data-testid, className, and child
   order matches the pre-refactor JSX so book-library.test.tsx
   selectors keep resolving. The filtering decision lives in the
   orchestrator's `matchesFilter` helper; this region just renders
   the already-filtered authors prop. */

import { useEffect, useRef, useState } from 'react';
import {
  IconPlus,
  IconStar,
  IconMore,
  IconTrash,
  IconRefresh,
  IconUpload,
  IconPencil,
  IconImage,
} from '../../lib/icons';
import { Pill } from '../primitives';
import { Stat } from '../stat-tiles';
import { ConfirmDialog } from '../../modals/confirm-dialog';
import { EditBookMetaModal, type EditBookMetaPatch } from '../../modals/edit-book-meta';
import { CoverPicker } from '../../modals/cover-picker';
import { type CoverFraming, computeCoverStyle } from '../../lib/cover-framing';
import { useAppSelector } from '../../store';
import { selectPausedSnapshotForBook } from '../../store/library-slice';
import type { LibraryAuthor, LibraryBook } from '../../lib/types';
import { SAMPLE } from '../../lib/tour-steps';
import { STATUS_UI } from './library-status-ui';
import { EmptyLibrary, LibrarySkeleton } from './library-empty-states';

interface Props {
  loaded: boolean;
  /** `true` when the underlying library has no books at all (pre-filter).
      Distinct from "filtered down to zero" — the empty-state copy fires on
      a genuinely-empty library only; an active filter that hides every
      card just shows the NewBookCard tile with no series rows above it,
      matching pre-split semantics. */
  isLibraryEmpty: boolean;
  /** Authors are pre-filtered by the orchestrator — each series.books
      list already reflects the active filter, and authors with no
      matching books have been dropped. The grid just renders. */
  authors: LibraryAuthor[];
  activeBookId: string | null;
  onOpenBook: (book: LibraryBook) => void;
  onDeleteBook: (book: LibraryBook) => void;
  onReparseBook: (book: LibraryBook) => void;
  onReplaceManuscript: (book: LibraryBook, file: File) => void | Promise<void>;
  onEditBook: (book: LibraryBook, patch: EditBookMetaPatch) => Promise<void>;
  onCoverChanged?: (book: LibraryBook) => Promise<void> | void;
  onStartNew: () => void;
  onTrySample?: () => void | Promise<void>;
}

export function LibraryGrid({
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
  onTrySample,
}: Props) {
  if (!loaded) return <LibrarySkeleton />;
  if (isLibraryEmpty) return <EmptyLibrary onStartNew={onStartNew} onTrySample={onTrySample} />;
  return (
    <div className="space-y-10">
      {authors.map((author) => (
        <section key={author.name}>
          <h2 className="font-serif text-xl font-bold text-ink mb-1">{author.name}</h2>
          <div className="mt-4 space-y-8">
            {author.series.map((series) => (
              <div key={series.name}>
                <div className="flex items-baseline justify-between mb-3">
                  <h3 className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink/55">
                    {series.name}
                  </h3>
                  <span className="text-[11px] text-ink/40">
                    {series.books.length} {series.books.length === 1 ? 'book' : 'books'}
                  </span>
                </div>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                  {series.books.map((b) => (
                    <BookCard
                      key={b.bookId}
                      book={b}
                      active={b.bookId === activeBookId}
                      onOpen={() => onOpenBook(b)}
                      onDelete={() => onDeleteBook(b)}
                      onReparse={() => onReparseBook(b)}
                      onReplace={(file) => onReplaceManuscript(b, file)}
                      onEdit={(patch) => onEditBook(b, patch)}
                      onCoverChanged={() => onCoverChanged?.(b)}
                    />
                  ))}
                </div>
              </div>
            ))}
          </div>
        </section>
      ))}
      <NewBookCard onStartNew={onStartNew} />
    </div>
  );
}

function BookCard({
  book,
  active,
  onOpen,
  onDelete,
  onReparse,
  onReplace,
  onEdit,
  onCoverChanged,
}: {
  book: LibraryBook;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onReparse: () => void;
  onReplace: (file: File) => void;
  onEdit: (patch: EditBookMetaPatch) => Promise<void> | void;
  onCoverChanged?: () => Promise<void> | void;
}) {
  const [from, to] = book.coverGradient;
  const grad = `linear-gradient(135deg, ${from}, ${to})`;
  const meta = STATUS_UI[book.status];
  /* Paused/halted snapshot from the cold-boot active-analyses scan.
     Drives the "Paused — resume?" / "Halted — review?" badge. Only
     rendered when the card is NOT the currently-open book — when it
     IS the open card the top-bar AnalysisPill already conveys the
     same information, and the cover badge would collide with the
     "Open" badge. */
  const pausedSnapshot = useAppSelector((s) => selectPausedSnapshotForBook(s, book.bookId));
  const seriesLine = book.isStandalone
    ? 'Standalone'
    : book.seriesPosition != null
      ? `${book.series} · Book ${book.seriesPosition}`
      : book.series;
  const [menuOpen, setMenuOpen] = useState(false);
  const [confirmReparse, setConfirmReparse] = useState(false);
  const [confirmReplace, setConfirmReplace] = useState(false);
  const [pendingReplaceFile, setPendingReplaceFile] = useState<File | null>(null);
  const replaceInputRef = useRef<HTMLInputElement | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [coverPickerOpen, setCoverPickerOpen] = useState(false);
  /* Locally-overridden cover URL after the picker resolves. The library
     slice re-hydrates async via onCoverChanged, but a same-URL refetch
     (`/api/books/:bookId/cover`) is fronted by the browser's HTTP cache —
     append a busting timestamp so the new bytes paint immediately. Empty
     string means "the user just removed the cover; ignore book.coverImageUrl
     until the slice catches up". */
  const [coverOverride, setCoverOverride] = useState<string | null>(null);
  /* Plan 40 — local framing override mirrors coverOverride pattern so
     the BookCard repaints framing immediately after a Frame-tab gesture,
     ahead of the library slice rehydrate. */
  const [framingOverride, setFramingOverride] = useState<CoverFraming | null>(null);
  const effectiveFraming = framingOverride ?? book.coverFraming;
  /* Tracks <img> load failures so we can fall back to the gradient
     skeleton without leaving a stale broken image rendered on top. */
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
  return (
    <article
      onClick={onOpen}
      className={`group relative bg-white rounded-3xl border shadow-card hover:shadow-float transition-all cursor-pointer overflow-hidden ${active ? 'border-peach ring-1 ring-peach/30' : 'border-ink/10 hover:border-ink/20'}`}
      {...(book.bookId === SAMPLE.bookId ? { 'data-tour-id': 'book-card' } : {})}
    >
      <div className="aspect-16/10 relative overflow-hidden" style={{ background: grad }}>
        <svg viewBox="0 0 320 200" className="absolute inset-0 w-full h-full opacity-20">
          <circle cx="60" cy="100" r="80" fill="none" stroke="white" strokeWidth="0.5" />
          <circle cx="60" cy="100" r="60" fill="none" stroke="white" strokeWidth="0.5" />
          <circle cx="60" cy="100" r="40" fill="none" stroke="white" strokeWidth="0.5" />
        </svg>
        {effectiveCoverUrl && !coverLoadFailed && (
          <img
            data-testid={`book-cover-${book.bookId}`}
            src={effectiveCoverUrl}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
            style={computeCoverStyle(effectiveFraming)}
            onError={() => setCoverLoadFailed(true)}
          />
        )}
        <div className="absolute top-5 left-5 right-5 flex items-center justify-between">
          <p className="text-[9px] uppercase tracking-[0.2em] text-white/70 font-semibold">
            Audiobook
          </p>
          {book.pinned && <IconStar className="w-3.5 h-3.5 text-white/80" />}
        </div>
        {!effectiveCoverUrl || coverLoadFailed ? (
          <div className="absolute bottom-5 left-5 right-5">
            <h3 className="font-serif text-2xl font-bold text-white leading-tight">{book.title}</h3>
            <p className="text-[10px] text-white/70 mt-1">{seriesLine}</p>
          </div>
        ) : null}
        {active && (
          <span className="absolute top-4 right-4 px-2 py-0.5 rounded-full bg-peach text-ink text-[10px] font-bold uppercase tracking-wider">
            Open
          </span>
        )}
        {!active && pausedSnapshot && (
          <span
            data-testid={`paused-badge-${book.bookId}`}
            className={`absolute top-4 right-4 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider border ${
              pausedSnapshot.state === 'halted'
                ? 'bg-rose-100 text-rose-800 border-rose-200'
                : 'bg-amber-100 text-amber-800 border-amber-200'
            }`}
          >
            {pausedSnapshot.state === 'halted' ? 'Halted — review?' : 'Paused — resume?'}
          </span>
        )}
        <div ref={menuRef} className="absolute top-3.5 right-3.5">
          <button
            onClick={(e) => {
              e.stopPropagation();
              setMenuOpen((o) => !o);
            }}
            aria-label="Book options"
            className="w-7 h-7 grid place-items-center rounded-full bg-black/30 hover:bg-black/50 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            <IconMore className="w-4 h-4" />
          </button>
          {menuOpen && (
            <div
              className="absolute right-0 mt-1.5 w-56 rounded-xl bg-white border border-ink/10 shadow-float overflow-hidden z-10"
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
                <IconUpload className="w-4 h-4" /> Replace manuscript…
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
      </div>

      <div className="p-5">
        {/* Bug 9 — always-visible metadata strip. Cover art alone can't
            convey the series position ("Book 7"), and even when the title
            is baked into the artwork (The Hollow Tide) it's
            useful to have a labelled fallback for screen readers and any
            book whose cover is title-less. The old gating on
            `!effectiveCoverUrl || coverLoadFailed` (lines 387–392) hid
            both pieces the moment a cover image rendered. */}
        <div data-testid={`book-meta-strip-${book.bookId}`} className="mb-3">
          <p className="text-sm font-semibold text-ink leading-snug truncate">{book.title}</p>
          <p className="text-xs text-ink/55 leading-snug truncate">{seriesLine}</p>
        </div>
        <div className="flex items-center justify-between gap-2 mb-3">
          <Pill color={meta.color}>
            <span className="inline-flex items-center gap-1.5">
              {meta.icon}
              {meta.label}
            </span>
          </Pill>
          <span className="text-[11px] text-ink/50">{book.lastWorkedOn}</span>
        </div>

        {book.status === 'generating' && book.progress != null && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[11px] text-ink/60 mb-1.5">
              <span>
                {book.completedChapters} of {book.chapterCount} chapters
              </span>
              <span className="tabular-nums font-bold text-ink">
                {Math.round(book.progress * 100)}%
              </span>
            </div>
            <div className="h-1 rounded-full bg-ink/6 overflow-hidden">
              <div
                className="h-full bg-gradient-progress rounded-full"
                style={{ width: `${book.progress * 100}%` }}
              />
            </div>
          </div>
        )}
        {book.status === 'analysing' && book.progress != null && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[11px] text-ink/60 mb-1.5">
              <span>Reading manuscript…</span>
              <span className="tabular-nums font-bold text-ink">
                {Math.round(book.progress * 100)}%
              </span>
            </div>
            <div className="h-1 rounded-full bg-ink/6 overflow-hidden relative">
              <div
                className="h-full bg-gradient-progress rounded-full pulse-bar"
                style={{ width: `${book.progress * 100}%` }}
              >
                <div className="absolute inset-0 stripe-travel" />
              </div>
            </div>
          </div>
        )}
        {book.status === 'cast_pending' && (book.matchedFromLibrary ?? 0) > 0 && (
          <p className="mb-3 text-xs text-purple-deep/80 leading-relaxed">
            <span className="font-semibold">
              {book.matchedFromLibrary} of {book.characterCount}
            </span>{' '}
            characters matched from your library — review and confirm.
          </p>
        )}
        {book.status === 'complete' && (
          <p className="mb-3 text-xs text-emerald-700 leading-relaxed">
            <span className="font-semibold">{book.runtime ?? '—'}</span> · ready to listen and
            share.
          </p>
        )}
        {book.status === 'not_analysed' && (
          <p className="mb-3 text-xs text-ink/60 leading-relaxed">
            Manuscript on disk, analysis not started yet. Open to begin.
          </p>
        )}
        {(book.status === 'unreadable' || book.status === 'orphaned') && (
          <p className="mb-3 text-xs text-red-700 leading-relaxed">
            {book.status === 'unreadable'
              ? 'state.json could not be parsed.'
              : 'manuscript file missing from disk.'}
          </p>
        )}

        <div className="grid grid-cols-3 gap-3 text-center pt-3 border-t border-ink/5">
          <Stat label="Chapters" value={book.chapterCount || '—'} />
          <Stat label="Voices" value={book.voiceCount || '—'} />
          <Stat label="Runtime" value={book.runtime ?? '—'} small />
        </div>
      </div>

      {/* Confirmation dialogs — rendered inside the card so click events stay
          scoped (the card's onClick is the open-book handler; the dialog's
          backdrop stops propagation by being position:fixed and on a higher
          z-index). */}
      <div onClick={(e) => e.stopPropagation()}>
        <EditBookMetaModal
          open={editOpen}
          book={book}
          onClose={() => setEditOpen(false)}
          onSave={async (patch) => {
            /* Close optimistically and let the parent handler surface any
               errors through the layout's showError toast. Mirrors the
               delete/reparse pattern. */
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
          currentFraming={effectiveFraming}
          onClose={() => setCoverPickerOpen(false)}
          onPicked={(newUrl) => {
            /* Empty string = the user picked "Remove cover". Bust the
               cache when setting a fresh URL so the browser fetches the
               new bytes from the same `/api/books/:bookId/cover` path. */
            setCoverLoadFailed(false);
            setCoverOverride(newUrl ? `${newUrl}?t=${Date.now()}` : '');
            /* Fresh image → drop framing override so the slice's value wins. */
            setFramingOverride(null);
            void onCoverChanged?.();
          }}
          onFramingChanged={(f) => setFramingOverride(f)}
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
          accept=".md,.markdown,.txt,.text,.pdf,.epub,.mobi,.azw3"
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
          icon={<IconUpload className="w-4 h-4" />}
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
    </article>
  );
}

function NewBookCard({ onStartNew }: { onStartNew: () => void }) {
  return (
    <button
      onClick={onStartNew}
      data-tour-id="new-book-btn"
      className="group bg-canvas rounded-3xl border-2 border-dashed border-ink/15 hover:border-peach hover:bg-peach/4 transition-all min-h-[180px] grid place-items-center text-center p-8"
    >
      <div>
        <span className="w-14 h-14 mx-auto rounded-full bg-white border border-ink/10 grid place-items-center group-hover:bg-peach group-hover:border-peach group-hover:text-white transition-colors text-ink">
          <IconPlus className="w-6 h-6" />
        </span>
        <p className="mt-4 text-base font-bold text-ink">Add another book</p>
        <p className="mt-1 text-xs text-ink/55 max-w-[280px] mx-auto leading-relaxed">
          Drop in a manuscript and we'll meet your cast within a couple of minutes.
        </p>
      </div>
    </button>
  );
}

