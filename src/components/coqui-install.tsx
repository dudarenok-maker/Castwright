/* In-app Coqui XTTS v2 install affordance. Mirrors qwen-install.tsx but for the
   alternate Coqui engine:

     GET  /api/coqui/detect          → { state, installed }
     POST /api/coqui/install         → { id, status, step, ... } (202)
     GET  /api/coqui/install/:id     → poll
     POST /api/coqui/install/:id/recheck → re-probe

   Progress is STEP-based (install-coqui.mjs streams `[install-coqui]` step
   lines; the ~1.8 GB download has no single byte total). Self-contained — owns
   its polling loop, no redux. Unlike Qwen this is a weights-only pre-fetch
   (coqui-tts is already in the venv), and Coqui is the ALTERNATE engine, so the
   copy frames it as optional rather than the default. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PrimaryButton } from './primitives';

export type CoquiInstallState = 'not-installed' | 'weights-missing' | 'ready' | 'loaded';

export interface CoquiInstallJob {
  id: string;
  status: 'detecting' | 'installing' | 'installed' | 'error';
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

interface DetectResp {
  state: CoquiInstallState;
  installed: boolean;
}

const POLL_INTERVAL_MS = 1_500;

export function CoquiInstall({ onInstalled }: { onInstalled?: () => void } = {}) {
  const [detect, setDetect] = useState<DetectResp | null>(null);
  const [job, setJob] = useState<CoquiInstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doDetect = useCallback(async () => {
    try {
      const res = await fetch('/api/coqui/detect');
      if (!res.ok) throw new Error(`detect failed: HTTP ${res.status}`);
      setDetect((await res.json()) as DetectResp);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void doDetect();
  }, [doDetect]);

  useEffect(() => {
    if (!job) return;
    if (job.status === 'installed' || job.status === 'error') return;
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/coqui/install/${job.id}`);
        if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);
        const body = (await res.json()) as CoquiInstallJob;
        setJob(body);
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
      const res = await fetch('/api/coqui/install', { method: 'POST' });
      if (!res.ok) throw new Error(`start failed: HTTP ${res.status}`);
      setJob((await res.json()) as CoquiInstallJob);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (detect?.installed) {
    return (
      <div
        data-testid="coqui-install-ready"
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
      >
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-600" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-900">Coqui XTTS v2 is installed</p>
            <p className="text-xs text-emerald-900/70">
              Its zero-shot cloning voices are available in the per-character voice picker.
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

  if (job && (job.status === 'detecting' || job.status === 'installing')) {
    return (
      <div
        data-testid="coqui-install-job"
        data-job-status={job.status}
        className="rounded-2xl border border-ink/10 bg-white p-4 space-y-2"
      >
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full border-2 border-magenta border-t-transparent animate-spin" />
          <p className="text-sm font-semibold text-ink">
            {job.status === 'detecting' ? 'Checking your system…' : 'Installing Coqui XTTS v2…'}
          </p>
        </div>
        <p className="text-xs text-ink/60">
          {job.step ?? 'Downloading the XTTS v2 model (~1.8 GB) — this can take a few minutes.'}
        </p>
      </div>
    );
  }

  if (job && job.status === 'error') {
    return (
      <div
        data-testid="coqui-install-error"
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-2"
      >
        <p className="text-sm font-semibold text-rose-900">Coqui install failed</p>
        <p className="text-xs text-rose-900/80">{job.error ?? 'Install failed.'}</p>
        <PrimaryButton variant="dark" onClick={startInstall} icon={false}>
          {busy ? 'Retrying…' : 'Try again'}
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div
      data-testid="coqui-install-not-detected"
      className="rounded-2xl border border-ink/10 bg-white p-4 space-y-3"
    >
      <div>
        <p className="text-sm font-semibold text-ink">Coqui XTTS v2 is not installed</p>
        <p className="mt-1 text-xs text-ink/55">
          Coqui XTTS v2 is an alternate engine — zero-shot voice cloning from a short reference clip,
          plus ~30 baked multilingual voices. Installing pre-fetches the model (~1.8 GB) and it needs
          ~3 GB VRAM to run. Optional: Kokoro and Qwen cover the defaults — install Coqui only if you
          want its zero-shot cloning.
        </p>
      </div>
      <PrimaryButton variant="dark" onClick={startInstall} disabled={busy} icon={false}>
        {busy ? 'Starting…' : 'Install Coqui XTTS v2'}
      </PrimaryButton>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
