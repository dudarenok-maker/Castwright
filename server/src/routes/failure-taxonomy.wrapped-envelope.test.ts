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

function wrappedApiError(
  inner: { message: string; status: string; details?: unknown[] },
  http: { code: number; reason: string } = { code: 400, reason: 'Bad Request' },
): ApiError {
  const body = `${JSON.stringify({ error: { code: http.code, ...inner } }, null, 2)}\n`;
  return new ApiError({
    status: http.code,
    message: JSON.stringify({ error: { message: body, code: http.code, status: http.reason } }),
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

/* The SDK wraps whatever the status, so the unwrap is not specific to 400 (the on-box 503s in
   docs/testing/onbox-batch-2-results/E112/gemma-run1-503-sse.txt carry the same shape). */
describe('a non-400 Gemini error the SDK wrapped in a second envelope (#4718)', () => {
  const quotaFailure = (quotaId: string) => [
    {
      '@type': 'type.googleapis.com/google.rpc.QuotaFailure',
      violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId }],
    },
  ];

  it('a wrapped per-minute 429 is analyzer-rate-limit with the first sentence of the envelope message', () => {
    const r = classifyAnalysisFailure(
      wrappedApiError(
        {
          message: 'You exceeded your current quota. Please retry in 20s.',
          status: 'RESOURCE_EXHAUSTED',
          details: quotaFailure('GenerateRequestsPerMinutePerProjectPerModel-FreeTier'),
        },
        { code: 429, reason: 'Too Many Requests' },
      ),
      'Gemini 3.5 Flash Lite',
    );
    expect(r.code).toBe('analyzer-rate-limit');
    expect(r.userMessage).toBe(
      'Gemini 3.5 Flash Lite returned 429 (RESOURCE_EXHAUSTED): You exceeded your current quota.',
    );
    expect(r.detail).toContain('status: RESOURCE_EXHAUSTED');
  });

  it('a wrapped per-day 429 is analyzer-daily-quota, decided on the envelope message', () => {
    const r = classifyAnalysisFailure(
      wrappedApiError(
        {
          message: 'Quota exceeded for metric GenerateRequestsPerDayPerProjectPerModel-FreeTier. Retry tomorrow.',
          status: 'RESOURCE_EXHAUSTED',
          details: quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
        },
        { code: 429, reason: 'Too Many Requests' },
      ),
      'Gemini 3.5 Flash Lite',
    );
    expect(r.code).toBe('analyzer-daily-quota');
    expect(r.userMessage).toContain('returned 429 (RESOURCE_EXHAUSTED)');
  });

  it('a per-day marker only in details does not make a wrapped 429 daily', () => {
    const r = classifyAnalysisFailure(
      wrappedApiError(
        {
          message: 'You exceeded your current quota. Please retry in 20s.',
          status: 'RESOURCE_EXHAUSTED',
          details: quotaFailure('GenerateRequestsPerDayPerProjectPerModel-FreeTier'),
        },
        { code: 429, reason: 'Too Many Requests' },
      ),
      'Gemini 3.5 Flash Lite',
    );
    expect(r.code).toBe('analyzer-rate-limit');
  });

  it('a wrapped 503 reads the real UNAVAILABLE envelope, not the raw JSON', () => {
    const r = classifyAnalysisFailure(
      wrappedApiError(
        { message: 'The model is overloaded. Please try again later.', status: 'UNAVAILABLE' },
        { code: 503, reason: 'Service Unavailable' },
      ),
      'Gemini 3.5 Flash Lite',
    );
    expect(r.code).toBe('analyzer-unreachable');
    expect(r.userMessage).toBe(
      'Gemini 3.5 Flash Lite returned 503 (UNAVAILABLE): The model is overloaded. Please try again later.',
    );
    expect(r.detail).toContain('status: UNAVAILABLE');
  });

  it('a wrapped 403 reads the real PERMISSION_DENIED envelope and stays auth', () => {
    const r = classifyAnalysisFailure(
      wrappedApiError(
        { message: 'Permission denied on resource project.', status: 'PERMISSION_DENIED' },
        { code: 403, reason: 'Forbidden' },
      ),
      'Gemini 3.5 Flash Lite',
    );
    expect(r.code).toBe('auth');
    expect(r.userMessage).toBe(
      'Gemini 3.5 Flash Lite returned 403 (PERMISSION_DENIED): Permission denied on resource project.',
    );
  });
});
