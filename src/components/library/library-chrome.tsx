/* Book-library chrome region — pure presentational lift from
   book-library.tsx. Owns: the heading row (SectionLabel +
   "Welcome back, …" + intro paragraph + workspace-path row +
   "Start a new book" CTA), the totals StatTile grid, and the
   filter-pill row.

   Plan 73 — also owns the search input + tag-chip filter row that
   sit above the existing status pills. State + dispatchers stay in
   the book-library.tsx orchestrator; the chrome is purely
   presentational. */

import { useRef, useState } from 'react';
import { IconPlus, IconFolder, IconCopy, IconClose, IconDownload } from '../../lib/icons';
import { SectionLabel, MixedHeading, PrimaryButton } from '../primitives';
import { formatHours } from '../../lib/time';
import { StatTile } from '../stat-tiles';
import type { WorkspaceInfo } from '../../lib/api';

type Filter = 'all' | 'in_progress' | 'complete';

/** Library presentation mode. Persisted across reloads via `localStorage`
    by the orchestrator — see `book-library.tsx`. */
export type LibraryViewMode = 'card' | 'table';

interface Totals {
  books: number;
  runtime: number;
  voices: number;
  inProgress: number;
}

interface Props {
  firstName: string;
  workspace: WorkspaceInfo | null;
  totals: Totals;
  filter: Filter;
  setFilter: (f: Filter) => void;
  filters: Array<{ id: Filter; label: string }>;
  viewMode: LibraryViewMode;
  setViewMode: (m: LibraryViewMode) => void;
  onStartNew: () => void;
  /** Plan 75 — when present, renders an "Import portable bundle" button
      alongside the "Start a new book" CTA. The button opens a file
      picker (.portable.zip / .zip) and hands the chosen File to the
      orchestrator, which POSTs it to /api/import/portable. Absent →
      the button hides, keeping the chrome backward-compatible. */
  onImportPortable?: (file: File) => void;
  /* Plan 73 — search/tag-filter props. */
  search: string;
  setSearch: (s: string) => void;
  /** Full union of tag strings across the library; drives the chip
      row. Sorted by the orchestrator. */
  allTags: string[];
  activeTags: string[];
  toggleTag: (tag: string) => void;
  clearFilters: () => void;
}

export function LibraryChrome({
  firstName,
  workspace,
  totals,
  filter,
  setFilter,
  filters,
  viewMode,
  setViewMode,
  onStartNew,
  onImportPortable,
  search,
  setSearch,
  allTags,
  activeTags,
  toggleTag,
  clearFilters,
}: Props) {
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const hasActiveFilter = search.trim().length > 0 || activeTags.length > 0;
  return (
    <>
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
        <div className="flex items-center gap-2 flex-wrap">
          {onImportPortable && (
            <>
              <input
                ref={importInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                data-testid="library-import-portable-input"
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) onImportPortable(file);
                  /* Reset the input so re-selecting the same file
                     re-fires onChange. */
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                onClick={() => importInputRef.current?.click()}
                data-testid="library-import-portable-button"
                className="inline-flex items-center gap-2 rounded-full px-4 py-2 text-sm font-semibold transition-colors bg-white border border-ink/15 text-ink hover:bg-ink/[0.04]"
                title="Import a .portable.zip bundle exported from another machine"
              >
                <IconDownload className="w-4 h-4" />
                Import portable bundle
              </button>
            </>
          )}
          <PrimaryButton variant="dark" onClick={onStartNew}>
            <span className="inline-flex items-center gap-2">
              <IconPlus className="w-4 h-4" />
              Start a new book
            </span>
          </PrimaryButton>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4 mb-6">
        <StatTile label="Books" value={totals.books} />
        <StatTile label="Total runtime" value={formatHours(totals.runtime)} />
        <StatTile label="Voices" value={totals.voices} />
        <StatTile label="In progress" value={totals.inProgress} />
      </div>

      <div className="flex items-center gap-3 mb-4 flex-wrap">
        <input
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search books"
          placeholder="Search by title or author…"
          data-testid="library-search-input"
          className="flex-1 min-w-[240px] max-w-md px-4 py-2 rounded-full bg-canvas border border-ink/10 text-sm text-ink placeholder:text-ink/40 focus:outline-none focus:border-ink/30"
        />
        {hasActiveFilter && (
          <button
            onClick={clearFilters}
            data-testid="library-clear-filters"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-full text-xs font-medium text-ink/60 hover:text-ink hover:bg-ink/[0.04]"
          >
            <IconClose className="w-3 h-3" />
            Clear filters
          </button>
        )}
      </div>

      {allTags.length > 0 && (
        <div
          className="flex items-center gap-2 mb-6 flex-wrap"
          data-testid="library-tag-chip-row"
        >
          {allTags.map((tag) => {
            const active = activeTags.includes(tag);
            return (
              <button
                key={tag}
                onClick={() => toggleTag(tag)}
                data-testid={`tag-filter-chip-${tag}`}
                aria-pressed={active}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-purple-deep text-white border-purple-deep'
                    : 'bg-white text-ink/70 border-ink/10 hover:bg-ink/[0.04]'
                }`}
              >
                {tag}
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between gap-3 mb-6">
        <div className="flex items-center gap-1">
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
        <div
          data-testid="library-view-mode-toggle"
          role="group"
          aria-label="Library view mode"
          className="inline-flex items-center gap-0.5 p-0.5 rounded-full bg-ink/[0.04] border border-ink/10"
        >
          <button
            type="button"
            onClick={() => setViewMode('card')}
            aria-pressed={viewMode === 'card'}
            data-testid="library-view-mode-card"
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${viewMode === 'card' ? 'bg-white text-ink shadow-sm' : 'text-ink/55 hover:text-ink'}`}
          >
            Cards
          </button>
          <button
            type="button"
            onClick={() => setViewMode('table')}
            aria-pressed={viewMode === 'table'}
            data-testid="library-view-mode-table"
            className={`px-3 py-1 rounded-full text-xs font-medium transition-colors ${viewMode === 'table' ? 'bg-white text-ink shadow-sm' : 'text-ink/55 hover:text-ink'}`}
          >
            Table
          </button>
        </div>
      </div>
    </>
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
