/* fs-21 wave 4 — one shared fix-action button for every BlockerDiagnosis
   across the Setup checker and the Status popover. Owns its own job-polling
   loop (mirrors venv-bootstrap.tsx's pattern) so callers don't hand-roll
   button wiring per action kind. */
import { useEffect, useRef, useState } from 'react';
import type { BlockerAction, BlockerDiagnosis } from '../lib/api';

interface Job {
  id: string;
  status: string;
  step: string | null;
  error: string | null;
  /* ollama-install only, Windows path: the job can't finish headlessly — it
     downloads a GUI installer, sets this path, and stays at 'installing'
     until the user runs it and the app re-probes via /recheck. */
  manualInstallerPath?: string | null;
}

const JOB_START_ENDPOINT: Partial<Record<BlockerAction['kind'], string>> = {
  'venv-bootstrap': '/api/setup/venv/bootstrap',
  'qwen-install': '/api/qwen/install',
  'kokoro-install': '/api/kokoro/install',
  'coqui-install': '/api/coqui/install',
  'ollama-install': '/api/ollama/install',
  'ollama-pull': '/api/ollama/pull',
};

/* Every install-job kind (venv-bootstrap, kokoro/qwen/coqui/ollama-install)
   reports success as 'installed' — EXCEPT ollama-pull, whose success status
   is 'pulled' (PullJobStatus in server/src/ollama/pull-bootstrap.ts). Missing
   'pulled' here would strand the ollama-pull fix button in "Working…"
   forever even though the pull actually succeeded server-side — the exact
   dead-end this feature exists to eliminate. No job kind emits 'done'. */
const JOB_DONE_STATUSES = ['installed', 'pulled'];
const JOB_ERROR_STATUSES = ['error'];
const POLL_MS = 1_500;

export function BlockerFixAction({
  diagnosis,
  onDone,
}: {
  diagnosis: BlockerDiagnosis;
  onDone: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /* Non-null only for the Windows ollama-install manual-installer handshake
     (round-2 plan review finding A1): the generic headless poll loop cannot
     reach a terminal status for this one job, since install-bootstrap.ts's
     win32 path returns at 'installing' with this path set and waits for a
     manual /recheck. Every other job kind never sets this. */
  const [manualInstallerPath, setManualInstallerPath] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const jobRef = useRef<{ endpoint: string; id: string } | null>(null);
  /* pollJob's recursive setTimeout chain outlives a single render — a fix can
     still be running when the Status popover closes or a wizard step swaps
     out. clearTimeout on unmount stops the NEXT scheduled tick; this guard
     additionally stops an already-in-flight fetch's response from calling
     setState (or onDone, a caller-owned callback) after unmount, mirroring
     venv-bootstrap.tsx's cleanup for the same recursive-poll shape. */
  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
      if (pollRef.current) clearTimeout(pollRef.current);
    };
  }, []);

  const action = diagnosis.action;
  if (diagnosis.status !== 'fail') return null;
  if (!action) return null;

  const pollJob = (endpoint: string, id: string) => {
    if (pollRef.current) clearTimeout(pollRef.current);
    pollRef.current = setTimeout(async () => {
      try {
        const res = await fetch(`${endpoint}/${id}`);
        const body = (await res.json()) as Job;
        if (!mountedRef.current) return;
        if (JOB_DONE_STATUSES.includes(body.status)) {
          setBusy(false);
          onDone();
          return;
        }
        if (JOB_ERROR_STATUSES.includes(body.status)) {
          setBusy(false);
          setError(body.error ?? 'Failed.');
          return;
        }
        if (body.manualInstallerPath) {
          setBusy(false);
          jobRef.current = { endpoint, id };
          setManualInstallerPath(body.manualInstallerPath);
          return;
        }
        pollJob(endpoint, id);
      } catch (e) {
        if (!mountedRef.current) return;
        setBusy(false);
        setError(e instanceof Error ? e.message : String(e));
      }
    }, POLL_MS);
  };

  const runJobAction = async () => {
    const endpoint = JOB_START_ENDPOINT[action.kind];
    if (!endpoint) return;
    setBusy(true);
    setError(null);
    setManualInstallerPath(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: action.params ? { 'Content-Type': 'application/json' } : undefined,
        body: action.params ? JSON.stringify(action.params) : undefined,
      });
      const body = (await res.json()) as Job;
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      if (body.manualInstallerPath) {
        setBusy(false);
        jobRef.current = { endpoint, id: body.id };
        setManualInstallerPath(body.manualInstallerPath);
        return;
      }
      pollJob(endpoint, body.id);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runRecheck = async () => {
    if (!jobRef.current) return;
    const { endpoint, id } = jobRef.current;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${endpoint}/${id}/recheck`, { method: 'POST' });
      const body = (await res.json()) as Job;
      if (JOB_DONE_STATUSES.includes(body.status)) {
        setBusy(false);
        setManualInstallerPath(null);
        onDone();
        return;
      }
      // Still 'installing' (installer not run yet) — stay in the manual state.
      setBusy(false);
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runRestartAction = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/sidecar/restart', { method: 'POST' });
      const body = (await res.json()) as { ok: boolean; error?: string };
      if (!body.ok) throw new Error(body.error ?? 'Restart failed.');
      setBusy(false);
      onDone();
    } catch (e) {
      setBusy(false);
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const runNavigateAction = () => {
    if (action.href) window.location.hash = action.href;
    onDone();
  };

  const onClick = () => {
    if (action.kind === 'sidecar-restart') return void runRestartAction();
    if (action.kind === 'navigate') return runNavigateAction();
    return void runJobAction();
  };

  if (manualInstallerPath) {
    return (
      <div className="space-y-1">
        <p className="text-xs text-ink/60">
          Installer downloaded to <code className="bg-ink/5 px-1 rounded">{manualInstallerPath}</code> — run it,
          then click Recheck.
        </p>
        <button
          type="button"
          onClick={runRecheck}
          disabled={busy}
          className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink-soft disabled:opacity-50"
        >
          {busy ? 'Checking…' : 'Recheck'}
        </button>
        {error && <p className="text-xs text-rose-700">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-1">
      <button
        type="button"
        onClick={onClick}
        disabled={busy}
        className="px-3 py-1.5 rounded-full bg-ink text-canvas text-xs font-semibold hover:bg-ink-soft disabled:opacity-50"
      >
        {busy ? 'Working…' : action.label}
      </button>
      {error && <p className="text-xs text-rose-700">{error}</p>}
    </div>
  );
}
