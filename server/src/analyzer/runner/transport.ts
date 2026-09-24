/* The chat-transport contract (#3084). A transport owns the wire format, the
   HTTP client, streaming, limiter/concurrency acquisition and transport-level
   retries. It returns a normalised result and NEVER throws for a completed
   response: truncation and content blocks are reported through `finish` and
   mapped to errors by the runner (finish.ts). It DOES throw abort /
   unreachable / HTTP / quota errors. */
import type { StageCall } from '../types.js';
import type { TransportKind } from '../errors.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type StructuredOutputMode = 'schema' | 'json' | 'off';

export type StructuredOutputRequest =
  | { mode: 'schema'; name: string; schema: Record<string, unknown> } // already adapted for this transport
  | { mode: 'json' }
  | { mode: 'off' };

export interface TransportRequest {
  system: string;
  messages: ChatMessage[];
  structuredOutput: StructuredOutputRequest;
  temperature: number;
  /** undefined = the transport's pre-wave-2 default (Ollama resolveNumPredict, Gemini GEMINI_FALLBACK_MAX_OUTPUT_TOKENS). */
  maxOutputTokens?: number;
  estimatedInputTokens: number;
  signal?: AbortSignal;
  /* 'onWaiting' deliberately excluded: StageRunner owns the waiting tick
     itself (stage-runner.ts's own setInterval) and no transport reads it off
     the request — a typed field a future transport would read straight off
     and always get undefined from, with no type error to catch it
     (pr-review-gate pass 1 finding 5). */
  call: Pick<StageCall, 'onChunk' | 'onThrottle' | 'onEvalTiming'>;
}

export interface TransportUsage {
  inputTokens?: number;
  outputTokens?: number;
  reasoningTokens?: number;
}

export interface TransportResult {
  /** Answer text only — never reasoning/thought text. */
  text: string;
  reasoningSeen: boolean;
  finish: 'stop' | 'length' | 'blocked';
  /** The provider's raw stop reason (Ollama done_reason, Gemini finishReason) — the AnalyzerTruncatedError `reason`. */
  finishReason?: string;
  /** Gemini SAFETY/RECITATION/prompt blockReason when finish === 'blocked'. */
  blockReason?: string;
  usage?: TransportUsage;
  receivedBytes: number;
}

export interface ChatTransport {
  readonly kind: TransportKind;
  readonly model: string;
  send(req: TransportRequest): Promise<TransportResult>;
  /** Optional async warm-up the runner awaits before reading EngineRequestSettings
      on every request — keeps settings resolution synchronous (e.g. the Gemini
      model catalog behind Auto max output tokens). Must never reject, must be
      bounded, and must return promptly when `signal` aborts (P26). */
  prepare?(signal?: AbortSignal): Promise<void>;
}
