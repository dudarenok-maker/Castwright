import { describe, it, expect } from 'vitest';
import { resolveDisplayTtsVoice } from './tts-voice-mapping';

/* Build minimal Character/Voice values off the function's own parameter types
   so this unit test needs no fixture/type imports. */
type C = Parameters<typeof resolveDisplayTtsVoice>[0];
type V = NonNullable<Parameters<typeof resolveDisplayTtsVoice>[1]>;

const ch = (o: Partial<C> = {}): C => ({ id: 'c1', name: 'Test', ...o }) as C;
const vx = (o: Partial<V> = {}): V =>
  ({ id: 'v1', ttsVoice: { provider: 'coqui', name: 'Damien Black', description: '' }, ...o }) as V;

describe('resolveDisplayTtsVoice', () => {
  it('uses the character qwen override when present', () => {
    const r = resolveDisplayTtsVoice(
      ch({ ttsEngine: 'qwen', overrideTtsVoices: { qwen: { name: 'qwen-wren' } } }),
      undefined,
      'kokoro',
    );
    expect(r).toEqual({ provider: 'qwen', name: 'qwen-wren', description: 'Designed voice' });
  });

  it('falls back to the matched qwen Voice for a reused row with no override', () => {
    /* Regression: reused qwen characters carry the designed voice on the matched
       library Voice (override empty). The row must show that voice, not the
       "No voice designed yet" stub. */
    const r = resolveDisplayTtsVoice(
      ch({ ttsEngine: 'qwen' }),
      vx({ ttsVoice: { provider: 'qwen', name: 'qwen-lord-vane', description: 'Designed voice' } }),
      'kokoro',
    );
    expect(r).toEqual({ provider: 'qwen', name: 'qwen-lord-vane', description: 'Designed voice' });
  });

  it('returns the empty qwen stub when neither override nor a named qwen Voice resolves', () => {
    const r = resolveDisplayTtsVoice(ch({ ttsEngine: 'qwen' }), undefined, 'kokoro');
    expect(r).toEqual({ provider: 'qwen', name: '', description: 'No voice designed yet' });
  });

  it('does not borrow a non-qwen matched Voice for a qwen character', () => {
    const r = resolveDisplayTtsVoice(
      ch({ ttsEngine: 'qwen' }),
      vx({ ttsVoice: { provider: 'kokoro', name: 'af_bella', description: '' } }),
      'kokoro',
    );
    expect(r.name).toBe('');
  });

  it('preset engine still shows the matched library voice', () => {
    const r = resolveDisplayTtsVoice(ch(), vx(), 'coqui');
    expect(r).toEqual({ provider: 'coqui', name: 'Damien Black', description: '' });
  });
});
