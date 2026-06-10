import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DesignScopePicker } from './design-scope-picker';

const props = (over = {}) => ({
  baseCount: 21,
  variantTotal: 40,
  variantReady: 5,
  variantBlocked: 35,
  variantBlockedChars: 14,
  onPick: vi.fn(),
  onClose: vi.fn(),
  ...over,
});

describe('DesignScopePicker', () => {
  it('shows total variant demand, the ready/blocked split, and a combined "both" total', () => {
    render(<DesignScopePicker {...props()} />);
    expect(screen.getByTestId('scope-bases')).toHaveTextContent('21 needed');
    expect(screen.getByTestId('scope-variants')).toHaveTextContent('40');
    expect(screen.getByTestId('scope-both')).toHaveTextContent('61 tasks');
    const split = screen.getByTestId('variants-split');
    expect(split).toHaveTextContent('5 ready');
    expect(split).toHaveTextContent('35 need a base');
  });

  it('shows a loud base-voice warning when some variants are blocked', () => {
    render(<DesignScopePicker {...props()} />);
    expect(screen.getByTestId('variants-base-warning')).toHaveTextContent('14');
    expect(screen.getByTestId('variants-base-warning')).toHaveTextContent(/base voice/i);
  });

  it('disables "Emotion variants" when nothing is ready, but keeps the warning visible', () => {
    render(
      <DesignScopePicker
        {...props({ variantReady: 0, variantBlocked: 40, variantBlockedChars: 16 })}
      />,
    );
    expect(screen.getByTestId('scope-variants')).toBeDisabled();
    expect(screen.getByTestId('variants-base-warning')).toBeInTheDocument();
  });

  it('enables "Emotion variants" when at least one is ready', () => {
    render(<DesignScopePicker {...props()} />);
    expect(screen.getByTestId('scope-variants')).not.toBeDisabled();
  });

  it('hides the base warning when every variant is ready', () => {
    render(
      <DesignScopePicker
        {...props({ variantTotal: 5, variantReady: 5, variantBlocked: 0, variantBlockedChars: 0 })}
      />,
    );
    expect(screen.queryByTestId('variants-base-warning')).not.toBeInTheDocument();
  });

  it('shows "all done" for a scope with no work', () => {
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
    render(
      <DesignScopePicker
        {...props({ baseCount: 0, variantTotal: 0, variantReady: 0, variantBlocked: 0, variantBlockedChars: 0 })}
      />,
    );
    expect(screen.getByTestId('scope-both')).toBeDisabled();
  });
});
