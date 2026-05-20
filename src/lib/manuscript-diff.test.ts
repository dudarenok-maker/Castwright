// Pairs with docs/features/74-manuscript-diff-on-reupload.md

import { describe, it, expect } from 'vitest';
import {
  splitIntoSentences,
  diffManuscripts,
  diffSentenceArrays,
  charDiff,
  summariseDiff,
} from './manuscript-diff';

describe('splitIntoSentences', () => {
  it('returns an empty array for empty input', () => {
    expect(splitIntoSentences('')).toEqual([]);
  });

  it('splits on terminal punctuation followed by whitespace', () => {
    expect(splitIntoSentences('Hello world. This is fine. Right?')).toEqual([
      'Hello world.',
      'This is fine.',
      'Right?',
    ]);
  });

  it('treats blank-line-separated chunks as paragraph breaks (own sentences)', () => {
    const out = splitIntoSentences('First para.\n\nSecond para.\n\nThird.');
    expect(out).toEqual(['First para.', 'Second para.', 'Third.']);
  });

  it('keeps closing quotes attached to the preceding sentence', () => {
    const out = splitIntoSentences('"Stop!" she said. He laughed.');
    expect(out).toEqual(['"Stop!" she said.', 'He laughed.']);
  });

  it('normalises CRLF to LF before splitting (Windows manuscript)', () => {
    const out = splitIntoSentences('Hello.\r\n\r\nWorld.');
    expect(out).toEqual(['Hello.', 'World.']);
  });
});

describe('diffManuscripts — identity & trivial cases', () => {
  it('returns all-equal entries when inputs are identical', () => {
    const diff = diffManuscripts('One. Two. Three.', 'One. Two. Three.');
    expect(diff.every((d) => d.type === 'equal')).toBe(true);
    expect(diff).toHaveLength(3);
  });

  it('treats whitespace-only changes as equal (collapse to compare key)', () => {
    /* "Hello world. Goodbye." vs "Hello  world.  Goodbye." should diff as
       all-equal — visible text retains the original whitespace but the
       comparison key normalises it. */
    const diff = diffManuscripts('Hello world. Goodbye.', 'Hello  world.  Goodbye.');
    expect(diff.every((d) => d.type === 'equal')).toBe(true);
  });

  it('handles empty old → all inserts', () => {
    const diff = diffManuscripts('', 'One. Two.');
    expect(diff.every((d) => d.type === 'insert')).toBe(true);
    expect(diff).toHaveLength(2);
  });

  it('handles empty new → all deletes', () => {
    const diff = diffManuscripts('One. Two.', '');
    expect(diff.every((d) => d.type === 'delete')).toBe(true);
    expect(diff).toHaveLength(2);
  });
});

describe('diffManuscripts — structural cases', () => {
  it('pure insertion in the middle', () => {
    const diff = diffManuscripts('A. C.', 'A. B. C.');
    expect(diff.map((d) => d.type)).toEqual(['equal', 'insert', 'equal']);
    const inserted = diff.find((d) => d.type === 'insert') as { newText: string };
    expect(inserted.newText).toBe('B.');
  });

  it('pure deletion from the middle', () => {
    const diff = diffManuscripts('A. B. C.', 'A. C.');
    expect(diff.map((d) => d.type)).toEqual(['equal', 'delete', 'equal']);
    const deleted = diff.find((d) => d.type === 'delete') as { oldText: string };
    expect(deleted.oldText).toBe('B.');
  });

  it('folds adjacent delete+insert into one replace row', () => {
    const diff = diffManuscripts('A. Old. C.', 'A. New. C.');
    expect(diff.map((d) => d.type)).toEqual(['equal', 'replace', 'equal']);
    const rep = diff.find((d) => d.type === 'replace') as {
      oldText: string;
      newText: string;
    };
    expect(rep.oldText).toBe('Old.');
    expect(rep.newText).toBe('New.');
  });

  it('multi-sentence replace surfaces every changed pair', () => {
    const diff = diffManuscripts('A. Old1. Old2. C.', 'A. New1. New2. C.');
    const replaces = diff.filter((d) => d.type === 'replace');
    expect(replaces).toHaveLength(2);
  });

  it('inserts at start and end ride alongside equal middle', () => {
    const diff = diffManuscripts('B.', 'A. B. C.');
    expect(diff.map((d) => d.type)).toEqual(['insert', 'equal', 'insert']);
  });
});

describe('diffSentenceArrays — exposed for slice integration', () => {
  it('matches diffManuscripts output when fed equivalent splits', () => {
    const direct = diffManuscripts('A. B.', 'A. C.');
    const arrayed = diffSentenceArrays(['A.', 'B.'], ['A.', 'C.']);
    expect(arrayed.map((d) => d.type)).toEqual(direct.map((d) => d.type));
  });
});

describe('charDiff', () => {
  it('returns a single equal span when inputs match', () => {
    expect(charDiff('hello', 'hello')).toEqual([{ type: 'equal', text: 'hello' }]);
  });

  it('returns empty array when both inputs are empty', () => {
    expect(charDiff('', '')).toEqual([]);
  });

  it('highlights the changed word inside an otherwise-equal sentence', () => {
    const spans = charDiff('The quick brown fox.', 'The slow brown fox.');
    const added = spans.filter((s) => s.type === 'add').map((s) => s.text);
    const removed = spans.filter((s) => s.type === 'remove').map((s) => s.text);
    expect(removed.join('')).toContain('quick');
    expect(added.join('')).toContain('slow');
    /* The shared "The " and " brown fox." prefix/suffix must surface as
       equal spans, not get rewritten as edits. */
    const equalText = spans
      .filter((s) => s.type === 'equal')
      .map((s) => s.text)
      .join('');
    expect(equalText).toContain('brown');
    expect(equalText).toContain('fox');
  });

  it('merges consecutive same-type spans (one <span> per logical run)', () => {
    const spans = charDiff('abc', 'xyz');
    /* All tokens differ → one remove span + one add span, not three of each. */
    const removes = spans.filter((s) => s.type === 'remove');
    const adds = spans.filter((s) => s.type === 'add');
    expect(removes).toHaveLength(1);
    expect(adds).toHaveLength(1);
  });
});

describe('summariseDiff', () => {
  it('reports zeroes for an all-equal diff', () => {
    const diff = diffManuscripts('A. B.', 'A. B.');
    expect(summariseDiff(diff)).toEqual({ changed: 0, added: 0, removed: 0 });
  });

  it('counts replaces as changed, inserts as added, deletes as removed', () => {
    const diff = diffManuscripts('A. Old. C. D.', 'A. New. C.');
    /* B → New = replace, D = delete; counts: 1 changed, 0 added, 1 removed. */
    expect(summariseDiff(diff)).toEqual({ changed: 1, added: 0, removed: 1 });
  });
});

describe('diffManuscripts — perf smoke', () => {
  it('completes a 1000-sentence diff in under 200 ms', () => {
    /* Generate two manuscripts that are 90% shared with 10% changes
       scattered through. Deterministic seed so the bench is repeatable. */
    const oldSents: string[] = [];
    const newSents: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const base = `Sentence number ${i} is here.`;
      oldSents.push(base);
      if (i % 10 === 0) {
        newSents.push(`Sentence number ${i} was rewritten.`);
      } else {
        newSents.push(base);
      }
    }
    const oldText = oldSents.join(' ');
    const newText = newSents.join(' ');
    const t0 = performance.now();
    const diff = diffManuscripts(oldText, newText);
    const elapsed = performance.now() - t0;
    expect(diff.length).toBeGreaterThan(900);
    expect(elapsed).toBeLessThan(200);
  });
});
