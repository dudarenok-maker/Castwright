/* Real-network regression lock for the analyzer client — the SAME defect
 * plan 137 fixed for the TTS sidecar (`sidecar-timeout.test.ts`), which was
 * never fixed for Ollama.
 *
 * Background: Ollama's /api/chat withholds response headers until the FIRST
 * generated token, so the whole prompt-prefill counts against undici's
 * default 300 s `headersTimeout`. On a large chapter section against a
 * split-GPU model, prefill exceeds that — the request dies at ~302 s with a
 * bare `TypeError: fetch failed`.
 *
 * The harm is not the failure, it is the MISCLASSIFICATION: classifyConnectError
 * reads that TypeError as LocalUnreachableError, which is the *only* condition
 * that trips the FallbackAnalyzer to Gemini. So a slow-but-perfectly-healthy
 * local daemon silently reroutes analysis to the cloud — exactly what the
 * module header says must never happen. Observed 2026-08-12: chapters 1 and 3
 * of a 103k-word book both failed cast detection at 302 s.
 *
 * These tests stand up a real local HTTP server that DELAYS its response
 * headers, exercising the mechanism in milliseconds rather than 300 s.
 * (No `vi.mock('undici')` here — we need the real client.)
 */

import { describe, it, expect, afterEach, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import { rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Agent } from 'undici';
import {
  OllamaAnalyzer,
  LocalUnreachableError,
  generatePersonaViaOllama,
} from './ollama.js';

/* protocol.ts resolves the handoff dirs relative to its own __dirname
   (server/src/handoff/), so HANDOFF_ROOT is server/handoff/. */
const HANDOFF_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'handoff');
const HANDOFF_IDS = ['m_ollama_timeout_control', 'm_ollama_timeout_fix', 'm_ollama_timeout_abort'];

/* A valid stage-1 chapter response, same shape as ollama.test.ts's. */
const VALID_RESPONSE = JSON.stringify({
  characters: [
    {
      id: 'narrator',
      name: 'Narrator',
      role: 'narrator',
      color: 'narrator',
      evidence: [{ quote: 'a' }, { quote: 'bb' }, { quote: 'ccc' }],
    },
  ],
});

let server: Server | undefined;

/* Hold the response open for `delayMs` — sending NO headers, which is what
   Ollama does during prefill — then stream the NDJSON body. The `close`
   guard clears the timer if the socket is torn down first (client timeout or
   abort), so an abandoned timer never writes to a destroyed socket. */
function startSlowOllama(delayMs: number): Promise<string> {
  server = createServer((_req, res) => {
    const t = setTimeout(() => {
      if (res.destroyed) return;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(
        JSON.stringify({ message: { role: 'assistant', content: VALID_RESPONSE }, done: false }) +
          '\n',
      );
      res.end(
        JSON.stringify({ message: { role: 'assistant', content: '' }, done: true }) + '\n',
      );
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

beforeAll(() => {
  process.env.CASTWRIGHT_VRAM_SAMPLE = '0';
});
afterAll(async () => {
  delete process.env.CASTWRIGHT_VRAM_SAMPLE;
  /* Same courtesy as ollama.test.ts — don't leave prompt traces behind in the
     (git-ignored, but shared) handoff dirs. */
  await Promise.all(
    HANDOFF_IDS.flatMap((id) => [
      rm(resolve(HANDOFF_ROOT, 'inbox', `${id}-stage1-ch1.md`), { force: true }),
      rm(resolve(HANDOFF_ROOT, 'outbox', `${id}-stage1-ch1.json`), { force: true }),
    ]),
  );
});

afterEach(async () => {
  if (server) {
    /* Drop keep-alive sockets first: the FIX and ABORT cases run through the
       module-singleton ANALYZER_DISPATCHER, whose pooled socket would
       otherwise hold `close()` open for undici's keepAliveTimeout (~4s) on
       every test. */
    server.closeAllConnections();
    await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  }
});

describe('OllamaAnalyzer fetch timeout', () => {
  it('CONTROL: a short headersTimeout aborts a slow-prefill call AND is misreported as LocalUnreachableError', async () => {
    const url = await startSlowOllama(2000);
    const shortAgent = new Agent({ headersTimeout: 200, bodyTimeout: 200 });
    const analyzer = new OllamaAnalyzer({
      url,
      model: 'qwen3.5:9b',
      dispatcher: shortAgent,
    });

    try {
      const err = await analyzer.runStage1Chapter('m_ollama_timeout_control', 1, '# p', {}).then(
        () => null,
        (e) => e,
      );

      /* This is the whole point of the fix: a healthy-but-slow daemon is
         reported as UNREACHABLE, and LocalUnreachableError is the sole trigger
         that reroutes analysis to Gemini. */
      expect(err).toBeInstanceOf(LocalUnreachableError);
    } finally {
      /* In a finally so a failing assertion above doesn't leak the Agent. */
      await shortAgent.close();
    }
  });

  it('FIX: the analyzer tolerates a slow-prefill daemon (no timeout abort, no bogus unreachable)', async () => {
    const url = await startSlowOllama(300);
    /* Uses the module-level ANALYZER_DISPATCHER (headers/body timeout 0). A
       regression to a finite headersTimeout turns this back into the CONTROL
       above — a false "Ollama is unreachable" and a silent cloud fallback. */
    const analyzer = new OllamaAnalyzer({ url, model: 'qwen3.5:9b' });

    const result = await analyzer.runStage1Chapter('m_ollama_timeout_fix', 1, '# p', {});

    expect(result.characters.map((c) => c.id)).toContain('narrator');
  });

  it('REGRESSION: generatePersonaViaOllama stays bounded — the dispatcher must not make it hang forever', async () => {
    /* This call site passes NO caller signal (voice-style.ts hands it only
       { onCpu, keepAlive }), so undici's hidden 300s cap was the ONLY thing
       stopping it. ANALYZER_DISPATCHER removes that, and the analyzer slot it
       holds is released only in a `finally` AFTER the await — so an unbounded
       hang leaks a token from a bounded semaphore and silently blocks every
       later analyzer call. PERSONA_ABSOLUTE_MAX_MS is the replacement bound;
       absoluteMaxMs proves it FIRES without waiting out ten minutes.

       OLLAMA_URL is pointed at the local slow server: generatePersonaViaOllama
       resolves its own URL, and without this the call would go to the real
       daemon on :11434. */
    const url = await startSlowOllama(5_000);
    const prevUrl = process.env.OLLAMA_URL;
    process.env.OLLAMA_URL = url;
    try {
      const err = await generatePersonaViaOllama('PROMPT', 'qwen3.5:9b', {
        onCpu: true,
        absoluteMaxMs: 250,
      }).then(
        () => null,
        (e: Error) => e,
      );

      expect(err, 'the call must terminate, not hang').not.toBeNull();
      /* Terminated by the budget, NOT by undici inventing a failure — and
         crucially not swallowed into LocalUnreachableError, which would
         reroute a healthy local daemon to the cloud. */
      expect(err).not.toBeInstanceOf(LocalUnreachableError);
    } finally {
      if (prevUrl === undefined) delete process.env.OLLAMA_URL;
      else process.env.OLLAMA_URL = prevUrl;
    }
  });

  it('still honours a caller AbortSignal (cancellation is not disabled)', async () => {
    const url = await startSlowOllama(2000);
    const analyzer = new OllamaAnalyzer({ url, model: 'qwen3.5:9b' });
    const ac = new AbortController();
    /* Abort before the header delay elapses — with the timeout now unbounded,
       the caller's signal is the only thing that can stop this call, so it
       must still work. */
    setTimeout(() => ac.abort(), 50);

    const err = await analyzer
      .runStage1Chapter('m_ollama_timeout_abort', 1, '# p', { signal: ac.signal })
      .then(
        () => null,
        (e) => e,
      );

    /* Must NOT be LocalUnreachableError — a client-driven stop is not a
       reason to fail over to the cloud. */
    expect(err).not.toBeInstanceOf(LocalUnreachableError);
    expect((err as Error | null)?.name).toMatch(/Abort/i);
  });
});
