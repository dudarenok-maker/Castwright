import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval } from './run-eval-cli.js';

describe('runEval gating', () => {
  it('SKIPs cleanly when the corpus dir is empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-corpus-'));
    const res = await runEval({ engines: ['qwen'], corpusDir: empty });
    expect(res.skipped).toMatch(/no corpus/i);
  });
});
