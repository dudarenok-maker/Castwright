import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { AdminView } from './admin';
import { api } from '../lib/api';
import type { GenerationStatsResponse, RecentChapter, DiagnosticsResponse } from '../lib/api';

vi.mock('../lib/api', () => ({
  api: { getWorktrees: vi.fn(), getGenerationStats: vi.fn(), getDiagnostics: vi.fn() },
}));

const mockWorktrees = vi.mocked(api.getWorktrees);
const mockStats = vi.mocked(api.getGenerationStats);
const mockDiag = vi.mocked(api.getDiagnostics);

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

const healthyBoard: DiagnosticsResponse = {
  ts: '2026-01-01T00:00:00.000Z',
  overall: 'ok',
  checks: [
    { id: 'gpu', label: 'GPU / VRAM', status: 'ok', detail: 'cuda · 1.2 / 8.0 GB reserved' },
    { id: 'sidecar', label: 'TTS sidecar', status: 'ok', detail: 'reachable · qwen' },
    { id: 'analyzer', label: 'Analyzer (Ollama)', status: 'warn', detail: 'reachable · model not pulled' },
    { id: 'gemini', label: 'Analyzer (Gemini)', status: 'ok', detail: 'not in use' },
    { id: 'ffmpeg', label: 'ffmpeg / ffprobe', status: 'fail', detail: 'ffprobe not found on PATH' },
    { id: 'disk', label: 'Free disk', status: 'ok', detail: '142 GB free' },
  ],
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
  mockStats.mockResolvedValue(idleStats);
  mockDiag.mockResolvedValue(healthyBoard);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AdminView — health board', () => {
  it('renders one row per diagnostics check with its status', async () => {
    render(<AdminView />);
    const board = await screen.findByTestId('health-board');
    const ids = within(board)
      .getAllByTestId(/^health-row-/)
      .map((r) => r.getAttribute('data-testid'));
    expect(ids).toEqual([
      'health-row-gpu',
      'health-row-sidecar',
      'health-row-analyzer',
      'health-row-gemini',
      'health-row-ffmpeg',
      'health-row-disk',
    ]);
    expect(screen.getByTestId('health-row-ffmpeg')).toHaveAttribute('data-status', 'fail');
    expect(screen.getByTestId('health-row-analyzer')).toHaveAttribute('data-status', 'warn');
    expect(within(screen.getByTestId('health-row-gpu')).getByText(/8\.0 GB/)).toBeInTheDocument();
  });
});

describe('AdminView — dev-only worktrees gating', () => {
  it('renders the worktrees section in dev (import.meta.env.DEV true)', async () => {
    // vitest runs with DEV === true by default.
    render(<AdminView />);
    expect(await screen.findByRole('heading', { name: 'Worktrees' })).toBeInTheDocument();
    await waitFor(() => expect(mockWorktrees).toHaveBeenCalled());
  });

  it('hides the worktrees section in production builds', async () => {
    vi.stubEnv('DEV', false);
    render(<AdminView />);
    // Health board still renders for all users…
    await screen.findByTestId('health-board');
    // …but the dev-only worktree dashboard does not, and never probes.
    expect(screen.queryByRole('heading', { name: 'Worktrees' })).toBeNull();
    expect(mockWorktrees).not.toHaveBeenCalled();
  });
});

describe('AdminView — generation throughput table', () => {
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
    render(<AdminView />);

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
    render(<AdminView />);

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
    render(<AdminView />);

    const table = await screen.findByTestId('generation-throughput-table');
    const row = within(table).getByTestId('throughput-row-2');
    expect(within(row).getByText('–')).toBeInTheDocument();
    expect(within(row).queryByText('▲')).toBeNull();
  });

  it('shows the empty-state copy when no chapters have been recorded', async () => {
    mockStats.mockResolvedValue(idleStats);
    render(<AdminView />);
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
    render(<AdminView />);

    const summary = await screen.findByTestId('throughput-summary');
    expect(within(summary).getByText('1.60')).toBeInTheDocument();
    expect(within(summary).getByText('6.4')).toBeInTheDocument();
  });

  it('hides the run-summary strip when all summary figures are null', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [chapter({ chapterId: 1, rtf: 1.0 })],
    });
    render(<AdminView />);
    await screen.findByTestId('generation-throughput-table');
    expect(screen.queryByTestId('throughput-summary')).toBeNull();
  });
});
