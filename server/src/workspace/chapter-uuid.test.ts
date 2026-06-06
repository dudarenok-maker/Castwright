/* srv-35 (plan 190) — lazy-migration + anti-strip primitives for the
 * immutable per-chapter `uuid`. Pure functions, no I/O. */

import { describe, it, expect } from 'vitest';
import { ensureChapterUuids, reconcileChapterUuids } from './chapter-uuid.js';
import type { BookStateJson } from './scan.js';

type Chapter = BookStateJson['chapters'][number];

function ch(partial: Partial<Chapter> & { id: number }): Chapter {
  return {
    title: `Chapter ${partial.id}`,
    slug: `${String(partial.id).padStart(2, '0')}-chapter-${partial.id}`,
    ...partial,
  };
}

function state(chapters: Chapter[]): BookStateJson {
  return {
    bookId: 'b',
    manuscriptId: 'm',
    title: 'T',
    author: 'A',
    series: 'Standalones',
    seriesPosition: null,
    isStandalone: true,
    manuscriptFile: 'manuscript.txt',
    castConfirmed: false,
    chapters,
    coverGradient: ['#000', '#fff'],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('ensureChapterUuids', () => {
  it('mints a uuid for every chapter missing one and reports changed', () => {
    const s = state([ch({ id: 1 }), ch({ id: 2 })]);

    const changed = ensureChapterUuids(s);

    expect(changed).toBe(true);
    expect(s.chapters[0].uuid).toMatch(UUID_RE);
    expect(s.chapters[1].uuid).toMatch(UUID_RE);
    expect(s.chapters[0].uuid).not.toBe(s.chapters[1].uuid);
  });

  it('is idempotent — a second pass mints nothing and reports unchanged', () => {
    const s = state([ch({ id: 1 }), ch({ id: 2 })]);
    ensureChapterUuids(s);
    const first = s.chapters.map((c) => c.uuid);

    const changed = ensureChapterUuids(s);

    expect(changed).toBe(false);
    expect(s.chapters.map((c) => c.uuid)).toEqual(first);
  });

  it('never overwrites an existing uuid', () => {
    const s = state([ch({ id: 1, uuid: 'keep-me' }), ch({ id: 2 })]);

    const changed = ensureChapterUuids(s);

    expect(changed).toBe(true); // ch 2 was minted
    expect(s.chapters[0].uuid).toBe('keep-me');
    expect(s.chapters[1].uuid).toMatch(UUID_RE);
  });

  it('mints for excluded chapters too (they can be re-included)', () => {
    const s = state([ch({ id: 1, excluded: true })]);

    ensureChapterUuids(s);

    expect(s.chapters[0].uuid).toMatch(UUID_RE);
  });
});

describe('reconcileChapterUuids', () => {
  it('carries each chapter uuid from the existing chapters by id', () => {
    const existing = [ch({ id: 1, uuid: 'u1' }), ch({ id: 2, uuid: 'u2' })];
    const incoming = [ch({ id: 1, title: 'Renamed' }), ch({ id: 2 })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('u1');
    expect(out[1].uuid).toBe('u2');
    expect(out[0].title).toBe('Renamed'); // incoming fields win
  });

  it('mints a uuid for an incoming chapter with no matching existing id', () => {
    const existing = [ch({ id: 1, uuid: 'u1' })];
    const incoming = [ch({ id: 1 }), ch({ id: 2 })]; // id 2 is new

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('u1');
    expect(out[1].uuid).toMatch(UUID_RE);
  });

  it('respects a uuid the incoming chapter already carries', () => {
    const existing = [ch({ id: 1, uuid: 'old' })];
    const incoming = [ch({ id: 1, uuid: 'client-supplied' })];

    const out = reconcileChapterUuids(incoming, existing);

    expect(out[0].uuid).toBe('client-supplied');
  });

  it('does not mutate the incoming array', () => {
    const existing = [ch({ id: 1, uuid: 'u1' })];
    const incoming = [ch({ id: 1 })];

    reconcileChapterUuids(incoming, existing);

    expect(incoming[0].uuid).toBeUndefined();
  });
});
