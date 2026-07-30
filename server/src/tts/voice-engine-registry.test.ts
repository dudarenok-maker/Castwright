import { describe, it, expect } from 'vitest';
import { VOICE_ENGINES } from './voice-engine-registry.js';

describe('VOICE_ENGINES registry', () => {
  it('lists exactly the three installable voice engines, excluding whisper/gemini/piper', () => {
    expect(VOICE_ENGINES.map((e) => e.id).sort()).toEqual(['coqui', 'kokoro', 'qwen']);
  });

  it('each entry exposes disk probes, live selectors, and a default model key', () => {
    for (const e of VOICE_ENGINES) {
      expect(typeof e.packageInstalledOnDisk).toBe('function');
      expect(typeof e.weightsPresentOnDisk).toBe('function');
      expect(typeof e.livePackageImportable).toBe('function');
      expect(typeof e.liveLoaded).toBe('function');
      expect(e.defaultModelKey).toMatch(/^(kokoro-v1|qwen3-tts-0\.6b|coqui-xtts-v2)$/);
    }
  });

  it('live selectors read the matching SidecarHealthResult fields', () => {
    const kokoro = VOICE_ENGINES.find((e) => e.id === 'kokoro')!;
    expect(kokoro.liveLoaded({ kokoroLoaded: true } as never)).toBe(true);
    expect(kokoro.livePackageImportable({ kokoroPackageInstalled: false } as never)).toBe(false);
    // undefined health field (older sidecar) → not importable-confirmed, not loaded
    expect(kokoro.liveLoaded({} as never)).toBe(false);
    expect(kokoro.livePackageImportable({} as never)).toBeUndefined();
  });

  describe('coqui livePackageImportable prefers coquiImportOk over coquiPackageInstalled (#1963)', () => {
    const coqui = VOICE_ENGINES.find((e) => e.id === 'coqui')!;

    it('coquiImportOk: false wins even when coquiPackageInstalled (find_spec) says true', () => {
      // Same on-box shape as #1944: find_spec claims "installed" for a
      // package that cannot actually import (the speechbrain lazy-proxy
      // collision) — the honesty fix must report false here, not true.
      expect(
        coqui.livePackageImportable({ coquiImportOk: false, coquiPackageInstalled: true } as never),
      ).toBe(false);
    });

    it('coquiImportOk: true wins', () => {
      expect(
        coqui.livePackageImportable({ coquiImportOk: true, coquiPackageInstalled: false } as never),
      ).toBe(true);
    });

    it('coquiImportOk: null falls back to coquiPackageInstalled — today\'s behaviour, unchanged', () => {
      expect(
        coqui.livePackageImportable({ coquiImportOk: null, coquiPackageInstalled: true } as never),
      ).toBe(true);
    });

    it('coquiImportOk absent (older sidecar) falls back to coquiPackageInstalled — same as null', () => {
      expect(coqui.livePackageImportable({ coquiPackageInstalled: true } as never)).toBe(true);
      expect(coqui.livePackageImportable({} as never)).toBeUndefined();
    });
  });
});

describe('VOICE_ENGINES capability fields', () => {
  const byId = Object.fromEntries(VOICE_ENGINES.map((e) => [e.id, e]));

  it('carries authored expressive + VRAM floor + capable rank per engine', () => {
    expect(byId.kokoro.expressive).toBe(false);
    expect(byId.kokoro.genVramFloorMb).toBe(1024);
    expect(byId.kokoro.capablePreferenceRank).toBe(99);

    expect(byId.qwen.expressive).toBe(true);
    expect(byId.qwen.genVramFloorMb).toBe(6144);
    expect(byId.qwen.capablePreferenceRank).toBe(0);

    expect(byId.coqui.expressive).toBe(true);
    expect(byId.coqui.genVramFloorMb).toBe(4096);
    expect(byId.coqui.capablePreferenceRank).toBe(1);
  });

  it('every entry has a positive generation floor', () => {
    for (const e of VOICE_ENGINES) expect(e.genVramFloorMb).toBeGreaterThan(0);
  });
});
