/* Locks the STATUS_UI contract — every LibraryBookStatus maps to a
   coloured pill with a non-empty label and an icon. The grid and
   table both render off this map, so a missing key would render an
   empty pill instead of failing the type check. */

import { describe, expect, it } from 'vitest';
import type { LibraryBookStatus } from '../../lib/types';
import { STATUS_UI } from './library-status-ui';

const ALL_STATUSES: LibraryBookStatus[] = [
  'not_analysed',
  'analysing',
  'cast_pending',
  'generating',
  'complete',
  'unreadable',
  'orphaned',
];

describe('STATUS_UI', () => {
  it('covers every LibraryBookStatus key', () => {
    for (const status of ALL_STATUSES) {
      expect(STATUS_UI[status]).toBeDefined();
    }
  });

  it.each(ALL_STATUSES)('"%s" carries a non-empty label and an icon', (status) => {
    const meta = STATUS_UI[status];
    expect(meta.label.length).toBeGreaterThan(0);
    expect(meta.icon).toBeTruthy();
    expect(meta.color).toMatch(/^(library|warning|peach|success|danger)$/);
  });

  it('routes failure statuses to the danger colour', () => {
    expect(STATUS_UI.unreadable.color).toBe('danger');
    expect(STATUS_UI.orphaned.color).toBe('danger');
  });

  it('routes complete to success and generating to peach', () => {
    expect(STATUS_UI.complete.color).toBe('success');
    expect(STATUS_UI.generating.color).toBe('peach');
  });
});
