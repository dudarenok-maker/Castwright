/* Ports the frontend script-review apply/match core (src/lib/script-review-apply.ts)
   server-side so the attribution eval harness can reuse it without pulling in
   Redux. review-apply-vectors.json is a SHARED fixture — the frontend test
   (src/lib/script-review-apply.test.ts) loads the same file and asserts its
   `planApply` produces an identical result, so the two implementations can
   never silently drift apart. */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { normalizeForMatch, resolveAnchorOffset, planApply, type LiveSentence } from './review-apply-core.js';
import type { ScriptReviewOp } from '../../handoff/schemas.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VECTORS_PATH = path.join(__dirname, '__fixtures__', 'review-apply-vectors.json');

interface Vector {
  name: string;
  ops: ScriptReviewOp[];
  live: LiveSentence[];
  roster: string[];
  expected: {
    appliableOpIndexes: number[];
    unappliable: Array<{ opIndex: number; reason: string }>;
  };
}

function loadVectors(): Vector[] {
  return JSON.parse(readFileSync(VECTORS_PATH, 'utf8'));
}

describe('review-apply-core — shared no-drift vector', () => {
  const vectors = loadVectors();

  for (const vector of vectors) {
    it(vector.name, () => {
      const result = planApply(vector.ops, vector.live, new Set(vector.roster));

      const appliableOpIndexes = result.appliable.map((op) => vector.ops.indexOf(op));
      expect(appliableOpIndexes).toEqual(vector.expected.appliableOpIndexes);

      const unappliable = result.unappliable.map((u) => ({ opIndex: vector.ops.indexOf(u.op), reason: u.reason }));
      expect(unappliable).toEqual(vector.expected.unappliable);
    });
  }
});

describe('resolveAnchorOffset', () => {
  it('returns the exact original offset of a unique anchor match', () => {
    const text = 'He paused—then ran. "Stop," she said.';
    const off = resolveAnchorOffset(text, 'ran. "Stop,"'); // anchor uses straight quotes
    expect(off).not.toBeNull();
    expect(text.slice(off!)).toBe(' she said.');
  });

  it('returns null when the anchor is not unique', () => {
    expect(resolveAnchorOffset('he said, he said', 'he said')).toBeNull();
  });

  it('returns null when the anchor is absent', () => {
    expect(resolveAnchorOffset('totally different', 'ran.')).toBeNull();
  });
});

describe('normalizeForMatch', () => {
  it('folds smart quotes, dashes, and ellipsis to their plain equivalents', () => {
    expect(normalizeForMatch('‘a’ “b” – — …')).toBe("'a' \"b\" - - ...");
  });

  it('does NOT collapse whitespace', () => {
    expect(normalizeForMatch('a  b')).toBe('a  b');
  });
});
