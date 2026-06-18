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
  vi.resetModules();
  deviceTokens = await import('../workspace/device-tokens.js');
  lanAuth = await import('../lan-auth.js');
  const { devicesRouter } = await import('./devices.js');
  app = express();
  app.use(express.json());
  app.use('/api', devicesRouter);
});

afterEach(async () => {
  delete process.env.WORKSPACE_DIR;
  delete process.env.LAN_HTTPS;
  delete process.env.LAN_AUTH_TOKEN;
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
});
