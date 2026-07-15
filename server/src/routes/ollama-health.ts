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
import { configValue } from '../config/resolver.js';
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

/* Warming a cold Ollama model into VRAM takes ~5-15s for a small model but a
   large one (e.g. 15 GB) on a slow disk can take a minute-plus — the old hard
   30s made that read as "unreachable" when it was only loading. The budget is
   now a registry knob (analyzer.ollama.warmTimeoutMs, default below); this
   constant is only the fallback when the config layer isn't wired (tests).
   /unload stays on the 2s probe budget. */
const WARM_TIMEOUT_FALLBACK_MS = 120_000;

function resolveWarmTimeoutMs(): number {
  const v = configValue<number>('analyzer.ollama.warmTimeoutMs');
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : WARM_TIMEOUT_FALLBACK_MS;
}

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

type OllamaResidentModel = NonNullable<OllamaPsResponse['models']>[number];

/* Shared /api/ps probe: null means unreachable (non-2xx or the request
   itself failed); an array (possibly empty) means Ollama answered. Kept
   separate from the two public probes below so each can fold that
   distinction the way its caller needs it. */
async function probeOllamaResidentModels(): Promise<OllamaResidentModel[] | null> {
  const url = getResolvedOllamaUrl();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const resp = await fetch(`${url}/api/ps`, { method: 'GET', signal: controller.signal });
    if (!resp.ok) return null;
    const body = (await resp.json().catch(() => ({}))) as OllamaPsResponse;
    return Array.isArray(body.models) ? body.models : [];
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Best-effort GPU/CPU detection from Ollama /api/ps (`size_vram`). Seeds the
    analyzer's first-chapter ETA rate before any wall-clock sample exists —
    local Ollama runs ~10× faster on CUDA than CPU (user-measured ≈150 vs
    ≈15 chars/s). Returns 'unknown' on any failure (no model resident, daemon
    down, parse error); the caller defaults to the GPU rate and the estimate
    self-corrects from observed pace within the first chapter regardless.

    Deliberately collapses "nothing resident" and "daemon unreachable" into
    the same 'unknown' — this feeds the GPU/CPU cost-eviction guards
    (gpu/analyzer-device-state.ts), which only need "definitely CPU" vs.
    "assume GPU, be safe." See detectOllamaDeviceDetailed() for the
    finer-grained version the read-only Advanced Configuration row uses. */
export async function detectOllamaDevice(): Promise<'cuda' | 'cpu' | 'unknown'> {
  const models = await probeOllamaResidentModels();
  if (!models || models.length === 0) return 'unknown';
  return models.some((m) => (m.size_vram ?? 0) > 0) ? 'cuda' : 'cpu';
}

/** Same probe as detectOllamaDevice(), but for display: distinguishes
    "Ollama's reachable, nothing is currently loaded" (idle) from "can't
    reach Ollama at all" (unreachable) instead of collapsing both into
    'unknown' — the row otherwise reads as broken/unhelpful on every visit
    that lands between generations, since Ollama's default keep_alive has
    usually already evicted the model by the time someone opens Advanced
    Configuration (issue #1225). Not used by the cost-eviction guards —
    those intentionally stay on the coarser detectOllamaDevice() above. */
export async function detectOllamaDeviceDetailed(): Promise<'cuda' | 'cpu' | 'idle' | 'unreachable'> {
  const models = await probeOllamaResidentModels();
  if (models === null) return 'unreachable';
  if (models.length === 0) return 'idle';
  return models.some((m) => (m.size_vram ?? 0) > 0) ? 'cuda' : 'cpu';
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
  /** Curated install list (= pull suggestions + pull allowlist). Static per
      release; surfaced here so the frontend stops mirroring it. */
  pullable?: string[];
  error?: string;
}

/* Probe the Ollama daemon once (tags + ps in parallel) and normalise the
   result. Extracted from the route handler so /api/diagnostics can reuse it. */
export async function probeOllamaHealth(): Promise<OllamaHealthResult> {
  const url = getResolvedOllamaUrl();
  const expectedModel = getResolvedOllamaModel();
  /* The curated install list — both the Model Manager's pull suggestions and
     the in-app pull allowlist. Static per release; attached to every envelope
     so the frontend fetches it instead of hardcoding a mirror. */
  const pullable = pullBootstrap.listAllowed();
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
        pullable,
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
      pullable,
    };
  } catch (e) {
    clearTimeout(timer);
    const err = e as { name?: string; message?: string };
    const isTimeout = err.name === 'AbortError';
    return {
      status: 'unreachable',
      url,
      pullable,
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

/* GET /api/ollama/device — Plan 2 §2.4. Surfaces the analyzer's live
   GPU/CPU/idle/unreachable placement for the Advanced Configuration
   read-only device row. Not app-pinnable — the analyzer connects to a
   user/OS-managed Ollama daemon, so there's nothing to write here. Uses
   the detailed probe (not the cost-guard's detectOllamaDevice()) so the
   row can tell "idle" apart from "unreachable" — see issue #1225. */
ollamaHealthRouter.get('/device', async (_req: Request, res: Response) => {
  res.json({ device: await detectOllamaDeviceDetailed() });
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
  extSignal?: AbortSignal,
): Promise<{ ok: boolean; status: number; error?: string; aborted?: boolean; connError?: boolean }> {
  const target = `${url}/api/generate`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const signal = extSignal ? AbortSignal.any([controller.signal, extSignal]) : controller.signal;
  try {
    const upstream = await fetch(target, {
      method: 'POST',
      signal,
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
    const isAbort = err.name === 'AbortError';
    return {
      ok: false,
      status: 503,
      error: isAbort
        ? `Ollama did not respond within ${timeoutMs}ms.`
        : err.message || 'Ollama request failed.',
      /* `aborted` = our timeout timer OR an external cancel fired (the caller
         disambiguates via its own signal). `connError` = fetch itself threw a
         non-abort error, i.e. the daemon wasn't reachable (ECONNREFUSED /
         ENOTFOUND / socket reset). Lets warmOllamaModel classify the failure
         kind without re-parsing the message string. */
      aborted: isAbort,
      connError: !isAbort,
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
/* Discriminated warm outcome (Part 2). `unreachable` = the daemon isn't
   answering (start Ollama); `load_timeout` = it's up but the model didn't
   finish loading inside the budget (bigger model / slower disk, or wait);
   `cancelled` = the caller aborted mid-warm; `error` = a running daemon
   returned an HTTP error (e.g. the model isn't pulled). The route maps each
   kind to its HTTP status; script-review maps each to distinct UI copy. */
export type WarmModelResult =
  | { ok: true }
  | {
      ok: false;
      kind: 'unreachable' | 'load_timeout' | 'cancelled' | 'error';
      status: number;
      error: string;
    };

/** Cheap reachability pre-check before the (now much longer) warm budget: a
    connection error (ECONNREFUSED/ENOTFOUND) → 'refused', so "Ollama isn't
    running" is reported immediately instead of after the full timeout. Any HTTP
    response → 'reachable' (even a 5xx means the daemon answered; let the warm
    proceed). An abort → 'timeout' (reachable-but-hung daemon, or an external
    cancel — the caller checks its own signal); fall through to the warm. */
async function probeOllamaReachable(
  url: string,
  extSignal?: AbortSignal,
): Promise<'reachable' | 'refused' | 'timeout'> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  const signal = extSignal ? AbortSignal.any([controller.signal, extSignal]) : controller.signal;
  try {
    await fetch(`${url}/api/tags`, { method: 'GET', signal });
    return 'reachable';
  } catch (e) {
    const err = e as { name?: string };
    return err.name === 'AbortError' ? 'timeout' : 'refused';
  } finally {
    clearTimeout(timer);
  }
}

/** Warm `model` into VRAM via the keep_alive:'5m' empty-prompt idiom, using the
    same num_ctx/num_gpu the analyzer's runStage path uses (see the CRITICAL
    note above). Extracted so the script-review job can warm the analyzer model
    in-process, not just via the /load route below.

    Patient by design (Part 2): a merely-SLOW cold load is waited out to the
    analyzer.ollama.warmTimeoutMs budget (default 120s) — only a genuine
    connection refusal is 'unreachable'. `onProgress(elapsedMs)` fires on a 1s
    ticker while the blocking POST is in flight (liveness the keep_alive call
    can't emit itself; an /api/ps poll can't help because /api/ps lists only
    already-resident models). An external `signal` short-circuits to
    'cancelled'. */
export async function warmOllamaModel(
  model: string,
  opts: { signal?: AbortSignal; onProgress?: (elapsedMs: number) => void } = {},
): Promise<WarmModelResult> {
  const url = getResolvedOllamaUrl();

  // 1. Fast reachability pre-check — a refused connection is 'unreachable' now,
  //    not after the whole warm budget.
  const reach = await probeOllamaReachable(url, opts.signal);
  if (opts.signal?.aborted) return { ok: false, kind: 'cancelled', status: 499, error: 'Warm cancelled.' };
  if (reach === 'refused') {
    return { ok: false, kind: 'unreachable', status: 503, error: `Can't reach Ollama at ${url}. Is the daemon running?` };
  }

  // 2. Liveness ticker while the (blocking) keep_alive POST runs.
  const startedAt = Date.now();
  let ticker: ReturnType<typeof setInterval> | undefined;
  if (opts.onProgress) {
    opts.onProgress(0);
    ticker = setInterval(() => {
      if (!opts.signal?.aborted) opts.onProgress?.(Date.now() - startedAt);
    }, 1000);
  }

  try {
    const budget = resolveWarmTimeoutMs();
    const result = await callOllamaGenerate(
      url,
      {
        model,
        prompt: '',
        keep_alive: '5m',
        stream: false,
        options: { num_ctx: resolveAnalyzerNumCtx(), num_gpu: resolveAnalyzerNumGpu() },
      },
      budget,
      opts.signal,
    );
    if (result.ok) return { ok: true };
    // Classify the failure. Check the external signal FIRST so a cancel that
    // aborted the POST reads as 'cancelled', not 'load_timeout'.
    if (opts.signal?.aborted) return { ok: false, kind: 'cancelled', status: 499, error: 'Warm cancelled.' };
    if (result.aborted) {
      return {
        ok: false,
        kind: 'load_timeout',
        status: 504,
        error: `The analyzer model (${model}) didn't finish loading within ${Math.round(budget / 1000)}s.`,
      };
    }
    if (result.connError) {
      return { ok: false, kind: 'unreachable', status: 503, error: result.error || `Can't reach Ollama at ${url}.` };
    }
    // A running daemon returned an HTTP error (e.g. 404 — model not pulled).
    return { ok: false, kind: 'error', status: result.status, error: result.error || 'Ollama warm failed.' };
  } finally {
    if (ticker) clearInterval(ticker);
  }
}

ollamaHealthRouter.post('/load', async (req: Request, res: Response) => {
  const requested = typeof req.body?.model === 'string' ? req.body.model.trim() : '';
  const model = requested || getResolvedOllamaModel();
  const result = await warmOllamaModel(model);
  if (!result.ok) {
    // Carry `kind` so the UI can distinguish "Ollama isn't running" from
    // "the model took too long to load".
    return res.status(result.status).json({ status: 'error', error: result.error, kind: result.kind });
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

/* POST /api/ollama/refresh — a thin "re-probe now" alias for GET /health.
   Delegates to probeOllamaHealth() so the two stay byte-identical (incl. the
   `pullable` install list) — no duplicated inline probe to drift. */
ollamaHealthRouter.post('/refresh', async (_req: Request, res: Response) => {
  res.json(await probeOllamaHealth());
});
