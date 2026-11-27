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
  app.get('/api/books/:bookId/exports/:exportId', (_req, res) => {
    res.json({ route: 'export' });
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

function raw(target: string): Promise<string> {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: '127.0.0.1' }, () => {
      s.write(
        `GET ${target} HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer goodtoken\r\nConnection: close\r\n\r\n`,
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
});
