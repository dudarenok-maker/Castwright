/* Shared analyzer error sentinels.

   `AnalyzerTruncatedError` is thrown by an engine (Gemini / Ollama) when the
   model stopped because it hit its OUTPUT budget mid-response, not because it
   finished — Gemini surfaces this as `finishReason: 'MAX_TOKENS'`, Ollama as
   `done_reason: 'length'`. Pre-fix, both engines silently returned the
   truncated buffer, which then failed JSON parse, retried at the same size,
   failed again, and surfaced to the client as a bare ECONNRESET (issue #528).

   Two consumers key off the type:
     - the per-engine retry loop re-throws it immediately (replaying the same
       oversized prompt just truncates again — retrying in place is futile),
     - the stage-2 chunking runner (`stage2-chunk.ts`) CATCHES it and splits the
       offending span into smaller sub-bodies so each call fits under the cap.

   Lives in its own module (not on an engine) so both engines + the route layer
   can import it without a circular dependency. Mirrors the sentinel shape of
   `AnalysisAbortedError` / `LocalUnreachableError` in ollama.ts. */
export class AnalyzerTruncatedError extends Error {
  readonly code = 'ANALYZER_TRUNCATED';
  constructor(
    /** Which engine truncated. */
    public readonly engine: 'gemini' | 'ollama',
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

/* Thrown by GeminiAnalyzer when the stream finishes with ZERO text — the
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
          ' source via RECITATION. Switch GEMINI_MODEL to a gemma-* model or set' +
          ' ANALYZER=local (Ollama).'
        : '';
    super(`Gemini ${model} returned an empty response${named}.${hint}`);
    this.name = 'GeminiContentBlockedError';
  }
}
