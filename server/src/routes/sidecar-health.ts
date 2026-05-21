/* Sidecar health proxy. The Generate screen polls this every 30s so the
   user can see "Sidecar: connected / unreachable / slow" right next to the
   Engine label, without waiting until a chapter actually fails. The server
   knows the LOCAL_TTS_URL env var; the frontend doesn't, so the indirection
   lives here. */

import { Router, type Request, type Response } from 'express';
import { getCachedCatalogAudit, runCatalogAudit } from '../tts/coqui-catalog-audit.js';
import { getResolvedSidecarUrl } from '../workspace/user-settings.js';

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
  device?: string | null;
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
    return res.json({
      status: 'reachable',
      url,
      proxy: 'sidecar',
      engines: Array.isArray(body.engines) ? body.engines : undefined,
      modelLoaded: body.model_loaded === true,
      loading: body.loading === true,
      kokoroLoaded: body.kokoro_loaded === true,
      kokoroLoading: body.kokoro_loading === true,
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

   Body: `{ engine?: 'coqui' | 'kokoro', model?: string }`. Forwarded
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

   Body: `{ engine?: 'coqui' | 'kokoro' }`, default `'coqui'`. We forward
   the full body so the sidecar can dispatch — the Kokoro Stop pill sets
   `engine: 'kokoro'` here. */
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
