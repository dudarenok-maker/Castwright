import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignScopePicker } from './design-scope-picker';

const props = (over = {}) => ({ baseCount: 2, variantCount: 5, onPick: vi.fn(), onClose: vi.fn(), ...over });

describe('DesignScopePicker', () => {
  it('shows live counts and a combined "both" total', () => {
    render(<DesignScopePicker {...props()} />);
    expect(screen.getByTestId('scope-bases')).toHaveTextContent('2 needed');
    expect(screen.getByTestId('scope-variants')).toHaveTextContent('5 needed');
    expect(screen.getByTestId('scope-both')).toHaveTextContent('7 tasks');
  });
  it('disables an empty scope with "all done"', () => {
    render(<DesignScopePicker {...props({ baseCount: 0 })} />);
    expect(screen.getByTestId('scope-bases')).toBeDisabled();
    expect(screen.getByTestId('scope-bases')).toHaveTextContent('all done');
  });
  it('calls onPick with the chosen scope', async () => {
    const onPick = vi.fn();
    render(<DesignScopePicker {...props({ onPick })} />);
    await userEvent.click(screen.getByTestId('scope-variants'));
    expect(onPick).toHaveBeenCalledWith('variants');
  });
  it('disables both when there is no work at all', () => {
    render(<DesignScopePicker {...props({ baseCount: 0, variantCount: 0 })} />);
    expect(screen.getByTestId('scope-both')).toBeDisabled();
  });
});
