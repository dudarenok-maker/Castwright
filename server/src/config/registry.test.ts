import { describe, it, expect } from 'vitest';
import { GROUPS, allKnobs, getKnob, knobByEnv, knobsInGroup } from './registry.js';

describe('config registry', () => {
  it('declares the ten groups', () => {
    expect(GROUPS.map((g) => g.id)).toEqual([
      'analyzer-sampling',
      'analyzer-chunking',
      'analyzer-prompts',
      'analyzer-models',
      'tts-engine',
      'tts-batching',
      'qa-gates',
      'audio-loudness',
      'gpu-lifecycle',
      'rate-limits',
    ]);
  });

  it('every knob has a unique key and a registered group', () => {
    const keys = new Set<string>();
    const groupIds = new Set(GROUPS.map((g) => g.id));
    for (const k of allKnobs()) {
      expect(keys.has(k.key), `dup key ${k.key}`).toBe(false);
      keys.add(k.key);
      expect(groupIds.has(k.group), `knob ${k.key} → unknown group ${k.group}`).toBe(true);
    }
  });

  it('every non-prompt knob has a unique env name', () => {
    const envs = new Set<string>();
    for (const k of allKnobs()) {
      if (k.isPrompt) continue;
      expect(envs.has(k.env), `dup env ${k.env}`).toBe(false);
      envs.add(k.env);
    }
  });

  it('getKnob resolves by key', () => {
    expect(getKnob('analyzer.stage2.minCoverage')?.env).toBe('STAGE2_MIN_COVERAGE');
  });

  it('knobByEnv resolves by env name (and misses cleanly)', () => {
    expect(knobByEnv('STAGE2_MIN_COVERAGE')?.key).toBe('analyzer.stage2.minCoverage');
    expect(knobByEnv('NOT_A_REAL_ENV')).toBeUndefined();
  });

  it('the ACCELERATOR knob is a rebuild-on-change enum (auto/nvidia/amd/cpu)', () => {
    const k = knobByEnv('ACCELERATOR');
    expect(k?.key).toBe('tts.accelerator');
    expect(k?.apply).toBe('rebuild');
    expect(k?.type).toBe('enum');
    expect(k?.options).toEqual(['auto', 'nvidia', 'amd', 'cpu']);
    expect(k?.default).toBe('auto');
  });

  it('knobsInGroup returns a populated group and empty for unknown', () => {
    expect(knobsInGroup('qa-gates').length).toBeGreaterThan(0);
    expect(knobsInGroup('does-not-exist')).toEqual([]);
  });

  it('prompt knobs carry isPrompt and empty env; non-prompt knobs have a non-empty env', () => {
    for (const k of allKnobs()) {
      if (k.isPrompt) { expect(k.env).toBe(''); }
      else { expect(k.env.length).toBeGreaterThan(0); }
    }
  });

  it('registers ANALYZER_KEEP_ALIVE with a 5m default', () => {
    const k = getKnob('analyzer.ollama.keepAlive');
    expect(k).toBeDefined();
    expect(k?.env).toBe('ANALYZER_KEEP_ALIVE');
    expect(k?.default).toBe('5m');
    expect(k?.apply).toBe('live');
  });
});
