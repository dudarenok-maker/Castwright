/* OpenAI Chat Completions transport for named endpoints (#3084 decisions
   1b, 1c; research 04-openai-sdk-facts; planning facts §A).

   Client: the official `openai` SDK with `fetch` built on undici.fetch (Node's
   global fetch rejects an npm-undici Agent) and a long-call dispatcher (no header
   or body timeout, 10 s connect), SDK retries off, SDK logging off. The SDK DOES
   read OPENAI_* environment variables when it is constructed: it merges
   OPENAI_CUSTOM_HEADERS into every request after its auth header (client.mjs:240-249).
   Every option it would take from env is passed explicitly, and allowlistedFetch
   rebuilds the outgoing headers from an allowlist, so no host env header reaches
   an endpoint and the key goes only to its own origin (P22).

   Signals: the absolute ceiling is AbortSignal.timeout(requestCeilingMs),
   created AFTER the endpoint semaphore is acquired, so queue time is never
   charged to the request. The idle watchdog arms on the first delta (answer
   OR reasoning). The SDK ends a stream SILENTLY on abort (openai
   core/streaming.ts:171-186), so a clean loop end is never trusted:
   classifyOpenAIOutcome decides from our own signals. */

import OpenAI, { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import type { ChatCompletionCreateParamsStreaming } from 'openai/resources/chat/completions';
import { Agent } from 'undici';
import type {
  ChatTransport,
  StructuredOutputRequest,
  TransportRequest,
  TransportResult,
  TransportUsage,
} from '../runner/transport.js';
import { withTransportRetry, type RetryClassifier } from '../runner/transport-retry.js';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerKeyOriginError,
  AnalyzerReasoningOverflowError,
  AnalyzerStreamIncompleteError,
  AnalyzerTimeoutError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
  causeCodeSuffix,
  sanitizeCauseCode,
} from '../errors.js';
import { analyzerRateLimiter } from '../rate-limit.js';
import { appendBounded, BACKOFFS_MS, resolveStreamIdleTimeoutMs } from '../gemini.js';
import { endpointModelId } from '../model-id.js';
import { endpointSemaphore, noteEndpointModelUsed } from './endpoint-runtime.js';
import type { AnalyzerEndpoint } from '../../workspace/analyzer-endpoints.js';
/* #3084 A9 — through the leaf gate: no import edge to workspace/user-settings.ts. */
import { loadKnownAnalyzerSecrets } from '../known-secrets-gate.js';
import { allowlistedFetch } from './allowlisted-fetch.js';
import { redactKnownSecrets } from '../redact.js';

type OpenAIClientOptions = NonNullable<ConstructorParameters<typeof OpenAI>[0]>;

/** #3084 P21 — connect-phase codes only: nothing on the other side was reached.
    Not ollama.ts's UNREACHABLE_CODES: its ECONNRESET, UND_ERR_SOCKET and EAI_AGAIN
    can come from an endpoint that is up (a reset before headers, a DNS hiccup), so
    for an endpoint they are OPENAI_PRE_HEADER_TRANSIENT_CODES instead. EHOSTUNREACH
    and ENETUNREACH: an unroutable address returns one of these or the connect
    timeout, depending on the host's routing table. */
export const OPENAI_UNREACHABLE_CODES: ReadonlySet<string> = new Set([
  'ECONNREFUSED',
  'ENOTFOUND',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/** #3084 P21 — before headers, these mean "retry", never "fall back to Gemini". */
export const OPENAI_PRE_HEADER_TRANSIENT_CODES: ReadonlySet<string> = new Set(['ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN']);

/* A llama.cpp request queued behind a busy slot gets no headers until a slot
   frees, and a long prefill streams nothing — both are bounded by the
   endpoint ceiling, never by the dispatcher. */
export const OPENAI_DISPATCHER = new Agent({ headersTimeout: 0, bodyTimeout: 0, connect: { timeout: 10_000 } });

/* #3084 P22 — allowlistedFetch lives in the leaf ./allowlisted-fetch.ts, so PR 3c's
   catalog listing, preview and served-limits clients import it without closing a
   transport → served-limits → catalog → transport cycle. Re-exported here for this
   module's tests and importers. */
export { allowlistedFetch, ANALYZER_USER_AGENT } from './allowlisted-fetch.js';

function causeChain(err: unknown): Array<{ code?: unknown; message?: unknown }> {
  const out: Array<{ code?: unknown; message?: unknown }> = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== null && typeof cur === 'object' && depth <= 4; depth += 1) {
    out.push(cur as { code?: unknown; message?: unknown });
    cur = (cur as { cause?: unknown }).cause;
  }
  return out;
}

export interface OutcomeContext {
  callerAborted: boolean;
  ceilingAborted: boolean;
  idleAborted: boolean;
  /** true once create() resolved — the SDK returns the Stream only after headers */
  headersReceived: boolean;
  sawFinish: boolean;
  elapsedMs: number;
  model: string;
  /** P22: redacted from every error this builds (the endpoint's key and every saved analyzer secret) */
  secrets: readonly string[];
}

/* Rule 7 (P20, P22) — our own analyzer errors pass through unchanged; the routes rethrow
   a reasoning overflow to stop the run. Anything else is rebuilt. */
function isOwnAnalyzerError(err: unknown): boolean {
  return (
    err instanceof AnalyzerReasoningOverflowError ||
    err instanceof AnalysisAbortedError ||
    err instanceof AnalyzerTimeoutError ||
    err instanceof AnalyzerHttpError ||
    err instanceof AnalyzerUnreachableError ||
    err instanceof AnalyzerStreamIncompleteError ||
    err instanceof AnalyzerTransportError ||
    err instanceof AnalyzerKeyOriginError
  );
}

/* The class names down the cause chain (the openai SDK's error classes set no `name`,
   so the constructor's name is read), each reduced to letters and digits. Never a
   message: upstream text can hold a header value, and so a key (P22). */
function chainClassNames(err: unknown): string {
  const names: string[] = [];
  let cur: unknown = err;
  for (let depth = 0; cur !== null && typeof cur === 'object' && depth <= 4; depth += 1) {
    const ctorName = (cur as { constructor?: { name?: unknown } }).constructor?.name;
    names.push(typeof ctorName === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(ctorName) ? ctorName : 'Error');
    cur = (cur as { cause?: unknown }).cause;
  }
  return names.length > 0 ? names.join(' <- ') : typeof err;
}

/** Decision 1c classification. `err` is undefined after a loop that ended
    without throwing. Returns null for a genuine success. */
export function classifyOpenAIOutcome(err: unknown, ctx: OutcomeContext): Error | null {
  if (ctx.callerAborted) {
    return new AnalysisAbortedError(`Endpoint ${ctx.model} call aborted (paused or client disconnected).`);
  }
  const chain = err === undefined ? [] : causeChain(err);
  const codes = chain.map((c) => c.code).filter((c): c is string => typeof c === 'string');
  /* P21 — only a connection-level failure can be "unreachable". An APIError with an
     HTTP status was built after the response arrived and carries the body's error.code
     (openai core/error.mjs:12, :35-65): a proxy's 502 reporting ECONNREFUSED is an
     answer, not an outage, and must never reach FallbackAnalyzer. */
  const connectionLevel =
    !isOwnAnalyzerError(err) &&
    (err instanceof APIConnectionError || (err !== undefined && !(err instanceof APIError) && !ctx.headersReceived));
  if (connectionLevel) {
    const unreachableCode = codes.find((c) => OPENAI_UNREACHABLE_CODES.has(c));
    const bareFetchFailed =
      codes.length === 0 && chain.some((c) => typeof c.message === 'string' && /fetch failed/i.test(c.message));
    if (unreachableCode || bareFetchFailed) {
      /* P22 — rebuilt: no `cause` (the SDK error and its chain stay behind), only the
         sanitized code. */
      return Object.assign(
        new AnalyzerUnreachableError(`Endpoint ${ctx.model} is unreachable (${unreachableCode ?? 'fetch failed'}).`, 'openai'),
        { causeCode: sanitizeCauseCode(unreachableCode, ctx.secrets) },
      );
    }
    /* P21 — a reset or a DNS hiccup before headers comes from a server that may be up:
       retried as an incomplete stream, so FallbackAnalyzer never sees it. P22, Q1 — it
       carries the sanitized transient code into its message. */
    const transientCode = ctx.headersReceived ? undefined : codes.find((c) => OPENAI_PRE_HEADER_TRANSIENT_CODES.has(c));
    if (transientCode) {
      return new AnalyzerStreamIncompleteError('openai', ctx.model, { causeCode: sanitizeCauseCode(transientCode, ctx.secrets) });
    }
  }
  if (ctx.ceilingAborted) return new AnalyzerTimeoutError('openai', ctx.model, ctx.elapsedMs, 'ceiling');
  if (err instanceof APIConnectionTimeoutError) {
    return new AnalyzerTimeoutError('openai', ctx.model, ctx.elapsedMs, 'connect-timeout');
  }
  if (err instanceof APIError && !(err instanceof APIConnectionError) && !(err instanceof APIUserAbortError)) {
    const status = typeof err.status === 'number' ? err.status : 0;
    /* P22 — redact BEFORE truncating, so a key the slice would cut in half cannot survive. */
    const excerpt = redactKnownSecrets(JSON.stringify(err.error ?? err.message), ctx.secrets).slice(0, 500);
    const httpError = new AnalyzerHttpError(
      'openai',
      status,
      excerpt,
      `Endpoint ${ctx.model} returned ${status === 0 ? 'an error event mid-stream' : status}: ${excerpt}`,
    );
    /* The raw SDK error is NOT attached as `cause`: it holds the unredacted body, and a
       logged error prints its cause chain. Only the retry hint travels. */
    return Object.assign(httpError, { retryAfterMs: retryAfterMs(err.headers as Headers | undefined) });
  }
  if (ctx.headersReceived) {
    const socketDrop =
      err !== undefined &&
      chain.some(
        (c) => c.code === 'UND_ERR_SOCKET' || c.code === 'ECONNRESET' || (typeof c.message === 'string' && /terminated/i.test(c.message)),
      );
    /* P25 — a finish_reason means the answer is complete. A watchdog that fires, or a
       socket that drops, while waiting for the trailing usage chunk or [DONE] must not
       retry a finished answer away. */
    if (ctx.sawFinish && ((ctx.idleAborted && (err === undefined || err instanceof APIUserAbortError)) || socketDrop)) {
      return null;
    }
    if (ctx.idleAborted || socketDrop || (err === undefined && !ctx.sawFinish)) {
      return new AnalyzerStreamIncompleteError('openai', ctx.model);
    }
  }
  if (err === undefined) return null;
  if (isOwnAnalyzerError(err)) return err as Error;
  /* P22 — never rethrow the SDK's error or keep its cause: undici's header errors embed
     the header value (`Headers.append: "Bearer <key>" is an invalid header value.`), and
     a logged error prints its whole cause chain. */
  /* Q1 — the sanitized code goes in the message too (causeCodeSuffix, the same ` (CODE)`
     shape as PR 3c's catalog listing error), so the run failure, the log and the Test
     action all show it. */
  const causeCode = sanitizeCauseCode(codes[0], ctx.secrets);
  return new AnalyzerTransportError(
    'openai',
    ctx.model,
    `Endpoint ${ctx.model} request failed${ctx.headersReceived ? '' : ' before a response'}${causeCodeSuffix(causeCode)} (${chainClassNames(err)}).`,
    causeCode,
  );
}

function retryAfterMs(headers: Headers | undefined): number | null {
  const ms = headers?.get('retry-after-ms');
  if (ms && Number.isFinite(Number(ms))) return Number(ms);
  const value = headers?.get('retry-after');
  if (!value) return null;
  if (Number.isFinite(Number(value))) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - Date.now()) : null;
}

export const OPENAI_RETRY_CLASSIFIER: RetryClassifier = {
  classify(err) {
    if (err instanceof AnalysisAbortedError) return 'abort';
    if (err instanceof AnalyzerStreamIncompleteError) return 'idle';
    if (err instanceof AnalyzerHttpError) {
      if (err.httpStatus === 429) return 'rate-limit';
      if ([500, 502, 503, 504].includes(err.httpStatus)) return 'server-error';
    }
    return 'no-retry';
  },
  retryAfterMs(err) {
    /* Set by classifyOpenAIOutcome from the SDK error's headers (no raw cause is kept, P22). */
    const value = (err as { retryAfterMs?: unknown }).retryAfterMs;
    return typeof value === 'number' ? value : null;
  },
};

export function openAIResponseFormat(so: StructuredOutputRequest): { response_format?: Record<string, unknown> } {
  if (so.mode === 'schema') {
    return { response_format: { type: 'json_schema', json_schema: { name: so.name, schema: so.schema, strict: false } } };
  }
  if (so.mode === 'json') return { response_format: { type: 'json_object' } };
  return {};
}

/** #3084 P24 — the margin endpoint Auto leaves between prompt + output and the
    served context: max(1024, 10% of contextTokens). The input size is an estimate,
    not a tokenizer count, and strict servers (vLLM) reject a prompt plus
    max_tokens above the served context. */
export function endpointAutoOutputMargin(contextTokens: number): number {
  return Math.max(1024, Math.ceil(contextTokens * 0.1));
}

/** #3084 P24 — the engine-level output cap OpenAIAnalyzer resolves into
    EngineRequestSettings.maxOutputTokens, a number (wave 2b resolves every engine's
    cap). A manual value is returned as saved; PR 3c clamps it to the served limit.
    Auto returns min(served output limit if known, contextTokens − margin). The
    request builder then takes each request's estimated input off Auto. */
export function resolveEndpointMaxOutputTokens(endpoint: AnalyzerEndpoint, servedOutputLimit?: number): number {
  if (endpoint.maxOutputTokens > 0) return endpoint.maxOutputTokens;
  const contextBound = Math.max(1, endpoint.contextTokens - endpointAutoOutputMargin(endpoint.contextTokens));
  return servedOutputLimit !== undefined ? Math.min(servedOutputLimit, contextBound) : contextBound;
}

/** Reasoning / extraParams: wave 5. */
export function buildOpenAIRequestBody(
  endpoint: AnalyzerEndpoint,
  model: string,
  req: TransportRequest,
): Record<string, unknown> {
  /* P24 — Auto (endpoint.maxOutputTokens 0) sends
     min(resolved cap, contextTokens − estimated input − margin), never below 1.
     A manual value is sent as resolved. */
  const perRequestBound = Math.max(
    1,
    endpoint.contextTokens - req.estimatedInputTokens - endpointAutoOutputMargin(endpoint.contextTokens),
  );
  const maxTokens =
    endpoint.maxOutputTokens > 0 && req.maxOutputTokens !== undefined
      ? req.maxOutputTokens
      : Math.min(req.maxOutputTokens ?? perRequestBound, perRequestBound);
  return {
    model,
    messages: [{ role: 'system', content: req.system }, ...req.messages],
    stream: true,
    stream_options: { include_usage: true },
    temperature: req.temperature,
    max_tokens: maxTokens,
    ...openAIResponseFormat(req.structuredOutput),
  };
}

interface StreamChunk {
  choices?: Array<{
    delta?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null; reasoning_details?: unknown[] | null };
    finish_reason?: string | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } } | null;
}

function mapFinishReason(reason: string): { finish: TransportResult['finish']; blockReason?: string } {
  if (reason === 'length') return { finish: 'length' };
  if (reason === 'content_filter') return { finish: 'blocked', blockReason: reason };
  return { finish: 'stop' };
}

export class OpenAITransport implements ChatTransport {
  readonly kind = 'openai' as const;
  readonly model: string;
  private readonly endpoint: AnalyzerEndpoint;
  private readonly client: OpenAI;
  private readonly now: () => number;
  /** P22: this endpoint's key, redacted from every error the transport builds. PR 3c's
      prepare() also reads it (w3cd Task 3c.9 must not add the field a second time). */
  private readonly apiKey: string | null;

  constructor(opts: { endpoint: AnalyzerEndpoint; apiKey: string | null; model: string; dispatcher?: Agent; now?: () => number }) {
    this.endpoint = opts.endpoint;
    this.model = opts.model;
    this.now = opts.now ?? Date.now;
    this.apiKey = opts.apiKey;
    this.client = new OpenAI({
      baseURL: opts.endpoint.baseUrl,
      /* A placeholder only: the SDK requires a string and would otherwise read
         OPENAI_API_KEY. allowlistedFetch drops the Authorization header the SDK
         builds from it and adds the real key, on its own origin only (P22). */
      apiKey: 'castwright-placeholder-key',
      organization: null,
      project: null,
      maxRetries: 0,
      timeout: opts.endpoint.requestCeilingMs,
      logLevel: 'off',
      fetch: allowlistedFetch(opts.apiKey, new URL(opts.endpoint.baseUrl).origin) as unknown as OpenAIClientOptions['fetch'],
      fetchOptions: { dispatcher: opts.dispatcher ?? OPENAI_DISPATCHER } as unknown as OpenAIClientOptions['fetchOptions'],
    });
  }

  async send(req: TransportRequest): Promise<TransportResult> {
    return withTransportRetry(() => this.attempt(req), {
      model: endpointModelId(this.endpoint.id, this.model),
      limiter: analyzerRateLimiter,
      estimatedInputTokens: req.estimatedInputTokens,
      classifier: OPENAI_RETRY_CLASSIFIER,
      signal: req.signal,
      onThrottle: req.call.onThrottle,
      maxAttempts: 3,
      maxTotalMs: this.endpoint.requestCeilingMs,
      backoffsMs: BACKOFFS_MS,
      /* W1's withTransportRetry requires both: the log prefix and the name in its
         "retry budget exhausted" error. Neither carries a key. */
      logTag: `openai:${this.endpoint.id}`,
      displayName: `Endpoint ${this.endpoint.name}`,
      recordActualTokens: (r) => r.usage?.inputTokens,
    });
  }

  private async attempt(req: TransportRequest): Promise<TransportResult> {
    const caller = req.signal;
    if (caller?.aborted) throw new AnalysisAbortedError(`Endpoint ${this.model} call aborted before sending.`);
    let release: () => void;
    try {
      release = await endpointSemaphore(this.endpoint).acquire({ signal: caller });
    } catch (err) {
      if (caller?.aborted) throw new AnalysisAbortedError(`Endpoint ${this.model} call aborted while queued.`);
      throw err;
    }

    const startedAt = this.now();
    const ceiling = AbortSignal.timeout(this.endpoint.requestCeilingMs);
    const idle = new AbortController();
    const combined = AbortSignal.any([ceiling, idle.signal, ...(caller ? [caller] : [])]);
    const idleMs = resolveStreamIdleTimeoutMs();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle.abort(), idleMs);
    };

    let headersReceived = false;
    let finishReason: string | null = null;
    let text = '';
    let reasoningSeen = false;
    let usage: TransportUsage | undefined;
    let lastChunkAt = startedAt;
    let streamError: unknown;

    /* P3, N2: the request is about to leave, so the server may load this model whether or
       not it answers — a run's call, a Test request and a call that then 5xxes all make it a
       valid `{model}` unload target. Recorded here, after the semaphore admitted the call and
       before `create()`: a call aborted while still queued threw above and records nothing. */
    noteEndpointModelUsed(this.endpoint.id, this.model);
    try {
      const stream = await this.client.chat.completions.create(
        buildOpenAIRequestBody(this.endpoint, this.model, req) as unknown as ChatCompletionCreateParamsStreaming,
        { signal: combined },
      );
      headersReceived = true;
      for await (const raw of stream) {
        const chunk = raw as unknown as StreamChunk;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta;
        const reasoningDelta =
          (typeof delta?.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
          (typeof delta?.reasoning === 'string' && delta.reasoning.length > 0) ||
          (Array.isArray(delta?.reasoning_details) && delta.reasoning_details.length > 0);
        const content = typeof delta?.content === 'string' ? delta.content : '';
        if (reasoningDelta) reasoningSeen = true;
        if (reasoningDelta || content) {
          armIdle();
          const now = this.now();
          if (content) text = appendBounded(text, content);
          /* Spec §1: reasoning deltas feed the route heartbeat too. A
             reasoning-only delta reports the answer bytes unchanged — the same
             convention as wave 2's Gemini thought-only chunk. */
          req.call.onChunk?.({ receivedBytes: text.length, receivedText: text, sinceLastChunkMs: now - lastChunkAt, elapsedMs: now - startedAt });
          lastChunkAt = now;
        }
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          usage = {
            inputTokens: chunk.usage.prompt_tokens,
            outputTokens: chunk.usage.completion_tokens,
            reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens,
          };
        }
      }
    } catch (err) {
      streamError = err;
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      release();
    }

    /* P22 — every error this attempt builds is redacted against this endpoint's key and
       every saved analyzer secret, read from settings if the cache is still cold. */
    const secrets = [...(this.apiKey ? [this.apiKey] : []), ...(await loadKnownAnalyzerSecrets())];
    const failure = classifyOpenAIOutcome(streamError, {
      callerAborted: caller?.aborted === true,
      ceilingAborted: ceiling.aborted,
      idleAborted: idle.signal.aborted,
      headersReceived,
      sawFinish: finishReason !== null,
      elapsedMs: this.now() - startedAt,
      model: this.model,
      secrets,
    });
    if (failure) throw failure;
    return { text, reasoningSeen, ...mapFinishReason(finishReason as string), usage, receivedBytes: text.length };
  }
}
