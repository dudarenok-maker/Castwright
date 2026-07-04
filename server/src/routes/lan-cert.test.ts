/* castwright-local-port-cert — POST /api/lan/cert/regenerate.
 *
 * Mocks node:child_process's execFileSync so no real mkcert install runs in
 * CI. Mirrors cert-root.test.ts's makeApp() isolation pattern — mount just
 * this router in a fresh express() app via supertest, no full app.ts needed. */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { execFileSync } from 'node:child_process';
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
    vi.mocked(execFileSync).mockReset();
  });

  it('on success: hot-swaps the live server and returns 200 with the host list', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFileSync).mockReturnValue(
      '[setup-lan-certs] generating cert for hosts: localhost, 127.0.0.1, castwright.local, castwright.dev.local, 192.168.1.42\n' +
        '[setup-lan-certs] cert: ...\n',
    );
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
    const err = Object.assign(new Error('mkcert exited 1'), {
      stderr: Buffer.from('[setup-lan-certs] [FAIL] mkcert is not on PATH.'),
    });
    vi.mocked(execFileSync).mockImplementation(() => {
      throw err;
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
    vi.mocked(execFileSync).mockReturnValue(
      '[setup-lan-certs] generating cert for hosts: localhost, castwright.local\n',
    );

    const res = await request(makeApp(undefined)).post('/api/lan/cert/regenerate');

    expect(res.status).toBe(200);
    expect(res.body.hosts).toEqual(['localhost', 'castwright.local']);
  });

  it('passes the 90s timeout and windowsHide:true to execFileSync', async () => {
    writeFileSync(join(certDir, 'lan-cert.pem'), 'FAKE-CERT');
    writeFileSync(join(certDir, 'lan-key.pem'), 'FAKE-KEY');
    vi.mocked(execFileSync).mockReturnValue('[setup-lan-certs] generating cert for hosts: localhost\n');

    await request(makeApp()).post('/api/lan/cert/regenerate');

    expect(execFileSync).toHaveBeenCalledWith(
      process.execPath,
      expect.arrayContaining([expect.stringContaining('setup-lan-certs.mjs')]),
      expect.objectContaining({ timeout: 90_000, windowsHide: true }),
    );
  });
});
