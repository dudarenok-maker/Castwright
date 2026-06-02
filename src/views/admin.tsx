/* fs-18 — Admin watch console. An all-users diagnostics surface that turns
   "why is it broken?" into a glanceable board, without dropping to logs or a
   debug window. Three stacked sections:

     1. Health board (all users) — GPU/VRAM, sidecar + resident models,
        analyzer connectivity, ffmpeg, free disk; one GET /api/diagnostics poll.
     2. Generation throughput (all users) — per-chapter RTF history fed by
        GET /api/generation/stats (the same source as the top-bar Admin pill).
     3. Worktrees (DEV-only) — the original plan-86 git-worktree dashboard;
        still gated behind import.meta.env.DEV (server route 404s in prod).

   Plan 86 (worktrees) + plan 127 (throughput) folded into this view. */

import { useEffect, useState } from 'react';
import {
  api,
  type GenerationStatsResponse,
  type RecentChapter,
  type DiagnosticsResponse,
  type DiagnosticsStatus,
} from '../lib/api';
import { formatDuration } from '../lib/time';

/* Diagnostics poll cadence. The probes spawn processes + do disk I/O, and
   health isn't fast-moving, so 30 s (matching the sidecar/ollama health polls)
   is plenty — 4 s would be wasteful. */
const DIAGNOSTICS_POLL_MS = 30000;

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

export function AdminView() {
  const [stats, setStats] = useState<GenerationStatsResponse | null>(null);

  /* Throughput poller — ticks at the pill's 4 s cadence. Best-effort: a stats
     failure leaves the last good snapshot in place. */
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
        Admin
      </h2>
      <p className="text-sm text-ink/60 mb-6">
        A live watch console for the generation pipeline — health checks and throughput at a glance,
        no logs required.
      </p>

      <HealthBoard />
      <GenerationThroughput stats={stats} />
      {import.meta.env.DEV && <WorktreesSection />}
    </div>
  );
}

const HEALTH_DOT: Record<DiagnosticsStatus, string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  fail: 'bg-rose-500',
};

const HEALTH_DOT_LABEL: Record<DiagnosticsStatus, string> = {
  ok: 'healthy',
  warn: 'warning',
  fail: 'failing',
};

/* fs-18 health board — one GET /api/diagnostics poll, rendered as a row per
   check with a green/amber/red dot, a friendly label, and a technical detail
   line. Self-polls every 30 s; a fetch failure leaves the last good board in
   place (and shows a "couldn't refresh" note rather than blanking). */
function HealthBoard() {
  const [diag, setDiag] = useState<DiagnosticsResponse | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [staleError, setStaleError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () =>
      api
        .getDiagnostics()
        .then((res) => {
          if (cancelled) return;
          setDiag(res);
          setStaleError(false);
          setLoaded(true);
        })
        .catch(() => {
          if (cancelled) return;
          setStaleError(true);
          setLoaded(true);
        });
    fetchOnce();
    const t = setInterval(fetchOnce, DIAGNOSTICS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="mb-10">
      <h3 className="text-lg font-medium tracking-tight text-ink mb-1">Health</h3>
      <p className="text-sm text-ink/60 mb-4">
        GPU &amp; VRAM, TTS sidecar, analyzer, ffmpeg and free disk. Re-checked every 30 s.
      </p>

      {!loaded && <p className="text-sm text-ink/50">Running diagnostics…</p>}

      {diag && (
        <div
          className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden divide-y divide-ink/5"
          data-testid="health-board"
        >
          {diag.checks.map((c) => (
            <div
              key={c.id}
              className="flex items-center gap-3 px-4 py-3"
              data-testid={`health-row-${c.id}`}
              data-status={c.status}
            >
              <span
                className={`inline-block w-2.5 h-2.5 rounded-full shrink-0 ${HEALTH_DOT[c.status]}`}
                aria-label={`${c.label}: ${HEALTH_DOT_LABEL[c.status]}`}
              />
              <span className="font-semibold text-ink text-sm w-40 shrink-0">{c.label}</span>
              <span className="text-sm text-ink/60 min-w-0 truncate">{c.detail}</span>
            </div>
          ))}
        </div>
      )}

      {staleError && (
        <p className="text-xs text-ink/50 mt-2">
          Couldn&apos;t refresh diagnostics — showing the last result.
        </p>
      )}
    </section>
  );
}

/* DEV-only git-worktree dashboard (plan 86). Lists every worktree from
   `git worktree list --porcelain` with its ports + a live TCP probe of each
   VITE_PORT; click a green row to open that worktree's dev URL. The whole
   section is gated behind import.meta.env.DEV by the caller, and the
   `/api/worktrees` server route 404s in production. */
function WorktreesSection() {
  const [rows, setRows] = useState<WorktreeRow[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

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

  return (
    <section className="mt-10">
      <h3 className="text-lg font-medium tracking-tight text-ink mb-1">Worktrees</h3>
      <p className="text-sm text-ink/60 mb-4">
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
    </section>
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
