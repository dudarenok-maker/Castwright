/* fs-23 — Model Manager view. Inventory rows, residency badges, and the
   Load/Unload action wiring. The moved form sections get their own assertions
   migrated over from account.test.tsx in step A8. */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { ModelManagerView } from './model-manager';
import { api, type ModelInventoryResponse } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getModelInventory: vi.fn(),
    loadSidecar: vi.fn(),
    unloadSidecar: vi.fn(),
    loadAnalyzer: vi.fn(),
    unloadAnalyzer: vi.fn(),
  },
}));

const mockInventory = vi.mocked(api.getModelInventory);
const mockLoad = vi.mocked(api.loadSidecar);
const mockUnload = vi.mocked(api.unloadSidecar);

const INVENTORY: ModelInventoryResponse = {
  ts: '2026-06-06T00:00:00.000Z',
  sidecarReachable: true,
  items: [
    {
      id: 'kokoro',
      kind: 'tts',
      label: 'Kokoro v1',
      present: true,
      sizeBytes: 346_030_080,
      diskPath: 'server/tts-sidecar/voices/kokoro',
      loaded: true,
      isDefaultEngine: true,
      isFallbackEngine: true,
      removable: true,
      updatable: true,
    },
    {
      id: 'qwen-base',
      kind: 'tts',
      label: 'Qwen3-TTS Base (0.6B)',
      present: true,
      sizeBytes: 1_283_457_024,
      diskPath: 'hub/models--Qwen--Qwen3-TTS-12Hz-0.6B-Base',
      loaded: false,
      isDefaultEngine: false,
      isFallbackEngine: false,
      removable: true,
      updatable: true,
    },
    {
      id: 'coqui',
      kind: 'tts',
      label: 'Coqui XTTS v2',
      present: false,
      sizeBytes: null,
      diskPath: 'voices/coqui',
      loaded: false,
      isDefaultEngine: false,
      isFallbackEngine: false,
      removable: false,
      updatable: true,
    },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockInventory.mockResolvedValue(INVENTORY);
  mockLoad.mockResolvedValue({ status: 'ready' });
  mockUnload.mockResolvedValue({ status: 'idle' });
});

describe('ModelManagerView — inventory', () => {
  it('renders a row per model with size and disk path', async () => {
    render(<ModelManagerView />);
    const board = await screen.findByTestId('model-inventory');
    expect(within(board).getByTestId('model-row-kokoro')).toBeInTheDocument();
    expect(within(board).getByTestId('model-row-qwen-base')).toBeInTheDocument();
    expect(within(board).getByText(/330 MB/)).toBeInTheDocument(); // 346030080 bytes
    expect(within(board).getByText(/models--Qwen--Qwen3-TTS/)).toBeInTheDocument();
  });

  it('shows the residency badge per model', async () => {
    render(<ModelManagerView />);
    const kokoro = await screen.findByTestId('model-row-kokoro');
    expect(within(kokoro).getByText('Loaded')).toBeInTheDocument();
    const qwen = screen.getByTestId('model-row-qwen-base');
    expect(within(qwen).getByText('Installed')).toBeInTheDocument();
    const coqui = screen.getByTestId('model-row-coqui');
    expect(within(coqui).getByText('Not installed')).toBeInTheDocument();
  });

  it('flags the default and fallback engines', async () => {
    render(<ModelManagerView />);
    const kokoro = await screen.findByTestId('model-row-kokoro');
    expect(within(kokoro).getByText('Default')).toBeInTheDocument();
    expect(within(kokoro).getByText('Fallback')).toBeInTheDocument();
  });

  it('loads an installed-but-unloaded engine via the control pill', async () => {
    render(<ModelManagerView />);
    const qwen = await screen.findByTestId('model-row-qwen-base');
    const loadBtn = within(qwen).getByRole('button', { name: /load model/i });
    loadBtn.click();
    await waitFor(() => expect(mockLoad).toHaveBeenCalledWith({ engine: 'qwen' }));
  });

  it('unloads a resident engine via the control pill', async () => {
    render(<ModelManagerView />);
    const kokoro = await screen.findByTestId('model-row-kokoro');
    const stopBtn = within(kokoro).getByRole('button', { name: /stop/i });
    stopBtn.click();
    await waitFor(() => expect(mockUnload).toHaveBeenCalledWith({ engine: 'kokoro' }));
  });

  it('offers no Load control for a not-installed model', async () => {
    render(<ModelManagerView />);
    const coqui = await screen.findByTestId('model-row-coqui');
    expect(within(coqui).queryByRole('button', { name: /load model/i })).toBeNull();
  });
});
