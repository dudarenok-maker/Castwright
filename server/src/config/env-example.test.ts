import { describe, it, expect } from 'vitest';
import { renderManagedBlock, BEGIN, END } from './env-example.js';

describe('.env.example managed block', () => {
  it('includes every non-prompt knob with its default', () => {
    const block = renderManagedBlock();
    expect(block.startsWith(BEGIN)).toBe(true);
    expect(block.trimEnd().endsWith(END)).toBe(true);
    expect(block).toContain('STAGE2_MIN_COVERAGE=');
    expect(block).toContain('GPU_WEIGHT_COQUI=');
    // prompts have no env → must NOT appear
    expect(block).not.toContain('prompt.castDetection');
  });
});
