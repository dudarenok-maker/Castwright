import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { AdminView } from './admin';
import { uiSlice } from '../store/ui-slice';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getWorktrees: vi.fn().mockResolvedValue({ worktrees: [] }),
    getGenerationStats: vi.fn().mockResolvedValue({
      chapters: 0,
      audioSec: 0,
      synthSec: 0,
      rtf: null,
      xRealtime: null,
      chaptersPerHour: null,
      last: null,
      updatedAt: null,
      liveBatchRtf: null,
      lastBatchRtf: null,
      batchesInWindow: 0,
      batchUpdatedAt: null,
      recentChapters: [],
    }),
    getDiagnostics: vi.fn().mockResolvedValue({ ts: new Date().toISOString(), overall: 'ok', checks: [] }),
    getResourceTelemetry: vi.fn(),
    listDevices: vi.fn().mockResolvedValue({ devices: [] }),
  },
}));

const mockTelemetry = vi.mocked(api.getResourceTelemetry as unknown as jest.Mock);

function renderAdmin() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  return render(
    <Provider store={store}>
      <AdminView />
    </Provider>,
  );
}

describe('ResourceTrends — model label', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows human-friendly model label when telemetry has modelKey', async () => {
    mockTelemetry.mockResolvedValue({
      records: [
        {
          at: '2026-06-01T09:00:00Z',
          bookId: 'book-a',
          bookTitle: 'Book A',
          chapterId: 1,
          title: 'Chapter 1',
          modelKey: 'qwen3-tts-0.6b',
          rtf: 1.2,
          audioSec: 600,
          wallSec: 720,
          vramReservedMb: 3200,
          vramTotalMb: 8192,
          committedHostMb: 4096,
        },
      ],
    });

    renderAdmin();

    // Wait for the resource trends section and expect the human-friendly label
    await waitFor(() => expect(screen.getByTestId('resource-trends')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Qwen3-TTS 0.6B')).toBeInTheDocument());
  });
});
