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
import { knobsInGroup, GROUPS } from '../../server/src/config/registry';

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
    const putResult = await mockPutConfig({ 'qa.asr.enabled': true });
    expect(putResult.ok).toBe(true);
    expect(putResult.values['qa.asr.enabled'].effective).toBe(true);
    expect(putResult.values['qa.asr.enabled'].overridden).toBe(true);
  });

  it('persists the override so a subsequent getConfig reflects it', async () => {
    await mockPutConfig({ 'qa.seg.maxRerecords': 5 });
    const { values } = await mockGetConfig();
    expect(values['qa.seg.maxRerecords'].effective).toBe(5);
    expect(values['qa.seg.maxRerecords'].overridden).toBe(true);
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
    await mockPutConfig({ KOKORO_SAMPLE_RATE: 8000, 'qa.seg.maxRerecords': 7 });
    const resetResult = await mockResetConfig({ all: true });
    expect(resetResult.values.KOKORO_SAMPLE_RATE.effective).toBe(24000);
    expect(resetResult.values['qa.seg.maxRerecords'].effective).toBe(2);
  });

  it('resets keys in a group', async () => {
    await mockPutConfig({ 'qa.asr.enabled': true, 'qa.seg.maxRerecords': 9 });
    const resetResult = await mockResetConfig({ group: 'qa-gates' });
    expect(resetResult.values['qa.asr.enabled'].effective).toBe(false);
    expect(resetResult.values['qa.seg.maxRerecords'].effective).toBe(2);
    /* Analyzer group key should be unaffected */
    expect(resetResult.values.ANALYZER_STAGE1_PROMPT.effective).toBe(
      'Attribute each sentence to its speaker.',
    );
  });
});

describe('_resetMockConfig', () => {
  it('resets tts.qwen.device back to its default after an override', async () => {
    await mockPutConfig({ 'tts.qwen.device': 'cuda' });
    const afterPut = await mockGetConfig();
    expect(afterPut.values['tts.qwen.device'].effective).toBe('cuda');

    _resetMockConfig();
    const afterReset = await mockGetConfig();
    expect(afterReset.values['tts.qwen.device'].effective).toBe('auto');
    expect(afterReset.values['tts.qwen.device'].overridden).toBe(false);
    expect(afterReset.values['tts.qwen.device'].source).toBe('default');
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

describe('mock config parity with the server registry', () => {
  /* Regression guard for the #1743 drift: the capacity-admission cutover
     (#1737) deleted the weighted-semaphore knobs (gpu.concurrency /
     gpu.vramBudget / gpu.weight.* / gpu.safeCoexistMb) from the server
     registry.ts, but the hand-copied MOCK_CONFIG_DESCRIPTORS kept them and
     never gained gpu.reserveMb — so mock mode (and the §9 wiki screenshots
     captured from it) rendered retired knobs. The mock is deliberately a
     SUBSET of the registry, so we don't assert full-catalog parity; but the
     gpu-lifecycle group must mirror the registry exactly, or this class of
     drift silently returns. */
  it('gpu-lifecycle descriptor keys mirror the registry group', async () => {
    const { descriptors } = await mockGetConfig();
    const mockKeys = descriptors
      .filter((d) => d.group === 'gpu-lifecycle')
      .map((d) => d.key)
      .sort();
    const registryKeys = knobsInGroup('gpu-lifecycle')
      .map((k) => k.key)
      .sort();
    expect(mockKeys).toEqual(registryKeys);
    // The retired knobs must be gone from the mock specifically.
    for (const dead of ['gpu.concurrency', 'gpu.vramBudget', 'gpu.safeCoexistMb']) {
      expect(mockKeys).not.toContain(dead);
    }
    expect(mockKeys).toContain('gpu.reserveMb');
  });

  it('gpu-lifecycle group blurb matches the registry', async () => {
    const { groups } = await mockGetConfig();
    const mockGroup = groups.find((g) => g.id === 'gpu-lifecycle');
    const registryGroup = GROUPS.find((g) => g.id === 'gpu-lifecycle');
    expect(mockGroup?.help).toBe(registryGroup?.help);
  });
});
