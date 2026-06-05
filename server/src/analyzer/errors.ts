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
