import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { WorktreesRtfPill } from './worktrees-rtf-pill';
import { api } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { getGenerationStats: vi.fn() },
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
};

const mockStats = vi.mocked(api.getGenerationStats);

beforeEach(() => vi.clearAllMocks());

describe('WorktreesRtfPill', () => {
  it('shows just "wt" with no RTF readout when idle', async () => {
    mockStats.mockResolvedValue(idle);
    render(<WorktreesRtfPill onClick={() => {}} active={false} pollMs={10_000} />);
    await waitFor(() => expect(mockStats).toHaveBeenCalled());
    expect(screen.queryByTestId('topbar-rtf')).toBeNull();
    expect(screen.getByTestId('topbar-worktrees-link')).toHaveTextContent('wt');
  });

  it('renders the live per-batch RTF while generating', async () => {
    mockStats.mockResolvedValue({ ...idle, liveBatchRtf: 1.12, batchesInWindow: 5 });
    render(<WorktreesRtfPill onClick={() => {}} active={false} pollMs={10_000} />);
    const readout = await screen.findByTestId('topbar-rtf');
    expect(readout).toHaveTextContent('1.12');
  });

  it('prefers the live per-batch RTF over the per-chapter rollup', async () => {
    // Both present mid-chapter — the responsive batch figure wins.
    mockStats.mockResolvedValue({ ...idle, rtf: 2.34, liveBatchRtf: 1.12, batchesInWindow: 5 });
    render(<WorktreesRtfPill onClick={() => {}} active={false} pollMs={10_000} />);
    const readout = await screen.findByTestId('topbar-rtf');
    expect(readout).toHaveTextContent('1.12');
  });

  it('falls back to the per-chapter RTF when no batch is recent', async () => {
    mockStats.mockResolvedValue({ ...idle, chapters: 3, rtf: 2.34, xRealtime: 0.43 });
    render(<WorktreesRtfPill onClick={() => {}} active={false} pollMs={10_000} />);
    const readout = await screen.findByTestId('topbar-rtf');
    expect(readout).toHaveTextContent('2.34');
  });

  it('still navigates to worktrees on click', async () => {
    mockStats.mockResolvedValue(idle);
    const onClick = vi.fn();
    render(<WorktreesRtfPill onClick={onClick} active={false} pollMs={10_000} />);
    fireEvent.click(screen.getByTestId('topbar-worktrees-link'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('falls back to no readout when the stats fetch fails', async () => {
    mockStats.mockRejectedValue(new Error('network'));
    render(<WorktreesRtfPill onClick={() => {}} active={false} pollMs={10_000} />);
    await waitFor(() => expect(mockStats).toHaveBeenCalled());
    expect(screen.queryByTestId('topbar-rtf')).toBeNull();
  });
});
