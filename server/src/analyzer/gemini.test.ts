/* GeminiAnalyzer streaming behaviour. Mocks @google/genai's
   generateContentStream and asserts:
     - chunks accumulate into the assembled buffer
     - onChunk fires per chunk with monotonic receivedBytes
     - sinceLastChunkMs is set on every chunk
     - the schema-validated stage 1 result is returned at the end
   Pairs with the analysis route's heartbeat / silence-watchdog wiring. */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { geminiRateLimiter } from './rate-limit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HANDOFF_ROOT = resolve(__dirname, '..', '..', 'handoff');

/* Build a stage-1-shaped JSON payload, sliced into chunks the same way a
   real model would stream tokens — partial JSON inside any one chunk is
   fine because we only validate the assembled buffer at the end. */
const STAGE1_RESPONSE = JSON.stringify({
  characters: [
    {
      id: 'narrator',
      name: 'Narrator',
      role: 'narrator',
      color: 'narrator',
      evidence: [{ quote: 'aaa' }, { quote: 'bbbb' }, { quote: 'ccccc' }],
    },
    {
      id: 'Wren',
      name: 'Wren',
      role: 'protagonist',
      color: 'orange',
      evidence: [{ quote: 'ddd' }, { quote: 'eeee' }, { quote: 'fffff' }],
    },
    {
      id: 'Marlow',
      name: 'Marlow',
      role: 'sidekick',
      color: 'magenta',
      evidence: [{ quote: 'ggg' }, { quote: 'hhhh' }, { quote: 'iiiii' }],
    },
  ],
  chapters: [{ id: 1, title: 'One' }],
});

function chunksOf(text: string, size: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const generateContentStream = vi.fn();

vi.mock('@google/genai', () => {
  return {
    GoogleGenAI: class {
      models = { generateContentStream };
    },
  };
});

beforeEach(async () => {
  generateContentStream.mockReset();
  /* The limiter is a module singleton; reset between tests so RPM/TPM
     bookkeeping from a prior test doesn't bleed across. */
  geminiRateLimiter._reset();
  /* writeInbox writes a real file under server/handoff/inbox/. Ensure the
     directory exists so the test doesn't trip over a missing parent. */
  await mkdir(resolve(HANDOFF_ROOT, 'inbox'), { recursive: true });
  await mkdir(resolve(HANDOFF_ROOT, 'outbox'), { recursive: true });
});

async function* asyncFromArray<T>(items: T[], delayMs = 0): AsyncGenerator<T> {
  for (const item of items) {
    if (delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
    yield item;
  }
}

describe('GeminiAnalyzer.runStage1 — streaming chunk feedback', () => {
  it('fires onChunk per stream chunk with monotonic receivedBytes and assembles the full response', async () => {
    const slices = chunksOf(STAGE1_RESPONSE, 64);
    expect(slices.length).toBeGreaterThan(2); // ensure we exercise multi-chunk
    generateContentStream.mockResolvedValue(asyncFromArray(slices.map((text) => ({ text }))));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onChunk = vi.fn();
    const result = await analyzer.runStage1('m_test', '# stage 1 prompt', { onChunk });

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledTimes(slices.length);

    const calls = onChunk.mock.calls.map((args) => args[0]);
    /* receivedBytes must be monotonically non-decreasing and end at the
       full assembled length. */
    const lengths = calls.map((c) => c.receivedBytes);
    for (let i = 1; i < lengths.length; i += 1) {
      expect(lengths[i]).toBeGreaterThanOrEqual(lengths[i - 1]);
    }
    expect(lengths[lengths.length - 1]).toBe(STAGE1_RESPONSE.length);
    /* sinceLastChunkMs is set on every call (≥0). */
    for (const c of calls) {
      expect(c.sinceLastChunkMs).toBeGreaterThanOrEqual(0);
      expect(typeof c.elapsedMs).toBe('number');
    }
    /* receivedText on the last call equals the assembled buffer. */
    expect(calls[calls.length - 1].receivedText).toBe(STAGE1_RESPONSE);

    /* And the analyzer returned the parsed payload. */
    expect(result.characters).toHaveLength(3);
    expect(result.characters.map((c) => c.id)).toEqual(['narrator', 'Wren', 'Marlow']);
  });

  it('skips empty chunks (text undefined) without firing onChunk', async () => {
    const slices = chunksOf(STAGE1_RESPONSE, 128);
    /* Interleave a couple of empty chunks. */
    const withGaps = [
      { text: slices[0] },
      { text: undefined },
      ...slices.slice(1).map((text) => ({ text })),
    ];
    generateContentStream.mockResolvedValue(asyncFromArray(withGaps));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onChunk = vi.fn();
    await analyzer.runStage1('m_skip_empty', '# prompt', { onChunk });

    /* Empty chunk does not produce an onChunk call. */
    expect(onChunk).toHaveBeenCalledTimes(slices.length);
  });

  it('throws a clear error when the stream emits zero text chunks', async () => {
    generateContentStream.mockResolvedValue(asyncFromArray([{ text: undefined }, { text: '' }]));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    await expect(analyzer.runStage1('m_empty', '# prompt', {})).rejects.toThrow(/empty response/);
  });
});

describe('GeminiAnalyzer.runStage1Chapter — Phase 0a per-chapter cast detection', () => {
  /* Per-chapter cast output is a strict subset of stage 1: { characters }
     only. Schema rejects an extra `chapters` field, which is the load-bearing
     test that we can't accidentally call the whole-book schema by mistake. */
  const PER_CHAPTER_RESPONSE = JSON.stringify({
    characters: [
      {
        id: 'narrator',
        name: 'Narrator',
        role: 'narrator',
        color: 'narrator',
        evidence: [{ quote: 'a' }, { quote: 'bb' }],
      },
      {
        id: 'Wren',
        name: 'Wren',
        role: 'protagonist',
        color: 'orange',
        evidence: [{ quote: 'cc' }, { quote: 'dddd' }],
      },
    ],
  });

  it('reuses the same streaming path as runStage1 and returns parsed per-chapter output', async () => {
    const slices = chunksOf(PER_CHAPTER_RESPONSE, 32);
    generateContentStream.mockResolvedValue(asyncFromArray(slices.map((text) => ({ text }))));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onChunk = vi.fn();
    const result = await analyzer.runStage1Chapter('m_test', 7, '# stage 1 chapter prompt', {
      onChunk,
    });

    expect(generateContentStream).toHaveBeenCalledTimes(1);
    expect(onChunk).toHaveBeenCalledTimes(slices.length);

    expect(result.characters).toHaveLength(2);
    expect(result.characters.map((c) => c.id)).toEqual(['narrator', 'Wren']);
    /* No chapters[] field on the per-chapter shape — the parser is the
       source of truth for the chapter list. */
    expect((result as unknown as { chapters?: unknown }).chapters).toBeUndefined();
  });
});

describe('GeminiAnalyzer.generateWithLimiter — retry policy', () => {
  /* Build an SDK-shaped ApiError so isRetryable5xx and parseRetryDelayMs
     find what they expect. */
  function apiError(status: number, body: object): Error {
    const e = new Error(`got status: ${status}. ${JSON.stringify(body)}`) as Error & {
      status: number;
    };
    e.status = status;
    return e;
  }

  it('retries on 5xx then succeeds, going through the limiter for each attempt', async () => {
    /* Two transient 503s, then success on the third attempt. */
    const ok = chunksOf(STAGE1_RESPONSE, 256);
    generateContentStream
      .mockRejectedValueOnce(
        apiError(503, {
          error: { code: 503, message: 'service unavailable', status: 'UNAVAILABLE' },
        }),
      )
      .mockRejectedValueOnce(
        apiError(503, {
          error: { code: 503, message: 'service unavailable', status: 'UNAVAILABLE' },
        }),
      )
      .mockResolvedValueOnce(asyncFromArray(ok.map((text) => ({ text }))));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onThrottle = vi.fn();
    const result = await analyzer.runStage1('m_retry_5xx', '# prompt', { onThrottle });

    expect(generateContentStream).toHaveBeenCalledTimes(3);
    expect(result.characters).toHaveLength(3);
    /* Backoff between attempts must have been ≥1s on at least one,
       so onThrottle fired. */
    expect(onThrottle).toHaveBeenCalled();
    /* Reason is 'retry-after' for explicit retry sleeps. */
    expect(onThrottle.mock.calls.some((c) => c[1] === 'retry-after')).toBe(true);
  }, 30_000);

  it('gives up after MAX_ATTEMPTS=3 of 5xx, re-throwing the upstream error', async () => {
    const err = apiError(500, { error: { code: 500, message: 'oops', status: 'INTERNAL' } });
    generateContentStream
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    await expect(analyzer.runStage1('m_5xx_exhaust', '# prompt', {})).rejects.toMatchObject({
      status: 500,
    });
    expect(generateContentStream).toHaveBeenCalledTimes(3);
  }, 30_000);

  it('retries a per-minute 429 honoring retry-delay from details[]', async () => {
    const throttle = apiError(429, {
      error: {
        code: 429,
        message: 'Resource has been exhausted (e.g. check quota).',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '2s' }],
      },
    });
    const ok = chunksOf(STAGE1_RESPONSE, 256);
    generateContentStream
      .mockRejectedValueOnce(throttle)
      .mockResolvedValueOnce(asyncFromArray(ok.map((text) => ({ text }))));

    const { GeminiAnalyzer } = await import('./gemini.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    const onThrottle = vi.fn();
    const t0 = Date.now();
    const result = await analyzer.runStage1('m_429_retry', '# prompt', { onThrottle });
    const elapsed = Date.now() - t0;

    expect(generateContentStream).toHaveBeenCalledTimes(2);
    expect(result.characters).toHaveLength(3);
    /* Honored the 2-s retry-delay (real timers in this file). */
    expect(elapsed).toBeGreaterThanOrEqual(1_500);
    expect(onThrottle).toHaveBeenCalled();
  }, 30_000);

  it('throws DailyQuotaExhaustedError on a daily-quota 429, no retry', async () => {
    const dailyQuota = apiError(429, {
      error: {
        code: 429,
        message: 'You exceeded your current quota. free_tier ...',
        status: 'RESOURCE_EXHAUSTED',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [] }],
      },
    });
    generateContentStream.mockRejectedValueOnce(dailyQuota);

    const { GeminiAnalyzer } = await import('./gemini.js');
    const { DailyQuotaExhaustedError } = await import('./rate-limit.js');
    const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

    await expect(analyzer.runStage1('m_daily', '# prompt', {})).rejects.toBeInstanceOf(
      DailyQuotaExhaustedError,
    );
    /* Daily 429 must NOT retry — exactly one upstream call. */
    expect(generateContentStream).toHaveBeenCalledTimes(1);
  }, 10_000);

  /* Idle-chunk watchdog + abort wiring — fix for the "Paused: Parsing and
     attribution" stall where a slow Gemini stream blocked the per-chapter
     pipeline indefinitely (see fix/server-gemini-stream-watchdog). The
     watchdog converts a wedged stream into a retryable error; the caller
     signal aborts an in-flight stream immediately. */
  describe('stream watchdog + abort', () => {
    /* Async generator that yields one chunk and then hangs forever. Models
       the pathological case (Google's stream goes silent mid-response). */
    async function* hangAfterFirstChunk(first: { text: string }): AsyncGenerator<{
      text: string;
    }> {
      yield first;
      await new Promise<never>(() => {
        /* never resolves — the watchdog or caller-abort must tear this
           down, not the iterator itself */
      });
    }

    it('throws GeminiStreamIdleError when the stream goes silent for STREAM_IDLE_TIMEOUT_MS', async () => {
      vi.useFakeTimers();
      try {
        const { GeminiAnalyzer, GeminiStreamIdleError, STREAM_IDLE_TIMEOUT_MS } = await import(
          './gemini.js'
        );

        /* All three attempts hang after the first chunk. The retry loop
           catches the idle error and retries; after MAX_ATTEMPTS the last
           idle error propagates. */
        generateContentStream
          .mockResolvedValueOnce(hangAfterFirstChunk({ text: '{' }))
          .mockResolvedValueOnce(hangAfterFirstChunk({ text: '{' }))
          .mockResolvedValueOnce(hangAfterFirstChunk({ text: '{' }));

        const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

        const runP = analyzer.runStage1('m_idle_stall', '# prompt', {}).catch((e) => e);

        /* Three idle-timeouts back-to-back, plus the inter-attempt
           backoff sleeps (up to ~6s each, jittered). Advance generously. */
        for (let i = 0; i < 3; i += 1) {
          await vi.advanceTimersByTimeAsync(STREAM_IDLE_TIMEOUT_MS + 10);
          await vi.advanceTimersByTimeAsync(10_000);
        }

        const err = await runP;
        expect(err).toBeInstanceOf(GeminiStreamIdleError);
        /* Three upstream attempts before giving up — same as the 5xx
           exhaustion path. */
        expect(generateContentStream).toHaveBeenCalledTimes(3);
      } finally {
        vi.useRealTimers();
      }
    }, 30_000);

    it('aborts in-flight stream and throws AnalysisAbortedError when caller signal fires', async () => {
      const { GeminiAnalyzer } = await import('./gemini.js');
      const { AnalysisAbortedError } = await import('./ollama.js');

      generateContentStream.mockResolvedValueOnce(hangAfterFirstChunk({ text: '{' }));

      const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });
      const controller = new AbortController();

      const runP = analyzer
        .runStage1('m_abort_mid_stream', '# prompt', { signal: controller.signal })
        .catch((e) => e);

      /* Wait one tick so the analyzer starts the stream and consumes the
         first chunk, then trip the caller's abort. */
      await new Promise((r) => setTimeout(r, 10));
      controller.abort();

      const err = await runP;
      expect(err).toBeInstanceOf(AnalysisAbortedError);
      /* Caller abort is NOT retried — exactly one upstream call. */
      expect(generateContentStream).toHaveBeenCalledTimes(1);
    }, 5_000);

    it('passes config.abortSignal to generateContentStream so the SDK can tear down the HTTP request', async () => {
      const slices = chunksOf(STAGE1_RESPONSE, 256);
      generateContentStream.mockResolvedValueOnce(asyncFromArray(slices.map((text) => ({ text }))));

      const { GeminiAnalyzer } = await import('./gemini.js');
      const analyzer = new GeminiAnalyzer({ apiKey: 'test-key', model: 'gemini-2.5-flash' });

      const controller = new AbortController();
      await analyzer.runStage1('m_signal_wired', '# prompt', { signal: controller.signal });

      const args = generateContentStream.mock.calls[0][0];
      expect(args.config).toBeDefined();
      /* AbortSignal.any-composed signal is itself an AbortSignal — the
         load-bearing assertion is that ANY signal is wired through, since
         pre-fix the field was unset (undefined). */
      expect(args.config.abortSignal).toBeInstanceOf(AbortSignal);
    });
  });

  it('parseRetryDelayMs handles "Ns", "N.Ns", and "Nms" forms', async () => {
    const { parseRetryDelayMs } = await import('./gemini.js');
    function build(delay: string): Error {
      return new Error(
        JSON.stringify({
          error: {
            details: [{ '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: delay }],
          },
        }),
      );
    }
    expect(parseRetryDelayMs(build('15s'))).toBe(15_000);
    expect(parseRetryDelayMs(build('1.5s'))).toBe(1_500);
    expect(parseRetryDelayMs(build('500ms'))).toBe(500);
    expect(parseRetryDelayMs(new Error('no body here'))).toBeNull();
  });
});

afterAll(async () => {
  /* Tidy the test inbox/outbox we touched so the workspace stays clean. */
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_test-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_skip_empty-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_empty-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_test-stage1-ch7.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_retry_5xx-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_5xx_exhaust-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_429_retry-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'inbox', 'm_daily-stage1.md'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_test-stage1.json'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_skip_empty-stage1.json'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_test-stage1-ch7.json'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_retry_5xx-stage1.json'), { force: true });
  await rm(resolve(HANDOFF_ROOT, 'outbox', 'm_429_retry-stage1.json'), { force: true });
});
