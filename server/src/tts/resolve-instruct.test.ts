// server/src/tts/resolve-instruct.test.ts
import { describe, it, expect } from 'vitest';
import { resolveInstructForGroup } from './resolve-instruct.js';

const grp = (o: Partial<{ emotion: string; instruct: string }>) =>
  ({ emotion: undefined, instruct: undefined, ...o }) as any;

describe('resolveInstructForGroup', () => {
  it('1.7B + liveInstruct: explicit instruct wins', () => {
    expect(resolveInstructForGroup(grp({ instruct: 'a tired sigh', emotion: 'angry' }),
      { is17b: true, liveInstruct: true })).toEqual({ instruct: 'a tired sigh' });
  });
  it('1.7B + liveInstruct: falls back to emotion phrase', () => {
    expect(resolveInstructForGroup(grp({ emotion: 'angry' }),
      { is17b: true, liveInstruct: true })).toEqual({ instruct: 'in an angry, raised voice' });
  });
  it('liveInstruct off: no instruct (today)', () => {
    expect(resolveInstructForGroup(grp({ emotion: 'angry' }),
      { is17b: true, liveInstruct: false })).toEqual({});
  });
  it('0.6B: never instruct', () => {
    expect(resolveInstructForGroup(grp({ instruct: 'x' }),
      { is17b: false, liveInstruct: true })).toEqual({});
  });
  it('1.7B + liveInstruct + neutral emotion: no instruct', () => {
    expect(resolveInstructForGroup(grp({ emotion: 'neutral' }),
      { is17b: true, liveInstruct: true })).toEqual({});
  });
  it('1.7B + liveInstruct + no emotion + no instruct: no instruct', () => {
    expect(resolveInstructForGroup(grp({}),
      { is17b: true, liveInstruct: true })).toEqual({});
  });
});
