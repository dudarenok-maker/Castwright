import { describe, it, expect, vi, afterEach } from 'vitest';

/* #4066 — `seq` restarts at 1 with every Node process, so the notice carries a
   per-process `bootId` the frontend compares alongside it. */

describe('tts-auto-free-notice', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
  });

  it('stamps every event of one process with the same bootId', async () => {
    const { recordTtsAutoFree, getLastTtsAutoFree } = await import('./tts-auto-free-notice.js');
    recordTtsAutoFree(['Qwen 0.6B'], 'voice design');
    const first = getLastTtsAutoFree()!;
    recordTtsAutoFree(['Kokoro'], 'Quality render');
    const second = getLastTtsAutoFree()!;
    expect(second.bootId).toBe(first.bootId);
    expect(second.seq).toBe(first.seq + 1);
  });

  it('a restarted process (fresh module) gets a different bootId even though seq starts at 1 again', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-09T10:00:00Z'));
    const a = await import('./tts-auto-free-notice.js');
    a.recordTtsAutoFree(['Qwen 0.6B'], 'voice design');
    const before = a.getLastTtsAutoFree()!;

    vi.resetModules();
    vi.setSystemTime(new Date('2026-11-09T10:05:00Z'));
    const b = await import('./tts-auto-free-notice.js');
    b.recordTtsAutoFree(['Qwen 0.6B'], 'voice design');
    const after = b.getLastTtsAutoFree()!;

    expect(after.seq).toBe(before.seq);
    expect(after.bootId).not.toBe(before.bootId);
  });

  it('records nothing for an empty model list', async () => {
    const { recordTtsAutoFree, getLastTtsAutoFree } = await import('./tts-auto-free-notice.js');
    recordTtsAutoFree([], 'voice design');
    expect(getLastTtsAutoFree()).toBeNull();
  });
});
