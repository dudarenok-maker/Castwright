/* castwright-local-port-cert — POST /api/lan/cert/regenerate.
 *
 * Mocks node:child_process's execFile so no real mkcert install runs in
 * CI. Mirrors cert-root.test.ts's makeApp() isolation pattern — mount just
 * this router in a fresh express() app via supertest, no full app.ts needed. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import http from 'node:http';
import express, { type Express } from 'express';
import request from 'supertest';
import { copyFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { setLanRuntime } from '../lan-runtime.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

vi.mock('../lan-hosts.js', () => ({ enumerateLanIps: vi.fn(() => [] as string[]) }));
import { enumerateLanIps } from '../lan-hosts.js';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

// Only mocked for the TOCTOU test below (readFileSyncOverride) -- every other
// test leaves it undefined and falls through to the real implementation, so
// existsSync/writeFileSync/mkdtempSync/rmSync used elsewhere in this file
// still hit the real filesystem.
let readFileSyncOverride: (() => never) | undefined;
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    readFileSync: (...args: Parameters<typeof actual.readFileSync>) => {
      if (readFileSyncOverride) return readFileSyncOverride();
      return actual.readFileSync(...args);
    },
  };
});

import { execFile } from 'node:child_process';
import { lanCertRouter, __setCertPathsForTest } from './lan-cert.js';

function makeApp(lanHttpsServer?: { setSecureContext: (...args: unknown[]) => void }): Express {
  const app = express();
  if (lanHttpsServer) app.set('lanHttpsServer', lanHttpsServer);
  app.use('/api/lan', lanCertRouter);
  return app;
}

describe('POST /api/lan/cert/regenerate', () => {
  let certDir: string;

  beforeEach(() => {
    certDir = mkdtempSync(join(tmpdir(), 'lan-cert-route-test-'));
    __setCertPathsForTest({
      certFile: join(certDir, 'lan-cert.pem'),
      keyFile: join(certDir, 'lan-key.pem'),
    });
  });

  afterEach(() => {
    rmSync(certDir, { recursive: true, force: true });
    __setCertPathsForTest(null);
    vi.mocked(execFile).mockReset();
    readFileSyncOverride = undefined;
  });

  it('on success: hot-swaps the live server and returns 200 with the host list', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        null,
        '[setup-lan-certs] generating cert for hosts: localhost, 127.0.0.1, castwright.local, castwright.dev.local, 192.168.1.42\n' +
          '[setup-lan-certs] cert: ...\n',
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });
    const setSecureContext = vi.fn();

    const res = await request(makeApp({ setSecureContext })).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual([
      'localhost',
      '127.0.0.1',
      'castwright.local',
      'castwright.dev.local',
      '192.168.1.42',
    ]);
    expect(setSecureContext).toHaveBeenCalledWith({
      key: Buffer.from('FAKE-KEY'),
      cert: Buffer.from('FAKE-CERT'),
    });
  });

  it('on failure: returns 500 with the captured stderr and does NOT call setSecureContext', async () => {
    const err = new Error('mkcert exited 1');
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        err,
        '',
        '[setup-lan-certs] [FAIL] mkcert is not on PATH.',
      );
      return {} as ReturnType<typeof execFile>;
    });
    const setSecureContext = vi.fn();

    const res = await request(makeApp({ setSecureContext })).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(500);
    expect(res.body.error).toContain('mkcert is not on PATH');
    expect(setSecureContext).not.toHaveBeenCalled();
  });

  it('on a TOCTOU hot-swap read failure: still returns 200 with the host list (not a 500)', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        null,
        '[setup-lan-certs] generating cert for hosts: localhost, castwright.local\n',
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });
    readFileSyncOverride = () => {
      throw new Error('ENOENT: no such file or directory (simulated TOCTOU race)');
    };
    const setSecureContext = vi.fn();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const res = await request(makeApp({ setSecureContext })).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual(['localhost', 'castwright.local']);
    expect(setSecureContext).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('hot-swap read failed'));

    warnSpy.mockRestore();
  });

  it('when no live HTTPS server is registered, skips the hot-swap without erroring', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        null,
        '[setup-lan-certs] generating cert for hosts: localhost, castwright.local\n',
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });

    const res = await request(makeApp(undefined)).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual(['localhost', 'castwright.local']);
  });

  it('passes the 90s timeout and windowsHide:true to execFile', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, callback) => {
      (callback as (error: Error | null, stdout: string, stderr: string) => void)(
        null,
        '[setup-lan-certs] generating cert for hosts: localhost\n',
        '',
      );
      return {} as ReturnType<typeof execFile>;
    });

    await request(makeApp()).post('/api/lan/cert/regenerate');

    expect(execFile).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringContaining('setup-lan-certs.mjs')]),
      expect.objectContaining({ timeout: 90_000, windowsHide: true }),
      expect.any(Function),
    );
  });

  it('rejects a second regenerate request with 409 while one is already in flight', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    let resolveFirst: (() => void) | undefined;
    // Resolves the instant execFile is actually invoked — which only happens
    // AFTER the route has already checked the in-flight flag and flipped it
    // to true (execFileAsync's Promise executor calls execFile synchronously),
    // so awaiting this is a reliable "flag is now true" signal.
    let firstCallStarted: () => void;
    const firstCallStartedPromise = new Promise<void>((r) => {
      firstCallStarted = r;
    });
    vi.mocked(execFile).mockImplementation((_cmd, _args, _opts, callback) => {
      firstCallStarted();
      // Don't call the callback yet — simulates a still-running subprocess,
      // so the first request's in-flight window is observable.
      resolveFirst = () =>
        (callback as (error: Error | null, stdout: string, stderr: string) => void)(
          null,
          '[setup-lan-certs] generating cert for hosts: localhost\n',
          '',
        );
      return {} as ReturnType<typeof execFile>;
    });

    // supertest/superagent don't actually send a request until it's awaited
    // (or .then() is called) — so two "fire and await later" supertest calls
    // can't observe overlap reliably. A real listening http.Server + raw
    // http.request calls (which send on .end(), no lazy thenable) gives
    // deterministic control over when each request actually hits the wire.
    const server = makeApp().listen(0);
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('expected AddressInfo');
    const port = address.port;

    function post(): Promise<{ status: number }> {
      return new Promise((resolvePost, reject) => {
        const req = http.request(
          { method: 'POST', hostname: '127.0.0.1', port, path: '/api/lan/cert/regenerate' },
          (res) => {
            res.resume();
            res.on('end', () => resolvePost({ status: res.statusCode as number }));
          },
        );
        req.on('error', reject);
        req.end();
      });
    }

    try {
      const firstRequest = post();
      await firstCallStartedPromise;

      const secondResponse = await post();
      expect(secondResponse.status).toBe(409);

      resolveFirst?.();
      const firstResponse = await firstRequest;
      expect(firstResponse.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('GET /api/lan/cert/status', () => {
  let certDir: string;
  const fixture = join(__dirname, '__fixtures__', 'lan-cert-healthy.pem');

  beforeEach(() => {
    certDir = mkdtempSync(join(tmpdir(), 'lan-cert-status-test-'));
    __setCertPathsForTest({
      certFile: join(certDir, 'lan-cert.pem'),
      keyFile: join(certDir, 'lan-key.pem'),
    });
    vi.mocked(enumerateLanIps).mockReturnValue([]);
    setLanRuntime({ httpsActive: false, port: 8080 });
    delete process.env.LAN_HTTPS;
  });
  afterEach(() => {
    rmSync(certDir, { recursive: true, force: true });
    __setCertPathsForTest(null);
    setLanRuntime({ httpsActive: false, port: 8080 });
    delete process.env.LAN_HTTPS;
  });

  it('missing when no cert files exist', async () => {
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.status).toBe(200);
    expect(res.body.health).toBe('missing');
    expect(res.body.certHosts).toEqual([]);
    expect(res.body.expiresAt).toBeNull();
  });

  it('missing when files present but unparseable', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.body.health).toBe('missing');
  });

  it('healthy for a real cert; reports certHosts + uncoveredIps informationally', async () => {
    copyFileSync(fixture, join(certDir, 'lan-cert.pem'));
    writeFileSync(join(certDir, 'lan-key.pem'), 'KEY-EXISTS');
    vi.mocked(enumerateLanIps).mockReturnValue(['192.168.1.42', '10.0.0.9']);
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.body.health).toBe('healthy');
    expect(res.body.certHosts).toEqual(['127.0.0.1', '192.168.1.42']);
    expect(res.body.uncoveredIps).toEqual(['10.0.0.9']);
    expect(typeof res.body.expiresAt).toBe('string');
  });

  it('reflects requested (env) and active (runtime) flags', async () => {
    process.env.LAN_HTTPS = '1';
    setLanRuntime({ httpsActive: true, port: 8443 });
    const res = await request(makeApp()).get('/api/lan/cert/status');
    expect(res.body.requested).toBe(true);
    expect(res.body.active).toBe(true);
  });
});
