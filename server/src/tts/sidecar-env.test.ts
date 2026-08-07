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

  it('tts.coqui.degenGuard (#2026) left at its default-on value is NOT injected (sidecar Python default True applies)', () => {
    const env = buildSidecarEnv({ modelKey: 'coqui-xtts-v2', repoRoot: process.cwd() });
    expect(env.COQUI_DEGEN_GUARD).toBeUndefined();
  });

  it('turning tts.coqui.degenGuard off injects COQUI_DEGEN_GUARD=0', () => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'tts.coqui.degenGuard': false,
    });
    const env = buildSidecarEnv({ modelKey: 'coqui-xtts-v2', repoRoot: process.cwd() });
    expect(env.COQUI_DEGEN_GUARD).toBe('0');
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

/* #2207 — an ambient env var that FAILS the resolver's validation (e.g.
   ASR_DEVICE=cuda1 against qa.asr.device's pattern) must not survive the
   `...process.env` spread verbatim: the server resolved something else
   (override or registry default) for that knob, and the sidecar must agree,
   not silently diverge onto whatever the rejected value happened to mean to
   main.py's own (more permissive) parser. */
describe('buildSidecarEnv deletes a rejected ambient env value (#2207)', () => {
  const prevAsrDevice = process.env.ASR_DEVICE;

  beforeEach(() => {
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({});
  });

  afterEach(() => {
    if (prevAsrDevice === undefined) delete process.env.ASR_DEVICE;
    else process.env.ASR_DEVICE = prevAsrDevice;
  });

  it('a rejected ASR_DEVICE (fails qa.asr.device\'s pattern) is deleted from the child env', () => {
    process.env.ASR_DEVICE = 'cuda1'; // no colon — fails /^(cpu|auto|cuda|cuda:\d+)$/i
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect('ASR_DEVICE' in env).toBe(false);
  });

  // Positive control (mandatory): a guard that can't distinguish its bug
  // from its fix refuses its own success case. NOTE: for THIS knob, an
  // unconditional delete (dropping isEnvValueRejected entirely) also passes
  // this test — Layer 2 re-derives and re-sets ASR_DEVICE regardless, because
  // its resolved source is 'env', not 'default'. This test still pins the
  // required contract (a valid value must survive), it just isn't the test
  // that catches an over-broad delete on this particular knob — see
  // 'the guard condition is load-bearing' below for the one that is.
  it('a VALID ASR_DEVICE reaches the child unchanged (positive control)', () => {
    process.env.ASR_DEVICE = 'cuda:1';
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.ASR_DEVICE).toBe('cuda:1');
  });

  it('a rejected ASR_DEVICE plus a UI override for the same knob: the child receives the override, proving the delete runs before the injection loop', () => {
    process.env.ASR_DEVICE = 'cuda1'; // still rejected
    (us.readConfigOverrides as ReturnType<typeof vi.fn>).mockReturnValue({
      'qa.asr.device': 'cuda:2',
    });
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.ASR_DEVICE).toBe('cuda:2');
  });

  it('a knob at its registry default with no env value is still injected nowhere', () => {
    delete process.env.ASR_DEVICE;
    const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
    expect(env.ASR_DEVICE).toBeUndefined();
  });

  /* This test exists SPECIFICALLY to prove the `isEnvValueRejected(knob)`
     guard on the Layer-1.5 delete loop is load-bearing, not vestigial.
     Every other test in this describe block — including the positive
     control above — still passes if that guard is dropped and the loop
     unconditionally deletes every restart-sidecar knob's env key: Layer 2
     re-derives and re-sets any knob whose resolved source isn't 'default'
     (env or override), so an over-broad delete on ASR_DEVICE is invisible
     through THIS file alone. tts.preload.coqui is the one restart-sidecar
     knob that breaks that symmetry — its env var (PRELOAD_COQUI) is also
     set synthetically from `modelKey` in buildSidecarEnv's BASE env block
     (before Layer 1.5 runs), and when the knob sits at its registry
     default (no override, no ambient PRELOAD_COQUI) Layer 2 skips it
     entirely (`source === 'default'` → `continue`) — nothing restores what
     Layer 1.5 deletes. An unconditional delete here wipes the modelKey-
     derived value with nothing to put it back. This exact case IS covered
     today, but only in a different file (spawn-sidecar.test.ts's
     'spawns with PRELOAD_COQUI=1 when default model is coqui-xtts-v2') —
     nothing in either file records that dependency, so tidying one file in
     isolation could silently break the chain. This test pins it locally. */
  it('the guard condition is load-bearing: PRELOAD_COQUI (modelKey-derived, no override) survives Layer 1.5 only because the delete is conditional', () => {
    delete process.env.PRELOAD_COQUI;
    const env = buildSidecarEnv({ modelKey: 'coqui-xtts-v2', repoRoot: process.cwd() });
    expect(env.PRELOAD_COQUI).toBe('1');
  });

  /* Independent review of PR #2219, finding F1 (BLOCKER). PRELOAD_COQUI is
     the ONE restart-sidecar env name the base env block also writes
     (line ~468, derived from `modelKey`) — so by the time Layer 1.5 runs,
     `env.PRELOAD_COQUI` is no longer the ambient value the resolver
     rejected, it's already the correct modelKey-derived one. The prior
     Layer-1.5 loop deleted on `isEnvValueRejected(knob)` alone, so a
     REJECTED ambient PRELOAD_COQUI (e.g. `PRELOAD_COQUI=y` in
     server/.env, outside 1/true/yes/on/0/false/no/off) deleted that
     freshly-computed correct value on the strength of a stale, already-
     neutralised one — the exact inverse of this change's intent. The
     other #2207 tests above never catch this: they all target ASR_DEVICE,
     which has no base-block synthetic value to clobber. This test sets an
     ambient PRELOAD_COQUI to a rejected value (not deleted — the F1 repro
     needs it PRESENT and invalid) with modelKey: 'coqui-xtts-v2', and
     asserts the child still gets '1'. */
  it('F1 — a rejected ambient PRELOAD_COQUI does not clobber the base-block modelKey-derived value', () => {
    const prev = process.env.PRELOAD_COQUI;
    process.env.PRELOAD_COQUI = 'y'; // rejected: not in 1/true/yes/on/0/false/no/off
    try {
      const env = buildSidecarEnv({ modelKey: 'coqui-xtts-v2', repoRoot: process.cwd() });
      expect(env.PRELOAD_COQUI).toBe('1');
    } finally {
      if (prev === undefined) delete process.env.PRELOAD_COQUI;
      else process.env.PRELOAD_COQUI = prev;
    }
  });

  /* Independent review of PR #2219, finding F2 — every #2207 assertion above
     targets ASR_DEVICE alone, so the Layer-1.5 `for` loop was never proven
     to actually iterate past its first match; `if (isEnvValueRejected(knob))
     { delete env[knob.env]; break; }` would also pass every test above.
     Two independently rejected knobs, asserted deleted together. */
  it('F2 — the delete loop is a loop: two independently rejected restart-sidecar knobs are BOTH deleted', () => {
    const prevAttn = process.env.QWEN_ATTN_IMPL;
    process.env.ASR_DEVICE = 'cuda1'; // rejected — fails qa.asr.device's pattern
    process.env.QWEN_ATTN_IMPL = 'flash'; // rejected — not 'sdpa' | 'flash_attention_2'
    try {
      const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
      expect('ASR_DEVICE' in env).toBe(false);
      expect('QWEN_ATTN_IMPL' in env).toBe(false);
    } finally {
      if (prevAttn === undefined) delete process.env.QWEN_ATTN_IMPL;
      else process.env.QWEN_ATTN_IMPL = prevAttn;
    }
  });

  /* Independent review of PR #2219, finding F3 — resolveKnobInner already
     treats a blank/whitespace-only ambient value identically to "no env var
     at all" (falls through to override/default, no validation, no warning).
     Verified in THIS repo (not merely reported by the review): GPU_RESERVE_MB
     reaches an unguarded `int(os.environ.get("GPU_RESERVE_MB", 500))` at
     three capacity-admission call sites in main.py (:3946, :4097, :4294) —
     `int("")` raises ValueError, so a half-restored `GPU_RESERVE_MB=` line in
     server/.env would crash admission, not merely apply a stale value. A
     blank ambient value is therefore deleted the same as a validation-
     rejected one (isEnvValueRejected now returns true for it — see
     resolver.ts and resolver.test.ts's dedicated F6 coverage). */
  it('F3 — a blank ambient value for a restart-sidecar knob is deleted from the child env (a half-restored GPU_RESERVE_MB=)', () => {
    const prev = process.env.GPU_RESERVE_MB;
    process.env.GPU_RESERVE_MB = '';
    try {
      const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
      expect('GPU_RESERVE_MB' in env).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.GPU_RESERVE_MB;
      else process.env.GPU_RESERVE_MB = prev;
    }
  });

  /* #2224 — qa.speaker.device (SPK_DEVICE) is the ASR twin's counterpart:
     same restart-sidecar shape, same "does the child env agree with what the
     server resolved" thesis. UNLIKE qa.asr.device it has no `pattern` today
     (see the #2224 report — a pattern was deliberately NOT added this round;
     _parse_device/_engine_env_pin treat 'mps' and 'rocm' as first-class
     device families for "spk", which qa.asr.device's own pattern would
     reject, so reusing it verbatim would newly break a currently-valid pin).
     That means a non-blank garbage value (e.g. "cuda1") is NOT rejected for
     THIS knob yet — nothing to assert there. A blank ambient value IS
     rejected regardless of pattern (F3's blank-is-absent semantics), so
     that's what this test exercises: still real coverage of "rejected ->
     deleted" for this knob, just not the pattern-driven path ASR_DEVICE has. */
  it('F3/#2224 — a blank ambient SPK_DEVICE is deleted from the child env the same way GPU_RESERVE_MB is', () => {
    const prev = process.env.SPK_DEVICE;
    process.env.SPK_DEVICE = '   ';
    try {
      const env = buildSidecarEnv({ modelKey: 'qwen3-tts-0.6b', repoRoot: process.cwd() });
      expect('SPK_DEVICE' in env).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.SPK_DEVICE;
      else process.env.SPK_DEVICE = prev;
    }
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
