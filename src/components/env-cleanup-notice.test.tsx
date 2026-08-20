import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EnvCleanupNotice } from './env-cleanup-notice';

describe('EnvCleanupNotice', () => {
  it('renders nothing when candidateCount is 0', () => {
    const { container } = render(
      <EnvCleanupNotice candidateCount={0} onCleanup={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the notice and count when candidateCount is greater than 0', () => {
    render(<EnvCleanupNotice candidateCount={3} onCleanup={vi.fn()} />);
    expect(screen.getByText(/3 settings look like leftover defaults/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /clean up/i })).toBeInTheDocument();
  });

  it('uses the singular "setting" for a count of 1', () => {
    render(<EnvCleanupNotice candidateCount={1} onCleanup={vi.fn()} />);
    expect(screen.getByText(/1 setting look/i)).toBeInTheDocument();
  });

  it('calls onCleanup when the button is clicked', () => {
    const onCleanup = vi.fn();
    render(<EnvCleanupNotice candidateCount={2} onCleanup={onCleanup} />);
    fireEvent.click(screen.getByRole('button', { name: /clean up/i }));
    expect(onCleanup).toHaveBeenCalledOnce();
  });

  it('disables the button and shows "Cleaning up…" when busy is true', () => {
    render(<EnvCleanupNotice candidateCount={2} onCleanup={vi.fn()} busy={true} />);
    const button = screen.getByRole('button', { name: /cleaning up/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/cleaning up/i);
  });
});
