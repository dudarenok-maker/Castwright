/* Plan 124 — build-version footer. Locks the pure formatter's dev/prod shapes
   and the `typeof`-guarded fallback contract (Vitest has no Vite `define`, so
   the injected globals are undefined — importing build-info must NOT throw). */

import { describe, it, expect } from 'vitest';
import { buildInfo, formatBuildStamp, type BuildInfo } from './build-info';

const base: BuildInfo = {
  version: '1.4.0',
  sha: 'a1b2c3d',
  branch: 'fix/foo',
  dirty: false,
  buildTime: '14:32',
};

describe('formatBuildStamp', () => {
  it('dev: verbose version · sha · branch · time when the tree is clean', () => {
    expect(formatBuildStamp(base, { dev: true })).toBe(
      'Castwright · v1.4.0 · a1b2c3d · fix/foo · 14:32',
    );
  });

  it('dev: appends a "*" dirty marker to the sha when the working tree is dirty', () => {
    expect(formatBuildStamp({ ...base, dirty: true }, { dev: true })).toBe(
      'Castwright · v1.4.0 · a1b2c3d* · fix/foo · 14:32',
    );
  });

  it('dev: omits the trailing segment when buildTime is empty (no dangling separator)', () => {
    expect(formatBuildStamp({ ...base, buildTime: '' }, { dev: true })).toBe(
      'Castwright · v1.4.0 · a1b2c3d · fix/foo',
    );
  });

  it('prod: minimal version + short sha only', () => {
    expect(formatBuildStamp(base, { dev: false })).toBe('Castwright · v1.4.0 (a1b2c3d)');
  });
});

describe('buildInfo (Vitest fallback contract)', () => {
  it('imports without ReferenceError and exposes sentinel fallbacks under Vitest', () => {
    /* No Vite `define` in vitest.config.ts → the injected globals are
       undefined; the typeof guard in build-info.ts is what keeps this import
       from throwing. The values below are the documented sentinels. */
    expect(buildInfo.version).toBe('0.0.0-dev');
    expect(buildInfo.sha).toBe('unknown');
    expect(buildInfo.branch).toBe('local');
    expect(buildInfo.dirty).toBe(false);
    expect(buildInfo.buildTime).toBe('');
  });
});
