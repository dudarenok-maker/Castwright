/* #4236 -- POST /api/config/env-cleanup answered the absolute server/.env path and raw node fs
   messages in four 404/500 bodies, and the app is served over LAN HTTPS. Each site now answers a
   fixed sentence naming the file by its relative name; the full path and raw error go to the
   server log. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

const seam = vi.hoisted(() => ({ renameError: null as unknown }));

vi.mock('../workspace/atomic-rename.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../workspace/atomic-rename.js')>();
  return {
    ...orig,
    renameWithRetry: vi.fn(async (...args: Parameters<typeof orig.renameWithRetry>) => {
      if (seam.renameError !== null) throw seam.renameError;
      return orig.renameWithRetry(...args);
    }),
  };
});

let tmpDir: string;
let app: Express;
let setPath: (p: string | null) => void;
let errSpy: ReturnType<typeof vi.spyOn>;

const ENV_WITH_CANDIDATE = 'STAGE2_MIN_COVERAGE=0.6\nSOME_UNRELATED_VAR=value\n';

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'config-env-cleanup-fs-error-'));
  const mod = await import('./config.js');
  setPath = mod._setServerEnvPathForTest;
  app = express();
  app.use(express.json());
  app.use('/api/config', mod.configRouter);
});

afterAll(() => {
  setPath(null);
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  seam.renameError = null;
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  setPath(null);
  errSpy.mockRestore();
});

/** The log carries the full path among its arguments plus the raw error. */
function expectLogged(fullPath: string): void {
  const call = errSpy.mock.calls.find((args: unknown[]) => args.includes(fullPath));
  expect(call).toBeDefined();
  expect(call!.some((a: unknown) => a instanceof Error)).toBe(true);
}

describe('POST /api/config/env-cleanup error bodies (#4236)', () => {
  it('404: names server/.env by relative name, no absolute path', async () => {
    const envPath = join(tmpDir, 'missing.env');
    setPath(envPath);
    const res = await request(app).post('/api/config/env-cleanup');
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('server/.env not found.');
    expect(res.body.error).not.toContain(tmpDir);
    expect(errSpy.mock.calls.some((args: unknown[]) => args.includes(envPath))).toBe(true);
  });

  it('read failure: fixed sentence, no absolute path or raw fs message', async () => {
    const envPath = join(tmpDir, 'dir-as-env');
    mkdirSync(envPath);
    setPath(envPath);
    const res = await request(app).post('/api/config/env-cleanup');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not read server/.env.');
    expect(res.body.error).not.toContain(tmpDir);
    expectLogged(envPath);
  });

  it('backup write failure: fixed sentence, .env unchanged', async () => {
    const envPath = join(tmpDir, 'backup-fail.env');
    writeFileSync(envPath, ENV_WITH_CANDIDATE, 'utf-8');
    mkdirSync(`${envPath}.bak`);
    setPath(envPath);
    const res = await request(app).post('/api/config/env-cleanup');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not write the backup server/.env.bak.');
    expect(res.body.error).not.toContain(tmpDir);
    expectLogged(`${envPath}.bak`);
    expect(readFileSync(envPath, 'utf-8')).toBe(ENV_WITH_CANDIDATE);
  });

  it('rename failure: fixed sentence, no .tmp-* left behind', async () => {
    const envPath = join(tmpDir, 'rename-fail', '.env');
    mkdirSync(join(tmpDir, 'rename-fail'));
    writeFileSync(envPath, ENV_WITH_CANDIDATE, 'utf-8');
    setPath(envPath);
    seam.renameError = Object.assign(
      new Error(`EPERM: operation not permitted, rename '${envPath}.tmp-1' -> '${envPath}'`),
      { code: 'EPERM', syscall: 'rename', path: envPath },
    );
    const res = await request(app).post('/api/config/env-cleanup');
    expect(res.status).toBe(500);
    expect(res.body.error).toBe('Could not write the cleaned server/.env.');
    expect(res.body.error).not.toContain(tmpDir);
    expectLogged(envPath);
    expect(readdirSync(join(tmpDir, 'rename-fail')).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});
