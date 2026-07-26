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

// Fake phase-1 panel: a single button that fires onReady with a fixed candidate.
vi.mock('../components/voices/clone-capture-panel', () => ({
  CloneCapturePanel: ({ onReady }: { onReady: (r: { candidateId: string; consent: unknown }) => void }) => (
    <button
      data-testid="fake-continue"
      onClick={() =>
        onReady({
          candidateId: 'cand-1',
          consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
        })
      }
    >
      continue
    </button>
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
      consent: { personName: 'Mum', relationship: 'family-with-permission', permittedUse: 'personal' },
    });
    expect(await screen.findByTestId('clone-voice-wizard-fidelity-warning')).toBeInTheDocument();
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
