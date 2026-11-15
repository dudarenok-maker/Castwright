import { describe, it, expect } from 'vitest';
import { currentCastModelKey } from './current-voice.js';
import { buildCharacterSnapshots } from '../character-snapshots.js';
import type { CastCharacter } from '../../tts/synthesise-chapter.js';
import type { TtsEngine, TtsModelKey } from '../../tts/model-keys.js';

const ch = (o: Record<string, unknown> = {}) => ({ id: 'c1', name: 'C1', ...o }) as unknown as CastCharacter;
const snap = (c: CastCharacter, e: TtsEngine, k: TtsModelKey) =>
  buildCharacterSnapshots([c], new Set([c.id]), e, new Map(), k, new Map())[c.id].modelKey;

describe('currentCastModelKey (#3518)', () => {
  const u1 = ch();
  const u2 = ch({ ttsModelKey: 'qwen3-tts-1.7b' });
  const u4a = ch({ ttsEngine: 'qwen' });
  const u4b = ch({ ttsEngine: 'qwen', ttsModelKey: 'qwen3-tts-1.7b' });
  const u5 = ch({ ttsModelKey: 'qwen3-tts-1.7b' });

  it('U1 unpinned qwen follows the run key', () => {
    expect(currentCastModelKey(u1, 'qwen', 'qwen3-tts-0.6b')).toBe('qwen3-tts-0.6b');
  });
  it('U2 a pin elevates', () => {
    expect(currentCastModelKey(u2, 'qwen', 'qwen3-tts-0.6b')).toBe('qwen3-tts-1.7b');
  });
  it('U3 a pin never lowers', () => {
    expect(currentCastModelKey(ch({ ttsModelKey: 'qwen3-tts-0.6b' }), 'qwen', 'qwen3-tts-1.7b')).toBe('qwen3-tts-1.7b');
  });
  it('U4 foreign run key canonicalises to the qwen base', () => {
    expect(currentCastModelKey(u4a, 'kokoro', 'kokoro-v1')).toBe('qwen3-tts-0.6b');
    expect(currentCastModelKey(u4b, 'kokoro', 'kokoro-v1')).toBe('qwen3-tts-1.7b');
  });
  it('U5 a qwen pin does not apply off qwen', () => {
    expect(currentCastModelKey(u5, 'kokoro', 'qwen3-tts-1.7b')).toBe('kokoro-v1');
  });
  it('U6 no engine gives undefined', () => {
    expect(currentCastModelKey(ch(), undefined, 'qwen3-tts-0.6b')).toBeUndefined();
  });
  it('U7 parity with the render stamp', () => {
    const cases: [CastCharacter, TtsEngine, TtsModelKey][] = [
      [u1, 'qwen', 'qwen3-tts-0.6b'],
      [u2, 'qwen', 'qwen3-tts-0.6b'],
      [u4a, 'kokoro', 'kokoro-v1'],
      [u4b, 'kokoro', 'kokoro-v1'],
      [u5, 'kokoro', 'qwen3-tts-1.7b'],
    ];
    for (const [c, e, k] of cases) expect(currentCastModelKey(c, e, k)).toBe(snap(c, e, k));
  });
});
