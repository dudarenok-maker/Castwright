/* Plan 86 — Live worktree dashboard. Shows every git worktree visible to
   `git worktree list --porcelain` with its branch, ports (from .env.local),
   and a TCP probe against the dev server's VITE_PORT. Auto-refreshes
   every 10 s. Dev-only — production builds hide the top-bar entry and
   the server route 404s.

   Click a row → opens that worktree's dev URL in a new tab.

   Plan 127 — also renders a per-chapter generation-throughput table fed by
   GET /api/generation/stats (the same source as the top-bar `wt` RTF pill), so
   the operator can see whether RTF is deteriorating or staying consistent across
   a run without grepping logs. */

import { useEffect, useState } from 'react';
import { api, type GenerationStatsResponse, type RecentChapter } from '../lib/api';
import { formatDuration } from '../lib/time';

interface WorktreeRow {
  path: string;
  branch: string | null;
  head: string | null;
  ports: Record<string, string>;
  vitePort: number;
  alive: boolean;
}

/* Poll the throughput stats at the pill's cadence, independent of the 10 s
   worktree refresh. */
const STATS_POLL_MS = 4000;
/* Ignore sub-noise rtf wobble when deciding the up/down trend arrow. */
const TREND_EPSILON = 0.02;

const fmtRtf = (rtf: number | null): string => (rtf == null ? '–' : rtf.toFixed(2));

const fmtClock = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour12: false });
};

/* Compare a row to the immediately-older entry (next in the newest-first list).
   Rising rtf = slower = deteriorating. null on either side → no verdict. */
type Trend = 'up' | 'down' | 'flat' | 'none';
const trendOf = (rtf: number | null, olderRtf: number | null | undefined): Trend => {
  if (rtf == null || olderRtf == null) return 'none';
  if (rtf > olderRtf + TREND_EPSILON) return 'up';
  if (rtf < olderRtf - TREND_EPSILON) return 'down';
  return 'flat';
};

const TREND_STYLE: Record<Trend, { cls: string; glyph: string; label: string }> = {
  up: { cls: 'text-rose-600', glyph: '▲', label: 'slower than previous chapter' },
  down: { cls: 'text-green-600', glyph: '▼', label: 'faster than previous chapter' },
  flat: { cls: 'text-ink/70', glyph: '→', label: 'about the same as previous chapter' },
  none: { cls: 'text-ink/70', glyph: '', label: '' },
};

export function WorktreesView() {
  const [rows, setRows] = useState<WorktreeRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [stats, setStats] = useState<GenerationStatsResponse | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () =>
      api
        .getWorktrees()
        .then((res) => {
          if (cancelled) return;
          setRows(res.worktrees);
          setLoadError(null);
          setLoaded(true);
        })
        .catch((e: Error) => {
          if (cancelled) return;
          setLoadError(e.message);
          setLoaded(true);
        });
    fetchOnce();
    const t = setInterval(fetchOnce, 10000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  /* Separate poller so a stats failure can't blank the worktree list (and vice
     versa), and so it ticks at the pill's 4 s cadence not the 10 s refresh. */
  useEffect(() => {
    let cancelled = false;
    const fetchStats = () =>
      api
        .getGenerationStats()
        .then((res) => {
          if (!cancelled) setStats(res);
        })
        .catch(() => {
          /* Telemetry is best-effort; leave the last good snapshot in place. */
        });
    fetchStats();
    const t = setInterval(fetchStats, STATS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8">
      <h2 className="text-2xl md:text-3xl font-medium leading-[1.1] tracking-tight text-ink mb-4">
        Worktrees
      </h2>
      <p className="text-sm text-ink/60 mb-6">
        Active git worktrees plus their port assignments and a live TCP probe of each VITE_PORT.
        Click a row with a green dot to open that worktree&apos;s dev URL in a new tab.
        Auto-refresh every 10 s. Dev-only.
      </p>
      {!loaded && <p className="text-sm text-ink/50">Loading…</p>}
      {loadError && (
        <p className="text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">
          Failed to load worktrees: {loadError}
        </p>
      )}
      {loaded && !loadError && rows.length === 0 && (
        <p className="text-sm text-ink/50">No worktrees found. (Are you on a git checkout?)</p>
      )}
      {loaded && rows.length > 0 && (
        <div className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5">
          {rows.map((r) => (
            <button
              key={r.path}
              onClick={() => {
                if (r.alive) {
                  window.open(`http://localhost:${r.vitePort}`, '_blank');
                }
              }}
              className={`w-full text-left px-4 py-3 hover:bg-ink/3 flex items-center gap-3 transition-colors ${
                r.alive ? 'cursor-pointer' : 'cursor-default opacity-60'
              }`}
              data-testid={`worktree-row-${r.branch ?? 'detached'}`}
              disabled={!r.alive}
            >
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full ${
                  r.alive ? 'bg-green-500' : 'bg-ink/30'
                }`}
                aria-label={r.alive ? 'Dev server alive' : 'Dev server not responding'}
              />
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-ink text-sm truncate">{r.branch ?? '(detached)'}</p>
                <p className="text-xs text-ink/50 truncate">{r.path}</p>
              </div>
              <div className="text-xs text-ink/60 hidden sm:block">
                VITE_PORT {r.vitePort}
              </div>
              <div className="text-xs text-ink/50 font-mono hidden md:block">
                {r.head?.slice(0, 8) ?? ''}
              </div>
            </button>
          ))}
        </div>
      )}

      <GenerationThroughput stats={stats} />
    </div>
  );
}

/* Per-chapter RTF history — newest-first, with a deterioration cue (rising rtf
   = slower) and a header strip of the run-level figures. Fed by the same
   GET /api/generation/stats source as the top-bar `wt` pill. */
function GenerationThroughput({ stats }: { stats: GenerationStatsResponse | null }) {
  const recent = stats?.recentChapters ?? [];
  const hasSummary =
    stats != null &&
    (stats.rtf != null || stats.liveBatchRtf != null || stats.chaptersPerHour != null);

  return (
    <section className="mt-10">
      <h3 className="text-lg font-medium tracking-tight text-ink mb-1">Generation throughput</h3>
      <p className="text-sm text-ink/60 mb-4">
        Per-chapter RTF (synth-wall ÷ audio; &lt; 1 = faster than realtime), newest first.
        A <span className="text-rose-600">▲</span> means the chapter ran slower than the one
        before it.
      </p>

      {hasSummary && (
        <div className="flex flex-wrap gap-x-8 gap-y-2 mb-4 text-sm" data-testid="throughput-summary">
          <SummaryStat label="Run RTF" value={fmtRtf(stats!.rtf)} />
          <SummaryStat label="Live batch RTF" value={fmtRtf(stats!.liveBatchRtf)} />
          <SummaryStat
            label="Chapters/hr"
            value={stats!.chaptersPerHour == null ? '–' : stats!.chaptersPerHour.toFixed(1)}
          />
        </div>
      )}

      {recent.length === 0 ? (
        <p className="text-sm text-ink/50">No chapters recorded yet this session.</p>
      ) : (
        <div
          className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden"
          data-testid="generation-throughput-table"
        >
          <div className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 sm:gap-x-6 px-4 py-2 text-[11px] uppercase tracking-wide text-ink/40 border-b border-ink/5">
            <span>Chapter</span>
            <span className="text-right hidden sm:block">Engine</span>
            <span className="text-right hidden md:block">Audio</span>
            <span className="text-right hidden md:block">Synth</span>
            <span className="text-right">RTF</span>
          </div>
          <div className="divide-y divide-ink/5">
            {recent.map((c, i) => (
              <ThroughputRow key={`${c.bookId ?? ''}:${c.chapterId}:${c.at}`} chapter={c} olderRtf={recent[i + 1]?.rtf} />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-baseline gap-1.5">
      <span className="text-ink/50">{label}</span>
      <span className="font-mono font-medium text-ink tabular-nums">{value}</span>
    </span>
  );
}

function ThroughputRow({ chapter, olderRtf }: { chapter: RecentChapter; olderRtf: number | null | undefined }) {
  const trend = trendOf(chapter.rtf, olderRtf);
  const style = TREND_STYLE[trend];
  return (
    <div
      className="grid grid-cols-[1fr_auto_auto_auto_auto] gap-x-3 sm:gap-x-6 items-center px-4 py-2.5 text-sm"
      data-testid={`throughput-row-${chapter.chapterId}`}
    >
      <span className="min-w-0 truncate text-ink">
        <span className="text-ink/40 font-mono mr-2">#{chapter.chapterId}</span>
        {chapter.title ?? <span className="text-ink/40">(untitled)</span>}
      </span>
      <span className="text-right text-xs text-ink/50 font-mono hidden sm:block">
        {chapter.modelKey ?? '–'}
      </span>
      <span className="text-right text-xs text-ink/50 font-mono tabular-nums hidden md:block">
        {formatDuration(chapter.audioSec)}
      </span>
      <span className="text-right text-xs text-ink/50 font-mono tabular-nums hidden md:block">
        {formatDuration(chapter.synthSec)}
      </span>
      <span
        className={`text-right font-mono font-medium tabular-nums ${style.cls}`}
        title={`${fmtClock(chapter.at)}${style.label ? ` · ${style.label}` : ''}`}
      >
        {style.glyph && (
          <span className="mr-1 text-xs" aria-label={style.label}>
            {style.glyph}
          </span>
        )}
        {fmtRtf(chapter.rtf)}
      </span>
    </div>
  );
}
