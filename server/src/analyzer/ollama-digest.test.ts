import { describe, it, expect } from 'vitest';
import { createServer, type RequestListener } from 'node:http';
import type { AddressInfo } from 'node:net';
import { ollamaModelDigest } from './ollama-digest.js';

async function withServer(handler: RequestListener, fn: (url: string) => Promise<void>): Promise<void> {
  const server = createServer(handler);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  try {
    await fn(`http://127.0.0.1:${(server.address() as AddressInfo).port}/`);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe('ollamaModelDigest (#3084 A3)', () => {
  it('returns the exact tag\'s digest, and undefined for an absent tag or a tag without one', async () => {
    await withServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ models: [{ name: 'qwen3.5:4b', digest: 'sha256:abc' }, { name: 'mistral:7b' }] }));
    }, async (url) => {
      expect(await ollamaModelDigest(url, 'qwen3.5:4b')).toBe('sha256:abc');
      expect(await ollamaModelDigest(url, 'qwen3.5')).toBeUndefined();
      expect(await ollamaModelDigest(url, 'mistral:7b')).toBeUndefined();
    });
  });

  it('never throws: a 500, a non-JSON body and a dropped connection all answer undefined', async () => {
    await withServer((_req, res) => { res.writeHead(500); res.end('boom'); }, async (url) => {
      expect(await ollamaModelDigest(url, 'qwen3.5:4b')).toBeUndefined();
    });
    await withServer((_req, res) => { res.writeHead(200); res.end('not json'); }, async (url) => {
      expect(await ollamaModelDigest(url, 'qwen3.5:4b')).toBeUndefined();
    });
    await withServer((req) => { req.socket.destroy(); }, async (url) => {
      await expect(ollamaModelDigest(url, 'qwen3.5:4b')).resolves.toBeUndefined();
    });
  });
});
