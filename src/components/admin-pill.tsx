import { useEffect, useState } from 'react';
import { api, type DiagnosticsStatus } from '../lib/api';

interface Props {
  onClick: () => void;
  /** Whether the Admin view is the active stage (drives the pressed style). */
  active: boolean;
  /** Override the RTF poll cadence in tests. */
  pollMs?: number;
  /** Override the diagnostics (status-dot) poll cadence in tests. */
  diagnosticsPollMs?: number;
}

const DEFAULT_POLL_MS = 4000;
/* Diagnostics are not fast-moving and the probes spawn processes / do disk I/O,
   so the status dot refreshes on the slow 30 s health cadence, not the 4 s RTF
   tick. */
const DEFAULT_DIAGNOSTICS_POLL_MS = 30000;

/* All-users top-bar entry to the Admin watch console (fs-18; was the dev-only
   "wt" worktrees pill, plan 86). Two independent self-polls:

   - A 30 s GET /api/diagnostics poll drives a green/amber/red health dot from
     the board's `overall` severity (grey before the first result or on error —
     a blip on the diagnostics endpoint itself shouldn't scream red).
   - The original 4 s GET /api/generation/stats poll shows the LIVE per-batch
     RTF (falling back to the per-chapter rollup) while a book renders, so the
     number moves mid-chapter. RTF convention: wall ÷ audio, < 1 = faster than
     realtime. Idle → no number, just the dot + "Admin". */
const DOT_CLASS: Record<DiagnosticsStatus | 'unknown', string> = {
  ok: 'bg-green-500',
  warn: 'bg-amber-500',
  fail: 'bg-rose-500',
  unknown: 'bg-ink/30',
};

const DOT_LABEL: Record<DiagnosticsStatus | 'unknown', string> = {
  ok: 'all systems healthy',
  warn: 'warnings present',
  fail: 'something is failing',
  unknown: 'checking…',
};

export function AdminPill({
  onClick,
  active,
  pollMs = DEFAULT_POLL_MS,
  diagnosticsPollMs = DEFAULT_DIAGNOSTICS_POLL_MS,
}: Props) {
  const [rtf, setRtf] = useState<number | null>(null);
  const [live, setLive] = useState(false);
  const [health, setHealth] = useState<DiagnosticsStatus | 'unknown'>('unknown');

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const stats = await api.getGenerationStats();
        if (!alive) return;
        // Prefer the live per-batch figure; fall back to the per-chapter rollup.
        const next = stats.liveBatchRtf ?? stats.rtf;
        setRtf(next);
        setLive(stats.liveBatchRtf != null);
      } catch {
        if (alive) {
          setRtf(null);
          setLive(false);
        }
      }
    };
    void tick();
    const id = setInterval(() => void tick(), pollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [pollMs]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const diag = await api.getDiagnostics();
        if (alive) setHealth(diag.overall);
      } catch {
        /* Leave the last known health in place on a transient blip. */
      }
    };
    void tick();
    const id = setInterval(() => void tick(), diagnosticsPollMs);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [diagnosticsPollMs]);

  const generating = rtf != null;
  const label =
    `Admin — ${DOT_LABEL[health]}` +
    (generating
      ? ` · ${live ? 'live per-batch' : 'per-chapter'} generation RTF ${rtf.toFixed(2)} — wall ÷ audio (<1 = faster than realtime)`
      : '');

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid="topbar-admin-link"
      className={`text-xs font-mono px-2 py-1 rounded-md transition-colors hover:bg-ink/5 inline-flex items-center gap-1.5 ${active ? 'bg-ink/10 ring-1 ring-ink/20' : 'text-ink/50'}`}
    >
      <span
        className={`inline-block w-2 h-2 rounded-full ${DOT_CLASS[health]}`}
        data-testid="topbar-health-dot"
        data-status={health}
      />
      Admin
      {generating && (
        <span className="text-magenta" data-testid="topbar-rtf">
          {rtf.toFixed(2)}
        </span>
      )}
    </button>
  );
}
