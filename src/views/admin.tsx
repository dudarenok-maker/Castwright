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
  type ResourceTelemetryRecord,
} from '../lib/api';
import { formatDuration } from '../lib/time';
import { useAppDispatch } from '../store';
import { uiActions } from '../store/ui-slice';

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

/* Shared column templates so each table's sticky header and its body rows are
   ONE grid definition, not two independent grids whose `auto` tracks size to
   different content (header text vs. data) and drift out of alignment. Explicit
   rem widths on the fixed columns guarantee the tracks line up; the responsive
   variants drop tracks in lockstep with the cells' `hidden sm:/md:block` so the
   collapse stays aligned at every breakpoint. The header lives INSIDE the
   scroll container (sticky) so it shares the scrollbar gutter the rows reserve
   (scrollbar-gutter: stable from .scrollbar-thin) — otherwise the header would
   run a gutter-width past the rows. */
const THROUGHPUT_COLS =
  'grid grid-cols-[1fr_auto] sm:grid-cols-[1fr_7rem_auto] md:grid-cols-[1fr_7rem_3.5rem_3.5rem_auto] gap-x-3 sm:gap-x-6';
const TRENDS_COLS =
  'grid grid-cols-[1fr_3rem_auto] sm:grid-cols-[1fr_3rem_3.5rem_auto] gap-x-3 sm:gap-x-6';

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

      <AboutLink />
      <ModelManagerLink />
      <AdvancedConfigLink />
      <HealthBoard />
      <GenerationThroughput stats={stats} />
      <ResourceTrends />
      {import.meta.env.DEV && <WorktreesSection />}
    </div>
  );
}

/* fs-23 — entry point to the In-app Model Manager. The manager consolidates
   every model install / inventory / residency control that used to be
   scattered across the Account view; Admin is its only launch surface. */
function ModelManagerLink() {
  const dispatch = useAppDispatch();
  return (
    <section className="mb-6 rounded-2xl border border-ink/10 bg-white p-5 shadow-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-base font-semibold text-ink">Model Manager</h3>
        <p className="mt-1 text-xs text-ink/55 max-w-prose">
          Install, remove, and update the local TTS / analyzer / ASR models, see disk usage, and load
          or unload each into the GPU — all in one place.
        </p>
      </div>
      <button
        type="button"
        onClick={() => dispatch(uiActions.openModelManager())}
        data-testid="admin-open-model-manager"
        className="shrink-0 min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
      >
        Open Model Manager →
      </button>
    </section>
  );
}

/* Wave 3 — entry point to the /about brand page. */
function AboutLink() {
  const dispatch = useAppDispatch();
  return (
    <section className="mb-6 rounded-2xl border border-ink/10 bg-white p-5 shadow-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-base font-semibold text-ink">About Castwright</h3>
        <p className="mt-1 text-xs text-ink/55 max-w-prose">
          Brand story, tagline, and app version.
        </p>
      </div>
      <button
        type="button"
        onClick={() => dispatch(uiActions.openAbout())}
        data-testid="admin-open-about"
        className="shrink-0 min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
      >
        About Castwright →
      </button>
    </section>
  );
}

/* Advanced configuration entry point — reached from Admin. */
function AdvancedConfigLink() {
  const dispatch = useAppDispatch();
  return (
    <section className="mb-6 rounded-2xl border border-ink/10 bg-white p-5 shadow-card flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div>
        <h3 className="text-base font-semibold text-ink">Advanced configuration</h3>
        <p className="mt-1 text-xs text-ink/55 max-w-prose">
          Tune model, generation, and QA settings at your own risk.
        </p>
      </div>
      <button
        type="button"
        onClick={() => dispatch(uiActions.openAdvanced())}
        data-testid="admin-open-advanced"
        className="shrink-0 min-h-[44px] sm:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
      >
        Open Advanced settings →
      </button>
    </section>
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
        GPU &amp; VRAM, Voice engine, analyzer, ASR, ffmpeg and free disk. Re-checked every 30 s.
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
          {/* Cap the rows and scroll inside with the inset thin scrollbar — a
              long run records far more chapters than fit on the page. The
              column header is sticky INSIDE the scroller so it shares the
              reserved gutter and stays put while rows scroll. */}
          <div
            className="max-h-[60vh] overflow-y-auto scrollbar-thin"
            data-testid="generation-throughput-scroll"
          >
            <div
              className={`sticky top-0 z-10 bg-white ${THROUGHPUT_COLS} px-4 py-2 text-[11px] uppercase tracking-wide text-ink/40 border-b border-ink/5`}
            >
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
        </div>
      )}
    </section>
  );
}

/* fs-20 — per-run resource telemetry trend panel. Polls
   GET /api/generation/telemetry (best-effort, last-good on error) and renders a
   compact per-chapter table plus a hand-rolled inline SVG sparkline of RTF
   across the records (no charting dep). VRAM (reserved/total) + wall-time
   columns surface the resource pressure that climbs across a long run. */
/* Group newest-first telemetry into contiguous runs by book, so a long
   workspace run reads as "The Drowning Bell (chapters…), Unlocked (chapters…)"
   rather than an undifferentiated wall of chapter numbers. We split on every
   bookId change rather than collapsing all of a book's rows together, so the
   chronological newest-first ordering is preserved even when two books'
   generations interleave. Label falls back bookTitle → bookId → unknown. */
function groupTelemetryByBook(
  records: ResourceTelemetryRecord[],
): Array<{ key: string; label: string; rows: ResourceTelemetryRecord[] }> {
  const groups: Array<{ key: string; label: string; rows: ResourceTelemetryRecord[] }> = [];
  for (const r of records) {
    const key = r.bookId ?? r.bookTitle ?? '';
    const last = groups[groups.length - 1];
    if (last && last.key === key) {
      last.rows.push(r);
    } else {
      groups.push({ key, label: r.bookTitle ?? r.bookId ?? '(unknown book)', rows: [r] });
    }
  }
  return groups;
}

function ResourceTrends() {
  const [records, setRecords] = useState<ResourceTelemetryRecord[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () =>
      api
        .getResourceTelemetry(100)
        .then((res) => {
          if (!cancelled) {
            setRecords(res.records);
            setLoaded(true);
          }
        })
        .catch(() => {
          /* Best-effort — leave the last-good snapshot in place. */
          if (!cancelled) setLoaded(true);
        });
    fetchOnce();
    const t = setInterval(fetchOnce, STATS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  return (
    <section className="mt-10">
      <h3 className="text-lg font-medium tracking-tight text-ink mb-1">Resource trends</h3>
      <p className="text-sm text-ink/60 mb-4">
        Per-chapter RTF, wall-time and VRAM captured across the run — watch for a slow climb that
        precedes a VRAM spill or host OOM. Newest first.
      </p>

      {!loaded && <p className="text-sm text-ink/50">Loading telemetry…</p>}

      {loaded && records.length === 0 ? (
        <p className="text-sm text-ink/50">No telemetry recorded yet.</p>
      ) : records.length > 0 ? (
        <div
          className="bg-white rounded-3xl border border-ink/10 shadow-card overflow-hidden"
          data-testid="resource-trends"
        >
          <div className="px-4 py-3 border-b border-ink/5">
            <RtfSparkline records={records} />
          </div>
          {/* Cap the rows at ~12 rows tall (~32rem) and scroll inside with the
              inset thin scrollbar — a long run records hundreds of chapters that
              would otherwise run off the page. The column header is sticky at the
              top of the scroller (so it shares the reserved gutter and aligns
              with the rows); each book's chapters sit under a sub-header that
              sticks just BELOW the column header. */}
          <div
            className="max-h-[32rem] overflow-y-auto scrollbar-thin"
            data-testid="resource-trends-scroll"
          >
            <div
              className={`sticky top-0 z-20 bg-white ${TRENDS_COLS} px-4 py-2 text-[11px] uppercase tracking-wide text-ink/40 border-b border-ink/5`}
            >
              <span>Chapter</span>
              <span className="text-right">RTF</span>
              <span className="text-right hidden sm:block">Wall</span>
              <span className="text-right">VRAM</span>
            </div>
            {groupTelemetryByBook(records).map((group, gi) => (
              <div key={`${group.key}:${gi}`} data-testid="resource-book-group">
                <div
                  className="sticky top-8 z-10 bg-white px-4 py-1.5 text-xs font-medium text-ink/70 border-b border-ink/5 truncate"
                  data-testid="resource-book-header"
                  title={group.label}
                >
                  {group.label}
                </div>
                <div className="divide-y divide-ink/5">
                  {group.rows.map((r) => (
                    <div
                      key={`${r.bookId ?? ''}:${r.chapterId}:${r.at}`}
                      className={`${TRENDS_COLS} items-center px-4 py-2.5 text-sm`}
                      data-testid={`resource-row-${r.chapterId}`}
                    >
                      <span className="min-w-0 truncate text-ink">
                        <span className="text-ink/40 font-mono mr-2">#{r.chapterId}</span>
                        {r.title ?? <span className="text-ink/40">(untitled)</span>}
                      </span>
                      <span className="text-right font-mono tabular-nums text-ink/80">
                        {fmtRtf(r.rtf)}
                      </span>
                      <span className="text-right font-mono tabular-nums text-ink/50 hidden sm:block">
                        {formatDuration(r.wallSec)}
                      </span>
                      <span className="text-right font-mono tabular-nums text-ink/50">
                        {r.vramReservedMb == null
                          ? '–'
                          : `${(r.vramReservedMb / 1024).toFixed(1)}${
                              r.vramTotalMb != null ? ` / ${(r.vramTotalMb / 1024).toFixed(1)}` : ''
                            } GB`}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

/* Hand-rolled inline SVG sparkline of RTF across the telemetry records. Records
   arrive newest-first; we plot oldest→newest left→right so the trend reads
   naturally. Null rtf points are skipped. No charting dependency. */
function RtfSparkline({ records }: { records: ResourceTelemetryRecord[] }) {
  const series = [...records]
    .reverse()
    .map((r) => r.rtf)
    .filter((v): v is number => v != null && Number.isFinite(v));
  if (series.length < 2) {
    return <p className="text-xs text-ink/40">Not enough data for a trend yet.</p>;
  }
  const W = 240;
  const H = 36;
  const pad = 2;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const points = series
    .map((v, i) => {
      const x = pad + (i / (series.length - 1)) * (W - pad * 2);
      const y = H - pad - ((v - min) / span) * (H - pad * 2);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg
      width={W}
      height={H}
      viewBox={`0 0 ${W} ${H}`}
      className="text-magenta"
      role="img"
      aria-label={`RTF trend across ${series.length} chapters`}
      data-testid="resource-rtf-sparkline"
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth={1.5}
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
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
      className={`${THROUGHPUT_COLS} items-center px-4 py-2.5 text-sm`}
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
