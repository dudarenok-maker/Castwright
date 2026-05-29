/* Sidecar health proxy. The Generate screen polls this every 30s so the
   user can see "Sidecar: connected / unreachable / slow" right next to the
   Engine label, without waiting until a chapter actually fails. The server
   knows the LOCAL_TTS_URL env var; the frontend doesn't, so the indirection
   lives here. */

import { Router, type Request, type Response } from 'express';
import { getCachedCatalogAudit, runCatalogAudit } from '../tts/coqui-catalog-audit.js';
import {
  getResolvedSidecarUrl,
  setLastKnownQwenInstallState,
  type QwenInstallState,
} from '../workspace/user-settings.js';

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

interface SidecarHealthBody {
  engines?: string[];
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
  device?: string | null;
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

sidecarHealthRouter.get('/health', async (_req: Request, res: Response) => {
  const url = getResolvedSidecarUrl();
  const target = `${url}/health`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return res.json({
        status: 'unreachable',
        url,
        proxy: 'sidecar',
        error: `Sidecar returned ${response.status} ${response.statusText}`,
      });
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
    return res.json({
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
      device: typeof body.device === 'string' ? body.device : null,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return res.json({
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
    });
  }
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
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return res.status(503).json({
      status: 'error',
      error: isTimeout
        ? `Sidecar /load did not complete within ${LOAD_TIMEOUT_MS}ms — model load is unusually slow or the process is stuck.`
        : err.message || 'Sidecar /load request failed.',
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
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return res.status(503).json({
      status: 'error',
      error: isTimeout
        ? `Sidecar /unload did not respond within ${PROBE_TIMEOUT_MS}ms.`
        : err.message || 'Sidecar /unload request failed.',
    });
  }
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
