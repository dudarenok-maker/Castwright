/* Unit coverage for the friendly-hostname pairing gate (isFriendlyHostnameRequest
   + mayStartPairingSession). The route tests mock lan-auth wholesale, so the real
   gate logic is exercised here against fabricated requests. */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Request } from './http.js';
import { isFriendlyHostnameRequest, mayStartPairingSession } from './lan-auth.js';

const req = (opts: { ip?: string; host?: string }): Request =>
  ({
    ip: opts.ip,
    socket: { remoteAddress: opts.ip },
    headers: opts.host === undefined ? {} : { host: opts.host },
  }) as unknown as Request;

describe('isFriendlyHostnameRequest', () => {
  it('matches the bare friendly hostname', () => {
    expect(isFriendlyHostnameRequest(req({ host: 'castwright.local' }))).toBe(true);
  });
  it('tolerates an explicit port and mixed case', () => {
    expect(isFriendlyHostnameRequest(req({ host: 'castwright.local:8443' }))).toBe(true);
    expect(isFriendlyHostnameRequest(req({ host: 'CASTWRIGHT.LOCAL' }))).toBe(true);
  });
  it('rejects a bare LAN IP and a missing Host header', () => {
    expect(isFriendlyHostnameRequest(req({ host: '192.168.1.5:8443' }))).toBe(false);
    expect(isFriendlyHostnameRequest(req({}))).toBe(false);
  });
});

describe('mayStartPairingSession', () => {
  beforeEach(() => {
    process.env.LAN_HTTPS = '1';
    process.env.LAN_AUTH_TOKEN = 'unit-secret';
  });
  afterEach(() => {
    delete process.env.LAN_HTTPS;
    delete process.env.LAN_AUTH_TOKEN;
  });

  it('always allows a loopback caller regardless of Host', () => {
    expect(mayStartPairingSession(req({ ip: '127.0.0.1', host: '192.168.1.5' }))).toBe(true);
  });

  it('allows an enforced non-loopback caller on the friendly hostname (the :443-forwarder 127.0.0.2 case)', () => {
    expect(mayStartPairingSession(req({ ip: '127.0.0.2', host: 'castwright.local' }))).toBe(true);
  });

  it('rejects an enforced non-loopback caller on a bare LAN IP', () => {
    expect(mayStartPairingSession(req({ ip: '127.0.0.2', host: '192.168.1.5:8443' }))).toBe(false);
  });

  it('rejects the friendly hostname when the LAN token guard is not enforced', () => {
    delete process.env.LAN_AUTH_TOKEN; // enforcement now off → the token gate never ran
    expect(mayStartPairingSession(req({ ip: '127.0.0.2', host: 'castwright.local' }))).toBe(false);
  });
});
