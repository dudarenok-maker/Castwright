import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconPlus,
  IconStar,
  IconCheck,
  IconSpinner,
  IconCheckCircle,
  IconWarning,
  IconMore,
  IconTrash,
  IconRefresh,
  IconFolder,
  IconCopy,
  IconPencil,
  IconImage,
} from '../lib/icons';
import { SectionLabel, MixedHeading, PrimaryButton, Pill } from '../components/primitives';
import { parseRuntime, formatHours } from '../lib/time';
import { StatTile } from './voices';
import { Stat } from './generation';
import { ConfirmDialog } from '../modals/confirm-dialog';
import { EditBookMetaModal, type EditBookMetaPatch } from '../modals/edit-book-meta';
import { CoverPicker } from '../modals/cover-picker';
import { type CoverFraming, computeCoverStyle } from '../lib/cover-framing';
import { api, type WorkspaceInfo } from '../lib/api';
import { useAppSelector } from '../store';
import { selectPausedSnapshotForBook } from '../store/library-slice';
import type { LibraryAuthor, LibraryBook, LibraryBookStatus } from '../lib/types';

type Filter = 'all' | 'in_progress' | 'complete';

interface Props {
  authors: LibraryAuthor[];
  activeBookId: string | null;
  onOpenBook: (book: LibraryBook) => void;
  onDeleteBook: (book: LibraryBook) => void;
  onReparseBook: (book: LibraryBook) => void;
  onEditBook: (book: LibraryBook, patch: EditBookMetaPatch) => Promise<void>;
  /** Fires after the CoverPicker modal successfully updates the book's
      cover (either picked a new candidate or removed the existing one).
      The parent should refresh the library so the new `coverImageUrl`
      propagates back through the slice. */
  onCoverChanged?: (book: LibraryBook) => Promise<void> | void;
  onStartNew: () => void;
}

const IN_PROGRESS_STATUSES = new Set<LibraryBookStatus>([
  'analysing',
  'cast_pending',
  'generating',
  'not_analysed',
]);

function matchesFilter(book: LibraryBook, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'in_progress') return IN_PROGRESS_STATUSES.has(book.status);
  if (filter === 'complete') return book.status === 'complete';
  return true;
}

export function BookLibraryView({
  authors,
  activeBookId,
  onOpenBook,
  onDeleteBook,
  onReparseBook,
  onEditBook,
  onCoverChanged,
  onStartNew,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  /* First word of the user's display name → "Welcome back, Mike". Falls back
     to "back" when the user hasn't set a name (keeps the heading grammatical). */
  const displayName = useAppSelector((s) => s.account.displayName);
  const firstName = displayName.trim().split(/\s+/)[0] || 'back';
  /* Distinguish "fetch hasn't resolved yet" from "fetched and genuinely empty".
     Without this, the first paint flashes <EmptyLibrary> for the duration of
     the api.getLibrary() round-trip — reads as "library wiped." Skeleton stays
     up until libraryActions.hydrate fires (set by src/components/layout.tsx). */
  const loaded = useAppSelector((s) => s.library.loaded);
  /* Surface the active workspace root so a stale `WORKSPACE_DIR` override
     (or worse: silently falling back to the in-repo default) is obvious at
     a glance. Page-local state — only the Books page needs this; widening
     to a slice would be overkill. Failures are swallowed silently because
     the path is informational, not load-bearing. */
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);
  useEffect(() => {
    let cancelled = false;
    api
      .getWorkspaceInfo()
      .then((info) => {
        if (!cancelled) setWorkspace(info);
      })
      .catch(() => {
        /* silent — header just hides the path */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const allBooks = useMemo(
    () => authors.flatMap((a) => a.series.flatMap((s) => s.books)),
    [authors],
  );
  const totals = {
    books: allBooks.length,
    runtime: allBooks.reduce((s, b) => s + (b.runtime ? parseRuntime(b.runtime) : 0), 0),
    voices: allBooks.reduce((s, b) => s + (b.voiceCount || 0), 0),
    inProgress: allBooks.filter((b) => IN_PROGRESS_STATUSES.has(b.status)).length,
  };
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all', label: `All (${totals.books})` },
    { id: 'in_progress', label: `In progress (${totals.inProgress})` },
    {
      id: 'complete',
      label: `Complete (${allBooks.filter((b) => b.status === 'complete').length})`,
    },
  ];

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Your audiobooks</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Welcome back," bold={firstName} level="h1" />
          </div>
          <p className="mt-3 text-ink/60 max-w-xl">
            Pick up where you left off, or start a new book. Voices stay consistent across a series
            — characters who appear in book one carry through to book seven.
          </p>
          {workspace && <WorkspacePathRow info={workspace} />}
        </div>
        <PrimaryButton variant="dark" onClick={onStartNew}>
          <span className="inline-flex items-center gap-2">
            <IconPlus className="w-4 h-4" />
            Start a new book
          </span>
        </PrimaryButton>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatTile label="Books" value={totals.books} />
        <StatTile label="Total runtime" value={formatHours(totals.runtime)} />
        <StatTile label="Voices" value={totals.voices} />
        <StatTile label="In progress" value={totals.inProgress} />
      </div>

      <div className="flex items-center gap-1 mb-6">
        {filters.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === f.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]'}`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {!loaded ? (
        <LibrarySkeleton />
      ) : authors.length === 0 ? (
        <EmptyLibrary onStartNew={onStartNew} />
      ) : (
        <div className="space-y-10">
          {authors.map((author) => {
            const visibleSeries = author.series
              .map((series) => ({
                ...series,
                books: series.books.filter((b) => matchesFilter(b, filter)),
              }))
              .filter((series) => series.books.length > 0);
            if (visibleSeries.length === 0) return null;
            return (
              <section key={author.name}>
                <h2 className="font-serif text-xl font-bold text-ink mb-1">{author.name}</h2>
                <div className="mt-4 space-y-8">
                  {visibleSeries.map((series) => (
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
                            onEdit={(patch) => onEditBook(b, patch)}
                            onCoverChanged={() => onCoverChanged?.(b)}
                          />
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          <NewBookCard onStartNew={onStartNew} />
        </div>
      )}
    </div>
  );
}

function WorkspacePathRow({ info }: { info: WorkspaceInfo }) {
  const [copied, setCopied] = useState(false);
  const onCopy = () => {
    /* navigator.clipboard is async + secure-context-gated. The local dev
       server runs on http://localhost which Chrome treats as secure, so this
       resolves; the catch is the safety net for headless tests / iframes. */
    void navigator.clipboard
      .writeText(info.root)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };
  /* "default" means WORKSPACE_DIR wasn't set, so the path is the in-repo
     fallback. Surface that in amber — it's not broken but it's almost
     always not what the user wanted on a Windows + OneDrive workspace. */
  const fromDefault = info.source === 'default';
  return (
    <p
      title={
        fromDefault
          ? `Workspace is using the default \`../audiobook-workspace\` inside the repo. Set WORKSPACE_DIR in server/.env to relocate.`
          : `Workspace root from WORKSPACE_DIR env var.`
      }
      className={`mt-2 inline-flex items-center gap-2 text-xs font-mono ${fromDefault ? 'text-amber-700' : 'text-ink/55'}`}
    >
      <IconFolder className={`w-3.5 h-3.5 ${fromDefault ? 'text-amber-600' : 'text-ink/45'}`} />
      <span className="truncate max-w-[520px]">{info.root}</span>
      <button
        onClick={onCopy}
        className="ml-1 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] uppercase tracking-wider font-semibold text-ink/55 hover:text-ink hover:bg-ink/[0.05] transition-colors"
      >
        <IconCopy className="w-3 h-3" />
        {copied ? 'copied' : 'copy'}
      </button>
    </p>
  );
}

type StatusMeta = {
  color: 'library' | 'warning' | 'peach' | 'success' | 'danger';
  label: string;
  icon: JSX.Element;
};

const STATUS_UI: Record<LibraryBookStatus, StatusMeta> = {
  not_analysed: {
    color: 'library',
    label: 'Ready to analyse',
    icon: <IconPlus className="w-3.5 h-3.5" />,
  },
  analysing: {
    color: 'library',
    label: 'Analysing',
    icon: <IconSpinner className="w-3.5 h-3.5" />,
  },
  cast_pending: {
    color: 'warning',
    label: 'Cast confirmation',
    icon: <IconCheckCircle className="w-3.5 h-3.5" />,
  },
  generating: {
    color: 'peach',
    label: 'Generating',
    icon: <IconSpinner className="w-3.5 h-3.5" />,
  },
  complete: { color: 'success', label: 'Complete', icon: <IconCheck className="w-3.5 h-3.5" /> },
  unreadable: {
    color: 'danger',
    label: 'State unreadable',
    icon: <IconWarning className="w-3.5 h-3.5" />,
  },
  orphaned: {
    color: 'danger',
    label: 'Manuscript missing',
    icon: <IconWarning className="w-3.5 h-3.5" />,
  },
};

function BookCard({
  book,
  active,
  onOpen,
  onDelete,
  onReparse,
  onEdit,
  onCoverChanged,
}: {
  book: LibraryBook;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
  onReparse: () => void;
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
    >
      <div className="aspect-[16/10] relative overflow-hidden" style={{ background: grad }}>
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
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/[0.04] inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconPencil className="w-4 h-4" /> Edit details
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setCoverPickerOpen(true);
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/[0.04] inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconImage className="w-4 h-4" /> Find cover image
              </button>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  setConfirmReparse(true);
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-ink hover:bg-ink/[0.04] inline-flex items-center gap-2 border-b border-ink/5"
              >
                <IconRefresh className="w-4 h-4" /> Re-parse manuscript
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
            <div className="h-1 rounded-full bg-ink/[0.06] overflow-hidden">
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
            <div className="h-1 rounded-full bg-ink/[0.06] overflow-hidden relative">
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
      className="group bg-canvas rounded-3xl border-2 border-dashed border-ink/15 hover:border-peach hover:bg-peach/[0.04] transition-all min-h-[180px] grid place-items-center text-center p-8"
    >
      <div>
        <span className="w-14 h-14 mx-auto rounded-full bg-white border border-ink/10 grid place-items-center group-hover:bg-peach group-hover:border-peach group-hover:text-white transition-colors text-ink">
          <IconPlus className="w-6 h-6" />
        </span>
        <p className="mt-4 text-base font-bold text-ink">Start a new book</p>
        <p className="mt-1 text-xs text-ink/55 max-w-[280px] mx-auto leading-relaxed">
          Drop in a manuscript and we'll meet your cast within a couple of minutes.
        </p>
      </div>
    </button>
  );
}

function EmptyLibrary({ onStartNew }: { onStartNew: () => void }) {
  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-12 text-center">
      <span className="w-16 h-16 mx-auto rounded-full bg-peach/10 grid place-items-center text-peach">
        <IconPlus className="w-7 h-7" />
      </span>
      <h3 className="mt-5 font-serif text-2xl font-bold text-ink">Your library is empty</h3>
      <p className="mt-2 text-sm text-ink/60 max-w-md mx-auto leading-relaxed">
        Books live on disk under{' '}
        <code className="px-1.5 py-0.5 rounded bg-ink/5 text-[12px]">
          audiobook-workspace/books/&lt;Author&gt;/&lt;Series&gt;/&lt;Title&gt;/
        </code>
        . Import a manuscript and we'll lay it out for you.
      </p>
      <div className="mt-6">
        <PrimaryButton variant="dark" onClick={onStartNew}>
          <span className="inline-flex items-center gap-2">
            <IconPlus className="w-4 h-4" />
            Import your first book
          </span>
        </PrimaryButton>
      </div>
    </div>
  );
}

/* Placeholder rendered while `library.loaded` is false. Mirrors the populated
   grid shape (one author block, one series row, three cards) so the layout
   doesn't shift when real data swaps in. Height matches `min-h-[180px]` on
   NewBookCard/BookCard. Reads as "loading" via Tailwind animate-pulse. */
function LibrarySkeleton() {
  return (
    <div className="space-y-10" data-testid="library-skeleton" aria-hidden="true">
      <section>
        <div className="h-6 w-40 rounded bg-ink/[0.06] animate-pulse mb-3" />
        <div className="mt-4 space-y-8">
          <div>
            <div className="flex items-baseline justify-between mb-3">
              <div className="h-3 w-28 rounded bg-ink/[0.06] animate-pulse" />
              <div className="h-3 w-14 rounded bg-ink/[0.04] animate-pulse" />
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
              <div className="min-h-[180px] rounded-3xl bg-ink/[0.04] animate-pulse" />
              <div className="min-h-[180px] rounded-3xl bg-ink/[0.04] animate-pulse" />
              <div className="min-h-[180px] rounded-3xl bg-ink/[0.04] animate-pulse" />
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
