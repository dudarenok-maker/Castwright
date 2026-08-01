import { describe, it, expect } from 'vitest';
import { buildCastResolver } from './cast-resolve.js';

const cast = [
  { id: 'narrator', name: 'Narrator' },
  { id: 'mairin', name: 'Мэйрин' },
  { id: 'the_torment', name: 'Torment' },
];
const history = { mayrin: 'mairin' };

describe('buildCastResolver', () => {
  it('tier 1: exact id', () => {
    expect(buildCastResolver(cast, history).resolve('mairin')?.character.id).toBe('mairin');
  });

  it('tier 2: history hit, and reports viaAlias', () => {
    const r = buildCastResolver(cast, history).resolve('mayrin');
    expect(r?.character.id).toBe('mairin');
    expect(r?.viaAlias).toBe('mayrin');
  });

  it('tier 3: normalised id — the wave-1 recovery, with an EMPTY history', () => {
    const r = buildCastResolver(cast).resolve('the-torment');
    expect(r?.character.id).toBe('the_torment');
    expect(r?.viaAlias).toBe('the-torment');
  });

  it('tier 4: normalised history key', () => {
    const r = buildCastResolver([{ id: 'x', name: 'X' }], { foo_bar: 'x' }).resolve('foo-bar');
    expect(r?.character.id).toBe('x');
  });

  it('a history entry whose target is NOT a live cast id does not resolve', () => {
    expect(buildCastResolver(cast, { ghost: 'deleted-character' }).resolve('ghost')).toBeUndefined();
  });

  it('an exact live id BEATS a history entry claiming it', () => {
    const c = [{ id: 'unknown-male', name: 'Unknown Male' }, { id: 'timkin', name: 'Timkin' }];
    const r = buildCastResolver(c, { 'unknown-male': 'timkin' }).resolve('unknown-male');
    expect(r?.character.id).toBe('unknown-male');
  });

  it('returns undefined on a genuine miss', () => {
    expect(buildCastResolver(cast, history).resolve('nobody')).toBeUndefined();
  });

  it('returns undefined on a NORMALISED tie rather than guessing', () => {
    const c = [{ id: 'foo_bar', name: 'A' }, { id: 'foo-bar', name: 'B' }];
    expect(buildCastResolver(c).resolve('foo bar')).toBeUndefined();
  });
});
