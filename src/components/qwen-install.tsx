/* In-app Qwen3-TTS install affordance (qwen-default phase 3). Models the
   Ollama installer (ollama-install.tsx) but for the Qwen bespoke-voice engine:

     GET  /api/qwen/detect          → { state, installed }
     POST /api/qwen/install         → { id, status, step, ... } (202)
     GET  /api/qwen/install/:id     → poll
     POST /api/qwen/install/:id/recheck → re-probe

   Progress is STEP-based (the underlying install-qwen3.mjs streams
   `[install-qwen3]` step lines; the multi-GB HF download has no single byte
   total). Self-contained — owns its polling loop, no redux. */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PrimaryButton } from './primitives';

export type QwenInstallState = 'not-installed' | 'weights-missing' | 'ready' | 'loaded';

export interface QwenInstallJob {
  id: string;
  status: 'detecting' | 'installing' | 'installed' | 'error';
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

interface DetectResp {
  state: QwenInstallState;
  installed: boolean;
}

const POLL_INTERVAL_MS = 1_500;

export function QwenInstall() {
  const [detect, setDetect] = useState<DetectResp | null>(null);
  const [job, setJob] = useState<QwenInstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const doDetect = useCallback(async () => {
    try {
      const res = await fetch('/api/qwen/detect');
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
        const res = await fetch(`/api/qwen/install/${job.id}`);
        if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);
        const body = (await res.json()) as QwenInstallJob;
        setJob(body);
        if (body.status === 'installed') void doDetect();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [job, doDetect]);

  const startInstall = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/qwen/install', { method: 'POST' });
      if (!res.ok) throw new Error(`start failed: HTTP ${res.status}`);
      setJob((await res.json()) as QwenInstallJob);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  if (detect?.installed) {
    return (
      <div
        data-testid="qwen-install-ready"
        className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
      >
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-emerald-600" />
          <div className="flex-1">
            <p className="text-sm font-semibold text-emerald-900">Qwen3-TTS is installed</p>
            <p className="text-xs text-emerald-900/70">
              Bespoke per-character voices are available. New books default to Qwen.
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
        data-testid="qwen-install-job"
        data-job-status={job.status}
        className="rounded-2xl border border-ink/10 bg-white p-4 space-y-2"
      >
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full border-2 border-magenta border-t-transparent animate-spin" />
          <p className="text-sm font-semibold text-ink">
            {job.status === 'detecting' ? 'Checking your system…' : 'Installing Qwen3-TTS…'}
          </p>
        </div>
        <p className="text-xs text-ink/60">
          {job.step ?? 'Downloading the Base + VoiceDesign models (~5 GB) — this can take a few minutes.'}
        </p>
      </div>
    );
  }

  if (job && job.status === 'error') {
    return (
      <div
        data-testid="qwen-install-error"
        className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-2"
      >
        <p className="text-sm font-semibold text-rose-900">Qwen install failed</p>
        <p className="text-xs text-rose-900/80">{job.error ?? 'Install failed.'}</p>
        <PrimaryButton variant="dark" onClick={startInstall} icon={false}>
          {busy ? 'Retrying…' : 'Try again'}
        </PrimaryButton>
      </div>
    );
  }

  return (
    <div
      data-testid="qwen-install-not-detected"
      className="rounded-2xl border border-ink/10 bg-white p-4 space-y-3"
    >
      <div>
        <p className="text-sm font-semibold text-ink">Qwen3-TTS is not installed</p>
        <p className="mt-1 text-xs text-ink/55">
          Qwen3-TTS designs a unique voice per character for the best quality. Installing downloads
          the Base + VoiceDesign models (~5 GB) into the Hugging Face cache; it runs in the
          background and you can keep working. Until it's installed, books render in Kokoro.
        </p>
      </div>
      <PrimaryButton variant="dark" onClick={startInstall} disabled={busy} icon={false}>
        {busy ? 'Starting…' : 'Install Qwen3-TTS'}
      </PrimaryButton>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
