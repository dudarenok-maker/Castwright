/* Unit tests for the analysis-state.json read/write/delete helpers.

   Mirrors the dropped-quotes.test.ts pattern: tempdir per-test, real
   atomic writes against the real filesystem (so we exercise the
   renameWithRetry path). Frontend / endpoint tests live in
   book-state.test.ts. */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  readAnalysisState,
  writeAnalysisState,
  deleteAnalysisState,
  type AnalysisStateFile,
} from './analysis-state.js';
import { analysisStateJsonPath } from '../workspace/paths.js';

let bookDir: string;

beforeEach(() => {
  bookDir = mkdtempSync(join(tmpdir(), 'audiobook-analysis-state-'));
  mkdirSync(join(bookDir, '.audiobook'), { recursive: true });
});

afterEach(() => {
  rmSync(bookDir, { recursive: true, force: true });
});

describe('analysis-state store', () => {
  it('readAnalysisState returns null when no file exists', async () => {
    const got = await readAnalysisState(bookDir);
    expect(got).toBeNull();
  });

  it('writeAnalysisState then readAnalysisState round-trips the snapshot', async () => {
    await writeAnalysisState(bookDir, {
      manuscriptId: 'm_test',
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      state: 'running',
      lastTickAt: 1_700_000_000_000,
    });

    const got = await readAnalysisState(bookDir);
    expect(got).not.toBeNull();
    expect(got).toMatchObject({
      manuscriptId: 'm_test',
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.42,
      state: 'running',
      lastTickAt: 1_700_000_000_000,
    });
    /* writtenAt is stamped by the writer at write time. Must be a
       number, must be ≤ now. */
    expect(typeof got!.writtenAt).toBe('number');
    expect(got!.writtenAt).toBeLessThanOrEqual(Date.now());
  });

  it('writeAnalysisState lands on disk under .audiobook/analysis-state.json', async () => {
    await writeAnalysisState(bookDir, {
      manuscriptId: 'm_test',
      phaseId: 0,
      phaseLabel: 'Detecting characters',
      phaseProgress: 0.1,
      state: 'paused',
      lastTickAt: Date.now(),
    });
    /* Read raw to assert the file path the discovery endpoint will
       look up — guards against a future rename that breaks the
       endpoint without touching this test. */
    const raw = readFileSync(analysisStateJsonPath(bookDir), 'utf8');
    const parsed = JSON.parse(raw) as AnalysisStateFile;
    expect(parsed.state).toBe('paused');
    expect(parsed.manuscriptId).toBe('m_test');
  });

  it('writeAnalysisState trims haltReason to 256 chars so the file does not bloat on a stack trace', async () => {
    const long = 'X'.repeat(1024);
    await writeAnalysisState(bookDir, {
      manuscriptId: 'm_test',
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.5,
      state: 'halted',
      haltCode: 'attribution_drift',
      haltReason: long,
      lastTickAt: Date.now(),
    });
    const got = await readAnalysisState(bookDir);
    expect(got!.haltReason).toHaveLength(256);
    expect(got!.haltReason).toBe('X'.repeat(256));
  });

  it('writeAnalysisState preserves haltCode without trimming', async () => {
    await writeAnalysisState(bookDir, {
      manuscriptId: 'm_test',
      phaseId: 0,
      phaseLabel: 'Detecting characters',
      phaseProgress: 0.2,
      state: 'halted',
      haltCode: 'cast_incomplete',
      haltReason: 'short',
      lastTickAt: Date.now(),
    });
    const got = await readAnalysisState(bookDir);
    expect(got!.haltCode).toBe('cast_incomplete');
    expect(got!.haltReason).toBe('short');
  });

  it('deleteAnalysisState removes the file when present', async () => {
    await writeAnalysisState(bookDir, {
      manuscriptId: 'm_test',
      phaseId: 1,
      phaseLabel: 'Parsing and attribution',
      phaseProgress: 0.7,
      state: 'running',
      lastTickAt: Date.now(),
    });
    expect(existsSync(analysisStateJsonPath(bookDir))).toBe(true);

    await deleteAnalysisState(bookDir);
    expect(existsSync(analysisStateJsonPath(bookDir))).toBe(false);
  });

  it('deleteAnalysisState is a no-op when the file is already missing', async () => {
    /* Idempotent — never throws. Mirrors the endJob path where we
       fire deleteAnalysisState whether or not a snapshot was ever
       written (Phase 2 only runs once Phase 0/1 both complete, but
       a fresh manuscript with zero prior writes still hits this). */
    await expect(deleteAnalysisState(bookDir)).resolves.toBeUndefined();
  });

  it('readAnalysisState returns null when the file is malformed JSON', async () => {
    /* OneDrive interrupted us mid-write, or a tester edited the file
       by hand. Caller should treat as "no state" rather than 500. */
    const fsMod = await import('node:fs/promises');
    await fsMod.writeFile(analysisStateJsonPath(bookDir), '{ not valid', 'utf8');
    const got = await readAnalysisState(bookDir);
    expect(got).toBeNull();
  });
});
