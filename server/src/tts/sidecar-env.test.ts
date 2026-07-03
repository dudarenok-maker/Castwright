/* Pins the buildSidecarEnv contract: resolved restart-sidecar knobs are
   injected into the child env, and knobs left at their default are NOT
   force-set (so the sidecar uses its own default, avoiding double-defaulting).
   PRELOAD_QWEN / PRELOAD_QWEN_BASE17 / PRELOAD_KOKORO are flat, independent
   registry knobs (preload-toggle dedup) — no coupling to modelKey. PRELOAD_COQUI
   is the one exception, still derived from modelKey (no Advanced Settings
   toggle stands in for it). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('../workspace/user-settings.js', () => ({ readConfigOverrides: vi.fn(() => ({})) }));
import { buildSidecarEnv } from './spawn-sidecar.js';
import * as us from '../workspace/user-settings.js';

describe('buildSidecarEnv injects resolved restart-sidecar knobs', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
    delete process.env.QWEN_ATTN_IMPL;
  });

  it('injects an overridden sidecar knob into the child env', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.qwen.attnImpl': 'flash_attention_2',
    });
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-0.6b',
      repoRoot: process.cwd(),
    });
    expect(env.QWEN_ATTN_IMPL).toBe('flash_attention_2');
  });

  it('does NOT inject a knob left at its default', () => {
    // no override, no env var — QWEN_ATTN_IMPL must not be force-set
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-0.6b',
      repoRoot: process.cwd(),
    });
    expect(env.QWEN_ATTN_IMPL).toBeUndefined();
  });

  it('env-var source also injects (re-exports the parent env var)', () => {
    const prev = process.env.QWEN_ATTN_IMPL;
    process.env.QWEN_ATTN_IMPL = 'sdpa';
    try {
      const env = buildSidecarEnv({
        modelKey: 'qwen3-tts-0.6b',
        repoRoot: process.cwd(),
      });
      // source='env' is NOT default, so it is injected
      expect(env.QWEN_ATTN_IMPL).toBe('sdpa');
    } finally {
      if (prev === undefined) delete process.env.QWEN_ATTN_IMPL;
      else process.env.QWEN_ATTN_IMPL = prev;
    }
  });

  it('PRELOAD_QWEN / PRELOAD_QWEN_BASE17 / PRELOAD_KOKORO are left unset at their registry default, regardless of modelKey', () => {
    for (const modelKey of ['qwen3-tts-0.6b', 'qwen3-tts-1.7b', 'kokoro-v1'] as const) {
      const env = buildSidecarEnv({ modelKey, repoRoot: process.cwd() });
      expect(env.PRELOAD_QWEN, `modelKey=${modelKey}`).toBeUndefined();
      expect(env.PRELOAD_QWEN_BASE17, `modelKey=${modelKey}`).toBeUndefined();
      expect(env.PRELOAD_KOKORO, `modelKey=${modelKey}`).toBeUndefined();
    }
  });

  it('a registry override for tts.preload.qwen sets PRELOAD_QWEN regardless of modelKey', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.preload.qwen': true,
    });
    // Even under a Kokoro default, the flat override still applies — no more
    // "only the resolved default engine preloads" coupling.
    const env = buildSidecarEnv({ modelKey: 'kokoro-v1', repoRoot: process.cwd() });
    expect(env.PRELOAD_QWEN).toBe('1');
  });

  it('a registry override for tts.preload.qwenBase17 sets PRELOAD_QWEN_BASE17', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.preload.qwenBase17': true,
    });
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-1.7b', repoRoot: process.cwd() });
    expect(env.PRELOAD_QWEN_BASE17).toBe('1');
  });

  it('a registry override for tts.preload.kokoro sets PRELOAD_KOKORO even under a Qwen default', () => {
    /* The old "non-default engine forced lazy" rule is gone — a user can
       pin both Qwen and Kokoro to preload at once (accepting the combined
       VRAM cost) via two independent Advanced Settings overrides. */
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.preload.kokoro': true,
    });
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.PRELOAD_KOKORO).toBe('1');
  });

  it('boolean overrides are emitted as 1/0 (not true/false) so == "1" sidecar reads work', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.preload.coqui': true,
    });
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-0.6b',
      repoRoot: process.cwd(),
    });
    expect(env.PRELOAD_COQUI).toBe('1');
  });
});

describe('buildSidecarEnv injects the accelerator profile + Kokoro ORT providers (AMD phase 2)', () => {
  const base = {
    modelKey: 'qwen3-tts-0.6b' as const,
    repoRoot: process.cwd(), // no venv stamp under this path → profile from env/default
  };
  afterEach(() => {
    delete process.env.ACCELERATOR;
  });

  it('no stamp / no override → cpu profile + CPU-only Kokoro ORT providers', () => {
    delete process.env.ACCELERATOR;
    const env = buildSidecarEnv(base);
    expect(env.CASTWRIGHT_ACCELERATOR_PROFILE).toBe('cpu');
    expect(JSON.parse(env.KOKORO_ORT_PROVIDERS as string)).toEqual(['CPUExecutionProvider']);
  });

  it('ACCELERATOR=nvidia → nvidia profile + CUDA/CPU ORT providers', () => {
    process.env.ACCELERATOR = 'nvidia';
    const env = buildSidecarEnv(base);
    expect(env.CASTWRIGHT_ACCELERATOR_PROFILE).toBe('nvidia');
    expect(JSON.parse(env.KOKORO_ORT_PROVIDERS as string)).toEqual([
      'CUDAExecutionProvider',
      'CPUExecutionProvider',
    ]);
  });

  it('ACCELERATOR=amd → amd profile; Kokoro ORT providers are CPU-only (DirectML disabled, S0.1)', () => {
    process.env.ACCELERATOR = 'amd';
    const env = buildSidecarEnv(base);
    expect(env.CASTWRIGHT_ACCELERATOR_PROFILE).toBe('amd');
    // S0.1 found DirectML can't run the Kokoro model → CPU EP on every OS.
    expect(JSON.parse(env.KOKORO_ORT_PROVIDERS as string)).toEqual(['CPUExecutionProvider']);
  });
});
