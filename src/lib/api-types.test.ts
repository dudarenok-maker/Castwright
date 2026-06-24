import { describe, it, expect } from 'vitest';
import type { components } from './api-types';

describe('Sentence fs-57 fields', () => {
  it('accepts a value with instruct + vocalization', () => {
    const s: components['schemas']['Sentence'] = {
      id: 1, chapterId: 1, characterId: 'narrator', text: 'Ah! Hi.',
      instruct: 'a short gasp', vocalization: true,
    };
    expect(s.instruct).toBe('a short gasp');
    expect(s.vocalization).toBe(true);
  });
});
