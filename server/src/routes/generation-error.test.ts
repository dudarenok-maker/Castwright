/* Pure unit tests for the synthesis-error classifier + cascade detector.

   These run without any TTS provider, file system, or Express handler —
   the function is a pure mapping from error → { errorReason, fatal }, and
   the cascade detector is a tiny state machine. Pinning the XTTS tensor
   pattern here so a future refactor can't silently regress the visible
   failure from screenshot 2026-05-13 181647 ("index out of range in self"
   cascading across every chapter). */

import { describe, it, expect } from 'vitest';
import { describeSynthesisError, newCascadeState, recordNonFatal } from './generation-error.js';

describe('describeSynthesisError', () => {
  it('flags sidecar-down (ECONNREFUSED) as fatal', () => {
    const out = describeSynthesisError(
      new Error('fetch failed: connect ECONNREFUSED 127.0.0.1:9000'),
    );
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/sidecar not running/i);
  });

  it('flags sidecar-down ("not reachable" text) as fatal', () => {
    const out = describeSynthesisError(
      new Error('Local TTS sidecar not reachable at http://localhost:9000.'),
    );
    expect(out.fatal).toBe(true);
  });

  it('flags 429 quota as fatal', () => {
    const err = Object.assign(new Error('Rate limit hit'), { status: 429 });
    const out = describeSynthesisError(err);
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/rate-limited/i);
  });

  it('a real 429 is still Gemini-rate-limited even when the engine is local', () => {
    /* A genuine HTTP 429 only comes from the metered cloud engine, so the
       Gemini wording is correct regardless of the run's primary engine. */
    const err = Object.assign(new Error('Too Many Requests'), { status: 429 });
    const out = describeSynthesisError(err, 'qwen');
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/gemini tts rate-limited/i);
  });

  it('does NOT classify a local synth timeout as a Gemini rate-limit (the "degenerate" substring bug)', () => {
    /* 2026-05-31 the Hollow Tide The Drowning Bell CH24: a local Qwen batch blew the 600s
       per-call ceiling and threw ChapterSynthTimeoutError. Its message contains
       "runaway/degenerate input" — and the OLD /rate/i quota regex matched the
       "rate" inside "dege·nerate", so the local timeout was reported as
       "Gemini TTS rate-limited" AND escalated to fatal, stopping the whole book.
       It must be NON-fatal (skip & advance) and never mention Gemini. */
    const timeoutErr = Object.assign(
      new Error(
        'TTS batch call exceeded 600s with no result — likely runaway/degenerate input. ' +
          'Skipping this chapter so the queue can advance.',
      ),
      { name: 'ChapterSynthTimeoutError' },
    );
    const out = describeSynthesisError(timeoutErr, 'qwen');
    expect(out.fatal).toBe(false);
    expect(out.errorReason).not.toMatch(/gemini/i);
    expect(out.errorReason).not.toMatch(/rate-limited/i);
    expect(out.errorReason).toMatch(/timed out/i);
  });

  it('does not blame Gemini for a rate-limit-shaped message on a local engine', () => {
    /* Defense-in-depth: even if a local engine somehow emits a "rate limit"
       phrase (no HTTP 429), don't pin it on Gemini — surface it non-fatally. */
    const err = new Error('Local TTS sidecar returned 503: {"detail":"rate limit exceeded"}');
    const out = describeSynthesisError(err, 'qwen');
    expect(out.fatal).toBe(false);
    expect(out.errorReason).not.toMatch(/gemini/i);
  });

  it('still flags a real Gemini quota message (engine=gemini) as fatal', () => {
    const err = new Error('RESOURCE_EXHAUSTED: Quota exceeded for the current project');
    const out = describeSynthesisError(err, 'gemini');
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/gemini tts rate-limited/i);
  });

  it('treats the word "generated" in an unmapped error as non-fatal, not a rate-limit', () => {
    /* "generated" also contains the substring "rate" — guard the same class. */
    const out = describeSynthesisError(new Error('Audio could not be generated for this segment'));
    expect(out.fatal).toBe(false);
    expect(out.errorReason).not.toMatch(/rate-limited/i);
  });

  it('flags 401/403 auth as fatal', () => {
    const err = Object.assign(new Error('forbidden'), { status: 403 });
    const out = describeSynthesisError(err);
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/authentication/i);
  });

  it('flags XTTS "index out of range in self" as fatal with a catalog-out-of-sync message', () => {
    /* This is the actual error from the screenshot — a PyTorch tensor index
       error inside Coqui XTTS when the substituted speaker passes manifest
       validation but the model's internal embedding lookup fails. It's
       deterministic across chapters, so retrying just burns the queue. */
    const out = describeSynthesisError(
      new Error('Local TTS sidecar returned 500: {"detail":"index out of range in self"}'),
    );
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/voice catalog is out of sync/i);
  });

  it('flags PyTorch IndexError text as fatal', () => {
    const out = describeSynthesisError(
      new Error('IndexError: tensors used as indices must be long, int, byte or bool'),
    );
    expect(out.fatal).toBe(true);
  });

  it('flags CUDA device-side assert as fatal with an auto-restart message', () => {
    /* The actual failure mode the screenshot pinned: the sidecar's GPT
       decoder hit an out-of-bounds embedding lookup, the CUDA context is
       now corrupted for the rest of the process, only a fresh Python
       process recovers — start.ps1's supervisor loop catches the
       sidecar's poison-code exit and respawns it. Classifying as fatal
       guarantees the user gets a single banner instead of the cascade
       detector burning two chapters' worth of identical 500s before it
       bails on its own. */
    const out = describeSynthesisError(
      new Error(
        'Local TTS sidecar returned 500: {"detail":"CUDA error: device-side assert triggered\\nCUDA kernel errors might be asynchronously reported…"}',
      ),
    );
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/auto-restart/i);
    expect(out.errorReason).toMatch(/retry/i);
    expect(out.errorReason).toMatch(/cuda/i);
  });

  it('flags the structured 503 poison-fence payload as fatal too', () => {
    /* After the first device-side assert, the sidecar self-flags as
       poisoned and every subsequent /synthesize call returns 503 with
       `"poisoned": true` in the body. The classifier must catch that
       shape too so the second chapter doesn't get misread as a different
       (non-fatal) class of failure. */
    const out = describeSynthesisError(
      new Error(
        'Local TTS sidecar returned 503: {"detail":"TTS sidecar is in a poisoned CUDA state…","poisoned":true}',
      ),
    );
    expect(out.fatal).toBe(true);
    expect(out.errorReason).toMatch(/auto-restart/i);
  });

  it('returns the raw message as non-fatal for unknown errors', () => {
    const out = describeSynthesisError(new Error('Something unexpected and unmapped happened'));
    expect(out.fatal).toBe(false);
    expect(out.errorReason).toBe('Something unexpected and unmapped happened');
  });

  it('truncates long unknown messages to 240 chars + ellipsis', () => {
    const long = 'x'.repeat(500);
    const out = describeSynthesisError(new Error(long));
    expect(out.fatal).toBe(false);
    expect(out.errorReason.length).toBeLessThanOrEqual(241);
    expect(out.errorReason.endsWith('…')).toBe(true);
  });
});

describe('cascade detector — recordNonFatal', () => {
  it('does not trip on a single non-fatal failure', () => {
    const state = newCascadeState();
    const out = recordNonFatal(state, 'transient blip');
    expect(out.fatal).toBe(false);
  });

  it('trips on the second identical non-fatal failure', () => {
    /* The whole point: stop the cascade visible in the screenshot where
       chapters 1, 2, 1 retried, all failed with the same string. */
    const state = newCascadeState();
    expect(recordNonFatal(state, 'same reason').fatal).toBe(false);
    expect(recordNonFatal(state, 'same reason').fatal).toBe(true);
  });

  it('resets the counter when the reason changes', () => {
    const state = newCascadeState();
    expect(recordNonFatal(state, 'reason A').fatal).toBe(false);
    expect(recordNonFatal(state, 'reason B').fatal).toBe(false);
    expect(recordNonFatal(state, 'reason A').fatal).toBe(false);
  });

  it('keeps tripping after escalation if the same reason continues', () => {
    /* Idempotent: once tripped, every further occurrence of the same reason
       stays fatal. Lets the caller break out of its loop on the boolean
       without separate "already escalated" bookkeeping. */
    const state = newCascadeState();
    recordNonFatal(state, 'same');
    expect(recordNonFatal(state, 'same').fatal).toBe(true);
    expect(recordNonFatal(state, 'same').fatal).toBe(true);
  });
});
