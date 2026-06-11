/* Book-library view — thin orchestrator over the two region
   sub-components under src/components/library/.

   Owns: filter state, workspace-info fetch effect, allBooks/totals
   memo + filter pill labels. Applies the active filter to the
   `authors` prop before handing the result to <LibraryGrid />.

   Render-tree shape mirrors the listen-view split pattern
   (plan 60): orchestrator → chrome region + grid region, with the
   sub-components staying purely presentational so per-region work
   doesn't fight the orchestrator's selectors.

   Plan 73 — also owns the search input + tag-chip filter state.
   Search/tags compose with the existing status pill via
   intersection semantics; a "no results" pane fires when an active
   filter narrows to zero rows.

   This view's public `BookLibraryView` prop contract is unchanged
   from the pre-split file — callers in App.tsx / routes/index.tsx
   require no updates. */

import { useEffect, useMemo, useState } from 'react';
import { api, type WorkspaceInfo } from '../lib/api';
import { parseRuntime } from '../lib/time';
import { useAppSelector } from '../store';
import { useDebouncedValue } from '../lib/use-debounced-value';
import {
  LibraryChrome,
  type LibraryViewMode,
} from '../components/library/library-chrome';
import { LibraryGrid } from '../components/library/library-grid';
import { LibraryTable } from '../components/library/library-table';
import { filterBooks, selectAllTags, selectPresentLanguages } from '../store/library-slice';
import { PrimaryButton } from '../components/primitives';
import { IconClose } from '../lib/icons';
import type { EditBookMetaPatch } from '../modals/edit-book-meta';
import type { LibraryAuthor, LibraryBook, LibraryBookStatus } from '../lib/types';

type Filter = 'all' | 'in_progress' | 'complete';

/** localStorage key for the card↔table view-mode toggle. */
const VIEW_MODE_STORAGE_KEY = 'library.viewMode';

/* localStorage can be unavailable (Safari private mode, sandboxed
   iframes, a test env that nukes globals). Always try/catch — fall
   back to the default rather than throwing on first render. */
function readStoredViewMode(): LibraryViewMode {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(VIEW_MODE_STORAGE_KEY) : null;
    if (raw === 'table' || raw === 'card') return raw;
  } catch {
    /* swallow — fall through to default */
  }
  return 'card';
}

function writeStoredViewMode(mode: LibraryViewMode): void {
  try {
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(VIEW_MODE_STORAGE_KEY, mode);
    }
  } catch {
    /* swallow — in-memory state still works, persistence just won't survive reload */
  }
}

interface Props {
  authors: LibraryAuthor[];
  activeBookId: string | null;
  onOpenBook: (book: LibraryBook) => void;
  onDeleteBook: (book: LibraryBook) => void;
  onReparseBook: (book: LibraryBook) => void;
  onReplaceManuscript: (book: LibraryBook, file: File) => void | Promise<void>;
  onEditBook: (book: LibraryBook, patch: EditBookMetaPatch) => Promise<void>;
  /** Fires after the CoverPicker modal successfully updates the book's
      cover (either picked a new candidate or removed the existing one).
      The parent should refresh the library so the new `coverImageUrl`
      propagates back through the slice. */
  onCoverChanged?: (book: LibraryBook) => Promise<void> | void;
  onStartNew: () => void;
  onTrySample?: () => void | Promise<void>;
  /** Plan 75 — when present, exposes the "Import portable bundle"
      button in the library chrome. The orchestrator wires the chosen
      File to api.importPortable + refreshes the library. */
  onImportPortable?: (file: File) => void;
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
  onReplaceManuscript,
  onEditBook,
  onCoverChanged,
  onStartNew,
  onTrySample,
  onImportPortable,
}: Props) {
  const [filter, setFilter] = useState<Filter>('all');
  /* Plan 73 — raw input fires every keystroke, debouncedSearch lags by
     ~150ms so the filter chain doesn't re-run mid-word. activeTags is
     a sorted array (not a Set) so it serialises cleanly through the
     prop interface and the test harness. */
  const [search, setSearch] = useState('');
  const [activeTags, setActiveTags] = useState<string[]>([]);
  /* fe-16 — active library language filter (BCP-47 codes). ANDs with
     search + tags; only meaningful when the library spans >1 language. */
  const [activeLanguages, setActiveLanguages] = useState<string[]>([]);
  const debouncedSearch = useDebouncedValue(search, 150);
  /* Plan 76 — card↔table presentation toggle. Initial read happens once
     at mount (lazy initialiser keeps the localStorage probe out of every
     render). Writes back on every change via the effect below — same
     shape as other persisted UI preferences in the app. */
  const [viewMode, setViewMode] = useState<LibraryViewMode>(() => readStoredViewMode());
  useEffect(() => {
    writeStoredViewMode(viewMode);
  }, [viewMode]);
  /* Plan 81 (Wave 3, books) — phone viewports (<640px) can't fit the
     wide multi-column table without horizontal scroll, and the user
     research bar for v1 says "no horizontal overflow at 375×667". On
     phone we force the card layout regardless of the persisted
     viewMode preference, so a tablet/desktop user whose stored
     preference is "table" still sees usable cards when they open the
     same workspace from a phone. The stored preference itself stays
     unchanged — when they go back to desktop, table re-appears. */
  const isMobileViewport = useIsMobileViewport();
  const effectiveViewMode: LibraryViewMode = isMobileViewport ? 'card' : viewMode;
  /* First word of the user's display name → "Welcome back, Mike". Falls back
     to "back" when the user hasn't set a name (keeps the heading grammatical). */
  const displayName = useAppSelector((s) => s.account.displayName);
  const firstName = displayName.trim().split(/\s+/)[0] || 'back';
  /* Distinguish "fetch hasn't resolved yet" from "fetched and genuinely empty".
     Without this, the first paint flashes <EmptyLibrary> for the duration of
     the api.getLibrary() round-trip — reads as "library wiped." Skeleton stays
     up until libraryActions.hydrate fires (set by src/components/layout.tsx). */
  const loaded = useAppSelector((s) => s.library.loaded);
  /* Plan 73 — union of all tags across the library. We read the raw
     books array from the slice and derive the sorted tag union with
     useMemo so React 18 doesn't warn about a selector returning a
     fresh array reference each render. `selectAllTags` is still
     exported for direct unit testing in library-slice.test.ts. */
  const libraryBooksForTags = useAppSelector((s) => s.library.books);
  const allTags = useMemo(
    () => selectAllTags({ library: { loaded: true, authors: [], books: libraryBooksForTags, pausedSnapshots: {} } }),
    [libraryBooksForTags],
  );
  /* fe-16 — distinct languages across the library (English first). The chrome
     renders the language pills only when this holds >1 entry. */
  const presentLanguages = useMemo(
    () => selectPresentLanguages(libraryBooksForTags),
    [libraryBooksForTags],
  );
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
    /* Distinct voices across the whole library — union the per-book voice-id
       sets rather than summing per-book counts, so a voice reused across a
       series (the headline consistency feature) counts once, not once per
       book. Falls back to nothing for any book missing the field. */
    voices: new Set(allBooks.flatMap((b) => b.voiceIds ?? [])).size,
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

  const toggleTag = (tag: string) => {
    setActiveTags((prev) =>
      prev.includes(tag) ? prev.filter((t) => t !== tag) : [...prev, tag],
    );
  };
  const toggleLanguage = (lang: string) => {
    setActiveLanguages((prev) =>
      prev.includes(lang) ? prev.filter((l) => l !== lang) : [...prev, lang],
    );
  };
  const clearFilters = () => {
    setSearch('');
    setActiveTags([]);
    setActiveLanguages([]);
  };

  /* Apply status filter + search + tag intersection at the orchestrator
     boundary so <LibraryGrid /> stays a pure render of whatever it's
     handed. Series with no matching books are dropped, and authors with
     no matching series collapse out entirely — same pre-split semantics. */
  const filteredAuthors = useMemo<LibraryAuthor[]>(() => {
    return authors
      .map((author) => ({
        ...author,
        series: author.series
          .map((series) => ({
            ...series,
            books: filterBooks(
              series.books.filter((b) => matchesFilter(b, filter)),
              debouncedSearch,
              activeTags,
              activeLanguages,
            ),
          }))
          .filter((series) => series.books.length > 0),
      }))
      .filter((author) => author.series.length > 0);
  }, [authors, filter, debouncedSearch, activeTags, activeLanguages]);

  const matchedBookCount = useMemo(
    () =>
      filteredAuthors.reduce(
        (sum, a) => sum + a.series.reduce((s, ser) => s + ser.books.length, 0),
        0,
      ),
    [filteredAuthors],
  );

  /* "No results" only fires when an active search/tag filter narrowed
     the otherwise-non-empty library to zero rows. An empty library
     still falls through to the existing <EmptyLibrary /> path. */
  const hasActiveSearchOrTag =
    debouncedSearch.trim().length > 0 || activeTags.length > 0 || activeLanguages.length > 0;
  const showNoResults =
    loaded && authors.length > 0 && hasActiveSearchOrTag && matchedBookCount === 0;

  return (
    <div className="max-w-[1400px] mx-auto px-4 py-6 sm:px-6 sm:py-10">
      <LibraryChrome
        firstName={firstName}
        workspace={workspace}
        totals={totals}
        filter={filter}
        setFilter={setFilter}
        filters={filters}
        viewMode={viewMode}
        setViewMode={setViewMode}
        onStartNew={onStartNew}
        onImportPortable={onImportPortable}
        search={search}
        setSearch={setSearch}
        allTags={allTags}
        activeTags={activeTags}
        toggleTag={toggleTag}
        presentLanguages={presentLanguages}
        activeLanguages={activeLanguages}
        toggleLanguage={toggleLanguage}
        clearFilters={clearFilters}
      />
      {showNoResults ? (
        <NoResults onClear={clearFilters} />
      ) : effectiveViewMode === 'card' ? (
        <LibraryGrid
          loaded={loaded}
          isLibraryEmpty={authors.length === 0}
          authors={filteredAuthors}
          activeBookId={activeBookId}
          onOpenBook={onOpenBook}
          onDeleteBook={onDeleteBook}
          onReparseBook={onReparseBook}
          onReplaceManuscript={onReplaceManuscript}
          onEditBook={onEditBook}
          onCoverChanged={onCoverChanged}
          onStartNew={onStartNew}
          onTrySample={onTrySample}
        />
      ) : (
        /* Plan 81 (Wave 3, books) — wrap the dense table in an
           overflow-x container so a narrow tablet (640–767px) that
           still resolves to the table branch (matchMedia <640 only
           forces card mode) keeps any horizontal overflow scoped to
           the table itself, not the document body. Desktop ≥md
           viewports never overflow this wrapper, so the visual is
           a no-op there. */
        <div
          className="overflow-x-auto scrollbar-thin -mx-4 px-4 sm:-mx-6 sm:px-6 md:mx-0 md:px-0"
          style={{ ['--scrollbar-thin-radius' as string]: '0px' } as React.CSSProperties}
        >
          <LibraryTable
            loaded={loaded}
            isLibraryEmpty={authors.length === 0}
            authors={filteredAuthors}
            activeBookId={activeBookId}
            onOpenBook={onOpenBook}
            onDeleteBook={onDeleteBook}
            onReparseBook={onReparseBook}
            onReplaceManuscript={onReplaceManuscript}
            onEditBook={onEditBook}
            onCoverChanged={onCoverChanged}
            onStartNew={onStartNew}
          />
        </div>
      )}
    </div>
  );
}

/* Subscribes to a `(max-width: 639px)` matchMedia query so the
   orchestrator can flip viewMode → card on phone viewports without
   stomping the user's persisted preference. SSR / jsdom-without-mock
   safe — returns `false` until the first effect runs. */
function useIsMobileViewport(): boolean {
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const mql = window.matchMedia('(max-width: 639px)');
    setIsMobile(mql.matches);
    const onChange = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    /* addEventListener is the modern API; the legacy addListener fallback
       covers Safari < 14. Match the same pattern use-theme.ts uses. */
    if (typeof mql.addEventListener === 'function') {
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    }
    /* Legacy fallback — webkit Safari < 14. */
    mql.addListener(onChange);
    return () => mql.removeListener(onChange);
  }, []);
  return isMobile;
}

/* Distinct "no results" pane — fires when search/tags narrow the
   library to zero rows. Mirrors the shape of <EmptyLibrary /> in
   library-grid.tsx so the rounded-3xl panel stays consistent. */
function NoResults({ onClear }: { onClear: () => void }) {
  return (
    <div
      className="bg-white rounded-3xl border border-ink/10 shadow-card p-12 text-center"
      data-testid="library-no-results"
    >
      <span className="w-16 h-16 mx-auto rounded-full bg-ink/5 grid place-items-center text-ink/55">
        <IconClose className="w-7 h-7" />
      </span>
      <h3 className="mt-5 font-serif text-2xl font-bold text-ink">No books match your filters</h3>
      <p className="mt-2 text-sm text-ink/60 max-w-md mx-auto leading-relaxed">
        Try a different search term, or clear the active tag chips to see every book again.
      </p>
      <div className="mt-6">
        <PrimaryButton variant="ghost" onClick={onClear} icon={false}>
          Clear filters
        </PrimaryButton>
      </div>
    </div>
  );
}
