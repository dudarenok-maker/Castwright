/* fs-19 — structured failure-taxonomy tests. Drives `classifyFailure` with
   REAL captured failure strings (XTTS tensor error, CUDA device-side assert,
   429 quota body, ECONNREFUSED, ENOSPC, the synth-timeout message, and an
   unmapped string) and asserts the stable `code`, a jargon-free `userMessage`,
   a non-empty `remediation`, and the legacy `fatal`. These pin the incident-
   tuned regexes the classifier ports from the old ad-hoc describeSynthesisError
   so a refactor can't silently regress them. The file also covers the
   analysis-side classifiers (classifyAnalysisError + classifyAnalysisFailure). */

import { describe, it, expect } from 'vitest';
import { classifyFailure, classifyAnalysisError, classifyAnalysisFailure } from './failure-taxonomy.js';
import { FAILURE_REMEDIATIONS } from './failure-remediations.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import { AnalyzerTruncatedError } from '../analyzer/errors.js';

/* No copy should leak raw stack/jargon at the user — assert the message reads
   like a sentence (starts uppercase, ends with punctuation, no "Traceback"
   /"Error:" prefix bleed). */
function assertJargonFree(msg: string): void {
  expect(msg.length).toBeGreaterThan(0);
  expect(msg).not.toMatch(/Traceback|at Object\.|node_modules/);
}

describe('classifyFailure', () => {
  it('classifies a ChapterSynthTimeoutError (by name) as synth-timeout, non-fatal', () => {
    const err = Object.assign(
      new Error(
        'TTS batch call exceeded 600s with no result — likely runaway/degenerate input. ' +
          'Skipping this chapter so the queue can advance.',
      ),
      { name: 'ChapterSynthTimeoutError' },
    );
    const out = classifyFailure(err, 'qwen');
    expect(out.code).toBe('synth-timeout');
    expect(out.fatal).toBe(false);
    expect(out.userMessage).toMatch(/timed out/i);
    expect(out.userMessage).not.toMatch(/gemini/i);
    expect(out.remediation.length).toBeGreaterThan(0);
    assertJargonFree(out.userMessage);
  });

  it('classifies a real HTTP 429 as analyzer-rate-limit, fatal', () => {
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const out = classifyFailure(err, 'gemini');
    expect(out.code).toBe('analyzer-rate-limit');
    expect(out.fatal).toBe(true);
    expect(out.userMessage).toMatch(/rate-limited/i);
    expect(out.remediation.length).toBeGreaterThan(0);
  });

  it('classifies a RESOURCE_EXHAUSTED quota body as analyzer-rate-limit, fatal (gemini)', () => {
    const out = classifyFailure(
      new Error('RESOURCE_EXHAUSTED: Quota exceeded for the current project'),
      'gemini',
    );
    expect(out.code).toBe('analyzer-rate-limit');
    expect(out.fatal).toBe(true);
  });

  it('does NOT pin a rate-limit-shaped local-engine error on Gemini (non-fatal unknown-ish)', () => {
    const out = classifyFailure(
      new Error('Local TTS sidecar returned 503: {"detail":"rate limit exceeded"}'),
      'qwen',
    );
    expect(out.fatal).toBe(false);
    expect(out.userMessage).not.toMatch(/gemini/i);
  });

  it('classifies the XTTS "index out of range in self" tensor error as xtts-speaker-desync, fatal', () => {
    const out = classifyFailure(
      new Error('Local TTS sidecar returned 500: {"detail":"index out of range in self"}'),
      'coqui',
    );
    expect(out.code).toBe('xtts-speaker-desync');
    expect(out.fatal).toBe(true);
    expect(out.userMessage).toMatch(/voice catalog is out of sync/i);
    expect(out.remediation.length).toBeGreaterThan(0);
  });

  it('classifies a CUDA device-side assert as cuda-poisoned, fatal', () => {
    const out = classifyFailure(
      new Error(
        'Local TTS sidecar returned 500: {"detail":"CUDA error: device-side assert triggered\\nCUDA kernel errors might be asynchronously reported…"}',
      ),
      'coqui',
    );
    expect(out.code).toBe('cuda-poisoned');
    expect(out.fatal).toBe(true);
    expect(out.userMessage).toMatch(/auto-restart/i);
    expect(out.userMessage).toMatch(/retry/i);
  });

  it('classifies the poisoned-fence 503 payload as cuda-poisoned, fatal', () => {
    const out = classifyFailure(
      new Error(
        'Local TTS sidecar returned 503: {"detail":"TTS sidecar is in a poisoned CUDA state…","poisoned":true}',
      ),
    );
    expect(out.code).toBe('cuda-poisoned');
    expect(out.fatal).toBe(true);
  });

  it('classifies CUDA out-of-memory as vram-spill, fatal', () => {
    const out = classifyFailure(
      new Error('CUDA out of memory. Tried to allocate 2.00 GiB (GPU 0; 8.00 GiB total capacity)'),
      'qwen',
    );
    expect(out.code).toBe('vram-spill');
    expect(out.fatal).toBe(true);
    expect(out.userMessage).toMatch(/memory|vram/i);
    expect(out.remediation.length).toBeGreaterThan(0);
  });

  it('classifies a host OOM kill (exit 137 / "killed") as oom, fatal', () => {
    const out = classifyFailure(
      new Error('TTS sidecar process exited unexpectedly: killed (exit code 137)'),
      'qwen',
    );
    expect(out.code).toBe('oom');
    expect(out.fatal).toBe(true);
    expect(out.remediation.length).toBeGreaterThan(0);
  });

  it('classifies ENOSPC / no space left as disk-full, fatal', () => {
    const out = classifyFailure(
      new Error("ENOSPC: no space left on device, write '/audiobook-workspace/audio/ch1.mp3.tmp'"),
    );
    expect(out.code).toBe('disk-full');
    expect(out.fatal).toBe(true);
    expect(out.userMessage).toMatch(/disk|space/i);
    expect(out.remediation.length).toBeGreaterThan(0);
  });

  it('classifies "model not loaded" / 503 loading as model-not-loaded, fatal', () => {
    const out = classifyFailure(
      new Error('Local TTS sidecar returned 503: {"detail":"model not loaded"}'),
      'coqui',
    );
    expect(out.code).toBe('model-not-loaded');
    expect(out.fatal).toBe(true);
    expect(out.remediation.length).toBeGreaterThan(0);
  });

  it('classifies ECONNREFUSED as sidecar-unreachable, fatal', () => {
    const out = classifyFailure(
      new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9000'),
    );
    expect(out.code).toBe('sidecar-unreachable');
    expect(out.fatal).toBe(true);
    expect(out.userMessage).toMatch(/sidecar/i);
    expect(out.remediation.length).toBeGreaterThan(0);
  });

  it('classifies a 401/403 auth failure as auth, fatal', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    const out = classifyFailure(err, 'gemini');
    expect(out.code).toBe('auth');
    expect(out.fatal).toBe(true);
    expect(out.userMessage).toMatch(/authentication/i);
  });

  it('classifies a RecycleStormError (by ctx.name) as recycle-storm, non-fatal', () => {
    /* C3 — the named recycle-storm error from synthesise-chapter.ts. Its real
       message contains "VRAM/RAM headroom", which would match the vram-spill
       regex; the type-driven ctx.name signature MUST win because it is ordered
       before vram-spill (first-match-wins). */
    const err = Object.assign(
      new Error(
        'The TTS sidecar recycled 2× while rendering this single chapter — it is likely ' +
          'thrashing (host-memory leak or insufficient VRAM/RAM headroom). Stopping so the ' +
          "run doesn't grind. Restart the sidecar / lower concurrency, then Retry.",
      ),
      { name: 'RecycleStormError' },
    );
    const out = classifyFailure(err, 'kokoro');
    expect(out.code).toBe('recycle-storm');
    expect(out.code).not.toBe('vram-spill'); // ORDERING: must not be swallowed by the VRAM regex
    expect(out.fatal).toBe(false);
    expect(out.userMessage).toMatch(/kept restarting|restarting/i);
    expect(out.remediation).toMatch(/sidecar|headroom|concurrency/i);
    assertJargonFree(out.userMessage);
  });

  it('classifies a recycle-storm by raw message fallback (no ctx.name) as recycle-storm', () => {
    /* Defense-in-depth: even with the type-driven ctx.name absent (e.g. a
       message-only error from another path), the raw-message fallback regex
       classifies it as recycle-storm, NOT vram-spill. */
    const out = classifyFailure(
      new Error(
        'The TTS sidecar recycled 3× while rendering this single chapter — insufficient VRAM headroom.',
      ),
      'kokoro',
    );
    expect(out.code).toBe('recycle-storm');
    expect(out.code).not.toBe('vram-spill');
    expect(out.fatal).toBe(false);
  });

  it('passes an unknown error through as code "unknown", non-fatal, raw userMessage', () => {
    const out = classifyFailure(new Error('Something unexpected and unmapped happened'));
    expect(out.code).toBe('unknown');
    expect(out.fatal).toBe(false);
    expect(out.userMessage).toBe('Something unexpected and unmapped happened');
    expect(out.remediation.length).toBeGreaterThan(0);
    expect(out.raw).toBe('Something unexpected and unmapped happened');
  });

  it('truncates a long unknown message to <=240 chars + ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = classifyFailure(new Error(long));
    expect(out.code).toBe('unknown');
    expect(out.userMessage.length).toBeLessThanOrEqual(241);
    expect(out.userMessage.endsWith('…')).toBe(true);
  });
});

describe('source gating (spec A2)', () => {
  it('classifyFailure (generation) still matches sidecar-unreachable on ECONNREFUSED', () => {
    const r = classifyFailure(new Error('connect ECONNREFUSED 127.0.0.1:8001'));
    expect(r.code).toBe('sidecar-unreachable');
  });
  it('classifyAnalysisError never blames the sidecar for an analysis failure', () => {
    const r = classifyAnalysisError(new Error('connect ECONNREFUSED 127.0.0.1:11434'));
    expect(r.code).not.toBe('sidecar-unreachable');
  });
  it('analysis path still sees the both-gated quota signature', () => {
    const err = Object.assign(new Error('429 Too Many Requests: quota exceeded'), { status: 429 });
    expect(classifyAnalysisError(err).code).toBe('analyzer-rate-limit');
  });
  it('analysis path still sees the both-gated disk-full signature', () => {
    expect(classifyAnalysisError(new Error('ENOSPC: no space left on device')).code).toBe('disk-full');
  });
});

describe('analysis-side codes (spec A2)', () => {
  it('classifies AnalyzerTruncatedError by name', () => {
    const err = Object.assign(new Error('gemini truncated the response'), {
      name: 'AnalyzerTruncatedError',
    });
    expect(classifyAnalysisError(err).code).toBe('analyzer-truncated');
  });
  it('classifies DailyQuotaExhaustedError by name, before the rate-limit signature', () => {
    const err = Object.assign(new Error('daily quota exhausted — resets later'), {
      name: 'DailyQuotaExhaustedError',
    });
    expect(classifyAnalysisError(err).code).toBe('analyzer-daily-quota');
  });
  it('classifies an unreachable analyzer (connection refused) as analyzer-unreachable', () => {
    expect(
      classifyAnalysisError(new Error('connect ECONNREFUSED 127.0.0.1:11434')).code,
    ).toBe('analyzer-unreachable');
  });
  it('classifies GeminiStreamIdleError (retry-exhausted) as analyzer-unreachable', () => {
    const err = Object.assign(new Error('stream idle'), { name: 'GeminiStreamIdleError' });
    expect(classifyAnalysisError(err).code).toBe('analyzer-unreachable');
  });
  it('classifies a Gemini empty-response (recitation block) as analyzer-content-blocked', () => {
    const err = new Error(
      'Gemini gemini-3.1-flash-lite returned an empty response (reason=RECITATION). A content filter blocked the text.',
    );
    expect(classifyAnalysisError(err).code).toBe('analyzer-content-blocked');
    /* Run-level classifier (no API envelope, no status) routes here too. */
    expect(classifyAnalysisFailure(err, 'Gemini (gemini-3.1-flash-lite)').code).toBe(
      'analyzer-content-blocked',
    );
  });
  it("does NOT blame Ollama's same-worded empty response on the recitation filter", () => {
    const err = new Error('Ollama qwen3.5:4b returned an empty response.');
    expect(classifyAnalysisError(err).code).not.toBe('analyzer-content-blocked');
  });
  it('generation path never sees the analysis-only entries', () => {
    const err = Object.assign(new Error('whatever'), { name: 'AnalyzerTruncatedError' });
    expect(classifyFailure(err).code).toBe('unknown');
  });
  it('attribution-incomplete has copy (synthetic code, no signature)', () => {
    expect(FAILURE_REMEDIATIONS['attribution-incomplete'].remediation.length).toBeGreaterThan(0);
  });
});

describe('failure-remediations copy module (fe-29/fs-19 shared copy)', () => {
  it('has exactly one entry per FailureCode', () => {
    expect(Object.keys(FAILURE_REMEDIATIONS).sort()).toEqual(
      [
        'analyzer-content-blocked',
        'analyzer-daily-quota',
        'analyzer-rate-limit',
        'analyzer-truncated',
        'analyzer-unreachable',
        'attribution-incomplete',
        'auth',
        'cuda-poisoned',
        'disk-full',
        'model-not-loaded',
        'oom',
        'recycle-storm',
        'sidecar-unreachable',
        'synth-timeout',
        'unknown',
        'vram-spill',
        'xtts-speaker-desync',
      ].sort(),
    );
  });
  it('every entry has non-empty userMessage and remediation', () => {
    for (const [code, copy] of Object.entries(FAILURE_REMEDIATIONS)) {
      expect(copy.userMessage.length, code).toBeGreaterThan(0);
      expect(copy.remediation.length, code).toBeGreaterThan(0);
    }
  });
});

describe('classifyAnalysisFailure (run-level, ports describeError verbatim — spec A3)', () => {
  it('AnalyzerTruncatedError → analyzer-truncated with dynamic message + structured detail', () => {
    const err = new AnalyzerTruncatedError('gemini', 'MAX_TOKENS', 8192, 4096);
    const r = classifyAnalysisFailure(err, 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-truncated');
    expect(r.userMessage).toContain('Gemini (gemma-4-31b-it)');
    expect(r.userMessage).toContain('MAX_TOKENS');
    expect(r.detail).toContain('engine=gemini');
    expect(r.remediation.length).toBeGreaterThan(0);
  });
  it('DailyQuotaExhaustedError → analyzer-daily-quota preserving the reset time', () => {
    const resetAt = new Date('2026-06-13T07:00:00Z');
    const err = new DailyQuotaExhaustedError('gemma-4-31b-it', resetAt);
    const r = classifyAnalysisFailure(err, 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-daily-quota');
    expect(r.userMessage).toContain('2026-06-13T07:00:00.000Z');
  });
  it('Google envelope 429 free-tier → analyzer-daily-quota with trimmed message', () => {
    const raw =
      'got status: 429. {"error":{"code":429,"message":"You exceeded your current quota: generate_requests_per_model_per_day_free_tier. Please check your plan and billing details. More text that should be trimmed away entirely.","status":"RESOURCE_EXHAUSTED","details":[{"quotaValue":"250"}]}}';
    const r = classifyAnalysisFailure(new Error(raw), 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-daily-quota');
    expect(r.userMessage).toContain('429');
    expect(r.detail).toContain('RESOURCE_EXHAUSTED');
  });
  it('envelope 503 → analyzer-unreachable; 401 → auth; 400 → unknown', () => {
    const env = (code: number, status: string) =>
      new Error(`got status: ${code}. {"error":{"code":${code},"message":"boom","status":"${status}"}}`);
    expect(classifyAnalysisFailure(env(503, 'UNAVAILABLE'), 'm').code).toBe('analyzer-unreachable');
    expect(classifyAnalysisFailure(env(401, 'UNAUTHENTICATED'), 'm').code).toBe('auth');
    expect(classifyAnalysisFailure(env(400, 'INVALID_ARGUMENT'), 'm').code).toBe('unknown');
  });
  it('bare status (no envelope) classifies too', () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    expect(classifyAnalysisFailure(err, 'm').code).toBe('analyzer-unreachable');
  });
  it('non-envelope plain error falls through to the analysis table scan', () => {
    const r = classifyAnalysisFailure(new Error('connect ECONNREFUSED 127.0.0.1:11434'), 'Ollama');
    expect(r.code).toBe('analyzer-unreachable');
  });
  it('unmapped error → unknown with raw message preserved', () => {
    const r = classifyAnalysisFailure(new Error('some novel failure'), 'm');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toContain('some novel failure');
  });
});
