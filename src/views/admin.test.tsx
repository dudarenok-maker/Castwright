import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import { configureStore } from '@reduxjs/toolkit';
import { Provider } from 'react-redux';
import { AdminView } from './admin';
import { uiSlice } from '../store/ui-slice';
import { api } from '../lib/api';
import type {
  GenerationStatsResponse,
  RecentChapter,
  DiagnosticsResponse,
  ResourceTelemetryRecord,
} from '../lib/api';

vi.mock('../lib/api', () => ({
  api: {
    getWorktrees: vi.fn(),
    getGenerationStats: vi.fn(),
    getDiagnostics: vi.fn(),
    getResourceTelemetry: vi.fn(),
    listDevices: vi.fn().mockResolvedValue({ devices: [] }),
  },
}));

const mockWorktrees = vi.mocked(api.getWorktrees);
const mockStats = vi.mocked(api.getGenerationStats);
const mockDiag = vi.mocked(api.getDiagnostics);
const mockTelemetry = vi.mocked(api.getResourceTelemetry);

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
    { id: 'sidecar', label: 'Voice engine', status: 'ok', detail: 'reachable · qwen' },
    { id: 'asr', label: 'ASR (Whisper)', status: 'ok', detail: 'off — content-QA disabled' },
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

const telemetry = (over: Partial<ResourceTelemetryRecord>): ResourceTelemetryRecord => ({
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
  ...over,
});

/* AdminView dispatches (the fs-23 "Open Model Manager" link), so it must
   render inside a Provider. A minimal store with just the ui slice is enough —
   the view only reads diagnostics/stats through the mocked api. */
function renderAdmin() {
  const store = configureStore({ reducer: { ui: uiSlice.reducer } });
  return {
    store,
    ...render(
      <Provider store={store}>
        <AdminView />
      </Provider>,
    ),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWorktrees.mockResolvedValue({ worktrees: [] });
  mockStats.mockResolvedValue(idleStats);
  mockDiag.mockResolvedValue(healthyBoard);
  mockTelemetry.mockResolvedValue({ records: [] });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('AdminView — health board', () => {
  it('renders one row per diagnostics check with its status', async () => {
    renderAdmin();
    const board = await screen.findByTestId('health-board');
    const ids = within(board)
      .getAllByTestId(/^health-row-/)
      .map((r) => r.getAttribute('data-testid'));
    expect(ids).toEqual([
      'health-row-gpu',
      'health-row-sidecar',
      'health-row-asr',
      'health-row-analyzer',
      'health-row-gemini',
      'health-row-ffmpeg',
      'health-row-disk',
    ]);
    /* The ASR row sits directly below the Voice engine row (srv-31 watch). */
    expect(ids[ids.indexOf('health-row-sidecar') + 1]).toBe('health-row-asr');
    expect(screen.getByTestId('health-row-ffmpeg')).toHaveAttribute('data-status', 'fail');
    expect(screen.getByTestId('health-row-analyzer')).toHaveAttribute('data-status', 'warn');
    expect(within(screen.getByTestId('health-row-gpu')).getByText(/8\.0 GB/)).toBeInTheDocument();
  });
});

describe('AdminView — model manager link (fs-23)', () => {
  it('opens the Model Manager when the link is clicked', async () => {
    const { store } = renderAdmin();
    const link = await screen.findByTestId('admin-open-model-manager');
    link.click();
    expect(store.getState().ui.stage.kind).toBe('model-manager');
  });

  it('uses the theme-safe ink/canvas token so it stays readable in dark mode', async () => {
    /* Regression: the button shipped with `bg-ink text-white`, which paints
       white-on-near-white once --ink inverts in dark mode. The codebase idiom
       (PrimaryButton `dark`) is `bg-ink text-canvas`. */
    renderAdmin();
    const link = await screen.findByTestId('admin-open-model-manager');
    expect(link.className).toContain('text-canvas');
    expect(link.className).not.toContain('text-white');
  });
});

describe('AdminView — about link', () => {
  it('opens the About page when the link is clicked', async () => {
    const { store } = renderAdmin();
    const link = await screen.findByTestId('admin-open-about');
    link.click();
    expect(store.getState().ui.stage.kind).toBe('about');
  });
});

describe('AdminView — dev-only worktrees gating', () => {
  it('renders the worktrees section in dev (import.meta.env.DEV true)', async () => {
    // vitest runs with DEV === true by default.
    renderAdmin();
    expect(await screen.findByRole('heading', { name: 'Worktrees' })).toBeInTheDocument();
    await waitFor(() => expect(mockWorktrees).toHaveBeenCalled());
  });

  it('hides the worktrees section in production builds', async () => {
    vi.stubEnv('DEV', false);
    renderAdmin();
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
    renderAdmin();

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
    renderAdmin();

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
    renderAdmin();

    const table = await screen.findByTestId('generation-throughput-table');
    const row = within(table).getByTestId('throughput-row-2');
    expect(within(row).getByText('–')).toBeInTheDocument();
    expect(within(row).queryByText('▲')).toBeNull();
  });

  it('shows the empty-state copy when no chapters have been recorded', async () => {
    mockStats.mockResolvedValue(idleStats);
    renderAdmin();
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
    renderAdmin();

    const summary = await screen.findByTestId('throughput-summary');
    expect(within(summary).getByText('1.60')).toBeInTheDocument();
    expect(within(summary).getByText('6.4')).toBeInTheDocument();
  });

  it('hides the run-summary strip when all summary figures are null', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [chapter({ chapterId: 1, rtf: 1.0 })],
    });
    renderAdmin();
    await screen.findByTestId('generation-throughput-table');
    expect(screen.queryByTestId('throughput-summary')).toBeNull();
  });
});

describe('AdminView — fs-20 resource trends panel', () => {
  it('renders a row per telemetry record incl. RTF + wall + VRAM columns, plus a sparkline', async () => {
    mockTelemetry.mockResolvedValue({
      records: [
        telemetry({ chapterId: 3, title: 'Gamma', rtf: 2.1, wallSec: 1260, vramReservedMb: 3600 }),
        telemetry({ chapterId: 2, title: 'Beta', rtf: 1.4, wallSec: 840, vramReservedMb: 3300 }),
        telemetry({ chapterId: 1, title: 'Alpha', rtf: 1.0, wallSec: 600, vramReservedMb: 3000 }),
      ],
    });
    renderAdmin();

    const panel = await screen.findByTestId('resource-trends');
    const rows = within(panel).getAllByTestId(/^resource-row-/);
    expect(rows.map((r) => r.getAttribute('data-testid'))).toEqual([
      'resource-row-3',
      'resource-row-2',
      'resource-row-1',
    ]);
    /* RTF + VRAM columns render. */
    expect(within(rows[0]).getByText('2.10')).toBeInTheDocument();
    expect(within(rows[0]).getByText(/3\.5 \/ 8\.0 GB/)).toBeInTheDocument();
    /* Wall-time column (sm+) renders the formatted duration (1260s = 21:00). */
    expect(within(rows[0]).getByText('21:00')).toBeInTheDocument();
    /* Hand-rolled sparkline present (>= 2 points). */
    expect(within(panel).getByTestId('resource-rtf-sparkline')).toBeInTheDocument();
  });

  it('groups rows under a sticky per-book header, splitting on book change', async () => {
    mockTelemetry.mockResolvedValue({
      records: [
        telemetry({ chapterId: 26, bookId: 'the drowning bell', bookTitle: 'The Drowning Bell' }),
        telemetry({ chapterId: 25, bookId: 'the drowning bell', bookTitle: 'The Drowning Bell' }),
        telemetry({ chapterId: 4, bookId: 'unlocked', bookTitle: 'The Floodmark' }),
      ],
    });
    renderAdmin();

    const panel = await screen.findByTestId('resource-trends');
    const headers = within(panel)
      .getAllByTestId('resource-book-header')
      .map((h) => h.textContent);
    expect(headers).toEqual(['The Drowning Bell', 'The Floodmark']);

    /* The Drowning Bell group owns the first two chapter rows; The Floodmark owns one. */
    const groups = within(panel).getAllByTestId('resource-book-group');
    expect(within(groups[0]).getAllByTestId(/^resource-row-/)).toHaveLength(2);
    expect(within(groups[1]).getAllByTestId(/^resource-row-/)).toHaveLength(1);
  });

  it('falls back to the bookId, then a placeholder, when the title is absent', async () => {
    mockTelemetry.mockResolvedValue({
      records: [
        telemetry({ chapterId: 2, bookId: 'legacy-slug', bookTitle: null }),
        telemetry({ chapterId: 1, bookId: null, bookTitle: null }),
      ],
    });
    renderAdmin();

    const panel = await screen.findByTestId('resource-trends');
    const headers = within(panel)
      .getAllByTestId('resource-book-header')
      .map((h) => h.textContent);
    expect(headers).toEqual(['legacy-slug', '(unknown book)']);
  });

  it('shows the empty-state copy when no telemetry has been recorded', async () => {
    mockTelemetry.mockResolvedValue({ records: [] });
    renderAdmin();
    await waitFor(() => expect(mockTelemetry).toHaveBeenCalled());
    expect(screen.queryByTestId('resource-trends')).toBeNull();
    expect(screen.getByText(/No telemetry recorded yet/i)).toBeInTheDocument();
  });
});

describe('AdminView — table scroll regions + header alignment', () => {
  /* Both Admin tables scroll inside the inset thin-scrollbar utility (matching
     every other in-card scroll region), and pin their column header INSIDE the
     scroller with ONE shared column template so the header tracks line up with
     the data rows instead of drifting on the scrollbar gutter + independent
     `auto` columns. */
  const THROUGHPUT_COLS = 'md:grid-cols-[1fr_7rem_3.5rem_3.5rem_auto]';
  const TRENDS_COLS = 'sm:grid-cols-[1fr_3rem_3.5rem_auto]';

  it('scrolls the generation-throughput rows in the inset thin-scrollbar region', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [chapter({ chapterId: 1, rtf: 1.0 })],
    });
    renderAdmin();
    const scroll = await screen.findByTestId('generation-throughput-scroll');
    expect(scroll.className).toMatch(/overflow-y-auto/);
    expect(scroll.className).toMatch(/scrollbar-thin/);
  });

  it('scrolls the resource-trends rows in the inset thin-scrollbar region', async () => {
    mockTelemetry.mockResolvedValue({ records: [telemetry({ chapterId: 1 })] });
    renderAdmin();
    const scroll = await screen.findByTestId('resource-trends-scroll');
    expect(scroll.className).toMatch(/overflow-y-auto/);
    expect(scroll.className).toMatch(/scrollbar-thin/);
  });

  it('throughput header is sticky inside the scroller and shares the row column template', async () => {
    mockStats.mockResolvedValue({
      ...idleStats,
      recentChapters: [chapter({ chapterId: 1, rtf: 1.0 })],
    });
    renderAdmin();
    const scroll = await screen.findByTestId('generation-throughput-scroll');
    const header = scroll.firstElementChild as HTMLElement;
    expect(header.className).toMatch(/sticky/);
    expect(header.className).toContain(THROUGHPUT_COLS);
    const row = within(scroll).getByTestId('throughput-row-1');
    expect(row.className).toContain(THROUGHPUT_COLS);
  });

  it('resource-trends header is sticky inside the scroller and shares the row column template', async () => {
    mockTelemetry.mockResolvedValue({ records: [telemetry({ chapterId: 1 })] });
    renderAdmin();
    const scroll = await screen.findByTestId('resource-trends-scroll');
    const header = scroll.firstElementChild as HTMLElement;
    expect(header.className).toMatch(/sticky/);
    expect(header.className).toContain(TRENDS_COLS);
    const row = within(scroll).getByTestId('resource-row-1');
    expect(row.className).toContain(TRENDS_COLS);
  });
});
