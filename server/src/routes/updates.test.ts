import { describe, expect, it, afterEach, vi } from 'vitest';
import { parseVersionFromTag, compareSemver, buildUpdateStatus, getCachedUpdateStatus, refreshUpdateStatusInBackground, __resetUpdateCacheForTests } from './updates.js';

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

describe('cache accessors (fe-27)', () => {
  afterEach(() => {
    __resetUpdateCacheForTests();
    vi.unstubAllGlobals();
  });

  it('getCachedUpdateStatus is null before any refresh', () => {
    __resetUpdateCacheForTests();
    expect(getCachedUpdateStatus()).toBeNull();
  });

  it('refreshUpdateStatusInBackground populates the cache from a reachable release', async () => {
    __resetUpdateCacheForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example/r' }),
      })),
    );
    refreshUpdateStatusInBackground();
    await vi.waitFor(() => expect(getCachedUpdateStatus()).not.toBeNull());
    const status = getCachedUpdateStatus();
    expect(status?.latestVersion).toBe('999.0.0');
    expect(status?.updateAvailable).toBe(true);
  });

  it('does not refetch while the cache is fresh', async () => {
    __resetUpdateCacheForTests();
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example/r' }),
    }));
    vi.stubGlobal('fetch', fetchMock);
    refreshUpdateStatusInBackground();
    await vi.waitFor(() => expect(getCachedUpdateStatus()).not.toBeNull());
    refreshUpdateStatusInBackground(); // cache now fresh → no second fetch
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not cache an unreachable result', async () => {
    __resetUpdateCacheForTests();
    const fetchMock = vi.fn(async () => ({ ok: false }));
    vi.stubGlobal('fetch', fetchMock);
    refreshUpdateStatusInBackground();
    // Let the fire-and-forget chain fully settle (fetch → build → finally).
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 0));
    expect(getCachedUpdateStatus()).toBeNull();
  });
});
