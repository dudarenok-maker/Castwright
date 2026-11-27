/* #4718 — the shape `@google/genai` gives a non-2xx whose body is not served as application/json
   (observed on-box on the streaming call, docs/testing/onbox-batch-2-results/E115/case3-bogus.sse.txt):
   the real Google envelope arrives as a STRING in `error.message`, and the outer `status` is only the
   HTTP reason phrase ("Bad Request"). */

import { describe, it, expect } from 'vitest';
import { ApiError } from '@google/genai';
import { classifyAnalysisFailure } from './failure-taxonomy.js';
import { redactGeminiError } from '../analyzer/transports/gemini-transport.js';
import { payloadSecretValues } from '../analyzer/runner/extra-params.js';

const PROBE = 'castwright-onbox-probe-value';

function wrappedApiError(inner: { message: string; status: string; details?: unknown[] }): ApiError {
  const body = `${JSON.stringify({ error: { code: 400, ...inner } }, null, 2)}\n`;
  return new ApiError({
    status: 400,
    message: JSON.stringify({ error: { message: body, code: 400, status: 'Bad Request' } }),
  });
}

describe('a Gemini 400 whose envelope the SDK wrapped in a second envelope (#4718)', () => {
  it('a bad safetySettings payload is analyzer-request-rejected, names the field and keeps the value redacted', () => {
    const field = 'safety_settings[0].category';
    const description = `Invalid value at '${field}' (type.googleapis.com/google.ai.generativelanguage.v1beta.HarmCategory), "${PROBE}"`;
    const upstream = wrappedApiError({
      message: description,
      status: 'INVALID_ARGUMENT',
      details: [{ '@type': 'type.googleapis.com/google.rpc.BadRequest', fieldViolations: [{ field, description }] }],
    });
    /* What GeminiTransport's catch rethrows for a request that carried this payload. */
    const thrown = redactGeminiError(
      upstream,
      payloadSecretValues({ config: { safetySettings: [{ category: PROBE, threshold: 'BLOCK_NONE' }] } }),
    );

    const r = classifyAnalysisFailure(thrown, 'Gemini 3.5 Flash Lite');

    expect(r.code).toBe('analyzer-request-rejected');
    expect(r.userMessage).toBe(
      `Gemini 3.5 Flash Lite rejected the request (400): ${description.replace(PROBE, '[redacted]')}`,
    );
    expect(r.remediation).toContain('Gemini custom parameters');
    expect(r.detail).toContain('status: INVALID_ARGUMENT');
    expect(r.detail).toContain(field);
    expect(JSON.stringify(r)).not.toContain(PROBE);
  });

  it('a wrapped FAILED_PRECONDITION 400 stays unknown', () => {
    const r = classifyAnalysisFailure(
      wrappedApiError({ message: 'User location is not supported for the API use.', status: 'FAILED_PRECONDITION' }),
      'Gemini 3.5 Flash Lite',
    );
    expect(r.code).toBe('unknown');
  });

  it('a wrapped API_KEY_INVALID 400 stays auth', () => {
    const r = classifyAnalysisFailure(
      wrappedApiError({
        message: 'API key not valid. Please pass a valid API key.',
        status: 'INVALID_ARGUMENT',
        details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID' }],
      }),
      'Gemini 3.5 Flash Lite',
    );
    expect(r.code).toBe('auth');
  });
});
