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
const KEYS = ['HOME', 'USERPROFILE', 'WORKSPACE_DIR', 'USER_SETTINGS_FILE', 'HF_HOME', 'OLLAMA_URL', 'LOCAL_TTS_URL'];

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
  process.env.LOCAL_TTS_URL = 'http://127.0.0.1:1';
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
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
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

type InvItem = { id: string; diskPath: string | null };

describe('/api/models diskPath collapse on the real app (#4446)', () => {
  it('loopback: every non-null diskPath is absolute and unchanged; some live under the fake home', async () => {
    const lo = await getJson('127.0.0.1', '/api/models/inventory');
    expect(lo.status).toBe(200);
    const paths = (lo.body.items as InvItem[]).map((i) => i.diskPath).filter((p): p is string => p !== null);
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.some((p) => p.startsWith(home))).toBe(true); // non-vacuity
    expect(paths.every((p) => !p.startsWith('~'))).toBe(true);
  });

  describe.skipIf(!lanIp)('from a LAN address', () => {
    it('collapses home to ~, leaves non-home paths and null alone', async () => {
      const lo = (await getJson('127.0.0.1', '/api/models/inventory')).body.items as InvItem[];
      const lan = (await getJson(lanIp!, '/api/models/inventory')).body.items as InvItem[];
      expect(lan.length).toBe(lo.length);
      for (const l of lan) {
        const orig = lo.find((i) => i.id === l.id)!;
        if (orig.diskPath === null) expect(l.diskPath).toBeNull();
        else if (orig.diskPath.startsWith(home)) expect(l.diskPath).toBe('~' + orig.diskPath.slice(home.length));
        else expect(l.diskPath).toBe(orig.diskPath);
        if (l.diskPath !== null) expect(l.diskPath.startsWith(home)).toBe(false);
      }
      expect(lan.some((i) => i.diskPath?.startsWith('~'))).toBe(true);
      const kokoro = lan.find((i) => i.id === 'kokoro')!;
      const kokoroLo = lo.find((i) => i.id === 'kokoro')!;
      if (kokoroLo.diskPath && !kokoroLo.diskPath.startsWith(home)) {
        expect(kokoro.diskPath).toBe(kokoroLo.diskPath);
      }
    });

    it('POST /:id/remove of a not-present model returns a collapsed item.diskPath', async () => {
      // qwen-base under the empty fake HF_HOME is not present -> removed:false + item, nothing deleted.
      const lan = await postJson(lanIp!, '/api/models/qwen-base/remove');
      expect(lan.status).toBe(200);
      expect(lan.body.removed).toBe(false);
      expect(lan.body.item.diskPath.startsWith('~')).toBe(true);
      expect(lan.body.item.diskPath.startsWith(home)).toBe(false);
      const lo = await postJson('127.0.0.1', '/api/models/qwen-base/remove');
      expect(lo.body.item.diskPath.startsWith(home)).toBe(true);
    });
  });
});

function postJson(host: string, path: string) {
  return new Promise<{ status: number; body: any }>((resolve, reject) => {
    const r = http.request({ host, port, path, method: 'POST' }, (res) => {
      let raw = '';
      res.on('data', (c) => (raw += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }));
    });
    r.on('error', reject);
    r.end();
  });
}
