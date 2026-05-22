/* Generic SearchablePicker primitive — covers the popover scaffolding
   shared by every typeahead picker in the app. */

import { useRef } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SearchablePicker, type PickerGroup } from './searchable-picker';

interface Fruit {
  id: string;
  name: string;
  flavour: string;
}

const fruits: Fruit[] = [
  { id: 'apple', name: 'Apple', flavour: 'crisp' },
  { id: 'banana', name: 'Banana', flavour: 'sweet' },
  { id: 'cherry', name: 'Cherry', flavour: 'tart' },
];

const veggies: Fruit[] = [
  { id: 'carrot', name: 'Carrot', flavour: 'earthy' },
  { id: 'kale', name: 'Kale', flavour: 'bitter' },
];

function buildGroups(): PickerGroup<Fruit>[] {
  return [
    {
      items: fruits.map((f) => ({ id: f.id, haystack: [f.name, f.flavour], data: f })),
    },
    {
      label: 'Veggies',
      items: veggies.map((v) => ({ id: v.id, haystack: [v.name, v.flavour], data: v })),
    },
  ];
}

describe('SearchablePicker', () => {
  let onPick: ReturnType<typeof vi.fn>;
  let onClose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    onPick = vi.fn();
    onClose = vi.fn();
  });

  function Harness(
    props: Partial<React.ComponentProps<typeof SearchablePicker<Fruit>>> = {},
  ) {
    const ref = useRef<HTMLButtonElement>(null);
    return (
      <div data-testid="harness-root">
        <button ref={ref} data-testid="anchor">
          Anchor
        </button>
        <div data-testid="outside-target">Outside</div>
        <SearchablePicker<Fruit>
          groups={buildGroups()}
          activeId=""
          renderItem={(f) => <span>{f.name}</span>}
          onPick={onPick}
          onClose={onClose}
          anchorRef={ref}
          ariaLabel="Fruit picker"
          searchPlaceholder="Search fruit…"
          {...props}
        />
      </div>
    );
  }

  function renderPicker(
    props: Partial<React.ComponentProps<typeof SearchablePicker<Fruit>>> = {},
  ) {
    return render(<Harness {...props} />);
  }

  it('focuses the search input on mount', () => {
    renderPicker();
    expect(screen.getByLabelText('Search fruit…')).toHaveFocus();
  });

  it('renders all groups with separator above labelled groups', () => {
    renderPicker();
    const picker = screen.getByRole('dialog', { name: 'Fruit picker' });
    expect(within(picker).getAllByRole('option')).toHaveLength(5);
    expect(within(picker).getByText('Veggies')).toBeInTheDocument();
  });

  it('filters by case-insensitive substring across haystack', async () => {
    const user = userEvent.setup();
    renderPicker();
    /* "bitter" is in Kale's haystack only — should narrow to 1 row. */
    await user.keyboard('bitter');
    const picker = screen.getByRole('dialog');
    const options = within(picker).getAllByRole('option');
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent(/Kale/);
  });

  it('ArrowDown + Enter picks the highlighted row', async () => {
    const user = userEvent.setup();
    renderPicker();
    /* Default highlight = Apple. Two ArrowDown → Cherry. */
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'cherry' }),
    );
  });

  it('Escape closes without picking', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalled();
    expect(onPick).not.toHaveBeenCalled();
  });

  it('renders empty state when filter has no matches', async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.keyboard('xxxxxxx');
    expect(screen.getByText(/No matches/i)).toBeInTheDocument();
  });

  it('renders a custom emptyState when provided', async () => {
    const user = userEvent.setup();
    renderPicker({ emptyState: 'Nothing here.' });
    await user.keyboard('xxxxxxx');
    expect(screen.getByText('Nothing here.')).toBeInTheDocument();
  });

  it('portals the popover into document.body', () => {
    renderPicker();
    const picker = screen.getByRole('dialog');
    const harnessRoot = screen.getByTestId('harness-root');
    expect(harnessRoot.contains(picker)).toBe(false);
    expect(picker.parentElement).toBe(document.body);
    expect(picker.className).toMatch(/\bfixed\b/);
  });

  it('does NOT close on pointer-leave', () => {
    renderPicker();
    const picker = screen.getByRole('dialog');
    fireEvent.mouseLeave(picker);
    fireEvent.mouseLeave(document.body);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('closes on mousedown outside popover + anchor', () => {
    renderPicker();
    fireEvent.mouseDown(screen.getByTestId('outside-target'));
    expect(onClose).toHaveBeenCalled();
  });

  it('does NOT close on mousedown over anchor', () => {
    renderPicker();
    fireEvent.mouseDown(screen.getByTestId('anchor'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('does NOT close on mousedown inside popover', () => {
    renderPicker();
    fireEvent.mouseDown(screen.getByRole('dialog'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('skips disabled rows during keyboard nav', async () => {
    const user = userEvent.setup();
    /* Make Banana disabled — ArrowDown from Apple should skip to
       Cherry, not stop on Banana. */
    const groups: PickerGroup<Fruit>[] = [
      {
        items: [
          { id: 'apple', haystack: ['Apple'], data: fruits[0] },
          { id: 'banana', haystack: ['Banana'], data: fruits[1], disabled: true },
          { id: 'cherry', haystack: ['Cherry'], data: fruits[2] },
        ],
      },
    ];
    renderPicker({ groups });
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'cherry' }));
  });

  it('disabled rows are unpickable on click', async () => {
    const user = userEvent.setup();
    const groups: PickerGroup<Fruit>[] = [
      {
        items: [
          { id: 'apple', haystack: ['Apple'], data: fruits[0] },
          { id: 'banana', haystack: ['Banana'], data: fruits[1], disabled: true },
        ],
      },
    ];
    renderPicker({ groups });
    const picker = screen.getByRole('dialog');
    const bananaRow = within(picker).getByRole('option', { name: /Banana/ });
    await user.click(bananaRow);
    expect(onPick).not.toHaveBeenCalled();
  });

  it('renderItem receives ctx with highlighted / active / disabled flags', () => {
    renderPicker({
      activeId: 'banana',
      renderItem: (f, ctx) => (
        <span>
          {f.name}
          {ctx.active && <span data-testid={`active-${f.id}`}>★</span>}
        </span>
      ),
    });
    expect(screen.getByTestId('active-banana')).toBeInTheDocument();
  });

  it('hides the search input when hideSearch is true', () => {
    renderPicker({ hideSearch: true });
    expect(screen.queryByLabelText('Search fruit…')).not.toBeInTheDocument();
  });
});
