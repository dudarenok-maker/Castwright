/* srv-20 — LAN shared-secret token guard. Unit-tests the middleware
   against mocked req/res so no HTTP server is needed. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./workspace/device-tokens.js', () => ({
  isValidDeviceToken: (t: string) => t === 'goodtoken',
}));

import {
  requireLanToken,
  isLanTokenEnforced,
  extractToken,
  getLanAuthToken,
} from './lan-auth.js';

interface ReqOpts {
  ip?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
}
function mkReq(opts: ReqOpts = {}) {
  const ip = opts.ip ?? '203.0.113.5'; // documentation range — non-loopback by default
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: opts.headers ?? {},
    query: opts.query ?? {},
  } as never;
}
function mkRes() {
  const res = { statusCode: 200, body: undefined as unknown };
  return {
    status(code: number) {
      res.statusCode = code;
      return this;
    },
    json(b: unknown) {
      res.body = b;
      return this;
    },
    _res: res,
  } as never as { _res: { statusCode: number; body: unknown } };
}

describe('lan-auth (srv-20)', () => {
  const origHttps = process.env.LAN_HTTPS;
  const origToken = process.env.LAN_AUTH_TOKEN;
  afterEach(() => {
    if (origHttps === undefined) delete process.env.LAN_HTTPS;
    else process.env.LAN_HTTPS = origHttps;
    if (origToken === undefined) delete process.env.LAN_AUTH_TOKEN;
    else process.env.LAN_AUTH_TOKEN = origToken;
  });

  it('is OFF unless LAN mode AND a token are both set', () => {
    delete process.env.LAN_HTTPS;
    delete process.env.LAN_AUTH_TOKEN;
    expect(isLanTokenEnforced()).toBe(false);
    process.env.LAN_HTTPS = '1';
    expect(isLanTokenEnforced()).toBe(false); // no token
    process.env.LAN_AUTH_TOKEN = 'secret';
    expect(isLanTokenEnforced()).toBe(true);
    process.env.LAN_HTTPS = '0';
    expect(isLanTokenEnforced()).toBe(false); // not LAN mode
  });

  it('getLanAuthToken treats empty/unset as no token', () => {
    delete process.env.LAN_AUTH_TOKEN;
    expect(getLanAuthToken()).toBeUndefined();
    process.env.LAN_AUTH_TOKEN = '';
    expect(getLanAuthToken()).toBeUndefined();
    process.env.LAN_AUTH_TOKEN = 'x';
    expect(getLanAuthToken()).toBe('x');
  });

  it('passes through (calls next) when the guard is not enforced', () => {
    delete process.env.LAN_HTTPS;
    delete process.env.LAN_AUTH_TOKEN;
    let called = false;
    const res = mkRes();
    requireLanToken(mkReq({ headers: {} }), res as never, () => {
      called = true;
    });
    expect(called).toBe(true);
    expect(res._res.statusCode).toBe(200);
  });

  describe('enforced (LAN mode + token set)', () => {
    beforeEach(() => {
      process.env.LAN_HTTPS = '1';
      process.env.LAN_AUTH_TOKEN = 'sekret-token';
    });

    it('bypasses loopback requests', () => {
      let called = false;
      requireLanToken(mkReq({ ip: '127.0.0.1' }), mkRes() as never, () => {
        called = true;
      });
      expect(called).toBe(true);
    });

    it('401s a non-loopback request with no token', () => {
      let called = false;
      const res = mkRes();
      requireLanToken(mkReq(), res as never, () => {
        called = true;
      });
      expect(called).toBe(false);
      expect(res._res.statusCode).toBe(401);
    });

    it('401s a non-loopback request with the wrong token', () => {
      let called = false;
      const res = mkRes();
      requireLanToken(mkReq({ headers: { authorization: 'Bearer nope' } }), res as never, () => {
        called = true;
      });
      expect(called).toBe(false);
      expect(res._res.statusCode).toBe(401);
    });

    it('accepts the correct token via Authorization: Bearer, X-Lan-Token, or ?token', () => {
      const ways: ReqOpts[] = [
        { headers: { authorization: 'Bearer sekret-token' } },
        { headers: { 'x-lan-token': 'sekret-token' } },
        { query: { token: 'sekret-token' } },
      ];
      for (const w of ways) {
        let called = false;
        requireLanToken(mkReq(w), mkRes() as never, () => {
          called = true;
        });
        expect(called).toBe(true);
      }
    });
  });

  it('extractToken reads Bearer / X-Lan-Token / ?token, else undefined', () => {
    expect(extractToken(mkReq({ headers: { authorization: 'Bearer abc' } }))).toBe('abc');
    expect(extractToken(mkReq({ headers: { 'x-lan-token': 'xyz' } }))).toBe('xyz');
    expect(extractToken(mkReq({ query: { token: 'qqq' } }))).toBe('qqq');
    expect(extractToken(mkReq())).toBeUndefined();
  });

  it('accepts a valid device token from the __Host-cw_lan cookie', () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    const req = mkReq({ headers: { cookie: '__Host-cw_lan=goodtoken' }, ip: '192.168.1.9' });
    const res = mkRes();
    const next = vi.fn();
    requireLanToken(req, res as never, next);
    expect(next).toHaveBeenCalled();
    expect(res._res.statusCode).not.toBe(401);
  });

  it('rejects a garbage cookie', () => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'secret';
    const req = mkReq({ headers: { cookie: '__Host-cw_lan=not-a-token' }, ip: '192.168.1.9' });
    const res = mkRes();
    const next = vi.fn();
    requireLanToken(req, res as never, next);
    expect(next).not.toHaveBeenCalled();
    expect(res._res.statusCode).toBe(401);
  });
});
