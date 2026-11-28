/* Reader for a Gemini API error envelope, shared by the retry helper (analyzer/runner) and the
   failure taxonomy (routes) so neither reads a different shape of the same error. */

export type ApiErrorEnvelope = { code?: number; message: string; status?: string; details?: unknown[] };

export function tryParseApiError(raw: string): ApiErrorEnvelope | null {
  const outer = readApiErrorEnvelope(raw);
  /* #4718 — for a non-2xx body not served as application/json, `@google/genai` wraps the body text:
     {"error":{"message":"<Google envelope>","code":400,"status":"Bad Request"}}. That outer status is
     only the HTTP reason phrase, so whatever the code (the 429s and 503s are wrapped the same way),
     a message that is itself an envelope is read instead. */
  if (!outer || !outer.message.trimStart().startsWith('{')) return outer;
  return readApiErrorEnvelope(outer.message) ?? outer;
}

/* The `details` (RetryInfo lives here) of an error envelope, whether SDK-wrapped (read through
   `tryParseApiError`'s unwrap) or a bare `{"error":{"details":[...]}}` with no code/message, which
   the classifier rejects but the retry helper still has to honour. */
export function readApiErrorDetails(raw: string): unknown[] {
  const unwrapped = tryParseApiError(raw)?.details;
  if (unwrapped) return unwrapped;
  const start = raw.indexOf('{');
  if (start < 0) return [];
  try {
    const obj = JSON.parse(raw.slice(start)) as { error?: { details?: unknown } };
    return Array.isArray(obj?.error?.details) ? obj.error.details : [];
  } catch {
    return [];
  }
}

function readApiErrorEnvelope(raw: string): ApiErrorEnvelope | null {
  /* SDK messages often look like 'got status: 503 UNAVAILABLE. {"error":{...}}'.
     Find the first '{' and try to parse from there. */
  const start = raw.indexOf('{');
  if (start < 0) return null;
  try {
    const obj = JSON.parse(raw.slice(start)) as {
      error?: { code?: number; message?: string; status?: string; details?: unknown[] };
    };
    if (obj?.error?.message) {
      return {
        code: obj.error.code,
        message: obj.error.message,
        status: obj.error.status,
        details: obj.error.details,
      };
    }
  } catch {
    return null;
  }
  return null;
}
