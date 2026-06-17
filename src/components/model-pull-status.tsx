/* Plan 61 — model pull UI on the analyzer section.
 *
 * Surfaces:
 *   - which models are present on disk (from /api/ollama/health.models)
 *   - which model is the configured default (highlight)
 *   - a "Pull" button that fires POST /api/ollama/pull and tracks the
 *     resulting job via GET /api/ollama/pull/:id
 *   - a "Refresh available models" button that POSTs /api/ollama/refresh
 *     and re-renders the list
 *
 * Per-step state machine surfaced via the pull job:
 *   idle → pulling (bytesReceived / bytesTotal / lastStatusMessage)
 *        → pulled  → terminal
 *        → error   → terminal (with retry)
 *
 * Pure UI — no redux, no global state. Tests render this directly with
 * `fetch` mocked. */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface PullJob {
  id: string;
  model: string;
  status: 'idle' | 'pulling' | 'pulled' | 'error';
  lastStatusMessage: string;
  bytesReceived: number;
  bytesTotal: number | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export interface OllamaHealthEnvelope {
  status: 'reachable' | 'unreachable';
  url: string;
  models?: string[];
  expectedModel?: string;
  modelPulled?: boolean;
  /** Curated pull-allowlist, echoed by /api/ollama/health and /refresh. Driving
      the rows off this (not just the redux prop) makes "Refresh available
      models" self-healing — a refresh response repopulates an empty list. */
  pullable?: string[];
  error?: string;
}

interface ModelPullStatusProps {
  /** Initial health envelope — typically passed in from the parent so
      the component doesn't need a redundant probe on mount. */
  health: OllamaHealthEnvelope | null;
  /** Allowlist of pullable models — the server's curated install list
      (account.pullableModels). Centralised so the UI can grey out
      anything not pullable. */
  pullableModels: readonly string[];
  /** Called once when a pull job reaches the terminal 'pulled' state, so a
      parent can re-fetch the model list (e.g. dispatch fetchAnalyzerModels). */
  onPulled?: () => void;
}

const POLL_INTERVAL_MS = 1_000;

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function ModelPullStatus({ health, pullableModels, onPulled }: ModelPullStatusProps) {
  const [localHealth, setLocalHealth] = useState<OllamaHealthEnvelope | null>(health);
  const [refreshing, setRefreshing] = useState(false);
  const [pullJob, setPullJob] = useState<PullJob | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /* Guard so onPulled fires exactly once per terminal-pulled job, not on
     every re-run of the polling effect. */
  const notifiedPulledId = useRef<string | null>(null);

  useEffect(() => {
    setLocalHealth(health);
  }, [health]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch('/api/ollama/refresh', { method: 'POST' });
      if (!res.ok) throw new Error(`refresh failed: HTTP ${res.status}`);
      const body = (await res.json()) as OllamaHealthEnvelope;
      setLocalHealth(body);
    } catch (e) {
      setPullError(e instanceof Error ? e.message : String(e));
    } finally {
      setRefreshing(false);
    }
  }, []);

  /* Poll the active pull job until it reaches a terminal state. */
  useEffect(() => {
    if (!pullJob) return;
    if (pullJob.status === 'pulled' || pullJob.status === 'error') {
      /* Terminal — one final refresh so the "pulled" indicator updates. */
      if (pullJob.status === 'pulled') {
        void refresh();
        if (notifiedPulledId.current !== pullJob.id) {
          notifiedPulledId.current = pullJob.id;
          onPulled?.();
        }
      }
      return;
    }
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ollama/pull/${pullJob.id}`);
        if (!res.ok) throw new Error(`pull poll failed: HTTP ${res.status}`);
        const body = (await res.json()) as PullJob;
        setPullJob(body);
      } catch (e) {
        setPullError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [pullJob, refresh, onPulled]);

  const startPull = async (model: string) => {
    setPullError(null);
    try {
      const res = await fetch('/api/ollama/pull', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const body = (await res.json()) as PullJob | { error: string };
      if (!res.ok) {
        setPullError('error' in body ? body.error : `HTTP ${res.status}`);
        return;
      }
      setPullJob(body as PullJob);
    } catch (e) {
      setPullError(e instanceof Error ? e.message : String(e));
    }
  };

  /* Curated pull-allowlist comes from the live health envelope when present (so
     "Refresh available models" repopulates it without a reload), falling back to
     the redux prop for callers that don't thread pullable through health. */
  const curated = localHealth?.pullable ?? [...pullableModels];
  const installedTags = localHealth?.models ?? [];
  const presentTags = new Set<string>(installedTags);
  const expectedModel = localHealth?.expectedModel;
  const isReachable = localHealth?.status === 'reachable';
  /* Installed-but-uncurated tags (e.g. a custom local Ollama model not in the
     allowlist) are unioned in as read-only on-disk rows, so this list is a
     complete picture of what the analyzer can run — mirroring the inventory. */
  const coveredByCurated = (tag: string) =>
    curated.some((m) => m === tag || isPrefixMatch(m, new Set([tag])));
  const extraInstalled = installedTags.filter((t) => !coveredByCurated(t));

  return (
    <div data-testid="model-pull-status" className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-ink/55">
          Models currently on disk (via <code className="font-mono">ollama list</code>).
        </p>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          data-testid="model-pull-refresh"
          className="px-3 py-1.5 rounded-full border border-ink/15 bg-white text-xs text-ink hover:bg-ink/5 disabled:opacity-50"
        >
          {refreshing ? 'Refreshing…' : 'Refresh available models'}
        </button>
      </div>

      {!isReachable && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
          Local Ollama daemon is unreachable. Pulls go through the daemon — start it (or
          install Ollama in the section above) and click "Refresh available models."
        </div>
      )}

      <ul className="divide-y divide-ink/5 rounded-xl border border-ink/10 overflow-hidden">
        {curated.map((model) => {
          const present = presentTags.has(model) || isPrefixMatch(model, presentTags);
          const isDefault = model === expectedModel;
          const isActivePull =
            pullJob && pullJob.model === model && pullJob.status === 'pulling';
          return (
            <li
              key={model}
              data-testid={`model-row-${model}`}
              className="flex items-center gap-3 px-3 py-2 bg-white"
            >
              <span
                className={`w-2 h-2 rounded-full ${
                  present ? 'bg-emerald-600' : 'bg-ink/20'
                }`}
                aria-hidden
              />
              <div className="flex-1">
                <p className="text-sm font-mono text-ink">{model}</p>
                <p className="text-xs text-ink/55">
                  {present ? 'On disk' : 'Not pulled yet'}
                  {isDefault ? ' · configured default' : ''}
                </p>
              </div>
              {isActivePull ? (
                <PullProgress job={pullJob} />
              ) : (
                <button
                  type="button"
                  onClick={() => startPull(model)}
                  disabled={!isReachable || present}
                  data-testid={`model-pull-${model}`}
                  className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs disabled:opacity-30 disabled:cursor-not-allowed hover:bg-ink-soft"
                >
                  {present ? 'Pulled' : 'Pull'}
                </button>
              )}
            </li>
          );
        })}
        {/* Installed tags outside the curated allowlist — read-only on-disk rows
            so a custom local model (e.g. a renamed Gemma) still shows here. */}
        {extraInstalled.map((model) => {
          const isDefault = model === expectedModel;
          return (
            <li
              key={model}
              data-testid={`model-row-${model}`}
              className="flex items-center gap-3 px-3 py-2 bg-white"
            >
              <span className="w-2 h-2 rounded-full bg-emerald-600" aria-hidden />
              <div className="flex-1">
                <p className="text-sm font-mono text-ink">{model}</p>
                <p className="text-xs text-ink/55">
                  On disk · installed{isDefault ? ' · configured default' : ''}
                </p>
              </div>
              <span
                data-testid={`model-installed-${model}`}
                className="px-3 py-1.5 rounded-full border border-ink/10 bg-ink/5 text-xs text-ink/50"
              >
                Installed
              </span>
            </li>
          );
        })}
      </ul>

      {pullJob && pullJob.status === 'error' && (
        <div className="rounded-xl border border-rose-200 bg-rose-50 p-3 text-xs text-rose-900">
          <p className="font-semibold">Pull failed.</p>
          <p>{pullJob.error}</p>
        </div>
      )}
      {pullError && <p className="text-xs text-rose-700">{pullError}</p>}
    </div>
  );
}

function PullProgress({ job }: { job: PullJob }) {
  const pct = job.bytesTotal && job.bytesTotal > 0
    ? Math.round((job.bytesReceived / job.bytesTotal) * 100)
    : null;
  return (
    <div
      data-testid={`model-pull-progress-${job.model}`}
      className="w-48 space-y-1"
    >
      <div className="h-1.5 rounded-full bg-ink/10 overflow-hidden">
        <div
          className="h-full bg-magenta transition-all"
          style={{ width: `${pct ?? 5}%` }}
        />
      </div>
      <p className="text-[10px] font-mono text-ink/55">
        {job.lastStatusMessage}
        {' · '}
        {pct !== null
          ? `${pct}% (${formatMB(job.bytesReceived)} / ${formatMB(job.bytesTotal ?? 0)})`
          : formatMB(job.bytesReceived)}
      </p>
    </div>
  );
}

/* Ollama canonicalises tags — `qwen3.5:4b` may surface as
   `qwen3.5:4b-instruct-q4_K_M`. Treat the family root as present
   whenever a prefix match exists, mirroring the server-side health
   check at server/src/routes/ollama-health.ts. */
function isPrefixMatch(model: string, tags: Set<string>): boolean {
  for (const t of tags) {
    if (t === model || t.startsWith(`${model}-`)) return true;
    if (t.split(':')[0] === model.split(':')[0] && t.startsWith(`${model.split(':')[0]}:`)) {
      return true;
    }
  }
  return false;
}
