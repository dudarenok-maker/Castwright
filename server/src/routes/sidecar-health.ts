/* Sidecar health proxy. The Generate screen polls this every 30s so the
   user can see "Sidecar: connected / unreachable / slow" right next to the
   Engine label, without waiting until a chapter actually fails. The server
   knows the LOCAL_TTS_URL env var; the frontend doesn't, so the indirection
   lives here. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getCachedCatalogAudit, runCatalogAudit } from '../tts/coqui-catalog-audit.js';
import {
  getResolvedSidecarUrl,
  setLastKnownQwenInstallState,
  type QwenInstallState,
} from '../workspace/user-settings.js';
import { asrEnabled } from '../tts/segment-asr-qa.js';
import { getActiveSupervisor } from '../tts/sidecar-supervisor.js';

export const sidecarHealthRouter = Router();

/* Short by design — a hung sidecar shouldn't pin a UI polling request. The
   sidecar's /health route is a trivial dict return that responds in <50ms
   under normal load, so 2s is a generous ceiling that still surfaces a
   stuck/loaded process as "unreachable". */
const PROBE_TIMEOUT_MS = 2_000;

/* Cold-loading XTTS v2 from disk takes 30–60s on a warm CPU/GPU and can spike
   to ~90s on first ever pull (model weights cached after that). The /load
   proxy needs a budget that covers the slowest realistic case; otherwise the
   Node-side fetch aborts mid-load while the sidecar keeps loading happily,
   leaving the UI with a phantom error and a model that's about to be ready. */
const LOAD_TIMEOUT_MS = 90_000;

/* When the sidecar PROCESS is down, Node's fetch rejects with the opaque
   `TypeError: fetch failed` (the real reason — ECONNREFUSED — hides in
   `.cause.code`). That bare "fetch failed" was leaking straight into the
   voice-engine pill's error banner when a user clicked Load before the
   sidecar had finished launching. Map any non-timeout proxy failure to copy
   the user can act on, with the technical code kept in parens for support. */
function friendlyUnreachableError(err: { message?: string; cause?: unknown }): string {
  const code = (err.cause as { code?: string } | undefined)?.code;
  const detail = code ?? err.message;
  return `Couldn't reach the voice engine — it may still be starting up, or it isn't running yet. Try again in a moment.${
    detail ? ` (${detail})` : ''
  }`;
}

interface SidecarHealthBody {
  engines?: string[];
  /* fs-1 — sidecar app version (server/tts-sidecar/version.py), surfaced by
     /api/info next to the server version. Absent on an older sidecar → null. */
  __version__?: string;
  model_loaded?: boolean;
  loading?: boolean;
  /* Kokoro mirrors the Coqui pair. Distinct names (not a generic map) so
     the frontend's per-engine pill state reads flat properties off a single
     /health response — preserves the consolidated useTtsLifecycle hook's
     one-poll-per-tick invariant. */
  kokoro_loaded?: boolean;
  kokoro_loading?: boolean;
  /* Qwen mirrors the Kokoro pair (plan 108). Like Kokoro it does NOT
     auto-evict the analyzer; its bespoke per-character voices share the
     same single /health response so useTtsLifecycle stays on one poll. */
  qwen_loaded?: boolean;
  qwen_loading?: boolean;
  /* Install-state (plan: Qwen-default). Distinct from load-state: tells
     "package not pip-installed" / "installed, weights not downloaded" apart
     from "ready" / "loaded". Absent on an older sidecar → treated as
     'not-installed' below (never optimistically claim Qwen is usable). */
  qwen_package_installed?: boolean;
  qwen_weights_present?: boolean;
  qwen_install_state?: 'not-installed' | 'weights-missing' | 'ready' | 'loaded';
  /* ASR content-QA Whisper engine (srv-31). Display-only in the model-watch
     pill — no per-engine Load/Stop (ASR loads lazily on /transcribe and
     idle-evicts). `asr_device` is 'cpu' | 'cuda' (where Whisper runs). Absent on
     an older sidecar → false / null below. */
  asr_loaded?: boolean;
  asr_device?: string | null;
  device?: string | null;
  /* side-14 — per-engine device ground-truth. Sidecar values are normalised
     families ('cuda' | 'mps' | 'cpu') or null while unknowable; devices_state
     tracks the startup probe ('pending' until torch is imported in the
     background, 'ready', or 'error' when torch is missing/broken). Absent on an
     older sidecar → null. */
  devices?: Record<string, string | null>;
  devices_state?: string;
  /* side-11 item 2 — SOFT recycle signal. `recycle_pending` flips true once the
     sidecar's committed-private memory crosses SIDECAR_RECYCLE_SOFT_MB (below the
     hard ceiling); the generation worker reads it off this poll and triggers a
     clean boundary recycle. `committed_mb` is the figure behind that decision
     (may be null when psutil can't read it). `recycle_pending` ALSO flips true
     when reserved VRAM crosses the VRAM soft ceiling (plan 159) — the server
     can't tell the two pressures apart and doesn't need to; the boundary recycle
     is identical. `vram_reserved_mb` / `vram_total_mb` are the VRAM figures
     behind that decision (observability). Absent on an older sidecar → false /
     null below. */
  recycle_pending?: boolean;
  committed_mb?: number | null;
  vram_reserved_mb?: number | null;
  vram_total_mb?: number | null;
}

/* side-14 — per-engine device ground-truth. Sidecar values are normalised
   families ('cuda' | 'mps' | 'cpu') or null while unknowable; devices_state
   tracks the startup probe ('pending' until torch is imported in the
   background, 'ready', or 'error' when torch is missing/broken). Absent on an
   older sidecar → null. */
export type SidecarDeviceFamily = 'cuda' | 'mps' | 'cpu';
export type SidecarDeviceMap = Record<
  'kokoro' | 'coqui' | 'qwen',
  SidecarDeviceFamily | null
>;
export type SidecarDevicesState = 'pending' | 'ready' | 'error';

const DEVICE_FAMILIES: readonly SidecarDeviceFamily[] = ['cuda', 'mps', 'cpu'];
const DEVICES_STATES: readonly SidecarDevicesState[] = ['pending', 'ready', 'error'];
const DEVICE_ENGINES = ['kokoro', 'coqui', 'qwen'] as const;

/* side-14 — normalise the sidecar's devices map. Old sidecar omits it → null;
   junk values per-slot → null (never forward an unknown string to the UI). */
export function normaliseDevices(raw: unknown): SidecarDeviceMap | null {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  const out = {} as SidecarDeviceMap;
  for (const engine of DEVICE_ENGINES) {
    const v = rec[engine];
    out[engine] = DEVICE_FAMILIES.includes(v as SidecarDeviceFamily)
      ? (v as SidecarDeviceFamily)
      : null;
  }
  return out;
}

export function normaliseDevicesState(raw: unknown): SidecarDevicesState | null {
  return DEVICES_STATES.includes(raw as SidecarDevicesState)
    ? (raw as SidecarDevicesState)
    : null;
}

const QWEN_INSTALL_STATES: readonly QwenInstallState[] = [
  'not-installed',
  'weights-missing',
  'ready',
  'loaded',
];

/* Normalise the sidecar's qwen_install_state. An old sidecar omits the field
   entirely → 'not-installed' so a stale build never reports Qwen as ready. */
function normaliseQwenInstallState(raw: unknown): QwenInstallState {
  return QWEN_INSTALL_STATES.includes(raw as QwenInstallState)
    ? (raw as QwenInstallState)
    : 'not-installed';
}

/* Derive the install-state the resolver cache should trust from a /health body.
   `qwen_loaded: true` means the Base model is resident in the sidecar's memory —
   the strongest possible proof Qwen is installed AND usable — so it OVERRIDES
   the qwen_install_state field rather than being subordinate to it.

   Why this override is load-bearing: a pre-plan-130 sidecar omits
   qwen_install_state entirely, which the normaliser maps to 'not-installed'.
   Without the override, a stale-but-running sidecar (model loaded, happily
   serving Qwen) reports 'not-installed' on every 30s poll, which poisons
   getLastKnownQwenInstallState() and makes generation silently fall EVERY Qwen
   character back to Kokoro — wrong engine, wrong voices, no warning. A loaded
   model can never be "not installed", so honour it. (Stale-build incident,
   2026-05-29 — see docs/features/archive/135-qwen-loud-fallback.md.) */
function deriveQwenInstallState(body: SidecarHealthBody): QwenInstallState {
  if (body.qwen_loaded === true) return 'loaded';
  return normaliseQwenInstallState(body.qwen_install_state);
}

/* Shape returned by probeSidecarHealth(). The /health route forwards this
   verbatim; the /api/diagnostics aggregator (fs-18) consumes it in-process so
   it never has to HTTP self-call this route (and never double-fires the
   setLastKnownQwenInstallState side effect against a different code path). */
export interface SidecarHealthResult {
  status: 'reachable' | 'unreachable';
  url: string;
  proxy: 'sidecar';
  engines?: string[];
  modelLoaded?: boolean;
  loading?: boolean;
  kokoroLoaded?: boolean;
  kokoroLoading?: boolean;
  qwenLoaded?: boolean;
  qwenLoading?: boolean;
  qwenPackageInstalled?: boolean;
  qwenWeightsPresent?: boolean;
  qwenInstallState?: QwenInstallState;
  /* ASR (Whisper) model-watch state (srv-31). `asrEnabled` is the SERVER's
     SEG_ASR_ENABLED (not from the sidecar body) — drives whether the model-watch
     shows an ASR pill at all. `asrLoaded` = the Whisper model is resident in the
     sidecar; `asrDevice` = 'cpu' | 'cuda'. */
  asrEnabled?: boolean;
  asrLoaded?: boolean;
  asrDevice?: string | null;
  device?: string | null;
  recyclePending?: boolean;
  committedMb?: number | null;
  vramReservedMb?: number | null;
  vramTotalMb?: number | null;
  /* side-14 — per-engine device map + probe state, forwarded from the sidecar. */
  devices?: SidecarDeviceMap | null;
  devicesState?: SidecarDevicesState | null;
  error?: string;
}

/* Probe the sidecar's /health once and normalise the result. Extracted from
   the route handler so /api/diagnostics can reuse it (plan: admin console). */
export async function probeSidecarHealth(): Promise<SidecarHealthResult> {
  const url = getResolvedSidecarUrl();
  const target = `${url}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return {
        status: 'unreachable',
        url,
        proxy: 'sidecar',
        error: `Sidecar returned ${response.status} ${response.statusText}`,
      };
    }
    const body = (await response.json().catch(() => ({}))) as SidecarHealthBody;
    const qwenInstallState = deriveQwenInstallState(body);
    /* A loaded model implies its package + weights are on disk — keep the
       forwarded booleans consistent with the derived 'loaded' state so the UI
       never shows the contradictory "loaded but not-installed" combination a
       stale sidecar's raw report would otherwise produce. */
    const qwenLoaded = body.qwen_loaded === true;
    /* Feed the in-process cache getResolvedTtsModelKey reads synchronously, so
       the conditional Qwen-when-installed default tracks reality on every poll
       without that resolver having to block on a sidecar fetch. Only updated on
       a reachable response — an unreachable poll leaves the last-known state
       intact (a transient timeout shouldn't downgrade a known-ready Qwen). */
    setLastKnownQwenInstallState(qwenInstallState);
    return {
      status: 'reachable',
      url,
      proxy: 'sidecar',
      engines: Array.isArray(body.engines) ? body.engines : undefined,
      modelLoaded: body.model_loaded === true,
      loading: body.loading === true,
      kokoroLoaded: body.kokoro_loaded === true,
      kokoroLoading: body.kokoro_loading === true,
      qwenLoaded,
      qwenLoading: body.qwen_loading === true,
      qwenPackageInstalled: qwenLoaded || body.qwen_package_installed === true,
      qwenWeightsPresent: qwenLoaded || body.qwen_weights_present === true,
      qwenInstallState: qwenInstallState,
      asrEnabled: asrEnabled(),
      asrLoaded: body.asr_loaded === true,
      asrDevice: typeof body.asr_device === 'string' ? body.asr_device : null,
      device: typeof body.device === 'string' ? body.device : null,
      /* side-11 item 2 — forward the soft-recycle signal (default false / null
         for an older sidecar that omits them). */
      recyclePending: body.recycle_pending === true,
      committedMb: typeof body.committed_mb === 'number' ? body.committed_mb : null,
      vramReservedMb:
        typeof body.vram_reserved_mb === 'number' ? body.vram_reserved_mb : null,
      vramTotalMb: typeof body.vram_total_mb === 'number' ? body.vram_total_mb : null,
      devices: normaliseDevices(body.devices),
      devicesState: normaliseDevicesState(body.devices_state),
    };
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return {
      status: 'unreachable',
      url,
      /* Hop tag — we reached Node fine (this handler ran), the failure was
         in the Node → sidecar fetch. Frontend uses it to surface the right
         "restart X" message. */
      proxy: 'sidecar',
      /* Distinguish "process down / unreachable host" from "process up but
         not responding" — both leave the user stuck but the remediation
         differs (start the process vs. wait or restart). */
      error: isTimeout
        ? `No response from ${url} within ${PROBE_TIMEOUT_MS}ms — the sidecar may be loading a model or stuck on a long synth.`
        : err.message || 'Sidecar fetch failed.',
    };
  }
}

sidecarHealthRouter.get('/health', async (_req: Request, res: Response) => {
  res.json(await probeSidecarHealth());
});

/* POST /api/sidecar/load — proxies to the sidecar's /load endpoint with a
   90s ceiling (vs. /health's 2s) because a cold XTTS load actually does take
   that long (Kokoro is ~1s but reuses the same ceiling — over-budgeted is
   safe). Idempotent on the sidecar side: a second call while the model
   is loaded returns `ready` immediately, so the UI can fire this on every
   screen entry without burning compute.

   Body: `{ engine?: 'coqui' | 'kokoro' | 'qwen', model?: string }`. Forwarded
   verbatim — see the sidecar's /load route for default-resolution logic. */
sidecarHealthRouter.post('/load', async (req: Request, res: Response) => {
  const url = getResolvedSidecarUrl();
  const target = `${url}/load`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOAD_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });
    clearTimeout(timer);
    const body = (await upstream.json().catch(() => ({}))) as { status?: string; error?: string };
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'error',
        error: body.error || `Sidecar /load returned ${upstream.status}`,
      });
    }
    return res.json(body);
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string; cause?: unknown };
    const isTimeout = err.name === 'AbortError';
    return res.status(503).json({
      status: 'error',
      error: isTimeout
        ? `Sidecar /load did not complete within ${LOAD_TIMEOUT_MS}ms — model load is unusually slow or the process is stuck.`
        : friendlyUnreachableError(err),
    });
  }
});

/* POST /api/sidecar/unload — drops a TTS engine's loaded model and frees GPU
   memory. Fast path on the sidecar side (no model load to await), so the
   2s probe budget suffices. Idempotent: returns `idle` whether or not the
   sidecar had a model resident.

   Body: `{ engine?: 'coqui' | 'kokoro' | 'qwen' }`, default `'coqui'`. We
   forward the full body so the sidecar can dispatch — the Kokoro / Qwen
   Stop pills set `engine: 'kokoro'` / `engine: 'qwen'` here. */
sidecarHealthRouter.post('/unload', async (req: Request, res: Response) => {
  const url = getResolvedSidecarUrl();
  const target = `${url}/unload`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body ?? {}),
    });
    clearTimeout(timer);
    const body = (await upstream.json().catch(() => ({}))) as { status?: string };
    if (!upstream.ok) {
      return res.status(upstream.status).json({
        status: 'error',
        error: `Sidecar /unload returned ${upstream.status}`,
      });
    }
    return res.json(body);
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string; cause?: unknown };
    const isTimeout = err.name === 'AbortError';
    return res.status(503).json({
      status: 'error',
      error: isTimeout
        ? `Sidecar /unload did not respond within ${PROBE_TIMEOUT_MS}ms.`
        : friendlyUnreachableError(err),
    });
  }
});

/* POST /api/sidecar/restart — kill the running sidecar child and let the
   supervisor respawn it. Because buildOpts() is re-evaluated on every spawn,
   the fresh process picks up any restart-sidecar overrides that were saved
   to the config store since the last spawn.

   Strategy: kill the current child (which the supervisor does NOT own the
   "stopped" flag for, so its onChildExit fires and triggers the normal respawn
   path with backoff). Then poll /health until the new process responds, up to
   RESTART_HEALTH_POLL_TIMEOUT_MS, and return { ok: true }. If no child is
   currently supervised (autoStart off, or already stopped), the sidecar can't
   be restarted via this route and we return 409. The SSRF guard is inherited
   from getResolvedSidecarUrl (same as /health, /load, /unload). */
const RESTART_HEALTH_POLL_MS = 500;
const RESTART_HEALTH_POLL_TIMEOUT_MS = 60_000; // generous — a Kokoro boot is ~1s, Coqui ~60s

sidecarHealthRouter.post('/restart', async (_req: Request, res: Response) => {
  const supervisor = getActiveSupervisor();
  if (!supervisor) {
    return res.status(409).json({
      ok: false,
      error: 'No active supervisor — sidecar auto-start is disabled or the server is still booting.',
    });
  }
  const handle = supervisor.current();
  if (!handle) {
    return res.status(409).json({
      ok: false,
      error: 'No sidecar child is currently running. If auto-start is on, the supervisor will spawn one shortly.',
    });
  }

  /* Kill the child. The supervisor's onChildExit callback fires (since
     stopped=false) and schedules a respawn with backoff. */
  await handle.kill();

  /* Poll /health until the fresh sidecar responds. getResolvedSidecarUrl()
     carries the SSRF guard — a non-local URL falls back to localhost. */
  const url = getResolvedSidecarUrl();
  const target = `${url}/health`;
  const deadline = Date.now() + RESTART_HEALTH_POLL_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, RESTART_HEALTH_POLL_MS));
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
      const r = await fetch(target, { signal: controller.signal }).finally(() =>
        clearTimeout(timer),
      );
      if (r.ok) return res.json({ ok: true });
    } catch {
      /* sidecar still starting — keep polling */
    }
  }

  return res.status(503).json({
    ok: false,
    error: `Sidecar did not become healthy within ${RESTART_HEALTH_POLL_TIMEOUT_MS / 1000}s after restart.`,
  });
});

/* Catalog-audit endpoint. Returns the diff between voice-mapping.ts's
   COQUI_PROFILE_VOICES and the speaker manifest XTTS v2 actually loaded.
   Auto-runs once at server startup; this route serves the cached result
   so the UI / curl can read it without re-polling. Triggers a fresh
   audit on demand if `?refresh=1` is passed or the startup audit hasn't
   completed yet (sidecar might have been down at boot). */
sidecarHealthRouter.get('/catalog-audit', async (req: Request, res: Response) => {
  const url = getResolvedSidecarUrl();
  const refresh = req.query.refresh === '1';
  const cached = getCachedCatalogAudit();
  if (cached && !refresh) {
    return res.json({ status: 'ready', audit: cached });
  }
  /* Tight loop — caller is explicitly asking, so don't poll for 2 min;
     just take one shot at the sidecar. The user can re-hit the endpoint
     if the sidecar is still loading. */
  const audit = await runCatalogAudit({
    sidecarUrl: url,
    maxAttempts: 1,
    attemptDelayMs: 0,
    probeTimeoutMs: 3_000,
  });
  if (audit) return res.json({ status: 'ready', audit });
  return res.status(503).json({
    status: 'pending',
    message: 'Sidecar not responding to /speakers yet (model may still be loading).',
    sidecarUrl: url,
  });
});
