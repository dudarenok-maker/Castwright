/* Plan 61 — in-app Ollama install affordance.
 *
 * State machine surfaced to the user:
 *   not-detected → installing (with progress %) → installed-and-ready
 *
 * Backed by:
 *   GET  /api/ollama/detect      → { installed, version }
 *   POST /api/ollama/install     → { id, status, ... } (202)
 *   GET  /api/ollama/install/:id → poll
 *   POST /api/ollama/install/:id/recheck → re-probe (Windows GUI path)
 *
 * The component is intentionally self-contained — it owns its polling
 * loop and doesn't reach into redux. The Account → Models pane mounts
 * it and renders it as a fully-encapsulated card. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PrimaryButton } from './primitives';

export interface InstallJob {
  id: string;
  status: 'idle' | 'detecting' | 'downloading' | 'installing' | 'installed' | 'error';
  platform: string;
  arch: string;
  bytesReceived: number;
  bytesTotal: number | null;
  manualInstallerPath: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

interface DetectResp {
  installed: boolean;
  version: string | null;
}

/* Poll interval while a job is mid-flight. Slow enough to keep the
   server happy, fast enough that a progress bar feels responsive. */
const POLL_INTERVAL_MS = 1_000;

function pct(job: InstallJob): number | null {
  if (job.status === 'installed') return 100;
  if (!job.bytesTotal || job.bytesTotal === 0) return null;
  return Math.round((job.bytesReceived / job.bytesTotal) * 100);
}

function formatMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function OllamaInstall({ onInstalled }: { onInstalled?: () => void } = {}) {
  const [detect, setDetect] = useState<DetectResp | null>(null);
  const [job, setJob] = useState<InstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doDetect = useCallback(async () => {
    try {
      const res = await fetch('/api/ollama/detect');
      if (!res.ok) throw new Error(`detect failed: HTTP ${res.status}`);
      const body = (await res.json()) as DetectResp;
      setDetect(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void doDetect();
  }, [doDetect]);

  /* Poll the active job once we have one. The polling loop tears
     itself down on terminal states ('installed' / 'error'). */
  useEffect(() => {
    if (!job) return;
    if (job.status === 'installed' || job.status === 'error') return;
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/ollama/install/${job.id}`);
        if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);
        const body = (await res.json()) as InstallJob;
        setJob(body);
        /* If the job finished while we were polling, refresh the
           top-level detect probe too so the "installed" banner shows
           the new version string. */
        if (body.status === 'installed') {
          void doDetect();
          onInstalled?.();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [job, doDetect, onInstalled]);

  const startInstall = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/ollama/install', { method: 'POST' });
      if (!res.ok) throw new Error(`start failed: HTTP ${res.status}`);
      const body = (await res.json()) as InstallJob;
      setJob(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const recheck = async () => {
    if (!job) return;
    setBusy(true);
    try {
      const res = await fetch(`/api/ollama/install/${job.id}/recheck`, { method: 'POST' });
      if (!res.ok) throw new Error(`recheck failed: HTTP ${res.status}`);
      const body = (await res.json()) as InstallJob;
      setJob(body);
      void doDetect();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /* Three top-level states the UI surfaces:
       1. installed (either detected at boot or the job just finished)
       2. in-flight job (detecting / downloading / installing)
       3. not-installed, no active job — show the "Install Ollama" button
     Plus error overlays. */

  if (detect?.installed) {
    return (
      <div
        data-testid="ollama-install-ready"
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
      >
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-600" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-900">Ollama is installed</p>
            <p className="text-xs text-emerald-900/70 font-mono">
              {detect.version ?? 'version unknown'}
            </p>
          </div>
          <button
            type="button"
            onClick={doDetect}
            disabled={busy}
            className="px-3 py-1.5 rounded-full border border-emerald-300 bg-white text-xs text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
          >
            Re-check
          </button>
        </div>
      </div>
    );
  }

  if (job && job.status !== 'idle') {
    const progress = pct(job);
    return (
      <div
        data-testid="ollama-install-job"
        data-job-status={job.status}
        className="rounded-2xl border border-ink/10 bg-white p-4 space-y-3"
      >
        <div className="flex items-center justify-between">
          <p className="text-sm font-semibold text-ink">
            {job.status === 'detecting' && 'Checking your system…'}
            {job.status === 'downloading' && 'Downloading Ollama installer…'}
            {job.status === 'installing' && 'Installing Ollama…'}
            {job.status === 'installed' && 'Ollama installed.'}
            {job.status === 'error' && 'Install failed.'}
          </p>
          <span className="text-xs font-mono text-ink/55">
            {job.platform}/{job.arch}
          </span>
        </div>

        {job.status === 'downloading' && (
          <div>
            <div className="h-2 rounded-full bg-ink/10 overflow-hidden">
              <div
                data-testid="ollama-install-progress-bar"
                className="h-full bg-magenta transition-all"
                style={{ width: `${progress ?? 0}%` }}
              />
            </div>
            <p className="mt-1 text-xs text-ink/60">
              {progress !== null ? `${progress}%` : 'Starting…'}
              {' · '}
              {formatMB(job.bytesReceived)}
              {job.bytesTotal ? ` / ${formatMB(job.bytesTotal)}` : ''}
            </p>
          </div>
        )}

        {job.status === 'installing' && job.manualInstallerPath && (
          <div className="rounded-xl bg-amber-50 border border-amber-200 p-3 space-y-2">
            <p className="text-xs text-amber-900">
              Windows installer is GUI-based. Double-click this file to finish the install:
            </p>
            <p className="text-xs font-mono text-amber-900/85 break-all">
              {job.manualInstallerPath}
            </p>
            <PrimaryButton variant="dark" onClick={recheck} icon={false}>
              {busy ? 'Re-checking…' : "I've finished — re-check"}
            </PrimaryButton>
          </div>
        )}

        {job.status === 'error' && (
          <div className="rounded-xl bg-rose-50 border border-rose-200 p-3 space-y-2">
            <p className="text-xs text-rose-900">{job.error ?? 'Install failed.'}</p>
            <PrimaryButton variant="dark" onClick={startInstall} icon={false}>
              {busy ? 'Retrying…' : 'Try again'}
            </PrimaryButton>
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid="ollama-install-not-detected"
      className="rounded-2xl border border-ink/10 bg-white p-4 space-y-3"
    >
      <div>
        <p className="text-sm font-semibold text-ink">Ollama is not installed</p>
        <p className="mt-1 text-xs text-ink/55">
          The local analyzer needs Ollama to run on-device. Install it here, or set the analyzer
          engine to Gemini above.
        </p>
      </div>
      <PrimaryButton variant="dark" onClick={startInstall} disabled={busy} icon={false}>
        {busy ? 'Starting…' : 'Install Ollama'}
      </PrimaryButton>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
