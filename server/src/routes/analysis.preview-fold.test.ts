/* Plan 291 Task 28 fix round 1 (I3, #4031) - `previewFoldForLiveView` builds the
   SSE `cast-update` frames ("Cast so far"). Its behavioural pins went with
   `buildInterimCast`'s tests; these restate the cases that still apply: the
   descriptor fold, dedup before the fold (Fix 1), localised buckets (Wave D), and
   the plan inputs (protectIds, constraints). */
import { describe, it, expect } from 'vitest';
import { previewFoldForLiveView } from './analysis.js';
import { EMPTY_DEDUP_CONSTRAINTS } from '../analyzer/roster-dedup.js';
import type { CharacterOutput } from '../handoff/schemas.js';
import type { DedupConstraints } from '../store/reanalysis-types.js';

const ch = (id: string, name: string, opts: Partial<CharacterOutput> = {}): CharacterOutput => ({
  id,
  name,
  role: 'character',
  color: 'unset',
  evidence: [{ quote: `${name}'s line one, long enough to be representative.` }],
  ...opts,
});

describe('previewFoldForLiveView', () => {
  it('folds descriptor names into the Unknown male / female buckets', () => {
    const out = previewFoldForLiveView(
      [
        ch('narrator', 'Narrator'),
        ch('wren', 'Wren', { gender: 'female' }),
        ch('the-jogger', 'The Jogger', { gender: 'male' }),
        ch('drooly-boy', 'Drooly Boy', { gender: 'male' }),
        ch('tall-lady', 'Tall Lady', { gender: 'female' }),
      ],
      'en',
      EMPTY_DEDUP_CONSTRAINTS,
    );
    expect(out.map((c) => c.id).sort()).toEqual(['narrator', 'unknown-female', 'unknown-male', 'wren']);
    expect(out.find((c) => c.id === 'unknown-male')!.aliases).toEqual(['The Jogger', 'Drooly Boy']);
    expect(out.find((c) => c.id === 'unknown-female')!.aliases).toEqual(['Tall Lady']);
  });

  it('dedups same-name rows with divergent model ids before the fold (Fix 1)', () => {
    const out = previewFoldForLiveView(
      [ch('anton', 'Антон', { gender: 'male' }), ch('антон', 'Антон', { gender: 'male' })],
      'ru',
      EMPTY_DEDUP_CONSTRAINTS,
    );
    expect(out.filter((c) => c.name === 'Антон')).toHaveLength(1);
  });

  it('mints localised Russian bucket names for a ru book (Wave D)', () => {
    const out = previewFoldForLiveView(
      [
        ch('narrator', 'Рассказчик'),
        ch('anton', 'Антон', { gender: 'male' }),
        ch('parnishka', 'парень', { gender: 'male' }),
        ch('devushka', 'девушка', { gender: 'female' }),
      ],
      'ru',
      EMPTY_DEDUP_CONSTRAINTS,
    );
    expect(out.find((c) => c.id === 'unknown-male')?.name).toBe('Незнакомый Парень');
    expect(out.find((c) => c.id === 'unknown-female')?.name).toBe('Незнакомая Девушка');
    expect(out.some((c) => c.id === 'anton')).toBe(true);
  });

  it('never folds a protected row (a plan join), even with a descriptor name', () => {
    const out = previewFoldForLiveView(
      [ch('the-jogger', 'The Jogger', { gender: 'male' })],
      'en',
      EMPTY_DEDUP_CONSTRAINTS,
      new Set(['the-jogger']),
    );
    expect(out.map((c) => c.id)).toEqual(['the-jogger']);
  });

  it('honours the plan constraints: two same-name rows joined to different prior rows stay two', () => {
    const constraints: DedupConstraints = {
      planned: new Map([
        ['wren-a', { kind: 'join', priorId: 'wren-a' }],
        ['wren-b', { kind: 'join', priorId: 'wren-b' }],
      ]),
    };
    const rows = [ch('wren-a', 'Wren', { gender: 'female' }), ch('wren-b', 'Wren', { gender: 'female' })];
    expect(previewFoldForLiveView(rows, 'en', constraints).map((c) => c.id).sort()).toEqual(['wren-a', 'wren-b']);
    // Control: without the plan the two collapse.
    expect(previewFoldForLiveView(rows, 'en', EMPTY_DEDUP_CONSTRAINTS)).toHaveLength(1);
  });
});
