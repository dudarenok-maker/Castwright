/* Shared character picker for the manuscript-view reassign surfaces
   (segment-row dropdown + segment-inspector pickers). Three behaviours
   bundled per `docs/features/NN-low-confidence-triage-polish.md`:

   1. Typeahead search input focused on open; case-insensitive substring
      match against name (and aliases when present). Picker height capped
      with internal scroll (~12 rows) so it never grows past the viewport
      regardless of total roster size.
   2. Optional series-roster group rendered under a separator labelled
      "From prior books in this series" with a book-title subtitle for
      disambiguation. Picking a series-roster entry materialises a new
      local character via the parent's `onAddFromSeriesRoster` callback
      (POSTs /cast/add-from-roster), then reassigns via `onPick` with
      the freshly-minted local id.
   3. Keyboard nav: arrow keys move the highlight across the filtered
      list (local + series), Enter picks the highlighted entry, Esc
      closes the picker. Mouse click on any visible row still works
      without typing. */

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { IconSearch, IconCheck, IconSpinner } from '../lib/icons';
import { ColorDot } from './primitives';
import { CHAR_COLORS } from '../lib/colors';
import type { Character, CharColor } from '../lib/types';
import type { SeriesRosterEntry } from '../lib/api';

interface CharacterSearchPickerProps {
  characters: Character[];
  priorRoster?: SeriesRosterEntry[];
  currentCharacterId: string;
  onPick: (characterId: string) => void;
  onAddFromSeriesRoster?: (entry: SeriesRosterEntry) => Promise<string>;
  onClose: () => void;
  /** Tailwind class string applied to the outer popover container so
      consumers can position the picker as right-/left-aligned dropdown
      or as a wider inline panel. */
  className?: string;
  /** Optional render hook for the row content — defaults to ColorDot +
      name. The segment-row dropdown and the segment-inspector use the
      same content shape; if a future caller needs richer rows it can
      override. */
  renderRowExtra?: (c: Character) => ReactNode;
}

type Row =
  | { kind: 'local'; character: Character }
  | { kind: 'roster'; entry: SeriesRosterEntry };

export function CharacterSearchPicker({
  characters,
  priorRoster,
  currentCharacterId,
  onPick,
  onAddFromSeriesRoster,
  onClose,
  className,
  renderRowExtra,
}: CharacterSearchPickerProps) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [pendingRosterId, setPendingRosterId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  /* Filter the union of local + roster by substring match against name
     (+ aliases on roster entries). Local cast rendered first; roster
     entries below under a separator. Roster rows whose name already
     matches a local row are filtered out — the user can pick the
     local row directly. */
  const rows: Row[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const localNames = new Set(characters.map((c) => c.name.trim().toLowerCase()));
    const matches = (haystack: Array<string | undefined>) => {
      if (!q) return true;
      return haystack.some((h) => (h ?? '').toLowerCase().includes(q));
    };
    const localRows: Row[] = characters
      .filter((c) => matches([c.name]))
      .map((c) => ({ kind: 'local' as const, character: c }));
    const rosterRows: Row[] = (priorRoster ?? [])
      .filter((e) => !localNames.has(e.name.trim().toLowerCase()))
      .filter((e) => matches([e.name, ...(e.aliases ?? [])]))
      .map((e) => ({ kind: 'roster' as const, entry: e }));
    return [...localRows, ...rosterRows];
  }, [characters, priorRoster, query]);

  /* Clamp highlight when the filtered list shrinks. */
  useEffect(() => {
    if (highlight >= rows.length) setHighlight(Math.max(0, rows.length - 1));
  }, [rows.length, highlight]);

  /* Keep the highlighted row in view inside the internal scroll
     container — same scrollIntoView pattern the chapter list uses. */
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row-idx="${highlight}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight]);

  async function pickRow(row: Row) {
    if (row.kind === 'local') {
      onPick(row.character.id);
      onClose();
      return;
    }
    if (!onAddFromSeriesRoster) return;
    setPendingRosterId(row.entry.id);
    try {
      const newLocalId = await onAddFromSeriesRoster(row.entry);
      onPick(newLocalId);
      onClose();
    } catch (err) {
      console.warn('[character-search-picker] add-from-roster failed', err);
      setPendingRosterId(null);
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => Math.min(rows.length - 1, h + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => Math.max(0, h - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = rows[highlight];
      if (row) void pickRow(row);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  /* Find the index where the roster section begins (after the last
     local row) so we can render a separator above it. */
  const firstRosterIdx = rows.findIndex((r) => r.kind === 'roster');

  return (
    <div
      className={
        className ??
        'absolute right-0 top-full mt-1 w-72 bg-white border border-ink/10 rounded-xl shadow-card py-1 z-10'
      }
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label="Reassign speaker"
    >
      <div className="px-2 pt-1 pb-2 border-b border-ink/10">
        <label className="relative block">
          <IconSearch className="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-ink/40 pointer-events-none" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHighlight(0);
            }}
            placeholder="Search character…"
            aria-label="Search character"
            className="w-full rounded-lg border border-ink/10 bg-canvas/40 pl-7 pr-2 py-1.5 text-xs focus:outline-none focus:border-peach"
          />
        </label>
      </div>
      <div
        ref={listRef}
        className="max-h-[calc(12*36px)] overflow-y-auto scrollbar-thin"
        role="listbox"
      >
        {rows.length === 0 && (
          <div className="px-3 py-3 text-xs text-ink/50 italic">No matches.</div>
        )}
        {rows.map((row, idx) => {
          const isHighlighted = idx === highlight;
          const showSeparator = idx === firstRosterIdx && firstRosterIdx > 0;
          if (row.kind === 'local') {
            const cc = row.character;
            const isActive = cc.id === currentCharacterId;
            return (
              <div key={`l_${cc.id}`}>
                {showSeparator && <RosterSeparator />}
                <button
                  data-row-idx={idx}
                  role="option"
                  aria-selected={isHighlighted}
                  onMouseEnter={() => setHighlight(idx)}
                  onClick={() => void pickRow(row)}
                  className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${
                    isHighlighted ? 'bg-ink/[0.06]' : 'hover:bg-ink/[0.04]'
                  }`}
                >
                  <ColorDot color={cc.color as CharColor} />
                  <span className="flex-1">{cc.name}</span>
                  {renderRowExtra?.(cc)}
                  {isActive && <IconCheck className="w-3.5 h-3.5 text-ink/60" />}
                </button>
              </div>
            );
          }
          const e = row.entry;
          const isPending = pendingRosterId === e.id;
          return (
            <div key={`r_${e.bookId}_${e.id}`}>
              {showSeparator && <RosterSeparator />}
              <button
                data-row-idx={idx}
                role="option"
                aria-selected={isHighlighted}
                onMouseEnter={() => setHighlight(idx)}
                onClick={() => void pickRow(row)}
                disabled={isPending || !onAddFromSeriesRoster}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm ${
                  isHighlighted ? 'bg-ink/[0.06]' : 'hover:bg-ink/[0.04]'
                } disabled:opacity-50 disabled:cursor-wait`}
              >
                <ColorDot color={(CHAR_COLORS.narrator ? 'unset' : 'unset') as CharColor} />
                <span className="flex-1 min-w-0">
                  <span className="block truncate">{e.name}</span>
                  <span className="block text-[10px] text-ink/50 truncate">
                    From {e.bookTitle}
                  </span>
                </span>
                {isPending && <IconSpinner className="w-3.5 h-3.5 text-ink/60 animate-spin" />}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function RosterSeparator() {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-ink/40 border-t border-ink/10 mt-1">
      From prior books in this series
    </div>
  );
}
