import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { EmptyLibrary } from './library-empty-states';

describe('EmptyLibrary', () => {
  it('renders a try-a-sample affordance that fires onTrySample', () => {
    const onTrySample = vi.fn();
    render(<EmptyLibrary onStartNew={() => {}} onTrySample={onTrySample} />);
    fireEvent.click(screen.getByText(/try a sample book/i));
    expect(onTrySample).toHaveBeenCalledTimes(1);
  });

  it('omits the try-a-sample affordance when onTrySample is not provided', () => {
    render(<EmptyLibrary onStartNew={() => {}} />);
    expect(screen.queryByText(/try a sample book/i)).not.toBeInTheDocument();
  });

  it('renders the guided-tour CTA and fires onStartTour', () => {
    const onStartTour = vi.fn();
    render(<EmptyLibrary onStartNew={() => {}} onTrySample={() => {}} onStartTour={onStartTour} tourCompleted={false} />);
    fireEvent.click(screen.getByRole('button', { name: /take the guided tour/i }));
    expect(onStartTour).toHaveBeenCalled();
  });

  it('suppresses the guided-tour CTA once the tour is completed', () => {
    render(<EmptyLibrary onStartNew={() => {}} onTrySample={() => {}} onStartTour={vi.fn()} tourCompleted />);
    expect(screen.queryByRole('button', { name: /take the guided tour/i })).toBeNull();
  });
});
