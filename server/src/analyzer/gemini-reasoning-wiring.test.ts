import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const captured: Array<{ config: Record<string, unknown> }> = [];
vi.mock('@google/genai', async (orig) => {
  const actual = await orig<typeof import('@google/genai')>();
  class FakeGoogleGenAI {
    models = {
      list: async () => { throw new Error('offline'); },
      generateContentStream: async (params: { config: Record<string, unknown> }) => {
        captured.push(params);
        return (async function* () { yield { text: '{}', candidates: [{ finishReason: 'STOP' }] }; })();
      },
    };
  }
  return { ...actual, GoogleGenAI: FakeGoogleGenAI };
});
vi.mock('../handoff/protocol.js', async (orig) => {
  const actual = await orig<typeof import('../handoff/protocol.js')>();
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = join(tmpdir(), `castwright-w5a-wiring-${process.pid}`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(dir, { recursive: true });
  return { ...actual, writeInbox: async () => join(dir, 'inbox.md'), outboxPath: () => join(dir, 'out.json'), errorPath: () => join(dir, 'err.json'), rawAttemptPath: () => join(dir, 'raw.txt') };
});

import { GeminiAnalyzer } from './gemini.js';
import { OllamaAnalyzer } from './ollama.js';
import { _setUserSettingsCacheForTest, _resetUserSettingsCache } from '../workspace/user-settings.js';
import { geminiRateLimiter } from './rate-limit.js';

let server: Server | null = null;
const ollamaBodies: Array<Record<string, unknown>> = [];
beforeAll(() => { process.env.CASTWRIGHT_VRAM_SAMPLE = '0'; });
beforeEach(() => {
  captured.length = 0;
  ollamaBodies.length = 0;
  geminiRateLimiter._reset();
  _resetUserSettingsCache();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(async () => {
  vi.restoreAllMocks();
  if (server) { server.closeAllConnections(); await new Promise<void>((r) => server!.close(() => r())); server = null; }
});

describe('saved reasoning settings reach the wire', () => {
  it('Gemini: the per-model level is sent, other models send nothing', async () => {
    /* F2 — a 3.x id, not 2.5 (2.5 offers model-default only). */
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { gemini: { 'gemini-3.6-flash': 'low' } } });
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.6-flash' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    await new GeminiAnalyzer({ apiKey: 'k', model: 'gemini-3.5-flash' }).runAttributionEscalation('m1', 1, 1, 'prompt', {});
    expect((captured[0].config.thinkingConfig as Record<string, unknown>).thinkingLevel).toBe('LOW');
    expect((captured[1].config.thinkingConfig as Record<string, unknown> | undefined)?.thinkingLevel).toBeUndefined();
  });

  it('Ollama: default install still sends think:false; a level saved for one model is sent for that model only (P18)', async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        ollamaBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '{}' }, done: true, done_reason: 'stop' }) + '\n');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    _setUserSettingsCacheForTest({});
    await new OllamaAnalyzer({ url, model: 'q:4b' }).runAttributionEscalation('m1', 1, 0, 'prompt', {});
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { ollama: { 'q:4b': 'on' } } });
    await new OllamaAnalyzer({ url, model: 'q:4b' }).runAttributionEscalation('m1', 1, 1, 'prompt', {});
    await new OllamaAnalyzer({ url, model: 'q:9b' }).runAttributionEscalation('m1', 1, 2, 'prompt', {});
    expect(ollamaBodies.map((b) => b.think)).toEqual([false, true, false]);
  });

  it('Ollama, one model id (N7): a level saved under qwen3:latest reaches a run on qwen3, and one saved under qwen3 a run on qwen3:latest', async () => {
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        ollamaBodies.push(JSON.parse(raw) as Record<string, unknown>);
        res.writeHead(200, { 'Content-Type': 'application/x-ndjson' });
        res.end(JSON.stringify({ message: { role: 'assistant', content: '{}' }, done: true, done_reason: 'stop' }) + '\n');
      });
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server!.address() as AddressInfo).port}`;
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { ollama: { 'qwen3:latest': 'on' } } });
    await new OllamaAnalyzer({ url, model: 'qwen3' }).runAttributionEscalation('m1', 1, 3, 'prompt', {});
    _setUserSettingsCacheForTest({ analyzerReasoningByEngine: { ollama: { qwen3: 'high' } } });
    await new OllamaAnalyzer({ url, model: 'qwen3:latest' }).runAttributionEscalation('m1', 1, 4, 'prompt', {});
    expect(ollamaBodies.map((b) => b.think)).toEqual([true, 'high']);
  });
});
