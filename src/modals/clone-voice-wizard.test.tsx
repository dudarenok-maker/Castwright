import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { configureStore } from '@reduxjs/toolkit';

const { cloneVoiceApi } = vi.hoisted(() => ({ cloneVoiceApi: vi.fn() }));
vi.mock('../lib/api', () => ({
  api: {
    cloneVoice: cloneVoiceApi,
    listVoiceLibrary: vi.fn().mockResolvedValue({ voices: [] }),
    sampleLibraryVoice: vi.fn().mockResolvedValue({ url: 'blob:preview' }),
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
import { CloneVoiceWizard } from './clone-voice-wizard';

function renderWizard(onClose = vi.fn()) {
  const store = configureStore({ reducer: { voiceLibrary: voiceLibrarySlice.reducer } });
  render(
    <Provider store={store}>
      <CloneVoiceWizard onClose={onClose} />
    </Provider>,
  );
  return { onClose };
}

beforeEach(() => vi.clearAllMocks());

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
});
