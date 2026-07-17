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

import { useEffect, useMemo, useState } from 'react';
import {
  api,
  type GenerationStatsResponse,
  type RecentChapter,
  type DiagnosticsResponse,
  type DiagnosticsStatus,
  type ResourceTelemetryRecord,
  type AnalyzerEvalRecord,
} from '../lib/api';
import { LanAccessCard } from '../components/lan-access-card';
import { WikiLink } from '../components/wiki-link';
import { formatDuration } from '../lib/time';
import { useAppDispatch } from '../store';
import { uiActions } from '../store/ui-slice';
import { ttsModelLabel, type TtsModelKey } from '../lib/tts-models';
import { ADMIN_WIKI } from '../lib/wiki-links';

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
   different content (header text vs. data) and drift out of alignment. EVERY
   column (including the last) must be an explicit rem width — an `auto` last
   column reintroduces the exact bug this comment warns about: the header row
   and each data row are separate `<div className={..._COLS}>` grids, so an
   `auto` track sizes independently per row (e.g. the header's short "VRAM"
   vs. a row's wide "23.9 / 24.0 GB"), which changes how much space is left
   for the adjacent `1fr` column and shifts every later column out of line
   with the header. The responsive variants drop tracks in lockstep with the
   cells' `hidden sm:/md:block` so the collapse stays aligned — and track
   COUNT per breakpoint must match the number of non-hidden cells at that
   breakpoint, or a cell lands in the wrong track. The header lives INSIDE the
   scroll container (sticky) so it shares the scrollbar gutter the rows reserve
   (scrollbar-gutter: stable from .scrollbar-thin) — otherwise the header would
   run a gutter-width past the rows. */
const THROUGHPUT_COLS =
  'grid grid-cols-[1fr_4.5rem] sm:grid-cols-[1fr_7rem_4.5rem] md:grid-cols-[1fr_7rem_3.5rem_3.5rem_3.5rem_4.5rem] gap-x-3 sm:gap-x-6';
const TRENDS_COLS =
  'grid grid-cols-[1fr_3rem_8rem] sm:grid-cols-[1fr_7rem_3.5rem_3rem_3.5rem_8rem] gap-x-3 sm:gap-x-6';

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
      <div className="mb-6">
        <LanAccessCard />
      </div>
      <HealthBoard />
      <GenerationThroughput stats={stats} />
      <ResourceTrends />
      <AnalyzerTrends />
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
        <WikiLink page={ADMIN_WIKI.modelManager} label="Wiki" className="text-xs" />
      </div>
      <button
        type="button"
        onClick={() => dispatch(uiActions.openModelManager())}
        data-testid="admin-open-model-manager"
        className="shrink-0 min-h-[44px] fine-pointer:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
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
        className="shrink-0 min-h-[44px] fine-pointer:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
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
        <WikiLink page={ADMIN_WIKI.advanced} label="Wiki" className="text-xs" />
      </div>
      <button
        type="button"
        onClick={() => dispatch(uiActions.openAdvanced())}
        data-testid="admin-open-advanced"
        className="shrink-0 min-h-[44px] fine-pointer:min-h-0 px-4 py-2 rounded-xl bg-ink text-canvas text-sm font-medium hover:bg-ink-soft"
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
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-lg font-medium tracking-tight text-ink">Health</h3>
        <WikiLink page={ADMIN_WIKI.admin} label="Wiki" className="text-xs" />
      </div>
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
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-lg font-medium tracking-tight text-ink">Generation throughput</h3>
        <WikiLink page={ADMIN_WIKI.admin} label="Wiki" className="text-xs" />
      </div>
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
              <span className="text-right hidden md:block">QA</span>
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
   workspace run reads as "The Drowning Bell (chapters…), The Floodmark (chapters…)"
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
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-lg font-medium tracking-tight text-ink">Resource trends</h3>
        <WikiLink page={ADMIN_WIKI.admin} label="Wiki" className="text-xs" />
      </div>
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
              <span className="text-right hidden sm:block">Engine</span>
              <span className="text-right hidden sm:block">QA</span>
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
                      <span className="text-right text-xs text-ink/50 font-mono hidden sm:block">
                        {r.modelKey ? ttsModelLabel(r.modelKey as TtsModelKey) : '–'}
                      </span>
                      <span
                        className="text-right text-xs text-ink/50 font-mono tabular-nums hidden sm:block"
                        data-testid="resource-qa-cell"
                      >
                        {fmtRtf(r.rerecordRtf)}
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

/* Analyzer eval-rate trend panel. Polls GET /api/generation/analyzer-stats,
   buckets by (manuscriptId, model) — NOT contiguous runs, so a concurrent
   multi-book run can't shatter a trend — and renders each bucket as a tok/s
   sparkline + per-(chapter,pass) table inside a bounded scroll. Falling
   tok/s = deteriorating (inverse of RTF). */
const ANALYZER_STATS_POLL_MS = 30000;

interface AnalyzerGroup {
  key: string;
  manuscriptId: string;
  model: string;
  bookTitle: string | null;
  rows: AnalyzerEvalRecord[];
  avgTokS: number | null;
}

/* Bucket by (manuscriptId, model) across the whole window (records arrive
   newest-first). Buckets ordered by most-recent row; rows kept newest-first. */
function groupByManuscriptModel(records: AnalyzerEvalRecord[]): AnalyzerGroup[] {
  const map = new Map<string, AnalyzerGroup>();
  for (const r of records) {
    const key = `${r.manuscriptId} ${r.model}`;
    let g = map.get(key);
    if (!g) {
      g = { key, manuscriptId: r.manuscriptId, model: r.model, bookTitle: r.bookTitle, rows: [], avgTokS: null };
      map.set(key, g);
    }
    g.rows.push(r);
    if (g.bookTitle == null && r.bookTitle) g.bookTitle = r.bookTitle;
  }
  const groups = [...map.values()];
  for (const g of groups) {
    const vals = g.rows.map((r) => r.evalTokS).filter((v): v is number => v != null);
    g.avgTokS = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return groups; // insertion order = first-seen = newest-first bucket ordering
}

const fmtTokS = (v: number | null): string => (v == null ? '–' : `${v.toFixed(1)} t/s`);
/* Tok/s wobble to ignore when deciding the row-level deterioration marker
   (distinct from the RTF-trend TREND_EPSILON above — different unit/scale). */
const ANALYZER_TOKS_EPSILON = 0.5;

function AnalyzerTrends() {
  const [records, setRecords] = useState<AnalyzerEvalRecord[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () =>
      api
        .getAnalyzerStats(400)
        .then((res) => {
          if (!cancelled) setRecords(res.records);
        })
        .catch(() => {
          /* Best-effort — leave the last-good snapshot in place. */
        });
    fetchOnce();
    const t = setInterval(fetchOnce, ANALYZER_STATS_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, []);

  const groups = useMemo(() => groupByManuscriptModel(records ?? []), [records]);
  const loaded = records != null;

  return (
    <section className="mt-10">
      <div className="flex items-center gap-2 mb-1">
        <h3 className="text-lg font-medium tracking-tight text-ink">Analyzer throughput</h3>
        <WikiLink page={ADMIN_WIKI.admin} label="Wiki" className="text-xs" />
      </div>
      <p className="text-sm text-ink/60 mb-4">
        Per-pass Ollama decode speed (eval tok/s), newest first — grouped by book &amp; model.
        Falling tok/s = slowing down.
      </p>

      {!loaded && <p className="text-sm text-ink/50">Loading telemetry…</p>}
      {loaded && groups.length === 0 && (
        <p className="text-sm text-ink/50">No analyzer telemetry recorded yet.</p>
      )}
      {loaded && groups.length > 0 && (
        <div
          data-testid="analyzer-trends-scroll"
          className="max-h-[28rem] overflow-y-auto scrollbar-thin rounded-3xl border border-ink/10 bg-white shadow-card"
        >
          {groups.map((g) => (
            <div
              key={g.key}
              data-testid="analyzer-trends-section"
              className="border-b border-ink/5 p-4 last:border-b-0"
            >
              <div className="flex items-baseline justify-between gap-2">
                <span className="font-semibold text-ink text-sm truncate">
                  {g.bookTitle ?? g.manuscriptId}
                </span>
                <span className="text-xs text-ink/50 shrink-0">
                  {g.model} · {g.rows.length} passes · avg {fmtTokS(g.avgTokS)}
                </span>
              </div>
              <TokSSparkline rows={g.rows} />
              <table className="mt-1 w-full text-xs">
                <thead>
                  <tr className="text-ink/50">
                    <th className="text-left font-medium">Ch</th>
                    <th className="text-left font-medium">Pass</th>
                    <th className="text-right font-medium">tok/s</th>
                    <th className="text-right font-medium">prompt t/s</th>
                    <th className="text-right font-medium">load</th>
                    <th className="text-right font-medium">calls</th>
                  </tr>
                </thead>
                <tbody>
                  {g.rows.map((r, i) => (
                    <AnalyzerRow
                      key={`${r.at}:${r.chapterId}:${r.stage}`}
                      row={r}
                      newerTokS={g.rows[i - 1]?.evalTokS}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function AnalyzerRow({ row, newerTokS }: { row: AnalyzerEvalRecord; newerTokS?: number | null }) {
  /* Falling tok/s vs the NEWER neighbour = deteriorating (rows are newest-first,
     so "newer" is the row above). Load spike + failure get their own tint. */
  const dropped =
    row.evalTokS != null && newerTokS != null && newerTokS < row.evalTokS - ANALYZER_TOKS_EPSILON;
  const loadSpike = row.loadMs > 200;
  return (
    <tr className={row.outcome === 'failed' ? 'text-magenta' : undefined} data-testid="analyzer-trends-row">
      <td>{row.chapterId}</td>
      <td>
        {row.stage}
        {row.chunkCount && row.chunkCount > 1 ? ` ⑂${row.chunkCount}` : ''}
      </td>
      <td className={`text-right ${dropped ? 'text-magenta' : ''}`}>
        {fmtTokS(row.evalTokS)}
        {dropped ? ' ▼' : ''}
      </td>
      <td className="text-right">{row.promptTokS == null ? '–' : row.promptTokS.toFixed(0)}</td>
      <td className={`text-right ${loadSpike ? 'text-magenta' : ''}`}>{Math.round(row.loadMs)}</td>
      <td className="text-right">{row.subCalls}</td>
    </tr>
  );
}

/* Hand-rolled inline SVG sparkline of eval tok/s across a group's rows. Rows
   arrive newest-first; plot oldest→newest left→right so the trend reads
   naturally. Null tok/s points are skipped. No charting dependency. */
function TokSSparkline({ rows }: { rows: AnalyzerEvalRecord[] }) {
  const series = rows
    .map((r) => r.evalTokS)
    .filter((v): v is number => v != null)
    .reverse(); // oldest→newest
  if (series.length < 2) return null;
  const max = Math.max(...series);
  const min = Math.min(...series);
  const span = max - min || 1;
  const pts = series
    .map((v, i) => `${(i / (series.length - 1)) * 260},${28 - ((v - min) / span) * 24}`)
    .join(' ');
  return (
    <svg
      width="100%"
      height="30"
      viewBox="0 0 260 30"
      preserveAspectRatio="none"
      data-testid="analyzer-toks-sparkline"
      role="img"
      aria-label={`tok/s trend across ${series.length} passes`}
    >
      <polyline fill="none" stroke="currentColor" strokeWidth="1.6" points={pts} className="text-magenta" />
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
        className="text-right text-xs text-ink/50 font-mono tabular-nums hidden md:block"
        data-testid="throughput-qa-cell"
      >
        {fmtRtf(chapter.rerecordRtf)}
      </span>
      <span
        className={`text-right font-mono font-medium tabular-nums ${style.cls}`}
        title={`${fmtClock(chapter.at)}${style.label ? ` · ${style.label}` : ''}`}
        data-testid="throughput-rtf-cell"
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
