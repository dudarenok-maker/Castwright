/* Plan 81 wave 1 — GET /cert/root.crt.
 *
 * The route serves the mkcert root CA so phones / tablets on the LAN can
 * download + trust it once, then hit https://<lan-ip>:8443 with no
 * browser warning. Three resolution sources: env override, mkcert CLI
 * shell-out, per-OS default fallback.
 *
 * Tests cover all three branches by manipulating $MKCERT_CAROOT and a
 * temp dir with a fake rootCA.pem. We don't need a real mkcert install
 * — the cert content is opaque bytes to the route. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';
import { certRootRouter, resolveRootCaPath } from './cert-root.js';

function makeApp(): Express {
  const app = express();
  app.use('/cert', certRootRouter);
  return app;
}

const FAKE_CA_CONTENT = '-----BEGIN CERTIFICATE-----\nFAKE-CA-FOR-TESTS\n-----END CERTIFICATE-----\n';

describe('resolveRootCaPath', () => {
  let tmpDir: string;
  const origEnv = process.env.MKCERT_CAROOT;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mkcert-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.MKCERT_CAROOT;
    else process.env.MKCERT_CAROOT = origEnv;
  });

  it('returns env source when MKCERT_CAROOT is set + rootCA.pem exists there', () => {
    writeFileSync(join(tmpDir, 'rootCA.pem'), FAKE_CA_CONTENT);
    process.env.MKCERT_CAROOT = tmpDir;
    const out = resolveRootCaPath();
    expect(out).not.toBeNull();
    expect(out!.source).toBe('env');
    expect(out!.path).toBe(join(tmpDir, 'rootCA.pem'));
  });

  it('falls through to next source when MKCERT_CAROOT is set but file missing there', () => {
    /* env points at empty dir → cert-root.ts walks past env, tries mkcert
       CLI, then platform default. In a sandbox without mkcert installed,
       all three sources miss → returns null. */
    process.env.MKCERT_CAROOT = tmpDir;
    const out = resolveRootCaPath();
    // out may be null OR a hit on the OS default if the test runner has
    // mkcert installed. Either is acceptable — what we're verifying is
    // that source != 'env' since the env file wasn't present.
    if (out !== null) {
      expect(out.source).not.toBe('env');
    }
  });
});

describe('GET /cert/root.crt', () => {
  let tmpDir: string;
  const origEnv = process.env.MKCERT_CAROOT;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mkcert-route-test-'));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.MKCERT_CAROOT;
    else process.env.MKCERT_CAROOT = origEnv;
  });

  it('streams the root CA file with the right Content-Type when present', async () => {
    writeFileSync(join(tmpDir, 'rootCA.pem'), FAKE_CA_CONTENT);
    process.env.MKCERT_CAROOT = tmpDir;
    const res = await request(makeApp()).get('/cert/root.crt');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/x-x509-ca-cert');
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.headers['content-disposition']).toContain('rootCA.pem');
    expect(res.headers['x-mkcert-source']).toBe('env');
    expect(res.text).toBe(FAKE_CA_CONTENT);
  });

  it('returns 404 with a helpful hint when no root CA is found', async () => {
    /* Point env at a non-existent dir + assume the test sandbox has no
       mkcert installed nor a CA in the default platform location.
       The "probed" body field lets users self-diagnose. */
    process.env.MKCERT_CAROOT = join(tmpDir, 'definitely-not-there');
    const res = await request(makeApp()).get('/cert/root.crt');
    /* If the test runner DOES have mkcert + a CA file at the OS default,
       this branch is unreachable and the test no-ops. Skip rather than
       false-fail. */
    if (res.status === 200) {
      // mkcert installed locally — different code path covered above.
      return;
    }
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/mkcert root CA not found/i);
    expect(res.body.hint).toContain('install:cert-mobile');
    expect(res.body.probed).toBeDefined();
    expect(res.body.probed.env).toBe(join(tmpDir, 'definitely-not-there'));
  });

  it('sets Cache-Control: no-store so the CA never lands in a caching proxy', async () => {
    writeFileSync(join(tmpDir, 'rootCA.pem'), FAKE_CA_CONTENT);
    process.env.MKCERT_CAROOT = tmpDir;
    const res = await request(makeApp()).get('/cert/root.crt');
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
  });
});

describe('GET /cert/root.crt 404 probed block, LAN caller (#4572)', () => {
  const origEnv = process.env.MKCERT_CAROOT;
  const BACKSLASH = String.fromCharCode(92);
  const foreignCaroot =
    process.platform === 'win32'
      ? ['C:', 'Users', 'alice-secret', 'AppData', 'Local', 'mkcert-missing'].join(BACKSLASH)
      : '/home/alice-secret/.local/share/mkcert-missing';

  function makeLanApp(): Express {
    const app = express();
    app.use((req, _res, next) => {
      Object.defineProperty(req, 'ip', { value: '192.168.1.50' });
      next();
    });
    app.use('/cert', certRootRouter);
    return app;
  }

  /* Hermetic: hide any real mkcert CLI / CA so the route reliably 404s. */
  const saved: Record<string, string | undefined> = {};
  let emptyDir: string;
  beforeEach(() => {
    emptyDir = mkdtempSync(join(tmpdir(), 'mkcert-lan-test-'));
    for (const k of ['PATH', 'Path', 'LOCALAPPDATA', 'XDG_DATA_HOME']) saved[k] = process.env[k];
    process.env.PATH = emptyDir;
    process.env.LOCALAPPDATA = emptyDir;
    process.env.XDG_DATA_HOME = emptyDir;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(emptyDir, { recursive: true, force: true });
    if (origEnv === undefined) delete process.env.MKCERT_CAROOT;
    else process.env.MKCERT_CAROOT = origEnv;
  });

  it('scrubs a CAROOT outside the server home for a non-loopback caller', async () => {
    process.env.MKCERT_CAROOT = foreignCaroot;
    const res = await request(makeLanApp()).get('/cert/root.crt');
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain('alice-secret');
    expect(res.body.probed.env).toBe('<path>');
  });

  it('keeps the full diagnostic for a loopback caller', async () => {
    process.env.MKCERT_CAROOT = foreignCaroot;
    const res = await request(makeApp()).get('/cert/root.crt');
    expect(res.status).toBe(404);
    expect(res.body.probed.env).toBe(foreignCaroot);
  });

  it('leaves no path in the other probes for a non-loopback caller', async () => {
    process.env.MKCERT_CAROOT = foreignCaroot;
    const res = await request(makeLanApp()).get('/cert/root.crt');
    const { mkcertCli, defaultForPlatform } = res.body.probed;
    expect(defaultForPlatform).toBe('<path>');
    if (mkcertCli !== null) {
      expect(mkcertCli).not.toContain('/');
      expect(mkcertCli).not.toContain(BACKSLASH);
      expect(mkcertCli).not.toMatch(/^[A-Za-z]:/);
    }
  });

  /* Non-absolute hand-typed values have no root scrubChildOutput recognises. */
  const nonAbsolute = [
    ['root-relative', BACKSLASH + ['Users', 'alice-secret', 'certs'].join(BACKSLASH)],
    ['drive-relative', 'C:' + ['Users', 'alice-secret', 'certs'].join(BACKSLASH)],
    ['dot-dot-relative', ['..', '..', 'Users', 'alice-secret', 'certs'].join(BACKSLASH)],
  ] as const;
  for (const [label, value] of nonAbsolute) {
    it(`scrubs a ${label} MKCERT_CAROOT for a LAN caller, raw for loopback`, async () => {
      process.env.MKCERT_CAROOT = value;
      const lan = await request(makeLanApp()).get('/cert/root.crt');
      expect(lan.status).toBe(404);
      expect(lan.body.probed.env).toBe('<path>');
      expect(JSON.stringify(lan.body)).not.toContain('alice-secret');
      const lo = await request(makeApp()).get('/cert/root.crt');
      expect(lo.body.probed.env).toBe(value);
    });
  }

  it('keeps probed.env null when MKCERT_CAROOT is unset', async () => {
    delete process.env.MKCERT_CAROOT;
    const res = await request(makeLanApp()).get('/cert/root.crt');
    expect(res.body.probed.env).toBeNull();
  });
});
