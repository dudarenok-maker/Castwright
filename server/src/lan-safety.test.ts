import { it, expect, beforeEach } from 'vitest';
import express from 'express';
import { assertNoTrustProxy, lanExposureWarning } from './lan-safety.js';

it('assertNoTrustProxy throws when trust proxy is set', () => {
  const a = express(); a.set('trust proxy', true);
  expect(() => assertNoTrustProxy(a)).toThrow(/trust proxy/i);
});
it('assertNoTrustProxy passes by default', () => {
  expect(() => assertNoTrustProxy(express())).not.toThrow();
});

beforeEach(() => { delete process.env.LAN_HTTPS; delete process.env.LAN_AUTH_TOKEN; });
it('warns when bound to LAN but token unset', () => {
  process.env.LAN_HTTPS = '1';
  expect(lanExposureWarning()).toMatch(/unauthenticated/i);
});
it('is silent when enforced or loopback-only', () => {
  process.env.LAN_HTTPS = '1'; process.env.LAN_AUTH_TOKEN = 'secret';
  expect(lanExposureWarning()).toBeNull();
  delete process.env.LAN_HTTPS; delete process.env.LAN_AUTH_TOKEN;
  expect(lanExposureWarning()).toBeNull();
});
