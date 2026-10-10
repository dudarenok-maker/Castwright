/* Shared analyzer error sentinels — one per failure mode the analyzer transports
   distinguish — plus `TransportKind`, the union that names those transports.

   Lives in its own module (not on an engine) so both engines + the route layer
   can import these without a circular dependency. */
/** Every transport the stage runner can drive. Wave 1 uses 'ollama' and 'gemini'. */
export type TransportKind = 'ollama' | 'gemini' | 'openai';

/** Sentinel error for "the SSE client disconnected, drop work silently."
    The analysis route uses `err instanceof AnalysisAbortedError` to skip
    its own error-reporting path (the client is gone — there's no one to
    tell) and to NOT trigger the Gemini fallback decorator. */
export class AnalysisAbortedError extends Error {
  readonly code = 'ANALYSIS_ABORTED';
  constructor(message: string) {
    super(message);
    this.name = 'AnalysisAbortedError';
  }
}

/** "Couldn't reach the analyzer at all", from any transport. FallbackAnalyzer
    (index.ts) uses `instanceof AnalyzerUnreachableError` as the SOLE trigger
    for Gemini fallback; every other error propagates and hard-fails. */
export class AnalyzerUnreachableError extends Error {
  readonly code: string = 'ANALYZER_UNREACHABLE';
  constructor(
    message: string,
    public readonly transport: TransportKind,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AnalyzerUnreachableError';
  }
}

/** Ollama's unreachable sentinel — produced only by classifyConnectError. */
export class LocalUnreachableError extends AnalyzerUnreachableError {
  readonly code: string = 'LOCAL_UNREACHABLE';
  constructor(message: string, cause?: unknown) {
    super(message, 'ollama', cause);
    this.name = 'LocalUnreachableError';
  }
}

/** A reachable analyzer answered with a non-OK HTTP status. Deliberately has
    NO `status` property: failure-taxonomy.ts reads `.status` (its bare-status
    branch maps 500/503 to analyzer-unreachable), and wave 1 must not move any
    taxonomy outcome. */
export class AnalyzerHttpError extends Error {
  constructor(
    public readonly transport: TransportKind,
    public readonly httpStatus: number,
    public readonly bodyExcerpt: string,
    message: string,
  ) {
    super(message);
    this.name = 'AnalyzerHttpError';
  }
}

/* Raised by the stage runner (runner/finish.ts) when the model stopped because it hit
   its OUTPUT budget mid-response, not because it finished — Gemini surfaces
   this as `finishReason: 'MAX_TOKENS'`, Ollama as `done_reason: 'length'`.
   Pre-fix, both engines silently returned the truncated buffer, which then
   failed JSON parse, retried at the same size, failed again, and surfaced to
   the client as a bare ECONNRESET (issue #528).

   Two consumers key off the type:
     - transports report it as finish:'length' and it is raised without a retry
       (replaying the same oversized prompt just truncates again),
     - the stage-2 chunking runner (`stage2-chunk.ts`) CATCHES it and splits the
       offending span into smaller sub-bodies so each call fits under the cap.

   Mirrors the sentinel shape of the AnalysisAbortedError /
   AnalyzerUnreachableError blocks above. */
export class AnalyzerTruncatedError extends Error {
  readonly code = 'ANALYZER_TRUNCATED';
  constructor(
    /** Which engine truncated. */
    public readonly engine: TransportKind,
    /** The engine's own stop reason — Gemini `MAX_TOKENS`/`SAFETY`/…, Ollama `length`. */
    public readonly reason: string,
    /** Bytes assembled before the stop, for the diagnostic log line. */
    public readonly receivedBytes: number,
    /** Output token count when the engine reported it (Gemini usageMetadata). */
    public readonly outputTokens?: number,
  ) {
    super(
      `${engine} output truncated (reason=${reason}) after ${receivedBytes} bytes` +
        (outputTokens ? ` / ${outputTokens} output tokens` : '') +
        ' — chapter too large for a single call.',
    );
    this.name = 'AnalyzerTruncatedError';
  }
}

/* #3084 P30 — a prompt too large for the fallback target, refused before it was sent, so it is never
   truncated on input. Thrown only for passes whose caller does not split; those that split get an
   AnalyzerTruncatedError instead. Not a subclass of either, and never retried: nothing was sent. */
export class AnalyzerTargetInputTooLargeError extends Error {
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    readonly targetLabel: string,
    readonly limitTokens: number,
    readonly family: 'context' | 'requestCap',
  ) {
    super(`prompt is larger than the fallback target ${targetLabel} can take (${family === 'context' ? 'context' : 'per-request cap'} ${limitTokens} tokens)`);
    this.name = 'AnalyzerTargetInputTooLargeError';
  }
}

/* #3084 P30 — what the fallback guard throws for a pass whose caller splits: a truncation, so the caller
   splits and retries each half, carrying the refusal it stands for. */
export class TargetInputOverBudgetError extends AnalyzerTruncatedError {
  constructor(readonly refusal: AnalyzerTargetInputTooLargeError) {
    super(refusal.transport, 'input-over-target-budget', 0);
    this.name = 'TargetInputOverBudgetError';
  }
}

/** A splitting caller's give-up rethrow: a target-budget truncation that cannot split further escapes as
    the refusal it stands for, so it classifies with that copy and never reads as "response truncated". */
export function targetInputTooLargeOr(err: unknown): unknown {
  return err instanceof TargetInputOverBudgetError ? err.refusal : err;
}

/* Raised by runner/finish.ts when the Gemini transport reports a stream that finished with ZERO text — the
   signature of a content-filter block. On a `gemini-*` model the usual cause is
   RECITATION (Google refuses memorised/copyrighted source) or SAFETY; the model
   returns a candidate carrying only the stop reason, or rejects the prompt via
   promptFeedback.blockReason.

   This is a DETERMINISTIC, WHOLE-BOOK-FATAL condition: the same filter blocks
   every chapter identically, so retrying or splitting is futile. The run-level
   consumers key off this TYPE to fail fast with one actionable terminal error
   instead of grinding chapter-by-chapter:
     - analysis.ts rethrows it from the per-chapter catch to its terminal handler,
     - script-review.ts breaks the chunk loop and emits a terminal error,
     - failure-taxonomy.ts matches it by `name` → `analyzer-content-blocked`.

   The message reproduces the pre-typed-error string VERBATIM (same reason suffix
   + remediation hint) so existing log-greps and the taxonomy regex still match.
   Mirrors the sentinel shape of `AnalyzerTruncatedError` above. */
export class GeminiContentBlockedError extends Error {
  readonly code = 'GEMINI_CONTENT_BLOCKED';
  constructor(
    /** The Gemini model id that returned the empty/blocked response. */
    public readonly model: string,
    /** The stop/block reason (RECITATION / SAFETY / PROHIBITED_CONTENT), or
        undefined when the stream ended empty without one. */
    public readonly reason?: string,
  ) {
    const named =
      reason && reason !== 'FINISH_REASON_UNSPECIFIED' ? ` (reason=${reason})` : '';
    const hint =
      reason && reason !== 'FINISH_REASON_UNSPECIFIED'
        ? ' A content filter blocked the text — gemini-* models block copyrighted' +
          ' source via RECITATION. Switch GEMINI_MODEL to a gemma-* model or switch' +
          ' to Local Ollama in Admin → Model Manager.'
        : '';
    super(`Gemini ${model} returned an empty response${named}.${hint}`);
    this.name = 'GeminiContentBlockedError';
  }
}

/* #3084 — a request ran past a time limit without finishing (spec §1 decision
   1c, spec §7). Wave 2 throws it from the Gemini transport for
   analyzer.gemini.requestCeilingMs ('ceiling') and for the thinking window,
   analyzer.gemini.thinkingIdleTimeoutMs ('thinking-idle'); wave 3 reuses it
   for OpenAI-compatible endpoints ('connect-timeout' too). Never retried, never
   a fallback: the upstream was reachable and did not finish. */
export class AnalyzerTimeoutError extends Error {
  readonly code = 'ANALYZER_TIMEOUT';
  constructor(
    public readonly transport: TransportKind,
    public readonly model: string,
    public readonly elapsedMs: number,
    public readonly reason: 'ceiling' | 'connect-timeout' | 'thinking-idle',
  ) {
    super(
      `${transport} ${model} request exceeded its ${
        reason === 'ceiling' ? 'time ceiling' : reason === 'thinking-idle' ? 'thinking window' : 'connect timeout'
      } after ${elapsedMs} ms.`,
    );
    this.name = 'AnalyzerTimeoutError';
  }
}

/* #3084 wave 2 — the model stopped at its OUTPUT cap with no answer text while
   there is evidence it was reasoning (reasoning tokens reported, thought parts
   or reasoning deltas seen, or an unterminated <think> block). Unlike
   AnalyzerTruncatedError this is NOT a size problem: splitting the chunk never
   shrinks reasoning, so no chunker catches it — runner/finish.ts raises it and
   the taxonomy maps it to analyzer-reasoning-overflow, naming the engine's
   max-output and reasoning settings. Deliberately not a subclass of
   AnalyzerTruncatedError. */
export class AnalyzerReasoningOverflowError extends Error {
  readonly code = 'ANALYZER_REASONING_OVERFLOW';
  /* #3084 F7 (Task 3b.1b) — the endpoint whose request overflowed. The runner
     that raises this (wave 2's mapFinish) is transport-agnostic and has no
     concept of an endpoint; only `OpenAIAnalyzer` holds one, so it is the layer
     that sets this. Deliberately MUTABLE (not a `readonly` constructor field):
     the escalation path reports the error through `StageCall.onReasoningOverflow`
     and stores it, so `OpenAIAnalyzer` must be able to stamp the id onto the SAME
     object after construction, before wave 2's route-level `throwIfReasoningOverflowed`
     rethrows it outside the analyzer entirely. `opts` is purely additive: every
     existing 3-arg call site (Ollama/Gemini paths, mapFinish) compiles and behaves
     unchanged, and `endpointId` stays `undefined` for them. */
  endpointId?: string;
  constructor(
    public readonly transport: TransportKind,
    public readonly model: string,
    public readonly reasoningTokens: number | undefined,
    opts?: { endpointId?: string },
  ) {
    super(
      `${transport} ${model} used its whole output budget on reasoning` +
        (reasoningTokens ? ` (${reasoningTokens} reasoning tokens)` : '') +
        ' and returned no answer — splitting the chunk cannot shrink reasoning.',
    );
    this.name = 'AnalyzerReasoningOverflowError';
    this.endpointId = opts?.endpointId;
  }
}

/* ── #3084 — analyzer endpoint ids (P23) ─────────────────────────────────── */

const ENDPOINT_SOURCE_LABEL: Record<'settings' | 'env' | 'run-pick' | 'persona', string> = {
  settings: 'a saved setting',
  env: 'ANALYZER_PHASE0_MODEL / ANALYZER_PHASE1_MODEL',
  'run-pick': "this run's model pick",
  persona: 'the persona generation engine',
};

/** A model id names an OpenAI-compatible endpoint that is not configured: from
    PR 3d, an id whose endpoint is not in saved settings (P23; before 3d, every
    endpoint id). Thrown by selection (PR 3a) and PR 3c's pre-run checks,
    before the first call. FailureCode `analyzer-endpoint-missing` (PR 3b). */
export class AnalyzerEndpointMissingError extends Error {
  readonly code = 'ANALYZER_ENDPOINT_MISSING';
  constructor(
    readonly endpointId: string,
    readonly source: 'settings' | 'env' | 'run-pick' | 'persona',
  ) {
    super(`Analyzer endpoint "${endpointId}" (from ${ENDPOINT_SOURCE_LABEL[source]}) cannot be used for analysis yet.`);
    this.name = 'AnalyzerEndpointMissingError';
  }
}

/* ── #3084 PR 3b — wave-3 analyzer errors ───────────────────────────────── */

const TRANSPORT_LABEL: Record<TransportKind, string> = {
  ollama: 'Ollama',
  gemini: 'Gemini',
  openai: 'Endpoint',
};

/** #3084 P22 — the one shape every message we build uses for a sanitized cause code:
    ` (CODE)`, or nothing. The same suffix as PR 3c's catalog listing error
    (`Endpoint model listing failed (CODE).`). */
export function causeCodeSuffix(causeCode: string | undefined): string {
  return causeCode ? ` (${causeCode})` : '';
}

/** A stream that ended — cleanly, by socket drop, or by the idle watchdog —
    after response headers but before a finish reason (`phase: 'mid-stream'`); or
    (P21) a connection reset or DNS hiccup before headers (ECONNRESET,
    UND_ERR_SOCKET, EAI_AGAIN) from a server that may be up
    (`phase: 'before-response'`). Retried like an idle stream; never a fallback.
    #3084 P22 — the pre-header case names its sanitized `causeCode` in its message,
    so a persistent DNS failure never reads as a mid-answer drop. */
export class AnalyzerStreamIncompleteError extends Error {
  readonly code = 'ANALYZER_STREAM_INCOMPLETE';
  readonly phase: 'before-response' | 'mid-stream';
  readonly causeCode: string | undefined;
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    beforeResponse?: { causeCode: string | undefined },
  ) {
    super(
      beforeResponse
        ? `${TRANSPORT_LABEL[transport]} ${model} dropped the connection before a response${causeCodeSuffix(beforeResponse.causeCode)}.`
        : `${TRANSPORT_LABEL[transport]} ${model} dropped the connection or ended its stream before a finish reason.`,
    );
    this.name = 'AnalyzerStreamIncompleteError';
    this.phase = beforeResponse ? 'before-response' : 'mid-stream';
    this.causeCode = beforeResponse?.causeCode;
  }
}

/** #3084 P22 — a system error code safe to carry on an error we build: upper-case
    letters, digits and underscores only (ECONNRESET, UND_ERR_SOCKET), and never one
    containing a known secret. Anything else is dropped. */
export function sanitizeCauseCode(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== 'string' || !/^[A-Z][A-Z0-9_]{1,63}$/.test(value)) return undefined;
  return secrets.some((s) => s.length >= 8 && value.includes(s)) ? undefined : value;
}

/** #3084 P22 — what the OpenAI transport rebuilds an error it does not recognise
    into, instead of rethrowing the SDK's. The message is built only from error
    NAMES and the sanitized code (shown with causeCodeSuffix, so the user can
    diagnose ERR_SSL_WRONG_VERSION_NUMBER and friends), never from upstream text,
    and there is no `cause`:
    a logged error prints its cause chain, and undici's header errors embed the
    header value (`Headers.append: "Bearer <key>" is an invalid header value.`). */
export class AnalyzerTransportError extends Error {
  readonly code = 'ANALYZER_TRANSPORT';
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    message: string,
    readonly causeCode: string | undefined,
  ) {
    super(message);
    this.name = 'AnalyzerTransportError';
  }
}

/** The saved key for an endpoint was bound to a different origin than the URL
    about to be called (decision 3c). No request was sent. Maps to `auth`. */
export class AnalyzerKeyOriginError extends Error {
  readonly code = 'ANALYZER_KEY_ORIGIN';
  constructor(
    readonly endpointId: string,
    readonly endpointName: string,
  ) {
    super(
      `The API key saved for ${endpointName} was entered for a different host — re-enter the key for ${endpointName}.`,
    );
    this.name = 'AnalyzerKeyOriginError';
  }
}

/** The Test action recorded that this model refuses a setting the run is configured
    to send (its structured-output mode, or — from wave 5 — its reasoning level), so
    the run stops before its first request. Nothing was sent, so it deliberately has
    NO `status` property: the taxonomy's bare-status branch reads `.status`, and this
    refusal must never be taken for an HTTP answer. `classifyAnalysisFailure` gives it
    its own branch, above the ApiError / bare-status checks, mapping it to
    `analyzer-request-rejected` (#3084 PR 3c). */
export class AnalyzerCapabilityRejectedError extends Error {
  readonly code = 'ANALYZER_CAPABILITY_REJECTED';
  constructor(
    readonly modelId: string,
    /** Which setting the record refused. W3 records only `structuredOutput`. */
    readonly setting: 'structuredOutput' | 'reasoning',
    /** The value the run would have sent (`schema` / `json` / `off`, or a level key). */
    readonly value: string,
    /** ISO timestamp of the Test that recorded the refusal. */
    readonly testedAt: string,
  ) {
    super(
      `Model ${modelId} rejected ${setting}=${value} when it was last tested (${testedAt}). Change that setting, or run Test again.`,
    );
    this.name = 'AnalyzerCapabilityRejectedError';
  }
}


/** Validation failed after the retry. The message is exactly today's text
    (ollama.ts:609-611, gemini.ts:515-517); `detail` is the
    "<kind> — <summarised detail>" string the runner builds. */
export class AnalyzerInvalidOutputError extends Error {
  readonly code = 'ANALYZER_INVALID_OUTPUT';
  constructor(
    readonly transport: TransportKind,
    readonly model: string,
    readonly key: string,
    readonly detail: string,
    readonly structuredOutputMode: 'schema' | 'json' | 'off',
  ) {
    super(
      transport === 'gemini'
        ? `Gemini ${key} failed validation after retry: ${detail}`
        : `${TRANSPORT_LABEL[transport]} ${model} ${key} failed validation after retry: ${detail}`,
    );
    this.name = 'AnalyzerInvalidOutputError';
  }
}
