/* In-app voice-engine runtime bootstrap affordance (fs-21 wave 1b).
   Three states driven by GET /api/setup/venv/detect:

     1. venvPresent (or job installed)  → green "Voice engine runtime ready" card
     2. !venvPresent && pythonFound     → one-click "Set up the voice engine runtime"
                                          button that POSTs bootstrap and polls the job
     3. !venvPresent && !pythonFound    → decision-Z degrade: per-OS manual
                                          instructions + Re-check button

   Routes:
     GET  /api/setup/venv/detect          → { state, venvPresent, pythonFound, installed }
     POST /api/setup/venv/bootstrap       → { id, status, step, error, ... } (202)
     GET  /api/setup/venv/bootstrap/:id   → poll

   Self-contained — owns its polling loop, no redux. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PrimaryButton } from './primitives';

export interface VenvBootstrapJob {
  id: string;
  status: 'installing' | 'installed' | 'error';
  step: string | null;
  error: string | null;
}

interface DetectResp {
  state: string;
  venvPresent: boolean;
  pythonFound: boolean;
  installed: boolean;
}

const POLL_INTERVAL_MS = 1_500;

export function VenvBootstrap({ onBootstrapped }: { onBootstrapped?: () => void } = {}) {
  const [detect, setDetect] = useState<DetectResp | null>(null);
  const [job, setJob] = useState<VenvBootstrapJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doDetect = useCallback(async () => {
    try {
      const res = await fetch('/api/setup/venv/detect');
      if (!res.ok) throw new Error(`detect failed: HTTP ${res.status}`);
      const body = (await res.json()) as DetectResp;
      setDetect(body);
      if (body.venvPresent || body.installed) {
        onBootstrapped?.();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [onBootstrapped]);

  useEffect(() => {
    void doDetect();
  }, [doDetect]);

  useEffect(() => {
    if (!job) return;
    if (job.status === 'installed' || job.status === 'error') return;
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/setup/venv/bootstrap/${job.id}`);
        if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);
        const body = (await res.json()) as VenvBootstrapJob;
        setJob(body);
        if (body.status === 'installed') {
          void doDetect();
          onBootstrapped?.();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [job, doDetect, onBootstrapped]);

  const startBootstrap = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/setup/venv/bootstrap', { method: 'POST' });
      if (!res.ok) throw new Error(`start failed: HTTP ${res.status}`);
      setJob((await res.json()) as VenvBootstrapJob);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // State 1: venv already present (or just installed)
  if (detect?.venvPresent || detect?.installed || job?.status === 'installed') {
    return (
      <div
        data-testid="venv-bootstrap-ready"
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
      >
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-600" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-900">Voice engine runtime ready</p>
            <p className="text-xs text-emerald-900/70">
              The Python runtime is set up — all voice engines can be loaded.
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

  // Job in progress
  if (job && job.status === 'installing') {
    return (
      <div
        data-testid="venv-bootstrap-job"
        data-job-status={job.status}
        className="rounded-2xl border border-ink/10 bg-canvas p-4 space-y-2"
      >
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full border-2 border-magenta border-t-transparent animate-spin" />
          <p className="text-sm font-semibold text-ink">Setting up the voice engine runtime…</p>
        </div>
        <p className="text-xs text-ink/60">
          {job.step ??
            'This downloads ~2 GB of Python packages and can take several minutes.'}
        </p>
        <p className="text-xs text-ink/40">
          This downloads ~2 GB of Python packages and can take several minutes.
        </p>
      </div>
    );
  }

  // Job error
  if (job && job.status === 'error') {
    return (
      <div
        data-testid="venv-bootstrap-error"
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-2"
      >
        <p className="text-sm font-semibold text-rose-900">Setup failed</p>
        <p className="text-xs text-rose-900/80">{job.error ?? 'Bootstrap failed.'}</p>
        <PrimaryButton variant="dark" onClick={startBootstrap} icon={false}>
          {busy ? 'Retrying…' : 'Try again'}
        </PrimaryButton>
      </div>
    );
  }

  // State 3: decision-Z — no Python found → manual instructions
  if (detect && !detect.pythonFound) {
    return (
      <div
        data-testid="venv-bootstrap-manual"
        className="rounded-2xl border border-ink/10 bg-canvas p-4 space-y-3"
      >
        <div>
          <p className="text-sm font-semibold text-ink">Python 3.11 not found</p>
          <p className="mt-1 text-xs text-ink/55">
            The voice engine runtime requires Python 3.11. Install it from{' '}
            <span className="font-medium text-ink">python.org</span>, then run these
            commands from the <code className="text-xs bg-ink/5 px-1 rounded">server/tts-sidecar</code>{' '}
            directory:
          </p>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink/70 uppercase tracking-wide">Windows</p>
          <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
            {`py -3.11 -m venv .venv\n.venv\\Scripts\\python -m pip install -r requirements.txt`}
          </pre>
        </div>

        <div className="space-y-2">
          <p className="text-xs font-semibold text-ink/70 uppercase tracking-wide">
            macOS / Linux
          </p>
          <pre className="text-xs bg-ink/5 text-ink rounded-lg p-3 overflow-x-auto leading-relaxed">
            {`python3.11 -m venv .venv\n.venv/bin/python -m pip install -r requirements.txt`}
          </pre>
        </div>

        <button
          type="button"
          onClick={doDetect}
          className="px-3 py-1.5 rounded-full border border-ink/20 bg-white text-xs text-ink hover:bg-ink/5"
        >
          Re-check
        </button>
        {error && <p className="text-xs text-rose-700">{error}</p>}
      </div>
    );
  }

  // State 2: Python found but no venv → one-click setup
  return (
    <div
      data-testid="venv-bootstrap-setup"
      className="rounded-2xl border border-ink/10 bg-canvas p-4 space-y-3"
    >
      <div>
        <p className="text-sm font-semibold text-ink">Voice engine runtime not set up</p>
        <p className="mt-1 text-xs text-ink/55">
          Voice engines need a Python runtime with their dependencies installed.
          This is a one-time setup (~2 GB download).
        </p>
      </div>
      <PrimaryButton variant="dark" onClick={startBootstrap} disabled={busy} icon={false}>
        {busy ? 'Starting…' : 'Set up the voice engine runtime'}
      </PrimaryButton>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
