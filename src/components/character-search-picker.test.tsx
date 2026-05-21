/* Plan: low-confidence-triage-polish — coverage for the shared
   CharacterSearchPicker. Pins: search-on-mount focus, substring filter
   (incl. roster aliases), arrow-key + Enter selection, Esc closes, and
   the materialise-then-assign flow for series-roster picks. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { CharacterSearchPicker } from './character-search-picker';
import type { Character } from '../lib/types';
import type { SeriesRosterEntry } from '../lib/api';

const characters: Character[] = [
  { id: 'narrator', name: 'Narrator', role: 'narrator', color: 'unset' },
  { id: 'sophie', name: 'Sophie', role: 'character', color: 'peach' },
  { id: 'lord-cassius', name: 'Lord Cassius', role: 'character', color: 'magenta' },
];

const roster: SeriesRosterEntry[] = [
  {
    id: 'councillor-alina',
    name: 'Councillor Alina',
    bookId: 'kotlc-1',
    bookTitle: 'Keeper of the Lost Cities',
    voiceId: 'v_alina',
    aliases: ['the Councillor'],
    gender: 'female',
    ageRange: 'adult',
  },
  {
    id: 'mae-vance',
    name: 'Mae Vance',
    bookId: 'kotlc-1',
    bookTitle: 'Keeper of the Lost Cities',
    voiceId: 'v_mae',
  },
];

describe('CharacterSearchPicker', () => {
  let onPick: ReturnType<typeof vi.fn>;
  let onAddFromSeriesRoster: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onPick = vi.fn();
    onClose = vi.fn();
    onAddFromSeriesRoster = vi.fn(async (e: SeriesRosterEntry) => `${e.id}_local`);
  });

  function renderPicker(props: Partial<React.ComponentProps<typeof CharacterSearchPicker>> = {}) {
    return render(
      <CharacterSearchPicker
        characters={characters}
        priorRoster={roster}
        currentCharacterId="narrator"
        onPick={onPick}
        onAddFromSeriesRoster={onAddFromSeriesRoster}
        onClose={onClose}
        {...props}
      />,
    );
  }

  it('focuses the search input on mount', () => {
    renderPicker();
    expect(screen.getByLabelText('Search character')).toHaveFocus();
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
    expect(options[3]).toHaveTextContent(/Councillor Alina/);
  });

  it('filters by case-insensitive substring against name', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('soph');
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(/Sophie/);
  });

  it('filters roster entries by their aliases too', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('the councillor');
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(/Councillor Alina/);
  });

  it('hides roster entries whose name matches a local character', () => {
    /* Re-seed local cast with "Councillor Alina" — the roster entry
       with the same name should be filtered out (no point listing it
       twice). */
    const localWithAlina: Character[] = [
      ...characters,
      { id: 'alina', name: 'Councillor Alina', role: 'character', color: 'sage' },
    ];
    renderPicker({ characters: localWithAlina });
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    /* 4 local + 1 roster (Mae Vance only — Alina deduped) = 5 rows. */
    expect(options).toHaveLength(5);
    const alinaOptions = within(picker).getAllByText('Councillor Alina');
    expect(alinaOptions).toHaveLength(1); // only the local row
  });

  it('arrow keys move the highlight and Enter picks the highlighted local row', async () => {
    const user = userEvent.setup();
    renderPicker();
    /* Default highlight = 0 (Narrator). Down twice → Lord Cassius. */
    await user.keyboard('{ArrowDown}{ArrowDown}');
    await user.keyboard('{Enter}');
    expect(onPick).toHaveBeenCalledWith('lord-cassius');
    expect(onClose).toHaveBeenCalled();
    expect(onAddFromSeriesRoster).not.toHaveBeenCalled();
  });

  it('Enter on a roster row triggers onAddFromSeriesRoster, then onPick with the new local id', async () => {
    const user = userEvent.setup();
    renderPicker();
    /* Move to the first roster row (index 3 = Councillor Alina). */
    await user.keyboard('{ArrowDown}{ArrowDown}{ArrowDown}{Enter}');
    await waitFor(() => {
      expect(onAddFromSeriesRoster).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'councillor-alina' }),
      );
    });
    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith('councillor-alina_local');
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('mouse click on a roster row materialises then assigns', async () => {
    const user = userEvent.setup();
    renderPicker();
    const picker = screen.getByRole('dialog');
    const alinaRow = within(picker).getByRole('option', { name: /Councillor Alina/ });
    await user.click(alinaRow);
    await waitFor(() => {
      expect(onAddFromSeriesRoster).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(onPick).toHaveBeenCalledWith('councillor-alina_local');
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
});
