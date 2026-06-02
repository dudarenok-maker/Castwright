/* fs-1 — pin compareVersions (drives the coordinator's upgrade/downgrade
   decision and release pruning). */

import { describe, it, expect } from 'vitest';
import { compareVersions, getAppVersion } from './app-version.js';

describe('compareVersions', () => {
  it('orders by numeric segments, not lexically', () => {
    expect(compareVersions('1.6.0', '1.5.1')).toBeGreaterThan(0);
    expect(compareVersions('1.5.1', '1.6.0')).toBeLessThan(0);
    expect(compareVersions('1.10.0', '1.9.0')).toBeGreaterThan(0); // not '1' < '9'
    expect(compareVersions('1.6.0', '1.6.0')).toBe(0);
  });

  it('treats malformed / missing segments as 0 (never a false upgrade)', () => {
    expect(compareVersions('1.6', '1.6.0')).toBe(0);
    expect(compareVersions('garbage', '0.0.0')).toBe(0);
  });
});

describe('getAppVersion', () => {
  it('returns the server package.json version (dotted, non-empty)', () => {
    expect(getAppVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
