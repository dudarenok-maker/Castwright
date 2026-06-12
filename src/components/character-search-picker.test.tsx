/* Plan: low-confidence-triage-polish — coverage for the shared
   CharacterSearchPicker. Pins: search-on-mount focus, substring filter
   (incl. roster aliases), arrow-key + Enter selection, Esc closes, and
   the materialise-then-assign flow for series-roster picks. Post-ship
   polish (this PR): the picker is now portal-rendered off an anchor
   ref, stays open on pointer-leave, and closes on document mousedown
   outside both the popover and the anchor. */

import { useRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CharacterSearchPicker } from './character-search-picker';
import type { Character } from '../lib/types';
import type { SeriesRosterEntry } from '../lib/api';

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'wren', name: 'Wren', role: 'character', color: 'peach' },
  { id: 'lord-vane', name: 'Lord Vane', role: 'character', color: 'magenta' },
];

const roster: SeriesRosterEntry[] = [
  {
    id: 'councillor-linnet',
    name: 'Councillor Linnet',
    bookId: 'the Hollow Tide-1',
    bookTitle: 'The Hollow Tide',
    voiceId: 'v_linnet',
    aliases: ['the Councillor'],
    gender: 'female',
    ageRange: 'adult',
  },
  {
    id: 'mae-vance',
    name: 'Mae Vance',
    bookId: 'the Hollow Tide-1',
    bookTitle: 'The Hollow Tide',
    voiceId: 'v_mae',
  },
];

describe('CharacterSearchPicker', () => {
  // Vitest 4: vi.fn() is typed Mock<Procedure | Constructable> and no longer
  // assigns to a specific function prop — pin the signature via the component's
  // own prop types so the mocks stay assignable (and self-maintaining).
  type PickerProps = React.ComponentProps<typeof CharacterSearchPicker>;
  let onPick: ReturnType<typeof vi.fn<NonNullable<PickerProps['onPick']>>>;
  let onAddFromSeriesRoster: ReturnType<
    typeof vi.fn<NonNullable<PickerProps['onAddFromSeriesRoster']>>
  >;
  let onClose: ReturnType<typeof vi.fn<NonNullable<PickerProps['onClose']>>>;

  beforeEach(() => {
    onPick = vi.fn<NonNullable<PickerProps['onPick']>>();
    onClose = vi.fn<NonNullable<PickerProps['onClose']>>();
    onAddFromSeriesRoster = vi.fn<NonNullable<PickerProps['onAddFromSeriesRoster']>>(
      async (e: SeriesRosterEntry) => `${e.id}_local`,
    );
  });

  /* Tiny harness that owns an anchor button + the picker. Mirrors the
     real callers (every caller pairs a trigger button with the picker
     via an anchorRef). The anchor is wrapped in a tagged div so tests
     can target "outside the picker but inside the page" for the
     click-outside case. */
  function Harness(props: Partial<React.ComponentProps<typeof CharacterSearchPicker>>) {
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <div data-testid="harness-root">
        <button ref={ref} data-testid="anchor">
          Anchor
        </button>
        <div data-testid="outside-target">Outside</div>
        <CharacterSearchPicker
          characters={characters}
          priorRoster={roster}
          currentCharacterId="narrator"
          onPick={onPick}
          onAddFromSeriesRoster={onAddFromSeriesRoster}
          onClose={onClose}
          anchorRef={ref}
          {...props}
        />
      </div>
    );
  }

  function renderPicker(props: Partial<React.ComponentProps<typeof CharacterSearchPicker>> = {}) {
    return render(<Harness {...props} />);
  }

  it('focuses the search input on mount', () => {
    renderPicker();
    expect(screen.getByPlaceholderText('Search character…')).toHaveFocus();
  });

  it('renders local cast on top + roster group below under separator', () => {
    renderPicker();
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    /* 3 local + 2 roster (no name collisions) = 5 rows. */
    expect(options).toHaveLength(5);
    expect(within(picker).getByText('From prior books in this series')).toBeInTheDocument();
    /* First three rows are local. */
    expect(options[0]).toHaveTextContent(/Narrator/);
    expect(options[3]).toHaveTextContent(/Councillor Linnet/);
  });

  it('filters by case-insensitive substring against name', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('wren');
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(/Wren/);
  });

  it('filters roster entries by their aliases too', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('the councillor');
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(/Councillor Linnet/);
  });

  it('hides roster entries whose name matches a local character', () => {
    /* Re-seed local cast with "Councillor Linnet" — the roster entry
       with the same name should be filtered out (no point listing it
       twice). */
    const localWithAlina: Character[] = [
      ...characters,
      { id: 'linnet', name: 'Councillor Linnet', role: 'character', color: 'sage' },
    ];
    renderPicker({ characters: localWithAlina });
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    /* 4 local + 1 roster (Mae Vance only — Linnet deduped) = 5 rows. */
    expect(options).toHaveLength(5);
    const LinnetOptions = within(picker).getAllByText('Councillor Linnet');
    expect(LinnetOptions).toHaveLength(1); // only the local row
  });

  it('arrow keys move the highlight and Enter picks the highlighted local row', async () => {
    const user = userEvent.setup();
    renderPicker();
    /* Default highlight = 0 (Narrator). Down twice → Lord Vane. */
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('lord-vane');
    expect(onClose).toHaveBeenCalled();
    expect(onAddFromSeriesRoster).not.toHaveBeenCalled();
  });

  it('Enter on a roster row triggers onAddFromSeriesRoster, then onPick with the new local id', async () => {
    const user = userEvent.setup();
    renderPicker();
    /* Move to the first roster row (index 3 = Councillor Linnet). */
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(onAddFromSeriesRoster).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'councillor-linnet' }),
      );
    });
    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith('councillor-linnet_local');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('mouse click on a roster row materialises then assigns', async () => {
    const user = userEvent.setup();
    renderPicker();
    const picker = screen.getByRole('dialog');
    const LinnetRow = within(picker).getByRole('option', { name: /Councillor Linnet/ });
    await user.click(LinnetRow);
    await waitFor(() => {
      expect(onAddFromSeriesRoster).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith('councillor-linnet_local');
    });
  });

  it('Esc closes the picker without firing onPick', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('renders empty-state message when filter has no matches', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('zzzzzzz');
    expect(screen.getByText(/No matches/i)).toBeInTheDocument();
  });

  it('degrades gracefully when priorRoster is empty or undefined', () => {
    renderPicker({ priorRoster: [] });
    expect(screen.queryByText('From prior books in this series')).not.toBeInTheDocument();
    const options = screen.getAllByRole('option');
    expect(options).toHaveLength(3); // local only
  });

  /* ── Portal + dismissal polish (this PR) ─────────────────────────── */

  it('portals the popover into document.body (escapes parent overflow:hidden)', () => {
    renderPicker();
    const picker = screen.getByRole('dialog');
    const harnessRoot = screen.getByTestId('harness-root');
    /* Picker must NOT be a descendant of the harness root — it's
       portalled out so it can escape any `overflow-y-auto` ancestor
       like the inspector's middle scroll region. */
    expect(harnessRoot.contains(picker)).toBe(false);
    expect(picker.parentElement).toBe(document.body);
    /* `fixed` (Tailwind) gives the popover `position: fixed` so the
       coords from getBoundingClientRect line up with the viewport. */
    expect(picker.className).toMatch(/\bfixed\b/);
  });

  it('does NOT close when pointer leaves the popover boundary', () => {
    renderPicker();
    const picker = screen.getByRole('dialog');
    /* Simulate the user moving the cursor away from the picker — the
       old onMouseLeave-on-row dismissal closed the menu here, which
       broke "scroll inside the list to find a character". The portal +
       click-outside model must NOT close on pointer movement alone. */
    fireEvent.mouseLeave(picker);
    fireEvent.mouseLeave(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on document mousedown outside both popover and anchor', () => {
    renderPicker();
    const outside = screen.getByTestId('outside-target');
    fireEvent.mouseDown(outside);
    expect(onClose).toHaveBeenCalled();
  });

  it('does NOT close on mousedown over the anchor (anchor toggles via its own onClick)', () => {
    renderPicker();
    const anchor = screen.getByTestId('anchor');
    fireEvent.mouseDown(anchor);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT close on mousedown inside the popover (lets the user scroll/select rows)', () => {
    renderPicker();
    const picker = screen.getByRole('dialog');
    fireEvent.mouseDown(picker);
    expect(onClose).not.toHaveBeenCalled();
  });

  /* ── onPickRosterEntry opt-in (added with the searchable-picker
       extraction; the Profile Drawer merge picker uses it). ────────── */

  it('onPickRosterEntry wins over onAddFromSeriesRoster on roster picks', async () => {
    const user = userEvent.setup();
    const onPickRosterEntry = vi.fn();
    renderPicker({ onPickRosterEntry });
    const picker = screen.getByRole('dialog');
    const LinnetRow = within(picker).getByRole('option', { name: /Councillor Linnet/ });
    await user.click(LinnetRow);
    expect(onPickRosterEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'councillor-linnet', bookId: 'the Hollow Tide-1' }),
    );
    expect(onAddFromSeriesRoster).not.toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('local picks still call onPick when onPickRosterEntry is present', async () => {
    const user = userEvent.setup();
    const onPickRosterEntry = vi.fn();
    renderPicker({ onPickRosterEntry });
    const picker = screen.getByRole('dialog');
    const WrenRow = within(picker).getByRole('option', { name: /Wren/ });
    await user.click(WrenRow);
    expect(onPick).toHaveBeenCalledWith('wren');
    expect(onPickRosterEntry).not.toHaveBeenCalled();
  });
});
