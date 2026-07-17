import { describe, it, expect } from 'vitest';
import { GROUPS, KNOBS, allKnobs, getKnob, knobByEnv, knobsInGroup } from './registry.js';

describe('config registry', () => {
  it('declares the twelve groups', () => {
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
      'lan-access',
      'analyzer-structure',
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

  it('registers the lan-access group', () => {
    const g = GROUPS.find((x) => x.id === 'lan-access');
    expect(g).toBeDefined();
    expect(g!.collapsedByDefault).toBe(false);
  });

  it('registers the device-token TTL knob with a 30-day default', () => {
    const k = KNOBS.find((x) => x.key === 'lan.deviceTokenTtlDays');
    expect(k).toMatchObject({
      env: 'LAN_DEVICE_TTL_DAYS',
      group: 'lan-access',
      type: 'integer',
      default: 30,
      min: 1,
      apply: 'live',
    });
  });

  it('qa.speaker settings registers three qa-gates keys with correct apply modes', () => {
    const byKey = Object.fromEntries(KNOBS.map((e) => [e.key, e]));
    expect(byKey['qa.speaker.enabled']).toMatchObject({ group: 'qa-gates', apply: 'live', default: false });
    expect(byKey['qa.speaker.device']).toMatchObject({ apply: 'restart-sidecar', default: 'cpu' });
    expect(byKey['qa.speaker.autoRepair']).toMatchObject({ apply: 'live', default: false });
  });

  it('registers the three Qwen codec-placement knobs with cpu/300/25 defaults', () => {
    const device = getKnob('tts.qwen.codecDevice');
    const chunkSize = getKnob('tts.qwen.codecChunkSize');
    const leftContext = getKnob('tts.qwen.codecLeftContextSize');
    expect(device?.env).toBe('QWEN_CODEC_DEVICE');
    expect(device?.default).toBe('cpu');
    expect(chunkSize?.env).toBe('QWEN_CODEC_CHUNK_SIZE');
    expect(chunkSize?.default).toBe(300);
    expect(leftContext?.env).toBe('QWEN_CODEC_LEFT_CONTEXT_SIZE');
    expect(leftContext?.default).toBe(25);
    [device, chunkSize, leftContext].forEach((k) => {
      expect(k?.group).toBe('tts-engine');
      expect(k?.apply).toBe('restart-sidecar');
      expect(k?.risk).toBe('high');
    });
  });

  it('tts.qwen.degenGuard registers a default-on boolean guard toggle mapped to QWEN_DEGEN_GUARD', () => {
    const k = getKnob('tts.qwen.degenGuard');
    expect(k).toBeDefined();
    expect(k?.env).toBe('QWEN_DEGEN_GUARD');
    expect(k?.type).toBe('boolean');
    expect(k?.default).toBe(true);
    expect(k?.group).toBe('tts-engine');
    expect(k?.apply).toBe('restart-sidecar');
  });

  it('tts.preload.kokoro defaults to false (fs-60 — non-English books are no longer forced onto a single engine, so an always-hot English-only engine is a less universally good default)', () => {
    const k = getKnob('tts.preload.kokoro');
    expect(k).toBeDefined();
    expect(k?.env).toBe('PRELOAD_KOKORO');
    expect(k?.default).toBe(false);
  });
});
