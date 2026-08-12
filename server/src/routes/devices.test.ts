/* srv-33 — device-token route contract + LAN-guard integration, against a real
   temp workspace (mkdtemp + WORKSPACE_DIR + resetModules, mirroring
   backup.test.ts). supertest requests are loopback (the guard bypasses those),
   so the guard's accept/reject of a device token is driven directly through
   requireLanToken with a mocked non-loopback request. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';
import type { Express } from 'express';

vi.mock('./export-lan.js', async (orig) => ({
  ...(await orig<typeof import('./export-lan.js')>()),
  enumerateLanUrls: () => ({ urls: ['https://192.168.1.7:8443'], port: 8443, protocol: 'https' }),
}));

// pair-session reads the ACTUAL bound runtime; mock it (vi.fn so a test can flip
// httpsActive to exercise the not-lan-https degrade branch). Survives vi.resetModules().
vi.mock('../lan-runtime.js', () => ({
  getLanRuntime: vi.fn(() => ({ httpsActive: true, port: 8443 })),
  setLanRuntime: () => {},
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
let pairingSessions: typeof import('../workspace/pairing-sessions.js');
let devicesRouter: import('express').Router;

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
  ({ devicesRouter } = await import('./devices.js'));
  pairingSessions = await import('../workspace/pairing-sessions.js');
  app = express();
  app.use(express.json());
  app.use('/api', devicesRouter);
});

afterEach(async () => {
  _requireLanToken = null;
  // Flush any fire-and-forget touchLastSeen write isValidDeviceToken kicked
  // off (e.g. the "accepts a minted device token" test below) before wiping
  // the workspace — otherwise the in-flight write can race the recursive rm
  // and intermittently fail with ENOTEMPTY.
  await deviceTokens._flushPendingWritesForTests();
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

  // #2204 review (F2/F7) — a degraded store must answer 503 with an
  // actionable message, not the shape of a genuine result: a 404 "Unknown
  // device." claims the credential never existed when the truth is "can't
  // currently read the store; that device may still be valid and
  // authenticating." Corrupting the file directly (rather than mocking the
  // module) exercises the real route -> device-tokens.js -> loadSync path.
  it('DELETE answers 503 (not 404) when the device store is degraded', async () => {
    await writeFile(join(workspaceRoot, 'device-tokens.json'), '{ this is not json', 'utf8');
    deviceTokens._resetDeviceTokenCacheForTests();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).delete('/api/devices/any-id');
    warn.mockRestore();

    expect(res.status).toBe(503);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  // #2204 review (F2/F7) — a degraded store must not present as an
  // authoritative, genuinely-empty roster (200 {devices: []}).
  it('GET answers 503 (not 200 with an empty list) when the device store is degraded', async () => {
    await writeFile(join(workspaceRoot, 'device-tokens.json'), '{ this is not json', 'utf8');
    deviceTokens._resetDeviceTokenCacheForTests();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/devices');
    warn.mockRestore();

    expect(res.status).toBe(503);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
  });

  // #2204 review (F2/F7) — the mint route's degraded-store failure used to
  // reach the generic errorHandler and come back as an opaque 500 with no
  // usable message; it now answers 503 with the same actionable message.
  it('POST answers 503 (not an opaque 500) when the device store is degraded', async () => {
    await writeFile(join(workspaceRoot, 'device-tokens.json'), '{ this is not json', 'utf8');
    deviceTokens._resetDeviceTokenCacheForTests();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).post('/api/devices').send({ label: 'Phone' });
    warn.mockRestore();

    expect(res.status).toBe(503);
    expect(typeof res.body.error).toBe('string');
    expect(res.body.error.length).toBeGreaterThan(0);
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

  it('pair-session includes a friendlyUrl when mdns and forwarder are both live', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    app.set('friendlyHostnameLiveness', () => ({ mdns: true, forwarder: true }));
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    expect(res.body.friendlyUrl).toMatch(/^https:\/\/castwright\.local\/#\/pair\?c=[0-9A-HJKMNP-TV-Z]{16}$/);
  });

  // #2258 — mDNS alive but the :443 forwarder down still yields a usable
  // friendly URL, carrying the actual bound port rather than disappearing.
  it('pair-session carries the bound port when mdns is live but the forwarder is down', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    app.set('friendlyHostnameLiveness', () => ({ mdns: true, forwarder: false }));
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    const { port } = vi.mocked(await import('../lan-runtime.js')).getLanRuntime();
    expect(res.body.friendlyUrl).toMatch(
      new RegExp(`^https://castwright\\.local:${port}/#/pair\\?c=[0-9A-HJKMNP-TV-Z]{16}$`),
    );
  });

  it('pair-session omits friendlyUrl when mdns is down, regardless of forwarder state', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    app.set('friendlyHostnameLiveness', () => ({ mdns: false, forwarder: true }));
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    expect(res.body.friendlyUrl).toBeUndefined();
  });

  it('pair-session omits friendlyUrl when the getter was never set (a bare test app that skipped app.set — not any real server mode, which always sets it via the shared listenerCallback)', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'Mike phone' });
    expect(res.status).toBe(200);
    expect(res.body.friendlyUrl).toBeUndefined();
  });

  it('pair-session 409s not-lan-https when HTTPS is not actually bound (cert-less degrade)', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    const { getLanRuntime } = await import('../lan-runtime.js');
    vi.mocked(getLanRuntime).mockReturnValueOnce({ httpsActive: false, port: 8080 });
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'x' });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('not-lan-https');
  });

  it('pair-session 409s when LAN auth is not enforced', async () => {
    delete process.env.LAN_AUTH_TOKEN;
    process.env.LAN_HTTPS = '1';
    vi.mocked(lanAuth.isLanTokenEnforced).mockReturnValueOnce(false);
    const res = await request(app).post('/api/devices/pair-session').send({ label: 'x' });
    expect(res.status).toBe(409);
  });

  // #2257 — NOT a friendly-hostname-arm case: `mayStartPairingSession` comes
  // through the mock factory's `...real` spread (only isLoopbackRequest and
  // isLanTokenEnforced are individually wrapped), so its own internal call to
  // isLoopbackRequest resolves lexically inside lan-auth.ts and never sees
  // this mock. supertest's connection is genuinely loopback, so
  // mayStartPairingSession admits this request via its TRUE loopback arm
  // regardless of the mock below. What this test actually pins:
  // `mockReturnValueOnce(false)` is consumed only by devices.ts:113's own
  // selfBind computation, which re-derives isLoopbackRequest independently
  // rather than trusting mayStartPairingSession's verdict — so faking that
  // one call to false must still suppress selfBind even though the request
  // both passed the gate and, in reality, is loopback. See the dedicated
  // friendly-hostname-arm test below for the actual :443-forwarder attack
  // this conjunct exists to stop.
  it('pair-session with isLoopbackRequest faked false at the selfBind check produces a session that does not self-bind on redeem (#2257)', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    vi.mocked(lanAuth.isLoopbackRequest).mockReturnValueOnce(false);
    const res = await request(app)
      .post('/api/devices/pair-session')
      .send({ label: 'This computer', selfBind: true });
    expect(res.status).toBe(200);

    const result = pairingSessions.redeemPairingSession(res.body.code);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selfBind).toBe(false);
  });

  // Sanity counterpart — a genuinely loopback caller sending selfBind:true
  // DOES get a self-binding session (the isLoopbackRequest mock forwards to
  // the real implementation by default, and supertest requests are loopback).
  it('pair-session from a loopback caller with selfBind:true DOES produce a self-binding session', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';
    const res = await request(app)
      .post('/api/devices/pair-session')
      .send({ label: 'This computer', selfBind: true });
    expect(res.status).toBe(200);

    const result = pairingSessions.redeemPairingSession(res.body.code);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selfBind).toBe(true);
  });

  // #2257 (security case, real attack) — the actual :443-forwarder scenario the
  // loopback conjunct exists to stop: an already-paired device reaching the
  // server through the forwarder lands with peer IP 127.0.0.2 (never loopback)
  // and Host castwright.local, which is exactly what admits it through
  // mayStartPairingSession's friendly-hostname arm (isLanTokenEnforced() &&
  // isFriendlyHostnameRequest(req)) rather than the loopback arm. supertest's
  // real TCP connection can't be made to present that peer IP, so this drives
  // devicesRouter directly with a fabricated request/response instead of going
  // through HTTP — the same `mkReq({ ip, host })` shape
  // lan-auth.pairing.test.ts:44 already uses for this exact case.
  it('pair-session reached via the friendly hostname (peer 127.0.0.2, Host castwright.local) with selfBind:true does not self-bind on redeem (#2257 security case)', async () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    process.env.LAN_HTTPS_PORT = '8443';

    const req = {
      method: 'POST',
      url: '/devices/pair-session',
      ip: '127.0.0.2',
      socket: { remoteAddress: '127.0.0.2' },
      headers: { host: 'castwright.local' },
      body: { label: 'This computer', selfBind: true },
      app: { get: () => undefined },
      query: {},
    } as never;
    let status = 200;
    let body: { code?: string } = {};
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload as { code?: string };
        return this;
      },
    } as never;
    let nextErr: unknown;
    devicesRouter(req, res, (err?: unknown) => {
      nextErr = err;
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (nextErr) throw nextErr;

    expect(status).toBe(200);
    const result = pairingSessions.redeemPairingSession(body.code as string);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.selfBind).toBe(false);
  });

  // #2278 review round 3, Finding 4 — devices.ts:82's 403 body
  // (`{ error: pairingOriginHint() }`) had NO assertion anywhere in this
  // file. mayStartPairingSession's own internal isLoopbackRequest /
  // isFriendlyHostnameRequest checks resolve lexically inside lan-auth.ts
  // (same reason the mock above can't move its verdict — see the comment on
  // the friendly-hostname test above), and supertest's connection is always
  // loopback, so genuinely tripping this branch needs the same
  // drive-the-router-directly technique with a fabricated non-loopback,
  // non-friendly-hostname request.
  it('pair-session 403s a genuinely non-loopback, non-friendly-hostname caller, with pairingOriginHint()\'s port-correct body', async () => {
    // #2278 review round 4, Finding 5 — a NON-default port. Asserted against
    // the file-level 8443 mock, this test passed unchanged against the
    // pre-#2278 hardcoded const and so proved nothing about the port being
    // dynamic. mayStartPairingSession runs first and reads no runtime, so
    // pairingOriginHint() is the first (and only) consumer of this Once.
    const { getLanRuntime } = await import('../lan-runtime.js');
    vi.mocked(getLanRuntime).mockReturnValueOnce({ httpsActive: true, port: 9443 });
    const req = {
      method: 'POST',
      url: '/devices/pair-session',
      ip: '203.0.113.5',
      socket: { remoteAddress: '203.0.113.5' },
      headers: { host: '203.0.113.5' },
      body: { label: 'x' },
      app: { get: () => undefined },
      query: {},
    } as never;
    let status = 200;
    let body: { error?: string } = {};
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload as { error?: string };
        return this;
      },
    } as never;
    let nextErr: unknown;
    devicesRouter(req, res, (err?: unknown) => {
      nextErr = err;
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (nextErr) throw nextErr;

    expect(status).toBe(403);
    expect(body.error).toBe(
      'Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
    );
  });

  it('admin mint POST /api/devices is loopback-only (403 from a non-loopback request)', async () => {
    // Under supertest req.ip is loopback, so mock the gate to simulate a LAN client.
    vi.mocked(lanAuth.isLoopbackRequest).mockReturnValueOnce(false);
    const res = await request(app).post('/api/devices').send({ label: 'x' });
    expect(res.status).toBe(403);
  });

  // #2269 — revoke is loopback-only, symmetric with mint: a non-loopback
  // caller must be refused, and the record must survive the attempt (a 403
  // with the write already done would pass a status-only assertion).
  it('DELETE /api/devices/:id is loopback-only (403 from a non-loopback request, record stays live)', async () => {
    const mk = await request(app).post('/api/devices').send({ label: 'Phone' });
    const id = mk.body.id as string;

    vi.mocked(lanAuth.isLoopbackRequest).mockReturnValueOnce(false);
    const res = await request(app).delete(`/api/devices/${id}`);
    expect(res.status).toBe(403);

    const list = await request(app).get('/api/devices');
    const device = list.body.devices.find((d: { id: string }) => d.id === id);
    expect(device).toBeTruthy();
    expect(device.revoked).toBe(false);
  });

  // #2269 (real attacker case, review round 2) — the test above only proves the
  // handler CONSULTS isLoopbackRequest; it mocks the verdict, so it stays green
  // even if a future "fix" widened LOOPBACK (server/src/lan-auth.ts) to admit
  // the :443 forwarder's peer 127.0.0.2 — which would re-open exactly the hole
  // #2269 closed, since a LAN device reaching the app via castwright.local or
  // the bare :443 forwarder presents that same peer IP. This drives the REAL
  // isLoopbackRequest against a fabricated request carrying that peer + Host,
  // the same shape as the pair-session security case above (#2257) and
  // lan-auth.pairing.test.ts's `mkReq` — supertest's real TCP connection can't
  // be made to present that peer IP. Asserts the 403 BODY too, not just the
  // status, since openapi.yaml now promises a specific message shape.
  it('DELETE reached via the friendly hostname (peer 127.0.0.2, Host castwright.local) is refused, with the record surviving and the 403 body intact (#2269 security case)', async () => {
    const mk = await request(app).post('/api/devices').send({ label: 'Phone' });
    const id = mk.body.id as string;

    const req = {
      method: 'DELETE',
      url: `/devices/${id}`,
      ip: '127.0.0.2',
      socket: { remoteAddress: '127.0.0.2' },
      headers: { host: 'castwright.local' },
      app: { get: () => undefined },
      query: {},
    } as never;
    let status = 200;
    let body: { error?: string } = {};
    const res = {
      status(code: number) {
        status = code;
        return this;
      },
      json(payload: unknown) {
        body = payload as { error?: string };
        return this;
      },
    } as never;
    let nextErr: unknown;
    devicesRouter(req, res, (err?: unknown) => {
      nextErr = err;
    });
    await new Promise((resolve) => setImmediate(resolve));
    if (nextErr) throw nextErr;

    expect(status).toBe(403);
    expect(body.error).toBe('Devices can only be revoked from the host UI.');

    const list = await request(app).get('/api/devices');
    const device = list.body.devices.find((d: { id: string }) => d.id === id);
    expect(device).toBeTruthy();
    expect(device.revoked).toBe(false);
  });

  // Sanity counterpart — a genuinely loopback caller can still revoke.
  // isLoopbackRequest's mock forwards to the real implementation by default,
  // and supertest requests are loopback.
  it('DELETE /api/devices/:id still succeeds from a loopback caller', async () => {
    const mk = await request(app).post('/api/devices').send({ label: 'Phone' });
    const id = mk.body.id as string;

    const res = await request(app).delete(`/api/devices/${id}`);
    expect(res.status).toBe(200);

    const list = await request(app).get('/api/devices');
    expect(list.body.devices.find((d: { id: string }) => d.id === id).revoked).toBe(true);
  });

  it('caps an over-long device label at 64 chars', async () => {
    const { device } = await deviceTokens.createDevice('x'.repeat(200), 30);
    expect(device.label.length).toBe(64);
  });

  // #2183 — a non-string label (e.g. a hand-edited store, or a future writer
  // bug) is coerced at load, not dropped: it's a display fault, not a
  // security/lifecycle one, so the device stays usable and revocable.
  // Asserted against the raw HTTP response body (not deviceTokens'
  // in-memory PublicDevice) per the #2183 decision comment's correction:
  // redactDevice sets `label`/`id` unconditionally, so an in-memory
  // assertion can pass for the wrong reason where the serialised body would
  // not — this also folds in the openapi Device required-key check for the
  // same reason (see below).
  it('a record with a non-string label is served as a coerced string, and stays revocable (#2183)', async () => {
    const raw = {
      id: 'bad-label',
      label: { evil: true },
      tokenHash: deviceTokens.hashToken('bad-label-token'),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    };
    await writeFile(
      join(workspaceRoot, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [raw] }),
      'utf8',
    );
    deviceTokens._resetDeviceTokenCacheForTests();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/devices');
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.devices).toHaveLength(1);
    expect(typeof res.body.devices[0].label).toBe('string');
    expect(res.body.devices[0].label).toBe('Unnamed device');

    const del = await request(app).delete(`/api/devices/${res.body.devices[0].id}`);
    expect(del.status).toBe(200);
  });

  // #2183 — every device GET /api/devices serves must satisfy openapi.yaml's
  // Device schema `required: [id, label, createdAt, revoked]`. Asserted on
  // the ACTUAL SERIALISED response body, per the decision comment's
  // correction: redactDevice sets `id`/`label` unconditionally (not
  // spread-guarded like expiresAt/lastSeenAt), so an id-less in-memory
  // PublicDevice still carries an `id: undefined` OWN property —
  // `hasOwnProperty` on that in-memory object would pass even though the key
  // vanishes over the wire at JSON.stringify time. Seeding an id-less raw
  // record directly (bypassing the normal mint path) is what makes this
  // genuinely red pre-fix: before #2183, loadSync never validated `id`, so
  // the id-less record survived to redactDevice and was served with its
  // `id` key silently missing over the wire. After #2183, it's dropped at
  // load and never reaches this response at all.
  it('every device served by GET /api/devices satisfies the openapi Device required key list [id, label, createdAt, revoked] (#2183)', async () => {
    const idless = {
      label: 'No id',
      tokenHash: deviceTokens.hashToken('idless-token'),
      createdAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    }; // deliberately no `id` field
    await writeFile(
      join(workspaceRoot, 'device-tokens.json'),
      JSON.stringify({ schema: 2, devices: [idless] }),
      'utf8',
    );
    deviceTokens._resetDeviceTokenCacheForTests();
    await request(app).post('/api/devices').send({ label: 'Normal' });

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const res = await request(app).get('/api/devices');
    warn.mockRestore();
    expect(res.status).toBe(200);
    expect(res.body.devices.length).toBeGreaterThan(0);
    for (const d of res.body.devices as Record<string, unknown>[]) {
      for (const key of ['id', 'label', 'createdAt', 'revoked']) {
        expect(Object.prototype.hasOwnProperty.call(d, key)).toBe(true);
      }
    }
  });
});
