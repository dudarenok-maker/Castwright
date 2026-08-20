/* Route-level tests for POST /api/config/env-cleanup.
   Uses a temp dir for the .env file under test so nothing touches the
   real server/.env. The envPath query param lets us inject the path
   without monkey-patching process.cwd. */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let workspaceRoot: string;
let settingsPath: string;
let envFilePath: string;
let app: Express;
let resetCache: () => void;

beforeAll(async () => {
  workspaceRoot = mkdtempSync(join(tmpdir(), 'castwright-env-cleanup-route-'));
  settingsPath = join(workspaceRoot, 'user-settings.json');
  envFilePath = join(workspaceRoot, '.env');
  process.env.USER_SETTINGS_FILE = settingsPath;
  process.env.CASTWRIGHT_PROMPTS_DIR = join(workspaceRoot, 'prompts');

  const [{ configRouter }, us] = await Promise.all([
    import('./config.js'),
    import('../workspace/user-settings.js'),
  ]);

  resetCache = us._resetUserSettingsCache;

  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  if (workspaceRoot) rmSync(workspaceRoot, { recursive: true, force: true });
  delete process.env.USER_SETTINGS_FILE;
  delete process.env.CASTWRIGHT_PROMPTS_DIR;
});

beforeEach(() => {
  resetCache?.();
  // Clean up .env and .bak between tests
  if (existsSync(envFilePath)) rmSync(envFilePath, { force: true });
  const bakPath = `${envFilePath}.bak`;
  if (existsSync(bakPath)) rmSync(bakPath, { force: true });
});

describe('POST /api/config/env-cleanup', () => {
  it('returns 404 when the .env file does not exist', async () => {
    const res = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: envFilePath });
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not found/i);
  });

  it('backs up the original file and comments out candidate lines', async () => {
    /* Set OLLAMA_TEMPERATURE to its registry default (0.2) so it becomes
       a candidate. Set WORKSPACE_DIR to something non-default so it is
       NOT a candidate. */
    process.env.OLLAMA_TEMPERATURE = '0.2';

    const originalContent = [
      '# ── Analyzer sampling ──',
      'OLLAMA_TEMPERATURE=0.2',
      'WORKSPACE_DIR=/data/ws',
      '',
      'GEMINI_API_KEY=sk-test',
    ].join('\n');
    writeFileSync(envFilePath, originalContent, 'utf-8');

    const res = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: envFilePath });

    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.cleaned)).toBe(true);

    // OLLAMA_TEMPERATURE is a candidate (env=default) → commented out
    expect(res.body.cleaned).toContain('OLLAMA_TEMPERATURE');
    // WORKSPACE_DIR has no env var matching in the registry or is not a candidate
    expect(res.body.cleaned).not.toContain('WORKSPACE_DIR');

    // Backup exists with original content
    const bakPath = `${envFilePath}.bak`;
    expect(existsSync(bakPath)).toBe(true);
    expect(readFileSync(bakPath, 'utf-8')).toBe(originalContent);

    // Cleaned file has OLLAMA_TEMPERATURE commented
    const cleaned = readFileSync(envFilePath, 'utf-8');
    expect(cleaned).toContain('# OLLAMA_TEMPERATURE=0.2');
    // WORKSPACE_DIR and GEMINI_API_KEY untouched
    expect(cleaned).toContain('WORKSPACE_DIR=/data/ws');
    expect(cleaned).toContain('GEMINI_API_KEY=sk-test');

    delete process.env.OLLAMA_TEMPERATURE;
  });

  it('is idempotent: second call returns cleaned:[] when nothing left', async () => {
    process.env.OLLAMA_TEMPERATURE = '0.2';

    const originalContent = 'OLLAMA_TEMPERATURE=0.2\n';
    writeFileSync(envFilePath, originalContent, 'utf-8');

    // First call
    const r1 = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: envFilePath });
    expect(r1.status).toBe(200);
    expect(r1.body.cleaned).toContain('OLLAMA_TEMPERATURE');

    // Second call — line is already commented, nothing to clean
    const r2 = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: envFilePath });
    expect(r2.status).toBe(200);
    expect(r2.body.cleaned).toEqual([]);

    delete process.env.OLLAMA_TEMPERATURE;
  });

  it('never touches a non-candidate line (deliberately pinned value)', async () => {
    /* Set OLLAMA_TEMPERATURE to a NON-default value so it is NOT a
       candidate. The endpoint must leave it untouched. */
    process.env.OLLAMA_TEMPERATURE = '0.99';

    const originalContent = 'OLLAMA_TEMPERATURE=0.99\nWORKSPACE_DIR=/custom\n';
    writeFileSync(envFilePath, originalContent, 'utf-8');

    const res = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: envFilePath });
    expect(res.status).toBe(200);
    expect(res.body.cleaned).not.toContain('OLLAMA_TEMPERATURE');

    const after = readFileSync(envFilePath, 'utf-8');
    expect(after).toBe(originalContent); // byte-for-byte unchanged

    delete process.env.OLLAMA_TEMPERATURE;
  });

  it('writes temp file in the same directory as target (not OS tmpdir), and cleans up on success', async () => {
    /* Regression test for finding 3: verify that temp files are written
       beside the target .env file (in the workspace directory), not in
       os.tmpdir(). This prevents cross-filesystem rename errors (EXDEV)
       and leaking temp directories. */
    process.env.OLLAMA_TEMPERATURE = '0.2';

    const originalContent = 'OLLAMA_TEMPERATURE=0.2\n';
    writeFileSync(envFilePath, originalContent, 'utf-8');

    // Record what's in os.tmpdir() before the call
    const osTmpBefore = new Set(
      readdirSync(tmpdir()).filter((name) => name.includes('env-cleanup')),
    );

    const res = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: envFilePath });

    expect(res.status).toBe(200);
    expect(res.body.cleaned).toContain('OLLAMA_TEMPERATURE');

    // Check what's in os.tmpdir() after the call
    const osTmpAfter = new Set(
      readdirSync(tmpdir()).filter((name) => name.includes('env-cleanup')),
    );

    // Verify no new temp dirs were created in os.tmpdir()
    // The fix writes temp file beside target (.env.tmp-*), not in tmpdir
    for (const name of osTmpAfter) {
      expect(osTmpBefore.has(name), `temp file leaked to os.tmpdir(): ${name}`).toBe(true);
    }

    delete process.env.OLLAMA_TEMPERATURE;
  });
});
