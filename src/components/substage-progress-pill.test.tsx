import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SubstageProgressPill } from './substage-progress-pill';

describe('SubstageProgressPill', () => {
  it('renders status label and percent, with no detail span when detailText is null', () => {
    render(
      <SubstageProgressPill
        testId="pill"
        detailTestId="pill-detail"
        status="Reviewing script"
        detailText={null}
        percent={42}
      />,
    );
    expect(screen.getByTestId('pill')).toBeInTheDocument();
    expect(screen.getByText('Reviewing script')).toBeInTheDocument();
    expect(screen.getByText('42%')).toBeInTheDocument();
    expect(screen.queryByTestId('pill-detail')).toBeNull();
  });

  it('renders the detail span with its text when detailText is non-null', () => {
    render(
      <SubstageProgressPill
        testId="pill"
        detailTestId="pill-detail"
        status="Detecting emotions"
        detailText="Chapter 3 of 12 · ~4m left"
        percent={25}
      />,
    );
    expect(screen.getByTestId('pill-detail').textContent).toBe('Chapter 3 of 12 · ~4m left');
  });

  it('omits the Cancel button when onCancel is not provided', () => {
    render(
      <SubstageProgressPill
        testId="pill"
        detailTestId="pill-detail"
        status="Reviewing script"
        detailText={null}
        percent={10}
      />,
    );
    expect(screen.queryByRole('button', { name: /cancel/i })).toBeNull();
  });

  it('renders a Cancel button that invokes onCancel when provided', () => {
    const onCancel = vi.fn();
    render(
      <SubstageProgressPill
        testId="pill"
        detailTestId="pill-detail"
        status="Detecting emotions"
        detailText={null}
        percent={10}
        onCancel={onCancel}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
