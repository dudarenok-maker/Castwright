import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEval, slotLabel } from './run-eval-cli.js';

describe('runEval gating', () => {
  it('SKIPs cleanly when the corpus dir is empty', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'empty-corpus-'));
    const res = await runEval({ engines: ['qwen'], corpusDir: empty });
    expect(res.skipped).toMatch(/no corpus/i);
  });
});

describe('slotLabel', () => {
  it('labels qwen with the resolved model id', () => {
    const prev = process.env.EVAL_QWEN_MODEL;
    process.env.EVAL_QWEN_MODEL = 'qwen36-cw-iq4-32k';
    try {
      expect(slotLabel('qwen')).toBe('qwen:qwen36-cw-iq4-32k');
    } finally {
      if (prev === undefined) delete process.env.EVAL_QWEN_MODEL;
      else process.env.EVAL_QWEN_MODEL = prev;
    }
  });

  it('labels gemma with the resolved GEMINI_MODEL so flash-lite is not printed as bare "gemma"', () => {
    const prev = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-3.1-flash-lite';
    try {
      expect(slotLabel('gemma')).toBe('gemma:gemini-3.1-flash-lite');
    } finally {
      if (prev === undefined) delete process.env.GEMINI_MODEL;
      else process.env.GEMINI_MODEL = prev;
    }
  });

  it('falls back to the default gemma model id when GEMINI_MODEL is unset', () => {
    const prev = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;
    try {
      expect(slotLabel('gemma')).toBe('gemma:gemma-4-31b-it');
    } finally {
      if (prev !== undefined) process.env.GEMINI_MODEL = prev;
    }
  });
});
