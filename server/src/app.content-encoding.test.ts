import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* #3790 — body-parser 2.4 decodes `Content-Encoding: zstd`, and the body limit
   caps decoded OUTPUT, not the decoder window, so a tiny frame declaring a huge
   window commits ~131 MB per request. The parsers run pre-auth, so app.ts
   refuses any encoding outside identity/gzip/deflate/br before they see it.
   Route-level against the REAL assembled app. */

let dir: string;
let app: import('express').Express;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-content-encoding-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  ({ app } = await import('./app.js'));
});
afterEach(() => {
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const json = Buffer.from(JSON.stringify({ code: 'x', label: 'x' }));
// The global-parser route and the per-route 1kb pairing parser.
const ROUTES = ['/api/devices', '/api/pair/redeem'];

describe('Content-Encoding allowlist (#3790)', () => {
  it('has zlib.zstdCompressSync (Node >= 22.22) so the zstd cases below are real', () => {
    expect(typeof (zlib as unknown as { zstdCompressSync?: unknown }).zstdCompressSync).toBe('function');
  });

  for (const route of ROUTES) {
    it(`${route}: a zstd-encoded body is 415`, async () => {
      const body = (zlib as unknown as { zstdCompressSync: (b: Buffer) => Buffer }).zstdCompressSync(json);
      const res = await request(app)
        .post(route)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'zstd')
        .send(body);
      expect(res.status).toBe(415);
      expect(JSON.stringify(res.body)).not.toContain('zstd');
    });

    it(`${route}: a multi-coding value containing zstd is 415`, async () => {
      const res = await request(app)
        .post(route)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip, ZSTD')
        .send(zlib.gzipSync(json));
      expect(res.status).toBe(415);
    });

    it(`${route}: identity and gzip bodies are NOT refused with 415`, async () => {
      const plain = await request(app).post(route).set('Content-Type', 'application/json').send(json);
      expect(plain.status).not.toBe(415);
      const gz = await request(app)
        .post(route)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip')
        .send(zlib.gzipSync(json));
      expect(gz.status).not.toBe(415);
    });
  }
});
