/* @google/genai 3.0 flipped the Developer API default from v1beta to v1, and v1
   has no speech output (speechConfig / responseModalities AUDIO). Every
   production `new GoogleGenAI` must therefore pin GEMINI_API_VERSION. This drives
   the REAL SDK against a local endpoint (GOOGLE_GEMINI_BASE_URL) and asserts the
   request path — an injected client would bypass the URL and could not fail. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { listGeminiModels, _resetGeminiCatalogForTest } from './catalog/gemini-catalog.js';
import { GeminiTransport } from './transports/gemini-transport.js';

let server: http.Server;
let urls: string[] = [];
const prevBase = process.env.GOOGLE_GEMINI_BASE_URL;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    urls.push(req.url ?? '');
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ models: [] }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  process.env.GOOGLE_GEMINI_BASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => {
  urls = [];
  _resetGeminiCatalogForTest();
});

afterAll(async () => {
  if (prevBase === undefined) delete process.env.GOOGLE_GEMINI_BASE_URL;
  else process.env.GOOGLE_GEMINI_BASE_URL = prevBase;
  await new Promise<void>((r) => server.close(() => r()));
});

describe('Gemini API version pin', () => {
  it('the model catalog lists against /v1beta/', async () => {
    await listGeminiModels('version-key-catalog', { refresh: true });
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^\/v1beta\/models/);
  });

  it("the analyzer transport's own client talks to /v1beta/", async () => {
    await new GeminiTransport({ apiKey: 'version-key-transport', model: 'gemma-version' }).prepare();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^\/v1beta\/models/);
  });
});
