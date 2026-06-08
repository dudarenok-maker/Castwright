/* Tests for the prompt-fork loader (server/src/config/prompts.ts).

   Isolation: each test gets its own temp directory pointed at by
   USER_SETTINGS_FILE (so writeConfigOverride never touches real settings)
   and CASTWRIGHT_PROMPTS_DIR (so fork files never touch ~/.castwright).
   The user-settings module cache is reset between tests via
   _resetUserSettingsCache() — same pattern as config.test.ts.

   vi.resetModules() + dynamic import is used so the module re-evaluates
   PROMPT_IDS from the registry on each test (handles the env change for
   CASTWRIGHT_PROMPTS_DIR isolation). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let tmpDir: string;
let resetCache: () => void;

beforeEach(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'cw-prompts-test-'));
  process.env.USER_SETTINGS_FILE = join(tmpDir, 'user-settings.json');
  process.env.CASTWRIGHT_PROMPTS_DIR = join(tmpDir, 'prompts');

  // Reset the user-settings in-process cache so each test starts cold.
  const us = await import('../workspace/user-settings.js');
  resetCache = us._resetUserSettingsCache;
  resetCache();

  // Reset modules so prompts.ts re-binds resolvePromptDir() to the new env.
  vi.resetModules();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.USER_SETTINGS_FILE;
  delete process.env.CASTWRIGHT_PROMPTS_DIR;
  resetCache?.();
  vi.resetModules();
});

describe('readPrompt — default (no fork)', () => {
  it('returns the shipped default before forking', async () => {
    const { readPrompt } = await import('./prompts.js');
    const p = await readPrompt('prompt.sentenceAttribution');
    expect(p.isForked).toBe(false);
    expect(p.text.length).toBeGreaterThan(0);
    expect(p.text).toBe(p.defaultText);
    // The shipped skill file has known content.
    expect(p.text).toMatch(/audiobook/i);
  });

  it('works for all four prompt ids', async () => {
    const { readPrompt, PROMPT_IDS } = await import('./prompts.js');
    for (const id of PROMPT_IDS) {
      const p = await readPrompt(id);
      expect(p.isForked).toBe(false);
      expect(p.text.length).toBeGreaterThan(0);
    }
  });

  it('throws for an unknown id', async () => {
    const { readPrompt } = await import('./prompts.js');
    await expect(readPrompt('prompt.doesNotExist')).rejects.toThrow(/Unknown prompt id/);
  });
});

describe('writeForkedPrompt + readPrompt', () => {
  it('fork then read returns the fork', async () => {
    const { readPrompt, writeForkedPrompt } = await import('./prompts.js');
    await writeForkedPrompt('prompt.sentenceAttribution', 'MY CUSTOM PROMPT');
    const p = await readPrompt('prompt.sentenceAttribution');
    expect(p.isForked).toBe(true);
    expect(p.text).toBe('MY CUSTOM PROMPT');
    // defaultText is always the shipped file.
    expect(p.defaultText.length).toBeGreaterThan(0);
    expect(p.defaultText).not.toBe('MY CUSTOM PROMPT');
  });

  it('fork then read then reset restores default', async () => {
    const { readPrompt, writeForkedPrompt, resetPrompt } = await import('./prompts.js');
    await writeForkedPrompt('prompt.sentenceAttribution', 'MY CUSTOM PROMPT');
    let p = await readPrompt('prompt.sentenceAttribution');
    expect(p.isForked).toBe(true);
    expect(p.text).toBe('MY CUSTOM PROMPT');

    await resetPrompt('prompt.sentenceAttribution');
    p = await readPrompt('prompt.sentenceAttribution');
    expect(p.isForked).toBe(false);
    expect(p.text).toBe(p.defaultText);
  });

  it('throws on unknown id for writeForkedPrompt', async () => {
    const { writeForkedPrompt } = await import('./prompts.js');
    await expect(writeForkedPrompt('prompt.nope', 'text')).rejects.toThrow(/Unknown prompt id/);
  });

  it('throws on unknown id for resetPrompt', async () => {
    const { resetPrompt } = await import('./prompts.js');
    await expect(resetPrompt('prompt.nope')).rejects.toThrow(/Unknown prompt id/);
  });

  it('fork file content survives across reads', async () => {
    const { readPrompt, writeForkedPrompt } = await import('./prompts.js');
    const customText = 'UNIQUE FORK TEXT ' + Math.random();
    await writeForkedPrompt('prompt.castDetection', customText);
    const p1 = await readPrompt('prompt.castDetection');
    const p2 = await readPrompt('prompt.castDetection');
    expect(p1.text).toBe(customText);
    expect(p2.text).toBe(customText);
  });

  it('each prompt id can be forked independently', async () => {
    const { readPrompt, writeForkedPrompt } = await import('./prompts.js');
    await writeForkedPrompt('prompt.castDetection', 'FORK A');
    await writeForkedPrompt('prompt.sentenceAttribution', 'FORK B');

    const a = await readPrompt('prompt.castDetection');
    const b = await readPrompt('prompt.sentenceAttribution');
    const c = await readPrompt('prompt.emotionAnnotation'); // not forked

    expect(a.isForked).toBe(true);
    expect(a.text).toBe('FORK A');
    expect(b.isForked).toBe(true);
    expect(b.text).toBe('FORK B');
    expect(c.isForked).toBe(false);
  });
});

describe('resetPrompt', () => {
  it('reset is a no-op when no fork exists (no throw)', async () => {
    const { resetPrompt, readPrompt } = await import('./prompts.js');
    await expect(resetPrompt('prompt.voiceStyle')).resolves.toBeUndefined();
    const p = await readPrompt('prompt.voiceStyle');
    expect(p.isForked).toBe(false);
  });

  it('fork then reset then re-fork works cleanly', async () => {
    const { readPrompt, writeForkedPrompt, resetPrompt } = await import('./prompts.js');
    await writeForkedPrompt('prompt.sentenceAttribution', 'FIRST FORK');
    await resetPrompt('prompt.sentenceAttribution');
    await writeForkedPrompt('prompt.sentenceAttribution', 'SECOND FORK');
    const p = await readPrompt('prompt.sentenceAttribution');
    expect(p.isForked).toBe(true);
    expect(p.text).toBe('SECOND FORK');
  });
});
