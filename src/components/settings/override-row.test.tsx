import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OverrideRow } from './override-row';
import type { GpuDevice, KnobDescriptor, KnobValue } from '../../lib/types';

/* ─── test fixtures ─────────────────────────────────────────────────────── */

function makeDescriptor(overrides: Partial<KnobDescriptor> = {}): KnobDescriptor {
  return {
    key: 'test_knob',
    group: 'general',
    label: 'Test Knob',
    help: 'A helpful description.',
    type: 'number',
    min: 0,
    max: 100,
    step: 1,
    apply: 'live',
    risk: 'low',
    isPrompt: false,
    default: 42,
    ...overrides,
  };
}

function makeValue(overrides: Partial<KnobValue> = {}): KnobValue {
  return {
    key: 'test_knob',
    effective: 42,
    source: 'default',
    locked: false,
    overridden: false,
    ...overrides,
  };
}

/* ─── env-locked state ───────────────────────────────────────────────────── */

describe('OverrideRow — env-locked', () => {
  it('renders the control as disabled when value.locked is true', () => {
    const descriptor = makeDescriptor({ type: 'number' });
    const value = makeValue({ source: 'env', locked: true, effective: 99 });
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton');
    expect(input).toBeDisabled();
  });

  it('shows a "set in .env" indicator when locked', () => {
    const descriptor = makeDescriptor({ type: 'number' });
    const value = makeValue({ source: 'env', locked: true, effective: 99 });
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(screen.getByText(/set in \.env/i)).toBeInTheDocument();
  });

  it('does NOT render a Revert button when locked', () => {
    const descriptor = makeDescriptor({ type: 'number' });
    const value = makeValue({ source: 'env', locked: true, effective: 99 });
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /revert/i })).not.toBeInTheDocument();
  });
});

/* ─── overridden state ───────────────────────────────────────────────────── */

describe('OverrideRow — overridden', () => {
  it('shows the default value when the knob is overridden', () => {
    const descriptor = makeDescriptor({ default: 42 });
    const value = makeValue({ source: 'override', overridden: true, effective: 99 });
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
      />,
    );
    // The default value should be visible somewhere in the row
    expect(screen.getByText(/42/)).toBeInTheDocument();
  });

  it('calls onRevert when the Revert button is clicked', () => {
    const descriptor = makeDescriptor({ default: 42 });
    const value = makeValue({ source: 'override', overridden: true, effective: 99 });
    const onRevert = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={onRevert}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));
    expect(onRevert).toHaveBeenCalledOnce();
  });
});

/* ─── onChange coercion ──────────────────────────────────────────────────── */

describe('OverrideRow — onChange coercion', () => {
  it('calls onChange with a number when a number input changes', () => {
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const value = makeValue({ effective: 10 });
    const onChange = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '55' } });
    expect(onChange).toHaveBeenCalledWith(55);
    expect(typeof onChange.mock.calls[0][0]).toBe('number');
  });

  it('calls onChange with an integer when an integer input changes', () => {
    const descriptor = makeDescriptor({ type: 'integer', min: 1, max: 10, step: 1 });
    const value = makeValue({ effective: 3 });
    const onChange = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.change(input, { target: { value: '7' } });
    expect(onChange).toHaveBeenCalledWith(7);
    expect(Number.isInteger(onChange.mock.calls[0][0])).toBe(true);
  });

  it('calls onChange with the option string when an enum select changes', () => {
    const descriptor = makeDescriptor({
      type: 'enum',
      options: ['alpha', 'beta', 'gamma'],
      default: 'alpha',
    });
    const value = makeValue({ effective: 'alpha', source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'beta' } });
    expect(onChange).toHaveBeenCalledWith('beta');
    expect(typeof onChange.mock.calls[0][0]).toBe('string');
  });

  it('calls onChange with a boolean when a boolean toggle changes', () => {
    const descriptor = makeDescriptor({ type: 'boolean', default: false });
    const value = makeValue({ effective: false, source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole('checkbox');
    fireEvent.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(true);
    expect(typeof onChange.mock.calls[0][0]).toBe('boolean');
  });
});

/* ─── device knob (GPU picker dropdown) ─────────────────────────────────── */

const GPU_DEVICES: GpuDevice[] = [
  { uuid: 'GPU-0', idx: 0, name: 'RTX 4070 Laptop', total_mb: 8000, free_mb: 6000 },
  { uuid: 'GPU-1', idx: 1, name: 'RTX 5070 Ti', total_mb: 16000, free_mb: 14000 },
];

describe('OverrideRow — device knob', () => {
  it('renders a select with auto/cpu plus one option per detected GPU', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
        gpuDevices={GPU_DEVICES}
      />,
    );
    const select = screen.getByRole('combobox');
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['auto', 'cpu', 'cuda:0', 'cuda:1']);
    expect(screen.getByText(/RTX 5070 Ti/)).toBeInTheDocument();
  });

  it('calls onChange with the cuda:N value when a GPU option is selected', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
        gpuDevices={GPU_DEVICES}
      />,
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'cuda:1' } });
    expect(onChange).toHaveBeenCalledWith('cuda:1');
  });

  it('keeps a stale current value selectable even when it is not in the detected GPU list', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'cuda:9', source: 'override', overridden: true });
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
        gpuDevices={GPU_DEVICES}
      />,
    );
    const select = screen.getByRole('combobox') as HTMLSelectElement;
    expect(select.value).toBe('cuda:9');
    expect(screen.getByRole('option', { name: 'cuda:9' })).toBeInTheDocument();
  });

  it('still offers auto/cpu when no GPU devices were detected (sidecar down)', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
        gpuDevices={[]}
      />,
    );
    const select = screen.getByRole('combobox');
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['auto', 'cpu']);
  });
});

/* ─── apply pill labels ──────────────────────────────────────────────────── */

describe('OverrideRow — apply pills', () => {
  it('shows a "live" pill when apply === "live"', () => {
    const descriptor = makeDescriptor({ apply: 'live' });
    const value = makeValue();
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} />,
    );
    expect(screen.getByText('live')).toBeInTheDocument();
  });

  it('shows a "restart" pill when apply === "restart-sidecar"', () => {
    const descriptor = makeDescriptor({ apply: 'restart-sidecar' });
    const value = makeValue();
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} />,
    );
    expect(screen.getByText('restart')).toBeInTheDocument();
  });

  it('shows a "restart · app" pill when apply === "restart-server"', () => {
    const descriptor = makeDescriptor({ apply: 'restart-server' });
    const value = makeValue();
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} />,
    );
    expect(screen.getByText('restart · app')).toBeInTheDocument();
  });
});
