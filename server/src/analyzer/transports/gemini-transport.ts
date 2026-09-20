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
import { AnalysisAbortedError } from '../errors.js';
import { geminiRateLimiter } from '../rate-limit.js';
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

export const DEFAULT_MAX_OUTPUT_TOKENS = 8192;
export function resolveMaxOutputTokens(): number {
  return configValue<number>('analyzer.gemini.maxOutputTokens');
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
}

type GeminiChunk = {
  text?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
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

  constructor(opts: GeminiTransportOptions) {
    this.client = new GoogleGenAI({ apiKey: opts.apiKey });
    this.model = opts.model;
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

    const config: Record<string, unknown> = {
      systemInstruction: req.system,
      temperature: req.temperature,
      maxOutputTokens: req.maxOutputTokens ?? resolveMaxOutputTokens(),
    };
    if (req.structuredOutput.mode === 'json') {
      config.responseMimeType = 'application/json';
    } else if (req.structuredOutput.mode === 'schema') {
      config.responseMimeType = 'application/json';
      config.responseJsonSchema = req.structuredOutput.schema;
    }

    const watchdog = new AbortController();
    let idleFired = false;
    const signals: AbortSignal[] = [watchdog.signal];
    if (req.signal) signals.push(req.signal);
    const combined = AbortSignal.any(signals);
    config.abortSignal = combined;

    const idleTimeoutMs = resolveStreamIdleTimeoutMs();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleFired = true;
        watchdog.abort();
      }, idleTimeoutMs);
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
      armIdleTimer();
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
        armIdleTimer();
        const chunk = next.value;

        /* Thought parts → reasoningSeen, but never enter the text buffer. */
        const parts = chunk.candidates?.[0]?.content?.parts;
        if (parts) {
          for (const p of parts) {
            if (p.thought) reasoningSeen = true;
          }
        }

        const usage = chunk.usageMetadata;
        if (usage?.promptTokenCount && Number.isFinite(usage.promptTokenCount)) {
          promptTokenCount = usage.promptTokenCount;
        }
        if (usage?.candidatesTokenCount && Number.isFinite(usage.candidatesTokenCount)) {
          candidatesTokenCount = usage.candidatesTokenCount;
        }

        const chunkFinish = chunk.candidates?.[0]?.finishReason;
        if (chunkFinish) finishReason = chunkFinish;
        const chunkBlock = chunk.promptFeedback?.blockReason;
        if (chunkBlock) promptBlockReason = chunkBlock;

        const text = chunk.text;
        if (!text) continue;
        buf = appendBounded(buf, text);
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
        throw new GeminiStreamIdleError(this.model, idleTimeoutMs);
      }
      if (req.signal?.aborted) {
        throw new AnalysisAbortedError(
          `Gemini ${this.model} stream aborted (paused or client disconnected).`,
        );
      }
      throw err;
    } finally {
      disarmIdleTimer();
      releaseAbortListener();
    }
  }
}
