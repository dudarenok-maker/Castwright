/* Integration test for POST /api/config/env-cleanup.

   Asserts that:
   1. (Part A) After cleanup, GET /api/config no longer lists the cleaned
      candidates, without needing a server restart (the cleanup and subsequent
      GET run in the same process, so process.env has not been reloaded).
   2. (Part B) A second cleanup call with no remaining candidates does not
      overwrite the .env.bak backup from the first cleanup.

   Uses a temp .env file injected via the ?envPath query param so the test
   doesn't touch the real server/.env. */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir, platform } from 'node:os';
import { join } from 'node:path';
import express, { type Express } from 'express';
import request from 'supertest';

let tmpDir: string;
let app: Express;
let envTestPath: string;

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
  const { configRouter } = await import('./config.js');

  app = express();
  app.use(express.json());
  app.use('/api/config', configRouter);
});

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('POST /api/config/env-cleanup', () => {
  it('(Part A) after cleanup, GET /api/config no longer lists the candidate', async () => {
    // Before cleanup, GET should list STAGE2_MIN_COVERAGE as a candidate
    // because the .env file contains "STAGE2_MIN_COVERAGE=0.6" which matches
    // the shipped default 0.6.
    const getBeforeRes = await request(app)
      .get('/api/config')
      .query({ envPath: envTestPath });
    expect(getBeforeRes.status).toBe(200);
    expect(getBeforeRes.body.envCleanupCandidates).toContain('analyzer.stage2.minCoverage');

    // Call cleanup
    const cleanupRes = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: envTestPath });
    expect(cleanupRes.status).toBe(200);
    expect(cleanupRes.body.cleaned).toContain('STAGE2_MIN_COVERAGE');

    // After cleanup (in the SAME process, no restart), GET should no longer
    // list the candidate because the .env file now has the line commented out.
    const getAfterRes = await request(app)
      .get('/api/config')
      .query({ envPath: envTestPath });
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

    // First cleanup: should write the original .env to .env.bak and comment out the candidate
    const cleanup1Res = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: env2Path });
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
    const cleanup2Res = await request(app)
      .post('/api/config/env-cleanup')
      .query({ envPath: env2Path });
    expect(cleanup2Res.status).toBe(200);
    expect(cleanup2Res.body.cleaned).toEqual([]);

    // Verify .env.bak was NOT overwritten
    const bakContentAfterSecond = readFileSync(bakPath, 'utf-8');
    expect(bakContentAfterSecond).toEqual(bakContentAfterFirst);

    // Verify the current .env is still the same (no new changes)
    const envAfterSecond = readFileSync(env2Path, 'utf-8');
    expect(envAfterSecond).toEqual(envAfterFirst);
  });
});
