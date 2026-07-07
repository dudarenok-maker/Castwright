import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
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
  it('does not call onChange while typing a number — only on blur', () => {
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
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '5' } });
    fireEvent.change(input, { target: { value: '55' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith(55);
    expect(typeof onChange.mock.calls[0][0]).toBe('number');
  });

  it('keeps showing the newly committed value immediately after blur, before the store confirms it', () => {
    // Regression: the draft-resync effect used to depend on `editing`
    // directly, so the blur handler's setEditing(false) — which happens
    // in the same tick as dispatching the save, before it resolves — would
    // itself re-run the effect against the still-stale `value.effective`
    // and snap the field back to the OLD value for the duration of the
    // in-flight save. `value.effective` is deliberately left at its
    // pre-edit value here to simulate that in-flight window.
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
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '55' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(55);
    expect(input.value).toBe('55');
  });

  it('calls onChange with an integer on blur when an integer input changes', () => {
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
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '7' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(7);
    expect(Number.isInteger(onChange.mock.calls[0][0])).toBe(true);
  });

  it('reverts the draft to the last effective value on blur when the typed number is invalid', () => {
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
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('10');
  });

  it('does not call onChange while typing a string — only on blur', () => {
    const descriptor = makeDescriptor({ type: 'string', default: 'hello' });
    const value = makeValue({ effective: 'hello', source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'hell' } });
    fireEvent.change(input, { target: { value: 'hello world' } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange).toHaveBeenCalledWith('hello world');
  });

  it('does not commit on blur when the field was focused/blurred but never edited (tab-through)', () => {
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
    // Tab landing on this field (e.g. as focus moves off a preceding row)
    // then away again, with no edit in between, must not fire a save.
    fireEvent.focus(input);
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('does not commit on blur when the typed value equals the current effective value', () => {
    const descriptor = makeDescriptor({ type: 'string', default: 'hello' });
    const value = makeValue({ effective: 'hello', source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'hello' } });
    fireEvent.blur(input);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('abandons an uncommitted edit instead of committing it when Revert is clicked directly', () => {
    // Regression, round 1: a mousedown-preventDefault was tried first to
    // stop this race, but that also blocks the blur the draft-resync effect
    // needs — the abandoned edit ended up silently re-committing (recreating
    // the override the click was reverting) on the row's next real blur.
    // Regression, round 2: a relatedTarget check was tried next, but WebKit
    // (desktop Safari, all iOS browsers) doesn't move focus to a <button>
    // on click the way Chromium/Firefox do, so no blur — and no
    // relatedTarget — ever fired there either. The fix forces the blur
    // itself, imperatively, via document.activeElement.blur() in
    // beginConfigAction — reproduced here with a real DOM .focus() call
    // (not fireEvent.focus) so document.activeElement is genuinely the
    // input, matching what the fix actually reads.
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const value = makeValue({ effective: 5, source: 'override', overridden: true });
    const onChange = vi.fn();
    const onRevert = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={onRevert}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    const revertButton = screen.getByRole('button', { name: /revert/i });

    act(() => input.focus());
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.mouseDown(revertButton);
    fireEvent.click(revertButton);

    expect(onChange).not.toHaveBeenCalled();
    expect(onRevert).toHaveBeenCalledOnce();
    expect(input.value).toBe('5');
  });

  it('does not clobber a fresh re-edit if an earlier rejected save resolves late', async () => {
    // Regression: the rejection .catch originally reset the draft
    // unconditionally. If the user refocuses the same field and starts a
    // new edit before the EARLIER save's rejection arrives, that stale
    // rejection must not stomp the in-progress edit.
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const value = makeValue({ effective: 10 });
    let rejectFirstSave: (() => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstSave = () => reject(new Error('save failed'));
        }),
    );
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    act(() => input.focus());
    fireEvent.change(input, { target: { value: '99' } });
    // A real input.blur() (not fireEvent.blur, which dispatches the event
    // without moving document.activeElement) so the next .focus() below is
    // a genuine focus transition rather than a same-element no-op.
    act(() => input.blur());
    expect(onChange).toHaveBeenCalledTimes(1);

    act(() => input.focus());
    fireEvent.change(input, { target: { value: '42' } });

    await act(async () => {
      rejectFirstSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(input.value).toBe('42');
  });

  it('does not clobber an already-committed newer edit if an earlier rejected save resolves late', async () => {
    // Regression: the previous fix guarded only on "is the user still
    // mid-typing" (editingRef), which isn't enough — a SECOND edit that's
    // itself already been committed (blurred, its own save dispatched) is
    // no longer "mid-typing" either, so the first edit's stale rejection
    // would still clobber it back to the pre-edit-1 value. Only the most
    // recent commit's own rejection should be allowed to revert the draft.
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const value = makeValue({ effective: 10 });
    let rejectFirstSave: (() => void) | undefined;
    const onChange = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_resolve, reject) => {
            rejectFirstSave = () => reject(new Error('save failed'));
          }),
      )
      .mockImplementationOnce(() => new Promise(() => {})); // second save never resolves either way
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    // Edit 1: 10 -> 99, committed (save in flight, not yet resolved).
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '99' } });
    act(() => input.blur());
    expect(onChange).toHaveBeenNthCalledWith(1, 99);

    // Edit 2: refocus, 99 -> 55, ALSO committed before edit 1 resolves.
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '55' } });
    act(() => input.blur());
    expect(onChange).toHaveBeenNthCalledWith(2, 55);

    // Now edit 1's stale save rejects. It must not clobber edit 2's value.
    await act(async () => {
      rejectFirstSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(input.value).toBe('55');
  });

  it('abandons an uncommitted edit when Tab lands focus directly on Revert (keyboard nav)', () => {
    // Regression: an earlier version of the fix dropped the relatedTarget
    // check entirely in favor of an onMouseDown-only mechanism, which
    // never fires for keyboard navigation — tabbing straight from a knob
    // input to its own Revert button (the common case, since Revert sits
    // right after its knob in tab order) would otherwise commit the edit
    // via the ordinary blur-commit path before Revert could abandon it.
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const value = makeValue({ effective: 5, source: 'override', overridden: true });
    const onChange = vi.fn();
    const onRevert = vi.fn();
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={onRevert}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    const revertButton = screen.getByRole('button', { name: /revert/i });

    act(() => input.focus());
    fireEvent.change(input, { target: { value: '99' } });
    // Tab's own focus change blurs the input with relatedTarget set to
    // whatever receives focus next — no mousedown involved at all.
    fireEvent.blur(input, { relatedTarget: revertButton });

    expect(onChange).not.toHaveBeenCalled();
    expect(input.value).toBe('5');
  });

  it('does not leave an unhandled rejection when a boolean save fails', async () => {
    const descriptor = makeDescriptor({ type: 'boolean', default: false });
    const value = makeValue({ effective: false, source: 'default' });
    const onChange = vi.fn(() => Promise.reject(new Error('save failed')));
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onChange).toHaveBeenCalledWith(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  it('reverts the draft to the last known value if the save is rejected', async () => {
    // Regression: with the local draft buffer, a rejected saveOverride left
    // `value.effective` untouched (config-slice only updates on fulfilled),
    // so the draft stayed frozen on the unsaved value forever with no
    // visible sign the save never landed.
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const value = makeValue({ effective: 10 });
    const onChange = vi.fn(() => Promise.reject(new Error('save failed')));
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledWith(99);
    await waitFor(() => expect(input.value).toBe('10'));
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
  it('renders a select with auto/cpu/mps plus one option per detected GPU', () => {
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
    expect(optionValues).toEqual(['auto', 'cpu', 'mps', 'cuda:0', 'cuda:1']);
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

  it('still offers auto/cpu/mps when no GPU devices were detected (sidecar down)', () => {
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
    expect(optionValues).toEqual(['auto', 'cpu', 'mps']);
  });

  /* Plan 2a on-box acceptance: the server appends a synthetic idx:-1
     "unindexed (cpu / ORT / CT2)" entry to gpuDevices[] so a cpu_fallback
     badge has somewhere to attach (gpu-devices.ts's mergeResidentData).
     That entry is not a real, pinnable card — verify it never becomes a
     bogus `cuda:-1` option in the device select. */
  it('never offers a cuda:-1 option for the synthetic unindexed device entry', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    const gpuDevicesWithUnindexed: GpuDevice[] = [
      ...GPU_DEVICES,
      {
        uuid: '',
        idx: -1,
        name: 'unindexed (cpu / ORT / CT2)',
        total_mb: 0,
        free_mb: 0,
        resident: [{ engine: 'kokoro', actual_card: null, stale_reason: 'cpu_fallback' }],
      },
    ];
    render(
      <OverrideRow
        descriptor={descriptor}
        value={value}
        onChange={vi.fn()}
        onRevert={vi.fn()}
        gpuDevices={gpuDevicesWithUnindexed}
      />,
    );
    const select = screen.getByRole('combobox');
    const optionValues = Array.from(select.querySelectorAll('option')).map((o) => o.getAttribute('value'));
    expect(optionValues).toEqual(['auto', 'cpu', 'mps', 'cuda:0', 'cuda:1']);
    expect(optionValues).not.toContain('cuda:-1');
  });
});

describe('OverrideRow — device knob stale_reason badge (Plan 2 §2.2)', () => {
  it('shows a distinct TEXT badge for cpu_fallback (not color alone)', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'cuda:1', source: 'override', overridden: true, staleReason: 'cpu_fallback' });
    render(<OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} gpuDevices={[]} />);
    expect(screen.getByText(/fell back to cpu/i)).toBeInTheDocument();
  });

  it('shows a distinct TEXT badge for uuid_unresolved', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'cuda-uuid:GONE', source: 'override', overridden: true, staleReason: 'uuid_unresolved' });
    render(<OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} gpuDevices={[]} />);
    expect(screen.getByText(/card (no longer|not) (found|detected)/i)).toBeInTheDocument();
  });

  it('renders no badge when staleReason is absent', () => {
    const descriptor = makeDescriptor({ type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'cuda:1', source: 'override', overridden: true });
    render(<OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()} gpuDevices={[]} />);
    expect(screen.queryByTestId('stale-reason-badge')).not.toBeInTheDocument();
  });
});

/* ─── device knob footprint pre-warn ─────────────────────────────────────── */

describe('OverrideRow — device knob footprint pre-warn (Plan 2 §2.2)', () => {
  it('warns when the selected card free_mb is well under the engine peak', () => {
    const descriptor = makeDescriptor({ key: 'tts.qwen.device', type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()}
        gpuDevices={[{ uuid: 'GPU-0', idx: 0, name: 'Small Card', total_mb: 4000, free_mb: 2000 }]} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cuda:0' } });
    expect(screen.getByText(/may not have enough free vram/i)).toBeInTheDocument();
  });

  it('does not warn when the selected card has ample free VRAM', () => {
    const descriptor = makeDescriptor({ key: 'tts.qwen.device', type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={vi.fn()}
        gpuDevices={[{ uuid: 'GPU-1', idx: 1, name: 'Big Card', total_mb: 16000, free_mb: 14000 }]} />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'cuda:1' } });
    expect(screen.queryByText(/may not have enough free vram/i)).not.toBeInTheDocument();
  });

  it('clears the warning when reselecting a well-provisioned card after an under-provisioned one', () => {
    const descriptor = makeDescriptor({ key: 'tts.qwen.device', type: 'device', default: 'auto' });
    const value = makeValue({ effective: 'auto', source: 'default' });
    const onChange = vi.fn();
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()}
        gpuDevices={[
          { uuid: 'GPU-0', idx: 0, name: 'Small Card', total_mb: 4000, free_mb: 2000 },
          { uuid: 'GPU-1', idx: 1, name: 'Big Card', total_mb: 16000, free_mb: 14000 },
        ]} />,
    );
    const select = screen.getByRole('combobox');
    fireEvent.change(select, { target: { value: 'cuda:0' } });
    expect(screen.getByText(/may not have enough free vram/i)).toBeInTheDocument();

    fireEvent.change(select, { target: { value: 'cuda:1' } });
    expect(screen.queryByText(/may not have enough free vram/i)).not.toBeInTheDocument();
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
