import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// A real self-signed cert (parses via node X509Certificate). Its SHA-256's
// first 10 bytes Crockford-base32-encode to fpTag "5CEE77RAKV3EN9JX".
const TEST_CERT_PEM = `-----BEGIN CERTIFICATE-----
MIIDFTCCAf2gAwIBAgIUIbK4LygapM3JSNcloQ29h8z5Ms8wDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPY2FzdHdyaWdodC10ZXN0MB4XDTI2MDYwOTIzNTQxN1oX
DTI2MDYxMTIzNTQxN1owGjEYMBYGA1UEAwwPY2FzdHdyaWdodC10ZXN0MIIBIjAN
BgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAzIoO0K/L5PyJR8uRFWD3dsa5ZS6R
MM6BHuY4xS2wNYY9fuOdtWrtJp/8knyCtIhiC4+2+zDr2t6zDjqiSQpM9anMJr3E
NuDf82ktDh4Skp8VgYX4tBgQs0VWQiajNVamzWlPRzzUqNzxcF7nDT+IkEOpS8Cp
xQqOsekThL5NF+IpGvnGdFN5c60sM7z4qGW6w2Mv5XmGLJwINh3e7YWT/3YKsIO5
9rvWAwJwSohDPp2Qm1AQxmiiTE10VkH8v9uO+yJdH3c/bwhG2iRqRNtwf18oMsWu
KImB6gkpOtfuR5+ywq1dM29KkbdJncwIrDLvBE2NBo7ewUrrndeJLBaI1wIDAQAB
o1MwUTAdBgNVHQ4EFgQUPla1YM1+g1R0FJ/DVZGyTAjR46cwHwYDVR0jBBgwFoAU
Pla1YM1+g1R0FJ/DVZGyTAjR46cwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0B
AQsFAAOCAQEAeTjntz2jONNLfye5xRrwopx9dzWanMMhWYaOLxiH7ZmwoJoWyHKS
QYwuSJjkBXvZvjxjVFHbTLujh6+b7foab1N5cCdyXai4PkF11G4cWFQ+x+T0c+vi
gU7diabXdmGyVCUhCYkFGYyJe9lplB7Cgn7rUEE2QobzZfvMvR8UtOzPT5e1HYFm
F9h2gi5FCdQ5/HtykuO5+p58OP6mDHIzyGX36GdI7DuIh/CPq7IHicBW3r7xgACQ
YnfkDgmHygMhGW3R2KBwRjyVnnbUz4Flys3JKquOG+QXQeAnTWrbJymzHa/USSjs
mXs+glZrizT6pLoIQQucbslLc15G85a7tw==
-----END CERTIFICATE-----`;

vi.mock('../lan-auth.js', () => ({
  isLoopbackRequest: vi.fn(() => true),
  isLanTokenEnforced: vi.fn(() => true),
  isPrivateNetworkRequest: vi.fn(() => true),
  // requireLanToken must be present so app.ts can mount it; the body-size tests
  // use pairRedeemRouter (pre-guard), so the guard never fires for them.
  requireLanToken: vi.fn((_req: unknown, _res: unknown, next: () => void) => next()),
  getLanAuthToken: vi.fn(() => undefined),
  extractToken: vi.fn(() => undefined),
  readCwLanCookie: vi.fn(() => undefined),
}));
vi.mock('./export-lan.js', async (orig) => {
  const real = await orig<typeof import('./export-lan.js')>();
  return {
    ...real,
    isLanHttpsEnabled: () => true,
    enumerateLanUrls: () => ({ urls: ['https://192.168.1.5:8443'], port: 8443, protocol: 'https' as const }),
  };
});
vi.mock('./cert-root.js', () => ({ resolveRootCaPath: () => ({ path: 'FAKE', source: 'default' as const }) }));
vi.mock('../config/resolver.js', () => ({ configValue: (_key: string) => 30 }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return { ...real, readFileSync: (p: unknown, ...rest: unknown[]) =>
    p === 'FAKE' ? Buffer.from(TEST_CERT_PEM) : (real.readFileSync as any)(p, ...rest) };
});
vi.mock('../workspace/device-tokens.js', () => ({
  createDevice: vi.fn(async (label: string, ttlDays: number) => ({
    device: {
      id: 'd1',
      label,
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + ttlDays * 86_400_000).toISOString(),
      revoked: false,
    },
    token: 'tok_test',
  })),
  clampTtlDays: (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 ? v : 30),
}));

import { pairSessionRouter, pairRedeemRouter, browserRedeemLimiter } from './pairing.js';
import { _resetPairingSessionsForTests, createPairingSession } from '../workspace/pairing-sessions.js';
import { isLoopbackRequest, isLanTokenEnforced, isPrivateNetworkRequest } from '../lan-auth.js';

function appWith(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/api/pair', router);
  return app;
}

describe('pairing routes', () => {
  beforeEach(() => {
    _resetPairingSessionsForTests();
    browserRedeemLimiter.resetKey('::ffff:127.0.0.1');
  });

  it('POST /session returns a qrPayload + code + fpTag', async () => {
    const res = await request(appWith(pairSessionRouter)).post('/api/pair/session').send({});
    expect(res.status).toBe(200);
    expect(res.body.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(res.body.fpTag).toBe('5CEE77RAKV3EN9JXTB2C9QD4JW');
    expect(res.body.hostPort).toBe('192.168.1.5:8443');
    expect(res.body.qrPayload).toBe(
      `https://www.castwright.ai/pair?h=192.168.1.5%3A8443&c=${res.body.code}&f=5CEE77RAKV3EN9JXTB2C9QD4JW`,
    );
    expect(res.body.expiresAt).toBeGreaterThan(0);
  });

  it('POST /redeem mints a token for a fresh code, then 410 on reuse', async () => {
    const session = await request(appWith(pairSessionRouter)).post('/api/pair/session').send({});
    const redeem = appWith(pairRedeemRouter);
    const first = await request(redeem).post('/api/pair/redeem').send({ code: session.body.code, label: 'Pixel' });
    expect(first.status).toBe(201);
    expect(first.body.token).toBe('tok_test');
    const second = await request(redeem).post('/api/pair/redeem').send({ code: session.body.code });
    expect(second.status).toBe(410);
  });

  it('POST /redeem 401s an unknown code', async () => {
    const res = await request(appWith(pairRedeemRouter)).post('/api/pair/redeem').send({ code: 'ZZZZZZZZ' });
    expect(res.status).toBe(401);
  });

  it('POST /session 403s a non-loopback caller', async () => {
    vi.mocked(isLoopbackRequest).mockReturnValueOnce(false);
    const res = await request(appWith(pairSessionRouter)).post('/api/pair/session').send({});
    expect(res.status).toBe(403);
  });

  it('redeem-browser sets the __Host-cw_lan cookie and returns no raw token', async () => {
    const { code } = createPairingSession('Mike phone', undefined, 10);
    const res = await request(appWith(pairRedeemRouter)).post('/api/pair/redeem-browser').send({ code });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty('label', 'Mike phone');
    expect(res.body).toHaveProperty('expiresAt');
    expect(res.body).not.toHaveProperty('token');
    const setCookie = String(res.headers['set-cookie'] ?? '');
    expect(setCookie).toMatch(/__Host-cw_lan=tok_test/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    expect(setCookie).toMatch(/Secure/i);
  });

  it('redeem-browser 409s when LAN auth not enforced', async () => {
    vi.mocked(isLanTokenEnforced).mockReturnValueOnce(false);
    const { code } = createPairingSession('x', undefined, 10);
    const res = await request(appWith(pairRedeemRouter)).post('/api/pair/redeem-browser').send({ code });
    expect(res.status).toBe(409);
  });

  it('redeem-browser rate-limits after 5/min', async () => {
    for (let i = 0; i < 5; i++) await request(appWith(pairRedeemRouter)).post('/api/pair/redeem-browser').send({ code: 'WRONGWRONGWRONG1' });
    const res = await request(appWith(pairRedeemRouter)).post('/api/pair/redeem-browser').send({ code: 'WRONGWRONGWRONG1' });
    expect(res.status).toBe(429);
  });

  it('POST /redeem 403s a non-private caller', async () => {
    vi.mocked(isPrivateNetworkRequest).mockReturnValueOnce(false);
    const session = await request(appWith(pairSessionRouter)).post('/api/pair/session').send({});
    const res = await request(appWith(pairRedeemRouter))
      .post('/api/pair/redeem').send({ code: session.body.code });
    expect(res.status).toBe(403);
  });

  it('redeem-browser 403s a non-private caller', async () => {
    vi.mocked(isPrivateNetworkRequest).mockReturnValueOnce(false);
    const { code } = createPairingSession('x', undefined, 10);
    const res = await request(appWith(pairRedeemRouter)).post('/api/pair/redeem-browser').send({ code });
    expect(res.status).toBe(403);
  });
});

// Body-size enforcement tests — reproduce the parser-order bug by building a
// minimal app that mimics app.ts: global 20MB parser THEN pairRedeemRouter.
// Before the fix: the global parser swallows the body; the per-route 1KB parser
// sees req._body already set and early-returns → large bodies are accepted (no 413).
// After the fix: pairRedeemRouter is mounted BEFORE the global parser, so its own
// per-route 1KB parsers engage first → large bodies are rejected with 413.
function appReproducingGlobalParserFirst() {
  const a = express();
  // Mimics app.ts pre-fix: global 20MB parser runs before pairRedeemRouter is mounted.
  a.use(express.json({ limit: '20mb' }));
  a.use('/api/pair', pairRedeemRouter);
  return a;
}

function appWithPreGuardRouterFirst() {
  const a = express();
  // Mimics app.ts post-fix: pairRedeemRouter mounted BEFORE global parser.
  a.use('/api/pair', pairRedeemRouter);
  a.use(express.json({ limit: '20mb' }));
  return a;
}

describe('pairing body-size cap — parser-order regression', () => {
  beforeEach(() => {
    _resetPairingSessionsForTests();
    browserRedeemLimiter.resetKey('::ffff:127.0.0.1');
  });

  // These two tests FAIL before the fix (global parser accepts the body, no 413)
  // and PASS after the fix (pairRedeemRouter is pre-guard with its own 1KB parser).
  it('POST /api/pair/redeem-browser rejects a body > 1KB with 413', async () => {
    const res = await request(appWithPreGuardRouterFirst())
      .post('/api/pair/redeem-browser')
      .send({ code: 'x'.repeat(2000) });
    expect(res.status).toBe(413);
  });

  it('POST /api/pair/redeem rejects a body > 1KB with 413', async () => {
    const res = await request(appWithPreGuardRouterFirst())
      .post('/api/pair/redeem')
      .send({ code: 'x'.repeat(2000) });
    expect(res.status).toBe(413);
  });

  // Sanity check: the bug is real — global-first layout accepts the oversized body.
  it('global-parser-first layout (pre-fix shape) accepts an oversized body (no 413)', async () => {
    const res = await request(appReproducingGlobalParserFirst())
      .post('/api/pair/redeem-browser')
      .send({ code: 'x'.repeat(2000) });
    // Anything but 413 — the 1KB route-level parser is a no-op when body already parsed.
    expect(res.status).not.toBe(413);
  });
});
