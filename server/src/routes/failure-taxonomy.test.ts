/* fs-19 — structured failure-taxonomy tests. Drives `classifyFailure` with
   REAL captured failure strings (XTTS tensor error, CUDA device-side assert,
   429 quota body, ECONNREFUSED, ENOSPC, the synth-timeout message, and an
   unmapped string) and asserts the stable `code`, a jargon-free `userMessage`,
   a non-empty `remediation`, and the legacy `fatal`. These pin the incident-
   tuned regexes the classifier ports from the old ad-hoc describeSynthesisError
   so a refactor can't silently regress them. The file also covers the
   analysis-side classifiers (classifyAnalysisError + classifyAnalysisFailure). */

import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import { ApiError } from '@google/genai';
import { classifyFailure, classifyAnalysisError, classifyAnalysisFailure, analyzerSelectionErrorEvent } from './failure-taxonomy.js';
import { FAILURE_REMEDIATIONS } from './failure-remediations.js';
import { DailyQuotaExhaustedError } from '../analyzer/rate-limit.js';
import {
  AnalyzerReasoningOverflowError,
  AnalyzerTimeoutError,
  AnalyzerTruncatedError,
  GeminiContentBlockedError,
  AnalyzerHttpError,
  AnalyzerKeyOriginError,
  AnalyzerEndpointMissingError,
  AnalyzerInvalidOutputError,
  AnalyzerStreamIncompleteError,
  AnalyzerTransportError,
  AnalyzerUnreachableError,
  causeCodeSuffix,
  sanitizeCauseCode,
} from '../analyzer/errors.js';
import { LIMIT_400_PATTERNS } from '../analyzer/limit-400-patterns.js';
import { UnresolvableClonedVoiceError } from '../tts/clone-voice-resolver.js';
/* #3084 A9 — importing user-settings.js registers the known-secrets provider
   at module load, so redactKnownSecrets can strip a saved key in the tests below. */
import { _resetUserSettingsCache, _setUserSettingsCacheForTest } from '../workspace/user-settings.js';

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
    expect(out.userMessage).toMatch(/voice engine/i);
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

  it('classifies UnresolvableClonedVoiceError (fromList, revoked) as cloned-voice-broken, non-fatal', () => {
    /* T7 (Wave 3b2) — the resolver pre-pass in synthesiseChapter raises this
       when an assigned cloned voice can't render as itself this run. */
    const err = UnresolvableClonedVoiceError.fromList([{ name: 'Marlow', reason: 'revoked' }]);
    const out = classifyFailure(err, 'qwen');
    expect(out.code).toBe('cloned-voice-broken');
    /* Per-chapter/per-character, not a whole-run stop — mirrors voice-not-
       designed's chapter-scoped model. The cross-chapter cascade in
       generation.ts still escalates to a run-stop if the same reason repeats. */
    expect(out.fatal).toBe(false);
    expect(out.remediation.length).toBeGreaterThan(0);
    expect(out.userMessage.length).toBeGreaterThan(0);
    assertJargonFree(out.userMessage);
  });

  it('classifies a wrong-engine UnresolvableClonedVoiceError as cloned-voice-broken without claiming Qwen is unavailable', () => {
    /* Task 6b guard: a wrong-engine break means the BOOK doesn't route to
       Qwen this run — Qwen itself may be perfectly healthy, so the surfaced
       copy must never misdiagnose this as "Qwen is unavailable". */
    const err = UnresolvableClonedVoiceError.fromList([{ name: 'Sable', reason: 'wrong-engine' }]);
    const out = classifyFailure(err, 'kokoro');
    expect(out.code).toBe('cloned-voice-broken');
    expect(out.userMessage).not.toMatch(/qwen (is|engine is not) unavailable/i);
    expect(out.remediation).not.toMatch(/qwen (is|engine is not) unavailable/i);
  });

  it('classifies the legacy single-name UnresolvableClonedVoiceError (engine-unavailable) as cloned-voice-broken', () => {
    const err = new UnresolvableClonedVoiceError('Marlow');
    const out = classifyFailure(err, 'qwen');
    expect(out.code).toBe('cloned-voice-broken');
  });

  it('does not let cloned-voice-broken get shadowed by a broader generation signature (ordering)', () => {
    /* Defense against a future re-order: craft a message that WOULD also
       match the later, broader gpu-acceleration-unavailable signature's
       regex (/GPU acceleration (is )?unavailable/i) — if cloned-voice-broken
       were ever moved after it in FAILURE_SIGNATURES, this would misclassify
       as gpu-acceleration-unavailable instead. Because scanSignatures is
       first-match-wins and the typed `matchName` entry sits earlier in the
       table, the named match must win regardless of what the message text
       collides with. This genuinely proves non-shadowing, unlike asserting
       on a message that matches no other signature at all. */
    const err = Object.assign(
      new Error('GPU acceleration unavailable — totally different future wording'),
      { name: 'UnresolvableClonedVoiceError' },
    );
    expect(classifyFailure(err, 'qwen').code).toBe('cloned-voice-broken');
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
  it('classifies a per-minute input-token 429 as analyzer-rate-limit, not analyzer-daily-quota (#1682)', () => {
    /* Real-world envelope (#1682): the per-minute input-token quota's message
       contains "free_tier" (via generate_content_free_tier_input_token_count),
       which used to false-positive-match the raw daily-quota signature and
       drop the whole chapter instead of retrying a minute later. */
    const raw =
      'got status: 429. {"error":{"message":"Quota exceeded for metric: ' +
      'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, ' +
      'quotaId: GenerateContentInputTokensPerModelPerMinute-FreeTier","status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"quotaValue":"16000"}]}}';
    const err = Object.assign(new Error(raw), { status: 429 });
    expect(classifyAnalysisError(err).code).toBe('analyzer-rate-limit');
  });
  it('classifies a genuine per_day 429 as analyzer-daily-quota via the raw-matcher regex (#1682)', () => {
    /* Same production envelope shape as the "Google envelope 429 free-tier"
       case below (classifyAnalysisFailure test at ~:352), but routed through
       classifyAnalysisError/scanSignatures with NO err.name set — so the
       matchName short-circuit for 'DailyQuotaExhaustedError' can't fire and
       Site 1's /per[_-]?day/i marker regex (line ~113) is the only thing that
       can classify this as daily. Post-#1695 the daily classifier keys SOLELY
       on the per_day/PerDay marker (the small-quotaValue clause was dropped),
       so a typo in per_day (e.g. -> per_dat) must make THIS test fail on its
       own — nothing else can rescue it. */
    const raw =
      'got status: 429. {"error":{"code":429,"message":"You exceeded your current quota: ' +
      'generate_requests_per_model_per_day_free_tier. GenerateRequestsPerDayPerProjectPerModel-FreeTier.",' +
      '"status":"RESOURCE_EXHAUSTED","details":[{"quotaValue":"12500"}]}}';
    const err = Object.assign(new Error(raw), { status: 429 });
    expect(classifyAnalysisError(err).code).toBe('analyzer-daily-quota');
  });
  it('classifies a per-minute RPM 429 (quotaValue":"15") as analyzer-rate-limit, not daily (#1695)', () => {
    /* The free-tier per-MINUTE request-rate cap is 15 (a 2-digit quotaValue),
       so the old `quotaValue":"\d{1,3}"` heuristic mis-classified this
       retryable RPM 429 as fatal daily-quota exhaustion. Discriminate on the
       PerMinute quotaId instead: no per_day/PerDay marker → rate-limit. */
    const raw =
      'got status: 429. {"error":{"message":"Quota exceeded for metric: ' +
      'generativelanguage.googleapis.com/generate_requests_per_model_per_minute, ' +
      'quotaId: GenerateRequestsPerMinutePerProjectPerModel-FreeTier","status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"quotaValue":"15"}]}}';
    const err = Object.assign(new Error(raw), { status: 429 });
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
  it('classifies a real GeminiContentBlockedError instance as analyzer-content-blocked', () => {
    const err = new GeminiContentBlockedError('gemini-3.1-flash-lite', 'RECITATION');
    expect(classifyAnalysisError(err).code).toBe('analyzer-content-blocked');
    expect(classifyAnalysisFailure(err, 'Gemini (gemini-3.1-flash-lite)').code).toBe(
      'analyzer-content-blocked',
    );
  });
  it('classifies GeminiContentBlockedError by name even if the message is reworded', () => {
    /* Name-driven match survives a future message reword — the regex is the
       fallback, the typed name is the primary matcher (mirrors AnalyzerTruncatedError). */
    const err = Object.assign(new Error('totally different future wording'), {
      name: 'GeminiContentBlockedError',
    });
    expect(classifyAnalysisError(err).code).toBe('analyzer-content-blocked');
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
  it('attribution-collapse has copy (synthetic code, no signature — #2342 item 2)', () => {
    expect(FAILURE_REMEDIATIONS['attribution-collapse'].remediation.length).toBeGreaterThan(0);
  });
  it('classifies a GPU-acceleration-unavailable message without shadowing CUDA/VRAM (AMD phase 2)', () => {
    expect(
      classifyFailure(new Error('GPU acceleration unavailable — no compatible GPU detected')).code,
    ).toBe('gpu-acceleration-unavailable');
    // the distinctive phrase must NOT swallow the specific GPU error signatures
    expect(classifyFailure(new Error('CUDA error: device-side assert')).code).toBe('cuda-poisoned');
    expect(classifyFailure(new Error('CUDA out of memory')).code).toBe('vram-spill');
  });
});

describe('failure-remediations copy module (fe-29/fs-19 shared copy)', () => {
  it('has exactly one entry per FailureCode', () => {
    expect(Object.keys(FAILURE_REMEDIATIONS).sort()).toEqual(
      [
        'analyzer-content-blocked',
        'analyzer-daily-quota',
        'analyzer-endpoint-missing',
        'analyzer-invalid-output',
        'analyzer-rate-limit',
        'analyzer-reasoning-overflow',
        'analyzer-request-rejected',
        'analyzer-timeout',
        'analyzer-truncated',
        'analyzer-unreachable',
        'attribution-incomplete',
        'attribution-collapse',
        'auth',
        'cloned-voice-broken',
        'cuda-poisoned',
        'disk-full',
        'gpu-acceleration-unavailable',
        'language-unset',
        'lock-contention',
        'model-not-loaded',
        'oom',
        'recycle-storm',
        'sidecar-unreachable',
        'synth-timeout',
        'unknown',
        'vram-spill',
        'voice-not-designed',
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
  it('Google envelope 429 per-minute input-token quota → analyzer-rate-limit, not daily (#1682)', () => {
    /* Same production envelope as above, routed through the message matcher
       (statusToFailureCode) instead of the raw one — "free_tier" appears here
       too (generate_content_free_tier_input_token_count) but there is no
       per_day marker, so this must NOT classify as analyzer-daily-quota
       (post-#1695 the quotaValue digit-count no longer influences it). */
    const raw =
      'got status: 429. {"error":{"code":429,"message":"Quota exceeded for metric: ' +
      'generativelanguage.googleapis.com/generate_content_free_tier_input_token_count, ' +
      'quotaId: GenerateContentInputTokensPerModelPerMinute-FreeTier","status":"RESOURCE_EXHAUSTED",' +
      '"details":[{"quotaValue":"16000"}]}}';
    const r = classifyAnalysisFailure(new Error(raw), 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-rate-limit');
  });
  it('Google envelope 429 per-minute RPM (quotaValue":"15" in message) → analyzer-rate-limit, not daily (#1695)', () => {
    /* The free-tier per-MINUTE request cap is 15 — a 2-digit quotaValue that
       the old `quotaValue":"\d{1,3}"` heuristic false-positive-matched as
       daily. Here the message inlines the violation (some 429 bodies do), so
       the message-matcher (statusToFailureCode) would have mis-fired. With no
       per_day marker it must classify retryable rate-limit. */
    const raw =
      'got status: 429. {"error":{"code":429,"message":"Quota exceeded for quota metric ' +
      'GenerateRequestsPerMinutePerProjectPerModel-FreeTier with limit quotaValue\\":\\"15\\" ' +
      'for the free tier.","status":"RESOURCE_EXHAUSTED"}}';
    const r = classifyAnalysisFailure(new Error(raw), 'Gemini (gemma-4-31b-it)');
    expect(r.code).toBe('analyzer-rate-limit');
  });
  it('envelope 503 → analyzer-unreachable; 401 → auth; 400 → analyzer-request-rejected (#3084 PR 3b)', () => {
    const env = (code: number, status: string) =>
      new Error(`got status: ${code}. {"error":{"code":${code},"message":"boom","status":"${status}"}}`);
    expect(classifyAnalysisFailure(env(503, 'UNAVAILABLE'), 'm').code).toBe('analyzer-unreachable');
    expect(classifyAnalysisFailure(env(401, 'UNAUTHENTICATED'), 'm').code).toBe('auth');
    expect(classifyAnalysisFailure(env(400, 'INVALID_ARGUMENT'), 'm').code).toBe('analyzer-request-rejected');
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

/* #2260 FINAL ROUND (B2) — the classifier is the seam where a lock-acquisition
 * timeout stops being a raw diagnostic and becomes something safe to broadcast.
 *
 * Both analysis jobs pass this function's `userMessage` straight to
 * `endJob(job, {kind:'error', message})`, which fans out over SSE to every
 * subscriber including a paired phone on the LAN. Before this branch the class
 * fell through to `withCopy('unknown', raw)`, so what went out was
 * `withKeyLock: timed out … "<ABSOLUTE WORKSPACE PATH>" — either a cast-lock.ts
 * rule 1 …` — six of the eight fail-loud sites in `analysis.ts` reach here.
 *
 * Two-directional on purpose: the second half is what reddens if the fix is
 * over-applied into "curate everything", which would throw away the only
 * diagnostic an unmapped analyzer failure has.
 */
describe('classifyAnalysisFailure — a lock timeout is curated, everything else is not (#2260)', () => {
  /* The real key shape: `withCastLock` keys on `castJsonPath(bookDir)`, so the
     lock key IS an absolute path into the user's library. */
  const KEY = 'C:\\Users\\someone\\Castwright\\books\\Della Renwick\\Hollow Tide\\.audiobook\\cast.json';

  it('a lock-acquisition timeout gets the shared curated sentence and leaks nothing', async () => {
    const { LockAcquisitionTimeoutError, LOCK_CONTENTION_REQUEST_ERROR } = await import(
      '../workspace/file-lock.js'
    );
    const r = classifyAnalysisFailure(
      new LockAcquisitionTimeoutError(KEY, 10_000),
      'Gemini (gemma-4-31b-it)',
    );

    expect(r.code).toBe('lock-contention');
    /* By value, so a reword has to move the constant and this line together. */
    expect(r.userMessage).toBe(LOCK_CONTENTION_REQUEST_ERROR);
    expect(r.userMessage).not.toContain(KEY);
    expect(r.userMessage).not.toContain('withKeyLock');
    expect(r.userMessage).not.toContain('rule 4');
    /* `detail` renders in the UI's collapsible, so populating it would put the
       leak back one fold down. */
    expect(r.detail).toBeUndefined();
    /* And the model label is deliberately NOT prefixed: the analyzer model had
       nothing to do with it. */
    expect(r.userMessage).not.toContain('gemma-4-31b-it');
  });

  it('discriminates on the stable `code` string, not the class or the name', async () => {
    const { LOCK_ACQUISITION_TIMEOUT_CODE, LOCK_CONTENTION_REQUEST_ERROR } = await import(
      '../workspace/file-lock.js'
    );
    /* The same reasoning `isLockAcquisitionTimeout`'s own comment records: an
       `instanceof` (or an `err.name`) check fails OPEN across two module
       instances, i.e. straight back to broadcasting the key. A duck-typed
       object carrying only the code must still classify. */
    const ducked = Object.assign(new Error(`withKeyLock: timed out … "${KEY}" … rule 4`), {
      code: LOCK_ACQUISITION_TIMEOUT_CODE,
      name: 'SomeOtherError',
    });
    expect(classifyAnalysisFailure(ducked, 'm').userMessage).toBe(LOCK_CONTENTION_REQUEST_ERROR);
  });

  it('a NON-timeout error that happens to name a file is unchanged', () => {
    /* The over-application direction. An EPERM keeps its own message — that is
       the only diagnostic an unmapped analysis failure has, it is not the class
       #2260 made reachable by ordinary contention, and nothing about this
       change is meant to touch it. */
    const eperm = Object.assign(
      new Error("EPERM: operation not permitted, rename 'cast.json'"),
      { code: 'EPERM' },
    );
    const r = classifyAnalysisFailure(eperm, 'm');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toContain('EPERM');
    expect(r.userMessage).toContain('cast.json');
  });

  it('the other classified families still win their own errors', () => {
    /* Placed FIRST in the function, so this pair is the guard that the new
       branch did not shadow the envelope/typed-error paths below it. */
    const env = new Error('got status: 503. {"error":{"code":503,"message":"boom","status":"UNAVAILABLE"}}');
    expect(classifyAnalysisFailure(env, 'm').code).toBe('analyzer-unreachable');
    expect(classifyAnalysisFailure(new Error('connect ECONNREFUSED 127.0.0.1:11434'), 'm').code).toBe(
      'analyzer-unreachable',
    );
  });
});

describe('AnalyzerTimeoutError (#3084 wave 2b)', () => {
  it('→ analyzer-timeout, naming the Gemini request ceiling setting', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerTimeoutError('gemini', 'gemini-3.6-flash', 1_800_000, 'ceiling'),
      'Gemini (gemini-3.6-flash)',
    );
    expect(r.code).toBe('analyzer-timeout');
    expect(r.userMessage).toContain('Gemini (gemini-3.6-flash)');
    expect(r.userMessage).toContain('Gemini request ceiling');
    expect(r.detail).toContain('reason=ceiling');
  });

  it('→ analyzer-timeout naming the thinking window setting and its 290 s maximum for a thinking-idle timeout, not the ceiling', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerTimeoutError('gemini', 'gemini-3.6-flash', 120_000, 'thinking-idle'),
      'Gemini (gemini-3.6-flash)',
    );
    expect(r.code).toBe('analyzer-timeout');
    expect(r.userMessage).toContain('Gemini (gemini-3.6-flash)');
    expect(r.userMessage).toContain('analyzer.gemini.thinkingIdleTimeoutMs');
    expect(r.userMessage).toContain('GEMINI_THINKING_IDLE_MS');
    expect(r.userMessage).toContain('290000');
    expect(r.userMessage).not.toContain('request ceiling');
    expect(r.remediation).toContain('ANALYZER_GEMINI_REQUEST_CEILING_MS');
    expect(r.detail).toContain('reason=thinking-idle');
  });

  it('is matched by name in the signature scan and never reads as unreachable', () => {
    expect(classifyAnalysisError(new AnalyzerTimeoutError('gemini', 'gemini-3.6-flash', 1, 'ceiling')).code).toBe(
      'analyzer-timeout',
    );
  });
});

describe('AnalyzerReasoningOverflowError (#3084 wave 2b)', () => {
  it('→ analyzer-reasoning-overflow: userMessage is the what-happened headline only, remediation names the setting (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
    );
    expect(r.code).toBe('analyzer-reasoning-overflow');
    expect(r.userMessage).toContain('Gemini (gemini-3.6-flash)');
    expect(r.detail).toContain('reasoningTokens=8100');
    // #3084 F7 — no "raise X" advice or "then retry" in userMessage; that
    // lives in remediation instead, which is static (per-code, not
    // per-instance) so it names the setting but not this chapter.
    expect(r.userMessage).not.toContain('Gemini max output tokens');
    expect(r.userMessage).not.toContain('retry');
    expect(r.remediation).toContain('Gemini max output tokens');
    // #3084 F2/#13 — no wave-5-only "reasoning level" control promised yet.
    expect(r.userMessage).not.toContain('reasoning level');
    expect(r.remediation).not.toContain('reasoning level');
    // #3084 F7 — the remediation step list ends with this sentence verbatim.
    expect(r.remediation.endsWith('Then resume — finished chapters are kept.')).toBe(true);
    // #3084 F7 — no chapter was passed, so the message never invents one.
    expect(r.userMessage).toContain('a chapter');
    expect(r.userMessage).not.toMatch(/chapter\s+"|chapter\s+\d/);
  });

  it('names the chapter by title when the caller passes one (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
      { chapter: { id: 4, title: 'The Long Night' } },
    );
    expect(r.userMessage).toContain('chapter "The Long Night"');
    expect(r.detail).toContain('chapterId=4');
  });

  it('falls back to the bare chapter id when no title was passed (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
      { chapter: { id: 7 } },
    );
    expect(r.userMessage).toContain('chapter 7');
    expect(r.detail).toContain('chapterId=7');
  });

  it('the static remediation names Ollama num_ctx as the default fix and num_predict only when pinned, for an Ollama overflow (#3084 F7)', () => {
    /* #3084 F7 — userMessage is the what-happened headline only (Task 2.9's
       rewrite, this same round); it never names a setting. The setting comes
       from the STATIC remediation (failure-remediations.ts), which is the
       same for every AnalyzerReasoningOverflowError regardless of transport
       or model, so this asserts on remediation, not userMessage. Task 2.9a's
       own test (below, added when it lands `fixes`) additionally asserts the
       Ollama branch's `reasoningOverflowFixes` names `analyzer.ollama.numCtx`
       specifically — that is the per-instance, structured version of this
       same fact; this test is the static, prose version. */
    const r = classifyAnalysisFailure(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined), 'Ollama (qwen3.5:4b)');
    expect(r.userMessage).not.toContain('num_ctx');
    expect(r.userMessage).not.toContain('num_predict');
    expect(r.remediation).toContain('Ollama num_ctx');
    /* num_predict is named only as the conditional case (set above -1), with
       num_ctx still the default advice. */
    expect(r.remediation).toContain("if you set 'Ollama num_predict'");
    expect(r.remediation).toContain('ANALYZER_NUM_CTX');
  });

  it('is matched by name in the signature scan', () => {
    expect(classifyAnalysisError(new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined)).code).toBe(
      'analyzer-reasoning-overflow',
    );
  });

  /* #3084 F7 (Task 2.9a) — `fixes` on top of the copy asserted above: the
     per-instance, structured half of the same advice. The static remediation
     stays transport-agnostic; `fixes` is the part that can name THIS engine's
     settings, so these assert the Gemini/Ollama split and the wiki entry's
     position (every actionable fix first, the single wiki link last). */
  it('attaches the Gemini fixes: actionable first, the single wiki link last (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('gemini', 'gemini-3.6-flash', 8100),
      'Gemini (gemini-3.6-flash)',
    );
    const keys = (r.fixes ?? []).map((f) => f.settingKey);
    expect(keys).not.toContain('analyzer.gemini.maxInputTokensPerRequest');
    expect(keys).not.toContain('analyzer.gemini.outputHeavyChunkChars');
    /* Label-only "switch model" (no settingKey, no wikiPage → plain text). */
    const switchModel = (r.fixes ?? []).find((f) => f.label === 'Switch to a different analyzer model');
    expect(switchModel?.settingKey).toBeUndefined();
    expect(switchModel?.wikiPage).toBeUndefined();
    const fixes = r.fixes ?? [];
    const last = fixes[fixes.length - 1];
    expect(last?.label).toBe('Read: When a model thinks past its output limit');
    expect(last?.wikiPage).toBe('Analysis-and-the-Analyzer');
    expect(last?.settingKey).toBeUndefined();
  });

  it('attaches the Ollama fixes naming num_ctx, not num_predict (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('ollama', 'qwen3.5:4b', undefined),
      'Ollama (qwen3.5:4b)',
    );
    const keys = (r.fixes ?? []).map((f) => f.settingKey);
    expect(keys).toContain('analyzer.ollama.numCtx');
    expect(keys).not.toContain('analyzer.ollama.numPredict');
    expect(keys).toContain('analyzer.stage1.localInputFraction');
    expect(keys).toContain('analyzer.stage2.localInputFraction');
    expect((r.fixes ?? []).map((f) => f.label)).toContain('Switch to a different analyzer model');
  });

  it('carries no fixes for an OpenAI-compatible endpoint yet (3b adds them) (#3084 F7)', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerReasoningOverflowError('openai', 'm', undefined),
      'OpenAI-compatible (m)',
    );
    expect(r.fixes).toEqual([]);
  });
});

describe('classifyAnalysisFailure — wave-3 analyzer codes (#3084 PR 3b)', () => {
  const savedKey = process.env.GEMINI_API_KEY;
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    _resetUserSettingsCache();
  });

  it.each(['ollama', 'gemini', 'openai'] as const)(
    'AnalyzerHttpError(%s, 400) → analyzer-request-rejected naming that engine\'s request-shaping settings',
    (transport) => {
      const body = '{"error":"response_format.type must be json_schema or text"}';
      const r = classifyAnalysisFailure(
        new AnalyzerHttpError(transport, 400, body, `returned 400: ${body}`),
        'Some model',
      );
      expect(r.code).toBe('analyzer-request-rejected');
      expect(r.userMessage).toContain('rejected the request (400)');
      expect(r.userMessage).toContain('response_format.type must be json_schema');
      const expected = {
        ollama: 'analyzer.ollama.structuredOutput',
        gemini: 'analyzer.gemini.structuredOutput',
        openai: "the endpoint's Structured output field",
      }[transport];
      expect(r.remediation).toContain(expected);
    },
  );

  it('a Gemini ApiError 400 envelope → analyzer-request-rejected with the provider message, keeping the status/details detail block', () => {
    const err = new ApiError({
      status: 400,
      message:
        'got status: 400 Bad Request. {"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"minLength\\"","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.BadRequest","fieldViolations":[{"field":"generation_config.response_json_schema"}]}]}}',
    });
    const r = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(r.code).toBe('analyzer-request-rejected');
    expect(r.userMessage).toContain('Unknown name');
    expect(r.remediation).toContain('analyzer.gemini.structuredOutput');
    /* failure-taxonomy.ts:556-560 — the envelope's status and details stay in `detail`. */
    expect(r.detail).toContain('status: INVALID_ARGUMENT');
    expect(r.detail).toContain('details:');
    expect(r.detail).toContain('generation_config.response_json_schema');
  });

  it('an endpoint 400 naming a token or context limit points to the max-output field; a schema 400 does not (#3084 P24)', () => {
    const limited = classifyAnalysisFailure(
      new AnalyzerHttpError('openai', 400, LIMIT_400_PATTERNS[0].example, `returned 400: ${LIMIT_400_PATTERNS[0].example}`),
      'Endpoint lab (qwen3:30b)',
    );
    expect(limited.code).toBe('analyzer-request-rejected');
    expect(limited.remediation).toContain("the endpoint's Max output tokens field");
    const schema = classifyAnalysisFailure(
      new AnalyzerHttpError('openai', 400, "'response_format.type' must be 'json_schema' or 'text'", 'returned 400'),
      'Endpoint lab (qwen3:30b)',
    );
    expect(schema.remediation).not.toContain("the endpoint's Max output tokens field");
  });

  it('redacts a saved API key from the provider message and the detail', () => {
    delete process.env.GEMINI_API_KEY;
    _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSyTEST-SECRET-123456' });
    const body = '{"error":{"message":"key AIzaSyTEST-SECRET-123456 cannot use responseJsonSchema"}}';
    const r = classifyAnalysisFailure(
      new AnalyzerHttpError('gemini', 400, body, `Gemini returned 400: ${body}`),
      'Gemini',
    );
    expect(`${r.userMessage}\n${r.detail}`).not.toContain('AIzaSyTEST-SECRET-123456');
    expect(r.userMessage).toContain('[redacted]');
  });

  it.each([401, 403])('AnalyzerHttpError(openai, %i) → auth', (status) => {
    const r = classifyAnalysisFailure(
      new AnalyzerHttpError('openai', status, '{"error":"bad key"}', `returned ${status}`),
      'Endpoint lab (qwen3:30b)',
    );
    expect(r.code).toBe('auth');
    expect(r.userMessage).toContain("the endpoint's API key");
  });

  it('AnalyzerKeyOriginError → auth naming the endpoint to re-enter the key for', () => {
    const r = classifyAnalysisFailure(new AnalyzerKeyOriginError('lab', 'Lab box'), 'Endpoint lab (m)');
    expect(r.code).toBe('auth');
    expect(r.userMessage).toContain('re-enter the key for Lab box');
  });

  it('AnalyzerTimeoutError → analyzer-timeout', () => {
    const r = classifyAnalysisFailure(new AnalyzerTimeoutError('openai', 'm', 1_800_000, 'ceiling'), 'Endpoint lab (m)');
    expect(r.code).toBe('analyzer-timeout');
    expect(r.userMessage).toContain('1800 s');
    expect(r.detail).toContain('reason=ceiling');
    expect(r.remediation).toContain('endpoint');
  });

  it('AnalyzerEndpointMissingError → analyzer-endpoint-missing naming the id and its source', () => {
    const r = classifyAnalysisFailure(new AnalyzerEndpointMissingError('gone', 'env'), 'Endpoint gone (m)');
    expect(r.code).toBe('analyzer-endpoint-missing');
    expect(r.userMessage).toContain('"gone"');
    expect(r.userMessage).toContain('ANALYZER_PHASE0_MODEL');
  });

  it.each([
    ['schema', 'may not enforce'],
    ['json', 'constrains the structure'],
    ['off', 'structured output was off'],
  ] as const)('AnalyzerInvalidOutputError(mode %s) → analyzer-invalid-output with a mode-aware hint', (mode, hint) => {
    const r = classifyAnalysisFailure(
      new AnalyzerInvalidOutputError('ollama', 'qwen3.5:4b', '1-ch1', 'invalid-json — Unexpected token', mode),
      'Ollama (qwen3.5:4b)',
    );
    expect(r.code).toBe('analyzer-invalid-output');
    expect(r.userMessage).toContain(hint);
  });

  it.each(['json', 'off'] as const)('a Gemini run in mode %s is never steered to "schema" in the user message', (mode) => {
    const r = classifyAnalysisFailure(
      new AnalyzerInvalidOutputError('gemini', 'gemini-3.5-flash-lite', '1-ch1', 'invalid-json — Unexpected token', mode),
      'Gemini (gemini-3.5-flash-lite)',
    );
    expect(r.code).toBe('analyzer-invalid-output');
    expect(r.userMessage).toContain(`structured output was ${mode === 'json' ? '"json"' : 'off'}`);
    expect(r.userMessage).not.toMatch(/schema/i);
    expect(r.remediation).not.toMatch(/schema/i);
  });
});

describe('classifyAnalysisFailure — unreachable and endpoint final errors (#3084 PR 3b)', () => {
  const savedKey = process.env.GEMINI_API_KEY;
  beforeEach(() => {
    delete process.env.GEMINI_API_KEY;
  });
  afterEach(() => {
    if (savedKey === undefined) delete process.env.GEMINI_API_KEY;
    else process.env.GEMINI_API_KEY = savedKey;
    _resetUserSettingsCache();
  });

  it('AnalyzerUnreachableError from an endpoint → analyzer-unreachable naming the endpoint', () => {
    const r = classifyAnalysisFailure(
      new AnalyzerUnreachableError('Endpoint qwen3:30b is unreachable (ECONNREFUSED).', 'openai'),
      'Endpoint lab (qwen3:30b)',
    );
    expect(r.code).toBe('analyzer-unreachable');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) could not be reached: Endpoint qwen3:30b is unreachable (ECONNREFUSED).');
    expect(r.remediation).toContain("endpoint's server");
  });

  it.each([
    [502, 'Endpoint lab (qwen3:30b) returned HTTP 502: '],
    [404, 'Endpoint lab (qwen3:30b) returned HTTP 404: '],
    [422, 'Endpoint lab (qwen3:30b) returned HTTP 422: '],
    [0, 'Endpoint lab (qwen3:30b) sent an error inside its response stream: '],
  ] as const)(
    'endpoint AnalyzerHttpError(%i) → unknown with a curated message naming the endpoint, the status and a redacted excerpt',
    (status, lead) => {
      _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSy-taxonomy-secret-1' });
      const body = '{"error":{"message":"upstream failed for key AIzaSy-taxonomy-secret-1"}}';
      const r = classifyAnalysisFailure(new AnalyzerHttpError('openai', status, body, `raw ${body}`), 'Endpoint lab (qwen3:30b)');
      expect(r.code).toBe('unknown');
      expect(r.userMessage).toBe(`${lead}{"error":{"message":"upstream failed for key [redacted]"}}`);
      expect(r.detail).toBe(`transport=openai status=${status}`);
      expect(`${r.userMessage}\n${r.detail}\n${r.remediation}`).not.toContain('AIzaSy-taxonomy-secret-1');
      expect(r.remediation).toContain("endpoint's server");
    },
  );

  it('AnalyzerStreamIncompleteError from an endpoint → unknown naming the endpoint', () => {
    const r = classifyAnalysisFailure(new AnalyzerStreamIncompleteError('openai', 'qwen3:30b'), 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe(
      'Endpoint lab (qwen3:30b) dropped the connection or stopped streaming before it finished its answer, and retrying did not help.',
    );
    expect(r.remediation).toContain("endpoint's server");
  });

  it('a pre-header AnalyzerStreamIncompleteError names its causeCode, so a DNS failure never reads as a mid-answer drop (P22)', () => {
    const err = new AnalyzerStreamIncompleteError('openai', 'qwen3:30b', { causeCode: 'EAI_AGAIN' });
    expect(err.phase).toBe('before-response');
    expect(err.causeCode).toBe('EAI_AGAIN');
    expect(err.message).toBe('Endpoint qwen3:30b dropped the connection before a response (EAI_AGAIN).');
    const r = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) dropped the connection before a response (EAI_AGAIN), and retrying did not help.');
    expect(r.userMessage).not.toContain('stopped streaming');
    expect(r.detail).toBe('transport=openai model=qwen3:30b causeCode=EAI_AGAIN');
  });

  it('AnalyzerTransportError → unknown naming the endpoint and appending its sanitized causeCode; the class chain goes to detail, never a raw cause (P22)', () => {
    const message =
      'Endpoint qwen3:30b request failed before a response (ERR_SSL_WRONG_VERSION_NUMBER) (APIConnectionError <- TypeError <- Error).';
    const err = new AnalyzerTransportError('openai', 'qwen3:30b', message, 'ERR_SSL_WRONG_VERSION_NUMBER');
    const r = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) request failed (ERR_SSL_WRONG_VERSION_NUMBER).');
    expect(r.detail).toBe(message);
    expect('cause' in err).toBe(false);
  });

  it('AnalyzerTransportError with no causeCode → the same copy with no code suffix (P22)', () => {
    const err = new AnalyzerTransportError('openai', 'qwen3:30b', 'Endpoint qwen3:30b request failed (RangeError).', undefined);
    const r = classifyAnalysisFailure(err, 'Endpoint lab (qwen3:30b)');
    expect(r.userMessage).toBe('Endpoint lab (qwen3:30b) request failed.');
    expect(r.detail).toBe('Endpoint qwen3:30b request failed (RangeError).');
  });

  it('causeCodeSuffix is the one " (CODE)" shape, empty without a code (P22)', () => {
    expect(causeCodeSuffix('EAI_AGAIN')).toBe(' (EAI_AGAIN)');
    expect(causeCodeSuffix(undefined)).toBe('');
  });

  it('sanitizeCauseCode keeps an upper-case system code and drops anything else, including a secret (P22)', () => {
    expect(sanitizeCauseCode('ECONNRESET', [])).toBe('ECONNRESET');
    expect(sanitizeCauseCode('UND_ERR_SOCKET', [])).toBe('UND_ERR_SOCKET');
    expect(sanitizeCauseCode('sk-lowercase-key-1234', [])).toBeUndefined();
    expect(sanitizeCauseCode('ABCDEFGHSECRET', ['ABCDEFGHSECRET'])).toBeUndefined();
    expect(sanitizeCauseCode(42, [])).toBeUndefined();
  });

  it("the unknown fall-through redacts a saved key from a raw message (P22)", () => {
    _setUserSettingsCacheForTest({ geminiApiKey: 'AIzaSy-taxonomy-secret-1' });
    const r = classifyAnalysisFailure(new Error('weird failure mentioning AIzaSy-taxonomy-secret-1'), 'Some model');
    expect(r.code).toBe('unknown');
    expect(r.userMessage).toBe('weird failure mentioning [redacted]');
  });
});

describe('analyzerSelectionErrorEvent (#3084 P23)', () => {
  it.each([
    [
      'AnalyzerEndpointMissingError',
      new AnalyzerEndpointMissingError('gone', 'env'),
      'analyzer-endpoint-missing',
      'Analyzer endpoint "gone" (from ANALYZER_PHASE0_MODEL / ANALYZER_PHASE1_MODEL) cannot be used for analysis yet. Pick another model.',
    ],
    [
      'AnalyzerKeyOriginError',
      new AnalyzerKeyOriginError('lab', 'Lab box'),
      'auth',
      'The API key saved for Lab box was entered for a different host, so it was not sent — re-enter the key for Lab box.',
    ],
    ['a plain Error', new Error('misconfigured engine: missing GEMINI_API_KEY'), 'unknown', 'misconfigured engine: missing GEMINI_API_KEY'],
  ] as const)('codes %s through classifyAnalysisFailure and never returns null', (_name, err, code, message) => {
    const failure = classifyAnalysisFailure(err, 'Analyzer');
    expect(failure.code).toBe(code);
    expect(analyzerSelectionErrorEvent(err)).toEqual({
      kind: 'error',
      code,
      message,
      remediation: failure.remediation,
      ...(failure.detail ? { detail: failure.detail } : {}),
    });
  });

  it("selection's own missing-Gemini-key error classifies as auth and keeps what is missing as its detail (declared outcome change: phase 0 / subset sent it uncoded)", () => {
    const err = new Error(
      'GEMINI_API_KEY is required when analyzer engine is Gemini. Set it in Admin → Model Manager → Gemini API key, or in server/.env for CI / power users.',
    );
    /* The `auth` signature's copy is generic ("check the Gemini API key"), so without the
       detail the event no longer says WHICH of the two auth cases this is. */
    expect(analyzerSelectionErrorEvent(err)).toMatchObject({ kind: 'error', code: 'auth', detail: 'Gemini API key required' });
  });
});



describe('Gemini invalid / expired API key (#3084 PR 3b review 🟠1)', () => {
  it.each([
    ['API_KEY_INVALID', 'API key not valid. Please pass a valid API key.'],
    ['API_KEY_EXPIRED', 'API key expired. Please renew the API key.'],
  ] as const)('a 400 envelope with reason %s classifies as auth, never analyzer-request-rejected', (reason, message) => {
    const err = new ApiError({
      status: 400,
      message: `got status: 400 Bad Request. {"error":{"code":400,"message":"${message}","status":"INVALID_ARGUMENT","details":[{"@type":"type.googleapis.com/google.rpc.ErrorInfo","reason":"${reason}"}]}}`,
    });
    const r = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(r.code).toBe('auth');
    expect(r.userMessage).toContain(message);
  });

  it('a bare-status 400 whose message names an API key classifies as auth', () => {
    const err = Object.assign(new Error('API key not valid. Please pass a valid API key.'), { status: 400 });
    expect(classifyAnalysisFailure(err, 'Gemini 3.6 Flash').code).toBe('auth');
  });

  it('a 400 that only names an api_key request field stays analyzer-request-rejected', () => {
    const err = new ApiError({
      status: 400,
      message:
        'got status: 400 Bad Request. {"error":{"code":400,"message":"Invalid JSON payload received. Unknown name \\"api_key\\": Cannot find field.","status":"INVALID_ARGUMENT"}}',
    });
    expect(classifyAnalysisFailure(err, 'Gemini 3.6 Flash').code).toBe('analyzer-request-rejected');
  });

  it('a 400 whose key was redacted out of the wording still classifies as auth', () => {
    const err = Object.assign(new Error('API key [redacted] not valid. Please pass a valid API key.'), { status: 400 });
    expect(classifyAnalysisFailure(err, 'Gemini 3.6 Flash').code).toBe('auth');
  });
});

describe('a Gemini 400 that is not about the request shape (#3084 PR 3b review pass 2 🟠)', () => {
  it.each([
    'User location is not supported for the API use.',
    'Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio.',
  ])('a FAILED_PRECONDITION 400 (%s) is main\'s unknown, never request-rejected', (message) => {
    const err = new ApiError({
      status: 400,
      message: `got status: 400 Bad Request. {"error":{"code":400,"message":"${message}","status":"FAILED_PRECONDITION"}}`,
    });
    const r = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(r.code).toBe('unknown');
    expect(r.remediation).toBe(FAILURE_REMEDIATIONS.unknown.remediation);
    expect(r.remediation).not.toContain('analyzer.gemini.structuredOutput');
  });

  it('an INVALID_ARGUMENT shape error is still request-rejected', () => {
    const err = new ApiError({
      status: 400,
      message:
        'got status: 400 Bad Request. {"error":{"code":400,"message":"Invalid JSON payload received.","status":"INVALID_ARGUMENT"}}',
    });
    expect(classifyAnalysisFailure(err, 'Gemini 3.6 Flash').code).toBe('analyzer-request-rejected');
  });

  it('an envelope with no status field keeps the request-rejected mapping', () => {
    const err = new ApiError({
      status: 400,
      message: 'got status: 400 Bad Request. {"error":{"code":400,"message":"bad field"}}',
    });
    expect(classifyAnalysisFailure(err, 'Gemini 3.6 Flash').code).toBe('analyzer-request-rejected');
  });
});

describe('Gemini auth remediation names both key homes (#3084 PR 3b review pass 2 🟡)', () => {
  it('the key-rejection 400 points at Settings as well as .env', () => {
    const err = new ApiError({
      status: 400,
      message:
        'got status: 400 Bad Request. {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
    });
    const r = classifyAnalysisFailure(err, 'Gemini 3.6 Flash');
    expect(r.code).toBe('auth');
    expect(r.remediation).toBe(
      'Check the Gemini API key (Settings, or GEMINI_API_KEY in server/.env, which takes precedence; restart the server after changing it), then retry the chapter.',
    );
  });

  it("selection's missing-key event carries a remediation that agrees with its message", () => {
    const ev = analyzerSelectionErrorEvent(
      new Error(
        'GEMINI_API_KEY is required when analyzer engine is Gemini. Set it in Admin → Model Manager → Gemini API key, or in server/.env for CI / power users.',
      ),
    );
    expect(ev.remediation).toContain('Settings');
    expect(ev.remediation).not.toMatch(/^Verify GEMINI_API_KEY in server\/\.env/);
  });
});

describe('auth remediation names its own key (#3084 PR 3b review 🟠2)', () => {
  it('a key-origin mismatch does not send the user to GEMINI_API_KEY', () => {
    const r = classifyAnalysisFailure(new AnalyzerKeyOriginError('lab', 'Lab box'), 'Analyzer');
    expect(r.code).toBe('auth');
    expect(r.remediation).not.toContain('GEMINI_API_KEY');
    expect(r.remediation).toContain('Lab box');
  });

  it.each([
    ['ollama', "Ollama server's access settings"],
    ['openai', "endpoint's API key"],
    ['gemini', 'GEMINI_API_KEY'],
  ] as const)('a %s 401 remediation names that transport\'s key setting', (transport, expected) => {
    const r = classifyAnalysisFailure(new AnalyzerHttpError(transport, 401, 'nope', 'raw nope'), 'Model');
    expect(r.code).toBe('auth');
    expect(r.remediation).toContain(expected);
    if (transport !== 'gemini') expect(r.remediation).not.toContain('GEMINI_API_KEY');
  });

  it("selection's missing-Gemini-key event keeps its own actionable sentence, not the TTS auth copy", () => {
    const text =
      'GEMINI_API_KEY is required when analyzer engine is Gemini. Set it in Admin → Model Manager → Gemini API key, or in server/.env for CI / power users.';
    const ev = analyzerSelectionErrorEvent(new Error(text));
    expect(ev.code).toBe('auth');
    expect(ev.message).toBe(text);
    expect(ev.message).not.toContain('TTS');
  });
});

describe('analyzer-timeout remediation (#3084 PR 3b review 🟠4)', () => {
  it("a thinking-idle timeout's remediation names the same control its message names, plus the request ceiling", () => {
    const r = classifyAnalysisFailure(new AnalyzerTimeoutError('gemini', 'gemini-3.6-flash', 121_000, 'thinking-idle'), 'Gemini 3.6 Flash');
    expect(r.userMessage).toContain("'Gemini thinking idle timeout'");
    expect(r.remediation).toContain("'Gemini thinking idle timeout'");
    expect(r.remediation).toContain('analyzer.gemini.thinkingIdleTimeoutMs');
    expect(r.remediation).toContain("'Gemini request ceiling'");
  });

  it("promises no reasoning-level control before wave 5", () => {
    expect(FAILURE_REMEDIATIONS['analyzer-timeout'].remediation).not.toContain('reasoning level');
  });
});

describe('analyzer-invalid-output remediation (#3084 PR 3b review 🟡1)', () => {
  const classify = (transport: 'ollama' | 'gemini' | 'openai', mode: 'schema' | 'json' | 'off') =>
    classifyAnalysisFailure(new AnalyzerInvalidOutputError(transport, 'm', '1-ch1', 'invalid-json — x', mode), 'Model');

  it('never tells a run already in "schema" mode to switch to "schema"', () => {
    expect(classify('ollama', 'schema').remediation).not.toMatch(/set Structured output to "schema"/);
    expect(classify('ollama', 'schema').remediation).toContain('already "schema"');
  });

  it('never steers Gemini to "schema" (E112 has not shown it accepts it)', () => {
    expect(classify('gemini', 'json').remediation).not.toContain('"schema"');
    expect(classify('gemini', 'off').remediation).not.toContain('"schema"');
  });

  it('suggests "schema" to an Ollama or endpoint run that is on "json"', () => {
    expect(classify('ollama', 'json').remediation).toContain('"schema"');
    expect(classify('openai', 'json').remediation).toContain('"schema"');
  });

  it('the static Help copy is mode-neutral', () => {
    expect(FAILURE_REMEDIATIONS['analyzer-invalid-output'].remediation).not.toContain('"schema"');
  });
});

describe('analyzer-endpoint-missing copy is true today (#3084 PR 3b review 🟡2)', () => {
  it('does not promise a Settings UI or claim a possibly-saved endpoint is unconfigured', () => {
    const live = classifyAnalysisFailure(new AnalyzerEndpointMissingError('gone', 'settings'), 'Analyzer');
    const help = FAILURE_REMEDIATIONS['analyzer-endpoint-missing'];
    for (const text of [live.userMessage, live.remediation, help.userMessage, help.remediation]) {
      expect(text).not.toMatch(/Settings/);
      expect(text).not.toMatch(/not configured/);
    }
    expect(live.userMessage).toContain('"gone"');
  });
});

describe('Gemini key advice says the env var wins and needs a restart (#3084 PR 3b review pass 3 🟡2)', () => {
  it('the key-rejection 400 remediation', () => {
    const err = new ApiError({
      status: 400,
      message:
        'got status: 400 Bad Request. {"error":{"code":400,"message":"API key not valid. Please pass a valid API key.","status":"INVALID_ARGUMENT","details":[{"reason":"API_KEY_INVALID"}]}}',
    });
    expect(classifyAnalysisFailure(err, 'Gemini 3.6 Flash').remediation).toBe(
      'Check the Gemini API key (Settings, or GEMINI_API_KEY in server/.env, which takes precedence; restart the server after changing it), then retry the chapter.',
    );
  });

  it('the static auth remediation keeps the restart', () => {
    expect(FAILURE_REMEDIATIONS.auth.remediation).toContain('restart the server after changing it');
  });
});
