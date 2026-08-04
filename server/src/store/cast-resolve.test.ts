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
    const r = buildCastResolver(cast, history).resolve('mairin');
    expect(r?.character.id).toBe('mairin');
    // #2040 Wave 3 review round 1 — `via` pairs with `viaAlias` being unset.
    expect(r?.via).toBe('exact');
    expect(r?.viaAlias).toBeUndefined();
  });

  it('tier 2: history hit, and reports viaAlias', () => {
    const r = buildCastResolver(cast, history).resolve('mayrin');
    expect(r?.character.id).toBe('mairin');
    expect(r?.viaAlias).toBe('mayrin');
    expect(r?.via).toBe('history');
  });

  it('tier 3: normalised id — the wave-1 recovery, with an EMPTY history', () => {
    const r = buildCastResolver(cast).resolve('the-torment');
    expect(r?.character.id).toBe('the_torment');
    expect(r?.viaAlias).toBe('the-torment');
    expect(r?.via).toBe('normalised-id');
  });

  it('tier 4: normalised history key', () => {
    const r = buildCastResolver([{ id: 'x', name: 'X' }], { foo_bar: 'x' }).resolve('foo-bar');
    expect(r?.character.id).toBe('x');
    expect(r?.via).toBe('normalised-history');
  });

  it('tier 3 beats tier 4 — a live normalised id wins over an unrelated normalised history entry', () => {
    // #2040 Wave 3 review round 1 CRITICAL repro: 'the-mairin' is a live cast
    // id (tier 3, normalised). A DIFFERENT, unrelated history entry
    // ('the_Mairin' -> 'wren') also normalises to the same key (tier 4).
    // Precedence must pick tier 3 — the live id — not the coincidentally
    // normalised-matching history entry.
    const c = [{ id: 'wren', name: 'Wren' }, { id: 'the-mairin', name: 'Mairin' }];
    const h = { the_Mairin: 'wren' };
    const r = buildCastResolver(c, h).resolve('the-Mairin');
    expect(r?.character.id).toBe('the-mairin');
    expect(r?.via).toBe('normalised-id');
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

  it('a tier-3 normalised tie stops at the orphan path rather than falling through to tier 4', () => {
    // pool_player_2 and pool-player-2 both normalise to the same key, so tier
    // 3 (byNormId) is an ambiguous tie (`null`). A history entry also
    // normalises to that same key and would resolve cleanly at tier 4 if the
    // tier-3 tie were mistaken for a miss (`null` is falsy) — it must not be.
    const c = [{ id: 'pool_player_2', name: 'A' }, { id: 'pool-player-2', name: 'B' }];
    const h = { 'Pool-Player-2': 'pool-player-2' };
    expect(buildCastResolver(c, h).resolve('pool player 2')).toBeUndefined();
  });

  it('resolving a non-string characterId returns undefined rather than throwing', () => {
    expect(buildCastResolver(cast, history).resolve(undefined as unknown as string)).toBeUndefined();
  });
});
