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
import { PAIR_RULES } from '../../server/src/config/pair-rules';

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

describe('mockPutConfig — qa.asr.device pattern validation (#2209)', () => {
  /* Mirrors the real PUT /api/config route's per-key pattern validation
     (server/src/config/registry.ts's qa.asr.device pattern, applied by
     resolver.ts's coerceAndValidate) — #2180's own "cuda1 typo" example,
     on the exact knob it names. Exercises the chain end-to-end: a rejected
     mock-mode save must be shaped exactly like realPutConfig's thrown
     Error so describeConfigSaveError (override-row.tsx) parses either one
     identically. */
  it('rejects an invalid device string with a 400-shaped error', async () => {
    await expect(mockPutConfig({ 'qa.asr.device': 'cuda1' })).rejects.toThrow(
      /^Config update failed \(400\): \{"error":"qa\.asr\.device: does not match the required shape/,
    );
  });

  it('does not persist the rejected value', async () => {
    await expect(mockPutConfig({ 'qa.asr.device': 'cuda1' })).rejects.toThrow();
    const { values } = await mockGetConfig();
    expect(values['qa.asr.device'].effective).toBe('cpu');
    expect(values['qa.asr.device'].overridden).toBe(false);
  });

  it.each(['cpu', 'auto', 'cuda', 'cuda:0', 'cuda:12', 'CUDA:1'])(
    'accepts %s',
    async (good) => {
      const result = await mockPutConfig({ 'qa.asr.device': good });
      expect(result.ok).toBe(true);
      expect(result.values['qa.asr.device'].effective).toBe(good);
    },
  );
});

/* #2209 review B4 — mockAsrPairError (api.ts) mirrors the real
   ASR_DEVICE_COMPUTE_TYPE_RULE (server/src/config/pair-rules.ts). Every
   test below asserts the mock's thrown message is BYTE-IDENTICAL to
   calling the REAL rule directly — imported, not re-typed — so the mock
   can't quietly drift from the real wording the way the wrapper verb
   already had (B1). */
describe('mockPutConfig — cross-field pair rule (#2209 review B4)', () => {
  const realCheck = PAIR_RULES[0].check;

  it('rejects an unsupported device+computeType pair with the REAL rule message', async () => {
    const expected = realCheck({ 'qa.asr.device': 'cuda', 'qa.asr.computeType': 'int16' });
    expect(expected).not.toBeNull();
    await expect(
      mockPutConfig({ 'qa.asr.device': 'cuda', 'qa.asr.computeType': 'int16' }),
    ).rejects.toThrow(`Config update failed (400): ${JSON.stringify({ error: expected })}`);
  });

  it('rejects when only computeType is patched and the CURRENT device makes the pair invalid', async () => {
    // qa.asr.device defaults to 'cpu'; int16 isn't supported on cpu either
    // — the patch only touches computeType, but the route (and the mock)
    // must validate against the RESULTING effective pair, not the patch
    // in isolation.
    const expected = realCheck({ 'qa.asr.device': 'cpu', 'qa.asr.computeType': 'int16' });
    expect(expected).not.toBeNull();
    await expect(mockPutConfig({ 'qa.asr.computeType': 'int16' })).rejects.toThrow(
      `Config update failed (400): ${JSON.stringify({ error: expected })}`,
    );
  });

  it('accepts a supported pair', async () => {
    expect(realCheck({ 'qa.asr.device': 'cuda', 'qa.asr.computeType': 'float16' })).toBeNull();
    const result = await mockPutConfig({ 'qa.asr.device': 'cuda', 'qa.asr.computeType': 'float16' });
    expect(result.ok).toBe(true);
  });

  it('accepts a sentinel computeType regardless of device', async () => {
    expect(realCheck({ 'qa.asr.device': 'cuda', 'qa.asr.computeType': 'auto' })).toBeNull();
    const result = await mockPutConfig({ 'qa.asr.device': 'cuda', 'qa.asr.computeType': 'auto' });
    expect(result.ok).toBe(true);
  });

  it('does not run the pair check when the patch touches neither key', async () => {
    const result = await mockPutConfig({ KOKORO_SAMPLE_RATE: 16000 });
    expect(result.ok).toBe(true);
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

/* #2209 review B1/B4 — a reset never revalidates a per-key pattern (it
   always restores a key's own, trivially-valid default), so the
   cross-field pair rule is the ONLY way either the real or the mock reset
   route can fail at all. This is #2180's own regression shape, on the
   reset path specifically: PUT enforces the pair rule, but POST /reset
   shipped without it, so the Revert button could re-create the exact bad
   pair the save path had just refused, in two clicks (Refs #2180 on-box
   register: "the UI can no longer produce this state" — it still could,
   through Revert). */
describe('mockResetConfig — cross-field pair rule (#2209 review B4)', () => {
  const realCheck = PAIR_RULES[0].check;

  it('rejects a Revert that would re-create the exact bad pair the save path just refused', async () => {
    // A valid pair, set via two saves — mirrors a real user's two clicks.
    await mockPutConfig({ 'qa.asr.device': 'cuda' });
    await mockPutConfig({ 'qa.asr.computeType': 'float16' });

    // Reverting qa.asr.device alone clears it back to its default (cpu),
    // while qa.asr.computeType stays pinned at float16 — cpu+float16 is
    // exactly the bad pair PUT would have refused outright.
    const expected = realCheck({ 'qa.asr.device': 'cpu', 'qa.asr.computeType': 'float16' });
    expect(expected).not.toBeNull();
    await expect(mockResetConfig({ keys: ['qa.asr.device'] })).rejects.toThrow(
      `Config reset failed (400): ${JSON.stringify({ error: expected })}`,
    );
  });

  it('does not clear anything when the reset is rejected', async () => {
    await mockPutConfig({ 'qa.asr.device': 'cuda' });
    await mockPutConfig({ 'qa.asr.computeType': 'float16' });

    await expect(mockResetConfig({ keys: ['qa.asr.device'] })).rejects.toThrow();

    const { values } = await mockGetConfig();
    expect(values['qa.asr.device'].effective).toBe('cuda');
    expect(values['qa.asr.device'].overridden).toBe(true);
  });

  it('allows resetting BOTH pair-rule keys together — both defaults are a valid (sentinel) pair', async () => {
    await mockPutConfig({ 'qa.asr.device': 'cuda' });
    await mockPutConfig({ 'qa.asr.computeType': 'float16' });

    expect(realCheck({ 'qa.asr.device': 'cpu', 'qa.asr.computeType': 'sidecar-default' })).toBeNull();
    const result = await mockResetConfig({ keys: ['qa.asr.device', 'qa.asr.computeType'] });
    expect(result.ok).toBe(true);
    expect(result.values['qa.asr.device'].effective).toBe('cpu');
    expect(result.values['qa.asr.computeType'].effective).toBe('sidecar-default');
  });

  it('does not run the pair check when the reset touches neither key', async () => {
    await mockPutConfig({ KOKORO_SAMPLE_RATE: 8000 });
    const result = await mockResetConfig({ keys: ['KOKORO_SAMPLE_RATE'] });
    expect(result.ok).toBe(true);
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

  /* #1786: the §12 dialogue-structure attribution group was absent from the
     mock entirely, so it could not be screenshotted for the wiki. Same
     mirror-the-registry-exactly guard as gpu-lifecycle above. */
  it('analyzer-structure descriptor keys mirror the registry group', async () => {
    const { descriptors } = await mockGetConfig();
    const mockKeys = descriptors
      .filter((d) => d.group === 'analyzer-structure')
      .map((d) => d.key)
      .sort();
    const registryKeys = knobsInGroup('analyzer-structure')
      .map((k) => k.key)
      .sort();
    expect(mockKeys).toEqual(registryKeys);
    expect(mockKeys.length).toBeGreaterThan(0);
  });

  it('analyzer-structure group blurb matches the registry', async () => {
    const { groups } = await mockGetConfig();
    const mockGroup = groups.find((g) => g.id === 'analyzer-structure');
    const registryGroup = GROUPS.find((g) => g.id === 'analyzer-structure');
    expect(mockGroup?.help).toBe(registryGroup?.help);
  });
});
