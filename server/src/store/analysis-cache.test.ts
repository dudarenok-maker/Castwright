import { describe, it, expect } from 'vitest';
import { cachePath } from './analysis-cache.js';

describe('cachePath', () => {
  it('throws on a traversal manuscriptId', () => {
    expect(() => cachePath('../../evil')).toThrow();
  });
  it('accepts a normal nanoid manuscriptId', () => {
    expect(() => cachePath('mns_aB3_xY')).not.toThrow();
  });
});
