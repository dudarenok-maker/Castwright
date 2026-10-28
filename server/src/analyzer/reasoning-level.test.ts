import { describe, it, expect } from 'vitest';
import { REASONING_LEVELS } from './reasoning-level.js';
import { REASONING_LEVELS as reExportedLevels } from './reasoning.js';

describe('reasoning-level.ts — the import-free leaf (#3084 wave 5)', () => {
  it('reasoning.ts re-exports the same array, not a copy', () => {
    expect(reExportedLevels).toBe(REASONING_LEVELS);
  });
  it('has the eight levels the rest of this wave assumes', () => {
    expect(REASONING_LEVELS).toEqual(['model-default', 'off', 'on', 'none', 'minimal', 'low', 'medium', 'high']);
  });
});
