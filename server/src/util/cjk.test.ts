/* Unit tests for the shared CJK-char primitives (issue #1576 — fs-59 W2
   review follow-up: unify the two divergent CJK regexes). Pins both the
   common-case behaviour the old range-form regexes already handled, AND the
   supplementary-plane / compatibility / halfwidth codepoints the old range
   form (`[぀-ヿ㐀-䶿一-鿿]`, formerly in `analyzer/gemini.ts` and
   `analyzer/strip-front-matter.ts`) silently missed. */
import { describe, expect, it } from 'vitest';
import { CJK_CHAR_RE, hasCjkChar, countCjkChars } from './cjk.js';

describe('hasCjkChar', () => {
  it('is true for common Han, Hiragana, and Katakana', () => {
    expect(hasCjkChar('序')).toBe(true); // Han
    expect(hasCjkChar('あとがき')).toBe(true); // Hiragana
    expect(hasCjkChar('プロローグ')).toBe(true); // Katakana
  });

  it('is false for Latin and Cyrillic text', () => {
    expect(hasCjkChar('Prologue')).toBe(false);
    expect(hasCjkChar('Пролог')).toBe(false);
    expect(hasCjkChar('')).toBe(false);
  });

  it('is true for codepoints the old range-form regex missed', () => {
    expect(hasCjkChar('ｱ')).toBe(true); // halfwidth katakana ｱ
    expect(hasCjkChar('\u{F900}')).toBe(true); // CJK Compatibility Ideograph 豈
    expect(hasCjkChar('\u{20000}')).toBe(true); // supplementary-plane Han (Ext. B)
  });
});

describe('countCjkChars', () => {
  it('counts each CJK char, ignoring Latin/whitespace', () => {
    expect(countCjkChars('序章 Hello 終章')).toBe(4); // 序, 章, 終, 章
  });

  it('returns 0 for text with no CJK chars', () => {
    expect(countCjkChars('Hello world')).toBe(0);
  });

  it('counts supplementary-plane codepoints as one char, not two UTF-16 units', () => {
    expect(countCjkChars('\u{20000}')).toBe(1);
  });
});

describe('CJK_CHAR_RE', () => {
  it('is the single property-escape source both call sites now share', () => {
    expect(CJK_CHAR_RE.source).toBe('[\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}]');
  });
});
