import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import zlib from 'node:zlib';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/* #3793 — body-parser client errors (malformed JSON, oversize body, corrupt
   gzip) reached the global errorHandler and came back as `500 Internal server
   error.`, logged as an unhandled route error. They are client faults and
   answer their own 4xx with a fixed sentence. Route-level against the REAL
   assembled app. */

let dir: string;
let app: import('express').Express;
let errSpy: { mock: { calls: unknown[][] } };

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-body-parser-errors-'));
  process.env.WORKSPACE_DIR = dir;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.resetModules();
  ({ app } = await import('./app.js'));
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

const raw = ((b: Buffer) => b) as unknown as (obj: unknown) => string;

function loggedAsUnhandled(): boolean {
  return errSpy.mock.calls.some((c: unknown[]) => String(c[0]).includes('unhandled route error'));
}

describe('body-parser client errors (#3793)', () => {
  it('malformed JSON on the global parser is 400, not 500', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .serialize(raw)
      .send(Buffer.from('{"code": '));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Malformed JSON request body.' });
    expect(loggedAsUnhandled()).toBe(false);
  });

  it('a body over the per-route 1kb limit is 413, not 500', async () => {
    const res = await request(app)
      .post('/api/pair/redeem')
      .set('Content-Type', 'application/json')
      .serialize(raw)
      .send(Buffer.from(JSON.stringify({ code: 'x'.repeat(4096) })));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large.' });
    expect(loggedAsUnhandled()).toBe(false);
  });

  it('a corrupt gzip body is 400, not 500', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize(raw)
      .send(Buffer.from('this is not gzip data at all'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Request body could not be decoded.' });
    expect(loggedAsUnhandled()).toBe(false);
  });

  it('a truncated gzip body is 400, not 500', async () => {
    const full = zlib.gzipSync(Buffer.from(JSON.stringify({ code: 'x', label: 'x' })));
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'gzip')
      .serialize(raw)
      .send(full.subarray(0, full.length - 6));
    expect(res.status).toBe(400);
    expect(loggedAsUnhandled()).toBe(false);
  });

  it('a corrupt brotli body is 400, not 500', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'br')
      .serialize(raw)
      .send(Buffer.from('garbage garbage garbage'));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Request body could not be decoded.' });
    expect(loggedAsUnhandled()).toBe(false);
  });

  it('a truncated brotli body is 400, not 500', async () => {
    const full = zlib.brotliCompressSync(
      Buffer.from(JSON.stringify({ code: 'x', label: 'hello world hello world' })),
    );
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json')
      .set('Content-Encoding', 'br')
      .serialize(raw)
      .send(full.subarray(0, full.length - 4));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Request body could not be decoded.' });
    expect(loggedAsUnhandled()).toBe(false);
  });

  it('an unsupported charset is 415, not 500', async () => {
    const res = await request(app)
      .post('/api/devices')
      .set('Content-Type', 'application/json; charset=klingon')
      .serialize(raw)
      .send(Buffer.from('{}'));
    expect(res.status).toBe(415);
    expect(res.body).toEqual({ error: 'Unsupported charset.' });
    expect(JSON.stringify(res.body)).not.toContain('klingon');
  });
});
