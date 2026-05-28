import { useEffect, useState } from 'react';
import { api } from '../lib/api';

interface Props {
  onClick: () => void;
  /** Whether the worktrees view is the active stage (drives the pressed style). */
  active: boolean;
  /** Override the poll cadence in tests. */
  pollMs?: number;
}

const DEFAULT_POLL_MS = 4000;

/* Dev-only top-bar pill. Serves two purposes now: it's still the plan-86
   worktrees-dashboard link, AND a live generation-RTF readout. While a book
   renders it shows the LIVE per-batch RTF from GET /api/generation/stats
   (`liveBatchRtf`, updated as each Qwen batch lands ~every batch), falling back
   to the per-chapter rolling figure (`rtf`) when no batch is recent — so the
   number moves mid-chapter, not just at chapter boundaries. Idle (nothing
   generating) → it's just the "wt" link.

   RTF convention matches the sidecar logs: wall ÷ audio, so < 1 is
   faster-than-realtime. Only mounted in DEV builds (see top-bar.tsx), so the
   4 s poll never runs in production. */
export function WorktreesRtfPill({ onClick, active, pollMs = DEFAULT_POLL_MS }: Props) {
  const [rtf, setRtf] = useState<number | null>(null);
  const [live, setLive] = useState(false);

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

  const generating = rtf != null;
  const label = generating
    ? `Worktrees (dev) · ${live ? 'live per-batch' : 'per-chapter'} generation RTF ${rtf.toFixed(2)} — wall ÷ audio (<1 = faster than realtime)`
    : 'Worktrees (dev)';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      data-testid="topbar-worktrees-link"
      className={`text-xs font-mono px-2 py-1 rounded-md transition-colors hover:bg-ink/5 ${active ? 'bg-ink/10 ring-1 ring-ink/20' : 'text-ink/50'}`}
    >
      wt
      {generating && (
        <span className="ml-1 text-magenta" data-testid="topbar-rtf">
          {rtf.toFixed(2)}
        </span>
      )}
    </button>
  );
}
