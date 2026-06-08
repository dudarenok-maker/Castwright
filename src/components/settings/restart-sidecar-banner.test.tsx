import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { RestartSidecarBanner } from './restart-sidecar-banner';

describe('RestartSidecarBanner', () => {
  it('renders nothing when visible is false', () => {
    const { container } = render(
      <RestartSidecarBanner visible={false} onRestart={vi.fn()} />,
    );
    expect(container.firstChild).toBeNull();
  });

  it('renders the banner when visible is true', () => {
    render(<RestartSidecarBanner visible={true} onRestart={vi.fn()} />);
    expect(screen.getByRole('button', { name: /restart sidecar/i })).toBeInTheDocument();
  });

  it('calls onRestart when the button is clicked', () => {
    const onRestart = vi.fn();
    render(<RestartSidecarBanner visible={true} onRestart={onRestart} />);
    fireEvent.click(screen.getByRole('button', { name: /restart sidecar/i }));
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it('disables the button and shows "Restarting…" when restarting prop is true', () => {
    render(
      <RestartSidecarBanner visible={true} onRestart={vi.fn()} restarting={true} />,
    );
    const button = screen.getByRole('button', { name: /restarting/i });
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/restarting/i);
  });
});
