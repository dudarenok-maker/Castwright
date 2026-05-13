/* Sidecar health proxy. The Generate screen polls this every 30s so the
   user can see "Sidecar: connected / unreachable / slow" right next to the
   Engine label, without waiting until a chapter actually fails. The server
   knows the LOCAL_TTS_URL env var; the frontend doesn't, so the indirection
   lives here. */

import { Router, type Request, type Response } from 'express';

export const sidecarHealthRouter = Router();

/* Short by design — a hung sidecar shouldn't pin a UI polling request. The
   sidecar's /health route is a trivial dict return that responds in <50ms
   under normal load, so 2s is a generous ceiling that still surfaces a
   stuck/loaded process as "unreachable". */
const PROBE_TIMEOUT_MS = 2_000;

sidecarHealthRouter.get('/health', async (_req: Request, res: Response) => {
  const url = (process.env.LOCAL_TTS_URL ?? 'http://localhost:9000').replace(/\/+$/, '');
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
        error: `Sidecar returned ${response.status} ${response.statusText}`,
      });
    }
    const body = await response.json().catch(() => ({})) as { engines?: string[] };
    return res.json({
      status: 'reachable',
      url,
      engines: Array.isArray(body.engines) ? body.engines : undefined,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return res.json({
      status: 'unreachable',
      url,
      /* Distinguish "process down / unreachable host" from "process up but
         not responding" — both leave the user stuck but the remediation
         differs (start the process vs. wait or restart). */
      error: isTimeout
        ? `No response from ${url} within ${PROBE_TIMEOUT_MS}ms — the sidecar may be loading a model or stuck on a long synth.`
        : err.message || 'Sidecar fetch failed.',
    });
  }
});
