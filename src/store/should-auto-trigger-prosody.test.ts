import { describe, it, expect } from 'vitest';
import { shouldAutoTriggerProsody } from './should-auto-trigger-prosody';
import type { RootState } from './index';

const mk = (prosody = {}, review = {}) =>
  ({ prosody: { activeStreams: prosody }, scriptReview: { activeStreams: review } } as unknown as RootState);

describe('shouldAutoTriggerProsody', () => {
  it('true when idle', () => expect(shouldAutoTriggerProsody(mk(), 'b1')).toBe(true));
  it('false when prosody runs for the book', () =>
    expect(shouldAutoTriggerProsody(mk({ b1: { progress: 0, label: 'x' } }), 'b1')).toBe(false));
  it('false when review runs for the book', () =>
    expect(shouldAutoTriggerProsody(mk({}, { b1: { progress: 0, label: 'x' } }), 'b1')).toBe(false));
  it('true when another book is busy', () =>
    expect(shouldAutoTriggerProsody(mk({ b2: { progress: 0, label: 'x' } }), 'b1')).toBe(true));
});
