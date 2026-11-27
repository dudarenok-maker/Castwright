/* srv-20 — LAN shared-secret token guard. Unit-tests the middleware
   against mocked req/res so no HTTP server is needed. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, existsSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mockState = vi.hoisted(() => ({ scope: 'full' as 'full' | 'companion' }));
vi.mock('./workspace/device-tokens.js', () => ({
  authenticateDeviceToken: (t: string) =>
    t === 'goodtoken'
      ? {
          id: 'd1',
          label: 'Anna phone',
          tokenHash: 'h',
          createdAt: '',
          expiresAt: '',
          scope: mockState.scope,
        }
      : null,
}));

import {
  requireLanToken,
  isLanTokenEnforced,
  extractToken,
  getLanAuthToken,
  ensureLanAuthToken,
  pairingOriginHint,
} from './lan-auth.js';
import { setLanRuntime } from './lan-runtime.js';

interface ReqOpts {
  ip?: string;
  headers?: Record<string, string>;
  query?: Record<string, unknown>;
  method?: string;
  originalUrl?: string;
  path?: string;
}
function mkReq(opts: ReqOpts = {}) {
  const ip = opts.ip ?? '203.0.113.5'; // documentation range — non-loopback by default
  const originalUrl = opts.originalUrl ?? '/api/info';
  return {
    ip,
    socket: { remoteAddress: ip },
    headers: opts.headers ?? {},
    query: opts.query ?? {},
    method: opts.method ?? 'GET',
    originalUrl,
    path: opts.path ?? originalUrl.replace(/^\/api(?=\/)/, '').split('?')[0],
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
    // #2278 review round 3 (nit) — resets to a fixed, known baseline for the
    // NEXT test in this file, not literally "the module default": that
    // default is `Number(process.env.PORT ?? 8080)` (lan-runtime.ts), which
    // only happens to equal 8080 when PORT is unset.
    setLanRuntime({ httpsActive: false, port: 8080 });
  });

  // #2278 review Finding 1/7 — PAIRING_ORIGIN_HINT used to be a hardcoded
  // `https://localhost:8443` const; it's now a function reading the ACTUAL
  // bound port off getLanRuntime(), never a requested/default one.
  it('pairingOriginHint names the actually-bound port, not a hardcoded default', () => {
    setLanRuntime({ httpsActive: true, port: 9443 });
    expect(pairingOriginHint()).toBe(
      'Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
    );
  });

  // #2278 review round 4, Finding 4 — the httpsActive:false arm was reachable
  // by no test at all: every other case sets httpsActive true or mocks
  // pairingOriginHint wholesale, so collapsing the ternary to an
  // unconditional `https://localhost:${port}` template left the suite green.
  // A degraded box's bound port is an HTTP one, so naming it behind https://
  // would be a dead link of a new kind — this pins that it names no address.
  it('pairingOriginHint drops the address entirely when LAN HTTPS is not active', () => {
    setLanRuntime({ httpsActive: false, port: 8080 });
    expect(pairingOriginHint()).toBe('Start pairing on the computer running Castwright.');
    expect(pairingOriginHint()).not.toMatch(/https?:\/\//);
    expect(pairingOriginHint()).not.toContain('8080');
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

    // #2278 review Finding 1 — the 401 body itself carries the same
    // port-correct pairing guidance a 403 from mayStartPairingSession does,
    // so a caller (e.g. the LAN-access card's listDevices call) can render
    // it straight from the response body instead of a separate client-side
    // fetch of its own for the port (which would sit behind this exact same
    // guard and could never actually resolve on this branch).
    it('the 401 body carries port-correct pairing guidance, not just a bare message', () => {
      setLanRuntime({ httpsActive: true, port: 9443 });
      const res = mkRes();
      requireLanToken(mkReq(), res as never, () => {});
      expect(res._res.statusCode).toBe(401);
      expect(res._res.body).toEqual({
        error:
          'Missing or invalid LAN access token. Start pairing from https://localhost:9443 or https://castwright.local on the computer running Castwright.',
      });
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

/* #898 (PR B) — companion-scope enforcement. Two vacuity hazards shape this
   block: (1) a loopback caller returns next() BEFORE any token check, so every
   deny case drives a NON-loopback ip; (2) the allow cases assert next(), which
   the not-enforced and loopback short-circuits also produce, so those two are
   pinned positively below (invariants 1 and 2) and the deny assertions are the
   ones that go red under the inverted mutations (M14: loopback ip, M15: guard
   off). */
describe('requireLanToken companion scope (#898)', () => {
  const origHttps = process.env.LAN_HTTPS;
  const origToken = process.env.LAN_AUTH_TOKEN;
  const DENY_IP = '203.0.113.5';
  const bearer = { authorization: 'Bearer goodtoken' };

  beforeEach(() => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'sekret-token';
    mockState.scope = 'companion';
  });
  afterEach(() => {
    mockState.scope = 'full';
    vi.restoreAllMocks();
    if (origHttps === undefined) delete process.env.LAN_HTTPS;
    else process.env.LAN_HTTPS = origHttps;
    if (origToken === undefined) delete process.env.LAN_AUTH_TOKEN;
    else process.env.LAN_AUTH_TOKEN = origToken;
  });

  function drive(opts: ReqOpts) {
    const res = mkRes();
    const next = vi.fn();
    requireLanToken(mkReq(opts), res as never, next);
    return { res, next };
  }

  // Invariant 1: loopback bypasses the guard entirely, scope included.
  it('invariant 1: a companion token on a DENIED route from loopback passes', () => {
    const { next } = drive({
      ip: '::ffff:127.0.0.1',
      headers: bearer,
      method: 'DELETE',
      originalUrl: '/api/books/x/cover',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  // Invariant 2: guard off (no shared secret) lets everything through.
  it('invariant 2: with LAN_AUTH_TOKEN unset a denied route passes', () => {
    delete process.env.LAN_AUTH_TOKEN;
    const { next } = drive({
      ip: DENY_IP,
      headers: bearer,
      method: 'DELETE',
      originalUrl: '/api/books/x/cover',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('denies a companion token on DELETE /api/books/x/cover with 403 scope-denied', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, next } = drive({
      ip: DENY_IP,
      headers: bearer,
      method: 'DELETE',
      originalUrl: '/api/books/x/cover',
    });
    expect(next).not.toHaveBeenCalled();
    expect(res._res.statusCode).toBe(403);
    expect(res._res.body).toEqual({ error: 'scope-denied', scope: 'companion' });
  });

  it.each([
    ['GET', '/api/info'],
    ['GET', '/api/library/sync-manifest'],
    ['GET', '/api/books/b1/cover'],
    ['GET', '/api/books/b1/chapters/3/audio'],
    ['GET', '/api/books/b1/chapters/3/audio.mp3'],
    ['GET', '/api/books/b1/chapters/3/audio.m4a'],
    ['GET', '/api/books/b1/chapters/3/audio.ogg'],
    ['GET', '/api/books/b1/listen-progress'],
    ['PUT', '/api/books/b1/listen-progress'],
    ['PUT', '/api/books/b1/listen-stats'],
    ['POST', '/api/books/b1/shelf-status'],
  ])('a companion token passes on the allowlisted %s %s', (method, originalUrl) => {
    const { next, res } = drive({ ip: DENY_IP, headers: bearer, method, originalUrl });
    expect(next).toHaveBeenCalledTimes(1);
    expect(res._res.statusCode).toBe(200);
  });

  // M6: Express presents path=/info for BOTH mounts; only originalUrl tells them apart.
  it('denies /workspace/info even though req.path is /info', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, next } = drive({
      ip: DENY_IP,
      headers: bearer,
      method: 'GET',
      originalUrl: '/workspace/info',
      path: '/info',
    });
    expect(next).not.toHaveBeenCalled();
    expect(res._res.statusCode).toBe(403);
  });

  // The discriminating variant of the M6 case: here req.path (/api/info) WOULD
  // match the allowlist while originalUrl (/workspace/info) must not, so a guard
  // that reads req.path lets it through and this goes red.
  it('denies /workspace/info even when req.path would match an allowlisted row', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, next } = drive({
      ip: DENY_IP,
      headers: bearer,
      method: 'GET',
      originalUrl: '/workspace/info',
      path: '/api/info',
    });
    expect(next).not.toHaveBeenCalled();
    expect(res._res.statusCode).toBe(403);
  });

  // Matching is raw: a case-folding mutant at the call site would grant this.
  it('denies GET /API/INFO (no case folding)', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { res, next } = drive({
      ip: DENY_IP,
      headers: bearer,
      method: 'GET',
      originalUrl: '/API/INFO',
    });
    expect(next).not.toHaveBeenCalled();
    expect(res._res.statusCode).toBe(403);
  });

  // Invariant 3: the legacy shared secret is not scoped.
  it('invariant 3: the shared secret on a denied route passes', () => {
    const { next } = drive({
      ip: DENY_IP,
      headers: { authorization: 'Bearer sekret-token' },
      method: 'DELETE',
      originalUrl: '/api/books/x/cover',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('a full-scope token on a denied route passes', () => {
    mockState.scope = 'full';
    const { next } = drive({
      ip: DENY_IP,
      headers: bearer,
      method: 'DELETE',
      originalUrl: '/api/books/x/cover',
    });
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('logs exactly one warning per denial naming method, pathname and device', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    drive({
      ip: DENY_IP,
      headers: bearer,
      method: 'DELETE',
      originalUrl: '/api/books/x/cover?x=1',
    });
    expect(warn).toHaveBeenCalledTimes(1);
    const msg = String(warn.mock.calls[0]?.[0]);
    expect(msg).toContain('DELETE');
    expect(msg).toContain('/api/books/x/cover');
    expect(msg).not.toContain('x=1');
    expect(msg).toContain('Anna phone');
  });
});

describe('ensureLanAuthToken (auto-provisioned LAN secret)', () => {
  const saved = {
    lan: process.env.LAN_HTTPS,
    tok: process.env.LAN_AUTH_TOKEN,
    env: process.env.NODE_ENV,
  };
  let dir: string;
  let tokenFile: string;
  beforeEach(() => {
    delete process.env.LAN_AUTH_TOKEN;
    process.env.NODE_ENV = 'production';
    process.env.LAN_HTTPS = '1';
    dir = mkdtempSync(join(tmpdir(), 'cw-lan-'));
    tokenFile = join(dir, 'lan-auth.token');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const [k, v] of [
      ['LAN_HTTPS', saved.lan],
      ['LAN_AUTH_TOKEN', saved.tok],
      ['NODE_ENV', saved.env],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('no-ops (undefined, no file) when LAN is off', () => {
    process.env.LAN_HTTPS = '0';
    expect(ensureLanAuthToken(tokenFile)).toBeUndefined();
    expect(existsSync(tokenFile)).toBe(false);
    expect(process.env.LAN_AUTH_TOKEN).toBeUndefined();
  });

  it('mints a 256-bit hex token and writes it to the shared file', () => {
    const tok = ensureLanAuthToken(tokenFile);
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.LAN_AUTH_TOKEN).toBe(tok);
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(tok);
  });

  it('adopts an existing token file without re-minting (survives restart/upgrade)', () => {
    const first = ensureLanAuthToken(tokenFile);
    delete process.env.LAN_AUTH_TOKEN; // simulate a fresh process whose .env has no token
    const second = ensureLanAuthToken(tokenFile);
    expect(second).toBe(first);
    expect(process.env.LAN_AUTH_TOKEN).toBe(first);
  });

  it('self-heals an empty/corrupt token file: mints, writes a real token to disk', () => {
    writeFileSync(tokenFile, ''); // interrupted first write / external truncate
    const tok = ensureLanAuthToken(tokenFile);
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(tokenFile, 'utf8').trim()).toBe(tok); // in-memory == disk
  });

  it('an explicit LAN_AUTH_TOKEN env value wins over the file (never persisted)', () => {
    process.env.LAN_AUTH_TOKEN = 'preset-token';
    expect(ensureLanAuthToken(tokenFile)).toBe('preset-token');
    expect(existsSync(tokenFile)).toBe(false);
  });

  it('still guards the API in-process when the token file can not be persisted', () => {
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x'); // parent-as-file → mkdir/write both fail
    const tok = ensureLanAuthToken(join(blocker, 'lan-auth.token'));
    expect(tok).toMatch(/^[0-9a-f]{64}$/);
    expect(process.env.LAN_AUTH_TOKEN).toBe(tok);
  });
});
