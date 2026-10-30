/* The chat-transport contract (#3084). A transport owns the wire format, the
   HTTP client, streaming, limiter/concurrency acquisition and transport-level
   retries. It returns a normalised result and NEVER throws for a completed
   response: truncation and content blocks are reported through `finish` and
   mapped to errors by the runner (finish.ts). It DOES throw abort /
   unreachable / HTTP / quota errors. */
import type { StageCall } from '../types.js';
import type { TransportKind } from '../errors.js';
import type { ReasoningLevel } from '../reasoning-level.js';

export interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export type StructuredOutputMode = 'schema' | 'json' | 'off';

export type StructuredOutputRequest =
  | { mode: 'schema'; name: string; schema: Record<string, unknown> } // already adapted for this transport
  | { mode: 'json' }
  | { mode: 'off' };

/** A provider-adapted draft-07 schema plus the paths of any constraints it
    could not carry (schema-adapters.ts, capabilities.ts — lifted here so
    neither has to import the other and form a cycle). */
export interface AdaptedSchema {
  schema: Record<string, unknown>;
  dropped: string[];
}

/* Absolute ceiling for a one-shot persona generation. Needed because
   ANALYZER_DISPATCHER removes undici's implicit 300s bound and this call site
   has no caller-supplied signal to fall back on; see the note in the former Ollama persona
   function. Deliberately generous: the whole point of the
   dispatcher is that a large model on CPU legitimately takes minutes. Mirrors
   DESIGN_ABSOLUTE_MAX_MS in tts/design-voice-core.ts. Every transport bounds a
   free-text request at min(its own request ceiling, this). */
export const PERSONA_ABSOLUTE_MAX_MS = 600_000;

/** #3084 W4 — per-call options for a free-text request. `absoluteMaxMs` is read by EVERY transport;
    `onCpu` and `keepAlive` are Ollama-only (the Gemini and OpenAI transports otherwise use the
    PRESENCE of `TransportRequest.freeText`). */
export interface FreeTextOptions {
  /** Ollama: run on system RAM (`num_gpu: 0`). The analyzer slot is still acquired (with onCpu=true). */
  onCpu?: boolean;
  /** Ollama: `keep_alive` when no analysis run is busy (a busy run pins -1). Default 0. */
  keepAlive?: string | number;
  /** Every transport: absolute ceiling for a free-text request; default PERSONA_ABSOLUTE_MAX_MS.
      Ollama starts it after the slot; Gemini/OpenAI use min(request ceiling, this). Tests pass a
      small value to prove the bound fires. */
  absoluteMaxMs?: number;
}

/** #3084 W4 — input to StageRunner.runFreeText. */
export interface FreeTextInput {
  system?: string;
  prompt: string;
  signal?: AbortSignal;
  /** Omitted → the transport omits temperature (server/model default), as the pre-transport
      Gemini persona call did. The Ollama persona caller passes resolveOllamaTemperature(). */
  temperature?: number;
  /** The persona ceiling for ANY engine (see FreeTextOptions.absoluteMaxMs); merged into `freeText`. */
  absoluteMaxMs?: number;
  /** Ollama placement (`onCpu`, `keepAlive`); an `absoluteMaxMs` set here is also honoured. */
  ollama?: FreeTextOptions;
}

export interface TransportRequest {
  system: string;
  messages: ChatMessage[];
  structuredOutput: StructuredOutputRequest;
  temperature: number | undefined; // W4: undefined only on a free-text request → the transport omits it
  /** undefined = the transport's pre-wave-2 default (Ollama resolveNumPredict, Gemini GEMINI_FALLBACK_MAX_OUTPUT_TOKENS). */
  maxOutputTokens?: number;
  /** #3084 wave 5 — the resolved reasoning level. undefined = the pre-W5 wire
      (Ollama think:false; Gemini and OpenAI-compatible send no reasoning field). */
  reasoning?: ReasoningLevel;
  /** #3084 wave 5 — the engine/endpoint custom payload, merged last by the
      transport (mergeExtraParams); a persona request carries it without its
      output-cap keys. undefined = no payload. */
  extraParams?: Record<string, unknown>;
  estimatedInputTokens: number;
  signal?: AbortSignal;
  /** W4: set only by StageRunner.runFreeText — a one-shot, unstructured, single-attempt call. */
  freeText?: FreeTextOptions;
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
