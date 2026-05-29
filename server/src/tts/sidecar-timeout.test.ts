/* Real-network regression lock for plan 137 — the sidecar fetch must NOT
 * abort a legitimately slow-but-alive synth.
 *
 * Background: a wide Qwen batch (plan 136) can take >5 min of GPU decode, and
 * the sidecar is non-streaming — it holds the connection open computing the
 * whole batch before sending any response headers. Node's global fetch
 * inherits undici's default 300 s `headersTimeout`, which aborted those long
 * batches → "fetch failed" → the provider's transient "not reachable" → the
 * retry wrapper re-synthesised the same batch → loop → fatal "sidecar not
 * running" while the sidecar kept producing orphaned audio. The fix points the
 * provider at undici's own `fetch` with an `Agent` whose headers/body timeouts
 * are disabled (0); cancellation stays caller-driven via AbortSignal.
 *
 * These tests stand up a real local HTTP server that DELAYS its response
 * headers, exercising the timeout mechanism in milliseconds rather than the
 * 300 s default. (No `vi.mock('undici')` here — we need the real client.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { fetch as undiciFetch, Agent } from 'undici';
import { SidecarTtsProvider } from './sidecar.js';

/* A tiny valid PCM body + the headers `synthesize` expects, sent AFTER a
   per-server delay so the time-to-first-byte exceeds a short headersTimeout. */
const PCM = Buffer.from([0x00, 0x10, 0x20, 0x30]);

let server: Server | undefined;

/* Hold the response open for `delayMs`, then send headers + PCM. The
   `close`-guard clears the timer if the socket is torn down first (client
   timeout/abort or server.close), so an abandoned timer never writes to a
   destroyed socket and crashes the run. */
function startSlowServer(delayMs: number): Promise<string> {
  server = createServer((_req, res) => {
    const t = setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, {
        'content-type': 'audio/L16;codec=pcm;rate=24000',
        'x-sample-rate': '24000',
      });
      res.end(PCM);
    }, delayMs);
    res.on('close', () => clearTimeout(t));
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve(`http://127.0.0.1:${port}`);
    });
  });
}

afterEach(async () => {
  if (server) {
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('SidecarTtsProvider fetch timeout (plan 137)', () => {
  it('CONTROL: a short headersTimeout aborts a slow-header response (the failure mode the 300 s default caused)', async () => {
    const url = await startSlowServer(2000);
    const shortAgent = new Agent({ headersTimeout: 200, bodyTimeout: 200 });

    const err = await undiciFetch(`${url}/synthesize`, {
      method: 'POST',
      body: '{}',
      headers: { 'content-type': 'application/json' },
      dispatcher: shortAgent,
    }).then(
      () => null,
      (e) => e,
    );

    /* undici surfaces this as a TypeError("fetch failed") whose `.cause` is the
       HeadersTimeoutError (code UND_ERR_HEADERS_TIMEOUT) — the provider would
       wrap that as the transient "not reachable" error and the retry wrapper
       would loop on it. */
    expect(err).toBeInstanceOf(Error);
    const e = err as Error & { cause?: { code?: string; message?: string } };
    expect(`${e.message} ${e.cause?.code ?? ''} ${e.cause?.message ?? ''}`).toMatch(/timeout/i);
    await shortAgent.close();
  });

  it('FIX: the provider tolerates a slow-but-alive sidecar (no timeout abort)', async () => {
    const url = await startSlowServer(300);
    const provider = new SidecarTtsProvider({ url, engine: 'qwen' });

    /* Uses the module-level SIDECAR_DISPATCHER (headers/body timeout 0). The
       same kind of slow response that tripped the CONTROL's short timeout now
       resolves cleanly — a regression to a finite timeout on the dispatcher
       would make this hang-then-fail instead. */
    const result = await provider.synthesize({
      text: 'hello',
      voiceName: 'qwen-narrator',
      modelKey: 'qwen3-tts-0.6b',
    });

    expect(result.pcm.equals(PCM)).toBe(true);
    expect(result.sampleRate).toBe(24000);
  });

  it('still honours a caller AbortSignal (cancellation is not disabled)', async () => {
    const url = await startSlowServer(2000);
    const provider = new SidecarTtsProvider({ url, engine: 'qwen' });
    const ac = new AbortController();
    /* Abort BEFORE the server's header delay elapses — the request must cancel
       promptly rather than wait out the (now-unbounded) timeout. */
    setTimeout(() => ac.abort(), 50);

    const err = await provider
      .synthesize({
        text: 'hello',
        voiceName: 'qwen-narrator',
        modelKey: 'qwen3-tts-0.6b',
        signal: ac.signal,
      })
      .then(
        () => null,
        (e) => e,
      );

    /* The provider re-throws AbortError unchanged (not the transient
       "not reachable"), so a caller-driven stop still works. */
    expect((err as Error | null)?.name).toBe('AbortError');
  });
});
