import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice } from '../../store/voice-library-slice';
import { CloneCapturePanel } from './clone-capture-panel';

const cloneVoiceSample = vi.fn().mockResolvedValue({ candidateId: 'cand-1', transcript: 'hi there', durationSeconds: 9, sampleRate: 24_000, qualityWarnings: [] });
vi.mock('../../lib/api', () => ({ api: { cloneVoiceSample: (...a: unknown[]) => cloneVoiceSample(...a), listVoiceLibrary: () => Promise.resolve({ voices: [] }) } }));

const wrap = (ui: React.ReactNode) => <Provider store={configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } })}>{ui}</Provider>;
beforeEach(() => vi.clearAllMocks());

describe('CloneCapturePanel', () => {
  it('gates Continue until a sample AND consent are complete', async () => {
    const onReady = vi.fn();
    render(wrap(<CloneCapturePanel onReady={onReady} />));
    const cont = () => screen.getByRole('button', { name: /continue/i });
    expect(cont()).toBeDisabled();

    // upload a file → ingest
    const file = new File([new Uint8Array([1, 2, 3])], 's.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } });
    await waitFor(() => expect(cloneVoiceSample).toHaveBeenCalled());

    // still gated — no consent yet
    expect(cont()).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/person/i), { target: { value: 'Mum' } });
    fireEvent.click(screen.getByLabelText(/i attest/i));
    await waitFor(() => expect(cont()).toBeEnabled());

    fireEvent.click(cont());
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ candidateId: 'cand-1', consent: expect.objectContaining({ personName: 'Mum' }) }));
  });

  /* #1836 — the transcript box is editable, so the edit has to leave the
     panel; otherwise a correction is silently discarded and the clone is
     still distilled against the raw Whisper text. */
  it('forwards the edited transcript, not the raw Whisper text', async () => {
    const onReady = vi.fn();
    render(wrap(<CloneCapturePanel onReady={onReady} />));

    const file = new File([new Uint8Array([1, 2, 3])], 's.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('transcript')).toHaveValue('hi there'));

    fireEvent.change(screen.getByLabelText('transcript'), { target: { value: 'hi, Thea' } });
    fireEvent.change(screen.getByLabelText(/person/i), { target: { value: 'Mum' } });
    fireEvent.click(screen.getByLabelText(/i attest/i));

    const cont = screen.getByRole('button', { name: /continue/i });
    await waitFor(() => expect(cont).toBeEnabled());
    fireEvent.click(cont);

    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ transcript: 'hi, Thea' }));
  });

  /* #1836 — the textarea deliberately carries NO maxLength: the browser would
     silently drop the tail of a long paste, persisting half a correction. The
     cap is enforced by blocking Continue instead, while the field is still
     editable. Pin both halves, or someone re-adds maxLength as an "obvious"
     tidy-up and restores the truncation. */
  it('does not cap the textarea with maxLength', async () => {
    render(wrap(<CloneCapturePanel onReady={vi.fn()} />));
    const file = new File([new Uint8Array([1, 2, 3])], 's.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('transcript')).toBeInTheDocument());
    expect(screen.getByLabelText('transcript')).not.toHaveAttribute('maxlength');
  });

  it('blocks Continue with a visible reason when the transcript exceeds the cap', async () => {
    const onReady = vi.fn();
    render(wrap(<CloneCapturePanel onReady={onReady} />));

    const file = new File([new Uint8Array([1, 2, 3])], 's.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('transcript')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/person/i), { target: { value: 'Mum' } });
    fireEvent.click(screen.getByLabelText(/i attest/i));
    const cont = () => screen.getByRole('button', { name: /continue/i });
    await waitFor(() => expect(cont()).toBeEnabled());

    // Over the cap → blocked, with the reason on screen rather than a silent cut.
    fireEvent.change(screen.getByLabelText('transcript'), { target: { value: 'x'.repeat(2001) } });
    await waitFor(() => expect(cont()).toBeDisabled());
    expect(screen.getByText(/too long/i)).toBeInTheDocument();
    fireEvent.click(cont());
    expect(onReady).not.toHaveBeenCalled();

    // Trimming to the cap unblocks it, with the full text preserved.
    fireEvent.change(screen.getByLabelText('transcript'), { target: { value: 'x'.repeat(2000) } });
    await waitFor(() => expect(cont()).toBeEnabled());
    fireEvent.click(cont());
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ transcript: 'x'.repeat(2000) }));
  });
});
