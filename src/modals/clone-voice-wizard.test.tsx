import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

const { cloneVoiceApi, sampleLibraryVoiceApi } = vi.hoisted(() => ({
  cloneVoiceApi: vi.fn(),
  sampleLibraryVoiceApi: vi.fn(),
}));
vi.mock('../lib/api', () => ({
  api: {
    cloneVoice: cloneVoiceApi,
    listVoiceLibrary: vi.fn().mockResolvedValue({ voices: [] }),
    sampleLibraryVoice: sampleLibraryVoiceApi,
  },
}));

// Fake phase-1 panel: buttons that fire onReady with a fixed candidate — one
// family-with-permission consent (no attester, #1836's existing coverage),
// one guardian-of-minor consent WITH attestedBy (#1943's new coverage).
vi.mock('../components/voices/clone-capture-panel', () => ({
  CloneCapturePanel: ({
    onReady,
  }: {
    onReady: (r: { candidateId: string; transcript: string; consent: unknown }) => void;
  }) => (
    <>
      <button
        data-testid="fake-continue"
        onClick={() =>
          onReady({
            candidateId: 'cand-1',
            transcript: 'the corrected transcript',
            consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
          })
        }
      >
        continue
      </button>
      <button
        data-testid="fake-continue-guardian"
        onClick={() =>
          onReady({
            candidateId: 'cand-1',
            transcript: 'the corrected transcript',
            consent: {
              personName: 'Ana',
              relationship: 'guardian-of-minor',
              permittedUse: 'personal',
              attestedBy: 'Dana',
            },
          })
        }
      >
        continue as guardian
      </button>
    </>
  ),
}));

vi.mock('../lib/use-sample-playback', () => ({
  useSamplePlayback: () => ({ isPlaying: false, currentUrl: null, play: vi.fn(), stop: vi.fn() }),
}));

import { voiceLibrarySlice } from '../store/voice-library-slice';
import { uiSlice } from '../store/ui-slice';
import { CloneVoiceWizard } from './clone-voice-wizard';
import type { TtsModelKey } from '../lib/types';

function renderWizard(onClose = vi.fn(), ttsModelKey?: TtsModelKey) {
  const store = configureStore({
    reducer: { voiceLibrary: voiceLibrarySlice.reducer, ui: uiSlice.reducer },
    preloadedState: {
      ui: ttsModelKey ? { ...uiSlice.getInitialState(), ttsModelKey } : uiSlice.getInitialState(),
    },
  });
  render(
    <Provider store={store}>
      <CloneVoiceWizard onClose={onClose} />
    </Provider>,
  );
  return { onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  sampleLibraryVoiceApi.mockResolvedValue({ url: 'blob:preview' });
});

describe('CloneVoiceWizard', () => {
  it('advances from phase 1 (onReady) to phase 2', () => {
    renderWizard();
    expect(screen.queryByTestId('clone-voice-wizard-name')).toBeNull();
    fireEvent.click(screen.getByTestId('fake-continue'));
    expect(screen.getByTestId('clone-voice-wizard-name')).toBeInTheDocument();
  });

  /* #2898 — the language hint must appear before a clip is captured, and be
     gone (superseded by phase 2's name/save UI) once the user has moved on. */
  it('shows the language hint during capture, not once phase 2 starts', () => {
    renderWizard();
    expect(screen.getByTestId('clone-voice-wizard-language-hint')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('fake-continue'));
    expect(screen.queryByTestId('clone-voice-wizard-language-hint')).toBeNull();
  });

  it('Save dispatches cloneVoice with the candidateId + consent and renders the fidelity warning', async () => {
    cloneVoiceApi.mockResolvedValue({
      voiceUuid: 'lib-clone-x', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      engines: { qwen: { status: 'ready', baseModel: 'q' } },
      sampleMeta: { qualityChecks: { cloneFidelityWarning: 'This clone sounds only loosely like the sample.' } },
      createdAt: 'a', updatedAt: 'b',
    });
    renderWizard();
    fireEvent.click(screen.getByTestId('fake-continue'));
    fireEvent.change(screen.getByTestId('clone-voice-wizard-name'), { target: { value: 'My Mum' } });
    fireEvent.click(screen.getByTestId('clone-voice-wizard-save'));
    await waitFor(() => expect(cloneVoiceApi).toHaveBeenCalledTimes(1));
    expect(cloneVoiceApi.mock.calls[0][0]).toMatchObject({
      candidateId: 'cand-1',
      name: 'My Mum',
      /* #1836 — pins the wizard's link of the panel → wizard → API chain.
         Without this the `transcript` hop could be deleted and every other
         test would stay green, silently restoring the original bug. */
      transcript: 'the corrected transcript',
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
    });
    expect(await screen.findByTestId('clone-voice-wizard-fidelity-warning')).toBeInTheDocument();
  });

  /* #1943 — the wizard must forward a guardian's attestedBy through to the
     API verbatim, not drop it on the way from the panel's onReady payload. */
  it('Save dispatches cloneVoice carrying a guardian consent.attestedBy distinct from personName', async () => {
    cloneVoiceApi.mockResolvedValue({
      voiceUuid: 'lib-clone-y', name: 'Ana', provenance: 'cloned', tags: [], pinned: false,
      engines: { qwen: { status: 'ready', baseModel: 'q' } },
      createdAt: 'a', updatedAt: 'b',
    });
    renderWizard();
    fireEvent.click(screen.getByTestId('fake-continue-guardian'));
    fireEvent.change(screen.getByTestId('clone-voice-wizard-name'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByTestId('clone-voice-wizard-save'));
    await waitFor(() => expect(cloneVoiceApi).toHaveBeenCalledTimes(1));
    expect(cloneVoiceApi.mock.calls[0][0]).toMatchObject({
      consent: { personName: 'Ana', relationship: 'guardian-of-minor', attestedBy: 'Dana', permittedUse: 'personal' },
    });
  });

  /* Finding 2 (#1842 review) — the post-save preview shares the `qwen-<uuid>`
     scope with the My-voices card's Play button, which already auditions at
     the session tier. Without threading modelKey here, a 1.7B session would
     save a clone at this wizard's default (0.6B) and hear it differently one
     click later on the card — the exact divergence #1842 exists to remove. */
  it('post-save preview calls api.sampleLibraryVoice with the session Qwen tier', async () => {
    cloneVoiceApi.mockResolvedValue({
      voiceUuid: 'lib-clone-x', name: 'Mum', provenance: 'cloned', tags: [], pinned: false,
      engines: { qwen: { status: 'ready', baseModel: 'q' } },
      createdAt: 'a', updatedAt: 'b',
    });
    renderWizard(vi.fn(), 'qwen3-tts-1.7b');
    fireEvent.click(screen.getByTestId('fake-continue'));
    fireEvent.change(screen.getByTestId('clone-voice-wizard-name'), { target: { value: 'My Mum' } });
    fireEvent.click(screen.getByTestId('clone-voice-wizard-save'));
    await waitFor(() =>
      expect(sampleLibraryVoiceApi).toHaveBeenCalledWith('lib-clone-x', { modelKey: 'qwen3-tts-1.7b' }),
    );
  });
});
