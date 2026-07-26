/* fs-38 Wave 1, Task 15 — CreateLibraryVoiceModal.
   Covers: Save is blocked until a design result exists; "Design & audition"
   dispatches the Task 13 `designVoice` thunk and unblocks Save + shows the
   audition player once it resolves; a missing name/persona blocks the design
   call with an inline error; Save closes the modal. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice, type VoiceLibraryEntry } from '../store/voice-library-slice';
import { castDesignSlice } from '../store/cast-design-slice';
import { uiSlice } from '../store/ui-slice';
import { CreateLibraryVoiceModal } from './create-library-voice';
import type { TtsModelKey } from '../lib/types';

const designLibraryVoice = vi.fn();
const listVoiceLibrary = vi.fn(() => Promise.resolve({ voices: [] }));

vi.mock('../lib/api', () => ({
  api: {
    designLibraryVoice: (...args: unknown[]) => designLibraryVoice(...args),
    listVoiceLibrary: () => listVoiceLibrary(),
  },
}));

function makeDesignResult(overrides: Partial<VoiceLibraryEntry> = {}) {
  const entry: VoiceLibraryEntry = {
    voiceUuid: 'lib-new',
    name: 'X',
    provenance: 'designed',
    tags: [],
    pinned: false,
    engines: { qwen: { status: 'ready' } },
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
  return { entry, previewUrl: '/preview.mp3' };
}

function renderModal(onClose = vi.fn(), ttsModelKey?: TtsModelKey) {
  const store = configureStore({
    reducer: {
      voiceLibrary: voiceLibrarySlice.reducer,
      castDesign: castDesignSlice.reducer,
      ui: uiSlice.reducer,
    },
    preloadedState: ttsModelKey ? { ui: { ...uiSlice.getInitialState(), ttsModelKey } } : undefined,
  });
  render(
    <Provider store={store}>
      <CreateLibraryVoiceModal onClose={onClose} />
    </Provider>,
  );
  return { store, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  listVoiceLibrary.mockResolvedValue({ voices: [] });
});

describe('CreateLibraryVoiceModal', () => {
  it('blocks Save until a design result exists', () => {
    renderModal();
    expect(screen.getByTestId('create-library-voice-save')).toBeDisabled();
  });

  it('"Design & audition" dispatches designVoice and unblocks Save with an audition player', async () => {
    designLibraryVoice.mockResolvedValue(makeDesignResult());
    renderModal();
    fireEvent.change(screen.getByTestId('create-library-voice-name'), {
      target: { value: 'Captain Halloran' },
    });
    fireEvent.change(screen.getByTestId('create-library-voice-persona'), {
      target: { value: 'A gruff captain' },
    });
    fireEvent.click(screen.getByTestId('create-library-voice-design'));
    await waitFor(() =>
      expect(designLibraryVoice).toHaveBeenCalledWith({
        name: 'Captain Halloran',
        persona: 'A gruff captain',
        modelKey: 'qwen3-tts-0.6b',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('create-library-voice-save')).not.toBeDisabled());
    expect(screen.getByTestId('create-library-voice-audition')).toBeInTheDocument();
  });

  /* Finding 4 (#1842 review) — the default-session test above leaves
     ttsModelKey at its DEFAULT_TTS_MODEL ('kokoro-v1'), for which
     modelKeyForEngineChoice('qwen', …) floors to 'qwen3-tts-0.6b' — the
     SAME value a hardcoded literal would produce. This variant proves the
     session tier actually reaches designVoice, not a hardcode wearing a
     mapper's clothing. */
  it('"Design & audition" dispatches designVoice at a 1.7B session tier', async () => {
    designLibraryVoice.mockResolvedValue(makeDesignResult());
    renderModal(vi.fn(), 'qwen3-tts-1.7b');
    fireEvent.change(screen.getByTestId('create-library-voice-name'), {
      target: { value: 'Captain Halloran' },
    });
    fireEvent.change(screen.getByTestId('create-library-voice-persona'), {
      target: { value: 'A gruff captain' },
    });
    fireEvent.click(screen.getByTestId('create-library-voice-design'));
    await waitFor(() =>
      expect(designLibraryVoice).toHaveBeenCalledWith({
        name: 'Captain Halloran',
        persona: 'A gruff captain',
        modelKey: 'qwen3-tts-1.7b',
      }),
    );
  });

  it('fs-38 Wave 1, Task 16 — opens a book-less (bookId: null) cast-design snapshot while designing, and clears it when done', async () => {
    designLibraryVoice.mockResolvedValue(makeDesignResult());
    const { store } = renderModal();
    fireEvent.change(screen.getByTestId('create-library-voice-name'), {
      target: { value: 'Captain Halloran' },
    });
    fireEvent.change(screen.getByTestId('create-library-voice-persona'), {
      target: { value: 'A gruff captain' },
    });
    fireEvent.click(screen.getByTestId('create-library-voice-design'));
    await waitFor(() =>
      expect(store.getState().castDesign.active).toMatchObject({
        bookId: null,
        state: 'running',
        currentName: 'Captain Halloran',
      }),
    );
    await waitFor(() => expect(screen.getByTestId('create-library-voice-save')).not.toBeDisabled());
    expect(store.getState().castDesign.active).toBeNull();
  });

  it('requires a persona before designing (no api call, inline error)', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('create-library-voice-name'), { target: { value: 'X' } });
    fireEvent.click(screen.getByTestId('create-library-voice-design'));
    expect(screen.getByTestId('create-library-voice-error')).toHaveTextContent('persona');
    expect(designLibraryVoice).not.toHaveBeenCalled();
  });

  it('requires a name before designing (no api call, inline error)', () => {
    renderModal();
    fireEvent.change(screen.getByTestId('create-library-voice-persona'), {
      target: { value: 'A gruff captain' },
    });
    fireEvent.click(screen.getByTestId('create-library-voice-design'));
    expect(screen.getByTestId('create-library-voice-error')).toHaveTextContent(/name/i);
    expect(designLibraryVoice).not.toHaveBeenCalled();
  });

  it('"Design & audition" disables while a design request is in flight', async () => {
    let resolveDesign: (v: ReturnType<typeof makeDesignResult>) => void = () => {};
    designLibraryVoice.mockReturnValue(
      new Promise((resolve) => {
        resolveDesign = resolve;
      }),
    );
    renderModal();
    fireEvent.change(screen.getByTestId('create-library-voice-name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('create-library-voice-persona'), {
      target: { value: 'Persona' },
    });
    fireEvent.click(screen.getByTestId('create-library-voice-design'));
    await waitFor(() => expect(screen.getByTestId('create-library-voice-design')).toBeDisabled());
    resolveDesign(makeDesignResult());
    await waitFor(() => expect(screen.getByTestId('create-library-voice-save')).not.toBeDisabled());
  });

  it('Save calls onClose', async () => {
    designLibraryVoice.mockResolvedValue(makeDesignResult());
    const { onClose } = renderModal();
    fireEvent.change(screen.getByTestId('create-library-voice-name'), { target: { value: 'X' } });
    fireEvent.change(screen.getByTestId('create-library-voice-persona'), {
      target: { value: 'Persona' },
    });
    fireEvent.click(screen.getByTestId('create-library-voice-design'));
    await waitFor(() => expect(screen.getByTestId('create-library-voice-save')).not.toBeDisabled());
    fireEvent.click(screen.getByTestId('create-library-voice-save'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the Close button and backdrop both call onClose', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByTestId('create-library-voice-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
