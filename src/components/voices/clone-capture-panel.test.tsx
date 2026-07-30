import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice } from '../../store/voice-library-slice';
import { MAX_CLONE_TRANSCRIPT_CHARS } from '../../lib/clone-transcript-limit';
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

    /* Derived from the constant, not from a literal: a literal would keep
       passing if the panel's cap drifted away from the contract's. */
    const atCap = 'x'.repeat(MAX_CLONE_TRANSCRIPT_CHARS);
    const overCap = 'x'.repeat(MAX_CLONE_TRANSCRIPT_CHARS + 1);

    // Over the cap → blocked, with the reason on screen rather than a silent cut.
    fireEvent.change(screen.getByLabelText('transcript'), { target: { value: overCap } });
    await waitFor(() => expect(cont()).toBeDisabled());
    expect(screen.getByText(/too long/i)).toBeInTheDocument();
    fireEvent.click(cont());
    expect(onReady).not.toHaveBeenCalled();

    // Trimming to the cap unblocks it, with the full text preserved.
    fireEvent.change(screen.getByLabelText('transcript'), { target: { value: atCap } });
    await waitFor(() => expect(cont()).toBeEnabled());
    fireEvent.click(cont());
    expect(onReady).toHaveBeenCalledWith(expect.objectContaining({ transcript: atCap }));
  });

  /* #1808 — the checkbox's accessible name is the short "I attest"
     aria-label; the full attestation sentence lives in a sibling <span> that
     must be programmatically associated via aria-describedby, not left as a
     visual-only neighbor a screen reader skips. */
  it('associates the attest checkbox with the full attestation sentence via aria-describedby', () => {
    render(wrap(<CloneCapturePanel onReady={vi.fn()} />));
    const checkbox = screen.getByLabelText(/i attest/i);
    const describedById = checkbox.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const sentence = document.getElementById(describedById!);
    expect(sentence).toHaveTextContent(
      'I attest I have this person’s permission to clone their voice.',
    );
  });

  /* #1943 — the sentence is relationship-aware, so pin the arm nothing else
     covers. 'self' is pinned by the aria-describedby test above (it renders
     the default) and 'guardian-of-minor' by the wording test below; without
     this, family-with-permission — the arm where a RELATIVE rather than the
     subject is attesting — is the one nothing asserts. */
  it('keeps the permission wording for family-with-permission', () => {
    render(wrap(<CloneCapturePanel onReady={vi.fn()} />));
    fireEvent.change(screen.getByLabelText(/relationship/i), {
      target: { value: 'family-with-permission' },
    });
    const checkbox = screen.getByLabelText(/i attest/i);
    const sentence = document.getElementById(checkbox.getAttribute('aria-describedby')!);
    expect(sentence).toHaveTextContent(
      'I attest I have this person’s permission to clone their voice.',
    );
  });

  /* #1943 — the real attester (e.g. a guardian) is not necessarily the
     person whose voice this is. The field only appears for the two
     relationships where that can differ; asking someone to type their own
     name twice for 'self' is noise. */
  it('shows the attester field only for non-self relationships, and omits it for self', async () => {
    render(wrap(<CloneCapturePanel onReady={vi.fn()} />));
    expect(screen.queryByLabelText(/attester name/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/relationship/i), {
      target: { value: 'family-with-permission' },
    });
    expect(screen.getByLabelText(/attester name/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/relationship/i), { target: { value: 'guardian-of-minor' } });
    expect(screen.getByLabelText(/attester name/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText(/relationship/i), { target: { value: 'self' } });
    expect(screen.queryByLabelText(/attester name/i)).not.toBeInTheDocument();
  });

  it('requires the attester name before Continue for guardian-of-minor, and forwards it', async () => {
    const onReady = vi.fn();
    render(wrap(<CloneCapturePanel onReady={onReady} />));
    const cont = () => screen.getByRole('button', { name: /continue/i });

    const file = new File([new Uint8Array([1, 2, 3])], 's.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('transcript')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/person/i), { target: { value: 'Ana' } });
    fireEvent.change(screen.getByLabelText(/relationship/i), { target: { value: 'guardian-of-minor' } });
    fireEvent.click(screen.getByLabelText(/i attest/i));

    // Still gated — attester name not filled in yet.
    expect(cont()).toBeDisabled();

    fireEvent.change(screen.getByLabelText(/attester name/i), { target: { value: 'Dana' } });
    await waitFor(() => expect(cont()).toBeEnabled());

    fireEvent.click(cont());
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({
        consent: expect.objectContaining({
          personName: 'Ana',
          relationship: 'guardian-of-minor',
          attestedBy: 'Dana',
        }),
      }),
    );
  });

  it('does not require or send an attester for self', async () => {
    const onReady = vi.fn();
    render(wrap(<CloneCapturePanel onReady={onReady} />));

    const file = new File([new Uint8Array([1, 2, 3])], 's.wav', { type: 'audio/wav' });
    fireEvent.change(screen.getByLabelText(/upload/i), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('transcript')).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(/person/i), { target: { value: 'Mum' } });
    fireEvent.click(screen.getByLabelText(/i attest/i));
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).toBeEnabled());

    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
    expect(onReady).toHaveBeenCalledWith(
      expect.objectContaining({
        consent: { personName: 'Mum', relationship: 'self', permittedUse: 'personal' },
      }),
    );
  });

  it('shows the guardian-specific attestation sentence for guardian-of-minor', () => {
    render(wrap(<CloneCapturePanel onReady={vi.fn()} />));
    fireEvent.change(screen.getByLabelText(/relationship/i), { target: { value: 'guardian-of-minor' } });
    const checkbox = screen.getByLabelText(/i attest/i);
    const describedById = checkbox.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const sentence = document.getElementById(describedById!);
    expect(sentence).toHaveTextContent(
      'I attest, as this child’s guardian, that I consent to cloning their voice.',
    );
  });
});
