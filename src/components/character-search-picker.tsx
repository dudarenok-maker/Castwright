/* Character picker — thin wrapper over the generic SearchablePicker
   primitive (`src/components/searchable-picker.tsx`). Owns the
   character-specific data shape, row rendering (ColorDot + name + optional
   subtitle), and the materialise-then-assign flow for prior-book roster
   picks.

   Behaviours pinned by `docs/features/archive/90-low-confidence-triage-polish.md`:

   1. Typeahead search input focused on open; case-insensitive substring
      match against name (and aliases when present). Picker height capped
      with internal scroll (~12 rows).
   2. Optional series-roster group rendered under a separator labelled
      "From prior books in this series" with a book-title subtitle.
      Picking a series-roster entry materialises a new local character
      via `onAddFromSeriesRoster` (POSTs /cast/add-from-roster), then
      reassigns via `onPick`. The `onPickRosterEntry` opt-in (added
      with the searchable-picker extraction) inverts this — when set,
      it runs INSTEAD of `onAddFromSeriesRoster`, which the Profile
      Drawer's merge picker uses to wire the link-prior flow instead
      of materialising.
   3. Keyboard nav: arrow keys move highlight, Enter picks, Esc closes.
      Mouse click on any visible row still works without typing.
   4. Portal-rendered floating popover. Lifted into the shared primitive;
      same scroll/resize tracking and click-outside dismissal model. */

import { useState, useMemo, type RefObject } from 'react';
import { IconCheck, IconSpinner } from '../lib/icons';
import { ColorDot } from './primitives';
import type { Character, CharColor } from '../lib/types';
import type { SeriesRosterEntry } from '../lib/api';
import { SearchablePicker, type PickerGroup, type PickerItem } from './searchable-picker';

interface CharacterSearchPickerProps {
  characters: Character[];
  priorRoster?: SeriesRosterEntry[];
  currentCharacterId: string;
  onPick: (characterId: string) => void;
  onAddFromSeriesRoster?: (entry: SeriesRosterEntry) => Promise<string>;
  /** Alternate hook for roster picks. When provided, runs INSTEAD of
      `onAddFromSeriesRoster` — used by the Profile Drawer merge picker
      which links to a prior character rather than materialising a new
      local one. The callback receives the SeriesRosterEntry; the
      picker fires onClose after the call so the parent's popover
      state collapses. */
  onPickRosterEntry?: (entry: SeriesRosterEntry) => void;
  onClose: () => void;
  /** Trigger element the popover anchors against. */
  anchorRef: RefObject<HTMLElement>;
  /** Horizontal alignment. `end` (default) right-aligns the popover to
      the trigger — what the row dropdown wants. `start` left-aligns —
      what the inspector segment-level / per-sentence pickers want. */
  placement?: 'bottom-start' | 'bottom-end';
  /** Minimum popover width in px. Defaults to 288 (matches the legacy
      `w-72`). */
  minWidth?: number;
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
  onPickRosterEntry,
  onClose,
  anchorRef,
  placement = 'bottom-end',
  minWidth,
}: CharacterSearchPickerProps) {
  const [pendingRosterId, setPendingRosterId] = useState<string | null>(null);

  /* Build the two groups: local cast first, then roster (with name
     collisions filtered out so the user picks the local row when both
     exist). Each PickerItem id is namespaced (`l_` / `r_`) so the
     primitive's keyboard nav and active-row check never confuse a
     prior-book entry with a local character that happens to share an
     id (server-generated ids are unique within a book, but a roster
     entry references a DIFFERENT book's character id). */
  const groups: PickerGroup<Row>[] = useMemo(() => {
    const localNames = new Set(characters.map((c) => c.name.trim().toLowerCase()));
    const localItems: PickerItem<Row>[] = characters.map((c) => ({
      id: `l_${c.id}`,
      haystack: [c.name],
      data: { kind: 'local', character: c },
    }));
    const rosterItems: PickerItem<Row>[] = (priorRoster ?? [])
      .filter((e) => !localNames.has(e.name.trim().toLowerCase()))
      .map((e) => ({
        id: `r_${e.bookId}_${e.id}`,
        haystack: [e.name, ...(e.aliases ?? [])],
        data: { kind: 'roster', entry: e },
        disabled: pendingRosterId === e.id || (!onAddFromSeriesRoster && !onPickRosterEntry),
      }));
    const out: PickerGroup<Row>[] = [{ items: localItems }];
    if (rosterItems.length > 0) {
      out.push({ label: 'From prior books in this series', items: rosterItems });
    }
    return out;
  }, [characters, priorRoster, pendingRosterId, onAddFromSeriesRoster, onPickRosterEntry]);

  async function pick(row: Row) {
    if (row.kind === 'local') {
      onPick(row.character.id);
      onClose();
      return;
    }
    /* `onPickRosterEntry` short-circuits the materialise step. Used by
       the merge picker which routes the prior-book pick to a
       different server endpoint (link-prior, not add-from-roster). */
    if (onPickRosterEntry) {
      onPickRosterEntry(row.entry);
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

  /* The active-id sentinel must match the namespaced PickerItem ids so
     the local-row indicator lights up. Roster rows can never be the
     "active" character (they're not in the local cast yet). */
  const activeId = `l_${currentCharacterId}`;

  return (
    <SearchablePicker<Row>
      groups={groups}
      activeId={activeId}
      renderItem={(row, ctx) => {
        if (row.kind === 'local') {
          const cc = row.character;
          return (
            <>
              <ColorDot color={cc.color as CharColor} />
              <span className="flex-1">{cc.name}</span>
              {ctx.active && <IconCheck className="w-3.5 h-3.5 text-ink/60" />}
            </>
          );
        }
        const e = row.entry;
        const isPending = pendingRosterId === e.id;
        return (
          <>
            <ColorDot color={'unset' as CharColor} />
            <span className="flex-1 min-w-0">
              <span className="block truncate">{e.name}</span>
              <span className="block text-[10px] text-ink/50 truncate">
                From {e.bookTitle}
              </span>
            </span>
            {isPending && <IconSpinner className="w-3.5 h-3.5 text-ink/60 animate-spin" />}
          </>
        );
      }}
      onPick={(row) => void pick(row)}
      onClose={onClose}
      anchorRef={anchorRef}
      placement={placement}
      minWidth={minWidth}
      searchPlaceholder="Search character…"
      ariaLabel="Reassign speaker"
    />
  );
}
