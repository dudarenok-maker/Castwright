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
});
