/* Generic searchable-picker primitive — the popover scaffolding that
   `CharacterSearchPicker`, `VoiceOverridePicker`, and `AnalysisModelPicker`
   share. Owns:
   - Portal popover positioned against an anchor ref (re-tracked on
     scroll/resize so it follows the trigger across nested scroll
     containers).
   - Search input with case-insensitive substring filter over each
     item's `haystack` strings.
   - Keyboard nav: ArrowUp/Down move the highlight across the flattened
     filtered list (groups merged), Enter picks the highlight, Esc
     closes.
   - Click-outside dismissal (excludes both the popover and the anchor).
   - Group headers rendered as separators above each labelled group.

   Callers own: data shape, row renderer (via `renderItem`), pick
   semantics, and any disabled / async-loading row state. */

import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import { IconSearch } from '../lib/icons';

export interface PickerItem<T> {
  /** Stable id used for React keys + active-row check. */
  id: string;
  /** Strings the search box matches (case-insensitive substring). */
  haystack: string[];
  /** Underlying data the caller's renderItem receives. */
  data: T;
  /** When true, the row is disabled and unpickable. */
  disabled?: boolean;
}

export interface PickerGroup<T> {
  /** Optional header rendered above this group's items. Omit on the
      first / default group to render it without a separator. */
  label?: string;
  items: PickerItem<T>[];
}

export interface SearchablePickerProps<T> {
  groups: PickerGroup<T>[];
  /** Id matching the currently-applied selection — passed through to
      `renderItem` as `ctx.active` so callers can draw a check mark or
      similar indicator. Empty string = nothing selected. */
  activeId: string;
  /** Renders the row body. Caller decides leading slot, label, subtitle,
      trailing indicator. */
  renderItem: (
    data: T,
    ctx: { highlighted: boolean; active: boolean; disabled: boolean },
  ) => ReactNode;
  onPick: (data: T) => void;
  onClose: () => void;
  anchorRef: RefObject<HTMLElement>;
  placement?: 'bottom-start' | 'bottom-end';
  minWidth?: number;
  searchPlaceholder?: string;
  /** Aria-label for the popover dialog. */
  ariaLabel?: string;
  /** Content shown in the list area when the filter has no matches. */
  emptyState?: ReactNode;
  /** When true, the search input is hidden — useful for pickers with
      ≤5 items where typeahead adds no value but the popover chrome is
      still desired. Defaults to false. */
  hideSearch?: boolean;
}

/* Estimated popover height for the flip-to-above check. Search header
   (~52px) + ~12 row scroll cap (12 * 36 = 432px) + chrome. Conservative
   over-estimate so a popover bottomed against the viewport flips above. */
const ESTIMATED_HEIGHT = 500;
const DEFAULT_MIN_WIDTH = 288;
const VIEWPORT_MARGIN = 8;

interface FlatRow<T> {
  item: PickerItem<T>;
  groupIdx: number;
  /** True if this is the first item of a labelled group (other than the
      first group) — the renderer draws a separator above it. */
  showSeparator: boolean;
  groupLabel?: string;
}

export function SearchablePicker<T>({
  groups,
  activeId,
  renderItem,
  onPick,
  onClose,
  anchorRef,
  placement = 'bottom-end',
  minWidth = DEFAULT_MIN_WIDTH,
  searchPlaceholder = 'Search…',
  ariaLabel = 'Searchable picker',
  emptyState,
  hideSearch = false,
}: SearchablePickerProps<T>) {
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);

  useEffect(() => {
    if (!hideSearch) inputRef.current?.focus();
  }, [hideSearch]);

  /* Compute the floating position from the anchor's bounding rect.
     useLayoutEffect on mount + scroll/resize listeners so the popover
     tracks the trigger across nested scroll containers. Capture phase
     on `scroll` so it fires for inner scrollers, not just window. */
  useLayoutEffect(() => {
    function compute() {
      const el = anchorRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const width = Math.max(minWidth, rect.width);
      const spillsBelow = rect.bottom + ESTIMATED_HEIGHT > vh - VIEWPORT_MARGIN;
      const top = spillsBelow
        ? Math.max(VIEWPORT_MARGIN, rect.top - ESTIMATED_HEIGHT - 4)
        : rect.bottom + 4;
      let left = placement === 'bottom-end' ? rect.right - width : rect.left;
      left = Math.min(Math.max(VIEWPORT_MARGIN, left), vw - width - VIEWPORT_MARGIN);
      setPos({ top, left, width });
    }
    compute();
    window.addEventListener('scroll', compute, true);
    window.addEventListener('resize', compute);
    return () => {
      window.removeEventListener('scroll', compute, true);
      window.removeEventListener('resize', compute);
    };
  }, [anchorRef, placement, minWidth]);

  /* Click-outside dismissal. Excludes both the popover root AND the
     anchor — the anchor's own onClick toggles open state, so we mustn't
     double-fire close. */
  useEffect(() => {
    function onDocMouseDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (!target) return;
      const popover = popoverRef.current;
      const anchor = anchorRef.current;
      if (popover && popover.contains(target)) return;
      if (anchor && anchor.contains(target)) return;
      onClose();
    }
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, [anchorRef, onClose]);

  /* Filter the union of all groups by substring match against haystack.
     Build a flat list with group metadata so keyboard nav and rendering
     can operate on a single sequence. */
  const flat: FlatRow<T>[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = (haystack: string[]) =>
      !q || haystack.some((h) => h.toLowerCase().includes(q));
    const rows: FlatRow<T>[] = [];
    groups.forEach((g, groupIdx) => {
      const filtered = g.items.filter((it) => matches(it.haystack));
      filtered.forEach((item, i) => {
        rows.push({
          item,
          groupIdx,
          showSeparator: i === 0 && groupIdx > 0 && !!g.label,
          groupLabel: i === 0 ? g.label : undefined,
        });
      });
    });
    return rows;
  }, [groups, query]);

  /* Clamp highlight when the filtered list shrinks. Skip past disabled
     rows so Enter never picks an unpickable item. */
  useEffect(() => {
    if (highlight >= flat.length) {
      setHighlight(Math.max(0, flat.length - 1));
    }
  }, [flat.length, highlight]);

  /* Keep the highlighted row scrolled into view inside the internal
     scroll container. */
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector<HTMLElement>(`[data-row-idx="${highlight}"]`);
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'nearest' });
    }
  }, [highlight]);

  function pick(item: PickerItem<T>) {
    if (item.disabled) return;
    onPick(item.data);
  }

  function moveHighlight(direction: 1 | -1) {
    if (flat.length === 0) return;
    /* Walk in the requested direction, skipping disabled rows so the
       highlight never lands on an unpickable item. Wraps after one
       full pass — if every row is disabled, leave the highlight where
       it is. */
    let next = highlight;
    for (let step = 0; step < flat.length; step++) {
      next = (next + direction + flat.length) % flat.length;
      if (!flat[next].item.disabled) {
        setHighlight(next);
        return;
      }
    }
  }

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveHighlight(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveHighlight(-1);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const row = flat[highlight];
      if (row) pick(row.item);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    }
  }

  if (typeof document === 'undefined') return null;
  const popoverStyle: React.CSSProperties = pos
    ? { top: pos.top, left: pos.left, width: pos.width }
    : { top: 0, left: 0, width: minWidth };

  return createPortal(
    <div
      ref={popoverRef}
      className="picker-surface fixed bg-white border border-ink/15 rounded-xl shadow-float py-1 z-50"
      style={popoverStyle}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      role="dialog"
      aria-label={ariaLabel}
    >
      {!hideSearch && (
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
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder}
              className="w-full rounded-lg border border-ink/10 bg-canvas/40 pl-7 pr-2 py-1.5 text-xs focus:outline-none focus:border-peach"
            />
          </label>
        </div>
      )}
      <div
        ref={listRef}
        className="max-h-[calc(12*36px)] overflow-y-auto scrollbar-thin"
        role="listbox"
      >
        {flat.length === 0 && (
          <div className="px-3 py-3 text-xs text-ink/50 italic">
            {emptyState ?? 'No matches.'}
          </div>
        )}
        {flat.map((row, idx) => {
          const isHighlighted = idx === highlight;
          const isActive = row.item.id === activeId;
          const isDisabled = !!row.item.disabled;
          return (
            <div key={`${row.groupIdx}_${row.item.id}`}>
              {row.showSeparator && <GroupSeparator label={row.groupLabel ?? ''} />}
              <button
                data-row-idx={idx}
                role="option"
                aria-selected={isHighlighted}
                aria-disabled={isDisabled || undefined}
                disabled={isDisabled}
                onMouseEnter={() => !isDisabled && setHighlight(idx)}
                onClick={() => pick(row.item)}
                className={`w-full flex items-center gap-2 px-3 py-2 text-left text-sm min-h-[36px] ${
                  isHighlighted && !isDisabled ? 'bg-ink/[0.06]' : 'hover:bg-ink/[0.04]'
                } disabled:opacity-50 disabled:cursor-not-allowed`}
              >
                {renderItem(row.item.data, {
                  highlighted: isHighlighted,
                  active: isActive,
                  disabled: isDisabled,
                })}
              </button>
            </div>
          );
        })}
      </div>
    </div>,
    document.body,
  );
}

function GroupSeparator({ label }: { label: string }) {
  return (
    <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider font-semibold text-ink/40 border-t border-ink/10 mt-1">
      {label}
    </div>
  );
}
