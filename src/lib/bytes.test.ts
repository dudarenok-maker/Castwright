import { describe, it, expect } from 'vitest';
import { formatBytes } from './bytes';

describe('formatBytes', () => {
  it('renders an em dash for null/undefined', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
  });

  it('keeps raw bytes under 1 KB', () => {
    expect(formatBytes(512)).toBe('512 B');
  });

  it('uses one decimal under 10 of a unit, whole numbers above', () => {
    expect(formatBytes(3_623_878_656)).toBe('3.4 GB'); // 3.375 → 3.4
    expect(formatBytes(346_030_080)).toBe('330 MB'); // 330.0 → 330
  });

  it('scales up to TB', () => {
    expect(formatBytes(2 * 1024 ** 4)).toBe('2.0 TB');
  });
});
