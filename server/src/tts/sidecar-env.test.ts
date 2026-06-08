/* Pins the buildSidecarEnv contract: resolved restart-sidecar knobs are
   injected into the child env, and knobs left at their default are NOT
   force-set (so the sidecar uses its own default, avoiding double-defaulting). */

import { describe, it, expect, beforeEach, vi } from 'vitest';
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
