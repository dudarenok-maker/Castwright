import { describe, it, expect } from 'vitest';
import { compareCastRows, normaliseIdKey } from './cast-sort';
import { normaliseIdKey as serverNormaliseIdKey } from '../../server/src/util/character-id';
import type { Character } from './types';

describe('compareCastRows — cast table ordering', () => {
  const mk = (over: Partial<Character> & { id: string }): Character =>
    ({ name: over.id, role: 'r', color: 'narrator', lines: 0, ...over }) as Character;

  it('sorts by line count descending', () => {
    const out = [mk({ id: 'a', lines: 5 }), mk({ id: 'b', lines: 100 }), mk({ id: 'c', lines: 42 })]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['b', 'c', 'a']);
  });

  it('pins unknown-male and unknown-female last regardless of line count', () => {
    const out = [
      mk({ id: 'unknown-male', name: 'Unknown male', lines: 9999 }),
      mk({ id: 'wren', name: 'Wren', lines: 10 }),
      mk({ id: 'unknown-female', name: 'Unknown female', lines: 8888 }),
      mk({ id: 'narrator', name: 'Narrator', lines: 5 }),
    ]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['wren', 'narrator', 'unknown-male', 'unknown-female']);
  });

  it('orders the two buckets between themselves by line count', () => {
    const out = [
      mk({ id: 'unknown-female', name: 'Unknown female', lines: 3 }),
      mk({ id: 'unknown-male', name: 'Unknown male', lines: 7 }),
    ]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['unknown-male', 'unknown-female']);
  });

  it('breaks line-count ties by name ascending', () => {
    const out = [mk({ id: 'z', name: 'Zed', lines: 10 }), mk({ id: 'a', name: 'Amy', lines: 10 })]
      .sort(compareCastRows)
      .map((c) => c.name);
    expect(out).toEqual(['Amy', 'Zed']);
  });

  it('treats a missing line count as zero', () => {
    const out = [mk({ id: 'has', name: 'Has', lines: 1 }), mk({ id: 'none', name: 'None' })]
      .sort(compareCastRows)
      .map((c) => c.id);
    expect(out).toEqual(['has', 'none']);
  });
});

/* N4 (review round) — `normaliseIdKey` is hand-maintained in two places:
   this file (the frontend twin) and `server/src/util/character-id.ts` (the
   server original). They are currently character-identical, but nothing
   pinned that before this test — a drift would fail silently in exactly the
   direction F4 (`cast-link-orphan.ts`) exists to prevent (a reserved-id or
   alias check that agrees on one side of the frontend/server boundary and
   disagrees on the other). Follows the cross-boundary-import precedent
   already established by `src/lib/api.config.test.ts` (imports
   `server/src/config/registry.ts` directly into a frontend test) rather than
   `narrator-ids.test.ts`'s pattern, which only pins ITS OWN twin's literal
   contents and never cross-imports the server original to compare. Table
   covers the drift shapes cast-link-orphan.ts's own F4 checks care about:
   a case/separator-drifted bucket id (`Unknown_Male`), the #2040
   `the-torment`/`the_torment` shape, non-ASCII (Cyrillic/CJK, which must
   survive unmodified per both copies' own doc comments), and mixed
   separators/whitespace. Mutation-verified: editing either copy's regex
   (e.g. dropping the `\s` from the separator class) turns the matching case
   red. */
describe('normaliseIdKey — parity with the server twin (server/src/util/character-id.ts)', () => {
  const cases = [
    'Unknown_Male',
    'unknown-male',
    'the-torment',
    'the_torment',
    'The Torment',
    '  spaced out id  ',
    '---leading-and-trailing---',
    'Mixed_Separator Style-Id',
    'Привет_Мир', // non-ASCII (Cyrillic) — must be preserved, not stripped
    '角色_名前', // non-ASCII (CJK) — must be preserved, not stripped
  ];

  it.each(cases)('normaliseIdKey(%j) agrees with the server implementation', (input) => {
    expect(normaliseIdKey(input)).toBe(serverNormaliseIdKey(input));
  });

  it('both copies collapse the #2040 drift shape onto the same key', () => {
    expect(normaliseIdKey('the-torment')).toBe(normaliseIdKey('the_torment'));
    expect(serverNormaliseIdKey('the-torment')).toBe(serverNormaliseIdKey('the_torment'));
    expect(normaliseIdKey('the-torment')).toBe(serverNormaliseIdKey('the_torment'));
  });
});
