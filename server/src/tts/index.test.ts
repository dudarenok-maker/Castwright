/* Engine-key plumbing for the TTS provider factory. Pins the pure routing
   helpers (no side-deps) so adding/renaming an engine key can't silently
   misroute a model to the wrong provider. Qwen3-TTS (plan 108) is the latest
   engine added here. */

import { describe, it, expect } from 'vitest';
import {
  engineForModelKey,
  sidecarModelId,
  isTtsModelKey,
  TTS_MODEL_LABELS,
  type TtsModelKey,
} from './index.js';

describe('engineForModelKey routes each model key to its engine', () => {
  it.each([
    ['coqui-xtts-v2', 'coqui'],
    ['kokoro-v1', 'kokoro'],
    ['qwen3-tts-0.6b', 'qwen'],
    ['gemini-2.5-flash', 'gemini'],
    ['gemini-3.1-flash', 'gemini'],
    ['piper-en-us-medium', 'piper'],
  ] as const)('%s -> %s', (key, engine) => {
    expect(engineForModelKey(key)).toBe(engine);
  });
});

describe('sidecarModelId', () => {
  it('maps local keys to their sidecar model id, incl. qwen', () => {
    expect(sidecarModelId('coqui-xtts-v2')).toBe('xtts_v2');
    expect(sidecarModelId('kokoro-v1')).toBe('v1');
    expect(sidecarModelId('qwen3-tts-0.6b')).toBe('0.6b');
  });

  it('throws for cloud (non-local) keys', () => {
    expect(() => sidecarModelId('gemini-2.5-flash')).toThrow();
  });
});

describe('isTtsModelKey', () => {
  it('accepts every known key incl. qwen3-tts-0.6b', () => {
    const keys: TtsModelKey[] = [
      'coqui-xtts-v2',
      'piper-en-us-medium',
      'kokoro-v1',
      'qwen3-tts-0.6b',
      'gemini-2.5-flash',
      'gemini-3.1-flash',
    ];
    for (const k of keys) expect(isTtsModelKey(k)).toBe(true);
  });

  it('rejects unknown values', () => {
    expect(isTtsModelKey('qwen')).toBe(false);
    expect(isTtsModelKey('qwen3-tts')).toBe(false);
    expect(isTtsModelKey(undefined)).toBe(false);
  });
});

describe('TTS_MODEL_LABELS', () => {
  it('has a human label for the qwen key', () => {
    expect(TTS_MODEL_LABELS['qwen3-tts-0.6b']).toBe('Qwen3-TTS 0.6B (local)');
  });
});
