import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PINNED_BUILD_INFO, selectBuildInfo } from '../../vite.config';

/* #4566 — every Playwright run pins the stamp, and Vitest has no `define`, so
   this is the only test that the real build path (package.json →
   buildInfoRaw().version → __APP_VERSION__) carries package.json's version. */
describe('selectBuildInfo (vite.config.ts)', () => {
  const pkgVersion = (
    JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8')) as {
      version: string;
    }
  ).version;

  it('unset knob: a real build carries package.json version', () => {
    expect(selectBuildInfo({}).version).toBe(pkgVersion);
  });

  it('VITE_PIN_BUILD_STAMP=1 returns the pinned stamp', () => {
    expect(selectBuildInfo({ VITE_PIN_BUILD_STAMP: '1' })).toEqual(PINNED_BUILD_INFO);
  });

  it('any other knob value is not a pin', () => {
    expect(selectBuildInfo({ VITE_PIN_BUILD_STAMP: '0' }).version).toBe(pkgVersion);
  });
});
