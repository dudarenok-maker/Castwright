import { describe, it, expect, vi } from 'vitest';
import { withCapacityRetry, getCapacityWaiterCount, parseNoCapacity } from './capacity-retry.js';
import { NoCapacityError } from '../tts/tts-errors.js';

/* Free-function contract for the reusable no-capacity retry helper (Task 5,
   #1720). Unlike the old SidecarTtsProvider.postWithCapacityRetry, this
   RETURNS any non-`noCapacity` response (ok or failure) — the caller applies
   its own error handling. It only throws NoCapacityError after maxAttempts,
   or an abort rejection. */

function noCapacityResponse(neededMb: number, deviceKey: string): Response {
  return new Response(JSON.stringify({ noCapacity: true, neededMb, deviceKey }), {
    status: 503,
    statusText: 'Service Unavailable',
    headers: { 'content-type': 'application/json' },
  });
}

function okResponse(): Response {
  return new Response(Buffer.from([0x01, 0x02]), {
    status: 200,
    headers: { 'content-type': 'audio/L16;codec=pcm;rate=24000' },
  });
}

function fakeDevices(deviceKey: string, freeMb: number) {
  const [kind, indexStr] = deviceKey.split(':');
  return [
    {
      kind: kind as 'cuda' | 'rocm' | 'mps' | 'cpu',
      index: Number(indexStr),
      label: deviceKey,
      totalMb: 8_000,
      freeMb,
    },
  ];
}

describe('withCapacityRetry', () => {
  it('(a) first doPost returns ok → returned as-is, capacityProbe.read NOT called', async () => {
    const ok = okResponse();
    const doPost = vi.fn(async () => ok);
    const capacityProbeRead = vi.fn();

    const result = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: capacityProbeRead },
    });

    expect(result).toBe(ok);
    expect(doPost).toHaveBeenCalledTimes(1);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });

  it('(b) noCapacity 503 + eviction would help + analysis idle → evicts once, retries, succeeds', async () => {
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });
    const evictOllama = vi.fn(async () => {});
    const analyzerEvictWouldHelp = vi.fn(async () => true);

    const result = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama,
      analyzerEvictWouldHelp,
      isAnalysisInFlight: () => false,
      pollMs: 1,
      maxAttempts: 5,
    });

    expect(calls).toBe(2);
    expect(evictOllama).toHaveBeenCalledTimes(1);
    expect(analyzerEvictWouldHelp).toHaveBeenCalledWith(2_000, 500);
    expect(result.ok).toBe(true);
  });

  it('(c) persistent noCapacity → throws NoCapacityError after maxAttempts', async () => {
    const doPost = vi.fn(async () => noCapacityResponse(4_000, 'cuda:0'));

    const err = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 100) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: async () => false,
      isAnalysisInFlight: () => false,
      pollMs: 0,
      maxAttempts: 3,
    }).then(
      () => null,
      (e) => e,
    );

    expect(err).toBeInstanceOf(NoCapacityError);
    expect(err.engine).toBe('qwen');
    expect(err.neededMb).toBe(4_000);
    expect(err.deviceKey).toBe('cuda:0');
    expect(doPost).toHaveBeenCalledTimes(3);
    expect(getCapacityWaiterCount()).toBe(0);
  });

  it('(d) CONTRACT: a 503 that is NOT noCapacity is returned, not thrown', async () => {
    const body = new Response(JSON.stringify({ detail: 'base17-unavailable' }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    });
    const doPost = vi.fn(async () => body);
    const capacityProbeRead = vi.fn();

    const result = await withCapacityRetry(doPost, {
      engine: 'qwen',
      capacityProbe: { read: capacityProbeRead },
    });

    expect(result).toBe(body);
    expect(result.status).toBe(503);
    expect(doPost).toHaveBeenCalledTimes(1);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });

  it('(e) a 500 response is returned, not thrown', async () => {
    const body = new Response('internal error', { status: 500 });
    const doPost = vi.fn(async () => body);
    const capacityProbeRead = vi.fn();

    const result = await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: capacityProbeRead },
    });

    expect(result).toBe(body);
    expect(result.status).toBe(500);
    expect(capacityProbeRead).not.toHaveBeenCalled();
  });

  it('(f) getCapacityWaiterCount() reflects a parked waiter while polling, back to 0 after', async () => {
    expect(getCapacityWaiterCount()).toBe(0);
    let calls = 0;
    const doPost = vi.fn(async () => {
      calls += 1;
      if (calls === 2) {
        // The retry after the poll wait — the waiter count should already be up.
        expect(getCapacityWaiterCount()).toBe(1);
      }
      return calls === 1 ? noCapacityResponse(2_000, 'cuda:0') : okResponse();
    });

    await withCapacityRetry(doPost, {
      engine: 'coqui',
      capacityProbe: { read: async () => fakeDevices('cuda:0', 500) },
      evictOllama: vi.fn(async () => {}),
      analyzerEvictWouldHelp: async () => false, // force the poll wait, no eviction
      isAnalysisInFlight: () => false,
      pollMs: 1,
      maxAttempts: 5,
    });

    expect(calls).toBe(2);
    expect(getCapacityWaiterCount()).toBe(0);
  });
});

describe('parseNoCapacity', () => {
  it('returns the parsed shape for a 503 noCapacity body', async () => {
    const parsed = await parseNoCapacity(noCapacityResponse(1_234, 'cuda:1'));
    expect(parsed).toEqual({ neededMb: 1_234, deviceKey: 'cuda:1' });
  });

  it('returns null for a non-503 status', async () => {
    expect(await parseNoCapacity(okResponse())).toBeNull();
  });

  it('returns null for a 503 that is not a noCapacity shape', async () => {
    const r = new Response(JSON.stringify({ detail: 'nope' }), { status: 503 });
    expect(await parseNoCapacity(r)).toBeNull();
  });
});
