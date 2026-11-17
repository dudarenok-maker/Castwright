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
import { buildNormIndex, normalizeForMatch, resolveAnchorOffset, planApply, type LiveSentence } from './review-apply-core.js';
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

interface AnchorVector {
  name: string;
  text: string;
  anchor: string;
  expectedTail: string | null;
  forms?: { text: 'NFC' | 'NFD'; anchor: 'NFC' | 'NFD' };
}

describe('resolveAnchorOffset — shared anchor vectors (#4226)', () => {
  const vectors: AnchorVector[] = JSON.parse(
    readFileSync(path.join(__dirname, '__fixtures__', 'anchor-offset-vectors.json'), 'utf8'),
  );
  const other = (f: 'NFC' | 'NFD'): 'NFC' | 'NFD' => (f === 'NFC' ? 'NFD' : 'NFC');

  for (const vector of vectors) {
    it(vector.name, () => {
      if (vector.forms) {
        expect(vector.text.normalize(vector.forms.text)).toBe(vector.text);
        expect(vector.text.normalize(other(vector.forms.text))).not.toBe(vector.text);
        expect(vector.anchor.normalize(vector.forms.anchor)).toBe(vector.anchor);
        expect(vector.anchor.normalize(other(vector.forms.anchor))).not.toBe(vector.anchor);
      }
      const off = resolveAnchorOffset(vector.text, vector.anchor);
      if (vector.expectedTail === null) expect(off).toBeNull();
      else expect(vector.text.slice(off!)).toBe(vector.expectedTail);
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
  it('resolves an anchor containing an NFC-changing astral char (#4219)', () => {
    const text = 'Он сказал \u{2F800} и ушёл.';
    const off = resolveAnchorOffset(text, '\u{2F800} и');
    expect(off).not.toBeNull();
    expect(text.slice(off!)).toBe(' ушёл.');
  });
  it('resolves an anchor after an NFC-changing astral char to the exact original offset (#4219)', () => {
    const text = 'a \u{2F800} b. c';
    const off = resolveAnchorOffset(text, 'b.');
    expect(off).not.toBeNull();
    expect(text.slice(off!)).toBe(' c');
  });
  it('still resolves an NFC-stable astral char (emoji)', () => {
    const text = 'Go \u{1F600} now. Stop.';
    const off = resolveAnchorOffset(text, '\u{1F600} now.');
    expect(off).not.toBeNull();
    expect(text.slice(off!)).toBe(' Stop.');
  });
  it('resolves a decomposed BMP accent (e + U+0301)', () => {
    const text = 'café au lait.';
    const off = resolveAnchorOffset(text, 'café');
    expect(off).not.toBeNull();
    expect(text.slice(off!)).toBe(' au lait.');
  });
});

describe('normalizeForMatch', () => {
  it('folds smart quotes, dashes, and ellipsis to their plain equivalents', () => {
    expect(normalizeForMatch('‘a’ “b” – — …')).toBe("'a' \"b\" - - ...");
  });

  it('does NOT collapse whitespace', () => {
    expect(normalizeForMatch('a  b')).toBe('a  b');
  });

  it('treats composed and decomposed spellings as equal (#4226)', () => {
    expect(normalizeForMatch('café')).toBe(normalizeForMatch('café'));
  });

  it('keeps a combining mark that has no precomposed form (#4226)', () => {
    expect(normalizeForMatch('Она́')).toHaveLength(4);
  });
});

describe('buildNormIndex', () => {
  it('maps only run boundaries; positions inside the ellipsis fold are null (#4226)', () => {
    expect(buildNormIndex('Wait… no').origAt).toEqual([0, 1, 2, 3, 4, null, null, 5, 6, 7, 8]);
  });
});
