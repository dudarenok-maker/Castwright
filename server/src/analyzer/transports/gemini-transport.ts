/* Gemini transport (#3084 wave 1, Task 1.9). Extracted from GeminiAnalyzer —
   owns the Gemini wire format (SDK call shape, request config, streamed
   response parsing, finish-reason mapping, token reconciliation) so the
   retry policy can live in transport-retry.ts and the analysis flow can
   live in gemini.ts.

   The transport NEVER throws for a completed response: truncation and
   content blocks are reported through `finish` and mapped to errors by
   the runner (finish.ts). It DOES throw abort / idle / HTTP / quota
   errors so the retry helper can classify and retry them. */
import { GoogleGenAI } from '@google/genai';
import { configValue } from '../../config/resolver.js';
import { AnalysisAbortedError, AnalyzerTimeoutError } from '../errors.js';
import { geminiRateLimiter } from '../rate-limit.js';
import { geminiModelThinks, warmGeminiCatalog, type GeminiModelsClient } from '../catalog/gemini-catalog.js';
import { GEMINI_FALLBACK_MAX_OUTPUT_TOKENS } from '../capacity.js';
import {
  BACKOFFS_MS,
  isRetryable5xx,
  parseRetryDelayMs,
  withTransportRetry,
  type RetryClassifier,
} from '../runner/transport-retry.js';

import type { ChatTransport, TransportRequest, TransportResult } from '../runner/transport.js';
import type { StageChunkInfo } from '../types.js';

/* Idle-chunk watchdog: if the SDK stream goes more than this long between
   chunks (or before the first chunk), assume the upstream is wedged and
   throw a retryable error so the retry loop kicks in. */
export const STREAM_IDLE_TIMEOUT_MS = 45_000;

/* Hard cap on the streamed-response accumulator. */
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export function appendBounded(buf: string, text: string, max = MAX_RESPONSE_BYTES): string {
  if (buf.length + text.length > max) {
    throw new Error('Analyzer response exceeded the maximum size.');
  }
  return buf + text;
}

export function resolveStreamIdleTimeoutMs(): number {
  const raw = process.env.GEMINI_STREAM_IDLE_MS;
  if (!raw) return STREAM_IDLE_TIMEOUT_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : STREAM_IDLE_TIMEOUT_MS;
}

/* #3084 P5 — how long a THINKING Gemini model may stay silent before its answer
   text starts. A long think can stream nothing, or only sparse thought
   summaries, before the answer, so the 45 s idle window would kill it. The
   knob's maximum is 290 000 ms: the SDK streams over the global fetch, whose
   undici headers/body timeouts are fixed at 300 s. The wave 2 on-box row (run
   sheet §1) measures real chapters to tune this default. */
export const GEMINI_THINKING_IDLE_TIMEOUT_MS = 120_000;

/** P5 — the silence allowed before a Gemini request's answer text starts: the
    wait for the first chunk and each gap between thought parts.
    analyzer.gemini.thinkingIdleTimeoutMs = 0 (the default) is automatic per
    model: 120 s for a model that thinks (static id rule, P27), otherwise the
    stream idle window. A positive value applies to every model. */
export function resolveGeminiThinkingIdleTimeoutMs(model: string): number {
  const configured = configValue<number>('analyzer.gemini.thinkingIdleTimeoutMs');
  if (configured > 0) return configured;
  return geminiModelThinks(model) ? GEMINI_THINKING_IDLE_TIMEOUT_MS : resolveStreamIdleTimeoutMs();
}

/** P5 — whether a timeout before answer text is a thinking-window timeout
    (AnalyzerTimeoutError, not retried) rather than today's idle timeout
    (GeminiStreamIdleError, retried): a model that thinks, or a positive knob. */
function geminiThinkingWindowApplies(model: string): boolean {
  return configValue<number>('analyzer.gemini.thinkingIdleTimeoutMs') > 0 || geminiModelThinks(model);
}

/** Live-read the cloud analyzer sampling temperature (registry wins). */
export function resolveGeminiTemperature(): number {
  return configValue<number>('analyzer.gemini.temperature');
}

/** Stream went silent for the watchdog window with no chunk. */
export class GeminiStreamIdleError extends Error {
  readonly code = 'GEMINI_STREAM_IDLE';
  constructor(
    public readonly model: string,
    public readonly idleMs: number,
  ) {
    super(`Gemini ${model} stream went idle for ${idleMs}ms with no chunk.`);
    this.name = 'GeminiStreamIdleError';
  }
}

/* The Gemini-specific retry classifier. Encodes the same error→action
   mapping the old generateWithLimiter inlined. */
export const GEMINI_RETRY_CLASSIFIER: RetryClassifier = {
  classify(err: unknown) {
    if (err instanceof AnalysisAbortedError) return 'abort';
    if (err instanceof GeminiStreamIdleError) return 'idle';
    /* #3084 P5 — a thinking-window or ceiling timeout already exceeds the 90 s
       retry budget: rethrow at once, with no "retrying" warning and no
       onThrottle announcement for an attempt the loop would never start. */
    if (err instanceof AnalyzerTimeoutError) return 'no-retry';
    const status = (err as { status?: number })?.status;
    const message = (err as Error)?.message ?? String(err);
    if (status === 429) {
      if (/per[_-]?day/i.test(message)) return 'daily-quota';
      return 'rate-limit';
    }
    if (isRetryable5xx(err)) return 'server-error';
    return 'no-retry';
  },
  retryAfterMs(err: unknown): number | null {
    return parseRetryDelayMs(err);
  },
};

interface GeminiTransportOptions {
  apiKey: string;
  model: string;
  /** A pre-built SDK client (tests inject one); production builds it from apiKey. */
  client?: GeminiModelsClient;
  /** #3084 P5 — overrides analyzer.gemini.requestCeilingMs. A test seam: the
      knob's minimum is 60 000 ms, so tests pass a much smaller value. */
  requestCeilingMs?: number;
}

type GeminiChunk = {
  text?: string;
  usageMetadata?: {
    promptTokenCount?: number;
    candidatesTokenCount?: number;
    thoughtsTokenCount?: number;
  };
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
  }>;
  promptFeedback?: { blockReason?: string };
};

export class GeminiTransport implements ChatTransport {
  readonly kind = 'gemini' as const;
  readonly model: string;
  private readonly client: GoogleGenAI;
  private readonly apiKey: string;
  private readonly requestCeilingMs: number | undefined;

  constructor(opts: GeminiTransportOptions) {
    this.client = (opts.client as unknown as GoogleGenAI) ?? new GoogleGenAI({ apiKey: opts.apiKey });
    this.apiKey = opts.apiKey;
    this.model = opts.model;
    this.requestCeilingMs = opts.requestCeilingMs;
  }

  /** #3084 wave 2b — warm the model catalog (Auto max output tokens) before the
      runner reads settings. warmGeminiCatalog never rejects, waits at most
      10 s, and returns at once when `signal` aborts (P26). */
  prepare(signal?: AbortSignal): Promise<void> {
    return warmGeminiCatalog(this.apiKey, { client: this.client as unknown as GeminiModelsClient, signal });
  }

  /* Every wire call — including the escalation pass — goes through the shared
     per-model rate limiter and the transport-level retry policy. This wrapper
     is the pre-#3084 `generateWithLimiter` behaviour (rate-limit acquisition,
     classification, backoff, daily-quota blocking) and lives here rather than
     in StageRunner so `ChatTransport` stays engine-agnostic: only the engine
     that needs a limiter carries one (#3343). */
  send(req: TransportRequest): Promise<TransportResult> {
    return withTransportRetry(() => this.generate(req), {
      model: this.model,
      limiter: geminiRateLimiter,
      estimatedInputTokens: req.estimatedInputTokens,
      classifier: GEMINI_RETRY_CLASSIFIER,
      signal: req.signal,
      onThrottle: req.call.onThrottle,
      maxAttempts: 3,
      maxTotalMs: 90_000,
      backoffsMs: BACKOFFS_MS,
      /* Pre-W1 reconciled only on a returned text; a truncated or blocked
         response was thrown and never reconciled. */
      recordActualTokens: (r) => (r.finish === 'stop' ? r.usage?.inputTokens : undefined),
      logTag: 'gemini',
      displayName: 'Gemini',
    });
  }

  /* One wire attempt. Throws aborted / idle / HTTP / quota errors so the
     retry wrapper above can classify and retry them; never throws for a
     completed response. */
  private async generate(req: TransportRequest): Promise<TransportResult> {
    const contents = req.messages.map((m) => ({
      role: m.role === 'assistant' ? ('model' as const) : ('user' as const),
      parts: [{ text: m.content }],
    }));

    /* #3084 P27 — decided once per request from the static id rule, never the
       live catalog, so a model's request shape and its reasoning evidence never
       change between requests. */
    const includeThoughts = geminiModelThinks(this.model);
    const config: Record<string, unknown> = {
      systemInstruction: req.system,
      temperature: req.temperature,
      ...(includeThoughts ? { thinkingConfig: { includeThoughts: true } } : {}),
      maxOutputTokens: req.maxOutputTokens ?? GEMINI_FALLBACK_MAX_OUTPUT_TOKENS,
    };
    if (req.structuredOutput.mode === 'json') {
      config.responseMimeType = 'application/json';
    } else if (req.structuredOutput.mode === 'schema') {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = req.structuredOutput.schema;
    }

    const watchdog = new AbortController();
    let idleFired = false;
    /* #3084 P5 — every Gemini request is bounded by an absolute ceiling, created
       here inside the per-attempt call, which runs AFTER the limiter was
       acquired, so queue time is not charged. */
    const requestCeilingMs = this.requestCeilingMs ?? configValue<number>('analyzer.gemini.requestCeilingMs');
    const ceiling = AbortSignal.timeout(requestCeilingMs);
    const requestStartedAt = Date.now();
    /* #3084 P5 — measured for the per-attempt timing line (on-box tuning). */
    let firstChunkMs: number | null = null;
    let firstAnswerMs: number | null = null;
    let thoughtPartsBeforeAnswer = 0;

    const signals: AbortSignal[] = [watchdog.signal, ceiling];
    if (req.signal) signals.push(req.signal);
    const combined = AbortSignal.any(signals);
    config.abortSignal = combined;

    const idleTimeoutMs = resolveStreamIdleTimeoutMs();
    const thinkingIdleTimeoutMs = resolveGeminiThinkingIdleTimeoutMs(this.model);
    const thinkingWindowApplies = geminiThinkingWindowApplies(this.model);
    /* #3084 P5 — true while the pending timer bounds silence before the answer
       text with the thinking window, so its expiry is a thinking-window timeout
       (not retried) rather than an idle timeout (retried). */
    let armedForThinking = thinkingWindowApplies;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    /** Until the answer text starts, every gap gets the thinking window; from
        then on, the idle window. */
    const armIdleTimer = (answerStarted: boolean) => {
      if (idleTimer) clearTimeout(idleTimer);
      armedForThinking = !answerStarted && thinkingWindowApplies;
      idleTimer = setTimeout(
        () => {
          idleFired = true;
          watchdog.abort();
        },
        answerStarted ? idleTimeoutMs : thinkingIdleTimeoutMs,
      );
    };
    const disarmIdleTimer = () => {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    };

    let onAbort: (() => void) | null = null;
    const abortPromise = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error('__gemini_abort_race__'));
      if (combined.aborted) onAbort();
      else combined.addEventListener('abort', onAbort, { once: true });
    });
    const releaseAbortListener = () => {
      if (onAbort) combined.removeEventListener('abort', onAbort);
    };

    try {
      /* #3084 P5 — no answer text yet: bounded by the thinking window. */
      armIdleTimer(false);
      const stream = await this.client.models.generateContentStream({
        model: this.model,
        contents,
        config,
      });
      const start = Date.now();
      let lastChunkAt = start;
      let buf = '';
      let promptTokenCount: number | undefined;
      let candidatesTokenCount: number | undefined;
      let thoughtsTokenCount: number | undefined;
      let finishReason: string | undefined;
      let promptBlockReason: string | undefined;
      let reasoningSeen = false;

      const iterator = (stream as AsyncIterable<GeminiChunk>)[Symbol.asyncIterator]();
      while (true) {
        const next = (await Promise.race([
          iterator.next(),
          abortPromise,
        ])) as IteratorResult<GeminiChunk>;
        if (next.done) break;
        armIdleTimer(buf !== '');
        const chunk = next.value;

        /* Thought parts → reasoningSeen, but never enter the text buffer. */
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const p of parts) {
            if (p.thought) reasoningSeen = true;
          }
        }

        if (firstChunkMs === null) firstChunkMs = Date.now() - requestStartedAt;
        if (!buf) {
          thoughtPartsBeforeAnswer += (chunk.candidates?.[0]?.content?.parts ?? []).filter((p) => p.thought === true).length;
        }

        const usage = chunk.usageMetadata;
        if (usage?.promptTokenCount && Number.isFinite(usage.promptTokenCount)) {
          promptTokenCount = usage.promptTokenCount;
        }
        if (usage?.candidatesTokenCount && Number.isFinite(usage.candidatesTokenCount)) {
          candidatesTokenCount = usage.candidatesTokenCount;
        }
        if (usage?.thoughtsTokenCount && Number.isFinite(usage.thoughtsTokenCount)) {
          thoughtsTokenCount = usage.thoughtsTokenCount;
        }

        const chunkFinish = chunk.candidates?.[0]?.finishReason;
        if (chunkFinish) finishReason = chunkFinish;
        const chunkBlock = chunk.promptFeedback?.blockReason;
        if (chunkBlock) promptBlockReason = chunkBlock;

        const text = chunk.text;
        if (!text) {
          /* #3084 wave 2b (P4) — a thought-only chunk (includeThoughts) is proof
             the model is alive: feed the route heartbeat with the answer buffer
             unchanged, so a long think does not read as a silent stream. The
             idle watchdog was already re-armed for this chunk above. */
          const chunkHadThought = (chunk.candidates?.[0]?.content?.parts ?? []).some((p) => p.thought === true);
          if (chunkHadThought) {
            const now = Date.now();
            req.call.onChunk?.({
              receivedBytes: buf.length,
              receivedText: buf,
              sinceLastChunkMs: now - lastChunkAt,
              elapsedMs: now - start,
            });
            lastChunkAt = now;
          }
          continue;
        }
        buf = appendBounded(buf, text);
        if (firstAnswerMs === null) {
          firstAnswerMs = Date.now() - requestStartedAt;
          /* #3084 P5 — the answer has started: from this chunk on, the 45 s
             idle watchdog applies, as today. */
          armIdleTimer(true);
        }
        const now = Date.now();
        req.call.onChunk?.({
          receivedBytes: buf.length,
          receivedText: buf,
          sinceLastChunkMs: now - lastChunkAt,
          elapsedMs: now - start,
        } satisfies StageChunkInfo);
        lastChunkAt = now;
      }

      /* Map finish reason to TransportResult.finish. The transport NEVER
         throws for a completed response — MAX_TOKENS/SAFETY/RECITATION are
         reported through `finish` so the runner (finish.ts) maps them to
         errors. */
      let finish: TransportResult['finish'];
      let blockReason: string | undefined;
      if (!buf) {
        if (finishReason === 'MAX_TOKENS') {
          finish = 'length';
        } else {
          finish = 'blocked';
          blockReason = finishReason ?? promptBlockReason;
        }
      } else if (
        !finishReason ||
        finishReason === 'STOP' ||
        finishReason === 'FINISH_REASON_UNSPECIFIED'
      ) {
        finish = 'stop';
      } else {
        finish = 'length';
      }

      /* Limiter reconciliation for a clean finish happens in `send`, via
         withTransportRetry's `recordActualTokens` option — a finish of
         'length'/'blocked' is reported here and deliberately never
         reconciled (pre-W1 only reconciled a returned text; #3343). */

      const resultUsage: TransportResult['usage'] = {};
      if (promptTokenCount !== undefined) resultUsage.inputTokens = promptTokenCount;
      if (candidatesTokenCount !== undefined) resultUsage.outputTokens = candidatesTokenCount;
      /* #3084 P27 — a thoughtsTokenCount is reasoning evidence only on a request
         that asked for thoughts. Gemma asks for none, so its empty MAX_TOKENS
         keeps the #528 split recovery even if the response reports a count. */
      if (includeThoughts && thoughtsTokenCount !== undefined) {
        resultUsage.reasoningTokens = thoughtsTokenCount;
      }

      /* Truncation is a transport SUCCESS here (mapFinish/finish.ts raises the
         classified AnalyzerTruncatedError centrally) — but pre-W1 logged this
         at the point of detection, and mirrors OllamaTransport's own
         transport-layer warn (ollama-transport.ts), so restore it here rather
         than relying on the (silent) central throw. */
      if (finish === 'length') {
        console.warn(
          `[gemini] output truncated reason=${finishReason ?? 'unknown'} bytes=${buf.length}` +
            (resultUsage.outputTokens ? ` tokens=${resultUsage.outputTokens}` : '') +
            ` model=${this.model}`,
        );
      }

      /* A content block is a transport SUCCESS here too (mapFinish/finish.ts
         raises the classified GeminiContentBlockedError centrally) — but
         pre-W1 threw it inline, which fell into the SAME catch as every
         other failure and got the full structured dump below (gemini.ts
         671 -> 710-726). Restore that dump at the point of detection, same
         as the 'length' restoration just above, so an operator isn't blind
         to a content block the way #3349 pass-2 review found: the B101
         on-box criterion ("no `[gemini] generate failed` line") had gone
         silently unable to fail for this case specifically. */
      if (finish === 'blocked') {
        const userTurn = contents[contents.length - 1]?.parts[0]?.text ?? '';
        console.error('[gemini] generate failed', {
          model: this.model,
          blockReason,
          userTurnLength: userTurn.length,
          userTurnHead: userTurn.slice(0, 200),
        });
      }

      return {
        text: buf,
        reasoningSeen,
        finish,
        finishReason:
          finishReason && finishReason !== 'STOP' && finishReason !== 'FINISH_REASON_UNSPECIFIED'
            ? finishReason
            : undefined,
        blockReason,
        usage: Object.keys(resultUsage).length > 0 ? resultUsage : undefined,
        receivedBytes: buf.length,
      };
    } catch (err) {
      if (idleFired) {
        /* #3084 P5 — silence before any answer text, past the thinking window:
           not an idle stall to retry, but a timeout naming its setting. */
        if (armedForThinking) {
          throw new AnalyzerTimeoutError('gemini', this.model, Date.now() - requestStartedAt, 'thinking-idle');
        }
        throw new GeminiStreamIdleError(this.model, idleTimeoutMs);
      }
      if (req.signal?.aborted) {
        throw new AnalysisAbortedError(
          `Gemini ${this.model} stream aborted (paused or client disconnected).`,
        );
      }
      if (ceiling.aborted) {
        throw new AnalyzerTimeoutError('gemini', this.model, Date.now() - requestStartedAt, 'ceiling');
      }
      /* The SDK's ApiError keeps the upstream body inside `.message` as a
         JSON envelope, so a bare rethrow only shows the stack + the start of
         the message. Force a structured dump so the server log carries the
         upstream `status` ('INTERNAL', 'INVALID_ARGUMENT', …) and any
         `details[]` payload — the only useful diagnostic for a 5xx/4xx that
         withTransportRetry classifies 'no-retry' or exhausts its retries on.
         Moved from pre-W1 generate()'s own catch (gemini.ts:710-726). */
      const status = (err as { status?: number })?.status;
      const message = (err as Error)?.message ?? String(err);
      const userTurn = contents[contents.length - 1]?.parts[0]?.text ?? '';
      console.error('[gemini] generate failed', {
        model: this.model,
        status,
        name: (err as Error)?.name,
        message,
        userTurnLength: userTurn.length,
        userTurnHead: userTurn.slice(0, 200),
      });
      throw err;
    } finally {
      disarmIdleTimer();
      releaseAbortListener();
      /* #3084 P5 — one line per request attempt, for on-box tuning of the
         thinking window. Counts and timings only: never request or response
         content. */
      console.info(
        `[gemini] stream-timing model=${this.model} firstChunkMs=${firstChunkMs ?? 'none'} firstAnswerMs=${firstAnswerMs ?? 'none'} thoughtPartsBeforeAnswer=${thoughtPartsBeforeAnswer}`,
      );
    }
  }
}
