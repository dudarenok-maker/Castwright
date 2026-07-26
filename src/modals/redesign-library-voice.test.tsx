/* fs-38 Wave 1, Task 15 — RedesignLibraryVoiceModal.
   Covers the plan-161 A/B compare idiom applied to a library entry:
   "Re-design from persona" dispatches the Task 13 `redesignVoice` thunk and
   unblocks "Keep new"; "Keep new" dispatches `promoteRedesign` and closes;
   "Keep old" dispatches `discardRedesign` (available immediately, no
   redesign required first) and closes; OLD play calls
   `api.sampleLibraryVoice(entry.voiceUuid)`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice, type VoiceLibraryEntry } from '../store/voice-library-slice';
import { uiSlice } from '../store/ui-slice';
import { RedesignLibraryVoiceModal } from './redesign-library-voice';

const sampleLibraryVoice = vi.fn();
const redesignLibraryVoice = vi.fn();
const promoteLibraryRedesign = vi.fn();
const discardLibraryRedesign = vi.fn();
const listVoiceLibrary = vi.fn(() => Promise.resolve({ voices: [] }));

vi.mock('../lib/api', () => ({
  api: {
    sampleLibraryVoice: (...args: unknown[]) => sampleLibraryVoice(...args),
    redesignLibraryVoice: (...args: unknown[]) => redesignLibraryVoice(...args),
    promoteLibraryRedesign: (...args: unknown[]) => promoteLibraryRedesign(...args),
    discardLibraryRedesign: (...args: unknown[]) => discardLibraryRedesign(...args),
    listVoiceLibrary: () => listVoiceLibrary(),
  },
}));

function makeEntry(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: 'lib-1',
    name: 'Captain Halloran',
    provenance: 'designed',
    tags: [],
    pinned: false,
    persona: 'A weathered ship captain.',
    engines: { qwen: { status: 'ready' } },
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

function renderModal(entry: VoiceLibraryEntry = makeEntry(), onClose = vi.fn()) {
  const store = configureStore({
    reducer: { voiceLibrary: voiceLibrarySlice.reducer, ui: uiSlice.reducer },
  });
  render(
    <Provider store={store}>
      <RedesignLibraryVoiceModal entry={entry} onClose={onClose} />
    </Provider>,
  );
  return { store, onClose };
}

beforeEach(() => {
  vi.clearAllMocks();
  listVoiceLibrary.mockResolvedValue({ voices: [] });
});

describe('RedesignLibraryVoiceModal', () => {
  it('seeds the persona textarea from the entry', () => {
    const entry = makeEntry({ persona: 'A gruff, weary sea captain.' });
    renderModal(entry);
    expect(screen.getByTestId('redesign-library-voice-persona')).toHaveValue(
      'A gruff, weary sea captain.',
    );
  });

  it('"Keep new" is disabled until a redesign result exists', () => {
    renderModal();
    expect(screen.getByTestId('redesign-library-voice-keep-new')).toBeDisabled();
  });

  it('"Re-design from persona" dispatches redesignVoice and unblocks Keep new', async () => {
    redesignLibraryVoice.mockResolvedValue({ previewUrl: '/new-preview.mp3' });
    const entry = makeEntry();
    renderModal(entry);
    fireEvent.click(screen.getByTestId('redesign-library-voice-redesign'));
    await waitFor(() =>
      expect(redesignLibraryVoice).toHaveBeenCalledWith(entry.voiceUuid, {
        persona: entry.persona,
        modelKey: 'qwen3-tts-0.6b',
      }),
    );
    await waitFor(() =>
      expect(screen.getByTestId('redesign-library-voice-keep-new')).not.toBeDisabled(),
    );
  });

  it('"Keep new" dispatches promoteRedesign with the edited persona and closes the modal', async () => {
    redesignLibraryVoice.mockResolvedValue({ previewUrl: '/new-preview.mp3' });
    promoteLibraryRedesign.mockResolvedValue(makeEntry());
    const entry = makeEntry();
    const { onClose } = renderModal(entry);
    fireEvent.change(screen.getByTestId('redesign-library-voice-persona'), {
      target: { value: 'A grizzled dockside smuggler.' },
    });
    fireEvent.click(screen.getByTestId('redesign-library-voice-redesign'));
    await waitFor(() =>
      expect(screen.getByTestId('redesign-library-voice-keep-new')).not.toBeDisabled(),
    );
    fireEvent.click(screen.getByTestId('redesign-library-voice-keep-new'));
    await waitFor(() =>
      expect(promoteLibraryRedesign).toHaveBeenCalledWith(entry.voiceUuid, {
        persona: 'A grizzled dockside smuggler.',
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('"Keep old" dispatches discardRedesign and closes the modal (no redesign needed first)', async () => {
    discardLibraryRedesign.mockResolvedValue(makeEntry());
    const entry = makeEntry();
    const { onClose } = renderModal(entry);
    expect(screen.getByTestId('redesign-library-voice-keep-old')).not.toBeDisabled();
    fireEvent.click(screen.getByTestId('redesign-library-voice-keep-old'));
    await waitFor(() => expect(discardLibraryRedesign).toHaveBeenCalledWith(entry.voiceUuid));
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  });

  it('OLD play calls api.sampleLibraryVoice with the entry uuid', async () => {
    sampleLibraryVoice.mockResolvedValue({ url: '/old-sample.mp3' });
    const entry = makeEntry();
    renderModal(entry);
    fireEvent.click(screen.getByTestId('redesign-library-voice-play-old'));
    await waitFor(() => expect(sampleLibraryVoice).toHaveBeenCalledWith(entry.voiceUuid));
  });

  it('NEW play is disabled until a redesign result exists', () => {
    renderModal();
    expect(screen.getByTestId('redesign-library-voice-play-new')).toBeDisabled();
  });
});
