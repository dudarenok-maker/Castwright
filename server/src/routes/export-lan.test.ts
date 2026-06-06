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
  beforeEach(() => {
    delete process.env.LAN_HTTPS;
  });
  afterEach(() => {
    delete process.env.LAN_HTTPS;
  });

  it('is false when env unset', () => {
    expect(isLanHttpsEnabled()).toBe(false);
  });
  it('is true when LAN_HTTPS=1', () => {
    process.env.LAN_HTTPS = '1';
    expect(isLanHttpsEnabled()).toBe(true);
  });
  it('is false for any other LAN_HTTPS value', () => {
    process.env.LAN_HTTPS = 'true';
    expect(isLanHttpsEnabled()).toBe(false);
    process.env.LAN_HTTPS = 'yes';
    expect(isLanHttpsEnabled()).toBe(false);
  });
});

describe('GET /api/export/lan — protocol switching', () => {
  const originalPort = process.env.PORT;
  const originalLanHttps = process.env.LAN_HTTPS;
  const originalLanHttpsPort = process.env.LAN_HTTPS_PORT;

  afterEach(() => {
    process.env.PORT = originalPort;
    if (originalLanHttps === undefined) delete process.env.LAN_HTTPS;
    else process.env.LAN_HTTPS = originalLanHttps;
    if (originalLanHttpsPort === undefined) delete process.env.LAN_HTTPS_PORT;
    else process.env.LAN_HTTPS_PORT = originalLanHttpsPort;
  });

  it('returns http URLs on PORT (default 8080) when LAN_HTTPS is unset', async () => {
    delete process.env.LAN_HTTPS;
    delete process.env.LAN_HTTPS_PORT;
    process.env.PORT = '8080';
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('http');
    expect(res.body.port).toBe(8080);
  });

  it('returns https URLs on LAN_HTTPS_PORT (default 8443) when LAN_HTTPS=1', async () => {
    process.env.LAN_HTTPS = '1';
    delete process.env.LAN_HTTPS_PORT; // use default 8443
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('https');
    expect(res.body.port).toBe(8443);
  });

  it('honours LAN_HTTPS_PORT override', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_HTTPS_PORT = '9443';
    const res = await request(makeApp()).get('/api/export/lan');
    expect(res.status).toBe(200);
    expect(res.body.protocol).toBe('https');
    expect(res.body.port).toBe(9443);
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
