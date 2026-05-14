/* Ollama health proxy. The Account view + analysis route polls this to tell
   the user "Local analyzer: connected / unreachable / model not pulled" right
   next to the Engine label. Mirrors server/src/routes/sidecar-health.ts —
   same envelope shape, same 2s probe ceiling, just a different upstream.

   Surfaces the `models` array from /api/tags so the UI can flag the
   second-most-common operational error after "daemon down": daemon up,
   but the configured model tag isn't pulled. */

import { Router, type Request, type Response } from 'express';
import { getResolvedOllamaUrl, getResolvedOllamaModel } from '../workspace/user-settings.js';

export const ollamaHealthRouter = Router();

/* Same 2s budget as the sidecar probe: a hung daemon mustn't pin a UI
   polling request. Ollama's /api/tags is a list of pulled models — trivial
   read, returns in <50ms under normal load. */
const PROBE_TIMEOUT_MS = 2_000;

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

ollamaHealthRouter.get('/health', async (_req: Request, res: Response) => {
  const url = getResolvedOllamaUrl();
  const expectedModel = getResolvedOllamaModel();
  const target = `${url}/api/tags`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const response = await fetch(target, { method: 'GET', signal: controller.signal });
    clearTimeout(timer);
    if (!response.ok) {
      return res.json({
        status: 'unreachable',
        url,
        error: `Ollama returned ${response.status} ${response.statusText}`,
      });
    }
    const body = (await response.json().catch(() => ({}))) as OllamaTagsResponse;
    const models = Array.isArray(body.models)
      ? body.models.map(m => m.name ?? m.model ?? '').filter(Boolean)
      : [];
    /* Tag matching tolerates Ollama's habit of canonicalising tags (a model
       pulled as `qwen3.5:9b` may appear in /api/tags as `qwen3.5:9b` with no
       digest, but on some installs as `qwen3.5:9b-instruct-q4_K_M`). Match
       on the prefix so the "model present" check stays useful. */
    const expectedRoot = expectedModel.split(':')[0];
    const expectedFull = expectedModel;
    const hasExpected = models.some(m =>
      m === expectedFull || m.startsWith(`${expectedFull}-`) || m.split(':')[0] === expectedRoot && m.startsWith(`${expectedRoot}:`)
    );
    return res.json({
      status: 'reachable',
      url,
      models,
      expectedModel,
      modelPulled: hasExpected,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return res.json({
      status: 'unreachable',
      url,
      /* Same distinction the sidecar probe makes: "process down" vs
         "process up but not responding". Remediation differs (start
         the daemon vs. wait or restart). */
      error: isTimeout
        ? `No response from ${url} within ${PROBE_TIMEOUT_MS}ms — Ollama may be loading a model or stuck on a long generation.`
        : err.message || 'Ollama fetch failed.',
    });
  }
});
