/* Book-library view — thin orchestrator over the two region
   sub-components under src/components/library/.

   Owns: filter state, workspace-info fetch effect, allBooks/totals
   memo + filter pill labels. Applies the active filter to the
   `authors` prop before handing the result to <LibraryGrid />.

   Render-tree shape mirrors the listen-view split pattern
   (plan 60): orchestrator → chrome region + grid region, with the
   sub-components staying purely presentational so per-region work
   doesn't fight the orchestrator's selectors.

   This view's public `BookLibraryView` prop contract is unchanged
   from the pre-split file — callers in App.tsx / routes/index.tsx
   require no updates. */

import { useEffect, useMemo, useState } from 'react';
import { api, type WorkspaceInfo } from '../lib/api';
import { parseRuntime } from '../lib/time';
import { useAppSelector } from '../store';
import { LibraryChrome } from '../components/library/library-chrome';
import { LibraryGrid } from '../components/library/library-grid';
import type { EditBookMetaPatch } from '../modals/edit-book-meta';
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

  /* Apply the active filter at the orchestrator boundary so <LibraryGrid />
     stays a pure render of whatever it's handed. Series with no matching
     books are dropped, and authors with no matching series collapse out
     entirely — same pre-split semantics. */
  const filteredAuthors = useMemo<LibraryAuthor[]>(() => {
    return authors
      .map((author) => ({
        ...author,
        series: author.series
          .map((series) => ({
            ...series,
            books: series.books.filter((b) => matchesFilter(b, filter)),
          }))
          .filter((series) => series.books.length > 0),
      }))
      .filter((author) => author.series.length > 0);
  }, [authors, filter]);

  return (
    <div className="max-w-[1400px] mx-auto px-6 py-10">
      <LibraryChrome
        firstName={firstName}
        workspace={workspace}
        totals={totals}
        filter={filter}
        setFilter={setFilter}
        filters={filters}
        onStartNew={onStartNew}
      />
      <LibraryGrid
        loaded={loaded}
        isLibraryEmpty={authors.length === 0}
        authors={filteredAuthors}
        activeBookId={activeBookId}
        onOpenBook={onOpenBook}
        onDeleteBook={onDeleteBook}
        onReparseBook={onReparseBook}
        onEditBook={onEditBook}
        onCoverChanged={onCoverChanged}
        onStartNew={onStartNew}
      />
    </div>
  );
}
