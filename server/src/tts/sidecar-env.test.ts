/* Pins the buildSidecarEnv contract: resolved restart-sidecar knobs are
   injected into the child env, and knobs left at their default are NOT
   force-set (so the sidecar uses its own default, avoiding double-defaulting). */

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
      eagerLoadKokoro: false,
      eagerLoadQwen: false,
      repoRoot: process.cwd(),
    });
    expect(env.QWEN_ATTN_IMPL).toBe('flash_attention_2');
  });

  it('does NOT inject a knob left at its default', () => {
    // no override, no env var — QWEN_ATTN_IMPL must not be force-set
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-0.6b',
      eagerLoadKokoro: false,
      eagerLoadQwen: false,
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
        eagerLoadKokoro: false,
        eagerLoadQwen: false,
        repoRoot: process.cwd(),
      });
      // source='env' is NOT default, so it is injected
      expect(env.QWEN_ATTN_IMPL).toBe('sdpa');
    } finally {
      if (prev === undefined) delete process.env.QWEN_ATTN_IMPL;
      else process.env.QWEN_ATTN_IMPL = prev;
    }
  });

  it('PRELOAD_QWEN from existing logic wins when no registry override exists', () => {
    // Qwen default + eagerLoadQwen=true → PRELOAD_QWEN=1 from existing logic
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-0.6b',
      eagerLoadKokoro: false,
      eagerLoadQwen: true,
      repoRoot: process.cwd(),
    });
    expect(env.PRELOAD_QWEN).toBe('1');
  });

  it('PRELOAD_QWEN_BASE17 from existing logic wins when no registry override exists (qwen 1.7B)', () => {
    /* Qwen-1.7B default + eagerLoadQwen=true → PRELOAD_QWEN_BASE17=1.
       PRELOAD_QWEN must stay '0' (mutual exclusivity — we only warm the
       chosen tier) and PRELOAD_KOKORO must be '0' (Kokoro is the on-demand
       fallback for Qwen defaults). */
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-1.7b',
      eagerLoadKokoro: false,
      eagerLoadQwen: true,
      repoRoot: process.cwd(),
    });
    expect(env.PRELOAD_QWEN_BASE17).toBe('1');
    expect(env.PRELOAD_QWEN).toBe('0');
    expect(env.PRELOAD_KOKORO).toBe('0');
  });

  it('PRELOAD_QWEN_BASE17 stays 0 when eagerLoadQwen is false (qwen 1.7B lazy)', () => {
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-1.7b',
      eagerLoadKokoro: false,
      eagerLoadQwen: false,
      repoRoot: process.cwd(),
    });
    expect(env.PRELOAD_QWEN_BASE17).toBe('0');
    expect(env.PRELOAD_QWEN).toBe('0');
    expect(env.PRELOAD_KOKORO).toBe('0');
  });

  it('registry override for PRELOAD_QWEN_BASE17 wins over derived 1.7B tier logic', () => {
    /* A power user pinning tts.preload.qwenBase17=0 must override the
       derived '1' from the 1.7B tier dispatcher (mirrors the existing
       PRELOAD_QWEN precedence test above). */
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.preload.qwenBase17': false,
    });
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-1.7b',
      eagerLoadKokoro: false,
      eagerLoadQwen: true,
      repoRoot: process.cwd(),
    });
    expect(env.PRELOAD_QWEN_BASE17).toBe('0');
  });

  it('registry override for PRELOAD_QWEN wins over derived modelKey/eagerLoad logic', () => {
    // registry override forces PRELOAD_QWEN=0 even for a Qwen default + eagerLoadQwen=true
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.preload.qwen': false,
    });
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-0.6b',
      eagerLoadKokoro: false,
      eagerLoadQwen: true,
      repoRoot: process.cwd(),
    });
    // The registry override must win over the derived '1', emitted as '0'.
    expect(env.PRELOAD_QWEN).toBe('0');
  });

  it('boolean overrides are emitted as 1/0 (not true/false) so == "1" sidecar reads work', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.preload.coqui': true,
    });
    const env = buildSidecarEnv({
      modelKey: 'qwen3-tts-0.6b',
      eagerLoadKokoro: false,
      eagerLoadQwen: false,
      repoRoot: process.cwd(),
    });
    expect(env.PRELOAD_COQUI).toBe('1');
  });
});

describe('buildSidecarEnv injects the accelerator profile + Kokoro ORT providers (AMD phase 2)', () => {
  const base = {
    modelKey: 'qwen3-tts-0.6b' as const,
    eagerLoadKokoro: false,
    eagerLoadQwen: false,
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
