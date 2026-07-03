import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Checkbox } from './primitives';

describe('Checkbox', () => {
  it('renders unchecked with no checkmark', () => {
    render(<Checkbox checked={false} onChange={() => {}} label="Expressive directions" />);
    const box = screen.getByRole('checkbox', { name: /expressive directions/i });
    expect(box).not.toBeChecked();
  });

  it('renders checked with the checkmark visible', () => {
    render(<Checkbox checked onChange={() => {}} label="Expressive directions" />);
    const box = screen.getByRole('checkbox', { name: /expressive directions/i });
    expect(box).toBeChecked();
  });

  it('calls onChange with the new boolean when toggled', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Expressive directions" />);
    fireEvent.click(screen.getByRole('checkbox', { name: /expressive directions/i }));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('does not include the description text in the accessible name', () => {
    render(
      <Checkbox
        checked={false}
        onChange={() => {}}
        label="Expressive directions"
        description="Generate per-line emotion + delivery directions."
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Expressive directions' });
    expect(box).toHaveAccessibleDescription(/generate per-line emotion/i);
    expect(screen.getByText(/generate per-line emotion/i)).toBeInTheDocument();
  });

  it('is disabled and non-interactive when disabled is set', () => {
    const onChange = vi.fn();
    render(<Checkbox checked={false} onChange={onChange} label="Locked setting" disabled />);
    const box = screen.getByRole('checkbox', { name: /locked setting/i });
    expect(box).toBeDisabled();
    fireEvent.click(box);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('falls back to aria-label when no visible label is given', () => {
    render(<Checkbox checked={false} onChange={() => {}} aria-label="Select row" />);
    expect(screen.getByRole('checkbox', { name: 'Select row' })).toBeInTheDocument();
  });

  it('honors an explicit id for external htmlFor references', () => {
    render(<Checkbox checked={false} onChange={() => {}} id="prosody-toggle" label="X" />);
    expect(document.getElementById('prosody-toggle')).not.toBeNull();
  });

  it('renders no wrapping <label> of its own when no label text is given, so a caller can safely nest it in their own <label> without invalid nested labels', () => {
    const { container } = render(
      <label htmlFor="row-toggle" data-testid="row-label">
        <Checkbox id="row-toggle" checked={false} onChange={() => {}} aria-label="Select row" />
        Row text
      </label>,
    );
    expect(container.querySelectorAll('label')).toHaveLength(1);
  });

  it('toggles via a click on the caller-owned wrapping label when rendered bare', () => {
    const onChange = vi.fn();
    render(
      <label htmlFor="row-toggle-2">
        <Checkbox id="row-toggle-2" checked={false} onChange={onChange} aria-label="Select row" />
        Row text
      </label>,
    );
    fireEvent.click(screen.getByText('Row text'));
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('dims a disabled checkbox rendered bare (no label prop), matching the labeled-mode disabled look', () => {
    const { container } = render(
      <Checkbox checked={false} onChange={() => {}} aria-label="Select row" disabled />,
    );
    expect(container.querySelector('.opacity-50')).not.toBeNull();
  });

  it('applies the peach accent to the checked box instead of the default magenta', () => {
    const { container } = render(
      <Checkbox checked onChange={() => {}} aria-label="Sync profile" accent="peach" />,
    );
    const visualBox = container.querySelector('[aria-hidden="true"]');
    expect(visualBox?.className).toContain('bg-peach');
    expect(visualBox?.className).not.toContain('bg-magenta');
  });

  it('lets a caller override the label text styling via labelClassName', () => {
    render(
      <Checkbox
        checked={false}
        onChange={() => {}}
        label="Also stop generation in progress"
        labelClassName="text-sm text-ink/75"
      />,
    );
    const labelText = screen.getByText('Also stop generation in progress');
    expect(labelText.className).toBe('text-sm text-ink/75');
  });
});
