import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

/* #4323 — /api/health returns cwd/runDir to loopback requests only. Drives the
   REAL assembled app over real sockets (a hand-built route copy, or a source
   string match, cannot see a mutation in app.ts's wiring). The non-loopback
   case connects to this host's own non-internal IPv4, so the server sees a
   genuine LAN peer. Never 127.0.0.2: macOS lo0 carries only 127.0.0.1. */

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

let dir: string;
let server: http.Server;
let port: number;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cw-health-loopback-'));
  process.env.WORKSPACE_DIR = dir;
  vi.resetModules();
  const { app } = await import('./app.js');
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  delete process.env.WORKSPACE_DIR;
  rmSync(dir, { recursive: true, force: true });
});

function getHealth(host: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: { configLoad: Record<string, unknown> } }>((resolve, reject) => {
    http
      .get({ host, port, path: '/api/health', headers }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      })
      .on('error', reject);
  });
}

describe('GET /api/health on the real app (#4323)', () => {
  it('a loopback connection gets cwd + runDir', async () => {
    const res = await getHealth('127.0.0.1');
    expect(res.status).toBe(200);
    expect(typeof res.body.configLoad.cwd).toBe('string');
    expect(typeof res.body.configLoad.runDir).toBe('string');
  });

  // CI's Ubuntu runner has a non-internal eth0, so there the LAN cases are
  // never skipped: this test turns a missing interface into a red run.
  it.runIf(!!process.env.CI)('CI host has a non-internal IPv4 (the LAN cases below must run)', () => {
    expect(lanIp).toBeTruthy();
  });

  // Visible skip: only a box with no non-internal IPv4 (offline laptop) skips.
  describe.skipIf(!lanIp)(`from a LAN address (${lanIp ?? 'none: no non-internal IPv4 on this host'})`, () => {
    it('gets only { envLoaded }', async () => {
      const res = await getHealth(lanIp!);
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.configLoad)).toEqual(['envLoaded']);
    });

    it('X-Forwarded-For: 127.0.0.1 does not unlock the paths', async () => {
      const res = await getHealth(lanIp!, { 'X-Forwarded-For': '127.0.0.1' });
      expect(res.status).toBe(200);
      expect(Object.keys(res.body.configLoad)).toEqual(['envLoaded']);
    });
  });
});
