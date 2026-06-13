import { describe, expect, it } from 'vitest';
import { parseVersionFromTag, compareSemver, buildUpdateStatus } from './updates.js';

describe('parseVersionFromTag', () => {
  it('extracts X.Y.Z from common tag shapes', () => {
    expect(parseVersionFromTag('v1.7.0')).toBe('1.7.0');
    expect(parseVersionFromTag('castwright-v1.7.0')).toBe('1.7.0');
    expect(parseVersionFromTag('castwright-1.7.0')).toBe('1.7.0');
    expect(parseVersionFromTag('1.7.0')).toBe('1.7.0');
  });

  it('returns null for null/empty/unparseable tags', () => {
    expect(parseVersionFromTag(null)).toBeNull();
    expect(parseVersionFromTag(undefined)).toBeNull();
    expect(parseVersionFromTag('')).toBeNull();
    expect(parseVersionFromTag('latest')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('orders by major.minor.patch', () => {
    expect(compareSemver('1.7.0', '1.6.0')).toBe(1);
    expect(compareSemver('1.6.0', '1.7.0')).toBe(-1);
    expect(compareSemver('1.6.0', '1.6.0')).toBe(0);
    expect(compareSemver('2.0.0', '1.9.9')).toBe(1);
    expect(compareSemver('1.6.1', '1.6.0')).toBe(1);
  });

  it('treats unparseable as 0.0.0 (oldest) so garbage never claims to be newer', () => {
    expect(compareSemver('garbage', '1.6.0')).toBe(-1);
  });
});

describe('buildUpdateStatus', () => {
  it('reports an available update when the release is newer', () => {
    const s = buildUpdateStatus('1.6.0', { ok: true, tag: 'v1.7.0', url: 'https://x/releases/1.7.0' });
    expect(s).toEqual({
      reachable: true,
      currentVersion: '1.6.0',
      latestVersion: '1.7.0',
      updateAvailable: true,
      url: 'https://x/releases/1.7.0',
    });
  });

  it('reports up-to-date when the release equals the running version', () => {
    const s = buildUpdateStatus('1.6.0', { ok: true, tag: 'v1.6.0', url: 'https://x' });
    expect(s.reachable).toBe(true);
    expect(s.updateAvailable).toBe(false);
    expect(s.latestVersion).toBe('1.6.0');
  });

  it('never claims an update when the release is older than current', () => {
    const s = buildUpdateStatus('1.7.0', { ok: true, tag: 'v1.6.0', url: 'https://x' });
    expect(s.updateAvailable).toBe(false);
  });

  it('FAILS OPEN: an unreachable source yields reachable:false with the running version, no update', () => {
    const s = buildUpdateStatus('1.6.0', { ok: false });
    expect(s).toEqual({
      reachable: false,
      currentVersion: '1.6.0',
      latestVersion: null,
      updateAvailable: false,
      url: null,
    });
  });

  it('does not claim an update when reachable but the tag is unparseable', () => {
    const s = buildUpdateStatus('1.6.0', { ok: true, tag: 'nightly', url: 'https://x' });
    expect(s.reachable).toBe(true);
    expect(s.updateAvailable).toBe(false);
    expect(s.latestVersion).toBeNull();
  });
});
