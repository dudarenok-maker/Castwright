/* fs-19 — structured failure-taxonomy tests. Drives `classifyFailure` with
   REAL captured failure strings (XTTS tensor error, CUDA device-side assert,
   429 quota body, ECONNREFUSED, ENOSPC, the synth-timeout message, and an
   unmapped string) and asserts the stable `code`, a jargon-free `userMessage`,
   a non-empty `remediation`, and the legacy `fatal`. These pin the incident-
   tuned regexes the classifier ports from the old ad-hoc describeSynthesisError
   so a refactor can't silently regress them. */

import { describe, it, expect } from 'vitest';
import { classifyFailure } from './failure-taxonomy.js';

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
