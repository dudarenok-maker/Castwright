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
});
