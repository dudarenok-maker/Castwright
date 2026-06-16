/* Plan 61 — in-app `ollama pull` proxy.
 *
 * Wraps the local Ollama daemon's POST /api/pull endpoint and tracks
 * progress for the UI. Unlike install-bootstrap.ts (which handles
 * "Ollama itself isn't on the box yet"), this assumes the daemon is
 * already up — we hit its native pull endpoint and surface streamed
 * progress.
 *
 * State machine:
 *   idle → pulling → pulled
 *                 └─ error
 *
 * The Ollama upstream API is NDJSON-streamed:
 *   {"status":"pulling manifest"}
 *   {"status":"downloading","digest":"sha256:…","total":…,"completed":…}
 *   {"status":"verifying sha256 digest"}
 *   {"status":"writing manifest"}
 *   {"status":"success"}
 *
 * We collapse those into one progress envelope (lastStatus + bytes).
 * On the legacy non-streaming path we just wait for the final response.
 *
 * Dependency-injectable: `fetchFn` is a constructor param so tests
 * never hit a live Ollama. The route does not auto-pull — it only
 * pulls the model the user explicitly clicked to pull.
 */

export type PullJobStatus = 'idle' | 'pulling' | 'pulled' | 'error';

export interface PullJob {
  id: string;
  model: string;
  status: PullJobStatus;
  lastStatusMessage: string;
  bytesReceived: number;
  bytesTotal: number | null;
  error: string | null;
  startedAt: number;
  updatedAt: number;
}

export type FetchFn = (
  url: string,
  init: { method: string; body: string; signal?: AbortSignal },
) => Promise<{
  ok: boolean;
  status: number;
  statusText: string;
  body: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}>;

export interface PullBootstrapOptions {
  fetchFn?: FetchFn;
  /** Allowlist of model tags the route is willing to pull. Defaults to
      the analyzer-supported set in src/lib/models.ts; the route layer
      enforces this so the user can't /pull arbitrary upstream tags. */
  allowedModels?: ReadonlySet<string>;
}

/** Conservative allowlist — mirrors the analyzer's MODEL_OPTIONS so the
    UI can only pull tags the rest of the app actually supports. */
export const DEFAULT_ALLOWED_MODELS: ReadonlySet<string> = new Set([
  'qwen3.5:4b',
  'qwen3.5:9b',
  'llama3.1:8b',
  'llama3.2:3b',
  'gemma3:4b',
  'gemma-4-E4B-it-GGUF:UD-Q4_K_XL',
]);

const defaultFetchFn: FetchFn = (url, init) =>
  fetch(url, init) as unknown as ReturnType<FetchFn>;

export class PullBootstrap {
  private jobs = new Map<string, PullJob>();
  private active: string | null = null;
  private nextId = 1;
  private readonly fetchFn: FetchFn;
  private readonly allowedModels: ReadonlySet<string>;

  constructor(opts: PullBootstrapOptions = {}) {
    this.fetchFn = opts.fetchFn ?? defaultFetchFn;
    this.allowedModels = opts.allowedModels ?? DEFAULT_ALLOWED_MODELS;
  }

  isAllowed(model: string): boolean {
    return this.allowedModels.has(model);
  }

  /** The curated install list — both the pull suggestions the Model Manager
      renders and the allowlist this proxy enforces. Single source of truth. */
  listAllowed(): string[] {
    return [...this.allowedModels];
  }

  getJob(id: string): PullJob | null {
    return this.jobs.get(id) ?? null;
  }

  getActiveJob(): PullJob | null {
    return this.active ? this.jobs.get(this.active) ?? null : null;
  }

  /** Kick off a pull for `model` against `ollamaUrl`. Returns the
      job snapshot synchronously; UI polls GET /pull/:id for progress. */
  start(ollamaUrl: string, model: string): PullJob {
    if (!this.isAllowed(model)) {
      const id = String(this.nextId++);
      const job: PullJob = {
        id,
        model,
        status: 'error',
        lastStatusMessage: '',
        bytesReceived: 0,
        bytesTotal: null,
        error: `Model '${model}' is not in the in-app pull allowlist. Pull it via the terminal if needed.`,
        startedAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.jobs.set(id, job);
      return job;
    }
    /* Coalesce: if an active job is already pulling THIS model, reuse it. */
    const existing = this.getActiveJob();
    if (existing && existing.model === model && existing.status === 'pulling') {
      return existing;
    }
    const id = String(this.nextId++);
    const job: PullJob = {
      id,
      model,
      status: 'pulling',
      lastStatusMessage: 'pulling manifest',
      bytesReceived: 0,
      bytesTotal: null,
      error: null,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.jobs.set(id, job);
    this.active = id;
    void this.run(job, ollamaUrl).catch((err) => {
      this.transition(job, 'error', {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return job;
  }

  private async run(job: PullJob, ollamaUrl: string): Promise<void> {
    const url = `${ollamaUrl.replace(/\/+$/, '')}/api/pull`;
    const res = await this.fetchFn(url, {
      method: 'POST',
      body: JSON.stringify({ name: job.model, stream: true }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Ollama /api/pull returned ${res.status} ${res.statusText}: ${text.slice(0, 200)}`);
    }
    if (!res.body) {
      /* Non-streamed response — we treat any 2xx as success. */
      this.transition(job, 'pulled', { lastStatusMessage: 'success' });
      return;
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let lineBuf = '';
    for (;;) {
      const result = await reader.read();
      if (result.done) break;
      lineBuf += decoder.decode(result.value, { stream: true });
      let nl: number;
      while ((nl = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, nl).trim();
        lineBuf = lineBuf.slice(nl + 1);
        if (!line) continue;
        this.consumeProgressLine(job, line);
      }
    }
    if (job.status === 'pulling') {
      this.transition(job, 'pulled', { lastStatusMessage: 'success' });
    }
  }

  private consumeProgressLine(job: PullJob, line: string): void {
    let parsed: {
      status?: string;
      total?: number;
      completed?: number;
      error?: string;
    };
    try {
      parsed = JSON.parse(line);
    } catch {
      /* Ollama very occasionally emits keep-alive noise; skip. */
      return;
    }
    if (parsed.error) {
      this.transition(job, 'error', { error: parsed.error });
      return;
    }
    const patch: Partial<PullJob> = {};
    if (parsed.status) patch.lastStatusMessage = parsed.status;
    if (typeof parsed.completed === 'number') patch.bytesReceived = parsed.completed;
    if (typeof parsed.total === 'number') patch.bytesTotal = parsed.total;
    this.update(job, patch);
    if (parsed.status === 'success') {
      this.transition(job, 'pulled', { lastStatusMessage: 'success' });
    }
  }

  private transition(job: PullJob, status: PullJobStatus, extra: Partial<PullJob> = {}): void {
    job.status = status;
    Object.assign(job, extra);
    job.updatedAt = Date.now();
  }

  private update(job: PullJob, patch: Partial<PullJob>): void {
    Object.assign(job, patch);
    job.updatedAt = Date.now();
  }

  _reset(): void {
    this.jobs.clear();
    this.active = null;
    this.nextId = 1;
  }
}

export const pullBootstrap = new PullBootstrap();
