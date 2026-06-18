/* srv-33 — device-token route contract + LAN-guard integration, against a real
   temp workspace (mkdtemp + WORKSPACE_DIR + resetModules, mirroring
   backup.test.ts). supertest requests are loopback (the guard bypasses those),
   so the guard's accept/reject of a device token is driven directly through
   requireLanToken with a mocked non-loopback request. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('./export-lan.js', async (orig) => ({
  ...(await orig<typeof import('./export-lan.js')>()),
  enumerateLanUrls: () => ({ urls: ['https://192.168.1.7:8443'], port: 8443, protocol: 'https' }),
}));

/* Spread the real lan-auth module and override only the two gate functions with
   vi.fn so we can mock them per-test. requireLanToken is exposed as a forwarding
   wrapper so it always calls through to the freshly-imported REAL requireLanToken
   (which shares the same device-tokens module as deviceTokens, keeping
   isValidDeviceToken in sync with created device tokens). */
let _requireLanToken: typeof import('../lan-auth.js')['requireLanToken'] | null = null;
vi.mock('../lan-auth.js', async (o) => {
  const real = await o<typeof import('../lan-auth.js')>();
  return {
    ...real,
    isLoopbackRequest: vi.fn((req: Parameters<typeof real.isLoopbackRequest>[0]) =>
      real.isLoopbackRequest(req),
    ),
    isLanTokenEnforced: vi.fn(() => real.isLanTokenEnforced()),
    requireLanToken: (...args: Parameters<typeof real.requireLanToken>) =>
      (_requireLanToken ?? real.requireLanToken)(...args),
  };
});

let workspaceRoot: string;
let app: Express;
let deviceTokens: typeof import('../workspace/device-tokens.js');
let lanAuth: typeof import('../lan-auth.js');

function mkReq(opts: { ip?: string; headers?: Record<string, string> } = {}) {
  const ip = opts.ip ?? '203.0.113.5'; // non-loopback documentation range
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: opts.headers ?? {},
    query: {},
  } as never;
}
function mkRes() {
  const res = { statusCode: 200 };
  return {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    json() {
      return this;
    },
    _res: res,
  } as never as { _res: { statusCode: number } };
}

beforeEach(async () => {
  workspaceRoot = await mkdtemp(join(tmpdir(), 'devices-test-'));
  process.env.WORKSPACE_DIR = workspaceRoot;
  process.env.LAN_HTTPS = '1';
  process.env.LAN_AUTH_TOKEN = 'shared-secret';
  _requireLanToken = null;
  vi.resetModules();
  deviceTokens = await import('../workspace/device-tokens.js');
  lanAuth = await import('../lan-auth.js');
  // Load the real (un-mocked) lan-auth so requireLanToken shares the same
  // device-tokens instance as deviceTokens, keeping isValidDeviceToken in sync.
  const realLanAuth = await vi.importActual<typeof import('../lan-auth.js')>('../lan-auth.js');
  _requireLanToken = realLanAuth.requireLanToken;
  const { devicesRouter } = await import('./devices.js');
  app = express();
  app.use(express.json());
  app.use('/api', devicesRouter);
});

afterEach(async () => {
  _requireLanToken = null;
  delete process.env.WORKSPACE_DIR;
  delete process.env.LAN_HTTPS;
  delete process.env.LAN_AUTH_TOKEN;
  delete process.env.LAN_HTTPS_PORT;
  await rm(workspaceRoot, { recursive: true, force: true });
});

describe('devices route (srv-33)', () => {
  it('POST mints a device, returning the raw token exactly once', async () => {
    const res = await request(app).post('/api/devices').send({ label: 'Pixel' });
    expect(res.status).toBe(201);
    expect(res.body.label).toBe('Pixel');
    expect(typeof res.body.token).toBe('string');
    expect(res.body.token.length).toBeGreaterThan(20);
    expect(res.body.tokenHash).toBeUndefined();
    expect(res.body.id).toBeTruthy();
  });

  it('GET lists devices without exposing token material', async () => {
    await request(app).post('/api/devices').send({ label: 'A' });
    await request(app).post('/api/devices').send({ label: 'B' });
    const res = await request(app).get('/api/devices');
    expect(res.status).toBe(200);
    expect(res.body.devices.map((d: { label: string }) => d.label).sort()).toEqual(['A', 'B']);
    for (const d of res.body.devices) {
      expect(d.token).toBeUndefined();
      expect(d.tokenHash).toBeUndefined();
      expect(d.revoked).toBe(false);
    }
  });

  it('DELETE revokes a device (then it shows revoked); unknown id -> 404', async () => {
    const mk = await request(app).post('/api/devices').send({ label: 'Old' });
    const id = mk.body.id as string;
    expect((await request(app).delete(`/api/devices/${id}`)).status).toBe(200);
    const list = await request(app).get('/api/devices');
    expect(list.body.devices.find((d: { id: string }) => d.id === id).revoked).toBe(true);
    expect((await request(app).delete('/api/devices/nope')).status).toBe(404);
  });

  it('the LAN guard accepts a minted device token from a non-loopback client', async () => {
    const { token } = await deviceTokens.createDevice('Phone', 30);
    let passed = false;
    lanAuth.requireLanToken(
      mkReq({ headers: { authorization: `Bearer ${token}` } }),
      mkRes() as never,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(true);
  });

  it('the LAN guard rejects a revoked device token (but the shared secret still works)', async () => {
    const { device, token } = await deviceTokens.createDevice('Phone', 30);
    await deviceTokens.revokeDevice(device.id);

    const revokedRes = mkRes();
    let passed = false;
    lanAuth.requireLanToken(
      mkReq({ headers: { authorization: `Bearer ${token}` } }),
      revokedRes as never,
      () => {
        passed = true;
      },
    );
    expect(passed).toBe(false);
    expect(revokedRes._res.statusCode).toBe(401);

    // Legacy shared secret is unaffected.
    let sharedPassed = false;
    lanAuth.requireLanToken(
      mkReq({ headers: { authorization: 'Bearer shared-secret' } }),
      mkRes() as never,
      () => {
        sharedPassed = true;
      },
    );
    expect(sharedPassed).toBe(true);
  });

  it('pair-session returns a #/pair URL payload from loopback when enforced', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    expect(res.body.url).toMatch(/^https:\/\/192\.168\.1\.7:8443\/#\/pair\?c=[0-9A-HJKMNP-TV-Z]{16}$/);
    expect(typeof res.body.expiresAt).toBe('number');
  });

  it('pair-session 409s when LAN auth is not enforced', async () => {
    delete process.env.LAN_AUTH_TOKEN;
    process.env.LAN_HTTPS = '1';
    vi.mocked(lanAuth.isLanTokenEnforced).mockReturnValueOnce(false);
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'x' });
    expect(res.status).toBe(409);
  });

  it('admin mint POST /api/devices is loopback-only (403 from a non-loopback request)', async () => {
    // Under supertest req.ip is loopback, so mock the gate to simulate a LAN client.
    vi.mocked(lanAuth.isLoopbackRequest).mockReturnValueOnce(false);
    const res = await request(app).post('/api/devices').send({ label: 'x' });
    expect(res.status).toBe(403);
  });
});
