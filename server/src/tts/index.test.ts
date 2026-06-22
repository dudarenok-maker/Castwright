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
import * as indexModule from './index.js';
import * as modelKeysModule from './model-keys.js';

describe('engineForModelKey routes each model key to its engine', () => {
  it.each([
    ['coqui-xtts-v2', 'coqui'],
    ['kokoro-v1', 'kokoro'],
    ['qwen3-tts-0.6b', 'qwen'],
    ['qwen3-tts-1.7b', 'qwen'],
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
    expect(sidecarModelId('qwen3-tts-1.7b')).toBe('1.7b');
  });

  it('throws for cloud (non-local) keys', () => {
    expect(() => sidecarModelId('gemini-2.5-flash')).toThrow();
  });
});

describe('isTtsModelKey', () => {
  it('accepts every known key incl. qwen3-tts-0.6b and qwen3-tts-1.7b', () => {
    const keys: TtsModelKey[] = [
      'coqui-xtts-v2',
      'piper-en-us-medium',
      'kokoro-v1',
      'qwen3-tts-0.6b',
      'qwen3-tts-1.7b',
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

  it('has a human label for the qwen3-tts-1.7b key', () => {
    expect(TTS_MODEL_LABELS['qwen3-tts-1.7b']).toBe('Qwen3-TTS 1.7B (local, higher quality)');
  });
});

describe('canonicalModelKeyForEngine', () => {
  it('preserves the qwen variant when the request is already a qwen key', () => {
    const { canonicalModelKeyForEngine } = indexModule;
    expect(canonicalModelKeyForEngine('qwen', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
    expect(canonicalModelKeyForEngine('qwen', 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });

  it('falls back to qwen3-tts-0.6b when the request key is not a qwen key', () => {
    const { canonicalModelKeyForEngine } = indexModule;
    expect(canonicalModelKeyForEngine('qwen', 'kokoro-v1')).toBe('qwen3-tts-0.6b');
  });
});

/* Cycle-break guard. The pure helpers live in the leaf ./model-keys.js so the
   provider modules (gemini/sidecar) can import them WITHOUT forming an
   index ↔ provider runtime cycle — that cycle made `importOriginal('../tts/index.js')`
   return a partially-initialised namespace under parallel load (the intermittent
   `No "isTtsModelKey" export is defined on the mock` flake that failed the
   cross-OS release gate). `index.js` must re-export them by reference, not
   re-declare them — assert identity so a future edit can't silently move a
   helper back into index and reintroduce the cycle. */
describe('model-keys re-export identity (cycle-break guard)', () => {
  it('index re-exports the same helper references as the leaf module', () => {
    expect(indexModule.isTtsModelKey).toBe(modelKeysModule.isTtsModelKey);
    expect(indexModule.engineForModelKey).toBe(modelKeysModule.engineForModelKey);
    expect(indexModule.sidecarModelId).toBe(modelKeysModule.sidecarModelId);
    expect(indexModule.resolveGeminiModelId).toBe(modelKeysModule.resolveGeminiModelId);
    expect(indexModule.TTS_MODEL_LABELS).toBe(modelKeysModule.TTS_MODEL_LABELS);
  });
});
