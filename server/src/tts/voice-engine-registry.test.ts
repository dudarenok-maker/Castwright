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
      expect(typeof e.liveImportOk).toBe('function');
      expect(typeof e.liveSpecPresent).toBe('function');
      expect(typeof e.liveLoaded).toBe('function');
      expect(e.defaultModelKey).toMatch(/^(kokoro-v1|qwen3-tts-0\.6b|coqui-xtts-v2)$/);
    }
  });

  it('live selectors read the matching SidecarHealthResult fields', () => {
    const kokoro = VOICE_ENGINES.find((e) => e.id === 'kokoro')!;
    expect(kokoro.liveLoaded({ kokoroLoaded: true } as never)).toBe(true);
    expect(kokoro.liveSpecPresent({ kokoroPackageInstalled: false } as never)).toBe(false);
    // undefined health field (older sidecar) → not importable-confirmed, not loaded
    expect(kokoro.liveLoaded({} as never)).toBe(false);
    expect(kokoro.liveSpecPresent({} as never)).toBeUndefined();
  });

  /* #1965 — the two live signals are now reported SEPARATELY rather than
     pre-collapsed by the registry: the "prefer importOk, fall back to
     find_spec" rule moved into models-status's packageBroken predicate so it is
     spelled exactly once. These pin that each accessor reads its OWN field and
     collapses nothing. */
  describe('liveImportOk / liveSpecPresent read distinct fields per engine', () => {
    const byId = Object.fromEntries(VOICE_ENGINES.map((e) => [e.id, e]));
    const CASES = [
      { id: 'kokoro', importField: 'kokoroImportOk', specField: 'kokoroPackageInstalled' },
      { id: 'qwen', importField: 'qwenImportOk', specField: 'qwenPackageInstalled' },
      { id: 'coqui', importField: 'coquiImportOk', specField: 'coquiPackageInstalled' },
    ] as const;

    for (const c of CASES) {
      it(`${c.id}: liveImportOk reads ${c.importField}, liveSpecPresent reads ${c.specField}`, () => {
        const e = byId[c.id];
        // The #1944 shape: find_spec says installed, a real import raised.
        const h = { [c.importField]: false, [c.specField]: true } as never;
        expect(e.liveImportOk(h)).toBe(false);
        expect(e.liveSpecPresent(h)).toBe(true);
        // ...and the inverse, so neither accessor is silently reading the other.
        const inv = { [c.importField]: true, [c.specField]: false } as never;
        expect(e.liveImportOk(inv)).toBe(true);
        expect(e.liveSpecPresent(inv)).toBe(false);
      });

      it(`${c.id}: liveImportOk maps BOTH null and absent to undefined (one "unknown")`, () => {
        const e = byId[c.id];
        expect(e.liveImportOk({ [c.importField]: null } as never)).toBeUndefined();
        expect(e.liveImportOk({} as never)).toBeUndefined();
      });
    }

    it('no accessor collapses the two — a false spec probe never leaks into liveImportOk', () => {
      for (const e of VOICE_ENGINES) {
        // Only the find_spec field is known; the real-import signal stays unknown.
        const h = {
          kokoroPackageInstalled: false,
          qwenPackageInstalled: false,
          coquiPackageInstalled: false,
        } as never;
        expect(e.liveImportOk(h)).toBeUndefined();
        expect(e.liveSpecPresent(h)).toBe(false);
      }
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
