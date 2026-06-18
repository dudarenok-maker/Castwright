import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { safeSegment, assertContained, safeJoin, PathContainmentError } from './safe-path.js';

describe('safeSegment', () => {
  it('accepts Unicode letters/numbers and allowed punctuation', () => {
    for (const ok of [
      'война__standalones__война',
      'qwen-война__angry-preview',
      'mns_aB3_xY',
      'a__b__c',
      'cover.jpg',
      '.audiobook',
    ])
      expect(safeSegment(ok)).toBe(ok);
  });
  it('rejects separators, NUL, dot-segments and absolute/drive paths', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a\x00b', '/etc', 'C:\\x'])
      expect(() => safeSegment(bad)).toThrow(PathContainmentError);
  });
});

describe('assertContained / safeJoin', () => {
  const root = path.resolve('/srv/workspace');
  it('accepts a contained path', () => {
    expect(() => assertContained(root, path.join(root, 'books', 'x.json'))).not.toThrow();
    expect(safeJoin(root, 'books', 'x.json')).toBe(path.join(root, 'books', 'x.json'));
  });
  it('rejects an escaping path', () => {
    expect(() => assertContained(root, path.resolve(root, '..', 'evil'))).toThrow(
      PathContainmentError,
    );
    expect(() => safeJoin(root, '..', 'evil')).toThrow(PathContainmentError);
  });
});
