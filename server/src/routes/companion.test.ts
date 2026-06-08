/* Interim companion-app distribution — GET /api/companion/apk streams the
   packaged Android APK as a download (the "third distribution method" next to
   the two store buttons), 404s when none is present, and answers HEAD as the
   frontend's availability probe. The APK location is COMPANION_APK_PATH-driven
   so the test points it at a temp fixture. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { companionRouter } from './companion.js';

let app: Express;
let tmpDir: string;
const ORIG_ENV = process.env.COMPANION_APK_PATH;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'castwright-apk-'));
  app = express();
  app.use('/api/companion', companionRouter);
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  if (ORIG_ENV === undefined) delete process.env.COMPANION_APK_PATH;
  else process.env.COMPANION_APK_PATH = ORIG_ENV;
});

describe('GET /api/companion/apk', () => {
  it('404s when no APK is present at the drop location', async () => {
    process.env.COMPANION_APK_PATH = join(tmpDir, 'missing.apk');
    const res = await request(app).get('/api/companion/apk');
    expect(res.status).toBe(404);
  });

  it('streams the APK as an attachment when present', async () => {
    const apkPath = join(tmpDir, 'castwright-companion.apk');
    writeFileSync(apkPath, Buffer.from('PK fake apk payload'));
    process.env.COMPANION_APK_PATH = apkPath;

    const res = await request(app).get('/api/companion/apk');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('application/vnd.android.package-archive');
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename=/);
    expect(res.headers['content-disposition']).toMatch(/\.apk"?$/);
  });

  it('answers HEAD 200 + Content-Length when present, 404 when absent', async () => {
    const apkPath = join(tmpDir, 'castwright-companion.apk');
    const bytes = Buffer.from('PK more fake bytes for the probe');
    writeFileSync(apkPath, bytes);
    process.env.COMPANION_APK_PATH = apkPath;

    let res = await request(app).head('/api/companion/apk');
    expect(res.status).toBe(200);
    expect(Number(res.headers['content-length'])).toBe(bytes.length);

    process.env.COMPANION_APK_PATH = join(tmpDir, 'gone.apk');
    res = await request(app).head('/api/companion/apk');
    expect(res.status).toBe(404);
  });
});
