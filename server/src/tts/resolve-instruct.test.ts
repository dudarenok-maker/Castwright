// server/src/tts/resolve-instruct.test.ts
import { describe, it, expect } from 'vitest';
import { resolveInstructForGroup } from './resolve-instruct.js';
import { emotionToInstruct } from './emotion-instruct.js';

describe('resolveInstructForGroup', () => {
  it('returns the instruct phrase when is17b, regardless of any liveInstruct', () => {
    expect(resolveInstructForGroup({ instruct: 'a sharp whisper' }, { is17b: true }))
      .toEqual({ instruct: 'a sharp whisper' });
  });

  it('returns {} when not is17b', () => {
    expect(resolveInstructForGroup({ instruct: 'a sharp whisper' }, { is17b: false }))
      .toEqual({});
  });

  it('falls back to the emotion phrase when no explicit instruct', () => {
    expect(resolveInstructForGroup({ emotion: 'angry' }, { is17b: true }))
      .toEqual({ instruct: emotionToInstruct('angry') });
  });

  it('neutral/absent emotion yields no instruct even on 1.7B', () => {
    expect(resolveInstructForGroup({ emotion: 'neutral' }, { is17b: true })).toEqual({});
    expect(resolveInstructForGroup({}, { is17b: true })).toEqual({});
  });
});
