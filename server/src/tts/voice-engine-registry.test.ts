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
});
