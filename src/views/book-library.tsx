import { useEffect, useMemo, useRef, useState } from 'react';
import {
  IconPlus, IconStar, IconCheck, IconSpinner, IconCheckCircle, IconWarning,
  IconMore, IconTrash,
} from '../lib/icons';
import {
  SectionLabel, MixedHeading, PrimaryButton, Pill,
} from '../components/primitives';
import { parseRuntime, formatHours } from '../lib/time';
import { StatTile } from './voices';
import { Stat } from './generation';
import type { LibraryAuthor, LibraryBook, LibraryBookStatus } from '../lib/types';

type Filter = 'all' | 'in_progress' | 'complete';

interface Props {
  authors: LibraryAuthor[];
  activeBookId: string | null;
  onOpenBook: (book: LibraryBook) => void;
  onDeleteBook: (book: LibraryBook) => void;
  onStartNew: () => void;
}

const IN_PROGRESS_STATUSES = new Set<LibraryBookStatus>([
  'analysing', 'cast_pending', 'generating', 'not_analysed',
]);

function matchesFilter(book: LibraryBook, filter: Filter): boolean {
  if (filter === 'all') return true;
  if (filter === 'in_progress') return IN_PROGRESS_STATUSES.has(book.status);
  if (filter === 'complete')    return book.status === 'complete';
  return true;
}

export function BookLibraryView({ authors, activeBookId, onOpenBook, onDeleteBook, onStartNew }: Props) {
  const [filter, setFilter] = useState<Filter>('all');

  const allBooks = useMemo(
    () => authors.flatMap(a => a.series.flatMap(s => s.books)),
    [authors],
  );
  const totals = {
    books: allBooks.length,
    runtime: allBooks.reduce((s, b) => s + (b.runtime ? parseRuntime(b.runtime) : 0), 0),
    voices: allBooks.reduce((s, b) => s + (b.voiceCount || 0), 0),
    inProgress: allBooks.filter(b => IN_PROGRESS_STATUSES.has(b.status)).length,
  };
  const filters: Array<{ id: Filter; label: string }> = [
    { id: 'all',         label: `All (${totals.books})` },
    { id: 'in_progress', label: `In progress (${totals.inProgress})` },
    { id: 'complete',    label: `Complete (${allBooks.filter(b => b.status === 'complete').length})` },
  ];

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      <div className="mb-8 flex items-end justify-between gap-6 flex-wrap">
        <div>
          <SectionLabel>Your audiobooks</SectionLabel>
          <div className="mt-4">
            <MixedHeading regular="Welcome back," bold="Mike" level="h1"/>
          </div>
          <p className="mt-3 text-ink/60 max-w-xl">Pick up where you left off, or start a new book. Voices stay consistent across a series — characters who appear in book one carry through to book seven.</p>
        </div>
        <PrimaryButton variant="dark" onClick={onStartNew}>
          <span className="inline-flex items-center gap-2"><IconPlus className="w-4 h-4"/>Start a new book</span>
        </PrimaryButton>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatTile label="Books"         value={totals.books}/>
        <StatTile label="Total runtime" value={formatHours(totals.runtime)}/>
        <StatTile label="Voices"        value={totals.voices}/>
        <StatTile label="In progress"   value={totals.inProgress}/>
      </div>

      <div className="flex items-center gap-1 mb-6">
        {filters.map(f => (
          <button key={f.id} onClick={() => setFilter(f.id)} className={`px-4 py-2 rounded-full text-sm font-medium transition-colors ${filter === f.id ? 'bg-ink text-canvas' : 'text-ink/60 hover:text-ink hover:bg-ink/[0.04]'}`}>{f.label}</button>
        ))}
      </div>

      {authors.length === 0 ? (
        <EmptyLibrary onStartNew={onStartNew}/>
      ) : (
        <div className="space-y-10">
          {authors.map(author => {
            const visibleSeries = author.series
              .map(series => ({ ...series, books: series.books.filter(b => matchesFilter(b, filter)) }))
              .filter(series => series.books.length > 0);
            if (visibleSeries.length === 0) return null;
            return (
              <section key={author.name}>
                <h2 className="font-serif text-xl font-bold text-ink mb-1">{author.name}</h2>
                <div className="mt-4 space-y-8">
                  {visibleSeries.map(series => (
                    <div key={series.name}>
                      <div className="flex items-baseline justify-between mb-3">
                        <h3 className="text-[11px] uppercase tracking-[0.18em] font-semibold text-ink/55">{series.name}</h3>
                        <span className="text-[11px] text-ink/40">{series.books.length} {series.books.length === 1 ? 'book' : 'books'}</span>
                      </div>
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
                        {series.books.map(b => (
                          <BookCard key={b.bookId} book={b} active={b.bookId === activeBookId} onOpen={() => onOpenBook(b)} onDelete={() => onDeleteBook(b)}/>
                        ))}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            );
          })}
          <NewBookCard onStartNew={onStartNew}/>
        </div>
      )}
    </div>
  );
}

type StatusMeta = { color: 'library' | 'warning' | 'peach' | 'success' | 'danger'; label: string; icon: JSX.Element };

const STATUS_UI: Record<LibraryBookStatus, StatusMeta> = {
  not_analysed: { color: 'library', label: 'Ready to analyse',  icon: <IconPlus className="w-3.5 h-3.5"/> },
  analysing:    { color: 'library', label: 'Analysing',         icon: <IconSpinner className="w-3.5 h-3.5"/> },
  cast_pending: { color: 'warning', label: 'Cast confirmation', icon: <IconCheckCircle className="w-3.5 h-3.5"/> },
  generating:   { color: 'peach',   label: 'Generating',        icon: <IconSpinner className="w-3.5 h-3.5"/> },
  complete:     { color: 'success', label: 'Complete',          icon: <IconCheck className="w-3.5 h-3.5"/> },
  unreadable:   { color: 'danger',  label: 'State unreadable',  icon: <IconWarning className="w-3.5 h-3.5"/> },
  orphaned:     { color: 'danger',  label: 'Manuscript missing',icon: <IconWarning className="w-3.5 h-3.5"/> },
};

function BookCard({ book, active, onOpen, onDelete }: { book: LibraryBook; active: boolean; onOpen: () => void; onDelete: () => void }) {
  const [from, to] = book.coverGradient;
  const grad = `linear-gradient(135deg, ${from}, ${to})`;
  const meta = STATUS_UI[book.status];
  const seriesLine = book.isStandalone
    ? 'Standalone'
    : book.seriesPosition != null
      ? `${book.series} · Book ${book.seriesPosition}`
      : book.series;
  const [menuOpen, setMenuOpen] = useState(false);
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
    <article onClick={onOpen} className={`group relative bg-white rounded-3xl border shadow-card hover:shadow-float transition-all cursor-pointer overflow-hidden ${active ? 'border-peach ring-1 ring-peach/30' : 'border-ink/10 hover:border-ink/20'}`}>
      <div className="aspect-[16/10] relative overflow-hidden" style={{ background: grad }}>
        <svg viewBox="0 0 320 200" className="absolute inset-0 w-full h-full opacity-20">
          <circle cx="60" cy="100" r="80" fill="none" stroke="white" strokeWidth="0.5"/>
          <circle cx="60" cy="100" r="60" fill="none" stroke="white" strokeWidth="0.5"/>
          <circle cx="60" cy="100" r="40" fill="none" stroke="white" strokeWidth="0.5"/>
        </svg>
        <div className="absolute top-4 left-4 right-4 flex items-center justify-between">
          <p className="text-[9px] uppercase tracking-[0.2em] text-white/70 font-semibold">Audiobook</p>
          {book.pinned && <IconStar className="w-3.5 h-3.5 text-white/80"/>}
        </div>
        <div className="absolute bottom-4 left-4 right-4">
          <h3 className="font-serif text-2xl font-bold text-white leading-tight">{book.title}</h3>
          <p className="text-[10px] text-white/70 mt-1">{seriesLine}</p>
        </div>
        {active && (
          <span className="absolute top-3 right-3 px-2 py-0.5 rounded-full bg-peach text-ink text-[10px] font-bold uppercase tracking-wider">Open</span>
        )}
        <div ref={menuRef} className="absolute top-2.5 right-2.5">
          <button
            onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }}
            aria-label="Book options"
            className="w-7 h-7 grid place-items-center rounded-full bg-black/30 hover:bg-black/50 text-white opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
          >
            <IconMore className="w-4 h-4"/>
          </button>
          {menuOpen && (
            <div className="absolute right-0 mt-1.5 w-44 rounded-xl bg-white border border-ink/10 shadow-float overflow-hidden z-10" onClick={(e) => e.stopPropagation()}>
              <button
                onClick={() => {
                  setMenuOpen(false);
                  if (confirm(`Delete "${book.title}"? This removes the book directory from disk and discards any cached analysis. Can't be undone.`)) {
                    onDelete();
                  }
                }}
                className="w-full px-3 py-2.5 text-left text-sm font-medium text-red-700 hover:bg-red-50 inline-flex items-center gap-2"
              >
                <IconTrash className="w-4 h-4"/> Delete book
              </button>
            </div>
          )}
        </div>
      </div>

      <div className="p-5">
        <div className="flex items-center justify-between gap-2 mb-3">
          <Pill color={meta.color}><span className="inline-flex items-center gap-1.5">{meta.icon}{meta.label}</span></Pill>
          <span className="text-[11px] text-ink/50">{book.lastWorkedOn}</span>
        </div>

        {book.status === 'generating' && book.progress != null && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[11px] text-ink/60 mb-1.5">
              <span>{book.completedChapters} of {book.chapterCount} chapters</span>
              <span className="tabular-nums font-bold text-ink">{Math.round(book.progress * 100)}%</span>
            </div>
            <div className="h-1 rounded-full bg-ink/[0.06] overflow-hidden">
              <div className="h-full bg-gradient-progress rounded-full" style={{ width: `${book.progress * 100}%` }}/>
            </div>
          </div>
        )}
        {book.status === 'analysing' && book.progress != null && (
          <div className="mb-3">
            <div className="flex items-center justify-between text-[11px] text-ink/60 mb-1.5">
              <span>Reading manuscript…</span>
              <span className="tabular-nums font-bold text-ink">{Math.round(book.progress * 100)}%</span>
            </div>
            <div className="h-1 rounded-full bg-ink/[0.06] overflow-hidden relative">
              <div className="h-full bg-gradient-progress rounded-full pulse-bar" style={{ width: `${book.progress * 100}%` }}>
                <div className="absolute inset-0 stripe-travel"/>
              </div>
            </div>
          </div>
        )}
        {book.status === 'cast_pending' && (book.matchedFromLibrary ?? 0) > 0 && (
          <p className="mb-3 text-xs text-purple-deep/80 leading-relaxed">
            <span className="font-semibold">{book.matchedFromLibrary} of {book.characterCount}</span> characters matched from your library — review and confirm.
          </p>
        )}
        {book.status === 'complete' && (
          <p className="mb-3 text-xs text-emerald-700 leading-relaxed">
            <span className="font-semibold">{book.runtime ?? '—'}</span> · ready to listen and share.
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
          <Stat label="Chapters" value={book.chapterCount || '—'}/>
          <Stat label="Voices"   value={book.voiceCount   || '—'}/>
          <Stat label="Runtime"  value={book.runtime ?? '—'} small/>
        </div>
      </div>
    </article>
  );
}

function NewBookCard({ onStartNew }: { onStartNew: () => void }) {
  return (
    <button onClick={onStartNew} className="group bg-canvas rounded-3xl border-2 border-dashed border-ink/15 hover:border-peach hover:bg-peach/[0.04] transition-all min-h-[180px] grid place-items-center text-center p-8">
      <div>
        <span className="w-14 h-14 mx-auto rounded-full bg-white border border-ink/10 grid place-items-center group-hover:bg-peach group-hover:border-peach group-hover:text-white transition-colors text-ink">
          <IconPlus className="w-6 h-6"/>
        </span>
        <p className="mt-4 text-base font-bold text-ink">Start a new book</p>
        <p className="mt-1 text-xs text-ink/55 max-w-[280px] mx-auto leading-relaxed">Drop in a manuscript and we'll meet your cast within a couple of minutes.</p>
      </div>
    </button>
  );
}

function EmptyLibrary({ onStartNew }: { onStartNew: () => void }) {
  return (
    <div className="bg-white rounded-3xl border border-ink/10 shadow-card p-12 text-center">
      <span className="w-16 h-16 mx-auto rounded-full bg-peach/10 grid place-items-center text-peach">
        <IconPlus className="w-7 h-7"/>
      </span>
      <h3 className="mt-5 font-serif text-2xl font-bold text-ink">Your library is empty</h3>
      <p className="mt-2 text-sm text-ink/60 max-w-md mx-auto leading-relaxed">
        Books live on disk under <code className="px-1.5 py-0.5 rounded bg-ink/5 text-[12px]">audiobook-workspace/books/&lt;Author&gt;/&lt;Series&gt;/&lt;Title&gt;/</code>.
        Import a manuscript and we'll lay it out for you.
      </p>
      <div className="mt-6">
        <PrimaryButton variant="dark" onClick={onStartNew}>
          <span className="inline-flex items-center gap-2"><IconPlus className="w-4 h-4"/>Import your first book</span>
        </PrimaryButton>
      </div>
    </div>
  );
}
