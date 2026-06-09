import { render, screen, act } from '@testing-library/react';
import { DesignProgress } from './design-progress';

describe('DesignProgress', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('shows the designing phase label', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
  });

  it('shows a ticking elapsed clock so it never looks frozen', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:00');
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(screen.getByTestId('design-elapsed')).toHaveTextContent('0:03');
  });

  it('shows the optimistic ETA inside the fast window', () => {
    render(<DesignProgress phase="designing" />);
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/about 15s/i);
  });

  it('switches to the honest "GPU busy" copy past the fast window', () => {
    render(<DesignProgress phase="designing" />);
    act(() => {
      vi.advanceTimersByTime(21000);
    });
    expect(screen.getByTestId('design-eta')).toHaveTextContent(/taking longer than usual/i);
  });

  it('flips the fill to indeterminate past the fast window', () => {
    const { container } = render(<DesignProgress phase="designing" />);
    expect(container.querySelector('.design-fill--indeterminate')).toBeNull();
    act(() => {
      vi.advanceTimersByTime(21000);
    });
    expect(container.querySelector('.design-fill--indeterminate')).toBeTruthy();
  });

  it('renders the waveform + fill scaffold', () => {
    const { container } = render(<DesignProgress phase="designing" />);
    expect(container.querySelector('[data-testid="design-waveform"]')).toBeTruthy();
    expect(container.querySelector('[data-testid="design-fill"]')).toBeTruthy();
  });

  it('shows the rendering phase label', () => {
    render(<DesignProgress phase="rendering" />);
    expect(screen.getByText(/rendering the 12s audition/i)).toBeInTheDocument();
  });
});
