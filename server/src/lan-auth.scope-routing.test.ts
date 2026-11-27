/* #898 (PR B) pass-1 finding: the scope guard must approve the SAME path Express
   routes. Real Express routing + the real requireLanToken, reached over a raw
   socket (supertest normalises the request-target before sending). Only the
   device lookup is faked. */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import express from 'express';

vi.mock('./workspace/device-tokens.js', () => ({
  authenticateDeviceToken: (t: string) =>
    t === 'goodtoken'
      ? { id: 'd1', label: 'phone', tokenHash: 'h', createdAt: '', expiresAt: '', scope: 'companion' }
      : null,
}));

import { requireLanToken } from './lan-auth.js';

let server: Server;
let port: number;
const ran: string[] = [];
const origHttps = process.env.LAN_HTTPS;
const origToken = process.env.LAN_AUTH_TOKEN;

beforeAll(async () => {
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'sekret-token';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const app = express();
  // Pose as a non-loopback caller so the guard is not bypassed.
  app.use((req, _res, next) => {
    Object.defineProperty(req, 'ip', { value: '203.0.113.5' });
    next();
  });
  app.use(['/api', '/workspace'], requireLanToken);
  // Like app.ts:298: a parameterised mount, whose prefix trim shifts the routed path.
  app.use('/api/books/:bookId', (_req, _res, next) => next());
  app.get('/api/books/:bookId/exports/:exportId', (_req, res) => {
    ran.push('GET exports');
    res.json({ route: 'export' });
  });
  app.put('/api/books/:bookId/state', (_req, res) => {
    ran.push('PUT state');
    res.json({ route: 'state' });
  });
  app.post('/api/books/:bookId/generation', (_req, res) => {
    ran.push('POST generation');
    res.json({ route: 'generation' });
  });
  app.get('/api/books/:bookId/cover', (_req, res) => {
    res.json({ route: 'cover' });
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(() => {
  server.close();
  vi.restoreAllMocks();
  if (origHttps === undefined) delete process.env.LAN_HTTPS;
  else process.env.LAN_HTTPS = origHttps;
  if (origToken === undefined) delete process.env.LAN_AUTH_TOKEN;
  else process.env.LAN_AUTH_TOKEN = origToken;
});

function raw(target: string, method = 'GET'): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => {
      s.write(
        `${method} ${target} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer goodtoken\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`,
      );
    });
    let buf = '';
    s.on('data', (d) => (buf += d));
    s.on('end', () => resolve(buf));
  });
}

describe('companion scope guard vs Express routing', () => {
  it('control: the allowlisted cover route is reachable', async () => {
    expect(await raw('/api/books/b/cover')).toContain('"route":"cover"');
  });
  it('control: the export route is denied on its plain path', async () => {
    expect(await raw('/api/books/b/exports/cover')).toContain('scope-denied');
  });
  it('denies a backslash + # path that Express would route to the export handler', async () => {
    const res = await raw('/api/books/b\\exports/cover#');
    expect(res.startsWith('HTTP/1.1 403')).toBe(true);
    expect(res).toContain('scope-denied');
    expect(res).not.toContain('"route":"export"');
  });

  /* The parameterised mount's prefix trim slices the matched length off the RAW url, but
     legacy url.parse (taken for a target containing #) escapes { } | ^ ` ' " < > in the
     pathname, so each such bookId character shifts the routed path 2 characters. The
     guard saw an allowlisted row; the router ran a non-allowlisted handler (#4720 pass 2). */
  it.each([
    ['GET', '/api/books/{{{{/cover#X/exports/foo'],
    ['PUT', '/api/books/{{{{{{{{{/listen-progress#X/state'],
    ['POST', '/api/books/{{{{{{{{/shelf-status#XY/generation'],
  ])('denies %s %s, which the shifted router would run as another handler', async (m, target) => {
    ran.length = 0;
    const res = await raw(target, m);
    expect(res.startsWith('HTTP/1.1 403')).toBe(true);
    expect(res).toContain('scope-denied');
    expect(ran).toEqual([]);
  });
});
