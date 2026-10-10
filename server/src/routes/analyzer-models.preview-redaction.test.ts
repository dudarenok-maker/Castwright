import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { inspect } from 'node:util';
import { analyzerModelsRouter } from './analyzer-models.js';
import { DEFAULT_CATALOG_DEPS } from '../analyzer/catalog/analyzer-catalog.js';
import { AnalyzerTransportError } from '../analyzer/errors.js';

describe('POST /api/analyzer/models/preview — redaction (#3084 P22)', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections();
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    server = undefined;
  });

  it('a listing error whose body echoes the typed key is returned redacted', async () => {
    const KEY = 'sk-typed-echo-secret-0001';
    /* The endpoint echoes the Authorization header it received, as some proxies do on a 401. */
    server = createServer((req, res) => {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `Incorrect API key provided: ${req.headers.authorization ?? 'none'}`, type: 'invalid_request_error' } }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const app = express();
    app.use(express.json());
    app.use('/api/analyzer', analyzerModelsRouter);
    const res = await request(app).post('/api/analyzer/models/preview').send({ baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: KEY });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('failed');
    expect(res.body.error).toContain('401');
    /* '[redacted]' proves the key reached the endpoint and came back, so the check cannot pass vacuously. */
    expect(res.body.error).toContain('[redacted]');
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it('an injected error carrying the key never reaches the preview response, its log line or inspect(err) (P22)', async () => {
    const KEY = 'sk-preview-inject-secret-0001';
    /* undici rejects this as a header value (`Headers.append: "Bearer <key>…" is an invalid header value.`)
       before dispatching; the SDK wraps that TypeError as APIConnectionError's cause. */
    const INJECTED = `${KEY}\nX-Injected: 1`;
    let requests = 0;
    server = createServer((_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', () => r()));
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    const lines: string[] = [];
    const spies = (['log', 'info', 'warn', 'error'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        lines.push(args.map((a) => (typeof a === 'string' ? a : inspect(a, { depth: 8 }))).join(' '));
      }),
    );
    try {
      const app = express();
      app.use(express.json());
      app.use('/api/analyzer', analyzerModelsRouter);
      const res = await request(app).post('/api/analyzer/models/preview').send({ baseUrl, apiKey: INJECTED });
      /* The same listing the route ran, for the thrown error itself. */
      const err = await DEFAULT_CATALOG_DEPS.listEndpoint(baseUrl, INJECTED).then(
        () => undefined,
        (e: unknown) => e,
      );
      /* Non-vacuous: undici refused the header, so every surface below comes from the error path. */
      expect(requests).toBe(0);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('failed');
      expect(lines.some((l) => l.includes('preview listing failed'))).toBe(true);
      expect(err).toBeInstanceOf(AnalyzerTransportError);
      for (const s of [JSON.stringify(res.body), ...lines, (err as Error).message, (err as Error).stack ?? '', inspect(err, { depth: 8 })]) {
        expect(s).not.toContain(KEY);
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
