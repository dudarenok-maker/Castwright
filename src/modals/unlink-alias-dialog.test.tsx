import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { UnlinkAliasDialog } from './unlink-alias-dialog';

const targets = [
  { id: 'anton', name: 'Антон' },
  { id: 'narrator', name: 'Narrator' },
] as never;

function setup(overrides = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <UnlinkAliasDialog
      aliasName="Я"
      sourceName="Егор"
      targets={targets}
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    />,
  );
  return { onConfirm, onCancel };
}

describe('UnlinkAliasDialog', () => {
  it('defaults to "own character" and confirms a split', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'split' });
  });

  it('requires a target before "move" can continue', () => {
    const { onConfirm } = setup();
    fireEvent.click(screen.getByRole('radio', { name: /move/i }));
    const continueBtn = screen.getByRole('button', { name: /continue/i });
    expect(continueBtn).toHaveProperty('disabled', true);
    fireEvent.change(screen.getByRole('combobox', { name: /move .* to/i }), { target: { value: 'anton' } });
    expect(continueBtn).toHaveProperty('disabled', false);
    fireEvent.click(continueBtn);
    expect(onConfirm).toHaveBeenCalledWith({ mode: 'move', targetCharacterId: 'anton' });
  });

  it('Cancel fires onCancel and never onConfirm', () => {
    const { onConfirm, onCancel } = setup();
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalled();
    expect(onConfirm).not.toHaveBeenCalled();
  });

  it('renders an error line when error is set', () => {
    setup({ error: 'Backend exploded' });
    expect(screen.getByText(/Backend exploded/)).toBeTruthy();
  });

  it('disables both buttons while busy', () => {
    setup({ busy: true });
    expect(screen.getByRole('button', { name: /continue/i })).toHaveProperty('disabled', true);
    expect(screen.getByRole('button', { name: /cancel/i })).toHaveProperty('disabled', true);
  });

  it('does not crash with an empty target list (only split selectable)', () => {
    setup({ targets: [] as never });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
});
