import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AdminPill } from './admin-pill';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { getGenerationStats: vi.fn(), getDiagnostics: vi.fn() },
}));

const idle = {
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
};

const board = (overall: 'ok' | 'warn' | 'fail') => ({ ts: '', overall, checks: [] });

const mockStats = vi.mocked(api.getGenerationStats);
const mockDiag = vi.mocked(api.getDiagnostics);

beforeEach(() => {
  vi.clearAllMocks();
  // Default both polls to benign resolved values; individual tests override.
  mockStats.mockResolvedValue(idle);
  mockDiag.mockResolvedValue(board('ok'));
});

/* Never let the slow 30 s diagnostics interval fire during a test. */
const QUIET = { pollMs: 10_000, diagnosticsPollMs: 10_000 };

describe('AdminPill', () => {
  it('shows "Admin" with no RTF readout when idle', async () => {
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    await waitFor(() => expect(mockStats).toHaveBeenCalled());
    expect(screen.queryByTestId('topbar-rtf')).toBeNull();
    expect(screen.getByTestId('topbar-admin-link')).toHaveTextContent('Admin');
  });

  it('renders the live per-batch RTF while generating', async () => {
    mockStats.mockResolvedValue({ ...idle, liveBatchRtf: 1.12, batchesInWindow: 5 });
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    const readout = await screen.findByTestId('topbar-rtf');
    expect(readout).toHaveTextContent('1.12');
  });

  it('prefers the live per-batch RTF over the per-chapter rollup', async () => {
    mockStats.mockResolvedValue({ ...idle, rtf: 2.34, liveBatchRtf: 1.12, batchesInWindow: 5 });
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    const readout = await screen.findByTestId('topbar-rtf');
    expect(readout).toHaveTextContent('1.12');
  });

  it('falls back to the per-chapter RTF when no batch is recent', async () => {
    mockStats.mockResolvedValue({ ...idle, chapters: 3, rtf: 2.34, xRealtime: 0.43 });
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    const readout = await screen.findByTestId('topbar-rtf');
    expect(readout).toHaveTextContent('2.34');
  });

  it('navigates to the Admin view on click', async () => {
    const onClick = vi.fn();
    render(<AdminPill onClick={onClick} active={false} {...QUIET} />);
    fireEvent.click(screen.getByTestId('topbar-admin-link'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('falls back to no readout when the stats fetch fails', async () => {
    mockStats.mockRejectedValue(new Error('network'));
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    await waitFor(() => expect(mockStats).toHaveBeenCalled());
    expect(screen.queryByTestId('topbar-rtf')).toBeNull();
  });

  it('starts the health dot grey before the first diagnostics result', () => {
    // Never-resolving diagnostics keeps the dot in its initial "unknown" state.
    mockDiag.mockReturnValue(new Promise(() => {}));
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    expect(screen.getByTestId('topbar-health-dot')).toHaveAttribute('data-status', 'unknown');
  });

  it('turns the health dot green / amber / red from the board overall', async () => {
    mockDiag.mockResolvedValue(board('warn'));
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    await waitFor(() =>
      expect(screen.getByTestId('topbar-health-dot')).toHaveAttribute('data-status', 'warn'),
    );
  });

  it('keeps the last known health on a diagnostics fetch error', async () => {
    mockDiag.mockRejectedValue(new Error('network'));
    render(<AdminPill onClick={() => {}} active={false} {...QUIET} />);
    await waitFor(() => expect(mockDiag).toHaveBeenCalled());
    // Never resolved successfully → stays grey rather than flipping to fail.
    expect(screen.getByTestId('topbar-health-dot')).toHaveAttribute('data-status', 'unknown');
  });
});
