import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { WorktreesView } from './worktrees';
import { api } from '../lib/api';
import type { GenerationStatsResponse, RecentChapter } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { getWorktrees: vi.fn(), getGenerationStats: vi.fn() },
}));

const mockWorktrees = vi.mocked(api.getWorktrees);
const mockStats = vi.mocked(api.getGenerationStats);

const idleStats: GenerationStatsResponse = {
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

const chapter = (over: Partial<RecentChapter>): RecentChapter => ({
  chapterId: 1,
  title: 'Chapter 1',
  bookId: 'book-a',
  modelKey: 'qwen3-tts',
  rtf: 1,
  audioSec: 600,
  synthSec: 600,
  at: '2026-06-01T09:00:00Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  mockWorktrees.mockResolvedValue({ worktrees: [] });
});

describe('WorktreesView — generation throughput table', () => {
  it('renders one row per chapter, newest-first as delivered', async () => {
    // Newest-first: ch 3 (rtf 2.1) is slower than ch 2 (1.0) → deterioration.
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [
        chapter({ chapterId: 3, title: 'Gamma', rtf: 2.1 }),
        chapter({ chapterId: 2, title: 'Beta', rtf: 1.0 }),
        chapter({ chapterId: 1, title: 'Alpha', rtf: 1.5 }),
      ],
    });
    render(<WorktreesView />);

    const table = await screen.findByTestId('generation-throughput-table');
    const rows = within(table).getAllByTestId(/^throughput-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'throughput-row-3',
      'throughput-row-2',
      'throughput-row-1',
    ]);
    expect(within(rows[0]).getByText('Gamma')).toBeInTheDocument();
  });

  it('tints a slower-than-previous chapter and not a faster one', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [
        chapter({ chapterId: 3, title: 'Gamma', rtf: 2.1 }), // slower than ch 2 → ▲
        chapter({ chapterId: 2, title: 'Beta', rtf: 1.0 }), // faster than ch 1 → ▼
        chapter({ chapterId: 1, title: 'Alpha', rtf: 1.5 }), // no older entry → no glyph
      ],
    });
    render(<WorktreesView />);

    const table = await screen.findByTestId('generation-throughput-table');
    expect(within(within(table).getByTestId('throughput-row-3')).getByText('▲')).toBeInTheDocument();
    expect(within(within(table).getByTestId('throughput-row-2')).getByText('▼')).toBeInTheDocument();
    // Oldest row has nothing to compare against → no trend glyph.
    expect(within(within(table).getByTestId('throughput-row-1')).queryByText('▲')).toBeNull();
    expect(within(within(table).getByTestId('throughput-row-1')).queryByText('▼')).toBeNull();
  });

  it('renders a dash and no trend for a null-rtf chapter', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [
        chapter({ chapterId: 2, title: 'Beta', rtf: null }),
        chapter({ chapterId: 1, title: 'Alpha', rtf: 1.5 }),
      ],
    });
    render(<WorktreesView />);

    const table = await screen.findByTestId('generation-throughput-table');
    const row = within(table).getByTestId('throughput-row-2');
    expect(within(row).getByText('–')).toBeInTheDocument();
    expect(within(row).queryByText('▲')).toBeNull();
  });

  it('shows the empty-state copy when no chapters have been recorded', async () => {
    mockStats.mockResolvedValue(idleStats);
    render(<WorktreesView />);
    await waitFor(() => expect(mockStats).toHaveBeenCalled());
    expect(screen.queryByTestId('generation-throughput-table')).toBeNull();
    expect(screen.getByText(/No chapters recorded yet/i)).toBeInTheDocument();
  });

  it('shows the run-summary strip only when a summary figure is present', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      rtf: 1.6,
      chaptersPerHour: 6.4,
      recentChapters: [chapter({ chapterId: 1, rtf: 1.6 })],
    });
    render(<WorktreesView />);

    const summary = await screen.findByTestId('throughput-summary');
    expect(within(summary).getByText('1.60')).toBeInTheDocument();
    expect(within(summary).getByText('6.4')).toBeInTheDocument();
  });

  it('hides the run-summary strip when all summary figures are null', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [chapter({ chapterId: 1, rtf: 1.0 })],
    });
    render(<WorktreesView />);
    await screen.findByTestId('generation-throughput-table');
    expect(screen.queryByTestId('throughput-summary')).toBeNull();
  });
});
