/* castwright-local-port-cert — POST /api/lan/cert/regenerate.
 *
 * Mocks node:child_process's execFile so no real mkcert install runs in
 * CI. Mirrors cert-root.test.ts's makeApp() isolation pattern — mount just
 * this router in a fresh express() app via supertest, no full app.ts needed. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import http from 'node:http';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

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
