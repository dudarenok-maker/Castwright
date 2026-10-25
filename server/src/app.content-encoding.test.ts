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
  vi.restoreAllMocks();
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const json = Buffer.from(JSON.stringify({ code: 'x', label: 'x' }));
// Raw bytes on the wire. Without this, superagent JSON-serialises a Buffer sent
// under application/json into {"type":"Buffer","data":[...]} and no real frame
// ever reaches the server.
// (superagent types serialize as returning string; the Buffer passes through.)
const raw = ((b: Buffer) => b) as unknown as (obj: unknown) => string;
// The global-parser route and the per-route 1kb pairing parser.
const ROUTES = ['/api/devices', '/api/pair/redeem'];

type ZstdZlib = { zstdCompressSync: (b: Buffer) => Buffer };

describe('Content-Encoding allowlist (#3790)', () => {
  it('has zlib.zstdCompressSync (Node >= 22.22) so the zstd cases below are real', () => {
    expect(typeof (zlib as unknown as Partial<ZstdZlib>).zstdCompressSync).toBe('function');
  });

  // body-parser creates its decoder through the shared node:zlib object, so this
  // spy sees every decode attempt. 0 calls is the property the guard exists for.
  for (const route of ROUTES) {
    it(`${route}: a zstd-encoded body is 415 and never reaches the decoder`, async () => {
      const spy = vi.spyOn(zlib, 'createZstdDecompress');
      const body = (zlib as unknown as ZstdZlib).zstdCompressSync(json);
      const res = await request(app)
        .post(route)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'zstd')
        .serialize(raw)
        .send(body);
      expect(res.status).toBe(415);
      expect(JSON.stringify(res.body)).not.toContain('zstd');
      expect(spy).toHaveBeenCalledTimes(0);
    });

    it(`${route}: a multi-coding value containing zstd is 415 and never reaches the decoder`, async () => {
      const spy = vi.spyOn(zlib, 'createZstdDecompress');
      const res = await request(app)
        .post(route)
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', 'gzip, ZSTD')
        .serialize(raw)
        .send(zlib.gzipSync(json));
      expect(res.status).toBe(415);
      expect(spy).toHaveBeenCalledTimes(0);
    });
  }

  it('/api/devices: an identity body is accepted and parsed (201, posted label)', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .serialize(raw)
      .send(json);
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('x');
  });

  // RFC 9110 5.6.1.2: empty list elements are ignored; body-parser reads '' as identity.
  for (const header of ['', ' ']) {
    it(`/api/devices: Content-Encoding ${JSON.stringify(header)} is identity (201, posted label)`, async () => {
      const res = await request(app)
        .post('/api/devices')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', header)
        .serialize(raw)
        .send(json);
      expect(res.status).toBe(201);
      expect(res.body.label).toBe('x');
    });
  }

  // body-parser itself refuses the literal value 'gzip,' (it does not split the
  // list), so only assert the GUARD let it through: its sentence is absent.
  it("/api/devices: 'gzip,' is not refused by the guard", async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip,')
      .serialize(raw)
      .send(zlib.gzipSync(json));
    expect(res.body?.error).not.toBe('Unsupported Content-Encoding.');
  });

  it('/api/devices: empty elements do not smuggle zstd through', async () => {
    for (const header of ['zstd', 'gzip, zstd', ',zstd', 'zstd,']) {
      const res = await request(app)
        .post('/api/devices')
        .set('Content-Type', 'application/json')
        .set('Content-Encoding', header)
        .serialize(raw)
        .send(json);
      expect(res.status).toBe(415);
    }
  });

  it('/api/devices: a real gzip body is accepted and decoded (201, posted label)', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize(raw)
      .send(zlib.gzipSync(json));
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('x');
  });
});
