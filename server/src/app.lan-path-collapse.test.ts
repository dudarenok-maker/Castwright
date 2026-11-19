import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir, networkInterfaces } from 'node:os';
import { join } from 'node:path';

/* #4446 — host paths collapse the home dir to `~` for non-loopback clients.
   Real assembled app over real sockets, modelled on app.health-loopback.test.ts.
   Later children of the chain extend this file. */

const lanIp = Object.values(networkInterfaces())
  .flat()
  .find((i) => i && i.family === 'IPv4' && !i.internal)?.address;

let home: string;
let server: http.Server;
let port: number;
const saved: Record<string, string | undefined> = {};
const KEYS = ['HOME', 'USERPROFILE', 'WORKSPACE_DIR', 'USER_SETTINGS_FILE', 'HF_HOME', 'OLLAMA_URL'];

beforeAll(async () => {
  for (const k of KEYS) saved[k] = process.env[k];
  home = realpathSync(mkdtempSync(join(tmpdir(), 'cw-lan-path-')));
  mkdirSync(join(home, 'ws'), { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.WORKSPACE_DIR = join(home, 'ws');
  process.env.USER_SETTINGS_FILE = join(home, 'user-settings.json');
  process.env.HF_HOME = join(home, 'hf');
  process.env.OLLAMA_URL = 'http://127.0.0.1:1';
  vi.resetModules();
  const { app } = await import('./app.js');
  server = http.createServer(app);
  await new Promise<void>((r) => server.listen(0, '0.0.0.0', r));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise((r) => server.close(r));
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(home, { recursive: true, force: true });
});

function getJson(host: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; body: Record<string, string> }>((resolve, reject) => {
    http
      .get({ host, port, path, headers }, (res) => {
        let raw = '';
        res.on('data', (c) => (raw += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
      })
      .on('error', reject);
  });
}

describe('GET /api/workspace path collapse on the real app (#4446)', () => {
  it('a loopback connection gets full absolute paths under the fake home', async () => {
    const res = await getJson('127.0.0.1', '/api/workspace');
    expect(res.status).toBe(200);
    expect(res.body.root.startsWith(home)).toBe(true);
    expect(res.body.booksRoot.startsWith(home)).toBe(true);
  });

  it.runIf(!!process.env.CI)('CI host has a non-internal IPv4 (the LAN cases below must run)', () => {
    expect(lanIp).toBeTruthy();
  });

  describe.skipIf(!lanIp)(`from a LAN address (${lanIp ?? 'none: no non-internal IPv4 on this host'})`, () => {
    it('collapses home to ~ and keeps the rest', async () => {
      const lo = await getJson('127.0.0.1', '/api/workspace');
      const lan = await getJson(lanIp!, '/api/workspace');
      expect(lan.status).toBe(200);
      expect(lan.body.root).toBe('~' + lo.body.root.slice(home.length));
      expect(lan.body.booksRoot).toBe('~' + lo.body.booksRoot.slice(home.length));
      expect(lan.body.root.startsWith('~')).toBe(true);
    });

    it.each([
      ['X-Forwarded-For', '127.0.0.1'],
      ['Host', 'localhost'],
    ])('a spoofed %s: %s still collapses', async (name, value) => {
      const res = await getJson(lanIp!, '/api/workspace', { [name]: value });
      expect(res.body.root.startsWith('~')).toBe(true);
      expect(res.body.booksRoot.startsWith('~')).toBe(true);
    });
  });
});
