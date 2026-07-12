/* Plan 81 wave 1 — export-lan protocol switching.
 *
 * Asserts that the existing GET /api/export/lan endpoint emits HTTPS URLs
 * on port LAN_HTTPS_PORT when LAN_HTTPS=1 is set, and HTTP URLs on port
 * PORT otherwise. The pre-plan-81 default (no env vars) is the regression
 * baseline. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { enumerateLanUrls, exportLanRouter, isLanHttpsEnabled } from './export-lan.js';
import { setLanRuntime } from '../lan-runtime.js';

function makeApp(): Express {
  const app = express();
  app.use('/api/export', exportLanRouter);
  return app;
}

describe('enumerateLanUrls', () => {
  it('defaults to http when no protocol is passed', () => {
    const out = enumerateLanUrls(8080);
    expect(out.protocol).toBe('http');
    expect(out.port).toBe(8080);
    // URLs may be [] in CI sandboxes without LAN interfaces — only assert
    // the prefix when at least one is present.
    if (out.urls.length > 0) {
      expect(out.urls[0]).toMatch(/^http:\/\//);
    }
  });

  it('emits https URLs when protocol is "https"', () => {
    const out = enumerateLanUrls(8443, 'https');
    expect(out.protocol).toBe('https');
    expect(out.port).toBe(8443);
    if (out.urls.length > 0) {
      expect(out.urls[0]).toMatch(/^https:\/\//);
      expect(out.urls[0]).toContain(':8443');
    }
  });
});

describe('isLanHttpsEnabled', () => {
  const savedNodeEnv = process.env.NODE_ENV;
  beforeEach(() => {
    delete process.env.LAN_HTTPS;
  });
  afterEach(() => {
    delete process.env.LAN_HTTPS;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
  });

  it('defaults OFF outside production when env unset (dev/test keep plain HTTP)', () => {
    process.env.NODE_ENV = 'development';
    expect(isLanHttpsEnabled()).toBe(false);
  });
  it('defaults ON in production when env unset (installers get LAN by default)', () => {
    process.env.NODE_ENV = 'production';
    expect(isLanHttpsEnabled()).toBe(true);
  });
  it('explicit LAN_HTTPS=1 wins even outside production', () => {
    process.env.NODE_ENV = 'development';
    process.env.LAN_HTTPS = '1';
    expect(isLanHttpsEnabled()).toBe(true);
  });
  it('explicit LAN_HTTPS=0 wins even in production', () => {
    process.env.NODE_ENV = 'production';
    process.env.LAN_HTTPS = '0';
    expect(isLanHttpsEnabled()).toBe(false);
  });
  it('a non-0/1 value falls back to the NODE_ENV default', () => {
    process.env.LAN_HTTPS = 'true';
    process.env.NODE_ENV = 'development';
    expect(isLanHttpsEnabled()).toBe(false);
    process.env.NODE_ENV = 'production';
    expect(isLanHttpsEnabled()).toBe(true);
  });
});

describe('GET /api/export/lan — reflects the ACTUAL bound runtime, not the requested flag', () => {
  afterEach(() => {
    // reset to the module default (loopback HTTP)
    setLanRuntime({ httpsActive: false, port: 8080 });
  });

  it('returns http URLs on the bound port when the server degraded to loopback HTTP', async () => {
    setLanRuntime({ httpsActive: false, port: 8080 });
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('http');
    expect(res.body.port).toBe(8080);
  });

  it('returns https URLs on the bound LAN port when HTTPS is actually active', async () => {
    setLanRuntime({ httpsActive: true, port: 8443 });
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('https');
    expect(res.body.port).toBe(8443);
  });

  it('honours a non-default bound LAN port', async () => {
    setLanRuntime({ httpsActive: true, port: 9443 });
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('https');
    expect(res.body.port).toBe(9443);
  });

  it('the CRITICAL regression: LAN requested but certs missing → HTTP, never advertises https:8443', async () => {
    // requested flag on, but the server bound loopback HTTP because certs were absent
    process.env.LAN_HTTPS = '1';
    setLanRuntime({ httpsActive: false, port: 8080 });
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.body.protocol).toBe('http');
    expect(res.body.port).toBe(8080);
    delete process.env.LAN_HTTPS;
  });
});

describe('GET /api/export/lan — CORS-from-LAN-origin acceptance', () => {
  /* The endpoint is JSON, no auth, no body-handling — verify that an
     `Origin` header from a typical LAN address doesn't trip any existing
     middleware. Production runs same-origin (Node serves both bundle +
     API on the same port) so this is mostly a regression seatbelt:
     adding CORS lockdowns to other routes must not accidentally affect
     this one. */
  it('accepts requests from an https LAN origin', async () => {
    const res = await request(makeApp())
      .get('/api/export/lan')
      .set('Origin', 'https://192.168.1.50:8443');
    expect(res.status).toBe(200);
  });
});

describe('GET /api/export/lan — srv-20 pairing payload (token + caFingerprint)', () => {
  const origToken = process.env.LAN_AUTH_TOKEN;
  afterEach(() => {
    if (origToken === undefined) delete process.env.LAN_AUTH_TOKEN;
    else process.env.LAN_AUTH_TOKEN = origToken;
  });

  it('omits token when LAN_AUTH_TOKEN is unset', async () => {
    delete process.env.LAN_AUTH_TOKEN;
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
  });

  it('surfaces the token when LAN_AUTH_TOKEN is set', async () => {
    process.env.LAN_AUTH_TOKEN = 'pair-secret-123';
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.token).toBe('pair-secret-123');
  });

  it('omits token for an empty LAN_AUTH_TOKEN', async () => {
    process.env.LAN_AUTH_TOKEN = '';
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.token).toBeUndefined();
  });

  it('caFingerprint, when present, is a non-empty fingerprint string (best-effort)', async () => {
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    if (res.body.caFingerprint !== undefined) {
      expect(typeof res.body.caFingerprint).toBe('string');
      expect(res.body.caFingerprint.length).toBeGreaterThan(0);
    }
  });
});
