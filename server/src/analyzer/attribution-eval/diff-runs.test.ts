import { describe, it, expect } from 'vitest';
import { diffRuns } from './diff-runs.js';
import type { SentenceOutput } from '../../handoff/schemas.js';

const base: SentenceOutput[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A', confidence: 0.9 },
  { id: 2, chapterId: 1, characterId: 'alice', text: 'B', confidence: 0.5 },
];
const tuned: SentenceOutput[] = [
  { id: 1, chapterId: 1, characterId: 'narrator', text: 'A', confidence: 0.9 },
  { id: 2, chapterId: 1, characterId: 'bob', text: 'B', confidence: 0.95 },
];

describe('diffRuns', () => {
  it('reports low-confidence delta and changed attributions', () => {
    const d = diffRuns(base, tuned);
    expect(d.lowConfDelta).toBe(-1); // one fewer low-conf line
    expect(d.changed).toEqual([{ id: 2, chapterId: 1, text: 'B', from: 'alice', to: 'bob' }]);
  });
});
