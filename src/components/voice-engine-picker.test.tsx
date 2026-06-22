/* VoiceEnginePicker — fs-2 hard-lock to Qwen for non-English books. Pins that
   the selector shows Qwen only (disabled) + the explanatory note when locked,
   and the normal multi-engine selector otherwise. */

import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { VoiceEnginePicker } from './voice-engine-picker';
import type { TtsEngine } from '../lib/types';

const baseProps = {
  value: 'qwen' as const,
  onChange: vi.fn(),
  installedEngines: ['kokoro', 'qwen'] as TtsEngine[],
  defaultEngineLabel: 'Kokoro',
  persona: 'a warm narrator',
  onPersonaChange: vi.fn(),
  onRegeneratePersona: vi.fn(),
  personaBusy: false,
  onDesignVoice: vi.fn(),
  designBusy: false,
  designPlaying: false,
  designedVoiceId: null,
  error: null,
};

describe('VoiceEnginePicker — fs-2 lockedToQwen', () => {
  it('locks the selector to Qwen and shows the note when lockedToQwen', () => {
    render(<VoiceEnginePicker {...baseProps} installedEngines={['kokoro', 'qwen']} lockedToQwen />);
    const select = screen.getByLabelText('Voice engine for this character') as HTMLSelectElement;
    expect(select).toBeDisabled();
    expect(select.value).toBe('qwen');
    /* No "Default (…)" / Kokoro option offered when locked. */
    expect(screen.queryByRole('option', { name: /Default/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('option', { name: 'Kokoro' })).not.toBeInTheDocument();
    expect(screen.getByTestId('qwen-locked-note')).toBeInTheDocument();
    /* The design sub-flow is visible (value is qwen). */
    expect(screen.getByTestId('qwen-design-panel')).toBeInTheDocument();
  });

  it('offers the full engine list and no note when not locked', () => {
    render(
      <VoiceEnginePicker
        {...baseProps}
        value="default"
        installedEngines={['kokoro', 'qwen']}
      />,
    );
    const select = screen.getByLabelText('Voice engine for this character') as HTMLSelectElement;
    expect(select).not.toBeDisabled();
    expect(screen.getByRole('option', { name: /Default \(Kokoro\)/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Kokoro' })).toBeInTheDocument();
    expect(screen.queryByTestId('qwen-locked-note')).not.toBeInTheDocument();
  });
});

describe('VoiceEnginePicker — fs-56 1.7B Quality-tier toggle', () => {
  it('shows the 1.7B toggle when Qwen is selected and qwen17bAvailable is true', () => {
    render(
      <VoiceEnginePicker
        {...baseProps}
        value="qwen"
        qwen17bAvailable
        charModelKey={null}
        onCharModelKeyChange={vi.fn()}
      />,
    );
    expect(screen.getByTestId('qwen-1.7b-toggle')).toBeInTheDocument();
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(false);
  });

  it('checks the checkbox when charModelKey is qwen3-tts-1.7b', () => {
    render(
      <VoiceEnginePicker
        {...baseProps}
        value="qwen"
        qwen17bAvailable
        charModelKey="qwen3-tts-1.7b"
        onCharModelKeyChange={vi.fn()}
      />,
    );
    const checkbox = screen.getByRole('checkbox') as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
  });

  it('hides the 1.7B toggle when qwen17bAvailable is false', () => {
    render(
      <VoiceEnginePicker
        {...baseProps}
        value="qwen"
        qwen17bAvailable={false}
        charModelKey={null}
        onCharModelKeyChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('qwen-1.7b-toggle')).not.toBeInTheDocument();
  });

  it('hides the 1.7B toggle when Qwen is not the selected engine', () => {
    render(
      <VoiceEnginePicker
        {...baseProps}
        value="default"
        qwen17bAvailable
        charModelKey={null}
        onCharModelKeyChange={vi.fn()}
      />,
    );
    expect(screen.queryByTestId('qwen-1.7b-toggle')).not.toBeInTheDocument();
  });

  it('calls onCharModelKeyChange(qwen3-tts-1.7b) when toggled on', async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <VoiceEnginePicker
        {...baseProps}
        value="qwen"
        qwen17bAvailable
        charModelKey={null}
        onCharModelKeyChange={onChange}
      />,
    );
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect(onChange).toHaveBeenCalledWith('qwen3-tts-1.7b');
  });

  it('calls onCharModelKeyChange(null) when toggled off', async () => {
    const { userEvent } = await import('@testing-library/user-event');
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <VoiceEnginePicker
        {...baseProps}
        value="qwen"
        qwen17bAvailable
        charModelKey="qwen3-tts-1.7b"
        onCharModelKeyChange={onChange}
      />,
    );
    const checkbox = screen.getByRole('checkbox');
    await user.click(checkbox);
    expect(onChange).toHaveBeenCalledWith(null);
  });
});

describe('VoiceEnginePicker — background design progress', () => {
  it('renders DesignProgress + the "keeps running" note while designBusy', () => {
    render(<VoiceEnginePicker {...baseProps} designBusy designPhase="rendering" />);
    /* Branded progress + honest phase label (rendering). */
    expect(screen.getByTestId('design-waveform')).toBeInTheDocument();
    expect(screen.getByText(/rendering the 12s audition/i)).toBeInTheDocument();
    expect(screen.getByText(/keeps running if you close/i)).toBeInTheDocument();
    /* The design button is the disabled "Designing voice…" affordance. */
    const btn = screen.getByTestId('qwen-design-voice') as HTMLButtonElement;
    expect(btn).toBeDisabled();
    expect(btn).toHaveTextContent(/designing voice/i);
  });

  it('does not click through to onDesignVoice while designBusy (button disabled)', () => {
    const onDesignVoice = vi.fn();
    render(<VoiceEnginePicker {...baseProps} designBusy onDesignVoice={onDesignVoice} />);
    /* No DesignProgress in the idle branch; phase defaults to designing here. */
    expect(screen.getByText(/designing the voice/i)).toBeInTheDocument();
    expect(onDesignVoice).not.toHaveBeenCalled();
  });
});
