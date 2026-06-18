import { it, expect, vi, beforeEach } from 'vitest';
import { requireSameOrigin } from './csrf-origin.js';

function mk(method: string, headers: Record<string, string>, ip = '192.168.1.9') {
  return { method, headers, ip, socket: { remoteAddress: ip } } as any;
}
function res() {
  return { statusCode: 200, body: undefined as unknown, status(c: number){this.statusCode=c;return this;}, json(b: unknown){this.body=b;return this;} } as any;
}

beforeEach(() => { process.env.LAN_HTTPS_PORT = '8443'; });

it('passes a GET regardless of origin', () => {
  const next = vi.fn();
  requireSameOrigin(mk('GET', {}), res(), next);
  expect(next).toHaveBeenCalled();
});

it('passes a cookie POST from an allowed loopback origin', () => {
  const next = vi.fn();
  requireSameOrigin(mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://localhost:8443' }), res(), next);
  expect(next).toHaveBeenCalled();
});

it('403s a cookie POST with a foreign origin', () => {
  const next = vi.fn(); const r = res();
  requireSameOrigin(mk('POST', { cookie: '__Host-cw_lan=x', origin: 'https://evil.example:8443' }), r, next);
  expect(next).not.toHaveBeenCalled();
  expect(r.statusCode).toBe(403);
});

it('403s a cookie POST with NO origin and NO referer (fail-closed)', () => {
  const next = vi.fn(); const r = res();
  requireSameOrigin(mk('POST', { cookie: '__Host-cw_lan=x' }), r, next);
  expect(r.statusCode).toBe(403);
});

it('passes a header-token POST (companion) with no cookie', () => {
  const next = vi.fn();
  requireSameOrigin(mk('POST', { 'x-lan-token': 'tok' }), res(), next);
  expect(next).toHaveBeenCalled();
});

it('still gates a cookie that cookie.parse accepts but a naive regex might miss', () => {
  // Leading whitespace + other pairs first — cookie.parse handles it; assert CSRF still fires.
  const next = vi.fn(); const r = res();
  requireSameOrigin(mk('POST', { cookie: 'foo=bar; __Host-cw_lan=x', origin: 'https://evil.example:8443' }), r, next);
  expect(next).not.toHaveBeenCalled();
  expect(r.statusCode).toBe(403);
});
