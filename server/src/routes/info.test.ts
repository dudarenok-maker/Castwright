/* fs-1 — pin GET /api/info + POST /api/info/dismiss-whats-new. Uses the real
   user-settings (test-setup redirects USER_SETTINGS_FILE to a temp file) and a
   stubbed fetch for the best-effort sidecar version probe. */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { rmSync } from 'node:fs';

import { infoRouter } from './info.js';
import { getAppVersion } from '../app-version.js';
import { USER_SETTINGS_PATH, writeUpgradeMeta, _resetUserSettingsCache, readUserSettings } from '../workspace/user-settings.js';
import {
  getCachedUpdateStatus,
  refreshUpdateStatusInBackground,
  __resetUpdateCacheForTests,
} from './updates.js';

let app: Express;

beforeEach(async () => {
  rmSync(USER_SETTINGS_PATH, { force: true });
  _resetUserSettingsCache();
  await readUserSettings();
  // Default: sidecar unreachable → version probe resolves null.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('sidecar down'); }));
  app = express();
  app.use(express.json());
  app.use('/api/info', infoRouter);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('GET /api/info', () => {
  it('reports the server version, the schema map, and a clean what\'s-new state', async () => {
    const res = await request(app).get('/api/info');
    expect(res.status).toBe(200);
    expect(res.body.appVersion).toBe(getAppVersion());
    expect(res.body.sidecarVersion).toBeNull(); // probe threw
    expect(res.body.schemas).toMatchObject({
      state: 1,
      cast: 1,
      manuscriptEdits: 1,
      revisions: 1,
      listenProgress: 1,
      voices: 1,
      syncManifest: 1, // srv-32 — companion compat-gates off this
    });
    expect(res.body.showWhatsNew).toBe(false);
  });

  it('reports host hardware for the device panel (fs-43)', async () => {
    const res = await request(app).get('/api/info');
    expect(res.body.hardware).toMatchObject({
      platform: expect.any(String),
      arch: expect.any(String),
      appleSilicon: expect.any(Boolean),
      label: expect.any(String),
    });
    expect(res.body.hardware.label.length).toBeGreaterThan(0);
    // appleSilicon is true iff darwin + arm64 — derived, never guessed.
    const { platform, arch, appleSilicon } = res.body.hardware;
    expect(appleSilicon).toBe(platform === 'darwin' && arch === 'arm64');
  });

  it('surfaces the sidecar __version__ when the probe succeeds', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, json: async () => ({ __version__: '1.6.0' }) })),
    );
    const res = await request(app).get('/api/info');
    expect(res.body.sidecarVersion).toBe('1.6.0');
  });

  it('carries sidecar devices + devicesState + the resolved activeEngine', async () => {
    /* side-14 — /api/info must lift the per-engine device map and devicesState
       off the single sidecar /health probe, and add the Node-resolved
       activeEngine. With a fresh settings cache (no Qwen known-installed),
       getResolvedTtsModelKey() returns 'kokoro-v1', so engineForModelKey maps it
       to 'kokoro'. */
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          __version__: '1.6.0',
          devices: { kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' },
          devices_state: 'ready',
        }),
      })),
    );
    const res = await request(app).get('/api/info');
    expect(res.status).toBe(200);
    expect(res.body.devices).toEqual({ kokoro: 'cuda', coqui: 'cuda', qwen: 'cuda' });
    expect(res.body.devicesState).toBe('ready');
    expect(res.body.activeEngine).toBe('kokoro');
  });

  it('reports null devices and a null devicesState when the sidecar is down', async () => {
    /* Default fetch stub throws → devices: null, devicesState: null. activeEngine
       is resolved Node-side so it's always present regardless of sidecar state. */
    // Default beforeEach stub already throws 'sidecar down'.
    const res = await request(app).get('/api/info');
    expect(res.status).toBe(200);
    expect(res.body.devices).toBeNull();
    expect(res.body.devicesState).toBeNull();
    expect(res.body.activeEngine).toBeDefined();
  });

  it('reflects a post-upgrade banner + lastSeenAppVersion, then clears on dismiss', async () => {
    await writeUpgradeMeta({ lastSeenAppVersion: '1.5.1', showWhatsNew: true });
    let res = await request(app).get('/api/info');
    expect(res.body.showWhatsNew).toBe(true);
    expect(res.body.lastSeenAppVersion).toBe('1.5.1');

    const dismiss = await request(app).post('/api/info/dismiss-whats-new');
    expect(dismiss.status).toBe(200);
    expect(dismiss.body.ok).toBe(true);

    res = await request(app).get('/api/info');
    expect(res.body.showWhatsNew).toBe(false);
  });
});

describe('GET /api/info — update fields (fe-27)', () => {
  afterEach(() => __resetUpdateCacheForTests());

  it('returns null update fields on a cold cache without blocking', async () => {
    __resetUpdateCacheForTests();
    const res = await request(app).get('/api/info');
    expect(res.status).toBe(200);
    expect(res.body.updateAvailable).toBeNull();
    expect(res.body.latestVersion).toBeNull();
  });

  it('reflects a populated cache', async () => {
    __resetUpdateCacheForTests();
    // Stub fetch to answer GitHub (tag) but still fail the sidecar /health probe.
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (typeof url === 'string' && url.includes('api.github.com')) {
          return { ok: true, json: async () => ({ tag_name: 'v999.0.0', html_url: 'https://example/r' }) };
        }
        throw new Error('sidecar down');
      }),
    );
    refreshUpdateStatusInBackground();
    await vi.waitFor(() => expect(getCachedUpdateStatus()).not.toBeNull());
    const res = await request(app).get('/api/info');
    expect(res.body.latestVersion).toBe('999.0.0');
    expect(res.body.updateAvailable).toBe(true);
  });
});
