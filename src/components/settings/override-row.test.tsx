import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { OverrideRow, describeConfigSaveError } from './override-row';
import { realPutConfig, realResetConfig } from '../../lib/api';
import type { GpuDevice, KnobDescriptor, KnobValue } from '../../lib/types';

/* #2209 review B1 — the ORIGINAL version of this helper hard-coded
   "Config update failed", and every Revert-path test in this file reused
   it: `POST /api/config/reset` actually throws "Config reset failed", so
   those tests asserted a rejection shape the reset path cannot produce.
   Kept for tests that exercise something OTHER than the parser itself
   (generation-guard races, per-row isolation, a11y wiring) — action-aware
   now, so it can no longer independently drift from the real verb the way
   the single hard-coded string did. The tests that specifically prove
   describeConfigSaveError parses a REAL rejection (below) drive the
   actual realPutConfig/realResetConfig throw sites instead — a test that
   hand-writes the wire string can only prove the parser matches what the
   test author imagined, not what production code actually produces. */
function wrappedConfigError(action: 'update' | 'reset', status: number, error: string): Error {
  return new Error(`Config ${action} failed (${status}): ${JSON.stringify({ error })}`);
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Drives the REAL realPutConfig ('put') / realResetConfig ('reset')
    against a stubbed global fetch returning the given status + `{error}`
    body, and returns the Error it actually throws (#2209 review B1). */
async function realConfigRejection(
  verb: 'put' | 'reset',
  status: number,
  error: string,
): Promise<Error> {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ error }, status)));
  try {
    if (verb === 'put') await realPutConfig({ 'qa.asr.device': 'irrelevant' });
    else await realResetConfig({ keys: ['irrelevant'] });
    throw new Error('expected the real config API call to reject');
  } catch (e) {
    return e as Error;
  } finally {
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

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

  it('does not clobber a value already reset externally while the original save is still pending', async () => {
    // Regression: the previous guard (commitSeqRef) only tracked NEWER
    // LOCAL commits — it didn't account for value.effective changing via
    // an EXTERNAL Revert/Reset on the same field while the original save
    // was still in flight. Replaced with a single generationRef bumped on
    // any value.effective change too, not just local commits.
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    let rejectSave: (() => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = () => reject(new Error('save failed'));
        }),
    );
    const { rerender } = render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 10 })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    // Edit: 10 -> 99, committed, save in flight (not yet resolved).
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '99' } });
    act(() => input.blur());
    expect(onChange).toHaveBeenCalledTimes(1);

    // Externally, the field gets reset to its real default (0) — e.g. the
    // user clicked Revert and resetKnob resolved — before the original
    // save settles. Simulated by re-rendering with the new value, same as
    // a real store update flowing down as a prop change.
    rerender(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 0 })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    expect(input.value).toBe('0');

    // The original (99) save's stale rejection arrives. It must NOT
    // clobber the already-correct, already-reset value.
    await act(async () => {
      rejectSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(input.value).toBe('0');
  });

  it("does not abandon an unrelated row's in-progress edit when a different row's Revert is clicked", () => {
    // Regression: beginConfigAction used to blur/abandon whatever was
    // GLOBALLY focused (document.activeElement), regardless of which
    // row's Revert button was actually clicked. Now scoped to the
    // clicked button's own row via inputRef.
    const descriptorA = makeDescriptor({ key: 'knob_a', label: 'Knob A', type: 'number' });
    const valueA = makeValue({ key: 'knob_a', effective: 5 });
    const onChangeA = vi.fn();

    const descriptorB = makeDescriptor({ key: 'knob_b', label: 'Knob B', type: 'number' });
    const valueB = makeValue({
      key: 'knob_b',
      effective: 7,
      source: 'override',
      overridden: true,
    });
    const onRevertB = vi.fn();

    render(
      <>
        <OverrideRow
          descriptor={descriptorA}
          value={valueA}
          onChange={onChangeA}
          onRevert={vi.fn()}
        />
        <OverrideRow descriptor={descriptorB} value={valueB} onChange={vi.fn()} onRevert={onRevertB} />
      </>,
    );
    const inputA = screen.getByRole('spinbutton', { name: 'Knob A' }) as HTMLInputElement;
    const revertB = screen.getByRole('button', { name: /revert/i });

    // Mid-typing in Row A, never blurred...
    act(() => inputA.focus());
    fireEvent.change(inputA, { target: { value: '99' } });

    // ...then click Row B's Revert.
    fireEvent.mouseDown(revertB);
    fireEvent.click(revertB);

    expect(onRevertB).toHaveBeenCalledOnce();
    expect(onChangeA).not.toHaveBeenCalled();
    // Row A's in-progress edit must be untouched — still showing what was
    // typed, not silently abandoned back to 5.
    expect(inputA.value).toBe('99');
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

/* ─── describeConfigSaveError (#2209) ────────────────────────────────────── */

describe('describeConfigSaveError', () => {
  it('extracts the server error field from a wrapped 400', () => {
    const err = wrappedConfigError(
      'update',
      400,
      'qa.asr.device: does not match the required shape (^(cpu|auto|cuda|cuda:\\d+)$)',
    );
    expect(describeConfigSaveError(err)).toEqual({
      status: 400,
      locked: false,
      message: 'qa.asr.device: does not match the required shape (^(cpu|auto|cuda|cuda:\\d+)$)',
    });
  });

  it('marks a 409 as locked', () => {
    const err = wrappedConfigError('update', 409, 'tts.qwen.attnImpl is set in environment');
    expect(describeConfigSaveError(err)).toEqual({
      status: 409,
      locked: true,
      message: 'tts.qwen.attnImpl is set in environment',
    });
  });

  /* #2209 review B1 — the regex used to be anchored to "Config update
     failed" only, so a rejected Revert/Reset (realResetConfig throws
     "Config reset failed") never matched at all and rendered raw. Driven
     against the REAL realResetConfig throw site, not a hand-typed string
     — see realConfigRejection's own doc comment. */
  it('parses a rejection from the REAL reset path (realResetConfig), not just update', async () => {
    const err = await realConfigRejection(
      'reset',
      400,
      'qa.asr.device=cpu + qa.asr.computeType=float16 is an unsupported pair.',
    );
    expect(err.message).toMatch(/^Config reset failed \(400\):/);
    expect(describeConfigSaveError(err)).toEqual({
      status: 400,
      locked: false,
      message: 'qa.asr.device=cpu + qa.asr.computeType=float16 is an unsupported pair.',
    });
  });

  it('parses a rejection from the REAL fetch path (realGetConfig-style "fetch" verb)', () => {
    // realGetConfig itself has no describeConfigSaveError consumer today
    // (fetchConfig.rejected renders through the !hydrated branch instead —
    // out of this fix's scope), but it shares configApiErrorMessage with
    // update/reset, so the SAME regex must not be verb-specific to those
    // two only either.
    const err = new Error('Config fetch failed (500): oops');
    expect(describeConfigSaveError(err)).toEqual({
      status: 500,
      locked: false,
      message: 'oops',
    });
  });

  it('falls back to the raw message for an un-wrapped Error', () => {
    expect(describeConfigSaveError(new Error('network error'))).toEqual({
      status: null,
      locked: false,
      message: 'network error',
    });
  });

  it('reads .message off a plain SerializedError-shaped object (RTK .unwrap())', () => {
    const serialized = { name: 'Error', message: wrappedConfigError('update', 400, 'bad value').message };
    expect(describeConfigSaveError(serialized)).toEqual({
      status: 400,
      locked: false,
      message: 'bad value',
    });
  });

  it('falls back to the raw body text when the body is not JSON', () => {
    const err = new Error('Config update failed (500): Internal Server Error');
    expect(describeConfigSaveError(err)).toEqual({
      status: 500,
      locked: false,
      message: 'Internal Server Error',
    });
  });

  /* #2209 review "also fix" — an empty body (`Config update failed (400): `
     with nothing after the colon — e.g. res.text() AND res.statusText both
     empty) used to produce message:'', so the rendered row read
     "Couldn't save:" and nothing after it, turning this fix back into the
     silence it exists to close. */
  it('gives an empty body a real fallback sentence instead of an empty message', () => {
    const err = wrappedConfigError('update', 400, '');
    // wrappedConfigError JSON-encodes {error: ''}; also cover the
    // genuinely-empty-body shape realPutConfig produces when both
    // res.text() and res.statusText are empty.
    expect(describeConfigSaveError(err).message).toBe("The server didn't say why (HTTP 400).");
    expect(describeConfigSaveError(new Error('Config update failed (400): ')).message).toBe(
      "The server didn't say why (HTTP 400).",
    );
  });

  it("gives a totally empty, un-wrapped message a fallback sentence too (no HTTP status to report)", () => {
    expect(describeConfigSaveError(new Error('')).message).toBe("The server didn't say why.");
  });

  /* A non-JSON body can be an entire HTML error page (a 500 from a proxy
     that never reached the JSON route handler) — rendering that verbatim
     inside role="alert", uncapped, is its own defect. */
  it('caps an oversized, unparseable body instead of rendering it verbatim', () => {
    const hugeBody = `<html><body><pre>${'x'.repeat(2000)}</pre></body></html>`;
    const err = new Error(`Config update failed (500): ${hugeBody}`);
    const { message } = describeConfigSaveError(err);
    expect(message.length).toBeLessThan(hugeBody.length);
    expect(message.length).toBeLessThanOrEqual(501); // 500 chars + the "…" suffix
    expect(message.endsWith('…')).toBe(true);
    expect(message.startsWith('<html>')).toBe(true); // still the real content, just capped
  });

  it('does not truncate a genuine, long-but-reasonable pair-rule message', () => {
    // #2180's real ASR_DEVICE_COMPUTE_TYPE_RULE message (pair-rules.ts) —
    // the longest real message this fix has to render — must survive
    // whole, proving the cap is calibrated past real messages, not just
    // "shorter than a huge one".
    const realMessage =
      'qa.asr.device=cuda + qa.asr.computeType=int16 is an unsupported pair — '
      + 'int16 is not available on a cuda device. '
      + 'Supported compute types here: bfloat16, float16, float32, int8, int8_bfloat16, int8_float16, int8_float32 '
      + '(or the sentinels: sidecar-default, auto, default).';
    expect(realMessage.length).toBeLessThan(500);
    const err = wrappedConfigError('update', 400, realMessage);
    expect(describeConfigSaveError(err).message).toBe(realMessage);
  });
});

/* ─── save-error surfacing (#2209) ───────────────────────────────────────── */

describe('OverrideRow — save-error surfacing (#2209)', () => {
  it('surfaces the server message for a rejected ENUM select save', async () => {
    const descriptor = makeDescriptor({
      key: 'tts.qwen.attnImpl',
      type: 'enum',
      options: ['sdpa', 'flash_attention_2'],
      default: 'sdpa',
    });
    const value = makeValue({ key: 'tts.qwen.attnImpl', effective: 'sdpa', source: 'default' });
    const onChange = vi.fn(() =>
      Promise.reject(
        wrappedConfigError(
          'update',
          400,
          'qa.asr.device=cuda + qa.asr.computeType=int16 is an unsupported pair — see the docs.',
        ),
      ),
    );
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()} />,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flash_attention_2' } });

    expect(
      await screen.findByTestId('knob-save-error-tts.qwen.attnImpl'),
    ).toHaveTextContent('qa.asr.device=cuda + qa.asr.computeType=int16 is an unsupported pair');
  });

  it('surfaces the server message for a rejected STRING commitEdit save', async () => {
    const descriptor = makeDescriptor({ key: 'qa.asr.device', type: 'string', default: 'cpu' });
    const value = makeValue({ key: 'qa.asr.device', effective: 'cpu', source: 'default' });
    const onChange = vi.fn(() =>
      Promise.reject(
        wrappedConfigError(
          'update',
          400,
          'qa.asr.device: does not match the required shape (^(cpu|auto|cuda|cuda:\\d+)$)',
        ),
      ),
    );
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()} />,
    );

    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'cuda1' } });
    fireEvent.blur(input);

    expect(onChange).toHaveBeenCalledWith('cuda1');
    expect(
      await screen.findByTestId('knob-save-error-qa.asr.device'),
    ).toHaveTextContent('qa.asr.device: does not match the required shape');
  });

  it('distinguishes a 409 env-lock rejection from a 400 bad-value rejection', async () => {
    const descriptorEnum = makeDescriptor({
      key: 'tts.qwen.attnImpl',
      type: 'enum',
      options: ['sdpa', 'flash_attention_2'],
      default: 'sdpa',
    });
    const valueEnum = makeValue({ key: 'tts.qwen.attnImpl', effective: 'sdpa', source: 'default' });
    const onChangeLocked = vi.fn(() =>
      Promise.reject(wrappedConfigError('update', 409, 'tts.qwen.attnImpl is set in environment')),
    );
    render(
      <OverrideRow
        descriptor={descriptorEnum}
        value={valueEnum}
        onChange={onChangeLocked}
        onRevert={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flash_attention_2' } });

    const lockedEl = await screen.findByTestId('knob-save-error-tts.qwen.attnImpl');
    expect(lockedEl).toHaveTextContent(/pinned in your environment/i);
    expect(lockedEl).not.toHaveTextContent(/couldn't save/i);
  });

  it('uses "couldn\'t save" wording (not the env-lock wording) for a 400', async () => {
    const descriptor = makeDescriptor({ key: 'qa.asr.device', type: 'string', default: 'cpu' });
    const value = makeValue({ key: 'qa.asr.device', effective: 'cpu', source: 'default' });
    const onChange = vi.fn(() => Promise.reject(wrappedConfigError('update', 400, 'bad value')));
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()} />,
    );
    const input = screen.getByRole('textbox');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.blur(input);

    const el = await screen.findByTestId('knob-save-error-qa.asr.device');
    expect(el).toHaveTextContent(/couldn't save/i);
    expect(el).not.toHaveTextContent(/pinned in your environment/i);
  });

  it('clears a shown error once a subsequent save on the same row succeeds', async () => {
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const value = makeValue({ effective: 10 });
    const onChange = vi.fn(() => Promise.reject(wrappedConfigError('update', 400, 'nope, try again')));
    const { rerender } = render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()} />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);

    expect(await screen.findByTestId('knob-save-error-test_knob')).toHaveTextContent(
      'nope, try again',
    );

    // Simulate the retried save succeeding — value.effective moves to 99,
    // which the row must treat as "this error is stale now" (req 4).
    rerender(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 99, source: 'override', overridden: true })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('knob-save-error-test_knob')).not.toBeInTheDocument(),
    );
  });

  it("keeps each row's error independent when two different rows fail in sequence (req 3)", async () => {
    const descriptorA = makeDescriptor({
      key: 'knob_a',
      label: 'Knob A',
      type: 'string',
      default: 'a',
    });
    const valueA = makeValue({ key: 'knob_a', effective: 'a', source: 'default' });
    const onChangeA = vi.fn(() => Promise.reject(wrappedConfigError('update', 400, 'Knob A is bad')));

    const descriptorB = makeDescriptor({
      key: 'knob_b',
      label: 'Knob B',
      type: 'string',
      default: 'b',
    });
    const valueB = makeValue({ key: 'knob_b', effective: 'b', source: 'default' });
    const onChangeB = vi.fn(() =>
      Promise.reject(wrappedConfigError('update', 409, 'Knob B is set in environment')),
    );

    render(
      <>
        <OverrideRow descriptor={descriptorA} value={valueA} onChange={onChangeA} onRevert={vi.fn()} />
        <OverrideRow descriptor={descriptorB} value={valueB} onChange={onChangeB} onRevert={vi.fn()} />
      </>,
    );

    const inputA = screen.getByRole('textbox', { name: 'Knob A' });
    fireEvent.focus(inputA);
    fireEvent.change(inputA, { target: { value: 'aa' } });
    fireEvent.blur(inputA);
    await screen.findByTestId('knob-save-error-knob_a');

    const inputB = screen.getByRole('textbox', { name: 'Knob B' });
    fireEvent.focus(inputB);
    fireEvent.change(inputB, { target: { value: 'bb' } });
    fireEvent.blur(inputB);
    await screen.findByTestId('knob-save-error-knob_b');

    // Both errors remain visible with their OWN message — row B failing
    // (after row A already failed) must not blank or overwrite row A's.
    expect(screen.getByTestId('knob-save-error-knob_a')).toHaveTextContent('Knob A is bad');
    expect(screen.getByTestId('knob-save-error-knob_b')).toHaveTextContent(
      /pinned in your environment/i,
    );
  });

  /* #2209 follow-up, corrected in review (B1) — Revert (POST
     /api/config/reset) is a config save too: #2180's cross-field
     validation ships on PUT but was missed on reset entirely, so the
     Revert button could re-create the exact bad pair it just cleared on
     the save path, in two clicks. It's attributable to this exact row
     (the Revert button that fired it), so it belongs in the SAME per-row
     error region onChange's rejections use — not a toast.

     What it does NOT do: 409. The reset route has no env-locked check at
     all (that guard lives only in the PUT handler), and a locked row
     never renders a Revert button in the first place — so a 409 here is
     unreachable by construction; the fixture below is a 400 (the pair
     rule), the ONE thing reset can actually reject with, driven against
     the REAL realResetConfig throw site rather than a hand-typed string
     (B1: a hand-typed fixture can only prove the parser matches what the
     test author imagined — the original version of this test asserted a
     409/"pinned in your environment" outcome that the reset path cannot
     produce, and nothing caught it). */
  it('surfaces the server message when Revert (resetKnob) is rejected with a 400 (the only status reset can produce)', async () => {
    const descriptor = makeDescriptor({
      key: 'qa.asr.device',
      type: 'string',
      default: 'cpu',
    });
    const value = makeValue({
      key: 'qa.asr.device',
      effective: 'cuda',
      source: 'override',
      overridden: true,
    });
    const err = await realConfigRejection(
      'reset',
      400,
      'qa.asr.device=cpu + qa.asr.computeType=float16 is an unsupported pair.',
    );
    const onRevert = vi.fn(() => Promise.reject(err));
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={onRevert} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /revert/i }));

    expect(onRevert).toHaveBeenCalledOnce();
    const el = await screen.findByTestId('knob-save-error-qa.asr.device');
    expect(el).toHaveTextContent('qa.asr.device=cpu + qa.asr.computeType=float16 is an unsupported pair.');
    // The wrong half of the original bug: a reset rejection must NEVER
    // read as an env-lock, because it structurally cannot be one.
    expect(el).not.toHaveTextContent(/pinned in your environment/i);
    expect(el).toHaveTextContent(/couldn't save/i);
  });

  it('clears a shown Revert error once value.effective actually moves (a later successful attempt)', async () => {
    const descriptor = makeDescriptor({
      key: 'qa.asr.device',
      type: 'string',
      default: 'cpu',
    });
    const value = makeValue({
      key: 'qa.asr.device',
      effective: 'cuda:9',
      source: 'override',
      overridden: true,
    });
    const onRevert = vi.fn(() =>
      Promise.reject(wrappedConfigError('reset', 400, 'reset blocked: bad combo')),
    );
    const { rerender } = render(
      <OverrideRow descriptor={descriptor} value={value} onChange={vi.fn()} onRevert={onRevert} />,
    );

    fireEvent.click(screen.getByRole('button', { name: /revert/i }));
    expect(await screen.findByTestId('knob-save-error-qa.asr.device')).toHaveTextContent(
      'reset blocked: bad combo',
    );

    // A subsequent successful Revert (or any other resolution of this same
    // key) moves value.effective back to the default — the row must treat
    // that as "this error is stale now" the same way a retried save does.
    rerender(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ key: 'qa.asr.device', effective: 'cpu', source: 'default' })}
        onChange={vi.fn()}
        onRevert={onRevert}
      />,
    );

    await waitFor(() =>
      expect(screen.queryByTestId('knob-save-error-qa.asr.device')).not.toBeInTheDocument(),
    );
  });
});

/* ─── generation-guard races (#2209 review B2 + "also fix") ────────────────
   B2: handleRevertClick had NO generation guard at all — Revert's error
   could clobber a newer save's outcome, and a stale older save could
   clobber Revert's own outcome. Both directions reproduced below.

   "Also fix": commitEdit/commitSimple's OWN saveError guard (as opposed
   to their pre-existing draft-revert guard, which the "does not clobber
   a fresh re-edit…" family already covers) was never actually asserted
   anywhere — removing `if (generationRef.current === myGeneration)` from
   either onSaveErrorChange call site passed the full suite. Pinned below,
   for both control families (commitEdit's number/string draft path and
   commitSimple's enum/boolean/device path). */

describe('OverrideRow — generation-guard races (#2209 review B2)', () => {
  it('a superseded Revert rejection does not clobber a newer, already-succeeded save (direction 1)', async () => {
    const descriptor = makeDescriptor({
      key: 'tts.qwen.attnImpl',
      type: 'enum',
      options: ['sdpa', 'flash_attention_2'],
      default: 'sdpa',
    });
    let rejectRevert: (() => void) | undefined;
    const onRevert = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectRevert = () => reject(wrappedConfigError('reset', 400, 'stale revert error'));
        }),
    );
    const onChange = vi.fn(() => Promise.resolve());
    const { rerender } = render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({
          key: 'tts.qwen.attnImpl',
          effective: 'sdpa',
          source: 'override',
          overridden: true,
        })}
        onChange={onChange}
        onRevert={onRevert}
      />,
    );

    // Click Revert — pending, not yet resolved.
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));
    expect(onRevert).toHaveBeenCalledOnce();

    // Before Revert resolves, change the dropdown — a newer, independent
    // attempt on the same row.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flash_attention_2' } });
    expect(onChange).toHaveBeenCalledWith('flash_attention_2');

    // That save succeeds — simulated, as sibling tests in this file do,
    // via a rerender carrying the new value.effective (what a real redux
    // update would produce).
    rerender(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({
          key: 'tts.qwen.attnImpl',
          effective: 'flash_attention_2',
          source: 'override',
          overridden: true,
        })}
        onChange={onChange}
        onRevert={onRevert}
      />,
    );

    // NOW the stale Revert rejects.
    await act(async () => {
      rejectRevert?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('knob-save-error-tts.qwen.attnImpl')).not.toBeInTheDocument();
  });

  it('an older, superseded save rejection does not clobber a newer Revert rejection (direction 2)', async () => {
    const descriptor = makeDescriptor({
      key: 'tts.qwen.attnImpl',
      type: 'enum',
      options: ['sdpa', 'flash_attention_2'],
      default: 'sdpa',
    });
    let rejectSave: (() => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectSave = () => reject(wrappedConfigError('update', 400, 'stale save error'));
        }),
    );
    const onRevert = vi.fn(() =>
      Promise.reject(wrappedConfigError('reset', 400, 'revert error — the one that should win')),
    );
    render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({
          key: 'tts.qwen.attnImpl',
          effective: 'sdpa',
          source: 'override',
          overridden: true,
        })}
        onChange={onChange}
        onRevert={onRevert}
      />,
    );

    // Change the dropdown — save in flight, not yet resolved.
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'flash_attention_2' } });
    expect(onChange).toHaveBeenCalledOnce();

    // Click Revert before the save resolves — a newer attempt on the same
    // row; its own (non-deferred) rejection lands first.
    fireEvent.click(screen.getByRole('button', { name: /revert/i }));
    expect(onRevert).toHaveBeenCalledOnce();

    const el = await screen.findByTestId('knob-save-error-tts.qwen.attnImpl');
    expect(el).toHaveTextContent('revert error — the one that should win');

    // NOW the older, superseded save rejects late.
    await act(async () => {
      rejectSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    // Must still show Revert's message — the older save's stale rejection
    // must not have clobbered it.
    expect(screen.getByTestId('knob-save-error-tts.qwen.attnImpl')).toHaveTextContent(
      'revert error — the one that should win',
    );
  });
});

describe('OverrideRow — save-path generation guard is real, not a placebo (#2209 review "also fix")', () => {
  it('commitEdit (number/string path): a stale rejection does not clobber a row already moved on', async () => {
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    let rejectFirstSave: (() => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstSave = () => reject(wrappedConfigError('update', 400, 'stale commitEdit error'));
        }),
    );
    const { rerender } = render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 10 })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton') as HTMLInputElement;

    act(() => input.focus());
    fireEvent.change(input, { target: { value: '99' } });
    act(() => input.blur());
    expect(onChange).toHaveBeenCalledTimes(1);

    // The value moves on externally (e.g. a Revert, or another tab's
    // edit) while this save is still pending.
    rerender(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 42, source: 'override', overridden: true })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );

    await act(async () => {
      rejectFirstSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('knob-save-error-test_knob')).not.toBeInTheDocument();
  });

  it('commitSimple (enum/boolean/device path): a stale rejection does not clobber a row already moved on', async () => {
    const descriptor = makeDescriptor({
      type: 'enum',
      options: ['a', 'b', 'c'],
      default: 'a',
    });
    let rejectFirstSave: (() => void) | undefined;
    const onChange = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectFirstSave = () => reject(wrappedConfigError('update', 400, 'stale commitSimple error'));
        }),
    );
    const { rerender } = render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 'a', source: 'default' })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'b' } });
    expect(onChange).toHaveBeenCalledOnce();

    // Externally, the field moves on to a THIRD value (e.g. a Revert
    // landed, or another tab edited it) while this save is still pending.
    rerender(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 'c', source: 'override', overridden: true })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );

    await act(async () => {
      rejectFirstSave?.();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByTestId('knob-save-error-test_knob')).not.toBeInTheDocument();
  });
});

/* ─── accessibility (#2209 review "also fix") ────────────────────────────── */

describe('OverrideRow — save-error accessibility (#2209 review "also fix")', () => {
  it('associates the control with the error via aria-describedby + aria-invalid, and the error region is role="alert"', async () => {
    const descriptor = makeDescriptor({ type: 'string', key: 'qa.asr.device', default: 'cpu' });
    const value = makeValue({ key: 'qa.asr.device', effective: 'cpu', source: 'default' });
    const onChange = vi.fn(() => Promise.reject(wrappedConfigError('update', 400, 'bad value')));
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()} />,
    );

    const input = screen.getByRole('textbox');
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');

    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: 'nope' } });
    fireEvent.blur(input);

    // role="alert" — asserted via getByRole, not just data-testid: a test
    // that only ever queries by testid can't tell role="alert" apart from
    // no role at all, which is exactly how the review found it untested.
    const alertEl = await screen.findByRole('alert');
    expect(alertEl).toHaveTextContent('bad value');
    expect(alertEl).toHaveAttribute('id', 'knob-save-error-qa.asr.device');

    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(input).toHaveAttribute('aria-describedby', 'knob-save-error-qa.asr.device');
  });

  it('clears aria-invalid/aria-describedby once the error clears', async () => {
    const descriptor = makeDescriptor({ type: 'number', min: 0, max: 100, step: 1 });
    const onChange = vi.fn(() => Promise.reject(wrappedConfigError('update', 400, 'nope')));
    const { rerender } = render(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 10 })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );
    const input = screen.getByRole('spinbutton');
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: '99' } });
    fireEvent.blur(input);
    await screen.findByRole('alert');
    expect(input).toHaveAttribute('aria-invalid', 'true');

    rerender(
      <OverrideRow
        descriptor={descriptor}
        value={makeValue({ effective: 99, source: 'override', overridden: true })}
        onChange={onChange}
        onRevert={vi.fn()}
      />,
    );

    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(input).not.toHaveAttribute('aria-invalid');
    expect(input).not.toHaveAttribute('aria-describedby');
  });

  it('associates a boolean Checkbox control with the error the same way', async () => {
    const descriptor = makeDescriptor({ type: 'boolean', key: 'qa.asr.enabled', default: false });
    const value = makeValue({ key: 'qa.asr.enabled', effective: false, source: 'default' });
    const onChange = vi.fn(() =>
      Promise.reject(wrappedConfigError('update', 400, 'boolean save rejected')),
    );
    render(
      <OverrideRow descriptor={descriptor} value={value} onChange={onChange} onRevert={vi.fn()} />,
    );
    fireEvent.click(screen.getByRole('checkbox'));
    await screen.findByRole('alert');
    expect(screen.getByRole('checkbox')).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('checkbox')).toHaveAttribute(
      'aria-describedby',
      'knob-save-error-qa.asr.enabled',
    );
  });
});
