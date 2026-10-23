import { describe, it, expect } from 'vitest';
import { NoCapacityError } from './tts-errors.js';

describe('NoCapacityError', () => {
  it('names the blocking models and their remedies in the message', () => {
    const err = new NoCapacityError('qwen', 4100, 'cuda:0', [
      { model: 'Coqui XTTS', remedy: 'Use its Stop button, at the top of the window.' },
    ]);

    expect(err.message).toContain('Coqui XTTS');
    expect(err.message).toContain('Use its Stop button, at the top of the window.');
    expect(err.blockers).toHaveLength(1);
  });

  it('falls back to the generic advice when nothing user-controlled is resident', () => {
    const err = new NoCapacityError('qwen', 4100, 'cuda:0', []);
    expect(err.message).toContain('free VRAM or attach a second GPU');
    expect(err.blockers).toEqual([]);
  });
});

describe('NoCapacityError notes (#3084)', () => {
  it('appends notes after the blocker text', () => {
    const err = new NoCapacityError('qwen', 3000, 'cuda:0', [], ['Analyzer endpoint "Lab" has no Unload URL.']);
    expect(err.message).toBe('Not enough GPU memory for qwen (3000MB) — free VRAM or attach a second GPU. Analyzer endpoint "Lab" has no Unload URL.');
  });
  it('without notes the message is unchanged', () => {
    expect(new NoCapacityError('qwen', 3000, 'cuda:0').message).toBe('Not enough GPU memory for qwen (3000MB) — free VRAM or attach a second GPU.');
  });
});
