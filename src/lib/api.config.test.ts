/* api.config.test.ts — covers the /api/config mock round-trip.
   Imports the mock functions directly (bypassing the USE_MOCKS toggle,
   which is locked at api.ts import time). */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  mockGetConfig,
  mockPutConfig,
  mockResetConfig,
  mockGetPrompt,
  mockPutPrompt,
  mockResetPrompt,
  mockRestartSidecar,
  _resetMockConfig,
} from './api';

beforeEach(() => {
  _resetMockConfig();
});

describe('mockGetConfig', () => {
  it('returns groups, descriptors, and values', async () => {
    const result = await mockGetConfig();
    expect(result.groups.length).toBeGreaterThan(0);
    expect(result.descriptors.length).toBeGreaterThan(0);
    expect(typeof result.values).toBe('object');
    expect(result.restartPending).toBe(false);
  });

  it('returns at least 3 descriptors across representative types', async () => {
    const { descriptors } = await mockGetConfig();
    expect(descriptors.length).toBeGreaterThanOrEqual(3);
    const types = descriptors.map((d) => d.type);
    expect(types).toContain('integer');
    expect(types).toContain('boolean');
  });

  it('each descriptor has a matching entry in values', async () => {
    const { descriptors, values } = await mockGetConfig();
    for (const d of descriptors) {
      expect(values).toHaveProperty(d.key);
    }
  });
});

describe('mockPutConfig round-trip', () => {
  it('updates a numeric knob and reflects it in values', async () => {
    const putResult = await mockPutConfig({ KOKORO_SAMPLE_RATE: 16000 });
    expect(putResult.ok).toBe(true);
    expect(putResult.applied).toContain('KOKORO_SAMPLE_RATE');
    expect(putResult.values.KOKORO_SAMPLE_RATE.effective).toBe(16000);
    expect(putResult.values.KOKORO_SAMPLE_RATE.overridden).toBe(true);
    expect(putResult.values.KOKORO_SAMPLE_RATE.source).toBe('override');
  });

  it('updates a boolean knob and reflects it in values', async () => {
    const putResult = await mockPutConfig({ SEG_ASR_ENABLED: true });
    expect(putResult.ok).toBe(true);
    expect(putResult.values.SEG_ASR_ENABLED.effective).toBe(true);
    expect(putResult.values.SEG_ASR_ENABLED.overridden).toBe(true);
  });

  it('persists the override so a subsequent getConfig reflects it', async () => {
    await mockPutConfig({ SEG_QA_MAX_RERECORDS: 5 });
    const { values } = await mockGetConfig();
    expect(values.SEG_QA_MAX_RERECORDS.effective).toBe(5);
    expect(values.SEG_QA_MAX_RERECORDS.overridden).toBe(true);
  });
});

describe('mockResetConfig round-trip', () => {
  it('resets a specific key back to its default', async () => {
    await mockPutConfig({ KOKORO_SAMPLE_RATE: 8000 });
    const afterPut = await mockGetConfig();
    expect(afterPut.values.KOKORO_SAMPLE_RATE.effective).toBe(8000);

    const resetResult = await mockResetConfig({ keys: ['KOKORO_SAMPLE_RATE'] });
    expect(resetResult.ok).toBe(true);
    expect(resetResult.values.KOKORO_SAMPLE_RATE.effective).toBe(24000);
    expect(resetResult.values.KOKORO_SAMPLE_RATE.overridden).toBe(false);
    expect(resetResult.values.KOKORO_SAMPLE_RATE.source).toBe('default');
  });

  it('resets all keys when all:true', async () => {
    await mockPutConfig({ KOKORO_SAMPLE_RATE: 8000, SEG_QA_MAX_RERECORDS: 7 });
    const resetResult = await mockResetConfig({ all: true });
    expect(resetResult.values.KOKORO_SAMPLE_RATE.effective).toBe(24000);
    expect(resetResult.values.SEG_QA_MAX_RERECORDS.effective).toBe(2);
  });

  it('resets keys in a group', async () => {
    await mockPutConfig({ SEG_ASR_ENABLED: true, SEG_QA_MAX_RERECORDS: 9 });
    const resetResult = await mockResetConfig({ group: 'tts' });
    expect(resetResult.values.SEG_ASR_ENABLED.effective).toBe(false);
    expect(resetResult.values.SEG_QA_MAX_RERECORDS.effective).toBe(2);
    /* Analyzer group key should be unaffected */
    expect(resetResult.values.ANALYZER_STAGE1_PROMPT.effective).toBe(
      'Attribute each sentence to its speaker.',
    );
  });
});

describe('mockGetPrompt / mockPutPrompt / mockResetPrompt', () => {
  it('getPrompt returns the default state for a known prompt', async () => {
    const prompt = await mockGetPrompt('ANALYZER_STAGE1_PROMPT');
    expect(prompt.id).toBe('ANALYZER_STAGE1_PROMPT');
    expect(prompt.isForked).toBe(false);
    expect(prompt.text).toBe(prompt.defaultText);
  });

  it('putPrompt forks the prompt when text differs from default', async () => {
    const updated = await mockPutPrompt('ANALYZER_STAGE1_PROMPT', 'Custom attribution prompt');
    expect(updated.isForked).toBe(true);
    expect(updated.text).toBe('Custom attribution prompt');
    expect(updated.defaultText).toBe('Attribute each sentence to its speaker.');
  });

  it('putPrompt then getPrompt reflects the forked state', async () => {
    await mockPutPrompt('ANALYZER_STAGE1_PROMPT', 'My custom prompt');
    const after = await mockGetPrompt('ANALYZER_STAGE1_PROMPT');
    expect(after.text).toBe('My custom prompt');
    expect(after.isForked).toBe(true);
  });

  it('resetPrompt reverts to default and clears isForked', async () => {
    await mockPutPrompt('ANALYZER_STAGE1_PROMPT', 'Custom text');
    const reset = await mockResetPrompt('ANALYZER_STAGE1_PROMPT');
    expect(reset.isForked).toBe(false);
    expect(reset.text).toBe('Attribute each sentence to its speaker.');
  });
});

describe('mockRestartSidecar', () => {
  it('returns ok:true', async () => {
    const result = await mockRestartSidecar();
    expect(result.ok).toBe(true);
  });
});
