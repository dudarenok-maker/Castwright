/* Ollama health proxy. The Account view + analysis route polls this to tell
   the user "Local analyzer: connected / unreachable / model not pulled" right
   next to the Engine label. Mirrors server/src/routes/sidecar-health.ts —
   same envelope shape, same 2s probe ceiling, just a different upstream.

   Surfaces the `models` array from /api/tags so the UI can flag the
   second-most-common operational error after "daemon down": daemon up,
   but the configured model tag isn't pulled. */

import { Router } from 'express';
import type { Request, Response } from '../http.js';
import { getResolvedOllamaUrl, getResolvedOllamaModel } from '../workspace/user-settings.js';
import { resolveAnalyzerNumCtx, resolveAnalyzerNumGpu } from '../analyzer/ollama.js';
import {
  installBootstrap as defaultInstallBootstrap,
  type InstallBootstrap,
} from '../ollama/install-bootstrap.js';
import {
  pullBootstrap as defaultPullBootstrap,
  type PullBootstrap,
} from '../ollama/pull-bootstrap.js';

export const ollamaHealthRouter = Router();

/* Plan 61 — injectable bootstraps. The default exports are the
   module-level singletons; tests swap them via setOllamaBootstraps() so
   the entire install/pull surface can run offline. */
let installBootstrap: InstallBootstrap = defaultInstallBootstrap;
let pullBootstrap: PullBootstrap = defaultPullBootstrap;

export function setOllamaBootstraps(opts: {
  install?: InstallBootstrap;
  pull?: PullBootstrap;
}): void {
  if (opts.install) installBootstrap = opts.install;
  if (opts.pull) pullBootstrap = opts.pull;
}

export function _resetOllamaBootstraps(): void {
  installBootstrap = defaultInstallBootstrap;
  pullBootstrap = defaultPullBootstrap;
}

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
  models?: Array<{
    name?: string;
    model?: string;
    expires_at?: string;
    /** Total model size (bytes) and the portion resident in VRAM. Ollama
        reports size_vram === 0 for a CPU-only load, > 0 when (partly) on GPU. */
    size?: number;
    size_vram?: number;
  }>;
}

/** Best-effort GPU/CPU detection from Ollama /api/ps (`size_vram`). Seeds the
    analyzer's first-chapter ETA rate before any wall-clock sample exists —
    local Ollama runs ~10× faster on CUDA than CPU (user-measured ≈150 vs
    ≈15 chars/s). Returns 'unknown' on any failure (no model resident, daemon
    down, parse error); the caller defaults to the GPU rate and the estimate
    self-corrects from observed pace within the first chapter regardless. */
export async function detectOllamaDevice(): Promise<'cuda' | 'cpu' | 'unknown'> {
  const url = getResolvedOllamaUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/api/ps`, { method: 'GET', signal: controller.signal });
    if (!resp.ok) return 'unknown';
    const body = (await resp.json().catch(() => ({}))) as OllamaPsResponse;
    const models = Array.isArray(body.models) ? body.models : [];
    if (models.length === 0) return 'unknown';
    return models.some((m) => (m.size_vram ?? 0) > 0) ? 'cuda' : 'cpu';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
}

/* Shape returned by probeOllamaHealth(). The /health route forwards this
   verbatim; the /api/diagnostics aggregator (fs-18) consumes it in-process. */
export interface OllamaHealthResult {
  status: 'reachable' | 'unreachable';
  url: string;
  models?: string[];
  expectedModel?: string;
  modelPulled?: boolean;
  resident?: string[];
  modelResident?: boolean;
  error?: string;
}

/* Probe the Ollama daemon once (tags + ps in parallel) and normalise the
   result. Extracted from the route handler so /api/diagnostics can reuse it. */
export async function probeOllamaHealth(): Promise<OllamaHealthResult> {
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
      fetch(`${url}/api/ps`, { method: 'GET', signal: controller.signal }),
    ]);
    clearTimeout(timer);
    if (!tagsResp.ok) {
      return {
        status: 'unreachable',
        url,
        error: `Ollama returned ${tagsResp.status} ${tagsResp.statusText}`,
      };
    }
    const tagsBody = (await tagsResp.json().catch(() => ({}))) as OllamaTagsResponse;
    const models = Array.isArray(tagsBody.models)
      ? tagsBody.models.map((m) => m.name ?? m.model ?? '').filter(Boolean)
      : [];
    /* Tag matching tolerates Ollama's habit of canonicalising tags (a model
       pulled as `qwen3.5:9b` may appear in /api/tags as `qwen3.5:9b` with no
       digest, but on some installs as `qwen3.5:9b-instruct-q4_K_M`). Match
       on the prefix so the "model present" check stays useful. */
    const expectedRoot = expectedModel.split(':')[0];
    const expectedFull = expectedModel;
    const hasExpected = models.some(
      (m) =>
        m === expectedFull ||
        m.startsWith(`${expectedFull}-`) ||
        (m.split(':')[0] === expectedRoot && m.startsWith(`${expectedRoot}:`)),
    );
    let resident: string[] = [];
    let expectedResident = false;
    if (psResp.ok) {
      const psBody = (await psResp.json().catch(() => ({}))) as OllamaPsResponse;
      resident = Array.isArray(psBody.models)
        ? psBody.models.map((m) => m.name ?? m.model ?? '').filter(Boolean)
        : [];
      expectedResident = resident.some(
        (m) =>
          m === expectedFull ||
          m.startsWith(`${expectedFull}-`) ||
          (m.split(':')[0] === expectedRoot && m.startsWith(`${expectedRoot}:`)),
      );
    }
    return {
      status: 'reachable',
      url,
      models,
      expectedModel,
      modelPulled: hasExpected,
      resident,
      modelResident: expectedResident,
    };
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return {
      status: 'unreachable',
      url,
      /* Same distinction the sidecar probe makes: "process down" vs
         "process up but not responding". Remediation differs (start
         the daemon vs. wait or restart). */
      error: isTimeout
        ? `No response from ${url} within ${PROBE_TIMEOUT_MS}ms — Ollama may be loading a model or stuck on a long generation.`
        : err.message || 'Ollama fetch failed.',
    };
  }
}

ollamaHealthRouter.get('/health', async (_req: Request, res: Response) => {
  res.json(await probeOllamaHealth());
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
      return {
        ok: false,
        status: upstream.status,
        error: `Ollama returned ${upstream.status} ${upstream.statusText}: ${text}`.trim(),
      };
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

   CRITICAL: pass the exact same num_ctx AND num_gpu the analyzer's
   runStage path uses (ANALYZER_NUM_CTX, ANALYZER_NUM_GPU). Ollama
   treats both as part of the load-time cache key — warming with the
   default num_ctx 2048 and then running analysis with 16384 forces a
   full model reload on the first analyzer chat call, and the same is
   true if num_gpu differs between warm and chat. The reload surfaces
   to the UI as "Analysis stream ended without a result event" while
   the pill stays green ("Analyzer ready"), so every Try Again triggers
   the same reload-and-die loop. */
ollamaHealthRouter.post('/load', async (req: Request, res: Response) => {
  const url = getResolvedOllamaUrl();
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const model = requested || getResolvedOllamaModel();
  const result = await callOllamaGenerate(
    url,
    {
      model,
      prompt: '',
      keep_alive: '5m',
      stream: false,
      options: { num_ctx: resolveAnalyzerNumCtx(), num_gpu: resolveAnalyzerNumGpu() },
    },
    LOAD_TIMEOUT_MS,
  );
  if (!result.ok) {
    return res.status(result.status).json({ status: 'error', error: result.error });
  }
  return res.json({ status: 'ready' });
});

/** Evict resident Ollama model(s) via keep_alive:0 generate calls. Empty/omitted
    `targets` → evict EVERY model /api/ps reports (the safe default: a phase-env
    or quant-tagged resident won't be missed; matches the /unload-all route).
    Returns the list evicted. Throws on the first failed eviction (error carries
    `.status` for the HTTP response code). */
export async function unloadResidentOllama(targets?: string[]): Promise<string[]> {
  const url = getResolvedOllamaUrl();
  const list = targets && targets.length > 0 ? targets : (await probeOllamaHealth()).resident ?? [];
  for (const model of list) {
    const result = await callOllamaGenerate(url, { model, prompt: '', keep_alive: 0, stream: false }, PROBE_TIMEOUT_MS);
    if (!result.ok) {
      const err = Object.assign(new Error(result.error ?? `unload ${model} failed`), { status: result.status });
      throw err;
    }
  }
  return list;
}

/** Poll /api/ps until no model remains resident (Ollama unloads asynchronously).
    Returns true when clear; false if still resident after the retries. */
export async function verifyOllamaEvicted(opts: { retries?: number; delayMs?: number } = {}): Promise<boolean> {
  const retries = opts.retries ?? 5;
  const delayMs = opts.delayMs ?? 400;
  for (let i = 0; i < retries; i += 1) {
    const resident = (await probeOllamaHealth()).resident ?? [];
    if (resident.length === 0) return true;
    await new Promise((r) => setTimeout(r, delayMs));
  }
  return ((await probeOllamaHealth()).resident ?? []).length === 0;
}

/* POST /api/ollama/unload — evict the configured analyzer model from VRAM.
   Used by both the Analysing-screen Stop button and the Generate-screen
   auto-evict flow (loading TTS calls this first to free GPU memory). */
ollamaHealthRouter.post('/unload', async (req: Request, res: Response) => {
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  try {
    const unloaded = await unloadResidentOllama(requested ? [requested] : undefined);
    return res.json({ status: 'unloaded', unloaded });
  } catch (e) {
    const err = e as Error & { status?: number };
    return res.status(err.status ?? 502).json({ status: 'error', error: err.message });
  }
});

/* ============================================================
 * Plan 61 — in-app multi-model management UX
 * ============================================================
 *
 * GET  /api/ollama/detect       — is `ollama` already on PATH?
 * POST /api/ollama/install      — kick off the vendor installer download
 * GET  /api/ollama/install/:id  — poll install-job progress
 * POST /api/ollama/install/:id/recheck — re-probe (used after Windows GUI install)
 * POST /api/ollama/pull         — start `ollama pull <model>`
 * GET  /api/ollama/pull/:id     — poll pull-job progress
 * POST /api/ollama/refresh      — re-probe daemon + return /health envelope
 *
 * Endpoints are designed so the UI never has to drop to a terminal.
 * Test injection: setOllamaBootstraps({...}) above swaps in mocked
 * InstallBootstrap / PullBootstrap so tests run offline. */

ollamaHealthRouter.get('/detect', async (_req: Request, res: Response) => {
  const result = await installBootstrap.detect();
  return res.json(result);
});

ollamaHealthRouter.post('/install', (_req: Request, res: Response) => {
  const job = installBootstrap.start();
  return res.status(202).json(job);
});

ollamaHealthRouter.get('/install/:id', (req: Request, res: Response) => {
  const job = installBootstrap.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No install job '${req.params.id}'` });
  }
  return res.json(job);
});

ollamaHealthRouter.post('/install/:id/recheck', async (req: Request, res: Response) => {
  const job = await installBootstrap.recheck(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No install job '${req.params.id}'` });
  }
  return res.json(job);
});

ollamaHealthRouter.post('/pull', (req: Request, res: Response) => {
  const model = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  if (!model) {
    return res.status(400).json({ error: 'Body must include { model: <tag> }' });
  }
  if (!pullBootstrap.isAllowed(model)) {
    return res.status(400).json({
      error: `Model '${model}' is not in the in-app pull allowlist. Pull it via the terminal if needed.`,
    });
  }
  const job = pullBootstrap.start(getResolvedOllamaUrl(), model);
  return res.status(202).json(job);
});

ollamaHealthRouter.get('/pull/:id', (req: Request, res: Response) => {
  const job = pullBootstrap.getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: `No pull job '${req.params.id}'` });
  }
  return res.json(job);
});

/* POST /api/ollama/refresh — a thin alias for the existing GET /health.
   The UI uses POST semantically ("re-probe now") and we re-export the
   same envelope so the dropdown updates without a page reload. */
ollamaHealthRouter.post('/refresh', async (_req: Request, res: Response) => {
  /* Inline-dispatch into the existing GET handler by re-invoking the
     same probe. We can't just `res.redirect()` because the caller wants
     the body now, and the GET handler isn't memoised. Easiest: build a
     fake req+res chain. Instead we just re-implement the small probe
     here — it's already a one-liner that returns the JSON. */
  const url = getResolvedOllamaUrl();
  const expectedModel = getResolvedOllamaModel();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const [tagsResp, psResp] = await Promise.all([
      fetch(`${url}/api/tags`, { method: 'GET', signal: controller.signal }),
      fetch(`${url}/api/ps`, { method: 'GET', signal: controller.signal }),
    ]);
    clearTimeout(timer);
    if (!tagsResp.ok) {
      return res.json({
        status: 'unreachable',
        url,
        error: `Ollama returned ${tagsResp.status} ${tagsResp.statusText}`,
      });
    }
    const tagsBody = (await tagsResp.json().catch(() => ({}))) as {
      models?: Array<{ name?: string; model?: string }>;
    };
    const models = Array.isArray(tagsBody.models)
      ? tagsBody.models.map((m) => m.name ?? m.model ?? '').filter(Boolean)
      : [];
    const expectedRoot = expectedModel.split(':')[0];
    const hasExpected = models.some(
      (m) =>
        m === expectedModel ||
        m.startsWith(`${expectedModel}-`) ||
        (m.split(':')[0] === expectedRoot && m.startsWith(`${expectedRoot}:`)),
    );
    let resident: string[] = [];
    let expectedResident = false;
    if (psResp.ok) {
      const psBody = (await psResp.json().catch(() => ({}))) as {
        models?: Array<{ name?: string; model?: string }>;
      };
      resident = Array.isArray(psBody.models)
        ? psBody.models.map((m) => m.name ?? m.model ?? '').filter(Boolean)
        : [];
      expectedResident = resident.some(
        (m) =>
          m === expectedModel ||
          m.startsWith(`${expectedModel}-`) ||
          (m.split(':')[0] === expectedRoot && m.startsWith(`${expectedRoot}:`)),
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
      error: isTimeout
        ? `No response from ${url} within ${PROBE_TIMEOUT_MS}ms`
        : err.message || 'Ollama fetch failed.',
    });
  }
});
