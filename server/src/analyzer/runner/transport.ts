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
  /** undefined = the transport's pre-wave-2 default (Ollama resolveNumPredict, Gemini resolveMaxOutputTokens). */
  maxOutputTokens?: number;
  estimatedInputTokens: number;
  signal?: AbortSignal;
  call: Pick<StageCall, 'onChunk' | 'onWaiting' | 'onThrottle' | 'onEvalTiming'>;
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
}
