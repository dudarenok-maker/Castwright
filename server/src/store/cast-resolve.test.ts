import { describe, it, expect } from 'vitest';
import { buildCastResolver } from './cast-resolve.js';
import type { CastIdHistory } from './cast-id-history.js';

const cast = [
  { id: 'narrator', name: 'Narrator' },
  { id: 'mairin', name: 'Мэйрин' },
  { id: 'the_torment', name: 'Torment' },
];

/* Small helper so every call site doesn't have to spell out
   `{ supersededBy: ..., rejected: ... }` by hand — buildCastResolver takes
   the whole loaded `CastIdHistory` shape (#2040 Task 17 fix round 1), not a
   bare supersededBy map plus a separate rejected array. */
function h(
  supersededBy: Record<string, string> = {},
  rejected?: string[],
): Pick<CastIdHistory, 'supersededBy' | 'rejected'> {
  return rejected === undefined ? { supersededBy } : { supersededBy, rejected };
}

/* Same idea as `h`, for the pair-scoped successor (#2092/#2089 D1). */
function hp(
  supersededBy: Record<string, string>,
  rejectedPairs: Array<{ from: string; to: string }>,
): Pick<CastIdHistory, 'supersededBy' | 'rejectedPairs'> {
  return { supersededBy, rejectedPairs };
}

const history = h({ mayrin: 'mairin' });

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
    const r = buildCastResolver([{ id: 'x', name: 'X' }], h({ foo_bar: 'x' })).resolve('foo-bar');
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
    const r = buildCastResolver(c, h({ the_Mairin: 'wren' })).resolve('the-Mairin');
    expect(r?.character.id).toBe('the-mairin');
    expect(r?.via).toBe('normalised-id');
  });

  it('a history entry whose target is NOT a live cast id does not resolve', () => {
    expect(
      buildCastResolver(cast, h({ ghost: 'deleted-character' })).resolve('ghost'),
    ).toBeUndefined();
  });

  it('an exact live id BEATS a history entry claiming it', () => {
    const c = [{ id: 'unknown-male', name: 'Unknown Male' }, { id: 'timkin', name: 'Timkin' }];
    const r = buildCastResolver(c, h({ 'unknown-male': 'timkin' })).resolve('unknown-male');
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
    const r = buildCastResolver(c, h({ 'Pool-Player-2': 'pool-player-2' })).resolve('pool player 2');
    expect(r).toBeUndefined();
  });

  it('resolving a non-string characterId returns undefined rather than throwing', () => {
    expect(buildCastResolver(cast, history).resolve(undefined as unknown as string)).toBeUndefined();
  });

  describe('rejected (#2040 Task 17 — "not the same character")', () => {
    it('blocks a history-tier match', () => {
      expect(
        buildCastResolver(cast, h({ mayrin: 'mairin' }, ['mayrin'])).resolve('mayrin'),
      ).toBeUndefined();
    });

    it('blocks a normalised-id-tier match', () => {
      expect(
        buildCastResolver(cast, h({}, ['the-torment'])).resolve('the-torment'),
      ).toBeUndefined();
    });

    it('blocks a normalised-history-tier match', () => {
      const c = [{ id: 'x', name: 'X' }];
      expect(
        buildCastResolver(c, h({ foo_bar: 'x' }, ['foo-bar'])).resolve('foo-bar'),
      ).toBeUndefined();
    });

    it('fix round 1 — an exact live id BEATS a rejection: a reclaimed id must still resolve', () => {
      // #2040 Task 17 fix round 1 CRITICAL repro: 'mairin' was rejected as
      // the answer for some now-irrelevant orphaned id, but 'mairin' is
      // ALSO, independently, a genuine live cast row (tier 1). Checking
      // `rejected` before `exact` would strand those segments — the exact
      // bug #2040 exists to fix, reintroduced by the fix itself. Liveness
      // must always win, mirroring dropSupersededIdsReclaimedByLiveCast's
      // principle for `supersededBy`.
      const r = buildCastResolver(cast, h({}, ['mairin'])).resolve('mairin');
      expect(r?.character.id).toBe('mairin');
      expect(r?.via).toBe('exact');
    });

    it('does not affect an id that is not in the rejected list', () => {
      const r = buildCastResolver(cast, h({ mayrin: 'mairin' }, ['some-other-id'])).resolve('mayrin');
      expect(r?.character.id).toBe('mairin');
    });

    it('defaults to no rejections when the history object omits `rejected`', () => {
      const r = buildCastResolver(cast, h({ mayrin: 'mairin' })).resolve('mayrin');
      expect(r?.character.id).toBe('mairin');
    });

    it('defaults to no rejections when the second argument is omitted entirely', () => {
      const r = buildCastResolver(cast).resolve('the_torment');
      expect(r?.character.id).toBe('the_torment');
    });
  });

  describe('rejectedPairs (#2092/#2089 D1/D2 — pair-scoped "not the same character")', () => {
    it('blocks a history-tier match onto the rejected target', () => {
      expect(
        buildCastResolver(cast, hp({ mayrin: 'mairin' }, [{ from: 'mayrin', to: 'mairin' }])).resolve(
          'mayrin',
        ),
      ).toBeUndefined();
    });

    it('blocks a normalised-id-tier match onto the rejected target', () => {
      expect(
        buildCastResolver(cast, hp({}, [{ from: 'the-torment', to: 'the_torment' }])).resolve(
          'the-torment',
        ),
      ).toBeUndefined();
    });

    it('blocks a normalised-history-tier match onto the rejected target', () => {
      const c = [{ id: 'x', name: 'X' }];
      expect(
        buildCastResolver(c, hp({ foo_bar: 'x' }, [{ from: 'foo-bar', to: 'x' }])).resolve('foo-bar'),
      ).toBeUndefined();
    });

    it('D1 pair scope: a DIFFERENT target for the same rejected `from` id still resolves', () => {
      // The whole point of D1 over the legacy id-wide `rejected`: rejecting
      // "mayrin is not Mr. Marrow" must not also block "mayrin is Mairin"
      // once a later analysis mints the RIGHT history entry.
      const c = [{ id: 'mr-marrow', name: 'Mr. Marrow' }, { id: 'mairin', name: 'Mairin' }];
      const history = hp({ mayrin: 'mairin' }, [{ from: 'mayrin', to: 'mr-marrow' }]);
      const r = buildCastResolver(c, history).resolve('mayrin');
      expect(r?.character.id).toBe('mairin');
      expect(r?.via).toBe('history');
    });

    it('an exact live id BEATS a pair rejection: a reclaimed id must still resolve (mirrors the legacy `rejected` fix round 1)', () => {
      const r = buildCastResolver(cast, hp({}, [{ from: 'mairin', to: 'wren' }])).resolve('mairin');
      expect(r?.character.id).toBe('mairin');
      expect(r?.via).toBe('exact');
    });

    it('does not affect an id whose pair names a different `from`', () => {
      const r = buildCastResolver(
        cast,
        hp({ mayrin: 'mairin' }, [{ from: 'some-other-id', to: 'mairin' }]),
      ).resolve('mayrin');
      expect(r?.character.id).toBe('mairin');
    });

    it('does not affect an id whose pair names the same `from` but a different `to`', () => {
      // Reinforces the D1-pair-scope test above from the opposite direction:
      // the history entry's target ('mairin') isn't the rejected pair's
      // target ('someone-else'), so the tier-2 match must go through.
      const r = buildCastResolver(
        cast,
        hp({ mayrin: 'mairin' }, [{ from: 'mayrin', to: 'someone-else' }]),
      ).resolve('mayrin');
      expect(r?.character.id).toBe('mairin');
    });

    it('defaults to no pair rejections when rejectedPairs is omitted', () => {
      const r = buildCastResolver(cast, h({ mayrin: 'mairin' })).resolve('mayrin');
      expect(r?.character.id).toBe('mairin');
    });

    it('a raw `from` that only normalises to the same key as a rejected pair is still blocked at tier 3 (normalised-tier keying, not raw)', () => {
      // 'the-mairin' is a live cast id, matched at tier 3 by anything that
      // normalises to the same key. The pair was recorded against the raw
      // string 'the_Mairin' (underscore + capital M); this call resolves
      // 'the-Mairin' (hyphen + capital M) — a DIFFERENT raw string that
      // normalises to the same key as both. Tier 3 itself matches by
      // normalised key, so the rejection check must too, or a
      // punctuation/case variant would silently slip the block.
      const c = [{ id: 'the-mairin', name: 'Mairin' }];
      const r = buildCastResolver(
        c,
        hp({}, [{ from: 'the_Mairin', to: 'the-mairin' }]),
      ).resolve('the-Mairin');
      expect(r).toBeUndefined();
    });

    describe('no-fall-through (D2, trap 2 — mutation-checked)', () => {
      it('a rejected tier-2 candidate does not fall through to a tier-3/4 match for the same characterId', () => {
        // 'ghost' matches tier 2 (history: ghost -> rejected-target) which is
        // rejected. If the resolver mistakenly fell through instead of
        // stopping, tier 3/4 could still resolve 'ghost' via SOME other
        // route — this fixture makes sure there is genuinely nothing else
        // for it to fall through to, so a fall-through bug would surface as
        // a resolved character rather than coincidentally landing on
        // undefined anyway.
        const c = [{ id: 'rejected-target', name: 'A' }, { id: 'narrator', name: 'N' }];
        const history = hp({ ghost: 'rejected-target' }, [{ from: 'ghost', to: 'rejected-target' }]);
        expect(buildCastResolver(c, history).resolve('ghost')).toBeUndefined();
      });
    });
  });
});
