/* #3084 W4 — an endpoint persona (PERSONA_GEN_ENGINE=openai:lab::qwen3) runs through OpenAITransport for
   real: limiter keyed by the model id, the endpoint's concurrency, W3d's per-call busy registration for a
   GPU endpoint, the served-model record, and the key sent only under a matching origin. The server also
   answers the served-models listing prepare() sends. Real http.createServer on 127.0.0.1:0. */
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { createServer, type Server, type IncomingHttpHeaders } from 'node:http';
import { _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';
import type { AnalyzerEndpoint } from '../workspace/analyzer-endpoints.js';
import { isEndpointBusy } from './analyzer-concurrency.js';
import { servedModels, _resetEndpointRuntimeForTest } from './transports/endpoint-runtime.js';
import { analyzerRateLimiter } from './rate-limit.js';
import { endpointModelId } from './model-id.js';
import { AnalysisAbortedError } from './errors.js';
import { generateVoiceStylePersona } from './voice-style.js';
import type { CastCharacter } from '../tts/synthesise-chapter.js';

let server: Server | undefined;
let active = 0;
let peak = 0;
let listings = 0;
const seen: Array<{ headers: IncomingHttpHeaders; busyDuringCall: boolean }> = [];

function startHeldServer(holdMs: number): Promise<string> {
  server = createServer((req, res) => {
    if (req.method === 'GET') {
      /* #3084 P15 — runFreeText awaits OpenAITransport.prepare(), which lists the served models. */
      listings += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
      return;
    }
    active += 1;
    peak = Math.max(peak, active);
    req.resume();
    req.on('end', () => {
      seen.push({ headers: req.headers, busyDuringCall: isEndpointBusy('lab') });
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = (delta: object, finish: string | null) =>
          `data: ${JSON.stringify({ id: 'c', object: 'chat.completion.chunk', created: 0, model: 'qwen3', choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
        res.write(chunk({ role: 'assistant', content: 'A calm, low voice.' }, null));
        res.write(chunk({}, 'stop'));
        res.end('data: [DONE]\n\n');
        active -= 1;
      }, holdMs);
    });
  });
  return new Promise((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const a = server!.address();
      resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`);
    });
  });
}

function endpoint(baseUrl: string, over: Partial<AnalyzerEndpoint> = {}): AnalyzerEndpoint {
  return {
    id: 'lab', name: 'Lab', baseUrl, gpu: 'any', concurrency: 1, requestCeilingMs: 1_800_000,
    structuredOutput: 'schema', reasoningStyle: 'not_controllable', reasoning: 'model-default',
    maxOutputTokens: 0, contextTokens: 32768, ...over,
  };
}

const CHAR = { id: 'miner', name: 'Old Tom' } as CastCharacter;

beforeEach(() => {
  process.env.PERSONA_GEN_ENGINE = 'openai:lab::qwen3';
  analyzerRateLimiter._reset();
  active = 0;
  peak = 0;
  listings = 0;
  seen.length = 0;
  _resetEndpointRuntimeForTest();
});

afterEach(async () => {
  delete process.env.PERSONA_GEN_ENGINE;
  _resetUserSettingsCache();
  vi.restoreAllMocks();
  if (server) {
    server.closeAllConnections();
    await new Promise<void>((r) => server!.close(() => r()));
    server = undefined;
  }
});

describe('endpoint persona wiring', () => {
  it('sends the key under a matching origin, registers the call busy (gpu any), records the served model and keys the limiter by model id', async () => {
    const baseUrl = await startHeldServer(50);
    _setUserSettingsCacheForTest({
      analyzerEndpoints: [endpoint(baseUrl)],
      analyzerEndpointKeys: { lab: { origin: new URL(baseUrl).origin, key: 'sk-test' } },
    });
    const acquire = vi.spyOn(analyzerRateLimiter, 'acquire');
    await expect(generateVoiceStylePersona(CHAR)).resolves.toBe('A calm, low voice.');
    expect(seen[0].headers.authorization).toBe('Bearer sk-test');
    expect(seen[0].busyDuringCall).toBe(true);
    expect(isEndpointBusy('lab')).toBe(false); // a call registration only: no run mark outlives the persona
    expect(servedModels('lab')).toEqual(['qwen3']); // recorded once the request is sent (after the semaphore admits it): an unload target (P3)
    expect(listings).toBe(1); // prepare() warmed the served limits first
    expect(acquire.mock.calls[0][0]).toBe(endpointModelId('lab', 'qwen3'));
  });

  it('does not register an endpoint on no card as busy', async () => {
    const baseUrl = await startHeldServer(50);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { gpu: 'none' })] });
    await generateVoiceStylePersona(CHAR);
    expect(seen[0].busyDuringCall).toBe(false);
    expect(seen[0].headers.authorization).toBeUndefined();
  });

  it('serialises concurrent personas at the endpoint concurrency of 1', async () => {
    const baseUrl = await startHeldServer(150);
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { concurrency: 1 })] });
    await Promise.all([generateVoiceStylePersona(CHAR), generateVoiceStylePersona(CHAR)]);
    expect(seen).toHaveLength(2);
    expect(peak).toBe(1);
  });

  it('aborting the caller signal aborts an in-flight endpoint persona call', async () => {
    let closedBeforeResponse = false;
    let arrived!: () => void;
    const requestArrived = new Promise<void>((r) => (arrived = r));
    server = createServer((req, res) => {
      if (req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [] }));
        return;
      }
      res.on('close', () => {
        if (!res.writableEnded) closedBeforeResponse = true;
      });
      req.resume();
      req.on('end', () => arrived()); // never answers: only the caller's abort can end this call
    });
    const baseUrl = await new Promise<string>((resolve) => {
      server!.listen(0, '127.0.0.1', () => {
        const a = server!.address();
        resolve(`http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}/v1`);
      });
    });
    _setUserSettingsCacheForTest({ analyzerEndpoints: [endpoint(baseUrl, { gpu: 'none' })] });
    const ac = new AbortController();
    const pending = generateVoiceStylePersona(CHAR, { signal: ac.signal }).catch((e: unknown) => e);
    await requestArrived;
    ac.abort();
    expect(await pending).toBeInstanceOf(AnalysisAbortedError);
    await vi.waitFor(() => expect(closedBeforeResponse).toBe(true));
  });
});
