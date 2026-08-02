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
});
