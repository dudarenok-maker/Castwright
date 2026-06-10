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
