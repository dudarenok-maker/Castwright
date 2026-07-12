/* Smoke coverage for VoiceOverridePicker — the engine-tab strip and
   integration with the Profile Drawer live in
   `src/modals/profile-drawer.test.tsx`. Tests here pin behaviour the
   wrapper owns alone: trigger label, disabled-while-loading, Auto-row
   pick passes null to onChange. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoiceOverridePicker } from './voice-override-picker';
import { playBaseVoiceSampleWithAutoLoad } from '../lib/play-sample-with-auto-load';
import type { BaseVoice } from '../lib/types';

vi.mock('../lib/play-sample-with-auto-load', () => ({
  playBaseVoiceSampleWithAutoLoad: vi.fn().mockResolvedValue({ analyzerEvicted: false }),
}));

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({
    isPlaying: false,
    currentUrl: null,
    play: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
  }),
}));

const baseCatalog: BaseVoice[] = [
  { engine: 'coqui', name: 'Asya Anara' },
  { engine: 'coqui', name: 'Damien Black' },
];

// Vitest 4: vi.fn() is typed Mock<Procedure | Constructable> and no longer
// assigns to a specific function prop — pin onChange's signature via the
// component's own prop type so the mocks stay assignable (self-maintaining).
type OnChange = NonNullable<React.ComponentProps<typeof VoiceOverridePicker>['onChange']>;

function defaultProps(overrides: Partial<React.ComponentProps<typeof VoiceOverridePicker>> = {}) {
  return {
    voiceId: 'v_brann',
    engineTab: 'coqui' as const,
    autoVoiceEngine: 'coqui' as const,
    autoVoiceName: 'Aaron Dreschner',
    voicesForTab: baseCatalog,
    selectedValue: 'auto',
    baseVoicesLoaded: true,
    onChange: vi.fn<OnChange>(),
    previewText: 'Hello, this is a sample.',
    previewModelKey: 'kokoro-v1' as const,
    ...overrides,
  };
}

describe('VoiceOverridePicker', () => {
  let onChange: ReturnType<typeof vi.fn<OnChange>>;
  beforeEach(() => {
    onChange = vi.fn<OnChange>();
    vi.mocked(playBaseVoiceSampleWithAutoLoad).mockClear();
    vi.mocked(playBaseVoiceSampleWithAutoLoad).mockResolvedValue({ analyzerEvicted: false });
  });

  it('shows the Auto resolved-voice label on the trigger when selectedValue is auto', () => {
    render(<VoiceOverridePicker {...defaultProps({ onChange })} />);
    const trigger = screen.getByRole('button', { name: /Model voice override/i });
    expect(trigger).toHaveTextContent(/Auto — currently Coqui · Aaron Dreschner/i);
  });

  it('shows the selected voice name on the trigger when selectedValue is a voice', () => {
    render(
      <VoiceOverridePicker
        {...defaultProps({ onChange, selectedValue: 'coqui|Damien Black' })}
      />,
    );
    expect(screen.getByRole('button', { name: /Model voice override/i })).toHaveTextContent(
      /Damien Black/,
    );
  });

  it('disables the trigger and shows a loading label when the catalog is unloaded', () => {
    render(
      <VoiceOverridePicker {...defaultProps({ onChange, baseVoicesLoaded: false })} />,
    );
    const trigger = screen.getByRole('button', { name: /Model voice override/i });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent(/Loading base voice catalog…/i);
  });

  it('picks Auto and fires onChange(null)', () => {
    render(
      <VoiceOverridePicker
        {...defaultProps({ onChange, selectedValue: 'coqui|Damien Black' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Model voice override/i }));
    fireEvent.click(screen.getByRole('option', { name: /Auto — currently Coqui/i }));
    expect(onChange).toHaveBeenCalledWith(null);
  });

  it('picks a base voice and fires onChange({engine, name})', () => {
    render(<VoiceOverridePicker {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /Model voice override/i }));
    fireEvent.click(screen.getByRole('option', { name: /Asya Anara/ }));
    expect(onChange).toHaveBeenCalledWith({ engine: 'coqui', name: 'Asya Anara' });
  });

  it('shows a per-row Play button on voice rows but not the Auto row', () => {
    render(<VoiceOverridePicker {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /Model voice override/i }));
    expect(screen.getByRole('button', { name: /Play sample for Asya Anara/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play sample for Damien Black/i })).toBeTruthy();
    /* The Auto row's option name starts with "Auto" — assert no Play
       button carries that as its accessible name. */
    expect(
      screen.queryByRole('button', { name: /^Play sample for Auto/i }),
    ).not.toBeInTheDocument();
  });

  it('clicking a row Play button auditions that voice without picking it', async () => {
    render(
      <VoiceOverridePicker
        {...defaultProps({ onChange, previewText: 'Custom sample line.' })}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Model voice override/i }));
    fireEvent.click(screen.getByRole('button', { name: /Play sample for Asya Anara/i }));

    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const call = vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[0][0];
    expect(call.args).toEqual({
      engine: 'coqui',
      speakerName: 'Asya Anara',
      modelKey: 'kokoro-v1',
      text: 'Custom sample line.',
    });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('picking the row (not the Play button) still commits the override', () => {
    render(<VoiceOverridePicker {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /Model voice override/i }));
    fireEvent.click(screen.getByRole('option', { name: /Asya Anara/ }));
    expect(onChange).toHaveBeenCalledWith({ engine: 'coqui', name: 'Asya Anara' });
    expect(playBaseVoiceSampleWithAutoLoad).not.toHaveBeenCalled();
  });

  it('activates the row Play button via keyboard (Enter) without picking the row', async () => {
    /* The ▶ is a focusable span role=button (not a native <button> — that
       would nest a button inside the row's option button). Enter/Space must
       still audition, and must not bubble to pick the row. */
    render(<VoiceOverridePicker {...defaultProps({ onChange })} />);
    fireEvent.click(screen.getByRole('button', { name: /Model voice override/i }));
    fireEvent.keyDown(screen.getByRole('button', { name: /Play sample for Asya Anara/i }), {
      key: 'Enter',
    });
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[0][0].args.speakerName).toBe(
      'Asya Anara',
    );
    expect(onChange).not.toHaveBeenCalled();
  });

  it('uses the attribute-driven label when the tab differs from the auto-resolved engine', () => {
    render(
      <VoiceOverridePicker
        {...defaultProps({
          onChange,
          engineTab: 'kokoro',
          autoVoiceEngine: 'coqui',
          voicesForTab: [],
        })}
      />,
    );
    expect(screen.getByRole('button', { name: /Model voice override/i })).toHaveTextContent(
      /Auto for Kokoro — attribute-driven/i,
    );
  });
});
