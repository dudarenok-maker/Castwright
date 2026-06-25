import { render, screen, act } from '@testing-library/react';
import { DesignProgress } from './design-progress';

describe('DesignProgress (honest)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('labels the current phase', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
  });

  it('shows the loading-model and rendering labels', () => {
    const { rerender } = render(<DesignProgress phase="loading-model" />);
    expect(screen.getByText(/loading the design model/i)).toBeInTheDocument();
    rerender(<DesignProgress phase="rendering" />);
    expect(screen.getByText(/rendering the 12s audition/i)).toBeInTheDocument();
  });

  it('ticks the elapsed clock', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:00');
    act(() => vi.advanceTimersByTime(3000));
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:03');
  });

  it('shows a realistic ETA, not "about 15s"', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-eta')).not.toHaveTextContent(/about 15s/i);
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/~\d/); // e.g. "~1:10 left"
  });

  it('does NOT cry "GPU busy" at a normal ~30s into designing', () => {
    render(<DesignProgress phase="designing" />);
    act(() => vi.advanceTimersByTime(30_000));
    expect(screen.getByTestId('design-eta')).not.toHaveTextContent(/taking longer than usual/i);
  });

  it('flips to the honest slow warning only past a real overage', () => {
    render(<DesignProgress phase="designing" />);
    act(() => vi.advanceTimersByTime(140_000)); // > 2× the designing budget
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/taking longer than usual/i);
  });

  it('snaps to complete', () => {
    const { container } = render(<DesignProgress phase="rendering" complete />);
    const fill = container.querySelector('[data-testid="design-fill"] > i') as HTMLElement;
    expect(fill.style.width).toBe('100%');
  });

  it('renders the waveform + fill scaffold', () => {
    const { container } = render(<DesignProgress phase="designing" />);
    expect(container.querySelector('[data-testid="design-waveform"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-fill"]')).toBeTruthy();
  });
});
