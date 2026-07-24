/* fs-38 Wave 1, Task 15 — VoiceLibraryCard.
   Covers engine-readiness chips per `engines.qwen.status` fixture, the
   inline tag editor (add on Enter / remove on ×) and pin toggle dispatching
   the Task 13 `patchEntry` thunk (optimistic — asserted against the store,
   not just the api spy), the "My voice" provenance marker for a designed
   entry, the onAssign/onEdit callback props, and the preview-play button
   calling `api.sampleLibraryVoice`. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { voiceLibrarySlice, type VoiceLibraryEntry } from '../../store/voice-library-slice';
import { VoiceLibraryCard } from './voice-library-card';

const patchVoiceLibrary = vi.fn();
const sampleLibraryVoice = vi.fn();
const listVoiceLibrary = vi.fn(() => Promise.resolve({ voices: [] }));

vi.mock('../../lib/api', () => ({
  api: {
    patchVoiceLibrary: (...args: unknown[]) => patchVoiceLibrary(...args),
    sampleLibraryVoice: (...args: unknown[]) => sampleLibraryVoice(...args),
    listVoiceLibrary: () => listVoiceLibrary(),
  },
}));

function makeEntry(overrides: Partial<VoiceLibraryEntry> = {}): VoiceLibraryEntry {
  return {
    voiceUuid: 'lib-1',
    name: 'Captain Halloran',
    provenance: 'designed',
    tags: ['narrator'],
    pinned: false,
    engines: { qwen: { status: 'ready' } },
    createdAt: '2026-06-01T09:00:00.000Z',
    updatedAt: '2026-06-01T09:00:00.000Z',
    ...overrides,
  };
}

function renderCard(
  entry: VoiceLibraryEntry,
  props: { onAssign?: (e: VoiceLibraryEntry) => void; onEdit?: (e: VoiceLibraryEntry) => void } = {},
) {
  const store = configureStore({
    reducer: { voiceLibrary: voiceLibrarySlice.reducer },
    preloadedState: {
      voiceLibrary: {
        entries: [entry],
        status: 'ready' as const,
        designPending: false,
        lastFetchedAt: Date.now(),
      },
    },
  });
  render(
    <Provider store={store}>
      <VoiceLibraryCard entry={entry} {...props} />
    </Provider>,
  );
  return store;
}

beforeEach(() => {
  vi.clearAllMocks();
  listVoiceLibrary.mockResolvedValue({ voices: [] });
});

describe('VoiceLibraryCard', () => {
  it.each([
    ['ready', 'Qwen ✓'],
    ['stale', 'Qwen ⟳'],
    ['failed', 'Qwen ⚠'],
  ] as const)('renders the %s engine-readiness chip', (status, label) => {
    const entry = makeEntry({ engines: { qwen: { status } } });
    renderCard(entry);
    expect(screen.getByTestId(`voice-library-engine-qwen-${entry.voiceUuid}`)).toHaveTextContent(
      label,
    );
  });

  it('shows the "My voice" provenance marker for a designed entry', () => {
    const entry = makeEntry({ provenance: 'designed' });
    renderCard(entry);
    expect(screen.getByTestId(`voice-library-provenance-${entry.voiceUuid}`)).toHaveTextContent(
      'My voice',
    );
  });

  it('renders the language chip when languageCode is set', () => {
    const entry = makeEntry({ languageCode: 'ru' });
    renderCard(entry);
    expect(screen.getByTestId(`voice-library-language-${entry.voiceUuid}`)).toHaveTextContent('ru');
  });

  it('adding a tag on Enter dispatches patchEntry (optimistic update lands immediately)', async () => {
    patchVoiceLibrary.mockResolvedValue(makeEntry({ tags: ['narrator', 'gruff'] }));
    const entry = makeEntry({ tags: ['narrator'] });
    const store = renderCard(entry);
    const input = screen.getByTestId(`voice-library-tag-input-${entry.voiceUuid}`);
    fireEvent.change(input, { target: { value: 'gruff' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(store.getState().voiceLibrary.entries[0].tags).toEqual(['narrator', 'gruff']);
    await waitFor(() =>
      expect(patchVoiceLibrary).toHaveBeenCalledWith(entry.voiceUuid, {
        tags: ['narrator', 'gruff'],
      }),
    );
  });

  it('removing a tag on × dispatches patchEntry (optimistic update lands immediately)', async () => {
    patchVoiceLibrary.mockResolvedValue(makeEntry({ tags: [] }));
    const entry = makeEntry({ tags: ['narrator'] });
    const store = renderCard(entry);
    fireEvent.click(screen.getByTestId(`voice-library-tag-remove-${entry.voiceUuid}-narrator`));
    expect(store.getState().voiceLibrary.entries[0].tags).toEqual([]);
    await waitFor(() =>
      expect(patchVoiceLibrary).toHaveBeenCalledWith(entry.voiceUuid, { tags: [] }),
    );
  });

  it('pin toggle dispatches patchEntry (optimistic update lands immediately)', async () => {
    patchVoiceLibrary.mockResolvedValue(makeEntry({ pinned: true }));
    const entry = makeEntry({ pinned: false });
    const store = renderCard(entry);
    fireEvent.click(screen.getByTestId(`voice-library-pin-${entry.voiceUuid}`));
    expect(store.getState().voiceLibrary.entries[0].pinned).toBe(true);
    await waitFor(() =>
      expect(patchVoiceLibrary).toHaveBeenCalledWith(entry.voiceUuid, { pinned: true }),
    );
  });

  it('fires onAssign / onEdit with the entry when their buttons are clicked', () => {
    const entry = makeEntry();
    const onAssign = vi.fn();
    const onEdit = vi.fn();
    renderCard(entry, { onAssign, onEdit });
    fireEvent.click(screen.getByTestId(`voice-library-assign-${entry.voiceUuid}`));
    fireEvent.click(screen.getByTestId(`voice-library-edit-${entry.voiceUuid}`));
    expect(onAssign).toHaveBeenCalledWith(entry);
    expect(onEdit).toHaveBeenCalledWith(entry);
  });

  it('does not render Assign/Edit buttons when the callbacks are omitted', () => {
    const entry = makeEntry();
    renderCard(entry);
    expect(screen.queryByTestId(`voice-library-assign-${entry.voiceUuid}`)).not.toBeInTheDocument();
    expect(screen.queryByTestId(`voice-library-edit-${entry.voiceUuid}`)).not.toBeInTheDocument();
  });

  it('preview-play calls api.sampleLibraryVoice with the entry uuid', async () => {
    sampleLibraryVoice.mockResolvedValue({ url: '/preview.mp3' });
    const entry = makeEntry();
    renderCard(entry);
    fireEvent.click(screen.getByTestId(`voice-library-play-${entry.voiceUuid}`));
    await waitFor(() => expect(sampleLibraryVoice).toHaveBeenCalledWith(entry.voiceUuid));
  });
});
