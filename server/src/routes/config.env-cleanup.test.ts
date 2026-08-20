/* Integration test for POST /api/config/env-cleanup.

   Asserts that:
   1. (Part A) After cleanup, GET /api/config no longer lists the cleaned
      candidates, without needing a server restart (the cleanup and subsequent
      GET run in the same process, so process.env has not been reloaded).
   2. (Part B) A second cleanup call with no remaining candidates does not
      overwrite the .env.bak backup from the first cleanup.
   3. (Part C) Query parameters like ?envPath are ignored (security regression test).

   Uses _setServerEnvPathForTest() to inject a temp .env path so the test
   doesn't touch the real server/.env. */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let tmpDir: string;
let app: Express;
let envTestPath: string;
let setServerEnvPathForTest: (path: string | null) => void;

// Global test state snapshots for cleanup (prevents cross-test leaks)
let savedCwd: string;
let savedEnv: Record<string, string | undefined>;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'config-env-cleanup-test-'));
  envTestPath = join(tmpDir, '.env.test');

  // Seed a test .env file with a leftover-default candidate.
  // Use one that we know will match a knob with a default value and is
  // testable in isolation. For simplicity, use STAGE2_MIN_COVERAGE=0.6
  // (analyzer.stage2.minCoverage, default 0.6).
  writeFileSync(
    envTestPath,
    [
      '# Leftover from example',
      'STAGE2_MIN_COVERAGE=0.6',
      '# Another comment',
      'SOME_UNRELATED_VAR=value',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Import and create the config router
  const configModule = await import('./config.js');
  const { configRouter } = configModule;
  setServerEnvPathForTest = configModule._setServerEnvPathForTest;

  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  setServerEnvPathForTest(null);
});

beforeEach(() => {
  // Reset the test path override before each test
  setServerEnvPathForTest(null);

  // Snapshot global state to prevent cross-test leaks
  savedCwd = process.cwd();
  savedEnv = { ...process.env };
});

afterEach(() => {
  // Restore global state unconditionally, even if the test threw
  // This prevents mutation leaks into subsequent tests
  setServerEnvPathForTest(null);

  if (process.cwd() !== savedCwd) {
    process.chdir(savedCwd);
  }

  // Restore process.env: remove any added keys and restore modified ones
  for (const key in process.env) {
    if (!(key in savedEnv)) {
      delete process.env[key];
    }
  }
  for (const key in savedEnv) {
    process.env[key] = savedEnv[key];
  }
});

describe('POST /api/config/env-cleanup', () => {
  it('(Part A) after cleanup, GET /api/config no longer lists the candidate', async () => {
    setServerEnvPathForTest(envTestPath);

    // Before cleanup, GET should list STAGE2_MIN_COVERAGE as a candidate
    // because the .env file contains "STAGE2_MIN_COVERAGE=0.6" which matches
    // the shipped default 0.6.
    const getBeforeRes = await request(app).get('/api/config');
    expect(getBeforeRes.status).toBe(200);
    expect(getBeforeRes.body.envCleanupCandidates).toContain('analyzer.stage2.minCoverage');

    // Call cleanup
    const cleanupRes = await request(app).post('/api/config/env-cleanup');
    expect(cleanupRes.status).toBe(200);
    expect(cleanupRes.body.cleaned).toContain('STAGE2_MIN_COVERAGE');

    // After cleanup (in the SAME process, no restart), GET should no longer
    // list the candidate because the .env file now has the line commented out.
    const getAfterRes = await request(app).get('/api/config');
    expect(getAfterRes.status).toBe(200);
    expect(getAfterRes.body.envCleanupCandidates).not.toContain('analyzer.stage2.minCoverage');
  });

  it('(Part B) second cleanup with no candidates does not overwrite backup', async () => {
    // Re-seed a fresh .env file with a candidate
    const env2Path = join(tmpDir, '.env.test2');
    writeFileSync(
      env2Path,
      [
        '# Leftover from example',
        'STAGE2_MIN_COVERAGE=0.6',
        '# Another comment',
        'SOME_UNRELATED_VAR=value',
        '',
      ].join('\n'),
      'utf-8',
    );

    const bakPath = `${env2Path}.bak`;
    setServerEnvPathForTest(env2Path);

    // First cleanup: should write the original .env to .env.bak and comment out the candidate
    const cleanup1Res = await request(app).post('/api/config/env-cleanup');
    expect(cleanup1Res.status).toBe(200);
    expect(cleanup1Res.body.cleaned).toContain('STAGE2_MIN_COVERAGE');

    // Verify backup was created and contains the original content (including the uncommented candidate)
    expect(existsSync(bakPath)).toBe(true);
    const bakContentAfterFirst = readFileSync(bakPath, 'utf-8');
    expect(bakContentAfterFirst).toContain('STAGE2_MIN_COVERAGE=0.6');

    // Read the current .env (should be cleaned)
    const envAfterFirst = readFileSync(env2Path, 'utf-8');
    expect(envAfterFirst).toContain('# STAGE2_MIN_COVERAGE=0.6');
    expect(envAfterFirst).not.toMatch(/^STAGE2_MIN_COVERAGE=/m);

    // Second cleanup: no candidates remain, so it should:
    // - Return empty cleaned array
    // - NOT overwrite .env.bak (it should stay unchanged)
    // - NOT modify .env (no changes to make)
    const cleanup2Res = await request(app).post('/api/config/env-cleanup');
    expect(cleanup2Res.status).toBe(200);
    expect(cleanup2Res.body.cleaned).toEqual([]);

    // Verify .env.bak was NOT overwritten
    const bakContentAfterSecond = readFileSync(bakPath, 'utf-8');
    expect(bakContentAfterSecond).toEqual(bakContentAfterFirst);

    // Verify the current .env is still the same (no new changes)
    const envAfterSecond = readFileSync(env2Path, 'utf-8');
    expect(envAfterSecond).toEqual(envAfterFirst);
  });

  it('(Part C) query parameter envPath is ignored (security regression test)', async () => {
    // Create two different .env files with different content
    const realEnvPath = join(tmpDir, '.env.real');
    const attackerPath = join(tmpDir, '.env.attacker');

    writeFileSync(
      realEnvPath,
      [
        '# Real server env',
        'STAGE2_MIN_COVERAGE=0.6',
        '',
      ].join('\n'),
      'utf-8',
    );

    writeFileSync(
      attackerPath,
      [
        '# Attacker-controlled file',
        'GEMINI_API_KEY=fake-key',
        '',
      ].join('\n'),
      'utf-8',
    );

    setServerEnvPathForTest(realEnvPath);

    // Try to use a query parameter to point at the attacker-controlled path.
    // The handler MUST ignore this and still use the real path.
    const getRes = await request(app)
      .get('/api/config')
      .query({ envPath: attackerPath });

    expect(getRes.status).toBe(200);
    // The response should contain candidates from realEnvPath, not attackerPath
    expect(getRes.body.envCleanupCandidates).toContain('analyzer.stage2.minCoverage');
    // GEMINI_API_KEY is not a cleanup candidate (it's a secret), so this proves
    // we read from the real path, not the attacker's path
  });

  it('(Part D) POST also ignores envPath query parameter', async () => {
    // Create a distinct test file for this check
    const postTestPath = join(tmpDir, '.env.post-test');
    const attackerPath = join(tmpDir, '.env.post-attacker');

    writeFileSync(
      postTestPath,
      [
        '# Real POST test env',
        'STAGE2_MIN_COVERAGE=0.6',
        '',
      ].join('\n'),
      'utf-8',
    );

    writeFileSync(attackerPath, '# Empty attacker file\n', 'utf-8');
    setServerEnvPathForTest(postTestPath);

    // Try POST with a malicious envPath query parameter pointing to attacker's file
    const postRes = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: attackerPath });

    expect(postRes.status).toBe(200);
    // Should have cleaned from the real path, not the attacker path
    expect(postRes.body.cleaned).toContain('STAGE2_MIN_COVERAGE');

    // Verify the real file was cleaned, not the attacker's
    const realFileContent = readFileSync(postTestPath, 'utf-8');
    expect(realFileContent).toContain('# STAGE2_MIN_COVERAGE=0.6');

    const attackerFileContent = readFileSync(attackerPath, 'utf-8');
    expect(attackerFileContent).toBe('# Empty attacker file\n'); // unchanged
  });

  it('exercises the default env-path resolution (no override)', async () => {
    // This test verifies that resolveServerEnvPath() correctly falls back to
    // the DEFAULT branch (resolve(process.cwd(), '.env')) when no override is set.
    // All other tests set an override, leaving the default path untested.
    //
    // Strategy: Change to a temp directory that contains a .env file, ensure
    // the override is null, call the route, and verify it uses the default path.
    // Cleanup is guaranteed by the afterEach hook that restores process.cwd().

    const testEnvDir = join(tmpDir, '.env-default-test');
    mkdirSync(testEnvDir, { recursive: true });
    const defaultEnvPath = join(testEnvDir, '.env');

    // Create a .env file in the test directory
    writeFileSync(
      defaultEnvPath,
      [
        '# Test .env using default path resolution',
        'STAGE2_MIN_COVERAGE=0.6',
        'SOME_OTHER_VAR=value',
        '',
      ].join('\n'),
      'utf-8',
    );

    // Change to the test directory so that resolve(process.cwd(), '.env')
    // points to our test .env file.
    // The afterEach hook will restore the original cwd unconditionally.
    process.chdir(testEnvDir);

    // Ensure override is null (beforeEach should have already done this)
    setServerEnvPathForTest(null);

    // GET /api/config should read from the default .env location
    const getRes = await request(app).get('/api/config');
    expect(getRes.status).toBe(200);
    expect(getRes.body.envCleanupCandidates).toContain('analyzer.stage2.minCoverage');

    // POST /api/config/env-cleanup should also use the default path
    const cleanupRes = await request(app).post('/api/config/env-cleanup');
    expect(cleanupRes.status).toBe(200);
    expect(cleanupRes.body.cleaned).toContain('STAGE2_MIN_COVERAGE');

    // Verify the file was actually cleaned (not some override)
    const cleanedContent = readFileSync(defaultEnvPath, 'utf-8');
    expect(cleanedContent).toContain('# STAGE2_MIN_COVERAGE=0.6');
    expect(cleanedContent).not.toMatch(/^STAGE2_MIN_COVERAGE=/m);
  });
});
