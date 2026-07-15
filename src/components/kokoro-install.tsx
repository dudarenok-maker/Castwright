/* In-app Kokoro install affordance. Mirrors coqui-install.tsx but for the
   default Kokoro engine. CONTROLLED: the idle state comes from a required
   `status` prop (derived from models-status by the parent); the card owns only
   the install-job POST/poll:

     POST /api/kokoro/install         → { id, status, step, ... } (202)
     GET  /api/kokoro/install/:id     → poll

   Progress is STEP-based (install-kokoro.mjs streams step lines; the ~330 MB
   download has no single byte total). Kokoro is the DEFAULT engine — copy frames
   it as such. */

import { useEffect, useRef, useState } from 'react';
import { PrimaryButton } from './primitives';
import type { EngineHealthState } from '../lib/api';

export interface KokoroInstallJob {
  id: string;
  status: 'detecting' | 'installing' | 'installed' | 'error';
  step: string | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

const POLL_INTERVAL_MS = 1_500;

export function KokoroInstall({
  status,
  onInstalled,
}: {
  status: { state: EngineHealthState; packageBroken: boolean };
  onInstalled?: () => void;
}) {
  const [job, setJob] = useState<KokoroInstallJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!job) return;
    if (job.status === 'installed' || job.status === 'error') return;
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`/api/kokoro/install/${job.id}`);
        if (!res.ok) throw new Error(`poll failed: HTTP ${res.status}`);
        const body = (await res.json()) as KokoroInstallJob;
        setJob(body);
        if (body.status === 'installed') {
          onInstalled?.();
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_INTERVAL_MS);
    return () => {
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, [job, onInstalled]);

  const startInstall = async () => {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch('/api/kokoro/install', { method: 'POST' });
      if (!res.ok) throw new Error(`start failed: HTTP ${res.status}`);
      setJob((await res.json()) as KokoroInstallJob);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const ready = (status.state === 'ready' || status.state === 'loaded') && !status.packageBroken;

  if (!job || job.status === 'installed') {
    if (ready) {
      return (
        <div
          data-testid="kokoro-install-ready"
          className="rounded-2xl border border-emerald-200 bg-emerald-50 p-4"
        >
          <div className="flex items-center gap-3">
            <span className="w-2 h-2 rounded-full bg-emerald-600" />
            <div className="flex-1">
              <p className="text-sm font-semibold text-emerald-900">Kokoro is installed</p>
              <p className="text-xs text-emerald-900/70">
                The default voice engine is ready — English voices are available in the per-character voice picker.
              </p>
            </div>
            <button
              type="button"
              onClick={() => onInstalled?.()}
              className="px-3 py-1.5 rounded-full border border-emerald-300 bg-white text-xs text-emerald-900 hover:bg-emerald-100 disabled:opacity-50"
            >
              Re-check
            </button>
          </div>
        </div>
      );
    }

    if (status.packageBroken) {
      return (
        <div
          data-testid="kokoro-install-repair"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-3"
        >
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Kokoro is installed but fails to load
            </p>
            <p className="mt-1 text-xs text-amber-900/70">
              The Kokoro package is on disk but the voice engine can't import it. Repair reinstalls
              the package.
            </p>
          </div>
          <PrimaryButton variant="dark" onClick={startInstall} disabled={busy} icon={false}>
            {busy ? 'Starting…' : 'Repair Kokoro'}
          </PrimaryButton>
          {error && <p className="text-xs text-rose-700">{error}</p>}
        </div>
      );
    }

    if (status.state === 'package-missing') {
      return (
        <div
          data-testid="kokoro-install-package-missing"
          className="rounded-2xl border border-amber-200 bg-amber-50 p-4 space-y-3"
        >
          <div>
            <p className="text-sm font-semibold text-amber-900">
              Kokoro weights present — package needs repair
            </p>
            <p className="mt-1 text-xs text-amber-900/70">
              The voice weights are downloaded but the Kokoro package is missing. Repair reinstalls
              it.
            </p>
          </div>
          <PrimaryButton variant="dark" onClick={startInstall} disabled={busy} icon={false}>
            {busy ? 'Starting…' : 'Repair Kokoro'}
          </PrimaryButton>
          {error && <p className="text-xs text-rose-700">{error}</p>}
        </div>
      );
    }

    if (status.state === 'weights-missing') {
      return (
        <div
          data-testid="kokoro-install-weights-missing"
          className="rounded-2xl border border-ink/10 bg-canvas p-4 space-y-3"
        >
          <div>
            <p className="text-sm font-semibold text-ink">
              Kokoro is installed — voice weights not downloaded
            </p>
            <p className="mt-1 text-xs text-ink/55">
              The Kokoro package is ready; fetch its ~330 MB voice weights to start generating audio.
            </p>
          </div>
          <PrimaryButton variant="dark" onClick={startInstall} disabled={busy} icon={false}>
            {busy ? 'Starting…' : 'Download weights'}
          </PrimaryButton>
          {error && <p className="text-xs text-rose-700">{error}</p>}
        </div>
      );
    }

    return (
      <div
        data-testid="kokoro-install-not-detected"
        className="rounded-2xl border border-ink/10 bg-canvas p-4 space-y-3"
      >
        <div>
          <p className="text-sm font-semibold text-ink">Kokoro is not installed</p>
          <p className="mt-1 text-xs text-ink/55">
            Kokoro is the default voice engine — 28 expressive English voices, fast CPU inference,
            and a compact ~330 MB footprint. Install it once and every book benefits immediately.
            Qwen (voice design) and Coqui (zero-shot cloning) are separate optional engines.
          </p>
        </div>
        <PrimaryButton variant="dark" onClick={startInstall} disabled={busy} icon={false}>
          {busy ? 'Starting…' : 'Install Kokoro'}
        </PrimaryButton>
        {error && <p className="text-xs text-rose-700">{error}</p>}
      </div>
    );
  }

  if (job.status === 'detecting' || job.status === 'installing') {
    return (
      <div
        data-testid="kokoro-install-job"
        data-job-status={job.status}
        className="rounded-2xl border border-ink/10 bg-canvas p-4 space-y-2"
      >
        <div className="flex items-center gap-3">
          <span className="w-3 h-3 rounded-full border-2 border-magenta border-t-transparent animate-spin" />
          <p className="text-sm font-semibold text-ink">
            {job.status === 'detecting' ? 'Checking your system…' : 'Installing Kokoro…'}
          </p>
        </div>
        <p className="text-xs text-ink/60">
          {job.step ?? 'Downloading Kokoro weights (~330 MB) — this should only take a minute.'}
        </p>
      </div>
    );
  }

  return (
    <div
      data-testid="kokoro-install-error"
      className="rounded-2xl border border-rose-200 bg-rose-50 p-4 space-y-2"
    >
      <p className="text-sm font-semibold text-rose-900">Kokoro install failed</p>
      <p className="text-xs text-rose-900/80">{job.error ?? 'Install failed.'}</p>
      <PrimaryButton variant="dark" onClick={startInstall} icon={false}>
        {busy ? 'Retrying…' : 'Try again'}
      </PrimaryButton>
    </div>
  );
}
