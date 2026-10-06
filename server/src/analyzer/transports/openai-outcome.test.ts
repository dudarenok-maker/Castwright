import { describe, expect, it } from 'vitest';
import { inspect } from 'node:util';
import { APIConnectionError, APIConnectionTimeoutError, APIError, APIUserAbortError } from 'openai';
import { classifyOpenAIOutcome, OPENAI_RETRY_CLASSIFIER, type OutcomeContext } from './openai-transport.js';
import { classifyAnalysisFailure } from '../../routes/failure-taxonomy.js';
import {
  AnalysisAbortedError,
  AnalyzerHttpError,
  AnalyzerReasoningOverflowError,
  AnalyzerStreamIncompleteError,
  AnalyzerTimeoutError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
} from '../errors.js';

const ctx = (over: Partial<OutcomeContext> = {}): OutcomeContext => ({
  callerAborted: false,
  ceilingAborted: false,
  idleAborted: false,
  headersReceived: false,
  sawFinish: false,
  elapsedMs: 1234,
  model: 'qwen3:30b',
  secrets: [],
  ...over,
});

/* The shapes observed in research probes P06–P11 (04-openai-sdk-facts). */
const chain = (code: string) =>
  new APIConnectionError({ cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error(code), { code }) }) });

describe('classifyOpenAIOutcome — order (#3084 decision 1c)', () => {
  it('1. a caller abort wins over everything, including a fired ceiling', () => {
    expect(classifyOpenAIOutcome(new APIUserAbortError(), ctx({ callerAborted: true, ceilingAborted: true }))).toBeInstanceOf(
      AnalysisAbortedError,
    );
    expect(classifyOpenAIOutcome(undefined, ctx({ callerAborted: true, headersReceived: true }))).toBeInstanceOf(AnalysisAbortedError);
  });

  it.each(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT'])(
    '2. %s (a connect-phase code) before headers is unreachable, carrying only the sanitized code (P21, P22)',
    (code) => {
      const out = classifyOpenAIOutcome(chain(code), ctx());
      expect(out).toBeInstanceOf(AnalyzerUnreachableError);
      expect((out as AnalyzerUnreachableError).transport).toBe('openai');
      expect((out as AnalyzerUnreachableError & { causeCode?: string }).causeCode).toBe(code);
      expect((out as Error & { cause?: unknown }).cause).toBeUndefined();
    },
  );

  it.each(['ECONNRESET', 'UND_ERR_SOCKET', 'EAI_AGAIN'])(
    '2. %s before headers comes from a server that may be up: an incomplete stream (retried), never unreachable (P21)',
    (code) => {
      const out = classifyOpenAIOutcome(chain(code), ctx());
      expect(out).toBeInstanceOf(AnalyzerStreamIncompleteError);
      expect(out).not.toBeInstanceOf(AnalyzerUnreachableError);
      expect(OPENAI_RETRY_CLASSIFIER.classify(out)).toBe('idle');
      /* Q1 — the pre-header case names its code. */
      expect((out as AnalyzerStreamIncompleteError).causeCode).toBe(code);
      expect((out as Error).message).toBe(`Endpoint qwen3:30b dropped the connection before a response (${code}).`);
    },
  );

  it('2. a non-APIError reset raised before create() resolved is an incomplete stream too (P21)', () => {
    const raw = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    expect(classifyOpenAIOutcome(raw, ctx())).toBeInstanceOf(AnalyzerStreamIncompleteError);
  });

  it('2. the unreachable error is rebuilt: no cause, and text in the chain reaches neither its message nor inspect() (P22)', () => {
    const err = new APIConnectionError({
      cause: Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('connect ECONNREFUSED while sending Bearer sk-rule2-secret-1'), { code: 'ECONNREFUSED' }),
      }),
    });
    /* secrets: [] — only the rebuild (no cause, no upstream text) can keep the key out. */
    const out = classifyOpenAIOutcome(err, ctx({ secrets: [] }));
    expect(out).toBeInstanceOf(AnalyzerUnreachableError);
    expect((out as Error).message).toBe('Endpoint qwen3:30b is unreachable (ECONNREFUSED).');
    expect(inspect(out, { depth: 8 })).not.toContain('sk-rule2-secret-1');
  });

  it('2. a bare "fetch failed" with no code anywhere is unreachable', () => {
    expect(classifyOpenAIOutcome(new APIConnectionError({ cause: new TypeError('fetch failed') }), ctx())).toBeInstanceOf(
      AnalyzerUnreachableError,
    );
  });

  it('2. an HTTP 502 whose body says code ECONNREFUSED is an AnalyzerHttpError, never unreachable (P21)', () => {
    /* Exactly what the SDK throws from create(): status, parsed body, headers; err.code copied from the body. */
    const err = new APIError(502, { code: 'ECONNREFUSED', message: 'upstream down' }, 'upstream down', new Headers());
    const out = classifyOpenAIOutcome(err, ctx());
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect(out).not.toBeInstanceOf(AnalyzerUnreachableError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(502);
  });

  it('2. an HTTP 500 whose message is "fetch failed" is an AnalyzerHttpError, never unreachable (P21)', () => {
    const out = classifyOpenAIOutcome(new APIError(500, { message: 'fetch failed' }, 'fetch failed', new Headers()), ctx());
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(500);
  });

  it('2. a non-APIError transport error raised before create() resolved is connection-level', () => {
    const raw = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect'), { code: 'ECONNREFUSED' }) });
    expect(classifyOpenAIOutcome(raw, ctx())).toBeInstanceOf(AnalyzerUnreachableError);
  });

  it('2. a headers-timeout chain is NOT unreachable (a slow server must never trigger fallback)', () => {
    const headersTimeout = Object.assign(
      new APIConnectionTimeoutError({ message: 'Request timed out.' }),
      { cause: Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Headers Timeout Error'), { code: 'UND_ERR_HEADERS_TIMEOUT' }) }) },
    );
    const out = classifyOpenAIOutcome(headersTimeout, ctx());
    expect(out).toBeInstanceOf(AnalyzerTimeoutError);
    expect((out as AnalyzerTimeoutError).reason).toBe('connect-timeout');
  });

  it('2. an unreachable-looking code AFTER headers is not unreachable', () => {
    const drop = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    expect(classifyOpenAIOutcome(drop, ctx({ headersReceived: true }))).toBeInstanceOf(AnalyzerStreamIncompleteError);
  });

  it('3. the ceiling firing (before or after headers) is a timeout, never a fallback', () => {
    const before = classifyOpenAIOutcome(new APIUserAbortError(), ctx({ ceilingAborted: true }));
    expect(before).toBeInstanceOf(AnalyzerTimeoutError);
    expect((before as AnalyzerTimeoutError).reason).toBe('ceiling');
    expect(classifyOpenAIOutcome(undefined, ctx({ ceilingAborted: true, headersReceived: true }))).toBeInstanceOf(AnalyzerTimeoutError);
  });

  it('4. an HTTP status becomes AnalyzerHttpError with that status, a redacted body excerpt, the retry hint, and no raw cause', () => {
    const err = new APIError(
      429,
      { message: 'slow down, key sk-outcome-secret-1', type: 'rate_limit_error' },
      'slow down',
      new Headers({ 'retry-after': '2' }),
    );
    const out = classifyOpenAIOutcome(err, ctx({ secrets: ['sk-outcome-secret-1'] }));
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(429);
    expect((out as AnalyzerHttpError).bodyExcerpt).toContain('slow down, key [redacted]');
    expect(`${(out as Error).message}\n${(out as AnalyzerHttpError).bodyExcerpt}`).not.toContain('sk-outcome-secret-1');
    expect(OPENAI_RETRY_CLASSIFIER.retryAfterMs(out)).toBe(2000);
    expect((out as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it('4b. a 400 body echoing a key that holds a quote or backslash is redacted in its JSON-escaped spelling too (P22)', () => {
    for (const key of ['sk-abc"defgh12345', 'sk-abc\\defgh12345']) {
      const err = new APIError(400, { message: `invalid key ${key} supplied` }, 'bad request', new Headers());
      const out = classifyOpenAIOutcome(err, ctx({ secrets: [key] }));
      expect((out as AnalyzerHttpError).bodyExcerpt).not.toContain('defgh12345');
      expect((out as AnalyzerHttpError).bodyExcerpt).toContain('invalid key [redacted] supplied');
    }
  });

  it('5. an in-stream error event (no status) becomes AnalyzerHttpError(0)', () => {
    const err = new APIError(undefined, { message: 'context exceeded' }, 'context exceeded', undefined);
    const out = classifyOpenAIOutcome(err, ctx({ headersReceived: true }));
    expect(out).toBeInstanceOf(AnalyzerHttpError);
    expect((out as AnalyzerHttpError).httpStatus).toBe(0);
  });

  it('6. a clean end without finish_reason, or an idle abort before one, after headers is incomplete', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true }))).toBeInstanceOf(AnalyzerStreamIncompleteError);
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, idleAborted: true }))).toBeInstanceOf(
      AnalyzerStreamIncompleteError,
    );
  });

  it('6. an idle abort AFTER a finish_reason is success: the answer was complete (P25)', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, idleAborted: true, sawFinish: true }))).toBeNull();
  });

  it('6. a socket drop AFTER a finish_reason is success: the answer was complete (P25)', () => {
    const drop = Object.assign(new TypeError('terminated'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) });
    expect(classifyOpenAIOutcome(drop, ctx({ headersReceived: true, sawFinish: true }))).toBeNull();
  });

  it('a clean end with a finish reason is success (null)', () => {
    expect(classifyOpenAIOutcome(undefined, ctx({ headersReceived: true, sawFinish: true }))).toBeNull();
  });

  it('7. anything else is rebuilt as AnalyzerTransportError: class names and a sanitized code only, no cause (P22)', () => {
    const odd = Object.assign(new RangeError('weird sk-rule7-secret-1'), { code: 'ERR_WEIRD' });
    const out = classifyOpenAIOutcome(odd, ctx({ headersReceived: true, sawFinish: true }));
    expect(out).toBeInstanceOf(AnalyzerTransportError);
    expect(out).not.toBe(odd);
    expect((out as InstanceType<typeof AnalyzerTransportError>).causeCode).toBe('ERR_WEIRD');
    expect((out as Error).message).toBe('Endpoint qwen3:30b request failed (ERR_WEIRD) (RangeError).');
    expect('cause' in (out as Error)).toBe(false);
    expect(inspect(out, { depth: 8 })).not.toContain('sk-rule7-secret-1');
  });

  it('7. an invalid header value, which undici echoes as "Bearer <key>", never surfaces the key (P22)', () => {
    const headerError = new TypeError('Headers.append: "Bearer sk-inject-secret-1\nX: y" is an invalid header value.');
    /* secrets: [] — the rebuild alone must keep the key out. */
    const out = classifyOpenAIOutcome(new APIConnectionError({ cause: headerError }), ctx({ secrets: [] }));
    expect(out).toBeInstanceOf(AnalyzerTransportError);
    expect((out as Error).message).toBe('Endpoint qwen3:30b request failed before a response (APIConnectionError <- TypeError).');
    for (const s of [(out as Error).message, (out as Error).stack ?? '', inspect(out, { depth: 8 })]) {
      expect(s).not.toContain('sk-inject-secret-1');
    }
  });

  it('7. P20: an AnalyzerReasoningOverflowError crossing the transport catch is returned unchanged, before or after headers', () => {
    const overflow = new AnalyzerReasoningOverflowError('openai', 'qwen3:30b', 512);
    expect(classifyOpenAIOutcome(overflow, ctx())).toBe(overflow);
    expect(classifyOpenAIOutcome(overflow, ctx({ headersReceived: true, sawFinish: true }))).toBe(overflow);
  });
});

describe('the classified run failure shows the cause code (#3084 P22, Q1)', () => {
  it('an injected ERR_SSL_WRONG_VERSION_NUMBER (https:// against a plain-HTTP server) reaches rule 7, and the classified failure names it', () => {
    const out = classifyOpenAIOutcome(chain('ERR_SSL_WRONG_VERSION_NUMBER'), ctx());
    expect(out).toBeInstanceOf(AnalyzerTransportError);
    expect((out as Error).message).toBe(
      'Endpoint qwen3:30b request failed before a response (ERR_SSL_WRONG_VERSION_NUMBER) (APIConnectionError <- TypeError <- Error).',
    );
    const r = classifyAnalysisFailure(out, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) request failed (ERR_SSL_WRONG_VERSION_NUMBER).');
  });

  it('an injected EAI_AGAIN before headers is retried as incomplete, and the classified failure names it instead of a mid-answer drop', () => {
    const out = classifyOpenAIOutcome(chain('EAI_AGAIN'), ctx());
    expect(out).toBeInstanceOf(AnalyzerStreamIncompleteError);
    const r = classifyAnalysisFailure(out, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) dropped the connection before a response (EAI_AGAIN), and retrying did not help.');
    expect(r.userMessage).not.toContain('stopped streaming');
  });
});
