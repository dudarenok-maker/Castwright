/* Ollama health proxy. The Account view + analysis route polls this to tell
   the user "Local analyzer: connected / unreachable / model not pulled" right
   next to the Engine label. Mirrors server/src/routes/sidecar-health.ts —
   same envelope shape, same 2s probe ceiling, just a different upstream.

   Surfaces the `models` array from /api/tags so the UI can flag the
   second-most-common operational error after "daemon down": daemon up,
   but the configured model tag isn't pulled. */

import { Router, type Request, type Response } from 'express';
import { getResolvedOllamaUrl, getResolvedOllamaModel } from '../workspace/user-settings.js';
import { ANALYZER_NUM_CTX } from '../analyzer/ollama.js';

export const ollamaHealthRouter = Router();

/* Same 2s budget as the sidecar probe: a hung daemon mustn't pin a UI
   polling request. Ollama's /api/tags is a list of pulled models — trivial
   read, returns in <50ms under normal load. */
const PROBE_TIMEOUT_MS = 2_000;

interface OllamaTagsResponse {
  models?: Array<{ name?: string; model?: string }>;
}

/* Warming a cold Ollama model (e.g. qwen3.5:4b ~3 GB) into VRAM takes
   ~5-15s depending on disk + GPU; unloading is near-instant. Give /load a
   30s ceiling, but keep /unload on the 2s probe budget. */
const LOAD_TIMEOUT_MS = 30_000;

interface OllamaPsResponse {
  models?: Array<{ name?: string; model?: string; expires_at?: string }>;
}

ollamaHealthRouter.get('/health', async (_req: Request, res: Response) => {
  const url = getResolvedOllamaUrl();
  const expectedModel = getResolvedOllamaModel();
  /* Two probes in parallel: /api/tags for "is it pulled" and /api/ps for
     "is it actually resident in VRAM". The pill needs the *resident*
     signal — pulled-but-not-loaded looks identical to ready without it,
     which is exactly the bug that surfaced as the "Try Again" loop:
     after the user clicked Load and our warm-up succeeded, the model
     was loaded but with the wrong num_ctx; analysis then triggered a
     reload that broke the SSE, and the pill stayed green because tags
     never stops listing the pulled model. */
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const [tagsResp, psResp] = await Promise.all([
      fetch(`${url}/api/tags`, { method: 'GET', signal: controller.signal }),
      fetch(`${url}/api/ps`,   { method: 'GET', signal: controller.signal }),
    ]);
    clearTimeout(timer);
    if (!tagsResp.ok) {
      return res.json({
        status: 'unreachable',
        url,
        error: `Ollama returned ${tagsResp.status} ${tagsResp.statusText}`,
      });
    }
    const tagsBody = (await tagsResp.json().catch(() => ({}))) as OllamaTagsResponse;
    const models = Array.isArray(tagsBody.models)
      ? tagsBody.models.map(m => m.name ?? m.model ?? '').filter(Boolean)
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
    let resident: string[] = [];
    let expectedResident = false;
    if (psResp.ok) {
      const psBody = (await psResp.json().catch(() => ({}))) as OllamaPsResponse;
      resident = Array.isArray(psBody.models)
        ? psBody.models.map(m => m.name ?? m.model ?? '').filter(Boolean)
        : [];
      expectedResident = resident.some(m =>
        m === expectedFull || m.startsWith(`${expectedFull}-`) || m.split(':')[0] === expectedRoot && m.startsWith(`${expectedRoot}:`)
      );
    }
    return res.json({
      status: 'reachable',
      url,
      models,
      expectedModel,
      modelPulled: hasExpected,
      resident,
      modelResident: expectedResident,
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

/* Ollama doesn't expose a dedicated load/unload pair — instead it interprets
   `keep_alive` on /api/generate as the eviction TTL for the loaded model.
   - `keep_alive: "5m"` + empty prompt = warm the model into VRAM and hold it.
   - `keep_alive: 0` + empty prompt = unload immediately.
   This is exactly the idiom keepAliveFor() at analyzer/ollama.ts:92 already
   uses on real analyzer calls; these endpoints just expose it as explicit
   manual control for the in-app Load/Stop pill. */

async function callOllamaGenerate(
  url: string,
  body: Record<string, unknown>,
  timeoutMs: number,
): Promise<{ ok: boolean; status: number; error?: string }> {
  const target = `${url}/api/generate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      signal: controller.signal,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    clearTimeout(timer);
    if (!upstream.ok) {
      const text = await upstream.text().catch(() => '');
      return { ok: false, status: upstream.status, error: `Ollama returned ${upstream.status} ${upstream.statusText}: ${text}`.trim() };
    }
    /* Drain the body — Ollama streams an NDJSON tail even for empty-prompt
       requests, and leaving it unread keeps the socket half-open. */
    await upstream.text().catch(() => '');
    return { ok: true, status: upstream.status };
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return {
      ok: false,
      status: 503,
      error: isTimeout
        ? `Ollama did not respond within ${timeoutMs}ms.`
        : err.message || 'Ollama request failed.',
    };
  }
}

/* POST /api/ollama/load — warm the configured analyzer model into VRAM so
   the next analysis run skips the cold-load tax. Used by the Analysing
   screen's Load button.

   CRITICAL: pass the exact same num_ctx the analyzer's runStage path uses
   (ANALYZER_NUM_CTX, 16K). Ollama treats (model, num_ctx) as the cache key
   — warming with the default 2048 and then running analysis with 16384
   forces a full model reload on the first analyzer chat call, which
   surfaces to the UI as "Analysis stream ended without a result event"
   mid-reload. The user sees the pill go green ("Analyzer ready") but
   every Try Again triggers the same reload-and-die loop. */
ollamaHealthRouter.post('/load', async (_req: Request, res: Response) => {
  const url = getResolvedOllamaUrl();
  const model = getResolvedOllamaModel();
  const result = await callOllamaGenerate(
    url,
    {
      model,
      prompt: '',
      keep_alive: '5m',
      stream: false,
      options: { num_ctx: ANALYZER_NUM_CTX },
    },
    LOAD_TIMEOUT_MS,
  );
  if (!result.ok) {
    return res.status(result.status).json({ status: 'error', error: result.error });
  }
  return res.json({ status: 'ready' });
});

/* POST /api/ollama/unload — evict the configured analyzer model from VRAM.
   Used by both the Analysing-screen Stop button and the Generate-screen
   auto-evict flow (loading TTS calls this first to free GPU memory). */
ollamaHealthRouter.post('/unload', async (_req: Request, res: Response) => {
  const url = getResolvedOllamaUrl();
  const model = getResolvedOllamaModel();
  const result = await callOllamaGenerate(
    url,
    { model, prompt: '', keep_alive: 0, stream: false },
    PROBE_TIMEOUT_MS,
  );
  if (!result.ok) {
    return res.status(result.status).json({ status: 'error', error: result.error });
  }
  return res.json({ status: 'unloaded' });
});
