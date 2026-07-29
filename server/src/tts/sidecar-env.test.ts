/* Pins the buildSidecarEnv contract: resolved restart-sidecar knobs are
   injected into the child env, and knobs left at their default are NOT
   force-set (so the sidecar uses its own default, avoiding double-defaulting).
   PRELOAD_QWEN / PRELOAD_QWEN_BASE17 / PRELOAD_KOKORO are flat, independent
   registry knobs (preload-toggle dedup) — no coupling to modelKey. PRELOAD_COQUI
   is the one exception, still derived from modelKey (no Advanced Settings
   toggle stands in for it). */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
vi.mock('../workspace/user-settings.js', () => ({ readConfigOverrides: vi.fn(() => ({})) }));
/* #1890 — QWEN_VOICES_DIR/XTTS_VOICES_DIR must be sourced from paths.ts's
   `qwenVoicesDir()`/`xttsVoicesDir()` helpers, not a local literal `join()`
   that happens to compute the same value today. Partial-mock so the
   describe block below can swap in sentinel return values and prove
   buildSidecarEnv's output actually tracks them — a plain equality check
   against the real helpers would pass even on the pre-fix literal-join code
   (the two are byte-identical today), so it wouldn't fail before the fix. */
vi.mock('../workspace/paths.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../workspace/paths.js')>();
  return { ...actual, qwenVoicesDir: vi.fn(actual.qwenVoicesDir), xttsVoicesDir: vi.fn(actual.xttsVoicesDir) };
});
import { buildSidecarEnv } from './spawn-sidecar.js';
import * as us from '../workspace/user-settings.js';
import * as paths from '../workspace/paths.js';
import { setLastKnownGpuDevices } from '../gpu/gpu-device-list-state.js';

describe('buildSidecarEnv injects resolved restart-sidecar knobs', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
    delete process.env.QWEN_ATTN_IMPL;
    delete process.env.QWEN_DEGEN_GUARD;
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

  it('tts.qwen.degenGuard left at its default-on value is NOT injected (sidecar Python default True applies)', () => {
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.QWEN_DEGEN_GUARD).toBeUndefined();
  });

  it('turning tts.qwen.degenGuard off injects QWEN_DEGEN_GUARD=0', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.qwen.degenGuard': false,
    });
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.QWEN_DEGEN_GUARD).toBe('0');
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

describe('buildSidecarEnv hands the sidecar a UUID device pin verbatim (#1857)', () => {
  beforeEach(() => {
    setLastKnownGpuDevices([]);
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
    delete process.env.QWEN_DEVICE;
  });

  afterEach(() => {
    setLastKnownGpuDevices([]);
  });

  /* Both cache states must agree. Before #1857 the emitted value depended on
     whether the user had opened Advanced Settings during this server session:
     a warm cache froze a cuda:N that buildOpts re-emitted on every respawn, so
     a card that later vanished failed _validate_cuda_index on every retry and
     one that renumbered landed on the wrong card. The sidecar resolves the uuid
     form itself, live, per spawn — that is the safe branch, so make it the only
     branch. */
  for (const [label, cache] of [
    ['cold cache', [] as { uuid: string; idx: number }[]],
    ['warm cache', [{ uuid: 'GPU-1', idx: 1 }]],
  ] as const) {
    it(`emits the raw cuda-uuid literal with a ${label}`, () => {
      (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
        'tts.qwen.device': 'cuda-uuid:GPU-1',
      });
      setLastKnownGpuDevices([...cache]);

      const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });

      expect(env.QWEN_DEVICE).toBe('cuda-uuid:GPU-1');
    });
  }

  it('still emits a plain cuda:N pin unchanged', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.qwen.device': 'cuda:1',
    });
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.QWEN_DEVICE).toBe('cuda:1');
  });

  it('leaves a device knob at its registry default unset', () => {
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.QWEN_DEVICE).toBeUndefined();
  });
});

/* #1890 — spawn-sidecar.ts's voice-dir env vars must be sourced from
   paths.ts's qwenVoicesDir()/xttsVoicesDir(), the same single source of
   truth purgeCloneArtifacts and the resolver read. A literal `join()` that
   happens to compute an identical path today would silently diverge the
   moment either side changes independently — a Property-2 ("erasure is
   total") hole. */
describe('buildSidecarEnv sources QWEN_VOICES_DIR/XTTS_VOICES_DIR from paths.ts (#1890)', () => {
  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  it('reflects an overridden qwenVoicesDir()/xttsVoicesDir() return value', () => {
    (paths.qwenVoicesDir as ReturnType<typeof vi.fn>).mockReturnValue('/sentinel/qwen-voices');
    (paths.xttsVoicesDir as ReturnType<typeof vi.fn>).mockReturnValue('/sentinel/xtts-voices');

    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });

    expect(env.QWEN_VOICES_DIR).toBe('/sentinel/qwen-voices');
    expect(env.XTTS_VOICES_DIR).toBe('/sentinel/xtts-voices');
  });
});
