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

vi.mock('../lan-auth.js', () => ({ isLoopbackRequest: vi.fn(() => true) }));
vi.mock('./export-lan.js', async (orig) => {
  const real = await orig<typeof import('./export-lan.js')>();
  return {
    ...real,
    isLanHttpsEnabled: () => true,
    enumerateLanUrls: () => ({ urls: ['https://192.168.1.5:8443'], port: 8443, protocol: 'https' as const }),
  };
});
vi.mock('./cert-root.js', () => ({ resolveRootCaPath: () => ({ path: 'FAKE', source: 'default' as const }) }));
vi.mock('node:fs', async (orig) => {
  const real = await orig<typeof import('node:fs')>();
  return { ...real, readFileSync: (p: unknown, ...rest: unknown[]) =>
    p === 'FAKE' ? Buffer.from(TEST_CERT_PEM) : (real.readFileSync as any)(p, ...rest) };
});
vi.mock('../workspace/device-tokens.js', () => ({
  createDevice: vi.fn(async (label: string) => ({ device: { id: 'd1', label, createdAt: '', revoked: false }, token: 'tok_test' })),
}));

import { pairSessionRouter, pairRedeemRouter } from './pairing.js';
import { _resetPairingSessionsForTests } from '../workspace/pairing-sessions.js';
import { isLoopbackRequest } from '../lan-auth.js';

function appWith(router: express.Router) {
  const app = express();
  app.use(express.json());
  app.use('/api/pair', router);
  return app;
}

describe('pairing routes', () => {
  beforeEach(() => _resetPairingSessionsForTests());

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
});
