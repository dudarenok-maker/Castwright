import { describe, it, expect } from 'vitest';
import { NoCapacityError } from './tts-errors.js';

describe('NoCapacityError', () => {
  it('names the blocking models and their remedies in the message', () => {
    const err = new NoCapacityError('qwen', 4100, 'cuda:0', [
      { model: 'Coqui XTTS', remedy: 'Stop it in the Models panel.' },
    ]);

    expect(err.message).toContain('Coqui XTTS');
    expect(err.message).toContain('Stop it in the Models panel.');
    expect(err.blockers).toHaveLength(1);
  });

  it('falls back to the generic advice when nothing user-controlled is resident', () => {
    const err = new NoCapacityError('qwen', 4100, 'cuda:0', []);
    expect(err.message).toContain('free VRAM or attach a second GPU');
    expect(err.blockers).toEqual([]);
  });
});
