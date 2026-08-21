import { describe, it, expect } from 'vitest';
import { normaliseIdKey } from './character-id.js';

describe('normaliseIdKey', () => {
  it('equates ids differing only by separator', () => {
    expect(normaliseIdKey('the_torment')).toBe(normaliseIdKey('the-torment'));
    expect(normaliseIdKey('lightning_dave')).toBe(normaliseIdKey('lightning-dave'));
  });

  it('equates ids differing only by case', () => {
    expect(normaliseIdKey('The-Torment')).toBe(normaliseIdKey('the-torment'));
  });

  it('collapses runs and trims edge separators', () => {
    expect(normaliseIdKey('__foo___bar__')).toBe('foo-bar');
    expect(normaliseIdKey('foo   bar')).toBe('foo-bar');
  });

  it('NEVER equates ids whose letters differ', () => {
    expect(normaliseIdKey('mairin')).not.toBe(normaliseIdKey('mayrin'));
    expect(normaliseIdKey('coalfall')).not.toBe(normaliseIdKey('coalfall-dragon'));
    expect(normaliseIdKey('pool-player-2')).not.toBe(normaliseIdKey('pool_player'));
  });

  it('preserves non-Latin characters', () => {
    expect(normaliseIdKey('мэйрин')).toBe('мэйрин');
    expect(normaliseIdKey('奥杜万')).toBe('奥杜万');
  });

  it('is output-identical to the previous trim-ReDoS implementation', () => {
    const legacy = (id: string): string =>
      id.toLowerCase().replace(/[-_\s]+/g, '-').replace(/^-+|-+$/g, '');
    const inputs = [
      '',
      '-',
      '---',
      '___',
      '   ',
      '-a-',
      '--a--',
      '_a b-c_',
      'A-B_C',
      'мэйрин-',
      '奥杜万--',
      '-'.repeat(200) + 'x',
    ];
    for (const input of inputs) {
      expect(normaliseIdKey(input)).toBe(legacy(input));
    }
  });

  it('replaces the ^-+|-+$ regex with linear stripEdges', () => {
    // CodeQL flagged the old regex /^-+|-+$/ as polynomial-redos (#226),
    // based on the alternation pattern between two anchored quantifiers.
    // The fix replaces it with stripEdges(), which is obviously linear O(n).
    //
    // NOTE: empirically, Node.js/V8's regex engine does NOT exhibit
    // catastrophic backtracking on this pattern with any tested input
    // (including 100k+ dashes), suggesting either:
    // (a) the engine has protections against this ReDoS class, or
    // (b) CodeQL's static analysis was conservative/false-positive.
    // Regardless, stripEdges is superior: provably linear and more readable.

    const largeInput = '-'.repeat(10000) + 'x';

    // New implementation is linear — completes instantly even on large input.
    const startNew = performance.now();
    const resultNew = normaliseIdKey(largeInput);
    const durationNew = performance.now() - startNew;

    expect(resultNew).toBe('x');
    expect(durationNew).toBeLessThan(100); // Should be microseconds, not ms

    // Verify the old regex produces identical output (output-identity test;
    // this is what the prior mutation actually proves).
    const legacy = (id: string): string =>
      id.toLowerCase().replace(/[-_\s]+/g, '-').replace(/^-+|-+$/g, '');

    expect(legacy(largeInput)).toBe('x');
  });
});
