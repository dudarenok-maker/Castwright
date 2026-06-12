// Pairs with docs/features/archive/64-voice-preview-while-editing.md

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { VoicePreviewButton } from './voice-preview-button';
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

const asyaCoqui: BaseVoice = { engine: 'coqui', name: 'Asya Anara' };
const damienCoqui: BaseVoice = { engine: 'coqui', name: 'Damien Black' };

describe('VoicePreviewButton', () => {
  beforeEach(() => {
    vi.mocked(playBaseVoiceSampleWithAutoLoad).mockClear();
    vi.mocked(playBaseVoiceSampleWithAutoLoad).mockResolvedValue({ analyzerEvicted: false });
  });

  it('routes click through playBaseVoiceSampleWithAutoLoad with the candidate voice + text', async () => {
    render(<VoicePreviewButton voice={asyaCoqui} modelKey="kokoro-v1" text="Hello world." />);
    fireEvent.click(screen.getByRole('button', { name: /Play sample for Asya Anara/i }));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    const call = vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[0][0];
    expect(call.args).toEqual({
      engine: 'coqui',
      speakerName: 'Asya Anara',
      modelKey: 'kokoro-v1',
      text: 'Hello world.',
    });
  });

  it('forwards the sample text the parent passes (re-renders pick up text edits)', async () => {
    const { rerender } = render(
      <VoicePreviewButton voice={asyaCoqui} modelKey="kokoro-v1" text="First line." />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play sample for Asya Anara/i }));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[0][0].args.text).toBe(
      'First line.',
    );

    /* Parent updates the sample text — next click sends the new value. */
    rerender(<VoicePreviewButton voice={asyaCoqui} modelKey="kokoro-v1" text="Second line." />);
    fireEvent.click(screen.getByRole('button', { name: /Play sample for Asya Anara/i }));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(2));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[1][0].args.text).toBe(
      'Second line.',
    );
  });

  it('two preview buttons against different candidates each invoke their own voice', async () => {
    /* Auditioning A then B is the core use case from the BACKLOG spec.
       Both buttons share the singleton playback hook, so the second click
       implicitly cancels the first via use-sample-playback's src-swap
       drain. This test pins that the args are passed straight through:
       no shared state leaks between rows. */
    const { rerender } = render(
      <>
        <VoicePreviewButton voice={asyaCoqui} modelKey="kokoro-v1" text="Hello." />
        <VoicePreviewButton voice={damienCoqui} modelKey="kokoro-v1" text="Hello." />
      </>,
    );
    fireEvent.click(screen.getByRole('button', { name: /Play sample for Asya Anara/i }));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(1));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[0][0].args.speakerName).toBe(
      'Asya Anara',
    );

    fireEvent.click(screen.getByRole('button', { name: /Play sample for Damien Black/i }));
    await waitFor(() => expect(playBaseVoiceSampleWithAutoLoad).toHaveBeenCalledTimes(2));
    expect(vi.mocked(playBaseVoiceSampleWithAutoLoad).mock.calls[1][0].args.speakerName).toBe(
      'Damien Black',
    );

    /* Sanity rerender for completeness — preview state is local so a
       parent rerender shouldn't drop button reachability. */
    rerender(
      <>
        <VoicePreviewButton voice={asyaCoqui} modelKey="kokoro-v1" text="Hello." />
        <VoicePreviewButton voice={damienCoqui} modelKey="kokoro-v1" text="Hello." />
      </>,
    );
    expect(screen.getByRole('button', { name: /Play sample for Asya Anara/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /Play sample for Damien Black/i })).toBeTruthy();
  });

  it('renders the helper error inline when the auto-load helper rejects', async () => {
    vi.mocked(playBaseVoiceSampleWithAutoLoad).mockRejectedValueOnce(
      new Error('Voice engine (:9000) is unreachable — restart it via scripts/start-app.ps1.'),
    );
    render(<VoicePreviewButton voice={asyaCoqui} modelKey="kokoro-v1" text="Hello." />);
    fireEvent.click(screen.getByRole('button', { name: /Play sample for Asya Anara/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/voice engine.*unreachable/i);
  });

  it('passes the optional aria-label override through', () => {
    render(
      <VoicePreviewButton
        voice={asyaCoqui}
        modelKey="kokoro-v1"
        text="Hello."
        ariaLabel="Preview Asya for Captain Halloran"
      />,
    );
    expect(screen.getByRole('button', { name: /Preview Asya for Captain Halloran/i })).toBeTruthy();
  });
});
